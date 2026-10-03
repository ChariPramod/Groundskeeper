import { isDashboardData } from "./dashboard-client";
import type { DashboardRun } from "./dashboard-types";

export const INBOX_PAGE_SIZE = 20;
export interface ReviewInboxFilters {
  status: "open" | "dismissed" | "all";
  owner: string;
  unassigned: boolean;
  repository: string;
}
export const defaultInboxFilters: ReviewInboxFilters = {
  status: "open",
  owner: "",
  unassigned: false,
  repository: "",
};
export interface ReviewInboxRow extends DashboardRun {
  review: {
    owner: string;
    noteSnippet: string;
    dismissed: boolean;
    version: number;
    updatedAt: string | null;
  };
}
export interface ReviewInboxPage {
  mode: "demo" | "live";
  generatedAt: string;
  rows: ReviewInboxRow[];
  nextCursor: string | null;
}

export function isReviewInboxPage(value: unknown): value is ReviewInboxPage {
  if (!value || typeof value !== "object") return false;
  const data = value as ReviewInboxPage;
  return (
    Array.isArray(data.rows) &&
    data.rows.length <= INBOX_PAGE_SIZE &&
    isDashboardData({
      mode: data.mode,
      generatedAt: data.generatedAt,
      runs: data.rows,
      repositories: [],
      queue: [],
    }) &&
    (data.nextCursor === null ||
      (typeof data.nextCursor === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(data.nextCursor))) &&
    data.rows.every(
      ({ review }) =>
        review &&
        typeof review.owner === "string" &&
        review.owner.length <= 100 &&
        typeof review.noteSnippet === "string" &&
        review.noteSnippet.length <= 160 &&
        typeof review.dismissed === "boolean" &&
        Number.isSafeInteger(review.version) &&
        review.version >= 0 &&
        (review.updatedAt === null ||
          (typeof review.updatedAt === "string" &&
            Number.isFinite(Date.parse(review.updatedAt)) &&
            new Date(review.updatedAt).toISOString() === review.updatedAt)),
    )
  );
}

export function inboxSearchParams(filters: ReviewInboxFilters, cursor?: string | null) {
  const query = new URLSearchParams({ status: filters.status });
  if (filters.owner.trim()) query.set("owner", filters.owner.trim());
  if (filters.unassigned) query.set("unassigned", "true");
  if (filters.repository.trim()) query.set("repository", filters.repository.trim());
  if (cursor) query.set("cursor", cursor);
  return query;
}
