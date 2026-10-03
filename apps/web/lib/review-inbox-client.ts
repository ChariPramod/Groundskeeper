import { getDemoDashboard } from "./demo-data";
import {
  inboxSearchParams,
  isReviewInboxPage,
  type ReviewInboxFilters,
  type ReviewInboxPage,
  type ReviewInboxRow,
} from "./review-inbox-types";

export class ReviewInboxAccessError extends Error {
  constructor() {
    super("Team access is unavailable. Sign in again or ask your operator to restore access.");
    this.name = "ReviewInboxAccessError";
  }
}

/** Stable examples stay entirely in the browser and never substitute for a failed live read. */
export function demoReviewInbox(filters: ReviewInboxFilters): ReviewInboxPage {
  const rows: ReviewInboxRow[] = getDemoDashboard().runs.map((run, index) => ({
    ...run,
    review: {
      owner: index === 0 ? "maya" : index === 2 ? "alex" : "",
      noteSnippet:
        index === 0
          ? "Check the new client signature before updating the quickstart."
          : index === 2
            ? "Coordinate the authentication guide with the API changes."
            : "",
      dismissed: [1, 4, 6].includes(index),
      version: [0, 1, 2, 4, 6].includes(index) ? 1 : 0,
      updatedAt: [0, 1, 2, 4, 6].includes(index) ? "2026-09-21T17:00:00.000Z" : null,
    },
  }));
  return {
    mode: "demo",
    generatedAt: "2026-09-21T17:00:00.000Z",
    nextCursor: null,
    rows: rows.filter(
      (row) =>
        (filters.status === "all" || row.review.dismissed === (filters.status === "dismissed")) &&
        (!filters.owner.trim() ||
          row.review.owner.toLowerCase() === filters.owner.trim().toLowerCase()) &&
        (!filters.unassigned || !row.review.owner) &&
        (!filters.repository.trim() ||
          row.repository.fullName.toLowerCase() === filters.repository.trim().toLowerCase()),
    ),
  };
}

export async function fetchReviewInbox(
  filters: ReviewInboxFilters,
  cursor: string | null,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewInboxPage> {
  const response = await fetchImpl(`/api/reviews?${inboxSearchParams(filters, cursor)}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (response.status === 401 || response.status === 403) throw new ReviewInboxAccessError();
  if (response.status === 400)
    throw new Error("These filters could not be loaded. Clear the filters and try again.");
  if (!response.ok)
    throw new Error("The review inbox is unavailable. Your last loaded reviews are still visible.");
  const data: unknown = await response.json();
  if (!isReviewInboxPage(data) || data.mode !== "live")
    throw new Error(
      "The server returned an unexpected inbox response. Your last loaded reviews are unchanged.",
    );
  return data;
}
