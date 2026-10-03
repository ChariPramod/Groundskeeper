import { describe, expect, it, vi } from "vitest";
import { demoReviewInbox, fetchReviewInbox, ReviewInboxAccessError } from "./review-inbox-client";
import { defaultInboxFilters, inboxSearchParams, isReviewInboxPage } from "./review-inbox-types";

describe("review inbox client", () => {
  it("filters demo assignments without claiming they are live", () => {
    const demo = demoReviewInbox(defaultInboxFilters);
    expect(demo.mode).toBe("demo");
    expect(isReviewInboxPage(demo)).toBe(true);
    expect(demo.rows.every((row) => !row.review.dismissed)).toBe(true);
    const owner = demoReviewInbox({
      ...defaultInboxFilters,
      owner: "MAYA",
      repository: "ACME/PYTHON-SDK",
    });
    expect(owner.rows.map((row) => row.id)).toEqual(["run-1042"]);
    expect(
      demoReviewInbox({ ...defaultInboxFilters, unassigned: true }).rows.every(
        (row) => !row.review.owner,
      ),
    ).toBe(true);
    expect(demoReviewInbox({ ...defaultInboxFilters, status: "dismissed" }).rows).toHaveLength(3);
  });
  it("encodes owner labels safely in requests", () => {
    const params = inboxSearchParams(
      { ...defaultInboxFilters, owner: " alex & team ", repository: "org/sdk" },
      "cursor",
    );
    expect(params.get("owner")).toBe("alex & team");
    expect(params.get("repository")).toBe("org/sdk");
    expect(params.get("cursor")).toBe("cursor");
  });
  it("rejects a demo or malformed response to a live request", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(demoReviewInbox(defaultInboxFilters)));
    await expect(
      fetchReviewInbox(defaultInboxFilters, null, new AbortController().signal, fetcher),
    ).rejects.toThrow("unexpected");
    const invalid = { ...demoReviewInbox(defaultInboxFilters), mode: "live" };
    const first = invalid.rows[0];
    if (!first) throw new Error("Missing demo row");
    first.review.noteSnippet = "x".repeat(161);
    expect(isReviewInboxPage(invalid)).toBe(false);
  });
  it("handles revoked access distinctly from a temporary outage", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(
      fetchReviewInbox(defaultInboxFilters, null, new AbortController().signal, fetcher),
    ).rejects.toBeInstanceOf(ReviewInboxAccessError);
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      fetchReviewInbox(defaultInboxFilters, null, new AbortController().signal, fetcher),
    ).rejects.toThrow("last loaded");
  });
});
