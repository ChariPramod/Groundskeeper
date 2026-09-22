import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, it, vi } from "vitest";
import {
  assertRepairPublicationLease,
  finishRepairPublication,
  releaseRepairPublicationLease,
  reserveRepairPublication,
} from "./repair-publications.js";

const input = {
  analysisRunId: "run",
  installationId: 1n,
  proposalId: "a".repeat(64),
  pages: 1,
  linesChanged: 2,
};
function fake() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ maxPages: 3, maxPrs: 1, maxLinesChanged: 150 }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    repairPublication: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  return { db, tx };
}
it("rejects invalid budgets before persistence", async () => {
  const { db, tx } = fake();
  for (const change of [{ pages: 4 }, { pages: 0 }, { linesChanged: 151 }, { proposalId: "bad" }])
    await expect(reserveRepairPublication(db, { ...input, ...change })).rejects.toThrow("Invalid");
  expect(tx.repairPublication.create).not.toHaveBeenCalled();
});
it("rejects unknown ownership, disabled budget and competing proposals", async () => {
  const { db, tx } = fake();
  tx.$queryRaw
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ maxPages: 3, maxPrs: 0, maxLinesChanged: 150 }]);
  await expect(reserveRepairPublication(db, input)).rejects.toThrow("ownership");
  await expect(reserveRepairPublication(db, input)).rejects.toThrow("budget");
  tx.repairPublication.findUnique.mockResolvedValueOnce({ proposalId: "b".repeat(64) });
  await expect(reserveRepairPublication(db, input)).rejects.toThrow("Another proposal");
  expect(tx.repairPublication.create).not.toHaveBeenCalled();
});
it("reuses a published reservation without allocating another lease", async () => {
  const { db, tx } = fake();
  tx.repairPublication.findUnique.mockResolvedValue({
    proposalId: input.proposalId,
    pullRequestUrl: "https://github.com/test/repo/pull/1",
  });
  expect(await reserveRepairPublication(db, input)).toEqual({
    token: null,
    url: "https://github.com/test/repo/pull/1",
  });
  expect(tx.$executeRaw).not.toHaveBeenCalled();
});
it("active lease and expired completion fail closed", async () => {
  const { db, tx } = fake();
  tx.$executeRaw.mockResolvedValue(0);
  await expect(reserveRepairPublication(db, input)).rejects.toThrow("active lease");
  await expect(
    finishRepairPublication(db, "run", "lost", "https://github.com/test/repo/pull/1"),
  ).rejects.toThrow("finalize");
  tx.$queryRaw.mockResolvedValue([]);
  await expect(assertRepairPublicationLease(db, "run", input.proposalId, "lost")).rejects.toThrow(
    "expired",
  );
});
it.skipIf(!process.env.DATABASE_TEST_URL)(
  "serializes per-analysis publication across clients and recovers expired owners",
  async () => {
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `repair_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("schema", schema);
    const db = new PrismaClient({ datasourceUrl: url.toString() }),
      other = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of ["Workspace", "Repository", "AnalysisRun", "RepairPublication"])
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
        );
      const workspace = await db.workspace.create({
        data: { installationId: 1n, account: "test" },
      });
      const repository = await db.repository.create({
        data: {
          workspaceId: workspace.id,
          githubId: 1n,
          fullName: "test/repo",
          defaultBranch: "main",
        },
      });
      await db.analysisRun.create({
        data: {
          id: "run",
          repositoryId: repository.id,
          deliveryId: "delivery",
          beforeCommit: "a".repeat(40),
          afterCommit: "b".repeat(40),
          inputDigest: "test",
          report: {},
        },
      });
      const outcomes = await Promise.allSettled([
        reserveRepairPublication(db, input),
        reserveRepairPublication(other, input),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const winner = outcomes.find((o) => o.status === "fulfilled");
      if (winner?.status !== "fulfilled" || !winner.value.token) throw new Error("Missing winner");
      const token = winner.value.token;
      await expect(
        reserveRepairPublication(other, { ...input, proposalId: "b".repeat(64) }),
      ).rejects.toThrow("Another proposal");
      await db.$executeRaw`UPDATE "RepairPublication" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "analysisRunId" = 'run'`;
      const recovered = await reserveRepairPublication(other, input);
      if (!recovered.token) throw new Error("Missing recovered token");
      await expect(
        assertRepairPublicationLease(db, "run", input.proposalId, token),
      ).rejects.toThrow();
      await releaseRepairPublicationLease(db, "run", token);
      await assertRepairPublicationLease(other, "run", input.proposalId, recovered.token);
      await finishRepairPublication(
        other,
        "run",
        recovered.token,
        "https://github.com/test/repo/pull/1",
      );
      expect((await reserveRepairPublication(db, input)).url).toBe(
        "https://github.com/test/repo/pull/1",
      );
    } finally {
      await Promise.all([db.$disconnect(), other.$disconnect()]);
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  },
  20_000,
);
