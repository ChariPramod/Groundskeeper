import { beforeEach, describe, expect, it, vi } from "vitest";
import { operationsResponse, readLiveOperations } from "./operations-data";
import { demoOperations, isOperationsData, recoveryCommands } from "./operations-types";

const database = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  disconnect: vi.fn(),
  options: vi.fn(),
}));
vi.mock("@groundskeeper/database/client", () => ({
  PrismaClient: class {
    $transaction(fn: (tx: typeof database) => Promise<unknown>, options: unknown) {
      database.options(options);
      return fn(database);
    }
    $disconnect() {
      return database.disconnect();
    }
  },
}));
const env = {
  DASHBOARD_MODE: "live",
  DASHBOARD_INSTALLATION_ID: "42",
  DASHBOARD_ACCESS_TOKEN: "token",
  DATABASE_URL: "postgresql://localhost/test",
};
const request = (token = "token") =>
  new Request("https://example.com/api/operations", {
    headers: { Authorization: `Bearer ${token}` },
  });
const emptyQueue = () => ({
  pending: 0n,
  processing: 0n,
  retrying: 0n,
  failed: 0n,
  stalled: 0n,
  total: 0n,
  invalid: 0n,
  oldest: null,
});
const mockResults = (queue = emptyQueue(), jobs: unknown[] = [], completed = 0n) => {
  database.$queryRaw
    .mockReset()
    .mockResolvedValueOnce([queue])
    .mockResolvedValueOnce([{ completed, latest: null }])
    .mockResolvedValueOnce(jobs);
};
beforeEach(() => {
  vi.clearAllMocks();
  mockResults();
});

