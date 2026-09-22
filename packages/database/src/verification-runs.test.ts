import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  Prisma,
  PrismaClient,
  type StoreVerificationRunInput,
  storeAnalysisRun,
  storeVerificationRun,
  VerificationRunConflictError,
  VerificationRunOwnershipError,
} from "./index.js";

function claim() {
  return {
    id: "claim",
    kind: "code",
    status: "verified",
    page: "docs/example.md",
    text: "print(1)",
    language: "python",
    runnable: true,
    expected_output: "1",
  };
}

function input(): StoreVerificationRunInput {
  return {
    analysisRunId: "analysis",
    installationId: 123n,
    repositoryId: 456n,
    afterCommit: "b".repeat(40),
    report: {
      schema_version: "1",
      id: randomUUID(),
      created_at: "2026-09-20T00:00:00Z",
      source_digest: "a".repeat(64),
      image: "python:3.12-slim",
      claims: [claim()],
      evidence: [
        {
          id: "evidence",
          claim_id: "claim",
          source_digest: "a".repeat(64),
          outcome: "passed",
          status: "verified",
        },
      ],
      outcomes: { passed: 1 },
      statuses: { verified: 1 },
    },
  };
}

function fakeDatabase(
  analysis: Prisma.InputJsonObject = {
    claims: [claim()],
    impacts: [{ claim_id: "claim" }],
  },
) {
  const runs = new Map<string, { id: string; inputDigest: string }>();
  const tx = {
    analysisRun: {
      findUnique: vi.fn(async () => ({
        afterCommit: "b".repeat(40),
        report: analysis,
        repository: { githubId: 456n, workspace: { installationId: 123n } },
      })),
    },
    verificationRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => runs.get(where.id)),
      create: vi.fn(async ({ data }: { data: { id: string; inputDigest: string } }) => {
        runs.set(data.id, data);
        return data;
      }),
    },
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
  return { database: { $transaction: transaction } as unknown as PrismaClient, tx, transaction };
}

