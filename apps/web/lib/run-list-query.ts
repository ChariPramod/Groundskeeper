import { Prisma } from "@groundskeeper/database/client";
import type { SummaryRunRecord } from "./dashboard-data";
import type { InboxQuery } from "./review-inbox-data";

export interface RunListRecord extends SummaryRunRecord {
  sharedReview: {
    owner: string;
    note: string;
    dismissed: boolean;
    version: number;
    updatedAt: Date;
  } | null;
}

type ProjectedRow = {
  id: string;
  fullName: string;
  beforeCommit: string;
  afterCommit: string;
  createdAt: Date;
  summary: unknown;
  verificationSummary: unknown;
  reviewId: string | null;
  owner: string;
  note: string;
  dismissed: boolean;
  version: number;
  updatedAt: Date;
};

/** Keep both the page and each latest-verification lookup bounded inside PostgreSQL. */
export async function readRunList(
  tx: Prisma.TransactionClient,
  installationId: bigint,
  take: number,
  filters?: InboxQuery,
): Promise<RunListRecord[]> {
  if (!Number.isInteger(take) || take < 1 || take > 50) throw new Error("Invalid run page size");
  const predicates = [Prisma.sql`w."installationId" = ${installationId}`];
  if (filters?.status === "open")
    predicates.push(Prisma.sql`(s."analysisRunId" IS NULL OR s.dismissed = false)`);
  if (filters?.status === "dismissed") predicates.push(Prisma.sql`s.dismissed = true`);
  if (filters?.owner) predicates.push(Prisma.sql`lower(s.owner) = lower(${filters.owner})`);
  if (filters?.unassigned) predicates.push(Prisma.sql`(s."analysisRunId" IS NULL OR s.owner = '')`);
  if (filters?.repository)
    predicates.push(Prisma.sql`lower(r."fullName") = lower(${filters.repository})`);
  if (filters?.cursor) {
    // Columns are UTC timestamps without a time zone. Text + explicit timestamp cast
    // preserves the cursor instant even when a connection has a non-UTC session zone.
    const instant = filters.cursor.createdAt.slice(0, -1);
    predicates.push(
      Prisma.sql`(a."createdAt", a.id) < (${instant}::timestamp, ${filters.cursor.id})`,
    );
  }
  const reviewJoin = filters
    ? Prisma.sql`LEFT JOIN "SharedReview" s ON s."analysisRunId" = a.id`
    : Prisma.empty;
  const reviewFields = filters
    ? Prisma.sql`s."analysisRunId" AS "reviewId", s.owner, left(s.note, 160) AS note,
        s.dismissed, s.version, s."updatedAt"`
    : Prisma.sql`NULL::text AS "reviewId"`;
  const rows = await tx.$queryRaw<ProjectedRow[]>(Prisma.sql`
    WITH page AS MATERIALIZED (
      SELECT a.id, a."beforeCommit", a."afterCommit", a."createdAt", a.summary,
        r."fullName", ${reviewFields}
      FROM "AnalysisRun" a
      JOIN "Repository" r ON r.id = a."repositoryId"
      JOIN "Workspace" w ON w.id = r."workspaceId"
      ${reviewJoin}
      WHERE ${Prisma.join(predicates, " AND ")}
      ORDER BY a."createdAt" DESC, a.id DESC
      LIMIT ${take}
    )
    SELECT page.*, latest.summary AS "verificationSummary"
    FROM page
    LEFT JOIN LATERAL (
      SELECT v.summary FROM "VerificationRun" v
      WHERE v."analysisRunId" = page.id
      ORDER BY v."createdAt" DESC, v.id DESC
      LIMIT 1
    ) latest ON true
    ORDER BY page."createdAt" DESC, page.id DESC
  `);
  return rows.map((row) => ({
    id: row.id,
    repository: { fullName: row.fullName },
    beforeCommit: row.beforeCommit,
    afterCommit: row.afterCommit,
    createdAt: row.createdAt,
    summary: row.summary,
    verificationRuns:
      row.verificationSummary === null ? [] : [{ summary: row.verificationSummary }],
    sharedReview:
      row.reviewId === null
        ? null
        : {
            owner: row.owner,
            note: row.note,
            dismissed: row.dismissed,
            version: row.version,
            updatedAt: row.updatedAt,
          },
  }));
}
