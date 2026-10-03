import { PrismaClient } from "@groundskeeper/database/client";
import { mapRun } from "./dashboard-data";
import {
  INBOX_PAGE_SIZE,
  type ReviewInboxFilters,
  type ReviewInboxPage,
  type ReviewInboxRow,
} from "./review-inbox-types";
import { type RunListRecord, readRunList } from "./run-list-query";
import { teamAccess, teamAuthEnabled } from "./team-auth";

type Env = Record<string, string | undefined>;
type Cursor = { createdAt: string; id: string };
export interface InboxQuery extends ReviewInboxFilters {
  cursor: Cursor | null;
}
const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };
class QueryError extends Error {}
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;

function encodeCursor(record: { createdAt: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({ createdAt: record.createdAt.toISOString(), id: record.id }),
  ).toString("base64url");
}

/** A cursor carries no authority: every page reapplies the installation boundary. */
export function parseInboxQuery(url: string): InboxQuery {
  const params = new URL(url).searchParams;
  const allowed = new Set(["status", "owner", "unassigned", "repository", "cursor"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new QueryError("Invalid review filters.");
  }
  const status = params.get("status") ?? "open";
  const owner = (params.get("owner") ?? "").trim();
  const repository = (params.get("repository") ?? "").trim();
  const unassigned = params.get("unassigned") ?? "false";
  if (
    !["open", "dismissed", "all"].includes(status) ||
    owner.length > 100 ||
    Array.from(owner).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    (repository && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) ||
    !["true", "false"].includes(unassigned) ||
    (owner && unassigned === "true")
  ) {
    throw new QueryError("Invalid review filters.");
  }
  let cursor: Cursor | null = null;
  const token = params.get("cursor");
  if (token !== null) {
    try {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new Error();
      const decoded: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
      const candidate = decoded as Cursor;
      if (
        Object.keys(candidate).length !== 2 ||
        typeof candidate.id !== "string" ||
        !idPattern.test(candidate.id) ||
        typeof candidate.createdAt !== "string" ||
        !Number.isFinite(Date.parse(candidate.createdAt)) ||
        new Date(candidate.createdAt).toISOString() !== candidate.createdAt
      )
        throw new Error();
      cursor = candidate;
    } catch {
      throw new QueryError("Invalid page cursor. Return to the first page.");
    }
  }
  return {
    status: status as InboxQuery["status"],
    owner,
    repository,
    unassigned: unassigned === "true",
    cursor,
  };
}

export function mapInboxRow(record: RunListRecord): ReviewInboxRow {
  const review = record.sharedReview;
  return {
    ...mapRun(record),
    review: {
      owner: review?.owner ?? "",
      noteSnippet: (review?.note ?? "").slice(0, 160),
      dismissed: review?.dismissed ?? false,
      version: review?.version ?? 0,
      updatedAt: review?.updatedAt.toISOString() ?? null,
    },
  };
}

export async function readReviewInbox(
  installationId: bigint,
  databaseUrl: string,
  query: InboxQuery,
): Promise<ReviewInboxPage> {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Invalid database configuration");
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("pool_timeout", "5");
  url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    const records = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
        return readRunList(tx, installationId, INBOX_PAGE_SIZE + 1, query);
      },
      { maxWait: 5000, timeout: 10000 },
    );
    const page = records.slice(0, INBOX_PAGE_SIZE);
    const last = page.at(-1);
    return {
      mode: "live",
      generatedAt: new Date().toISOString(),
      rows: page.map(mapInboxRow),
      nextCursor: records.length > INBOX_PAGE_SIZE && last ? encodeCursor(last) : null,
    };
  } finally {
    await db.$disconnect();
  }
}

export async function reviewInboxResponse(
  request: Request,
  env: Env = process.env,
  dependencies: Partial<{ authorize: typeof teamAccess; read: typeof readReviewInbox }> = {},
): Promise<Response> {
  if (env.DASHBOARD_MODE !== "live" || !teamAuthEnabled(env))
    return Response.json(
      { error: "The shared review inbox requires live team sign-in." },
      { status: 503, headers },
    );
  try {
    const access = await (dependencies.authorize ?? teamAccess)(request, env);
    if (access instanceof Response) return access;
    const query = parseInboxQuery(request.url);
    return Response.json(
      await (dependencies.read ?? readReviewInbox)(
        access.installationId,
        access.databaseUrl,
        query,
      ),
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof QueryError
            ? error.message
            : "The review inbox is temporarily unavailable. Retry to reload your reviews.",
      },
      { status: error instanceof QueryError ? 400 : 503, headers },
    );
  }
}
