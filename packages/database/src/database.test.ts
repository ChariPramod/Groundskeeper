import { randomInt, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { PrismaClient } from "./index.js";

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "persists claim graphs and deduplicates webhook deliveries",
  async () => {
    const database = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const rollback = new Error("rollback test transaction");
    try {
      await expect(
        database.$transaction(async (tx) => {
          const workspace = await tx.workspace.create({
            data: { installationId: BigInt(randomInt(1, 2 ** 48 - 1)), account: "test" },
          });
          const repository = await tx.repository.create({
            data: {
              workspaceId: workspace.id,
              githubId: 1n,
              fullName: "test/docs",
              defaultBranch: "main",
            },
          });
          const page = await tx.page.create({
            data: { repositoryId: repository.id, path: "README.md", indexedCommit: "a".repeat(40) },
          });
          const claim = await tx.claim.create({
            data: {
              pageId: page.id,
              stableKey: "claim",
              anchor: "setup",
              kind: "paragraph",
              text: "Use Client.",
              position: { start_line: 1, start_column: 1, end_line: 1, end_column: 12 },
              references: [],
            },
          });
          expect(claim.status).toBe("unknown");
          expect(repository.maxPrs).toBe(1);
          const symbol = await tx.symbol.create({
            data: {
              repositoryId: repository.id,
              stableKey: "symbol",
              path: "client.py",
              name: "Client",
              qualifiedName: "Client",
              kind: "class",
              language: "python",
              startLine: 1,
              endLine: 2,
              fingerprint: "abc",
              indexedCommit: "a".repeat(40),
            },
          });
          await tx.claimLink.create({
            data: {
              claimId: claim.id,
              symbolId: symbol.id,
              match: "identifier:Client",
              confidence: 1,
            },
          });
          const delivery = {
            id: randomUUID(),
            event: "push",
            installationId: workspace.installationId,
            payload: {},
          };
          expect(
            (await tx.webhookDelivery.createMany({ data: [delivery], skipDuplicates: true })).count,
          ).toBe(1);
          expect(
            (await tx.webhookDelivery.createMany({ data: [delivery], skipDuplicates: true })).count,
          ).toBe(0);
          await tx.workspace.delete({ where: { id: workspace.id } });
          expect(await tx.claim.findUnique({ where: { id: claim.id } })).toBeNull();
          expect(await tx.claimLink.findMany({ where: { claimId: claim.id } })).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await database.$disconnect();
    }
  },
);
