import { PrismaClient } from "@groundskeeper/database/client";
import {
  changeTeamMembership,
  isTeamRole,
  readTeamDirectory,
  type TeamChange,
  TeamConflictError,
  TeamInputError,
  TeamLastAdminError,
  TeamPermissionError,
} from "@groundskeeper/database/team-management";
import { authConfig, teamAccess, teamAuthEnabled } from "./team-auth";

type Env = Record<string, string | undefined>;
type Access = Exclude<Awaited<ReturnType<typeof teamAccess>>, Response>;
const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };
const response = (error: string, status: number) => Response.json({ error }, { status, headers });
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9]\d{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const MAX_BODY_BYTES = 4096;
const BODY_TIMEOUT_MS = 5000;
class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readChange(request: Request): Promise<TeamChange> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new BodyError(415, "Use application/json for team changes.");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
    throw new BodyError(413, "Team change exceeds the request size limit.");
  if (!request.body) throw new BodyError(400, "A team change is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BodyError(408, "Team request timed out.")),
      BODY_TIMEOUT_MS,
    );
    abort = () => reject(new BodyError(400, "Team request was interrupted."));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES)
        throw new BodyError(413, "Team change exceeds the request size limit.");
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
      throw new BodyError(400, "Team change must contain valid JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BodyError(400, "Invalid team change.");
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).length !== 3 ||
      Object.keys(data).some((key) => !["version", "githubUserId", "role"].includes(key)) ||
      typeof data.version !== "number" ||
      !Number.isSafeInteger(data.version) ||
      data.version < 0 ||
      data.version > 2147483647 ||
      !validId(data.githubUserId) ||
      !(data.role === null || isTeamRole(data.role))
    )
      throw new BodyError(400, "Invalid team change.");
    return data as unknown as TeamChange;
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
const actor = (access: Access) => ({
  source: "member" as const,
  githubUserId: access.githubUserId,
  login: access.login,
});
const defaults = {
  authorize: teamAccess,
  read: (access: Access, cursor?: bigint) =>
    withDatabase(access, (db) =>
      readTeamDirectory(db, {
        installationId: access.installationId,
        actor: actor(access),
        cursor,
      }),
    ),
  update: (access: Access, change: TeamChange) =>
    withDatabase(access, (db) =>
      changeTeamMembership(db, {
        installationId: access.installationId,
        actor: actor(access),
        targetGithubUserId: BigInt(change.githubUserId),
        expectedVersion: change.version,
        role: change.role,
      }),
    ),
};
export async function teamManagementResponse(
  request: Request,
  env: Env = process.env,
  dependencies: Partial<typeof defaults> = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT")
    return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, PUT" } });
  if (env.DASHBOARD_MODE !== "live" || !teamAuthEnabled(env))
    return response("Team management requires live team sign-in.", 503);
  try {
    const config = authConfig(env);
    if (request.method === "PUT" && request.headers.get("origin") !== config.origin)
      return response("Invalid request origin.", 403);
    const deps = { ...defaults, ...dependencies };
    const access = await deps.authorize(request, env);
    if (access instanceof Response) return access;
    if (access.role !== "admin")
      return response("An active admin role is required to manage the team.", 403);
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((key) => key !== "cursor") ||
      params.getAll("cursor").length > 1 ||
      (params.has("cursor") && (request.method !== "GET" || !validId(params.get("cursor"))))
    )
      return response("Invalid team page cursor.", 400);
    const cursor = params.get("cursor");
    const result =
      request.method === "GET"
        ? await deps.read(access, cursor === null ? undefined : BigInt(cursor))
        : await deps.update(access, await readChange(request));
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof BodyError) return response(error.message, error.status);
    if (error instanceof TeamInputError) return response("Invalid team change.", 400);
    if (error instanceof TeamPermissionError)
      return response("An active admin role is required to manage the team.", 403);
    if (error instanceof TeamConflictError || error instanceof TeamLastAdminError)
      return response(error.message, 409);
    return response(
      "Team management is temporarily unavailable. Refresh before retrying a change.",
      503,
    );
  }
}
