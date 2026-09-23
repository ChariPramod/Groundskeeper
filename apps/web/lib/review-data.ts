import { PrismaClient } from "@groundskeeper/database/client";
import { authorizeDashboard, type RunRecord } from "./dashboard-data";
import { getDemoReview } from "./review-demo";

import type { RunReviewData } from "./review-types";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const array = (v: unknown) => (Array.isArray(v) ? v.map(object) : []);
const text = (v: unknown, limit = 500) => (typeof v === "string" ? v.slice(0, limit) : "");

/** An explicit allowlist keeps sandbox streams, source bodies and credentials off this API. */
export function mapReview(record: RunRecord): RunReviewData {
  const report = object(record.report);
  const claims = array(report.claims);
  const impacts = new Map(
    array(report.impacts)
      .slice(0, 20)
      .map((i) => [i.claim_id, i]),
  );
  const symbols = new Map(array(report.symbols).map((s) => [s.id, s]));
  const changed = new Set(
    Array.isArray(report.changed_symbol_ids) ? report.changed_symbol_ids : [],
  );
  const evidence = new Map(
    array(object(record.verificationRuns[0]?.report).evidence).map((e) => [e.claim_id, e]),
  );
  const prioritized = [
    ...claims.filter((c) => impacts.has(c.id)),
    ...claims.filter((c) => !impacts.has(c.id)),
  ].slice(0, 20);
  return {
    id: record.id,
    mode: "live",
    repository: text(record.repository.fullName),
    beforeCommit: text(record.beforeCommit, 64),
    afterCommit: text(record.afterCommit, 64),
    totalClaims: claims.length,
    truncated: claims.length > 20 || array(report.impacts).length > 20,
    findings: prioritized.map((claim, index) => {
      const impact = impacts.get(claim.id);
      const execution = evidence.get(claim.id);
      const position = object(claim.position);
      const ids = Array.isArray(impact?.symbol_ids) ? impact.symbol_ids : [];
      return {
        id: text(claim.id, 200) || `claim-${index}`,
        page: text(claim.page),
        line:
          typeof position.start_line === "number" &&
          Number.isSafeInteger(position.start_line) &&
          position.start_line > 0
            ? position.start_line
            : 1,
        text: text(claim.text, 4000),
        impact: impact ? text(impact.reason) : null,
        symbols: ids
          .filter((id) => changed.has(id))
          .slice(0, 20)
          .flatMap((id) => {
            const symbol = symbols.get(id);
            return symbol
              ? [{ name: text(symbol.qualified_name || symbol.name), path: text(symbol.path) }]
              : [];
          }),
        execution: execution
          ? {
              status: ["passed", "failed", "skipped", "error"].includes(String(execution.outcome))
                ? String(execution.outcome)
                : "error",
              reason: text(execution.reason),
            }
          : null,
      };
    }),
  };
}

export async function readLiveReview(
  id: string,
  installationId: bigint,
  databaseUrl: string,
): Promise<RunReviewData | null> {
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
        const run = await tx.analysisRun.findFirst({
          where: { id, repository: { workspace: { installationId } } },
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
        return run ? mapReview(run) : null;
      },
      { maxWait: 5000, timeout: 10000 },
    );
  } finally {
    await db.$disconnect();
  }
}

export async function reviewResponse(
  request: Request,
  id: string,
  env: Record<string, string | undefined> = process.env,
  read = readLiveReview,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store", Vary: "Authorization" };
  const response = (value: unknown, status = 200) => Response.json(value, { status, headers });
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return response({ error: "Run not found." }, 404);
  if (!env.DASHBOARD_MODE || env.DASHBOARD_MODE === "demo") {
    const demo = getDemoReview(id);
    return demo ? response(demo) : response({ error: "Run not found." }, 404);
  }
  if (env.DASHBOARD_MODE !== "live")
    return response({ error: "Review mode is not configured correctly." }, 503);
  const access = await authorizeDashboard(request, env);
  if (access instanceof Response) return access;
  try {
    const result = await read(id, access.installationId, access.databaseUrl);
    return result ? response(result) : response({ error: "Run not found." }, 404);
  } catch {
    return response(
      { error: "Review details are temporarily unavailable. Retry to load this run." },
      503,
    );
  }
}
