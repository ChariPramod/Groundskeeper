import { expect, it, vi } from "vitest";
import { healthResponse } from "./health";

it("demo never claims database readiness or probes it", async () => {
  const check = vi.fn();
  const response = await healthResponse({}, check);
  expect(await response.json()).toMatchObject({ mode: "demo", liveReady: false });
  expect(check).not.toHaveBeenCalled();
});
it("fails closed for missing config, invalid mode, and database outages without leaking errors", async () => {
  const check = vi.fn().mockRejectedValue(new Error("postgres://password@private"));
  for (const env of [
    { DASHBOARD_MODE: "bad" },
    { DASHBOARD_MODE: "live" },
    { DASHBOARD_MODE: "live", DATABASE_URL: "secret" },
  ]) {
    const response = await healthResponse(env, check);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  }
});
it("live readiness requires a successful database probe", async () => {
  const check = vi.fn().mockResolvedValue(undefined);
  const response = await healthResponse(
    {
      DASHBOARD_MODE: "live",
      DATABASE_URL: "test",
      DASHBOARD_ACCESS_TOKEN: "test",
      DASHBOARD_INSTALLATION_ID: "1",
    },
    check,
  );
  expect(check).toHaveBeenCalledWith("test", false);
  expect(await response.json()).toMatchObject({ mode: "live", liveReady: true });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("partial team configuration cannot fall back to token readiness", async () => {
  const check = vi.fn();
  const response = await healthResponse(
    {
      DASHBOARD_MODE: "live",
      DATABASE_URL: "test",
      DASHBOARD_INSTALLATION_ID: "1",
      DASHBOARD_ACCESS_TOKEN: "test",
      AUTH_SECRET: "partial",
    },
    check,
  );
  expect(response.status).toBe(503);
  expect(check).not.toHaveBeenCalled();
});

it("a configured live service becomes unavailable when its database fails", async () => {
  const check = vi.fn().mockRejectedValue(new Error("private database details"));
  const response = await healthResponse(
    {
      DASHBOARD_MODE: "live",
      DATABASE_URL: "test",
      DASHBOARD_INSTALLATION_ID: "1",
      DASHBOARD_ACCESS_TOKEN: "test",
    },
    check,
  );
  expect(check).toHaveBeenCalledOnce();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
