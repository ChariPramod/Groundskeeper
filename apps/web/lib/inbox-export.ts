import {
  isReviewInboxPage,
  type ReviewInboxFilters,
  type ReviewInboxPage,
} from "./review-inbox-types";

export interface InboxExportSnapshot {
  data: ReviewInboxPage;
  filters: ReviewInboxFilters;
  page: number;
}
export type InboxExportFormat = "csv" | "json";

// Quote every cell and neutralize spreadsheet formulas, including leading whitespace/control
// characters. JSON remains the lossless alternative for labels that need this CSV protection.
function cell(value: string | number | boolean) {
  let text = String(value);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detect controls that can conceal a spreadsheet formula prefix.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Export only the validated loaded page. Never serialize opaque cursors or extra response fields. */
export function buildInboxExport(
  snapshot: InboxExportSnapshot,
  format: InboxExportFormat,
  stale: boolean,
) {
  const { data, filters, page } = snapshot;
  if (
    !isReviewInboxPage(data) ||
    !Number.isSafeInteger(page) ||
    page < 0 ||
    page >= Number.MAX_SAFE_INTEGER ||
    !["csv", "json"].includes(format) ||
    !["open", "dismissed", "all"].includes(filters.status) ||
    typeof filters.owner !== "string" ||
    filters.owner.length > 100 ||
    typeof filters.repository !== "string" ||
    filters.repository.length > 201 ||
    typeof filters.unassigned !== "boolean" ||
    typeof stale !== "boolean"
  )
    throw new Error("This inbox snapshot cannot be exported. Refresh the inbox and try again.");

  const appliedFilters = {
    status: filters.status,
    owner: filters.owner.trim(),
    unassigned: filters.unassigned,
    repository: filters.repository.trim(),
  };
  const rows = data.rows.map((row) => ({
    runId: row.id,
    repository: row.repository.fullName,
    beforeCommit: row.beforeCommit,
    afterCommit: row.afterCommit,
    createdAt: row.createdAt,
    verificationStatus: row.status,
    affectedClaims: row.affectedClaims,
    totalClaims: row.totalClaims,
    reviewStatus: row.review.dismissed ? "dismissed" : "open",
    owner: row.review.owner,
    noteSnippet: row.review.noteSnippet,
    reviewVersion: row.review.version,
    reviewUpdatedAt: row.review.updatedAt,
  }));
  const metadata = {
    schemaVersion: 1,
    scope: "loaded-page",
    mode: data.mode,
    snapshotAt: data.generatedAt,
    stale,
    page: page + 1,
    hasMore: data.nextCursor !== null,
    filters: appliedFilters,
    rowCount: rows.length,
    notes:
      "Notes are snippets, at most 160 characters. Review decisions do not change verification evidence.",
  };
  const headers = [
    "run_id",
    "repository",
    "before_commit",
    "after_commit",
    "created_at",
    "verification_status",
    "affected_claims",
    "total_claims",
    "review_status",
    "owner",
    "note_snippet",
    "review_version",
    "review_updated_at",
    "mode",
    "snapshot_at",
    "stale",
    "page",
    "has_more",
    "filter_status",
    "filter_owner",
    "filter_unassigned",
    "filter_repository",
  ];
  const records = rows.map((row) => [
    row.runId,
    row.repository,
    row.beforeCommit,
    row.afterCommit,
    row.createdAt,
    row.verificationStatus,
    row.affectedClaims,
    row.totalClaims,
    row.reviewStatus,
    row.owner,
    row.noteSnippet,
    row.reviewVersion,
    row.reviewUpdatedAt ?? "",
    data.mode,
    data.generatedAt,
    stale,
    page + 1,
    metadata.hasMore,
    appliedFilters.status,
    appliedFilters.owner,
    appliedFilters.unassigned,
    appliedFilters.repository,
  ]);
  return {
    filename: `groundskeeper-${data.mode}-inbox-page-${page + 1}.${format}`,
    mimeType: format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8",
    content:
      format === "json"
        ? `${JSON.stringify({ ...metadata, rows }, null, 2)}\n`
        : `\uFEFF${[headers, ...records].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`,
  };
}
