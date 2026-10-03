import { parseArgs } from "node:util";
import type { PrismaClient } from "@prisma/client";
export interface MaintenanceOptions {
  installationId: bigint;
  limit: number;
  apply: boolean;
}
export class MaintenanceInputError extends Error {}
export function parseMaintenanceArgs(args: string[]): MaintenanceOptions {
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        "installation-id": { type: "string" },
        limit: { type: "string", default: "100" },
        apply: { type: "boolean", default: false },
      },
    });
    if (
      !/^[1-9]\d{0,18}$/.test(values["installation-id"] ?? "") ||
      !/^[1-9]\d{0,3}$/.test(values.limit ?? "")
    )
      throw new Error();
    const result = {
      installationId: BigInt(values["installation-id"] as string),
      limit: Number(values.limit),
      apply: values.apply ?? false,
    };
    validate(result);
    return result;
  } catch {
    throw new MaintenanceInputError(
      "Use --installation-id POSITIVE_ID [--limit 1..1000] [--apply]. Dry-run is the default.",
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
    typeof options.apply !== "boolean"
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
interface Counts {
  sessions: string;
  expiredSessions: string;
  analysisRuns: string;
  verificationRuns: string;
  reviewEvents: string;
  webhookDeliveries: string;
}
/** Only expired sessions can be deleted. Durable evidence and webhook deduplication are retained. */
export async function maintainStorage(db: PrismaClient, options: MaintenanceOptions) {
  validate(options);
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
      const [counts] = await tx.$queryRaw<Counts[]>`
      SELECT
        (SELECT COUNT(*)::text FROM "TeamSession" s WHERE s."workspaceId" = ${workspace.id}) AS sessions,
        (SELECT COUNT(*)::text FROM "TeamSession" s WHERE s."workspaceId" = ${workspace.id} AND s."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AS "expiredSessions",
        (SELECT COUNT(*)::text FROM "AnalysisRun" a JOIN "Repository" r ON r.id = a."repositoryId" WHERE r."workspaceId" = ${workspace.id}) AS "analysisRuns",
        (SELECT COUNT(*)::text FROM "VerificationRun" v JOIN "AnalysisRun" a ON a.id = v."analysisRunId" JOIN "Repository" r ON r.id = a."repositoryId" WHERE r."workspaceId" = ${workspace.id}) AS "verificationRuns",
        (SELECT COUNT(*)::text FROM "SharedReviewEvent" e JOIN "AnalysisRun" a ON a.id = e."analysisRunId" JOIN "Repository" r ON r.id = a."repositoryId" WHERE r."workspaceId" = ${workspace.id}) AS "reviewEvents",
        (SELECT COUNT(*)::text FROM "WebhookDelivery" d WHERE d."installationId" = ${options.installationId}) AS "webhookDeliveries"`;
      const relationBytes = await tx.$queryRaw<{ relation: string; bytes: string }[]>`
      SELECT name AS relation, pg_total_relation_size(to_regclass(quote_ident(name)))::text AS bytes
      FROM (VALUES ('TeamSession'), ('AnalysisRun'), ('VerificationRun'), ('SharedReviewEvent'), ('WebhookDelivery')) AS tables(name)
      ORDER BY name`;
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
      if (!observed || !counts) throw new Error("Incomplete maintenance diagnostics");
      return {
        schemaVersion: 1,
        mode: options.apply ? "apply" : "dry-run",
        installationId: options.installationId.toString(),
        observedAt: observed.at.toISOString(),
        limit: options.limit,
        scopedCountsBeforeCleanup: counts,
        expiredSessionBatch: batchCount,
        deletedSessions: options.apply ? batchCount : 0,
        relationBytes: {
          scope: "database-wide relations in the connected schema; not installation-specific",
          values: relationBytes,
        },
        retained: [
          "analysis runs",
          "verification evidence",
          "review audit events",
          "webhook delivery IDs and payloads",
        ],
      };
    },
    { maxWait: 5000, timeout: 15000 },
  );
}
