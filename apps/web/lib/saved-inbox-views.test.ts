import { describe, expect, it } from "vitest";
import { defaultInboxFilters } from "./review-inbox-types";
import { decodeSavedViews, encodeSavedViews, savedViewsKey } from "./saved-inbox-views";

describe("saved inbox view storage boundary", () => {
  it("round trips only bounded names and filters, removing unexpected content", () => {
    const raw = JSON.stringify({
      version: 1,
      token: "secret",
      views: [
        {
          name: " SDK ",
          note: "private",
          filters: { ...defaultInboxFilters, repository: "acme/sdk", report: "private" },
        },
      ],
    });
    const views = decodeSavedViews(raw);
    expect(views).toEqual([
      { name: "SDK", filters: { ...defaultInboxFilters, repository: "acme/sdk" } },
    ]);
    expect(decodeSavedViews(encodeSavedViews(views))).toEqual(views);
    expect(savedViewsKey("demo")).not.toBe(savedViewsKey("live:123"));
  });
  it("rejects corrupt, future, oversized and conflicting presets", () => {
    const view = { name: "SDK", filters: defaultInboxFilters };
    for (const raw of [
      "{",
      JSON.stringify({ version: 2, views: [] }),
      " ".repeat(16001),
      JSON.stringify({ version: 1, views: [view, { ...view, name: "sdk" }] }),
      JSON.stringify({
        version: 1,
        views: Array.from({ length: 9 }, (_, i) => ({ ...view, name: `View ${i}` })),
      }),
      JSON.stringify({
        version: 1,
        views: [{ ...view, filters: { ...defaultInboxFilters, owner: "maya", unassigned: true } }],
      }),
      JSON.stringify({
        version: 1,
        views: [{ ...view, filters: { ...defaultInboxFilters, repository: "../private/repo" } }],
      }),
    ])
      expect(() => decodeSavedViews(raw)).toThrow();
    expect(decodeSavedViews(null)).toEqual([]);
  });
});
