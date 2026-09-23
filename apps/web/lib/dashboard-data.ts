import { timingSafeEqual } from "node:crypto";
import { PrismaClient } from "@groundskeeper/database/client";
import type { DashboardData, DashboardRun, EvidenceStatus } from "./dashboard-types";
import { getDemoDashboard } from "./demo-data";
import { teamAccess, teamAuthEnabled } from "./team-auth";

type Environment = Record<string, string | undefined>;
type Reader = (installationId: bigint, databaseUrl: string) => Promise<DashboardData>;
const headers = { "Cache-Control": "no-store", Vary: "Authorization, Cookie" };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export interface RunRecord {
  id: string;
  repository: { fullName: string };
  beforeCommit: string;
  afterCommit: string;
  createdAt: Date;
  report: unknown;
  verificationRuns: { report: unknown }[];
}

/** Project counts and execution outcomes only; never expose claim text or sandbox output. */
export function mapRun(record: RunRecord): DashboardRun {
  const report = object(record.report);
  const health = object(report.health);
  const verification = object(record.verificationRuns[0]?.report);
  const rawEvidence = Array.isArray(verification.evidence) ? verification.evidence : [];
  const evidence = rawEvidence.slice(0, 100).map((raw, index) => {
    const item = object(raw);
    const status: EvidenceStatus = ["passed", "failed", "skipped", "error"].includes(
      String(item.outcome),
    )
      ? (item.outcome as EvidenceStatus)
      : "error";
    const descriptions: Record<EvidenceStatus, string> = {
      passed: "This Python example completed successfully under recorded verification checks.",
      failed: "This Python example did not pass verification. Review the stored evidence locally.",
      skipped: "This example was not executed. Review prerequisites and execution limits.",
      error: "Verification could not complete. Restore the execution environment and rerun.",
    };
    return {
      id: `${record.id}-evidence-${index}`,
      label: `Python example ${index + 1}`,
      status,
      detail: descriptions[status],
    };
  });
  const affectedClaims = count(health.affected_claims);
  // A passed subset is not proof that every selected example passed.
  const allPassed =
    rawEvidence.length > 0 && rawEvidence.every((raw) => object(raw).outcome === "passed");
  return {
    id: record.id,
    repository: {
      fullName: record.repository.fullName,
      name: record.repository.fullName.split("/").at(-1) ?? record.repository.fullName,
    },
    beforeCommit: record.beforeCommit,
    afterCommit: record.afterCommit,
    createdAt: record.createdAt.toISOString(),
    affectedClaims,
    totalClaims: count(health.total_claims),
    status:
      affectedClaims > 0 || rawEvidence.some((raw) => object(raw).outcome === "failed")
        ? "needs-review"
        : allPassed
          ? "verified"
          : "unknown",
    evidence,
  };
}

export async function readLiveDashboard(
  installationId: bigint,
  databaseUrl: string,
): Promise<DashboardData> {
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
        const repositories = await tx.repository.findMany({
          where: { workspace: { installationId } },
          take: 50,
          orderBy: { fullName: "asc" },
          select: { id: true, githubId: true, fullName: true, defaultBranch: true },
        });
        const runs = await tx.analysisRun.findMany({
          where: { repository: { workspace: { installationId } } },
          take: 50,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            beforeCommit: true,
            afterCommit: true,
            createdAt: true,
            report: true,
            repository: { select: { fullName: true } },
            verificationRuns: {
              take: 1,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: { report: true },
            },
          },
        });
        const deliveries = await tx.webhookDelivery.findMany({
          where: { installationId, event: { in: ["push", "pull_request"] }, processedAt: null },
          take: 50,
          orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            repositoryId: true,
            event: true,
            attemptCount: true,
            receivedAt: true,
            nextAttemptAt: true,
            failedAt: true,
            leaseExpiresAt: true,
          },
        });
        const now = new Date();
        return {
          mode: "live",
          generatedAt: now.toISOString(),
          repositories: repositories.map(({ githubId: _githubId, ...repo }) => ({
            ...repo,
            name: repo.fullName.split("/").at(-1) ?? repo.fullName,
          })),
          runs: runs.map(mapRun),
          queue: deliveries.map((delivery) => ({
            id: delivery.id,
            repository:
              repositories.find((repo) => repo.githubId === delivery.repositoryId)?.fullName ??
              "Unindexed repository",
            event: delivery.event,
            status: delivery.failedAt
              ? "failed"
              : delivery.leaseExpiresAt && delivery.leaseExpiresAt > now
                ? "processing"
                : delivery.attemptCount > 0
                  ? "retrying"
                  : "pending",
            attempts: delivery.attemptCount,
            receivedAt: delivery.receivedAt.toISOString(),
            nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
          })),
        };
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
  } finally {
    await db.$disconnect();
  }
}

export async function dashboardResponse(
  request: Request,
  env: Environment = process.env,
  read: Reader = readLiveDashboard,
): Promise<Response> {
  if (!env.DASHBOARD_MODE || env.DASHBOARD_MODE === "demo")
    return Response.json(getDemoDashboard(), { headers });
  if (env.DASHBOARD_MODE !== "live")
    return Response.json(
      { error: "Dashboard mode is not configured correctly." },
      { status: 503, headers },
    );
  const access = await authorizeDashboard(request, env);
  if (access instanceof Response) return access;
  const { installationId, databaseUrl } = access;
  try {
    return Response.json(await read(installationId, databaseUrl), { headers });
  } catch {
    return Response.json(
      { error: "Live data is temporarily unavailable. Retry or explicitly switch to demo." },
      { status: 503, headers },
    );
  }
}

/** Shared fail-closed access boundary for dashboard and detailed review reads. */
export async function authorizeDashboard(
  request: Request,
  env: Environment,
): Promise<
  Response | { installationId: bigint; databaseUrl: string; githubUserId?: bigint; login?: string }
> {
  if (teamAuthEnabled(env)) return teamAccess(request, env);
  const token = env.DASHBOARD_ACCESS_TOKEN;
  const installation = env.DASHBOARD_INSTALLATION_ID;
  if (
    !token ||
    !installation ||
    !/^[1-9]\d{0,18}$/.test(installation) ||
    BigInt(installation) > 9223372036854775807n ||
    !env.DATABASE_URL
  ) {
    return Response.json(
      { error: "Live dashboard is not configured. Check server readiness." },
      { status: 503, headers },
    );
  }
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  if (
    Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    return Response.json(
      { error: "A valid dashboard access token is required." },
      { status: 401, headers },
    );
  }
  return { installationId: BigInt(installation), databaseUrl: env.DATABASE_URL };
}
