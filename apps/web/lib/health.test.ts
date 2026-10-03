import { randomUUID } from "node:crypto";
import { PrismaClient } from "@groundskeeper/database/client";
import { expect, it, vi } from "vitest";
import { healthResponse } from "./health";

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "readiness rejects a database missing the report-summary migration",
  async () => {
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    const namespace = url.searchParams.get("schema") ?? "public";
    const source = `"${namespace.replaceAll('"', '""')}"`;
    const schema = `health_${randomUUID().replaceAll("-", "")}`;
    const db = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of ["Workspace", "AnalysisRun", "VerificationRun", "WebhookDelivery"])
        await db.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE ${source}."${table}" INCLUDING ALL)`,
        );
      url.searchParams.set("schema", schema);
      const env = {
        DATABASE_URL: url.toString(),
        DASHBOARD_MODE: "live",
        DASHBOARD_INSTALLATION_ID: "1",
        DASHBOARD_ACCESS_TOKEN: "health-test",
      };
      expect((await healthResponse(env)).status).toBe(200);
      await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."VerificationRun" DROP COLUMN summary`);
      const unavailable = await healthResponse(env);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ liveReady: false, status: "unavailable" });
    } finally {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.$disconnect();
    }
  },
);

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
