import { PrismaClient } from "@groundskeeper/database/client";
import { authorizeDashboard } from "./dashboard-data";
import { demoOperations, type OperationsData } from "./operations-types";

const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };
function safeCount(value: bigint): number {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Unsafe operations count");
  return Number(value);
}
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
        // DateTime columns use UTC timestamp-without-time-zone values. Bind explicit
        // UTC text to timestamp so PostgreSQL session time zones cannot shift cutoffs.
        const instant = now.toISOString().slice(0, -1);
        const staleAt = new Date(now.getTime() - 15 * 60_000).toISOString().slice(0, -1);
        const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, -1);
        const [queue] = await tx.$queryRaw<
          {
            pending: bigint;
            processing: bigint;
            retrying: bigint;
            failed: bigint;
            stalled: bigint;
            total: bigint;
            invalid: bigint;
            oldest: Date | null;
          }[]
        >`
          SELECT
            COUNT(*) FILTER (WHERE "failedAt" IS NULL AND "attemptCount" = 0
              AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${instant}::timestamp)) AS pending,
            COUNT(*) FILTER (WHERE "failedAt" IS NULL AND "leaseExpiresAt" > ${instant}::timestamp) AS processing,
            COUNT(*) FILTER (WHERE "failedAt" IS NULL AND "attemptCount" > 0
              AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${instant}::timestamp)) AS retrying,
            COUNT(*) FILTER (WHERE "failedAt" IS NOT NULL) AS failed,
            COUNT(*) FILTER (WHERE "failedAt" IS NULL
              AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${instant}::timestamp)
              AND ("leaseExpiresAt" <= ${instant}::timestamp
                OR ("receivedAt" <= ${staleAt}::timestamp
                  AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${instant}::timestamp)))) AS stalled,
            COUNT(*) AS total, COUNT(*) FILTER (WHERE "attemptCount" < 0) AS invalid,
            MIN("receivedAt") AS oldest
          FROM "WebhookDelivery"
          WHERE "installationId" = ${installationId} AND event IN ('push', 'pull_request')
            AND "processedAt" IS NULL
        `;
        const [analyses] = await tx.$queryRaw<{ completed: bigint; latest: Date | null }[]>`
          SELECT COUNT(*) FILTER (WHERE a."createdAt" >= ${dayAgo}::timestamp) AS completed,
            MAX(a."createdAt") AS latest
          FROM "AnalysisRun" a JOIN "Repository" r ON r.id = a."repositoryId"
          JOIN "Workspace" w ON w.id = r."workspaceId"
          WHERE w."installationId" = ${installationId}
        `;
        const jobs = await tx.$queryRaw<
          {
            id: string;
            event: "push" | "pull_request";
            failedAt: Date | null;
            attemptCount: number;
            receivedAt: Date;
            nextAttemptAt: Date | null;
          }[]
        >`
          SELECT id, event, "failedAt", "attemptCount", "receivedAt", "nextAttemptAt"
          FROM "WebhookDelivery"
          WHERE "installationId" = ${installationId} AND event IN ('push', 'pull_request')
            AND "processedAt" IS NULL
            AND ("failedAt" IS NOT NULL OR ("failedAt" IS NULL
              AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${instant}::timestamp)
              AND ("leaseExpiresAt" <= ${instant}::timestamp
                OR ("receivedAt" <= ${staleAt}::timestamp
                  AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${instant}::timestamp)))))
          ORDER BY "receivedAt" ASC, id ASC LIMIT 10
        `;
        if (!queue || !analyses || queue.invalid !== 0n)
          throw new Error("Incomplete or invalid operations snapshot");
        const counts = {
          pending: safeCount(queue.pending),
          processing: safeCount(queue.processing),
          retrying: safeCount(queue.retrying),
          failed: safeCount(queue.failed),
          stalled: safeCount(queue.stalled),
          total: safeCount(queue.total),
        };
        if (
          counts.pending + counts.processing + counts.retrying + counts.failed !== counts.total ||
          counts.stalled > counts.pending + counts.retrying
        )
          throw new Error("Inconsistent operations counts");
        return {
          mode: "live",
          installationId: installationId.toString(),
          generatedAt: now.toISOString(),
          workerStatus: "unknown",
          queue: { ...counts, oldestUnfinishedAt: queue.oldest?.toISOString() ?? null },
          analyses: {
            completedLast24Hours: safeCount(analyses.completed),
            latestAt: analyses.latest?.toISOString() ?? null,
          },
          jobs: jobs.map((job) => ({
            id: job.id,
            event: job.event,
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
