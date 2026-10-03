import { beforeEach, describe, expect, it, vi } from "vitest";
import { operationsResponse, readLiveOperations } from "./operations-data";
import { demoOperations, isOperationsData, recoveryCommands } from "./operations-types";

const database = vi.hoisted(() => ({
  webhookDelivery: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  analysisRun: { count: vi.fn(), findFirst: vi.fn() },
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
beforeEach(() => {
  vi.clearAllMocks();
  database.webhookDelivery.count.mockReset().mockResolvedValue(0);
  database.webhookDelivery.findFirst.mockResolvedValue(null);
  database.webhookDelivery.findMany.mockResolvedValue([]);
  database.analysisRun.count.mockResolvedValue(0);
  database.analysisRun.findFirst.mockResolvedValue(null);
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
  it("scopes every aggregate and sample query, excludes unsupported events, and bounds the transaction", async () => {
    await readLiveOperations(42n, env.DATABASE_URL);
    for (const call of [
      ...database.webhookDelivery.count.mock.calls,
      ...database.webhookDelivery.findFirst.mock.calls,
      ...database.webhookDelivery.findMany.mock.calls,
    ]) {
      expect(call[0].where).toMatchObject({
        installationId: 42n,
        event: { in: ["push", "pull_request"] },
        processedAt: null,
      });
    }
    for (const call of [
      ...database.analysisRun.count.mock.calls,
      ...database.analysisRun.findFirst.mock.calls,
    ])
      expect(call[0].where).toMatchObject({ repository: { workspace: { installationId: 42n } } });
    expect(database.webhookDelivery.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 10,
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    });
    const selection = database.webhookDelivery.findMany.mock.calls[0]?.[0].select;
    expect(selection).not.toHaveProperty("payload");
    expect(selection).not.toHaveProperty("lastError");
    expect(selection).not.toHaveProperty("leaseToken");
    expect(database.options).toHaveBeenCalledWith({
      maxWait: 5000,
      timeout: 10000,
      isolationLevel: "RepeatableRead",
    });
    expect(database.$executeRaw).toHaveBeenCalled();
    expect(database.disconnect).toHaveBeenCalled();
  });
  it("counts all matching jobs rather than the actionable sample and never claims a healthy worker", async () => {
    database.webhookDelivery.count
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(2);
    database.analysisRun.count.mockResolvedValue(500);
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
  it("keeps empty activity unknown, not a passing pipeline", async () => {
    const result = await readLiveOperations(42n, env.DATABASE_URL);
    expect(result.workerStatus).toBe("unknown");
    expect(result.queue.total).toBe(0);
    expect(result.queue.oldestUnfinishedAt).toBeNull();
    expect(result.analyses.latestAt).toBeNull();
    expect(isOperationsData(result)).toBe(true);
  });
  it("returns only allowed job summaries", async () => {
    database.webhookDelivery.findMany.mockResolvedValue([
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
    database.webhookDelivery.count.mockRejectedValueOnce(new Error("offline"));
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