describe("operations boundaries", () => {
  it("labels sample data without reaching persistence", async () => {
    const read = vi.fn();
    const response = await operationsResponse(request(), {}, read);
    expect(await response.json()).toEqual(demoOperations());
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects absent, wrong and partially configured access before persistence", async () => {
    for (const token of ["", "wrong"]) {
      const read = vi.fn();
      expect((await operationsResponse(request(token), env, read)).status).toBe(401);
      expect(read).not.toHaveBeenCalled();
    }
    const read = vi.fn();
    expect(
      (await operationsResponse(request(), { ...env, AUTH_SECRET: "partial" }, read)).status,
    ).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
  it("passes the authorized installation and redacts operational errors", async () => {
    const read = vi.fn().mockRejectedValue(new Error("PASSWORD payload stdout"));
    const result = await operationsResponse(request(), env, read);
    expect(read).toHaveBeenCalledWith(42n, env.DATABASE_URL);
    expect(result.status).toBe(503);
    expect(await result.text()).not.toMatch(/PASSWORD|payload|stdout/);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("vary")).toContain("Cookie");
  });
  it("executes exactly three parameterized data reads with tenant scope and bounded snapshot transaction", async () => {
    await readLiveOperations(42n, env.DATABASE_URL);
    expect(database.$queryRaw).toHaveBeenCalledTimes(3);
    for (const call of database.$queryRaw.mock.calls) {
      const sql = call[0].join("?");
      expect(sql).toContain('"installationId" = ?');
      expect(call.slice(1)).toContain(42n);
      expect(sql).not.toMatch(/payload|lastError|leaseToken/);
    }
    const queueSql = database.$queryRaw.mock.calls[0]?.[0].join("?");
    const jobsSql = database.$queryRaw.mock.calls[2]?.[0].join("?");
    expect(queueSql).toContain("FILTER");
    for (const sql of [queueSql, jobsSql]) {
      expect(sql).toContain("event IN ('push', 'pull_request')");
      expect(sql).toContain('"processedAt" IS NULL');
    }
    expect(jobsSql).toContain('ORDER BY "receivedAt" ASC, id ASC LIMIT 10');
    expect(database.options).toHaveBeenCalledWith({
      maxWait: 5000,
      timeout: 10000,
      isolationLevel: "RepeatableRead",
    });
    expect(database.$executeRaw).toHaveBeenCalledTimes(1);
    expect(database.disconnect).toHaveBeenCalled();
  });
  it("counts all matching jobs independently of the sample without claiming worker health", async () => {
    mockResults(
      {
        ...emptyQueue(),
        pending: 100n,
        processing: 20n,
        retrying: 30n,
        failed: 40n,
        stalled: 2n,
        total: 190n,
      },
      [],
      500n,
    );
    const result = await readLiveOperations(42n, env.DATABASE_URL);
    expect(result.queue).toMatchObject({
      pending: 100,
      processing: 20,
      retrying: 30,
      failed: 40,
      stalled: 2,
      total: 190,
    });
    expect(result.jobs).toEqual([]);
    expect(result.analyses.completedLast24Hours).toBe(500);
    expect(result.workerStatus).toBe("unknown");
  });
  it("fails closed on unsafe bigint counts, invalid attempts or contradictory totals", async () => {
    for (const patch of [
      { pending: 9007199254740992n, total: 9007199254740992n },
      { invalid: 1n },
      { failed: -1n },
      { total: 1n },
      { stalled: 1n },
    ]) {
      mockResults({ ...emptyQueue(), ...patch });
      await expect(readLiveOperations(42n, env.DATABASE_URL)).rejects.toThrow();
    }
    mockResults(emptyQueue(), [], 9007199254740992n);
    await expect(readLiveOperations(42n, env.DATABASE_URL)).rejects.toThrow(
      "Unsafe operations count",
    );
  });
  it("keeps empty activity unknown, not a passing pipeline", async () => {
    const result = await readLiveOperations(42n, env.DATABASE_URL);
    expect(result.workerStatus).toBe("unknown");
    expect(result.queue.total).toBe(0);
    expect(result.queue.oldestUnfinishedAt).toBeNull();
    expect(result.analyses.latestAt).toBeNull();
    expect(isOperationsData(result)).toBe(true);
  });
  it("returns only allowed job summaries", async () => {
    mockResults(emptyQueue(), [
      {
        id: "job",
        event: "push",
        failedAt: new Date(),
        attemptCount: 5,
        receivedAt: new Date("2026-10-01"),
        nextAttemptAt: null,
        payload: "SECRET",
        lastError: "SECRET",
        leaseToken: "SECRET",
      },
    ]);
    const result = await readLiveOperations(42n, env.DATABASE_URL);
    expect(result.jobs[0]).toEqual({
      id: "job",
      event: "push",
      status: "failed",
      attempts: 5,
      receivedAt: "2026-10-01T00:00:00.000Z",
      nextAttemptAt: null,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("always disconnects when the transaction fails", async () => {
    database.$queryRaw.mockReset().mockRejectedValueOnce(new Error("offline"));
    await expect(readLiveOperations(42n, env.DATABASE_URL)).rejects.toThrow("offline");
    expect(database.disconnect).toHaveBeenCalled();
  });
});
describe("operations contracts", () => {
  it("validates samples and rejects contradictory or falsely healthy data", () => {
    expect(isOperationsData(demoOperations())).toBe(true);
    for (const data of [
      { ...demoOperations(), workerStatus: "healthy" },
      { ...demoOperations(), installationId: "x; command" },
      { ...demoOperations(), jobs: Array(11).fill(demoOperations().jobs[0]) },
      { ...demoOperations(), queue: { ...demoOperations().queue, total: 999 } },
      { ...demoOperations(), generatedAt: "invalid" },
    ])
      expect(isOperationsData(data)).toBe(false);
  });
  it("generates inspect-first commands and terminal-only retries with shell quoting", () => {
    const data = demoOperations();
    const [first, second] = data.jobs;
    if (!first || !second) throw new Error("Missing demo fixtures");
    const failed = recoveryCommands(data, { ...first, id: "bad'$(echo secret)" });
    expect(failed.inspect).toBe("pnpm queue --installation-id '42' --event 'push'");
    expect(failed.retry).toContain("--retry-failed 'bad'\\''$(echo secret)'");
    expect(recoveryCommands(data, second).retry).toBeNull();
  });
});
