import { describe, expect, it, vi } from "vitest";
import { dashboardResponse, mapRun, type RunRecord, readLiveDashboard } from "./dashboard-data";
import { getDemoDashboard } from "./demo-data";

const database = vi.hoisted(() => ({
  repository: { findMany: vi.fn() },
  analysisRun: { findMany: vi.fn() },
  webhookDelivery: { findMany: vi.fn() },
  disconnect: vi.fn(),
}));
vi.mock("@groundskeeper/database/client", () => ({
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
const record: RunRecord = {
  id: "r1",
  repository: { fullName: "org/sdk" },
  beforeCommit: "abc",
  afterCommit: "def",
  createdAt: new Date("2026-09-21T12:00:00Z"),
  report: { health: { total_claims: 5, affected_claims: 0 }, claims: [{ text: "secret source" }] },
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

describe("dashboard report projection", () => {
  it("leaves unverified analysis unknown and does not leak source", () => {
    const run = mapRun(record);
    expect(run.status).toBe("unknown");
    expect(run.totalClaims).toBe(5);
    expect(JSON.stringify(run)).not.toContain("secret source");
  });
  it("marks affected claims for review even with passing execution", () => {
    expect(
      mapRun({
        ...record,
        report: { health: { affected_claims: 2, total_claims: 5 } },
        verificationRuns: [{ report: { evidence: [{ outcome: "passed" }] } }],
      }).status,
    ).toBe("needs-review");
  });
  it("uses newest evidence and excludes raw execution output and arbitrary reasons", () => {
    const run = mapRun({
      ...record,
      verificationRuns: [
        {
          report: {
            evidence: [
              {
                outcome: "passed",
                stdout: "password",
                reason: "secret",
                claim_id: "sensitive-path",
              },
            ],
          },
        },
        { report: { evidence: [{ outcome: "failed" }] } },
      ],
    });
    expect(run.status).toBe("verified");
    expect(run.evidence[0]?.status).toBe("passed");
    expect(JSON.stringify(run)).not.toMatch(/password|secret|sensitive-path/);
  });
  it("bounds displayed evidence without losing a failure beyond the display limit", () => {
    const evidence = [
      ...Array.from({ length: 100 }, () => ({ outcome: "passed" })),
      { outcome: "failed" },
    ];
    const run = mapRun({ ...record, verificationRuns: [{ report: { evidence } }] });
    expect(run.evidence).toHaveLength(100);
    expect(run.status).toBe("needs-review");
  });
  it("does not turn skipped, error, or malformed reports into verified runs", () => {
    for (const report of [
      null,
      { evidence: [{ outcome: "skipped" }] },
      { evidence: [{ outcome: "error" }] },
      { evidence: [{ outcome: "other" }] },
    ]) {
      expect(mapRun({ ...record, verificationRuns: [{ report }] }).status).toBe("unknown");
    }
  });
});

describe("live query boundaries", () => {
  it("scopes every query, bounds results, and excludes webhook payloads", async () => {
    database.repository.findMany.mockResolvedValue([
      { id: "repo1", githubId: 7n, fullName: "org/sdk", defaultBranch: "main" },
    ]);
    database.analysisRun.findMany.mockResolvedValue([record]);
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
    expect(database.analysisRun.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { repository: { workspace: { installationId: 42n } } },
        take: 50,
      }),
    );
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
