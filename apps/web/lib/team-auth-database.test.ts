import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ transaction: vi.fn(), disconnect: vi.fn() }));
vi.mock("@groundskeeper/database/client", () => ({
  PrismaClient: class {
    $transaction = db.transaction;
    $disconnect = db.disconnect;
  },
}));

import { teamAccess } from "./team-auth";

const env = {
  AUTH_ORIGIN: "https://groundskeeper.example",
  AUTH_SECRET: "a".repeat(32),
  GITHUB_OAUTH_CLIENT_ID: "client",
  GITHUB_OAUTH_CLIENT_SECRET: "secret",
  DATABASE_URL: "postgresql://localhost/test",
  DASHBOARD_INSTALLATION_ID: "42",
};
beforeEach(() => {
  vi.clearAllMocks();
});
it("bounds authenticated database work and closes the client after transaction timeout", async () => {
  db.transaction.mockRejectedValue(new Error("Timed out: PRIVATE_DATABASE"));
  const result = await teamAccess(
    new Request(env.AUTH_ORIGIN, { headers: { cookie: `__Host-gk-session=${"a".repeat(43)}` } }),
    env,
  );
  expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
    maxWait: 5000,
    timeout: 5000,
  });
  expect(db.disconnect).toHaveBeenCalledOnce();
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(503);
  expect(await (result as Response).text()).not.toContain("PRIVATE_DATABASE");
});
it("runs session lookup through the transaction client", async () => {
  const findFirst = vi.fn().mockResolvedValue({ githubUserId: 7n, login: "alice" });
  db.transaction.mockImplementation((fn) => fn({ teamSession: { findFirst } }));
  const result = await teamAccess(
    new Request(env.AUTH_ORIGIN, { headers: { cookie: `__Host-gk-session=${"a".repeat(43)}` } }),
    env,
  );
  expect(result).toMatchObject({ installationId: 42n, githubUserId: 7n });
  expect(findFirst).toHaveBeenCalledOnce();
  expect(db.disconnect).toHaveBeenCalledOnce();
});
