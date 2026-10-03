import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapInboxRow,
  parseInboxQuery,
  readReviewInbox,
  reviewInboxResponse,
} from "./review-inbox-data";

const database = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("@groundskeeper/database/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@groundskeeper/database/client")>()),
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
  summary: { version: 1, affectedClaims: 2, totalClaims: 5 },
  verificationRuns: [
    {
      summary: {
        version: 1,
        evidenceCount: 1,
        outcomes: ["failed"],
        allPassed: false,
        hasFailed: true,
      },
    },
  ],
  sharedReview: {
    owner: "reviewer",
    note: "x".repeat(2000),
    dismissed: false,
    version: 3,
    updatedAt: new Date(createdAt),
  },
});
const projectedRecord = (id: string) => {
  const value = record(id);
  return {
    ...value,
    fullName: value.repository.fullName,
    verificationSummary: value.verificationRuns[0]?.summary,
    reviewId: id,
    ...value.sharedReview,
    note: value.sharedReview.note.slice(0, 160),
  };
};
beforeEach(() => {
  vi.clearAllMocks();
});

describe("review inbox filters and tenant boundary", () => {
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
    database.$queryRaw.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) =>
        projectedRecord(`r${String(99 - index).padStart(3, "0")}`),
      ),
    );
    const page = await readReviewInbox(42n, access.databaseUrl, parseInboxQuery(request().url));
    expect(page.rows).toHaveLength(20);
    const query = parseInboxQuery(request(`?cursor=${page.nextCursor}`).url);
    expect(query.cursor?.id).toBe(page.rows[19]?.id);
    expect(database.$queryRaw).toHaveBeenCalledOnce();
    const statement = database.$queryRaw.mock.calls[0]?.[0];
    expect(statement.values).toEqual([42n, 21]);
    expect(statement.sql).toContain("LIMIT 1");
    expect(statement.sql).not.toContain(".report");
    expect(database.disconnect).toHaveBeenCalledOnce();
  });
  it("ends pagination exactly at the last page", async () => {
    database.$queryRaw.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => projectedRecord(`r${index}`)),
    );
    expect(
      (await readReviewInbox(42n, access.databaseUrl, parseInboxQuery(request().url))).nextCursor,
    ).toBeNull();
  });
  it("disconnects the database on failure", async () => {
    database.$queryRaw.mockRejectedValue(new Error("private connection"));
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
