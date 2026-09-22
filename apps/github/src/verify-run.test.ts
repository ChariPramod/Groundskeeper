import type { AnalysisReport, VerificationReport } from "@groundskeeper/contracts";
import { type Prisma, type PrismaClient, storeVerificationRun } from "@groundskeeper/database";
import { extractClaims } from "@groundskeeper/parser";
import { expect, it, vi } from "vitest";
import { analyzeLocally } from "./analysis.js";
import { type VerificationRunDependencies, verifyLocally, verifyStoredRun } from "./verify-run.js";

const analysis: AnalysisReport = {
  claims: [],
  symbols: [],
  links: [],
  impacts: [],
  changed_symbol_ids: [],
  warnings: [],
  health: {
    total_claims: 0,
    linked_claims: 0,
    affected_claims: 0,
    link_coverage: 0,
    verified_share: 0,
    statuses: {},
  },
};
const evidence: VerificationReport = {
  id: "c".repeat(32),
  created_at: "2026-09-20T00:00:00Z",
  source_digest: "d".repeat(64),
  image: "python:3.12-slim",
  claims: [],
  evidence: [],
  outcomes: { passed: 0, failed: 0, error: 0, skipped: 0 },
  statuses: {},
};
const options = { image: "python:3.12-slim", maxBlocks: 10 };
function setup() {
  const order: string[] = [];
  const snapshot = vi.fn().mockResolvedValue([
    { path: "client.py", content: "def send(): pass" },
    { path: "README.md", content: "docs" },
    { path: "client.ts", content: "export const send = 1;" },
  ]);
  const dependencies: VerificationRunDependencies = {
    load: vi.fn().mockResolvedValue({
      id: "analysis-1",
      installationId: 42n,
      repositoryId: 7n,
      fullName: "team/docs",
      afterCommit: "b".repeat(40),
      report: analysis,
    }),
    gateway: vi.fn().mockResolvedValue({
      repository: async () => ({
        githubId: 7,
        fullName: "team/docs",
        account: "team",
        defaultBranch: "main",
      }),
      snapshot,
    }),
    execute: vi.fn().mockResolvedValue(evidence),
    saveArtifact: vi.fn(async () => {
      order.push("artifact");
    }),
    persist: vi.fn(async () => {
      order.push("persist");
    }),
  };
  return { dependencies, order, snapshot };
}

it("pins verification to stored commit, filters Python sources, saves evidence before persistence", async () => {
  const { dependencies, order, snapshot } = setup();
  await verifyStoredRun("analysis-1", 42n, options, dependencies);
  expect(snapshot).toHaveBeenCalledWith("team/docs", "b".repeat(40));
  expect(dependencies.execute).toHaveBeenCalledWith({
    analysis,
    sources: [{ path: "client.py", content: "def send(): pass" }],
    image: "python:3.12-slim",
    limits: { max_blocks: 10, timeout_seconds: 10 },
  });
  expect(order).toEqual(["artifact", "persist"]);
  expect(dependencies.persist).toHaveBeenCalledWith(
    expect.objectContaining({
      analysisRunId: "analysis-1",
      installationId: 42n,
      repositoryId: 7n,
      afterCommit: "b".repeat(40),
      report: evidence,
    }),
  );
});

it("rejects cross-installation loads before network or execution", async () => {
  const { dependencies } = setup();
  await expect(verifyStoredRun("analysis-1", 43n, options, dependencies)).rejects.toThrow(
    "not found",
  );
  expect(dependencies.gateway).not.toHaveBeenCalled();
  expect(dependencies.execute).not.toHaveBeenCalled();
});

it("records infrastructure error reports instead of discarding them", async () => {
  const { dependencies } = setup();
  const report = { ...evidence, outcomes: { ...evidence.outcomes, error: 1 } };
  dependencies.execute = vi.fn().mockResolvedValue(report);
  expect(await verifyStoredRun("analysis-1", 42n, options, dependencies)).toBe(report);
  expect(dependencies.persist).toHaveBeenCalledOnce();
});

it("retains an artifact if persistence fails, and never persists after artifact failure", async () => {
  const { dependencies, order } = setup();
  dependencies.persist = vi.fn().mockRejectedValue(new Error("database down"));
  await expect(verifyStoredRun("analysis-1", 42n, options, dependencies)).rejects.toThrow(
    "database down",
  );
  expect(order).toEqual(["artifact"]);
  dependencies.saveArtifact = vi.fn().mockRejectedValue(new Error("disk full"));
  vi.mocked(dependencies.persist).mockClear();
  await expect(verifyStoredRun("analysis-1", 42n, options, dependencies)).rejects.toThrow(
    "disk full",
  );
  expect(dependencies.persist).not.toHaveBeenCalled();
});

it("rejects invalid budgets before loading a run", async () => {
  const { dependencies } = setup();
  for (const maxBlocks of [-1, 11, Number.NaN, 1.5]) {
    await expect(
      verifyStoredRun("analysis-1", 42n, { ...options, maxBlocks }, dependencies),
    ).rejects.toThrow("max-blocks");
  }
  expect(dependencies.load).not.toHaveBeenCalled();
});

it.each([
  { name: "standalone", markdown: "```python groundskeeper:run\nsend()\n```", count: 1 },
  {
    name: "tutorial",
    markdown: [
      "```python groundskeeper:run groundskeeper:session=setup\nvalue = 1\n```",
      "```python groundskeeper:run groundskeeper:session=setup\nsend(value)\n```",
      "```python groundskeeper:run groundskeeper:session=setup\nprint(value)\n```",
    ].join("\n\n"),
    count: 3,
  },
])(
  "runs real $name bridges and storage validation with zero execution budget",
  async ({ markdown, count }) => {
    const claims = extractClaims(markdown, "README.md");
    const analysis = await analyzeLocally({
      claims,
      before: [{ path: "client.py", content: "def send(): pass" }],
      after: [{ path: "client.py", content: "def deliver(): pass" }],
    });
    const report = await verifyLocally({
      analysis,
      sources: [{ path: "client.py", content: "def deliver(): pass" }],
      image: "python:3.12-slim",
      limits: { max_blocks: 0, timeout_seconds: 10 },
    });
    expect(report.outcomes.skipped).toBe(count);
    expect(report.claims[0]?.status).toBe("unknown");
    expect(report.evidence[0]?.source_digest).toBe(report.source_digest);
    expect(report.evidence[0]?.image_id).toBeNull();
    const create = vi.fn().mockResolvedValue({ id: report.id });
    const transaction = {
      analysisRun: {
        findUnique: vi.fn().mockResolvedValue({
          afterCommit: "b".repeat(40),
          report: analysis,
          repository: { githubId: 7n, workspace: { installationId: 42n } },
        }),
      },
      verificationRun: { findUnique: vi.fn().mockResolvedValue(null), create },
    };
    const database = {
      $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    } as unknown as PrismaClient;
    const result = await storeVerificationRun(database, {
      analysisRunId: "analysis-1",
      installationId: 42n,
      repositoryId: 7n,
      afterCommit: "b".repeat(40),
      report: report as unknown as Prisma.InputJsonObject,
    });
    expect(result).toEqual({ runId: report.id, created: true });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ report, sourceDigest: report.source_digest }),
    });
  },
);
