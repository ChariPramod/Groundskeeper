import { describe, expect, it } from "vitest";
import { buildInboxExport } from "./inbox-export";
import { demoReviewInbox } from "./review-inbox-client";
import { defaultInboxFilters } from "./review-inbox-types";

function snapshot() {
  return {
    data: demoReviewInbox(defaultInboxFilters),
    filters: { ...defaultInboxFilters },
    page: 0,
  };
}
describe("loaded inbox exports", () => {
  it("includes applied filters, snapshot provenance and pagination without exporting cursors or evidence", () => {
    const value = snapshot();
    value.data.nextCursor = "opaque_private_cursor";
    value.filters.owner = " maya ";
    value.page = 2;
    Object.assign(value.data, { secret: "never-serialize-extra-fields" });
    const file = buildInboxExport(value, "json", true);
    const exported = JSON.parse(file.content);
    expect(file.filename).toBe("groundskeeper-demo-inbox-page-3.json");
    expect(exported).toMatchObject({
      schemaVersion: 1,
      scope: "loaded-page",
      mode: "demo",
      stale: true,
      page: 3,
      hasMore: true,
      snapshotAt: value.data.generatedAt,
      filters: { ...defaultInboxFilters, owner: "maya" },
      rowCount: value.data.rows.length,
    });
    expect(exported.rows[0]).toMatchObject({
      runId: value.data.rows[0]?.id,
      reviewStatus: "open",
      verificationStatus: "needs-review",
    });
    expect(file.content).not.toMatch(/opaque_private_cursor|never-serialize|"evidence"|"detail"/);
  });
  it.each(["=1+1", "+SUM(A1)", "-1+2", "@cmd", " \t=cmd", "\ttext", "\ntext", "\u0000=cmd"])(
    "neutralizes spreadsheet formula/control prefix %j while JSON retains exact text",
    (text) => {
      const value = snapshot();
      const row = value.data.rows[0];
      if (!row) throw new Error("Missing sample");
      row.review.owner = text;
      const csv = buildInboxExport(value, "csv", false).content;
      expect(csv).toContain(`"'${text}"`);
      expect(JSON.parse(buildInboxExport(value, "json", false).content).rows[0].owner).toBe(text);
    },
  );
  it("quotes commas, embedded quotes and multiline note snippets", () => {
    const value = snapshot();
    const row = value.data.rows[0];
    if (!row) throw new Error("Missing sample");
    row.review.noteSnippet = 'Check "alpha", then\nβeta';
    const csv = buildInboxExport(value, "csv", false);
    expect(csv.content).toContain('"Check ""alpha"", then\nβeta"');
    expect(csv.content.startsWith("\uFEFF")).toBe(true);
    expect(csv.content.endsWith("\r\n")).toBe(true);
  });
  it("exports an empty page with metadata in JSON and a header-only CSV", () => {
    const value = snapshot();
    value.data.rows = [];
    expect(JSON.parse(buildInboxExport(value, "json", false).content)).toMatchObject({
      rowCount: 0,
      rows: [],
      hasMore: false,
    });
    expect(buildInboxExport(value, "csv", false).content.split("\r\n")).toHaveLength(2);
  });
  it("rejects unbounded pages, invalid metadata and oversized snippets", () => {
    const value = snapshot();
    expect(() => buildInboxExport({ ...value, page: -1 }, "json", false)).toThrow(
      "cannot be exported",
    );
    const row = value.data.rows[0];
    if (!row) throw new Error("Missing sample");
    value.data.rows = Array.from({ length: 21 }, () => row);
    expect(() => buildInboxExport(value, "csv", false)).toThrow("cannot be exported");
    value.data.rows = [row];
    row.review.noteSnippet = "x".repeat(161);
    expect(() => buildInboxExport(value, "json", false)).toThrow("cannot be exported");
  });
});