describe("verification persistence", () => {
  it("accepts replay with reordered JSON and allows explicit new attempts", async () => {
    const { database, tx } = fakeDatabase();
    const first = input();
    expect(await storeVerificationRun(database, first)).toEqual({
      runId: first.report.id,
      created: true,
    });
    expect(
      await storeVerificationRun(database, {
        ...first,
        afterCommit: first.afterCommit.toUpperCase(),
        report: Object.fromEntries(Object.entries(first.report).reverse()),
      }),
    ).toEqual({ runId: first.report.id, created: false });
    expect((await storeVerificationRun(database, input())).created).toBe(true);
    expect(tx.verificationRun.create).toHaveBeenCalledTimes(2);
  });

  it("rejects report replacement and reassignment without updating evidence", async () => {
    const { database, tx } = fakeDatabase();
    const first = input();
    await storeVerificationRun(database, first);
    for (const change of [
      { report: { ...first.report, image: "changed" } },
      { analysisRunId: "another" },
    ]) {
      await expect(storeVerificationRun(database, { ...first, ...change })).rejects.toBeInstanceOf(
        VerificationRunConflictError,
      );
    }
    expect(tx.verificationRun.create).toHaveBeenCalledTimes(1);
  });

  it("checks ownership inside the transaction even for existing reports", async () => {
    const { database, tx } = fakeDatabase();
    const first = input();
    await storeVerificationRun(database, first);
    for (const change of [
      { installationId: 999n },
      { repositoryId: 999n },
      { afterCommit: "c".repeat(40) },
    ]) {
      await expect(storeVerificationRun(database, { ...first, ...change })).rejects.toBeInstanceOf(
        VerificationRunOwnershipError,
      );
    }
    expect(tx.verificationRun.findUnique).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed reports and digest mixing before opening transactions", async () => {
    const { database, transaction } = fakeDatabase();
    const first = input();
    for (const change of [
      { id: "" },
      { schema_version: "2" },
      { source_digest: "bad" },
      { created_at: "bad" },
      { claims: null },
      { outcomes: { passed: -1 } },
      { extra: Number.NaN },
      { evidence: [{ id: "e", claim_id: "c", outcome: "passed", source_digest: "c".repeat(64) }] },
    ]) {
      await expect(
        storeVerificationRun(database, { ...first, report: { ...first.report, ...change } }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects unrelated or repeated claims and missing evidence", async () => {
    const { database, tx } = fakeDatabase();
    const first = input();
    for (const change of [
      { claims: [{ id: "unrelated" }] },
      { claims: [{ id: "claim" }, { id: "claim" }] },
      { evidence: [] },
      { claims: [] },
      { outcomes: { passed: 0 } },
      { statuses: { verified: 2 } },
    ]) {
      await expect(
        storeVerificationRun(database, { ...first, report: { ...first.report, ...change } }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(tx.verificationRun.create).not.toHaveBeenCalled();
    expect(
      (
        await storeVerificationRun(database, {
          ...first,
          report: { ...first.report, claims: [], evidence: [], outcomes: {}, statuses: {} },
        })
      ).created,
    ).toBe(true);
  });

  it("rejects altered assertions under a reused claim ID", async () => {
    const { database, tx } = fakeDatabase();
    for (const change of [
      { page: "other.md" },
      { kind: "paragraph" },
      { text: "print(2)" },
      { language: "bash" },
      { runnable: false },
      { expected_output: "2" },
      { session: "tutorial" },
      { position: { start_line: 1, start_column: 1, end_line: 3, end_column: 1 } },
    ]) {
      const first = input();
      await expect(
        storeVerificationRun(database, {
          ...first,
          report: { ...first.report, claims: [{ ...claim(), ...change }] },
        }),
      ).rejects.toThrow("assertion differs");
    }
    expect(tx.verificationRun.create).not.toHaveBeenCalled();
  });

  it("expands affected sessions without including other pages or unrelated sessions", async () => {
    const setup = { ...claim(), id: "setup", session: "tutorial", text: "value = 1" };
    const affected = { ...claim(), session: "tutorial" };
    const otherPage = { ...setup, id: "other-page", page: "docs/other.md" };
    const otherSession = { ...setup, id: "other-session", session: "unrelated" };
    const standalone = { ...claim(), id: "standalone" };
    const { database, tx } = fakeDatabase({
      claims: [setup, affected, otherPage, otherSession, standalone],
      impacts: [{ claim_id: affected.id }],
    });
    const first = input();
    const reportFor = (claims: Prisma.InputJsonObject[]) => ({
      ...first.report,
      id: randomUUID(),
      claims,
      evidence: claims.map((item) => ({
        id: `evidence-${item.id}`,
        claim_id: item.id,
        source_digest: first.report.source_digest,
        outcome: "passed",
        status: "verified",
      })),
      outcomes: { passed: claims.length },
      statuses: { verified: claims.length },
    });
    expect(
      (await storeVerificationRun(database, { ...first, report: reportFor([setup, affected]) }))
        .created,
    ).toBe(true);
    for (const unrelated of [otherPage, otherSession, standalone]) {
      await expect(
        storeVerificationRun(database, {
          ...first,
          report: reportFor([setup, affected, unrelated]),
        }),
      ).rejects.toThrow("uniquely reference affected code claims");
    }
    for (const incomplete of [[affected], [setup]]) {
      await expect(
        storeVerificationRun(database, { ...first, report: reportFor(incomplete) }),
      ).rejects.toThrow("every code claim in a selected tutorial session");
    }
    expect(tx.verificationRun.create).toHaveBeenCalledTimes(1);
  });

  it("preserves session labels and source order provenance", async () => {
    const original = {
      ...claim(),
      session: "tutorial",
      position: { start_line: 10, start_column: 1, end_line: 12, end_column: 4 },
    };
    const { database } = fakeDatabase({
      claims: [original],
      impacts: [{ claim_id: original.id }],
    });
    for (const change of [
      { session: "other" },
      { session: null },
      { position: { ...original.position, start_line: 9 } },
      { position: null },
    ]) {
      const first = input();
      await expect(
        storeVerificationRun(database, {
          ...first,
          report: { ...first.report, claims: [{ ...original, ...change }] },
        }),
      ).rejects.toThrow("assertion differs");
    }
    const first = input();
    expect(
      (
        await storeVerificationRun(database, {
          ...first,
          report: {
            ...first.report,
            claims: [
              {
                ...original,
                position: Object.fromEntries(Object.entries(original.position).reverse()),
              },
            ],
          },
        })
      ).created,
    ).toBe(true);
  });

  it("rejects evidence status contradictory to claim or outcome", async () => {
    const { database, tx } = fakeDatabase();
    for (const change of [
      { status: "stale", outcome: "failed" },
      { status: "verified", outcome: "error" },
      { status: "verified", outcome: "skipped" },
    ]) {
      const first = input();
      await expect(
        storeVerificationRun(database, {
          ...first,
          report: {
            ...first.report,
            evidence: [
              { id: "e", claim_id: "claim", source_digest: first.report.source_digest, ...change },
            ],
          },
        }),
      ).rejects.toThrow("status disagrees");
    }
    expect(tx.verificationRun.create).not.toHaveBeenCalled();
  });

  it("retries concurrent unique-key races", async () => {
    const { database, transaction } = fakeDatabase();
    transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("race", { code: "P2002", clientVersion: "6.19.0" }),
    );
    expect((await storeVerificationRun(database, input())).created).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "stores concurrent verification attempts with ownership and immutable replay",
  async () => {
    const database = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const installationId = BigInt(randomInt(1, 2 ** 48 - 1));
    try {
      const analysis = await storeAnalysisRun(database, {
        deliveryId: randomUUID(),
        installationId,
        account: "test",
        repository: { githubId: 456n, fullName: "test/docs", defaultBranch: "main" },
        beforeCommit: "a".repeat(40),
        afterCommit: "b".repeat(40),
        report: {
          claims: [claim()],
          impacts: [{ claim_id: "claim" }],
        },
      });
      const first = { ...input(), installationId, analysisRunId: analysis.runId };
      const results = await Promise.all([
        storeVerificationRun(database, first),
        storeVerificationRun(database, first),
      ]);
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      await expect(
        storeVerificationRun(database, { ...first, installationId: installationId + 1n }),
      ).rejects.toBeInstanceOf(VerificationRunOwnershipError);
      await expect(
        storeVerificationRun(database, { ...first, report: { ...first.report, image: "changed" } }),
      ).rejects.toBeInstanceOf(VerificationRunConflictError);
      await storeVerificationRun(database, {
        ...first,
        report: { ...first.report, id: randomUUID() },
      });
      expect(
        await database.verificationRun.count({ where: { analysisRunId: analysis.runId } }),
      ).toBe(2);
      const stored = await database.verificationRun.findUniqueOrThrow({
        where: { id: String(first.report.id) },
      });
      expect(stored.report).toEqual(first.report);
      expect(stored.sourceDigest).toBe(first.report.source_digest);
    } finally {
      await database.workspace.deleteMany({ where: { installationId } });
      await database.$disconnect();
    }
  },
);
