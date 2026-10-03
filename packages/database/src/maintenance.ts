import { parseArgs } from "node:util";
import type { PrismaClient } from "@prisma/client";
export interface MaintenanceOptions {
  installationId: bigint;
  limit: number;
  apply: boolean;
  diagnostics?: "exact" | "summary";
}
export class MaintenanceInputError extends Error {}
export function parseMaintenanceArgs(args: string[]): MaintenanceOptions {
  try {
    const { values, tokens } = parseArgs({
      tokens: true,
      args,
      strict: true,
      allowPositionals: false,
      options: {
        "installation-id": { type: "string" },
        limit: { type: "string", default: "100" },
        apply: { type: "boolean", default: false },
        diagnostics: { type: "string", default: "exact" },
      },
    });
    const supplied = tokens.filter((token) => token.kind === "option").map((token) => token.name);
    if (new Set(supplied).size !== supplied.length) throw new Error();
    if (
      !/^[1-9]\d{0,18}$/.test(values["installation-id"] ?? "") ||
      !/^[1-9]\d{0,3}$/.test(values.limit ?? "")
    )
      throw new Error();
    const result = {
      installationId: BigInt(values["installation-id"] as string),
      limit: Number(values.limit),
      apply: values.apply ?? false,
      diagnostics: values.diagnostics as "exact" | "summary",
    };
    validate(result);
    return result;
  } catch {
    throw new MaintenanceInputError(
      "Use --installation-id POSITIVE_ID [--limit 1..1000] [--diagnostics exact|summary] [--apply]. Dry-run is the default.",
    );
  }
}
function validate(options: MaintenanceOptions) {
  if (
    typeof options.installationId !== "bigint" ||
    options.installationId <= 0n ||
    options.installationId > 9223372036854775807n ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 1000 ||
    typeof options.apply !== "boolean" ||
    (options.diagnostics !== undefined && !["exact", "summary"].includes(options.diagnostics))
  )
    throw new MaintenanceInputError("Invalid maintenance options.");
}
export function maintenanceDatabaseUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    url.searchParams.set("connect_timeout", "5");
    url.searchParams.set("pool_timeout", "5");
    url.searchParams.set("connection_limit", "1");
    return url.toString();
  } catch {
    throw new MaintenanceInputError("A valid PostgreSQL DATABASE_URL is required.");
  }
}
interface RelationBytes {
  relation: string;
  bytes: string;
  tableBytes: string;
  indexBytes: string;
}
interface Counts {
  sessions: string;
  expiredSessions: string;
  analysisRuns: string;
  verificationRuns: string;
  reviewEvents: string;
  teamAccessEvents: string;
  webhookDeliveries: string;
}
/** Only expired sessions can be deleted. Durable evidence and webhook deduplication are retained. */
export async function maintainStorage(db: PrismaClient, suppliedOptions: MaintenanceOptions) {
  // Copy validated primitives before awaiting so a caller cannot widen a running batch.
  const options = { ...suppliedOptions };
  validate(options);
  const diagnostics = options.diagnostics ?? "exact";
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
      await tx.$executeRaw`SET LOCAL lock_timeout = '2000ms'`;
      const workspace = await tx.workspace.findUnique({
        where: { installationId: options.installationId },
        select: { id: true },
      });
      if (!workspace) throw new MaintenanceInputError("Installation workspace not found.");
      const [observed] = await tx.$queryRaw<{ at: Date }[]>`SELECT CURRENT_TIMESTAMP AS at`;
      let counts: Counts | null = null;
      let relationBytes: RelationBytes[] | null = null;
      if (diagnostics === "exact") {
        const [observedCounts] = await tx.$queryRaw<Counts[]>`
      SELECT
        session_counts.sessions, session_counts."expiredSessions",
        (SELECT COUNT(*)::text FROM "AnalysisRun" a JOIN "Repository" r ON r.id = a."repositoryId" WHERE r."workspaceId" = ${workspace.id}) AS "analysisRuns",
        (SELECT COUNT(*)::text FROM "VerificationRun" v JOIN "AnalysisRun" a ON a.id = v."analysisRunId" JOIN "Repository" r ON r.id = a."repositoryId" WHERE r."workspaceId" = ${workspace.id}) AS "verificationRuns",
        (SELECT COUNT(*)::text FROM "SharedReviewEvent" e JOIN "AnalysisRun" a ON a.id = e."analysisRunId" JOIN "Repository" r ON r.id = a."repositoryId" WHERE r."workspaceId" = ${workspace.id}) AS "reviewEvents",
        (SELECT COUNT(*)::text FROM "TeamAccessEvent" e WHERE e."workspaceId" = ${workspace.id}) AS "teamAccessEvents",
        (SELECT COUNT(*)::text FROM "WebhookDelivery" d WHERE d."installationId" = ${options.installationId}) AS "webhookDeliveries"
      FROM (
        SELECT COUNT(*)::text AS sessions,
          (COUNT(*) FILTER (WHERE s."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))::text AS "expiredSessions"
        FROM "TeamSession" s WHERE s."workspaceId" = ${workspace.id}
      ) AS session_counts`;
        if (!observedCounts) throw new Error("Incomplete maintenance diagnostics");
        counts = observedCounts;
        relationBytes = await tx.$queryRaw<RelationBytes[]>`
      WITH sizes AS MATERIALIZED (
        SELECT name AS relation,
          pg_table_size(to_regclass(quote_ident(name))) AS table_bytes,
          pg_indexes_size(to_regclass(quote_ident(name))) AS index_bytes
        FROM (VALUES ('TeamSession'), ('AnalysisRun'), ('VerificationRun'), ('SharedReviewEvent'), ('TeamAccessEvent'), ('WebhookDelivery')) AS tables(name)
      )
      SELECT relation, (table_bytes + index_bytes)::text AS bytes,
        table_bytes::text AS "tableBytes", index_bytes::text AS "indexBytes"
      FROM sizes ORDER BY relation`;
      }

      let batchCount: number;
      if (options.apply) {
        const [result] = await tx.$queryRaw<{ count: number }[]>`
        WITH candidates AS (
          SELECT s."tokenHash" FROM "TeamSession" s JOIN "Workspace" w ON w.id = s."workspaceId"
          WHERE w."installationId" = ${options.installationId} AND s."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          ORDER BY s."expiresAt", s."tokenHash" LIMIT ${options.limit} FOR UPDATE OF s SKIP LOCKED
        ), deleted AS (
          DELETE FROM "TeamSession" s USING candidates c, "Workspace" w
          WHERE s."tokenHash" = c."tokenHash" AND s."workspaceId" = w.id
            AND w."installationId" = ${options.installationId} AND s."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          RETURNING 1
        ) SELECT COUNT(*)::int AS count FROM deleted`;
        batchCount = result?.count ?? 0;
      } else {
        const [result] = await tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM (
          SELECT 1 FROM "TeamSession" s JOIN "Workspace" w ON w.id = s."workspaceId"
          WHERE w."installationId" = ${options.installationId} AND s."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          ORDER BY s."expiresAt", s."tokenHash" LIMIT ${options.limit}
        ) AS candidates`;
        batchCount = result?.count ?? 0;
      }
      // A separate statement sees this transaction's deletion. EXISTS stops after one
      // eligible row; locked sessions still count so a skipped batch is not called empty.
      const [remaining] = await tx.$queryRaw<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "TeamSession" s
          WHERE s."workspaceId" = ${workspace.id}
            AND s."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        ) AS "exists"`;
      if (!observed || !remaining) throw new Error("Incomplete maintenance diagnostics");
      return {
        schemaVersion: 2,
        diagnostics,
        mode: options.apply ? "apply" : "dry-run",
        installationId: options.installationId.toString(),
        observedAt: observed.at.toISOString(),
        limit: options.limit,
        scopedCountsBeforeCleanup: counts,
        expiredSessionBatch: batchCount,
        deletedSessions: options.apply ? batchCount : 0,
        expiredSessionsRemain: remaining.exists,
        relationBytes:
          relationBytes === null
            ? null
            : {
                scope: "database-wide relations in the connected schema; not installation-specific",
                values: relationBytes,
              },
        retained: [
          "analysis runs",
          "verification evidence",
          "review audit events",
          "team access audit events",
          "webhook delivery IDs and payloads",
        ],
      };
    },
    { maxWait: 5000, timeout: 15000 },
  );
}
