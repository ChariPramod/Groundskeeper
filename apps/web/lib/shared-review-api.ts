import { PrismaClient } from "@groundskeeper/database/client";
import {
  readSharedReview,
  SharedReviewAccessError,
  SharedReviewConflictError,
  SharedReviewInputError,
  SharedReviewNotFoundError,
  SharedReviewPermissionError,
  updateSharedReview,
} from "@groundskeeper/database/shared-reviews";
import { canReview } from "@groundskeeper/database/team-access";
import { authConfig, teamAccess, teamAuthEnabled } from "./team-auth";

type Env = Record<string, string | undefined>;
type Access = Exclude<Awaited<ReturnType<typeof teamAccess>>, Response>;
type Change = { version: number; owner: string; note: string; dismissed: boolean };
const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };
const response = (error: string, status: number) => Response.json({ error }, { status, headers });
const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 5000;
class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readChange(request: Request): Promise<Change> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new BodyError(415, "Use application/json for review changes.");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
    throw new BodyError(413, "Review change exceeds the request size limit.");
  if (!request.body) throw new BodyError(400, "A review change is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BodyError(408, "Review request timed out.")),
      BODY_TIMEOUT_MS,
    );
    abort = () => reject(new BodyError(400, "Review request was interrupted."));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES)
        throw new BodyError(413, "Review change exceeds the request size limit.");
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new BodyError(400, "Review change must contain valid JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BodyError(400, "Invalid review change.");
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).length !== 4 ||
      Object.keys(data).some((key) => !["version", "owner", "note", "dismissed"].includes(key)) ||
      typeof data.version !== "number" ||
      !Number.isSafeInteger(data.version) ||
      data.version < 0 ||
      typeof data.owner !== "string" ||
      data.owner.length > 100 ||
      typeof data.note !== "string" ||
      data.note.length > 2000 ||
      typeof data.dismissed !== "boolean"
    )
      throw new BodyError(400, "Invalid review change.");
    return data as Change;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    // Cancellation must not let a malicious slow stream delay the timeout response.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function withDatabase<T>(access: Access, fn: (db: PrismaClient) => Promise<T>) {
  const url = new URL(access.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid database");
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("pool_timeout", "5");
  url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
const identity = (access: Access, id: string) => ({
  analysisRunId: id,
  installationId: access.installationId,
  actorGithubUserId: access.githubUserId,
});
const defaults = {
  authorize: teamAccess,
  read: (access: Access, id: string) =>
    withDatabase(access, (db) => readSharedReview(db, identity(access, id))),
  update: (access: Access, id: string, change: Change) =>
    withDatabase(access, (db) =>
      updateSharedReview(db, {
        ...identity(access, id),
        actorLogin: access.login,
        expectedVersion: change.version,
        owner: change.owner,
        note: change.note,
        dismissed: change.dismissed,
      }),
    ),
};

/** OAuth only: bearer-token dashboard access never grants access to shared team state. */
export async function sharedReviewResponse(
  request: Request,
  id: string,
  env: Env = process.env,
  dependencies: Partial<typeof defaults> = {},
): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return response("Run not found.", 404);
  if (request.method !== "GET" && request.method !== "PUT")
    return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, PUT" } });
  if (env.DASHBOARD_MODE !== "live" || !teamAuthEnabled(env))
    return response("Shared reviews require live team sign-in.", 503);
  try {
    const config = authConfig(env);
    if (request.method === "PUT" && request.headers.get("origin") !== config.origin)
      return response("Invalid request origin.", 403);
    const deps = { ...defaults, ...dependencies };
    const access = await deps.authorize(request, env);
    if (access instanceof Response) return access;
    if (request.method === "PUT" && !canReview(access.role))
      return response(
        "Your role can view reviews. A reviewer or admin role is required to save changes.",
        403,
      );
    const result =
      request.method === "GET"
        ? await deps.read(access, id)
        : await deps.update(access, id, await readChange(request));
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof BodyError) return response(error.message, error.status);
    if (error instanceof SharedReviewNotFoundError) return response("Run not found.", 404);
    if (error instanceof SharedReviewAccessError)
      return response("Team membership is no longer active.", 403);
    if (error instanceof SharedReviewPermissionError)
      return response(
        "Your role can view reviews. A reviewer or admin role is required to save changes.",
        403,
      );
    if (error instanceof SharedReviewConflictError)
      return response("This review changed. Reload before saving your edits.", 409);
    if (error instanceof SharedReviewInputError) return response("Invalid review change.", 400);
    return response(
      "Shared reviews are temporarily unavailable. Retry without discarding your edits.",
      503,
    );
  }
}
