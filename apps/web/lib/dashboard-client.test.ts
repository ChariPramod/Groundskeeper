import { describe, expect, it, vi } from "vitest";
import { fetchDashboard, isDashboardData } from "./dashboard-client";
import { getDemoDashboard } from "./demo-data";

describe("dashboard response validation", () => {
  it("accepts complete demo and live data", () => {
    expect(isDashboardData(getDemoDashboard())).toBe(true);
    expect(isDashboardData({ ...getDemoDashboard(), mode: "live" })).toBe(true);
  });
  it.each([
    { mode: "other" },
    { generatedAt: "yesterday" },
    { generatedAt: "2026-02-30T12:00:00.000Z" },
    { repositories: [{}] },
    { runs: [{}] },
    { queue: [{}] },
    { queue: null },
    { repositories: Array(51).fill({}) },
  ])("rejects malformed top-level or incomplete records %j", (change) => {
    expect(isDashboardData({ ...getDemoDashboard(), ...change })).toBe(false);
  });
  it.each([
    { affectedClaims: -1 },
    { totalClaims: Infinity },
    { totalClaims: 0 },
    { status: "passed" },
    { createdAt: "2026-invalid" },
    { evidence: [{ id: "e", label: "test", status: "passed", detail: 3 }] },
    { evidence: Array(101).fill({ id: "e", label: "test", status: "passed", detail: "ok" }) },
  ])("rejects invalid run details %j", (change) => {
    const data = getDemoDashboard();
    data.runs = [{ ...data.runs[0], ...change }] as typeof data.runs;
    expect(isDashboardData(data)).toBe(false);
  });
  it("rejects invalid queue dates and numeric attempts", () => {
    const data = getDemoDashboard();
    for (const change of [
      { attempts: NaN },
      { attempts: 1.5 },
      { nextAttemptAt: "no" },
      { status: "complete" },
    ]) {
      expect(isDashboardData({ ...data, queue: [{ ...data.queue[0], ...change }] })).toBe(false);
    }
  });
});

describe("dashboard fetching", () => {
  it("sends the token only in a no-store request header and provides a timeout signal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(getDemoDashboard()));
    expect(await fetchDashboard("private-token", fetchImpl)).toEqual(getDemoDashboard());
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/dashboard",
      expect.objectContaining({
        headers: { Authorization: "Bearer private-token" },
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("omits authorization for demo access", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(getDemoDashboard()));
    await fetchDashboard("", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({});
  });
  it("reports rejected access separately without echoing server text", async () => {
    await expect(
      fetchDashboard(
        "secret",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("secret server details", { status: 401 })),
      ),
    ).rejects.toThrow("Access token was not accepted");
  });
  it("sanitizes unavailable server errors", async () => {
    await expect(
      fetchDashboard(
        "",
        vi.fn<typeof fetch>().mockResolvedValue(new Response("database password", { status: 503 })),
      ),
    ).rejects.toThrow("Dashboard data is temporarily unavailable");
  });
  it("sanitizes network failures and aborts", async () => {
    for (const failure of [
      new Error("sensitive url"),
      new DOMException("timeout", "TimeoutError"),
    ]) {
      await expect(
        fetchDashboard("", vi.fn<typeof fetch>().mockRejectedValue(failure)),
      ).rejects.toThrow("your last loaded data is unchanged");
    }
  });
  it("rejects invalid JSON and incomplete successful responses", async () => {
    for (const response of [new Response("not json"), Response.json({ mode: "live" })]) {
      await expect(
        fetchDashboard("", vi.fn<typeof fetch>().mockResolvedValue(response)),
      ).rejects.toThrow("invalid response");
    }
  });
});
