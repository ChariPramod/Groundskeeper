import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "./dashboard-data";
import { mapReview, readLiveReview, reviewResponse } from "./review-data";
import { getDemoReview } from "./review-demo";

const database = vi.hoisted(() => ({ analysisRun: { findFirst: vi.fn() }, disconnect: vi.fn() }));
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
  DASHBOARD_ACCESS_TOKEN: "secret",
  DATABASE_URL: "postgresql://local/db",
};
const request = (token = "secret") =>
  new Request("http://localhost/api/review/r1", { headers: { Authorization: `Bearer ${token}` } });
const record: RunRecord = {
  id: "r1",
  repository: { fullName: "org/sdk" },
  beforeCommit: "a",
  afterCommit: "b",
  createdAt: new Date(),
  verificationRuns: [
    {
      report: {
        evidence: [
          {
            claim_id: "c1",
            outcome: "failed",
            reason: "r".repeat(600),
            stdout: "PRIVATE OUTPUT",
            stderr: "PRIVATE ERROR",
          },
        ],
      },
    },
  ],
  report: {
    claims: [{ id: "c1", page: "docs.md", text: "t".repeat(5000), position: { start_line: 9 } }],
    impacts: [{ claim_id: "c1", reason: "Changed signature", symbol_ids: ["s1", "s2"] }],
    symbols: [
      {
        id: "s1",
        qualified_name: "Client.send",
        path: "client.py",
        fingerprint: "PRIVATE FINGERPRINT",
      },
      { id: "s2", name: "Unchanged" },
    ],
    changed_symbol_ids: ["s1"],
  },
};
describe("review data boundaries", () => {
  it("bounds excerpts and reasons and excludes sandbox output and raw symbol metadata", () => {
    const detail = mapReview(record);
    expect(detail.findings[0]?.text).toHaveLength(4000);
    expect(detail.findings[0]?.execution?.reason).toHaveLength(500);
    expect(detail.findings[0]?.symbols).toEqual([{ name: "Client.send", path: "client.py" }]);
    expect(JSON.stringify(detail)).not.toContain("PRIVATE");
  });
  it("prioritizes affected claims and caps records", () => {
    const detail = mapReview({
      ...record,
      report: {
        claims: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}` })),
        impacts: [{ claim_id: "c29", reason: "impact" }],
      },
    });
    expect(detail.findings).toHaveLength(20);
    expect(detail.findings[0]?.id).toBe("c29");
    expect(detail.truncated).toBe(true);
  });
  it("returns unknown execution for missing evidence and tolerates malformed legacy reports", () => {
    expect(mapReview({ ...record, report: null }).findings).toEqual([]);
    expect(mapReview({ ...record, verificationRuns: [] }).findings[0]?.execution).toBeNull();
  });
  it("authenticates before reading and rejects unsupported configuration", async () => {
    const read = vi.fn();
    expect((await reviewResponse(request("bad"), "r1", env, read)).status).toBe(401);
    expect(
      (await reviewResponse(request(), "r1", { ...env, DASHBOARD_MODE: "broken" }, read)).status,
    ).toBe(503);
    expect(
      (await reviewResponse(request(), "r1", { ...env, DASHBOARD_INSTALLATION_ID: "0" }, read))
        .status,
    ).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
  it("returns scoped not-found instead of revealing other installations", async () => {
    database.analysisRun.findFirst.mockResolvedValueOnce(null);
    const response = await reviewResponse(request(), "r1", env);
    expect(response.status).toBe(404);
    expect(database.analysisRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", repository: { workspace: { installationId: 42n } } },
      }),
    );
    expect(database.disconnect).toHaveBeenCalled();
  });
  it("does not substitute demo or expose exception contents when live reading fails", async () => {
    const response = await reviewResponse(request(), "run-1042", env, async () => {
      throw new Error("PRIVATE DATABASE URL");
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("returns only known demo fixtures without database reads", async () => {
    const read = vi.fn();
    expect((await reviewResponse(request(), "run-1042", {}, read)).status).toBe(200);
    expect((await reviewResponse(request(), "unknown", {}, read)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(getDemoReview("run-1042")?.mode).toBe("demo");
  });
  it("selects latest verification and disconnects even on read errors", async () => {
    database.analysisRun.findFirst.mockResolvedValueOnce(record);
    expect((await readLiveReview("r1", 42n, env.DATABASE_URL))?.id).toBe("r1");
    expect(database.analysisRun.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          verificationRuns: {
            take: 1,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { report: true },
          },
        }),
      }),
    );
    database.analysisRun.findFirst.mockRejectedValueOnce(new Error("offline"));
    await expect(readLiveReview("r1", 42n, env.DATABASE_URL)).rejects.toThrow("offline");
    expect(database.disconnect).toHaveBeenCalled();
  });
});
