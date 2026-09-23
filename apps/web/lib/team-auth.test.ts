import { describe, expect, it, vi } from "vitest";
import {
  authConfig,
  callbackResponse,
  loginResponse,
  logoutResponse,
  teamAccess,
  teamAuthEnabled,
} from "./team-auth";

const env = {
  AUTH_ORIGIN: "https://groundskeeper.example",
  AUTH_SECRET: "a".repeat(32),
  GITHUB_OAUTH_CLIENT_ID: "client",
  GITHUB_OAUTH_CLIENT_SECRET: "secret",
  DATABASE_URL: "postgresql://localhost/test",
  DASHBOARD_INSTALLATION_ID: "42",
};
function flow() {
  const login = loginResponse(new Request(`${env.AUTH_ORIGIN}/api/auth/login`), env);
  const location = new URL(login.headers.get("location") as string);
  const cookie = (login.headers.get("set-cookie") as string).split(";")[0] ?? "";
  return {
    location,
    cookie,
    request: new Request(
      `${env.AUTH_ORIGIN}/api/auth/callback?code=one-time&state=${location.searchParams.get("state")}`,
      { headers: { cookie } },
    ),
  };
}
const fetcher = () =>
  vi
    .fn()
    .mockResolvedValueOnce(Response.json({ access_token: "github-token" }))
    .mockResolvedValueOnce(Response.json({ id: 7, login: "alice" }));
describe("team OAuth", () => {
  it("requires a canonical HTTPS origin and complete configuration", () => {
    for (const AUTH_ORIGIN of [
      "http://example.com",
      "https://example.com/",
      "https://example.com/path",
      "https://evil@example.com",
    ])
      expect(() => authConfig({ ...env, AUTH_ORIGIN })).toThrow();
    expect(teamAuthEnabled({ AUTH_SECRET: "partial" })).toBe(true);
    expect(teamAuthEnabled({})).toBe(false);
    expect(loginResponse(new Request(env.AUTH_ORIGIN), {}).status).toBe(503);
  });
  it("issues secure cookie-bound state and S256 PKCE without unnecessary scopes", () => {
    const { location, cookie } = flow();
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.has("scope")).toBe(false);
    expect(cookie).toMatch(/^__Host-gk-oauth=/);
    const response = loginResponse(new Request(env.AUTH_ORIGIN), env);
    expect(response.headers.get("set-cookie")).toContain(
      "HttpOnly; Secure; SameSite=Lax; Max-Age=600",
    );
  });
  it("exchanges an approved identity for a session, never returning GitHub credentials", async () => {
    const { request } = flow(),
      fetch = fetcher(),
      save = vi.fn().mockResolvedValue("s".repeat(43));
    const result = await callbackResponse(request, env, fetch, save);
    expect(result.status).toBe(303);
    expect(save).toHaveBeenCalledWith(env.DATABASE_URL, 42n, 7n, "alice");
    expect(result.headers.get("set-cookie")).toContain("__Host-gk-session=");
    expect(result.headers.get("set-cookie")).not.toContain("github-token");
    const body = JSON.parse(fetch.mock.calls[0]?.[1].body);
    expect(body.code_verifier).toHaveLength(43);
    expect(fetch.mock.calls[0]?.[1].redirect).toBe("error");
  });
  it("rejects unapproved users without issuing a session", async () => {
    const result = await callbackResponse(
      flow().request,
      env,
      fetcher(),
      vi.fn().mockResolvedValue(null),
    );
    expect(result.status).toBe(403);
    expect(result.headers.get("set-cookie")).not.toContain("__Host-gk-session");
  });
  it("rejects missing, mismatched, tampered and duplicate state cookies before network calls", async () => {
    const { request, cookie } = flow();
    for (const headers of [
      {} as Record<string, string>,
      { cookie: `${cookie}x` },
      { cookie: `${cookie}; ${cookie}` },
    ]) {
      const fetch = vi.fn();
      expect(
        (await callbackResponse(new Request(request.url, { headers }), env, fetch)).status,
      ).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    }
    const fetch = vi.fn();
    expect(
      (
        await callbackResponse(
          new Request(`${env.AUTH_ORIGIN}/api/auth/callback?code=x&state=wrong`, {
            headers: { cookie },
          }),
          env,
          fetch,
        )
      ).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects expired state", async () => {
    const { request } = flow();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    try {
      expect((await callbackResponse(request, env, vi.fn())).status).toBe(400);
    } finally {
      now.mockRestore();
    }
  });
  it("fails closed and redacts token exchange and storage failures", async () => {
    for (const fetch of [
      vi.fn().mockRejectedValue(new Error("SECRET")),
      vi.fn().mockResolvedValue(Response.json({ access_token: null })),
    ]) {
      const result = await callbackResponse(flow().request, env, fetch);
      expect(result.status).toBe(400);
      expect(await result.text()).not.toContain("SECRET");
    }
    const result = await callbackResponse(
      flow().request,
      env,
      fetcher(),
      vi.fn().mockRejectedValue(new Error("DATABASE_SECRET")),
    );
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain("DATABASE_SECRET");
  });
  it("requires exact same-origin POST logout", async () => {
    expect(
      (
        await logoutResponse(
          new Request(env.AUTH_ORIGIN, {
            method: "POST",
            headers: { Origin: "https://evil.example" },
          }),
          env,
        )
      ).status,
    ).toBe(403);
  });
  it("does not use a bearer token when OAuth is partly configured", async () => {
    const result = await teamAccess(
      new Request(env.AUTH_ORIGIN, { headers: { Authorization: "Bearer old-token" } }),
      { AUTH_SECRET: "partial" },
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
  });
});
