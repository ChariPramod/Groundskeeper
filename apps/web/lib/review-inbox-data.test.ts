import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inboxWhere,
  mapInboxRow,
  parseInboxQuery,
  readReviewInbox,
  reviewInboxResponse,
} from "./review-inbox-data";

const database = vi.hoisted(() => ({ analysisRun: { findMany: vi.fn() }, disconnect: vi.fn() }));
vi.mock("@groundskeeper/database/client", () => ({
  PrismaClient: class {
    $transaction(callback: (tx: typeof database) => Promise<unknown>) {
      return callback(database);
    }
    $disconnect() {
      return database.disconnect();
    }
  },
}));
const env = { DASHBOARD_MODE: "live", GITHUB_OAUTH_CLIENT_ID: "oauth" };
const access = {
  installationId: 42n,
  databaseUrl: "postgresql://local/db",
  githubUserId: 7n,
  login: "reviewer",
};
const request = (query = "") => new Request(`https://example.com/api/reviews${query}`);
const record = (id: string, createdAt = "2026-10-01T12:00:00.000Z") => ({
  id,
  repository: { fullName: "org/sdk" },
  beforeCommit: "aaa",
  afterCommit: "bbb",
  createdAt: new Date(createdAt),
  report: { health: { affected_claims: 2, total_claims: 5 }, claims: [{ text: "PRIVATE_SOURCE" }] },
  verificationRuns: [{ report: { evidence: [{ outcome: "failed", stdout: "PRIVATE_OUTPUT" }] } }],
  sharedReview: {
    owner: "reviewer",
    note: "x".repeat(2000),
    dismissed: false,
    version: 3,
    updatedAt: new Date(createdAt),
  },
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe("review inbox filters and tenant boundary", () => {
  it("keeps installation scope for every filter and cursor", () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-10-01T12:00:00.000Z", id: "foreign-run" }),
    ).toString("base64url");
    const query = parseInboxQuery(
      request(`?status=dismissed&owner=Alex&repository=org/sdk&cursor=${cursor}`).url,
    );
    const where = inboxWhere(42n, query);
    expect(where.repository).toEqual({
      workspace: { installationId: 42n },
      fullName: { equals: "org/sdk", mode: "insensitive" },
    });
    expect(where.AND).toEqual([
      { sharedReview: { is: { dismissed: true } } },
      { sharedReview: { is: { owner: { equals: "Alex", mode: "insensitive" } } } },
      {
        OR: [
          { createdAt: { lt: new Date("2026-10-01T12:00:00.000Z") } },
          { createdAt: new Date("2026-10-01T12:00:00.000Z"), id: { lt: "foreign-run" } },
        ],
      },
    ]);
  });
  it("includes reviews without any saved state as open and unassigned", () => {
    expect(inboxWhere(42n, parseInboxQuery(request("?unassigned=true").url)).AND).toEqual([
      { OR: [{ sharedReview: null }, { sharedReview: { is: { dismissed: false } } }] },
      { OR: [{ sharedReview: null }, { sharedReview: { is: { owner: "" } } }] },
    ]);
  });
  it.each([
    "?status=pending",
    "?status=open&status=all",
    "?limit=1000",
    "?sort=createdAt",
    "?cursor=bad",
    "?cursor=",
    "?repository=other",
    "?owner=x&unassigned=true",
    "?unassigned=yes",
    `?owner=${"x".repeat(101)}`,
    "?owner=%00private",
    `?cursor=${Buffer.from(JSON.stringify({ id: "x", createdAt: "yesterday" })).toString("base64url")}`,
    `?cursor=${Buffer.from(JSON.stringify({ id: "x", createdAt: "2026-10-01T12:00:00.000Z", extra: true })).toString("base64url")}`,
  ])("rejects malformed or unbounded query %s", (query) => {
    expect(() => parseInboxQuery(request(query).url)).toThrow();
  });
  it("does not return source, output, or complete notes", () => {
    const value = mapInboxRow(record("r1"));
    expect(value.review.noteSnippet).toHaveLength(160);
    expect(value.status).toBe("needs-review");
    expect(JSON.stringify(value)).not.toContain("PRIVATE_");
    expect(mapInboxRow({ ...record("r1"), sharedReview: null }).review).toEqual({
      owner: "",
      noteSnippet: "",
      dismissed: false,
      version: 0,
      updatedAt: null,
    });
  });
});

describe("review inbox paging and recovery", () => {
  it("fetches a bounded extra row and anchors the next page to the last returned row", async () => {
    database.analysisRun.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => record(`r${String(99 - index).padStart(3, "0")}`)),
    );
    const page = await readReviewInbox(42n, access.databaseUrl, parseInboxQuery(request().url));
    expect(page.rows).toHaveLength(20);
    const query = parseInboxQuery(request(`?cursor=${page.nextCursor}`).url);
    expect(query.cursor?.id).toBe(page.rows[19]?.id);
    expect(database.analysisRun.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 21,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(database.disconnect).toHaveBeenCalledOnce();
  });
  it("ends pagination exactly at the last page", async () => {
    database.analysisRun.findMany.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => record(`r${index}`)),
    );
    expect(
      (await readReviewInbox(42n, access.databaseUrl, parseInboxQuery(request().url))).nextCursor,
    ).toBeNull();
  });
  it("disconnects the database on failure", async () => {
    database.analysisRun.findMany.mockRejectedValue(new Error("private connection"));
    await expect(
      readReviewInbox(42n, access.databaseUrl, parseInboxQuery(request().url)),
    ).rejects.toThrow();
    expect(database.disconnect).toHaveBeenCalledOnce();
  });
});

describe("review inbox API", () => {
  it("does not grant bearer-only access to shared team metadata", async () => {
    const read = vi.fn();
    const result = await reviewInboxResponse(
      request(),
      { DASHBOARD_MODE: "live", DASHBOARD_ACCESS_TOKEN: "secret" },
      { read },
    );
    expect(result.status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
  it("preserves authentication failures and never queries data", async () => {
    const read = vi.fn();
    const result = await reviewInboxResponse(request(), env, {
      authorize: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      read,
    });
    expect(result.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });
  it("applies the authenticated installation and no-store response", async () => {
    const read = vi.fn().mockResolvedValue({ rows: [], nextCursor: null, mode: "live" });
    const result = await reviewInboxResponse(request("?status=all"), env, {
      authorize: vi.fn().mockResolvedValue(access),
      read,
    });
    expect(result.status).toBe(200);
    expect(read).toHaveBeenCalledWith(
      42n,
      access.databaseUrl,
      expect.objectContaining({ status: "all" }),
    );
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("vary")).toContain("Cookie");
  });
  it("does not convert database errors into sample data or expose internal errors", async () => {
    const result = await reviewInboxResponse(request(), env, {
      authorize: vi.fn().mockResolvedValue(access),
      read: vi.fn().mockRejectedValue(new Error("PRIVATE_DATABASE_PASSWORD")),
    });
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("PRIVATE_");
  });
  it("returns bad filters only after authorization and before reading the database", async () => {
    const read = vi.fn();
    const result = await reviewInboxResponse(request("?limit=10000"), env, {
      authorize: vi.fn().mockResolvedValue(access),
      read,
    });
    expect(result.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
});
