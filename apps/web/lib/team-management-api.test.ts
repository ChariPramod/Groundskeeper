import {
  TeamConflictError,
  TeamLastAdminError,
  TeamPermissionError,
} from "@groundskeeper/database/team-management";
import { describe, expect, it, vi } from "vitest";
import { teamManagementResponse } from "./team-management-api";
import { isTeamChangeResult, isTeamDirectory } from "./team-management-types";

const env = {
  DASHBOARD_MODE: "live",
  AUTH_ORIGIN: "https://team.example",
  AUTH_SECRET: "a".repeat(32),
  GITHUB_OAUTH_CLIENT_ID: "client",
  GITHUB_OAUTH_CLIENT_SECRET: "secret",
  DATABASE_URL: "postgresql://localhost/test",
  DASHBOARD_INSTALLATION_ID: "42",
};
const access = {
  installationId: 42n,
  databaseUrl: env.DATABASE_URL,
  githubUserId: 7n,
  login: "alice",
  role: "admin",
};
const directory = { version: 0, members: [], nextCursor: null, events: [] };
const change = { version: 0, githubUserId: "8", role: "viewer" };
const dependencies = () => ({
  authorize: vi.fn().mockResolvedValue(access),
  read: vi.fn().mockResolvedValue(directory),
  update: vi.fn().mockResolvedValue({ version: 1, changed: true }),
});
const get = (query = "") => new Request(`${env.AUTH_ORIGIN}/api/team${query}`);
const put = (value: unknown = change, headers: Record<string, string> = {}) =>
  new Request(`${env.AUTH_ORIGIN}/api/team`, {
    method: "PUT",
    headers: { Origin: env.AUTH_ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
describe("team management HTTP boundary", () => {
  it("reads only for the trusted admin identity and keeps roster responses uncached", async () => {
    const deps = dependencies();
    const response = await teamManagementResponse(get("?cursor=8"), env, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(await response.json()).toEqual(directory);
    expect(deps.read).toHaveBeenCalledWith(access, 8n);
  });
  it("passes exact validated grant/revoke data and the authenticated actor to the engine", async () => {
    for (const role of ["viewer", "reviewer", "admin", null]) {
      const deps = dependencies();
      expect((await teamManagementResponse(put({ ...change, role }), env, deps)).status).toBe(200);
      expect(deps.update).toHaveBeenCalledWith(access, { ...change, role });
    }
  });
  it("requires live complete OAuth configuration and never treats a bearer token as admin", async () => {
    for (const config of [
      {},
      { ...env, DASHBOARD_MODE: "demo" },
      { ...env, GITHUB_OAUTH_CLIENT_SECRET: "" },
      { DASHBOARD_MODE: "live", DASHBOARD_ACCESS_TOKEN: "token" },
    ]) {
      const deps = dependencies();
      expect(
        (await teamManagementResponse(put(change, { Authorization: "Bearer token" }), config, deps))
          .status,
      ).toBe(503);
      expect(deps.authorize).not.toHaveBeenCalled();
    }
    const deps = dependencies();
    deps.authorize.mockResolvedValue(Response.json({ error: "Sign in" }, { status: 401 }));
    expect((await teamManagementResponse(get(), env, deps)).status).toBe(401);
    expect(deps.read).not.toHaveBeenCalled();
  });
  it("denies viewers and reviewers before reading state or processing a mutation", async () => {
    for (const role of ["viewer", "reviewer", "owner", undefined]) {
      const deps = dependencies();
      deps.authorize.mockResolvedValue({ ...access, role });
      expect((await teamManagementResponse(get(), env, deps)).status).toBe(403);
      expect((await teamManagementResponse(put(), env, deps)).status).toBe(403);
      expect(deps.read).not.toHaveBeenCalled();
      expect(deps.update).not.toHaveBeenCalled();
    }
  });
  it("requires exact origin and rejects forged actors, tenant fields, invalid IDs and unsafe versions", async () => {
    for (const origin of ["", "null", "https://evil.example", `${env.AUTH_ORIGIN}/`]) {
      const deps = dependencies();
      expect(
        (await teamManagementResponse(put(change, { Origin: origin }), env, deps)).status,
      ).toBe(403);
      expect(deps.authorize).not.toHaveBeenCalled();
    }
    for (const value of [
      null,
      [],
      {},
      { ...change, actor: "operator" },
      { ...change, installationId: "9" },
      { ...change, version: -1 },
      { ...change, version: 1.2 },
      { ...change, version: 2147483648 },
      ...["0", "-1", "01", "1.5", "9223372036854775808", 8].map((githubUserId) => ({
        ...change,
        githubUserId,
      })),
      { ...change, role: "owner" },
    ]) {
      const deps = dependencies();
      expect((await teamManagementResponse(put(value), env, deps)).status).toBe(400);
      expect(deps.update).not.toHaveBeenCalled();
    }
  });
  it("rejects malformed cursors, duplicate filters and method abuse", async () => {
    for (const query of [
      "?cursor=0",
      "?cursor=1&cursor=2",
      "?installationId=9",
      "?cursor=9223372036854775808",
    ]) {
      const deps = dependencies();
      expect((await teamManagementResponse(get(query), env, deps)).status).toBe(400);
      expect(deps.read).not.toHaveBeenCalled();
    }
    expect(
      (
        await teamManagementResponse(
          new Request(env.AUTH_ORIGIN, { method: "POST" }),
          env,
          dependencies(),
        )
      ).status,
    ).toBe(405);
  });
  it("bounds streamed body bytes and rejects invalid encodings", async () => {
    for (const [body, type, expected] of [
      ["{}", "text/plain", 415],
      ["{broken", "application/json", 400],
      [new Uint8Array([0xff]), "application/json", 400],
      [" ".repeat(4097), "application/json", 413],
    ] as const) {
      const deps = dependencies();
      const request = new Request(env.AUTH_ORIGIN, {
        method: "PUT",
        headers: { Origin: env.AUTH_ORIGIN, "Content-Type": type, "Content-Length": "1" },
        body,
      });
      expect((await teamManagementResponse(request, env, deps)).status).toBe(expected);
      expect(deps.update).not.toHaveBeenCalled();
    }
  });
  it("times out incomplete bodies even if cancellation never completes", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      const request = new Request(env.AUTH_ORIGIN, {
        method: "PUT",
        headers: { Origin: env.AUTH_ORIGIN, "Content-Type": "application/json" },
        body: new ReadableStream({ cancel: () => new Promise<void>(() => {}) }),
        duplex: "half",
      } as RequestInit);
      const result = teamManagementResponse(request, env, deps);
      await vi.advanceTimersByTimeAsync(5001);
      expect((await result).status).toBe(408);
      expect(deps.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("handles revoked admins, concurrent edits, last-admin protection and outages explicitly", async () => {
    for (const [error, code] of [
      [new TeamPermissionError(), 403],
      [new TeamConflictError("Refresh"), 409],
      [new TeamLastAdminError("Keep an admin"), 409],
      [new Error("PRIVATE_DATABASE"), 503],
    ] as const) {
      const deps = dependencies();
      deps.update.mockRejectedValue(error);
      const response = await teamManagementResponse(put(), env, deps);
      expect(response.status).toBe(code);
      expect(await response.text()).not.toContain("PRIVATE_DATABASE");
    }
  });
  it("validates directory and mutation response contracts without accepting unsafe identities", () => {
    expect(isTeamDirectory(directory)).toBe(true);
    expect(
      isTeamDirectory({
        ...directory,
        members: [
          {
            githubUserId: "8",
            role: "viewer",
            createdAt: new Date(0).toISOString(),
            lastKnownLogin: null,
          },
        ],
      }),
    ).toBe(true);
    expect(isTeamDirectory({ ...directory, version: 2147483648 })).toBe(false);
    expect(isTeamDirectory({ ...directory, nextCursor: "9223372036854775808" })).toBe(false);
    expect(isTeamChangeResult({ version: 1, changed: false })).toBe(true);
    expect(isTeamChangeResult({ version: -1, changed: true })).toBe(false);
  });
});
