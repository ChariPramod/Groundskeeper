import { randomInt, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  ackDelivery,
  claimNextDelivery,
  failDelivery,
  PrismaClient,
  PushLeaseLostError,
  retryFailedDelivery,
  storeAnalysisRun,
} from "./index.js";

it.skipIf(!process.env.DATABASE_TEST_URL).each(["push", "pull_request"] as const)(
  "fences concurrent claims, persistence and acknowledgements; bounds retry and recovers terminal %s deliveries",
  async (event) => {
    const claimNextPush = (db: PrismaClient) => claimNextDelivery(db, event);
    const ackPush = (db: PrismaClient, id: string, token: string) =>
      ackDelivery(db, id, token, event);
    const failPush = (db: PrismaClient, id: string, token: string, error: string) =>
      failDelivery(db, id, token, error, event);
    const retryFailedPush = (db: PrismaClient, id: string, installation: bigint) =>
      retryFailedDelivery(db, id, installation, event);
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `leases_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("schema", schema);
    const database = new PrismaClient({ datasourceUrl: url.toString() });
    const other = new PrismaClient({ datasourceUrl: url.toString() });
    const ids = [randomUUID(), randomUUID()];
    const installationId = BigInt(randomInt(1, 2 ** 48 - 1));
    try {
      // Isolated schema makes global queue claims safe alongside other integration suites.
      // Identifiers below contain only a fixed prefix and a generated hexadecimal UUID.
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of ["WebhookDelivery", "Workspace", "Repository", "AnalysisRun"]) {
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
        );
      }
      await database.webhookDelivery.createMany({
        data: ids.map((id) => ({
          id,
          event,
          installationId,
          payload: {},
          receivedAt: new Date(0),
        })),
      });
      const claims = await Promise.all([claimNextDelivery(database, "all"), claimNextPush(other)]);
      expect(new Set(claims.map((claim) => claim?.id))).toEqual(new Set(ids));
      const first = claims[0];
      const second = claims[1];
      if (!first?.leaseToken || !second?.leaseToken) throw new Error("Claims missing leases");
      expect(first.attemptCount).toBe(1);
      expect(await claimNextDelivery(other, event === "push" ? "pull_request" : "push")).toBeNull();
      expect(
        await ackDelivery(
          database,
          first.id,
          first.leaseToken,
          event === "push" ? "pull_request" : "push",
        ),
      ).toBe(false);
      expect(await ackPush(database, first.id, "wrong-token")).toBe(false);
      expect(await ackPush(database, second.id, second.leaseToken)).toBe(true);
      expect(await claimNextPush(other)).toBeNull();
      await database.$executeRaw`UPDATE "WebhookDelivery" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${first.id}`;
      expect(await ackPush(database, first.id, first.leaseToken)).toBe(false);
      const reclaimed = await claimNextPush(other);
      expect(reclaimed?.id).toBe(first.id);
      expect(reclaimed?.attemptCount).toBe(2);
      expect(reclaimed?.leaseToken).not.toBe(first.leaseToken);
      if (!reclaimed?.leaseToken) throw new Error("Missing reclaimed lease");
      expect(await failPush(database, first.id, first.leaseToken, "Error")).toBe(false);
      const input = {
        deliveryId: first.id,
        installationId,
        account: "lease-test",
        repository: { githubId: 1n, fullName: "lease-test/docs", defaultBranch: "main" },
        beforeCommit: "a".repeat(40),
        afterCommit: "b".repeat(40),
        report: {},
      };
      await expect(
        storeAnalysisRun(database, input, first.leaseToken, event),
      ).rejects.toBeInstanceOf(PushLeaseLostError);
      expect(await database.analysisRun.count({ where: { deliveryId: first.id } })).toBe(0);
      const stored = await storeAnalysisRun(database, input, reclaimed.leaseToken, event);
      expect(stored.created).toBe(true);
      expect(await failPush(database, first.id, reclaimed.leaseToken, "secret value")).toBe(true);
      const retrying = await database.webhookDelivery.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(retrying.failedAt).toBeNull();
      expect(retrying.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() + 240_000);
      expect(retrying.lastError).toBe("Error");
      expect(await claimNextPush(other)).toBeNull();
      // Simulate retries through the final claim without wall-clock sleeps.
      await database.webhookDelivery.update({
        where: { id: first.id },
        data: { attemptCount: 4, nextAttemptAt: null },
      });
      const finalAttempt = await claimNextPush(database);
      expect(finalAttempt?.attemptCount).toBe(5);
      if (!finalAttempt?.leaseToken) throw new Error("Missing final lease");
      expect(await storeAnalysisRun(database, input, finalAttempt.leaseToken, event)).toEqual({
        runId: stored.runId,
        created: false,
      });
      expect(await failPush(database, first.id, finalAttempt.leaseToken, "AnalysisError")).toBe(
        true,
      );
      expect(
        (await database.webhookDelivery.findUniqueOrThrow({ where: { id: first.id } })).failedAt,
      ).not.toBeNull();
      expect(await retryFailedPush(database, first.id, installationId + 1n)).toBe(false);
      expect(await retryFailedPush(database, first.id, installationId)).toBe(true);
      const recovered = await claimNextPush(database);
      expect(recovered?.attemptCount).toBe(1);
      if (!recovered?.leaseToken) throw new Error("Missing recovery lease");
      expect(await storeAnalysisRun(database, input, recovered.leaseToken, event)).toEqual({
        runId: stored.runId,
        created: false,
      });
      expect(await ackPush(database, first.id, recovered.leaseToken)).toBe(true);
      expect(await retryFailedPush(database, first.id, installationId)).toBe(false);
      // A worker dying on its final attempt is terminalized on the next poll.
      await database.webhookDelivery.update({
        where: { id: second.id },
        data: {
          processedAt: null,
          attemptCount: 5,
          leaseToken: "crashed",
          leaseExpiresAt: new Date(0),
        },
      });
      await claimNextPush(database);
      const exhausted = await database.webhookDelivery.findUniqueOrThrow({
        where: { id: second.id },
      });
      expect(exhausted.failedAt).not.toBeNull();
      expect(exhausted.leaseToken).toBeNull();
      expect(exhausted.lastError).toBe("LeaseExpired");
    } finally {
      await Promise.all([database.$disconnect(), other.$disconnect()]);
      try {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.$disconnect();
      }
    }
  },
  20_000,
);
