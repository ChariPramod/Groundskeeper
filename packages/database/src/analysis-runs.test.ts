import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AnalysisRunConflictError,
  Prisma,
  PrismaClient,
  PushLeaseLostError,
  type StoreAnalysisRunInput,
  storeAnalysisRun,
} from "./index.js";

function input(): StoreAnalysisRunInput {
  return {
    deliveryId: randomUUID(),
    installationId: BigInt(randomInt(1, 2 ** 48 - 1)),
    account: "test",
    repository: { githubId: 123n, fullName: "test/docs", defaultBranch: "main" },
    beforeCommit: "a".repeat(40),
    afterCommit: "b".repeat(40),
    report: { impacted: [], stats: { total: 2, changed: 1 } },
  };
}

function fakeDatabase() {
  const runs = new Map<string, { id: string; inputDigest: string }>();
  const tx = {
    $queryRaw: vi.fn(async (): Promise<{ id: string }[]> => []),
    analysisRun: {
      findUnique: vi.fn(async ({ where }: { where: { deliveryId: string } }) =>
        runs.get(where.deliveryId),
      ),
      create: vi.fn(async ({ data }: { data: { deliveryId: string; inputDigest: string } }) => {
        const run = { id: randomUUID(), ...data };
        runs.set(data.deliveryId, run);
        return run;
      }),
    },
    workspace: { upsert: vi.fn(async () => ({ id: "workspace" })) },
    repository: { upsert: vi.fn(async () => ({ id: "repository" })) },
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
  return { database: { $transaction: transaction } as unknown as PrismaClient, tx, transaction };
}

describe("analysis result persistence", () => {
  it("rejects a lost lease inside the transaction before reading or writing results", async () => {
    const { database, tx, transaction } = fakeDatabase();
    await expect(storeAnalysisRun(database, input(), "expired-token")).rejects.toBeInstanceOf(
      PushLeaseLostError,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.analysisRun.findUnique).not.toHaveBeenCalled();
    expect(tx.workspace.upsert).not.toHaveBeenCalled();
    expect(tx.repository.upsert).not.toHaveBeenCalled();
    expect(tx.analysisRun.create).not.toHaveBeenCalled();
  });

  it("stores an owned claim only after checking ownership in the same transaction", async () => {
    const { database, tx, transaction } = fakeDatabase();
    const first = input();
    tx.$queryRaw.mockResolvedValueOnce([{ id: first.deliveryId }]);
    expect((await storeAnalysisRun(database, first, "owned-token")).created).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.analysisRun.findUnique.mock.invocationCallOrder[0] as number,
    );
    expect(tx.workspace.upsert).toHaveBeenCalledTimes(1);
    expect(tx.repository.upsert).toHaveBeenCalledTimes(1);
    expect(tx.analysisRun.create).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid commits before touching storage", async () => {
    const { database, transaction } = fakeDatabase();
    for (const beforeCommit of ["main", "a".repeat(39), "0".repeat(40)]) {
      await expect(storeAnalysisRun(database, { ...input(), beforeCommit })).rejects.toThrow(
        "full nonzero",
      );
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("acknowledges equivalent JSON despite key order and commit case", async () => {
    const { database, tx } = fakeDatabase();
    const first = input();
    const result = await storeAnalysisRun(database, first);
    expect(result.created).toBe(true);
    expect(
      await storeAnalysisRun(database, {
        ...first,
        beforeCommit: first.beforeCommit.toUpperCase(),
        report: { stats: { changed: 1, total: 2 }, impacted: [] },
      }),
    ).toEqual({ runId: result.runId, created: false });
    expect(tx.analysisRun.create).toHaveBeenCalledTimes(1);
    expect(tx.workspace.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting identity, commits, and report without mutating tenant metadata", async () => {
    const { database, tx } = fakeDatabase();
    const first = input();
    await storeAnalysisRun(database, first);
    for (const change of [
      { installationId: first.installationId + 1n },
      { repository: { ...first.repository, githubId: 999n } },
      { afterCommit: "c".repeat(40) },
      { report: { impacted: ["new"] } },
    ]) {
      await expect(storeAnalysisRun(database, { ...first, ...change })).rejects.toBeInstanceOf(
        AnalysisRunConflictError,
      );
    }
    expect(tx.workspace.upsert).toHaveBeenCalledTimes(1);
    expect(tx.workspace.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(tx.repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_githubId: { workspaceId: "workspace", githubId: 123n } },
        update: {},
      }),
    );
  });

  it("retries an aborted unique-key race", async () => {
    const { database, transaction } = fakeDatabase();
    transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("race", { code: "P2002", clientVersion: "6.19.0" }),
    );
    expect((await storeAnalysisRun(database, input())).created).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects non-JSON report values instead of hashing them ambiguously", async () => {
    const { database, transaction } = fakeDatabase();
    await expect(
      storeAnalysisRun(database, { ...input(), report: { unexpected: Number.NaN } }),
    ).rejects.toThrow("only JSON");
    expect(transaction).not.toHaveBeenCalled();
  });
});

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "stores concurrent immutable runs with tenant isolation and rejects conflicting replay",
  async () => {
    const database = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const first = input();
    const other = { ...input(), repository: first.repository };
    try {
      const results = await Promise.all([
        storeAnalysisRun(database, first),
        storeAnalysisRun(database, first),
      ]);
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(results[0]?.runId).toBe(results[1]?.runId);
      await storeAnalysisRun(database, other);
      const runs = await database.analysisRun.findMany({
        where: { deliveryId: { in: [first.deliveryId, other.deliveryId] } },
        include: { repository: { include: { workspace: true } } },
      });
      expect(runs).toHaveLength(2);
      expect(new Set(runs.map((run) => run.repositoryId)).size).toBe(2);
      expect(new Set(runs.map((run) => run.repository.workspace.installationId))).toEqual(
        new Set([first.installationId, other.installationId]),
      );
      await expect(
        storeAnalysisRun(database, { ...first, installationId: other.installationId }),
      ).rejects.toBeInstanceOf(AnalysisRunConflictError);
      await expect(
        storeAnalysisRun(database, { ...first, report: { changed: true } }),
      ).rejects.toBeInstanceOf(AnalysisRunConflictError);
      await storeAnalysisRun(database, {
        ...first,
        deliveryId: randomUUID(),
        account: "stale-account",
        repository: { ...first.repository, fullName: "stale/name" },
      });
      const workspace = await database.workspace.findUniqueOrThrow({
        where: { installationId: first.installationId },
        include: { repositories: true },
      });
      expect(workspace.account).toBe(first.account);
      expect(workspace.repositories[0]?.fullName).toBe(first.repository.fullName);
      expect(
        await database.page.count({ where: { repositoryId: workspace.repositories[0]?.id } }),
      ).toBe(0);
    } finally {
      await database.workspace.deleteMany({
        where: { installationId: { in: [first.installationId, other.installationId] } },
      });
      await database.$disconnect();
    }
  },
);
