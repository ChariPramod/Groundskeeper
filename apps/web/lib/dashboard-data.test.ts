import { describe, expect, it, vi } from "vitest";
import {
  dashboardResponse,
  mapRun,
  readLiveDashboard,
  type SummaryRunRecord,
} from "./dashboard-data";
import { getDemoDashboard } from "./demo-data";

const database = vi.hoisted(() => ({
  repository: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  webhookDelivery: { findMany: vi.fn() },
  disconnect: vi.fn(),
}));
vi.mock("@groundskeeper/database/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@groundskeeper/database/client")>()),
  PrismaClient: class {
    $transaction(callback: (tx: typeof database) => Promise<unknown>) {
      return callback(database);
    }
    $disconnect() {
      return database.disconnect();
    }
  },
}));

const env = {
  DASHBOARD_MODE: "live",
  DASHBOARD_INSTALLATION_ID: "42",
  DASHBOARD_ACCESS_TOKEN: "private-token",
  DATABASE_URL: "postgresql://user:password@localhost/db",
};
const request = (token = "private-token") =>
  new Request("http://localhost/api/dashboard", { headers: { Authorization: `Bearer ${token}` } });
const record: SummaryRunRecord = {
  id: "r1",
  repository: { fullName: "org/sdk" },
  beforeCommit: "abc",
  afterCommit: "def",
  createdAt: new Date("2026-09-21T12:00:00Z"),
  summary: { version: 1, totalClaims: 5, affectedClaims: 0 },
  verificationRuns: [],
};

