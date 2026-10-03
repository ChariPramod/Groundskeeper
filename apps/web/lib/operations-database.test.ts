import { randomUUID } from "node:crypto";
import { PrismaClient } from "@groundskeeper/database/client";
import { expect, it, vi } from "vitest";
import { readLiveOperations } from "./operations-data";

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "Postgres operations aggregates match independent classification across tenant and timestamp boundaries",
  async () => {
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `operations_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("schema", schema);
    url.searchParams.set("options", "-c timezone=Asia/Tokyo");
    const db = new PrismaClient({ datasourceUrl: url.toString() });
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds);
    const base = {
      installationId: 42n,
      event: "push",
      receivedAt: ago(60_000),
      processedAt: null,
      failedAt: null,
      attemptCount: 0,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      payload: { secret: "do-not-project" },
      lastError: "do-not-project",
      leaseToken: "do-not-project",
    };
    const rows = [
      { ...base, id: "pending" },
      { ...base, id: "pending-at-stall-boundary", receivedAt: ago(900_000) },
      { ...base, id: "pending-before-stall-boundary", receivedAt: ago(899_999) },
      { ...base, id: "pending-future-retry", receivedAt: ago(3600_000), nextAttemptAt: ago(-1) },
      { ...base, id: "retry-due", receivedAt: ago(900_000), attemptCount: 2, nextAttemptAt: now },
      {
        ...base,
        id: "retry-scheduled",
        receivedAt: ago(3600_000),
        attemptCount: 2,
        nextAttemptAt: ago(-1),
      },
      {
        ...base,
        id: "expired-lease-future-retry",
        attemptCount: 2,
        leaseExpiresAt: now,
        nextAttemptAt: ago(-3600_000),
      },
      {
        ...base,
        id: "active-lease",
        event: "pull_request",
        receivedAt: ago(3600_000),
        attemptCount: 1,
        leaseExpiresAt: ago(-1),
      },
      {
        ...base,
        id: "failed-with-active-lease",
        failedAt: ago(-3600_000),
        leaseExpiresAt: ago(-3600_000),
      },
      { ...base, id: "processed", failedAt: now, processedAt: now, receivedAt: ago(86400_000) },
      {
        ...base,
        id: "unsupported",
        event: "installation",
        failedAt: now,
        receivedAt: ago(86400_000),
      },
      { ...base, id: "foreign", installationId: 99n, failedAt: now, receivedAt: ago(86400_000) },
      ...Array.from({ length: 12 }, (_, index) => ({
        ...base,
        id: `failed-${String(index).padStart(2, "0")}`,
        failedAt: now,
        attemptCount: 5,
        receivedAt: ago(7200_000),
      })),
    ];
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of ["Workspace", "Repository", "AnalysisRun", "WebhookDelivery"])
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
        );
      const zone = await db.$queryRawUnsafe<{ TimeZone: string }[]>("SHOW TimeZone");
      expect(zone[0]?.TimeZone).toBe("Asia/Tokyo");
      await db.workspace.createMany({
        data: [
          { id: "own", installationId: 42n, account: "own" },
          { id: "foreign", installationId: 99n, account: "foreign" },
        ],
      });
      await db.repository.createMany({
        data: [
          {
            id: "own-repo",
            workspaceId: "own",
            githubId: 1n,
            fullName: "own/repo",
            defaultBranch: "main",
          },
          {
            id: "foreign-repo",
            workspaceId: "foreign",
            githubId: 2n,
            fullName: "foreign/repo",
            defaultBranch: "main",
          },
        ],
      });
      await db.webhookDelivery.createMany({ data: rows });
      await db.analysisRun.createMany({
        data: [
          { id: "at-day-boundary", repositoryId: "own-repo", createdAt: ago(86400_000) },
          { id: "before-day-boundary", repositoryId: "own-repo", createdAt: ago(86400_001) },
          { id: "latest", repositoryId: "own-repo", createdAt: now },
          { id: "foreign-run", repositoryId: "foreign-repo", createdAt: ago(-86400_000) },
        ].map((run) => ({
          ...run,
          deliveryId: run.id,
          inputDigest: run.id,
          beforeCommit: "a",
          afterCommit: "b",
          report: { secret: "do-not-project" },
        })),
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const result = await readLiveOperations(42n, url.toString());
      const included = rows.filter(
        (row) =>
          row.installationId === 42n &&
          ["push", "pull_request"].includes(row.event) &&
          !row.processedAt,
      );
      const inactive = (row: (typeof rows)[number]) =>
        !row.leaseExpiresAt || row.leaseExpiresAt <= now;
      const stalled = (row: (typeof rows)[number]) =>
        !row.failedAt &&
        inactive(row) &&
        ((row.leaseExpiresAt !== null && row.leaseExpiresAt <= now) ||
          (row.receivedAt <= ago(900_000) && (!row.nextAttemptAt || row.nextAttemptAt <= now)));
      const expected = {
        pending: included.filter((row) => !row.failedAt && inactive(row) && row.attemptCount === 0)
          .length,
        processing: included.filter((row) => !row.failedAt && !inactive(row)).length,
        retrying: included.filter((row) => !row.failedAt && inactive(row) && row.attemptCount > 0)
          .length,
        failed: included.filter((row) => !!row.failedAt).length,
        stalled: included.filter(stalled).length,
        total: included.length,
        oldestUnfinishedAt: new Date(
          Math.min(...included.map((row) => row.receivedAt.getTime())),
        ).toISOString(),
      };
      expect(result.queue).toEqual(expected);
      expect(result.analyses).toEqual({ completedLast24Hours: 2, latestAt: now.toISOString() });
      expect(result.jobs.map((job) => job.id)).toEqual(
        included
          .filter((row) => row.failedAt || stalled(row))
          .sort(
            (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id),
          )
          .slice(0, 10)
          .map((row) => row.id),
      );
      expect(result.jobs).toHaveLength(10);
      expect(result.workerStatus).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("do-not-project");
      await db.webhookDelivery.deleteMany({ where: { id: { startsWith: "failed-" } } });
      const visibleStalls = await readLiveOperations(42n, url.toString());
      expect(
        visibleStalls.jobs
          .filter((job) => job.status === "stalled")
          .map((job) => job.id)
          .sort(),
      ).toEqual(
        included
          .filter(stalled)
          .map((row) => row.id)
          .sort(),
      );

      const empty = await readLiveOperations(777n, url.toString());
      expect(empty.queue).toEqual({
        pending: 0,
        processing: 0,
        retrying: 0,
        failed: 0,
        stalled: 0,
        total: 0,
        oldestUnfinishedAt: null,
      });
      expect(empty.analyses).toEqual({ completedLast24Hours: 0, latestAt: null });
      expect(empty.workerStatus).toBe("unknown");
      // Corrupt attempts must not disappear from totals or create a misleading clean snapshot.
      await db.webhookDelivery.update({ where: { id: "pending" }, data: { attemptCount: -1 } });
      await expect(readLiveOperations(42n, url.toString())).rejects.toThrow(
        "invalid operations snapshot",
      );
    } finally {
      vi.useRealTimers();
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  },
  30000,
);
