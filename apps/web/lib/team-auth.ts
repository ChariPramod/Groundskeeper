import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaClient } from "@groundskeeper/database/client";
import {
  createTeamSession,
  readTeamSession,
  revokeTeamSession,
  type TeamDatabase,
} from "@groundskeeper/database/team-access";

type Env = Record<string, string | undefined>;
export const SESSION_COOKIE = "__Host-gk-session";
const STATE_COOKIE = "__Host-gk-oauth";
const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };
export function teamAuthEnabled(env: Env) {
  return Boolean(
    env.GITHUB_OAUTH_CLIENT_ID ||
      env.GITHUB_OAUTH_CLIENT_SECRET ||
      env.AUTH_ORIGIN ||
      env.AUTH_SECRET,
  );
}
export function authConfig(env: Env) {
  const origin = new URL(env.AUTH_ORIGIN ?? "invalid");
  if (
    origin.protocol !== "https:" ||
    origin.origin !== env.AUTH_ORIGIN ||
    !env.GITHUB_OAUTH_CLIENT_ID ||
    !env.GITHUB_OAUTH_CLIENT_SECRET ||
    (env.AUTH_SECRET?.length ?? 0) < 32 ||
    !env.DATABASE_URL ||
    !/^[1-9]\d{0,18}$/.test(env.DASHBOARD_INSTALLATION_ID ?? "") ||
    BigInt(env.DASHBOARD_INSTALLATION_ID ?? "0") > 9223372036854775807n
  )
    throw new Error("Invalid authentication configuration");
  return {
    origin: origin.origin,
    id: env.GITHUB_OAUTH_CLIENT_ID,
    secret: env.GITHUB_OAUTH_CLIENT_SECRET,
    signing: env.AUTH_SECRET as string,
    installationId: BigInt(env.DASHBOARD_INSTALLATION_ID as string),
    databaseUrl: env.DATABASE_URL,
  };
}
export function cookie(request: Request, name: string) {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  return matches.length === 1 ? (matches[0]?.slice(name.length + 1) ?? "") : "";
}
const setCookie = (name: string, value: string, age: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = (value: string, secret: string) =>
  createHmac("sha256", secret).update(value).digest("base64url");
async function withDb<T>(url: string, fn: (db: TeamDatabase) => Promise<T>) {
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Invalid database");
  parsed.searchParams.set("connect_timeout", "5");
  parsed.searchParams.set("pool_timeout", "5");
  parsed.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: parsed.toString() } } });
  try {
    return await db.$transaction((tx) => fn(tx), { maxWait: 5_000, timeout: 5_000 });
  } finally {
    await db.$disconnect();
  }
}
export async function teamAccess(request: Request, env: Env) {
  try {
    const config = authConfig(env);
    const member = await withDb(config.databaseUrl, (db) =>
      readTeamSession(db, config.installationId, cookie(request, SESSION_COOKIE)),
    );
    if (!member)
      return Response.json(
        { error: "Sign in with an approved GitHub team account." },
        { status: 401, headers },
      );
    return {
      installationId: config.installationId,
      databaseUrl: config.databaseUrl,
      githubUserId: member.githubUserId,
      login: member.login,
    };
  } catch {
    return Response.json(
      { error: "Team authentication is temporarily unavailable." },
      { status: 503, headers },
    );
  }
}
export function loginResponse(_request: Request, env: Env = process.env) {
  try {
    const config = authConfig(env);
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ state, verifier, expires: Date.now() + 600_000 }),
    ).toString("base64url");
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: config.id,
      redirect_uri: `${config.origin}/api/auth/callback`,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        ...headers,
        Location: url.toString(),
        "Set-Cookie": setCookie(STATE_COOKIE, `${payload}.${sign(payload, config.signing)}`, 600),
      },
    });
  } catch {
    return Response.json({ error: "Team sign-in is not configured." }, { status: 503, headers });
  }
}
export async function callbackResponse(
  request: Request,
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
  save = (url: string, installation: bigint, id: bigint, login: string) =>
    withDb(url, (db) => createTeamSession(db, installation, id, login)),
) {
  const responseHeaders = new Headers({ ...headers, "Set-Cookie": setCookie(STATE_COOKIE, "", 0) });
  try {
    const config = authConfig(env),
      url = new URL(request.url);
    const [payload, signature, extra] = cookie(request, STATE_COOKIE).split(".");
    if (
      !payload ||
      payload.length > 1024 ||
      !signature ||
      extra ||
      !equal(sign(payload, config.signing), signature)
    )
      throw new Error("Invalid state");
    const saved = JSON.parse(Buffer.from(payload, "base64url").toString());
    const state = url.searchParams.get("state") ?? "",
      code = url.searchParams.get("code") ?? "";
    if (
      typeof saved.state !== "string" ||
      !equal(state, saved.state) ||
      typeof saved.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier) ||
      !Number.isFinite(saved.expires) ||
      saved.expires <= Date.now() ||
      saved.expires > Date.now() + 600_000 ||
      !code ||
      code.length > 512 ||
      url.searchParams.has("error")
    )
      throw new Error("Invalid callback");
    const tokenResponse = await fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.id,
        client_secret: config.secret,
        code,
        redirect_uri: `${config.origin}/api/auth/callback`,
        code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!tokenResponse.ok) throw new Error("Token exchange failed");
    const token = await tokenResponse.json();
    if (typeof token.access_token !== "string" || token.access_token.length > 512)
      throw new Error("Invalid token");
    const userResponse = await fetcher("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!userResponse.ok) throw new Error("Identity lookup failed");
    const user = await userResponse.json();
    if (
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      typeof user.login !== "string" ||
      !/^[a-zA-Z0-9-]{1,39}$/.test(user.login)
    )
      throw new Error("Invalid identity");
    const session = await save(
      config.databaseUrl,
      config.installationId,
      BigInt(user.id),
      user.login,
    );
    if (!session)
      return Response.json(
        {
          error:
            "Your GitHub account is not approved for this installation. Ask its operator to grant membership.",
        },
        { status: 403, headers: responseHeaders },
      );
    responseHeaders.append("Set-Cookie", setCookie(SESSION_COOKIE, session, 8 * 3600));
    responseHeaders.set("Location", config.origin);
    return new Response(null, { status: 303, headers: responseHeaders });
  } catch {
    return Response.json(
      { error: "Sign-in could not complete. Start sign-in again." },
      { status: 400, headers: responseHeaders },
    );
  }
}
export async function logoutResponse(request: Request, env: Env = process.env) {
  try {
    const config = authConfig(env);
    if (request.headers.get("origin") !== config.origin)
      return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    await withDb(config.databaseUrl, (db) =>
      revokeTeamSession(db, cookie(request, SESSION_COOKIE)),
    );
    return new Response(null, {
      status: 303,
      headers: {
        ...headers,
        Location: config.origin,
        "Set-Cookie": setCookie(SESSION_COOKIE, "", 0),
      },
    });
  } catch {
    return Response.json(
      { error: "Sign-out could not complete. Please retry." },
      { status: 503, headers },
    );
  }
}