describe("dashboard access and failure boundaries", () => {
  it("defaults to deterministic demo without reading the database", async () => {
    const read = vi.fn();
    const response = await dashboardResponse(request(), {}, read);
    expect(await response.json()).toEqual(getDemoDashboard());
    expect(read).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("returns isolated demo copies", () => {
    const sample = getDemoDashboard();
    sample.runs.length = 0;
    expect(getDemoDashboard().runs).toHaveLength(7);
  });
  it.each(["", "wrong", "private-token-extra", "é"])(
    "rejects an invalid token %s before reading",
    async (token) => {
      const read = vi.fn();
      expect((await dashboardResponse(request(token), env, read)).status).toBe(401);
      expect(read).not.toHaveBeenCalled();
    },
  );
  it.each(["0", "-1", "42.2", "9223372036854775808", "not-an-id"])(
    "fails closed for invalid installation %s",
    async (id) => {
      const read = vi.fn();
      expect(
        (await dashboardResponse(request(), { ...env, DASHBOARD_INSTALLATION_ID: id }, read))
          .status,
      ).toBe(503);
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("requires explicit complete live configuration", async () => {
    const read = vi.fn();
    for (const overrides of [
      { DASHBOARD_MODE: "production" },
      { DASHBOARD_ACCESS_TOKEN: "" },
      { DATABASE_URL: "" },
    ]) {
      expect((await dashboardResponse(request(), { ...env, ...overrides }, read)).status).toBe(503);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("passes the configured installation, never a query-supplied tenant", async () => {
    const live = { ...getDemoDashboard(), mode: "live" as const };
    const read = vi.fn().mockResolvedValue(live);
    const response = await dashboardResponse(
      new Request("http://localhost/api/dashboard?installationId=999", {
        headers: { Authorization: "Bearer private-token" },
      }),
      env,
      read,
    );
    expect(read).toHaveBeenCalledWith(42n, env.DATABASE_URL);
    expect((await response.json()).mode).toBe("live");
  });
  it("sanitizes live failures without substituting sample data", async () => {
    const response = await dashboardResponse(
      request(),
      env,
      vi.fn().mockRejectedValue(new Error("password=secret SQL failed")),
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("secret");
    expect(body).not.toContain("repositories");
    expect(body).toContain("explicitly switch to demo");
  });
});

describe("dashboard compact report projection", () => {
  const passing = {
    version: 1,
    evidenceCount: 1,
    outcomes: ["passed"],
    allPassed: true,
    hasFailed: false,
  };
  it("leaves unverified analysis unknown", () => {
    const run = mapRun(record);
    expect(run.status).toBe("unknown");
    expect(run.totalClaims).toBe(5);
  });
  it("marks affected claims for review even with passing execution", () => {
    expect(
      mapRun({
        ...record,
        summary: { version: 1, affectedClaims: 2, totalClaims: 5 },
        verificationRuns: [{ summary: passing }],
      }).status,
    ).toBe("needs-review");
  });
  it("uses newest evidence and exposes only fixed descriptions", () => {
    const run = mapRun({
      ...record,
      verificationRuns: [
        {
          summary: { ...passing, stdout: "password", reason: "secret", claim_id: "sensitive-path" },
        },
        { summary: { ...passing, outcomes: ["failed"], allPassed: false, hasFailed: true } },
      ],
    });
    expect(run.status).toBe("verified");
    expect(run.evidence[0]?.status).toBe("passed");
    expect(JSON.stringify(run)).not.toMatch(/password|secret|sensitive-path/);
  });
  it("keeps failed and unexecuted outcomes beyond the displayed 100 in the verdict", () => {
    const summary = {
      ...passing,
      evidenceCount: 101,
      outcomes: Array(100).fill("passed"),
      allPassed: false,
    };
    const failed = mapRun({
      ...record,
      verificationRuns: [{ summary: { ...summary, hasFailed: true } }],
    });
    expect(failed.evidence).toHaveLength(100);
    expect(failed.status).toBe("needs-review");
    expect(mapRun({ ...record, verificationRuns: [{ summary }] }).status).toBe("unknown");
  });
  it("fails closed for malformed, missing, future-version or inconsistent summaries", () => {
    for (const summary of [
      null,
      {},
      { ...passing, version: 2 },
      { ...passing, outcomes: ["skipped"] },
      { ...passing, outcomes: ["other"] },
      { ...passing, outcomes: [["passed"]] },
      { ...passing, evidenceCount: 0 },
    ])
      expect(mapRun({ ...record, verificationRuns: [{ summary }] }).status).toBe("unknown");
    for (const summary of [
      null,
      {},
      { version: 2, affectedClaims: 0, totalClaims: 5 },
      { version: 1, affectedClaims: -1, totalClaims: 5 },
    ])
      expect(mapRun({ ...record, summary, verificationRuns: [{ summary: passing }] }).status).toBe(
        "unknown",
      );
  });
});

describe("live query boundaries", () => {
  it("scopes every query, bounds results, and excludes webhook payloads", async () => {
    database.repository.findMany.mockResolvedValue([
      { id: "repo1", githubId: 7n, fullName: "org/sdk", defaultBranch: "main" },
    ]);
    database.$queryRaw.mockResolvedValue([
      { ...record, fullName: "org/sdk", verificationSummary: null, reviewId: null },
    ]);
    database.webhookDelivery.findMany.mockResolvedValue([
      {
        id: "d1",
        repositoryId: 7n,
        event: "push",
        attemptCount: 5,
        receivedAt: new Date("2026-09-21T12:00:00Z"),
        nextAttemptAt: null,
        failedAt: new Date(),
        leaseExpiresAt: null,
      },
    ]);
    const result = await readLiveDashboard(42n, env.DATABASE_URL);
    expect(database.repository.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspace: { installationId: 42n } }, take: 50 }),
    );
    expect(database.$queryRaw).toHaveBeenCalledOnce();
    const runQuery = database.$queryRaw.mock.lastCall?.[0];
    expect(runQuery.values).toEqual([42n, 50]);
    expect(runQuery.sql).toContain("LIMIT 1");
    expect(runQuery.sql).not.toContain(".report");
    expect(runQuery.sql).not.toContain('"SharedReview"');
    const queueQuery = database.webhookDelivery.findMany.mock.lastCall?.[0];
    expect(queueQuery.where).toEqual({
      installationId: 42n,
      event: { in: ["push", "pull_request"] },
      processedAt: null,
    });
    expect(queueQuery.take).toBe(50);
    expect(queueQuery.select).not.toHaveProperty("payload");
    expect(queueQuery.select).not.toHaveProperty("lastError");
    expect(result.queue[0]).toMatchObject({ repository: "org/sdk", status: "failed", attempts: 5 });
    expect(JSON.stringify(result)).not.toContain("githubId");
    expect(database.disconnect).toHaveBeenCalled();
  });
  it("disconnects its client when a database read fails", async () => {
    database.disconnect.mockClear();
    database.repository.findMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(readLiveDashboard(42n, env.DATABASE_URL)).rejects.toThrow("database unavailable");
    expect(database.disconnect).toHaveBeenCalledOnce();
  });
});
