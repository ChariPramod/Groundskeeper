import { PrismaClient } from "@groundskeeper/database/client";
import { authorizeDashboard } from "./dashboard-data";
import { demoOperations, type OperationsData } from "./operations-types";

const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };
export async function readLiveOperations(
  installationId: bigint,
  databaseUrl: string,
): Promise<OperationsData> {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Invalid database configuration");
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("pool_timeout", "5");
  url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
        const now = new Date();
        const scope = {
          installationId,
          event: { in: ["push", "pull_request"] },
          processedAt: null,
        };
        const inactive = { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] };
        const failed = { ...scope, failedAt: { not: null } };
        const stalled = {
          ...scope,
          failedAt: null,
          AND: [
            inactive,
            {
              OR: [
                { leaseExpiresAt: { lte: now } },
                {
                  receivedAt: { lte: new Date(now.getTime() - 15 * 60_000) },
                  OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
                },
              ],
            },
          ],
        };
        const runs = { repository: { workspace: { installationId } } };
        const [
          pending,
          processing,
          retrying,
          failedCount,
          stalledCount,
          oldest,
          completed,
          latest,
          jobs,
        ] = await Promise.all([
          tx.webhookDelivery.count({
            where: { ...scope, failedAt: null, attemptCount: 0, ...inactive },
          }),
          tx.webhookDelivery.count({
            where: { ...scope, failedAt: null, leaseExpiresAt: { gt: now } },
          }),
          tx.webhookDelivery.count({
            where: { ...scope, failedAt: null, attemptCount: { gt: 0 }, ...inactive },
          }),
          tx.webhookDelivery.count({ where: failed }),
          tx.webhookDelivery.count({ where: stalled }),
          tx.webhookDelivery.findFirst({
            where: scope,
            orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
            select: { receivedAt: true },
          }),
          tx.analysisRun.count({
            where: { ...runs, createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
          }),
          tx.analysisRun.findFirst({
            where: runs,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { createdAt: true },
          }),
          tx.webhookDelivery.findMany({
            where: { ...scope, OR: [failed, stalled] },
            take: 10,
            orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
            select: {
              id: true,
              event: true,
              failedAt: true,
              attemptCount: true,
              receivedAt: true,
              nextAttemptAt: true,
            },
          }),
        ]);
        return {
          mode: "live",
          installationId: installationId.toString(),
          generatedAt: now.toISOString(),
          workerStatus: "unknown",
          queue: {
            pending,
            processing,
            retrying,
            failed: failedCount,
            stalled: stalledCount,
            total: pending + processing + retrying + failedCount,
            oldestUnfinishedAt: oldest?.receivedAt.toISOString() ?? null,
          },
          analyses: {
            completedLast24Hours: completed,
            latestAt: latest?.createdAt.toISOString() ?? null,
          },
          jobs: jobs.map((job) => ({
            id: job.id,
            event: job.event as "push" | "pull_request",
            status: job.failedAt ? "failed" : "stalled",
            attempts: job.attemptCount,
            receivedAt: job.receivedAt.toISOString(),
            nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
          })),
        };
      },
      { maxWait: 5000, timeout: 10000, isolationLevel: "RepeatableRead" },
    );
  } finally {
    await db.$disconnect();
  }
}
export async function operationsResponse(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  read = readLiveOperations,
) {
  if (!env.DASHBOARD_MODE || env.DASHBOARD_MODE === "demo")
    return Response.json(demoOperations(), { headers });
  if (env.DASHBOARD_MODE !== "live")
    return Response.json(
      { error: "Operations mode is not configured correctly." },
      { status: 503, headers },
    );
  const access = await authorizeDashboard(request, env);
  if (access instanceof Response) return access;
  try {
    return Response.json(await read(access.installationId, access.databaseUrl), { headers });
  } catch {
    return Response.json(
      { error: "Operations data is temporarily unavailable. Retry to refresh the snapshot." },
      { status: 503, headers },
    );
  }
}
