import {
  SharedReviewAccessError,
  SharedReviewConflictError,
  SharedReviewInputError,
  SharedReviewNotFoundError,
} from "@groundskeeper/database/shared-reviews";
import { describe, expect, it, vi } from "vitest";
import { sharedReviewResponse } from "./shared-review-api";

const env = {
  DASHBOARD_MODE: "live",
  AUTH_ORIGIN: "https://groundskeeper.example",
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
};
const state = {
  runId: "run-1",
  version: 0,
  owner: "",
  note: "",
  dismissed: false,
  updatedAt: null,
  events: [],
};
const change = { version: 0, owner: "alice", note: "Investigating", dismissed: false };
const deps = () => ({
  authorize: vi.fn().mockResolvedValue(access),
  read: vi.fn().mockResolvedValue(state),
  update: vi.fn().mockResolvedValue({ ...state, ...change, version: 1 }),
});
const request = (body: unknown = change, headers: Record<string, string> = {}) =>
  new Request(`${env.AUTH_ORIGIN}/api/review/run-1/state`, {
    method: "PUT",
    headers: { Origin: env.AUTH_ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
describe("shared review API", () => {
  it("reads only through trusted OAuth identity and prevents caching", async () => {
    const dependencies = deps();
    const result = await sharedReviewResponse(
      new Request(env.AUTH_ORIGIN),
      "run-1",
      env,
      dependencies,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(state);
    expect(dependencies.read).toHaveBeenCalledWith(access, "run-1");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("vary")).toContain("Cookie");
  });
  it("passes validated edits and the authenticated actor to persistence", async () => {
    const dependencies = deps();
    expect((await sharedReviewResponse(request(), "run-1", env, dependencies)).status).toBe(200);
    expect(dependencies.update).toHaveBeenCalledWith(access, "run-1", change);
  });
  it("fails closed for demo, bearer-only and partial OAuth configuration", async () => {
    for (const configuration of [
      {},
      { ...env, DASHBOARD_MODE: "demo" },
      { DASHBOARD_MODE: "live", DATABASE_URL: env.DATABASE_URL, DASHBOARD_ACCESS_TOKEN: "token" },
      { ...env, GITHUB_OAUTH_CLIENT_SECRET: undefined },
      { ...env, AUTH_ORIGIN: "http://localhost" },
    ]) {
      const dependencies = deps();
      const result = await sharedReviewResponse(
        request(change, { Authorization: "Bearer token" }),
        "run-1",
        configuration,
        dependencies,
      );
      expect(result.status).toBe(503);
      expect(dependencies.authorize).not.toHaveBeenCalled();
      expect(dependencies.update).not.toHaveBeenCalled();
    }
  });
  it("preserves auth rejection and never reads or writes storage", async () => {
    const dependencies = deps();
    dependencies.authorize.mockResolvedValue(Response.json({ error: "Sign in" }, { status: 401 }));
    expect((await sharedReviewResponse(request(), "run-1", env, dependencies)).status).toBe(401);
    expect(dependencies.update).not.toHaveBeenCalled();
  });
  it("rejects missing, cross-origin, null and lookalike origins", async () => {
    for (const origin of [
      "",
      "null",
      "https://evil.example",
      `${env.AUTH_ORIGIN}.evil`,
      `${env.AUTH_ORIGIN}/`,
    ]) {
      const dependencies = deps();
      expect(
        (
          await sharedReviewResponse(
            request(change, { Origin: origin }),
            "run-1",
            env,
            dependencies,
          )
        ).status,
      ).toBe(403);
      expect(dependencies.authorize).not.toHaveBeenCalled();
    }
  });
  it("rejects forged actors, extra fields, missing fields and invalid values", async () => {
    for (const value of [
      null,
      [],
      {},
      { ...change, actorGithubUserId: "99" },
      { ...change, extra: true },
      { ...change, version: -1 },
      { ...change, version: 1.5 },
      { ...change, version: Number.MAX_SAFE_INTEGER + 1 },
      { ...change, owner: "x".repeat(101) },
      { ...change, note: "x".repeat(2001) },
      { ...change, dismissed: "false" },
    ]) {
      const dependencies = deps();
      expect((await sharedReviewResponse(request(value), "run-1", env, dependencies)).status).toBe(
        400,
      );
      expect(dependencies.update).not.toHaveBeenCalled();
    }
  });
  it("accepts exact field limits and JSON charset", async () => {
    expect(
      (
        await sharedReviewResponse(
          request(
            { ...change, owner: "x".repeat(100), note: "x".repeat(2000) },
            { "Content-Type": "application/json; charset=utf-8" },
          ),
          "run-1",
          env,
          deps(),
        )
      ).status,
    ).toBe(200);
  });
  it("rejects non-JSON, malformed JSON, invalid UTF-8 and oversized declared or actual bodies", async () => {
    expect(
      (
        await sharedReviewResponse(
          request(change, { "Content-Type": "text/plain" }),
          "run-1",
          env,
          deps(),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await sharedReviewResponse(
          request(change, { "Content-Length": "16385" }),
          "run-1",
          env,
          deps(),
        )
      ).status,
    ).toBe(413);
    for (const [body, expected] of [
      ["{broken", 400],
      [new Uint8Array([0xff]), 400],
      [" ".repeat(16385), 413],
    ] as const) {
      const req = new Request(env.AUTH_ORIGIN, {
        method: "PUT",
        headers: { Origin: env.AUTH_ORIGIN, "Content-Type": "application/json" },
        body,
      });
      expect((await sharedReviewResponse(req, "run-1", env, deps())).status).toBe(expected);
    }
  });
  it("bounds streamed bytes even when content-length lies", async () => {
    const dependencies = deps();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9000));
        controller.enqueue(new Uint8Array(9000));
        controller.close();
      },
    });
    const req = new Request(env.AUTH_ORIGIN, {
      method: "PUT",
      headers: {
        Origin: env.AUTH_ORIGIN,
        "Content-Type": "application/json",
        "Content-Length": "1",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await sharedReviewResponse(req, "run-1", env, dependencies)).status).toBe(413);
    expect(dependencies.update).not.toHaveBeenCalled();
  });
  it("times out a slow body without waiting for cancellation", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const stream = new ReadableStream({ cancel });
      const req = new Request(env.AUTH_ORIGIN, {
        method: "PUT",
        headers: { Origin: env.AUTH_ORIGIN, "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit);
      const dependencies = deps();
      const result = sharedReviewResponse(req, "run-1", env, dependencies);
      await vi.advanceTimersByTimeAsync(5001);
      expect((await result).status).toBe(408);
      expect(cancel).toHaveBeenCalled();
      expect(dependencies.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not write an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const original = request();
    const req = new Request(original, { signal: controller.signal });
    const dependencies = deps();
    expect((await sharedReviewResponse(req, "run-1", env, dependencies)).status).toBe(400);
    expect(dependencies.update).not.toHaveBeenCalled();
  });
  it("maps scoped absence, revocation, conflicts, invalid changes and outages without leaking details", async () => {
    for (const [error, status] of [
      [new SharedReviewNotFoundError(), 404],
      [new SharedReviewAccessError(), 403],
      [new SharedReviewConflictError(), 409],
      [new SharedReviewInputError(), 400],
      [new Error("DATABASE_SECRET"), 503],
    ] as const) {
      const dependencies = deps();
      dependencies.update.mockRejectedValue(error);
      const result = await sharedReviewResponse(request(), "run-1", env, dependencies);
      expect(result.status).toBe(status);
      expect(await result.text()).not.toContain("DATABASE_SECRET");
      expect(dependencies.update).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects invalid run ids and unsupported methods before persistence", async () => {
    const dependencies = deps();
    expect((await sharedReviewResponse(request(), "../other", env, dependencies)).status).toBe(404);
    expect(
      (
        await sharedReviewResponse(
          new Request(env.AUTH_ORIGIN, { method: "POST" }),
          "run-1",
          env,
          dependencies,
        )
      ).status,
    ).toBe(405);
    expect(dependencies.authorize).not.toHaveBeenCalled();
  });
});
