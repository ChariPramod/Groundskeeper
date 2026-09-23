import { PrismaClient } from "@groundskeeper/database/client";

import { authConfig, teamAuthEnabled } from "./team-auth";

async function probe(databaseUrl: string, team: boolean) {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid database");
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("connect_timeout", "3");
  url.searchParams.set("pool_timeout", "3");
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    await db.$transaction(
      async (tx) => {
        if (team) {
          await tx.teamMember.findFirst({ select: { workspaceId: true } });
          await tx.teamSession.findFirst({ select: { tokenHash: true } });
        }
        await tx.workspace.findFirst({ select: { id: true } });
        await tx.analysisRun.findFirst({ select: { id: true } });
        await tx.webhookDelivery.findFirst({ select: { leaseExpiresAt: true, failedAt: true } });
      },
      { maxWait: 3000, timeout: 3000 },
    );
  } finally {
    await db.$disconnect();
  }
}

/** Public, redacted readiness; demo health never claims live-service readiness. */
export async function healthResponse(
  env: Record<string, string | undefined> = process.env,
  checkDatabase: (url: string, team: boolean) => Promise<void> = probe,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const mode = env.DASHBOARD_MODE ?? "demo";
  if (mode === "demo")
    return Response.json(
      { service: "groundskeeper-web", mode, status: "demo", liveReady: false },
      { headers },
    );
  const unavailable = () =>
    Response.json(
      { service: "groundskeeper-web", mode: "live", status: "unavailable", liveReady: false },
      { status: 503, headers },
    );
  if (mode !== "live" || !env.DATABASE_URL) return unavailable();
  try {
    const team = teamAuthEnabled(env);
    if (team) authConfig(env);
    else if (
      !env.DASHBOARD_ACCESS_TOKEN ||
      !/^[1-9]\d{0,18}$/.test(env.DASHBOARD_INSTALLATION_ID ?? "") ||
      BigInt(env.DASHBOARD_INSTALLATION_ID ?? "0") > 9223372036854775807n
    )
      return unavailable();
    await checkDatabase(env.DATABASE_URL, team);
    return Response.json(
      { service: "groundskeeper-web", mode, status: "ready", liveReady: true },
      { headers },
    );
  } catch {
    return unavailable();
  }
}
