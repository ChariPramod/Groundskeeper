import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { checkReadiness, type ReadinessDependencies } from "./readiness.js";

function dependencies(): ReadinessDependencies {
  return {
    command: vi.fn(async (program: string, args: string[]) => ({
      ok: true,
      stdout:
        program === "node"
          ? "v22.17.1"
          : program === "pnpm"
            ? "10.33.0"
            : program === "uv"
              ? "uv 0.11.22"
              : args[0] === "info"
                ? "28.0.0"
                : "docker ready",
    })),
    exists: vi.fn().mockResolvedValue(false),
    database: vi.fn().mockResolvedValue(true),
  };
}

describe("readiness", () => {
  it("allows local work without requiring external services or credentials", async () => {
    const deps = dependencies();
    deps.command = vi.fn(async (program) => ({
      ok: program !== "docker",
      stdout: program === "node" ? "v22.17.1" : program === "pnpm" ? "10.33.0" : "uv 0.11.22",
    }));
    const result = await checkReadiness("local", {}, "/workspace", deps);
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.name === "docker")?.status).toBe("missing");
    expect(deps.database).not.toHaveBeenCalled();
  });

  it("fails integration readiness when the explicit test database URL is missing", async () => {
    const result = await checkReadiness(
      "integration",
      { DATABASE_URL: "postgresql://live" },
      "/workspace",
      dependencies(),
    );
    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.name === "test-database")?.required).toBe(true);
  });

  it("requires daemon and cached image before integration tests", async () => {
    const deps = dependencies();
    deps.command = vi.fn(async (program, args) => ({
      ok: program !== "docker" || args[0] === "--version",
      stdout: program === "node" ? "v22.17.1" : program === "pnpm" ? "10.33.0" : "uv 0.11.22",
    }));
    const result = await checkReadiness(
      "integration",
      { DATABASE_TEST_URL: "postgresql://test" },
      "/workspace",
      deps,
    );
    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.name === "docker-daemon")?.status).toBe("missing");
  });

  it("never exposes URLs or secrets in reports", async () => {
    const deps = dependencies();
    deps.database = vi.fn().mockResolvedValue(false);
    const secret = "DO_NOT_PRINT_password";
    const result = await checkReadiness(
      "github",
      {
        DATABASE_URL: `postgresql://user:${secret}@example.com/db`,
        PRIVATE_KEY: secret,
        APP_ID: "42",
        WEBHOOK_SECRET: secret,
      },
      "/workspace",
      deps,
    );
    expect(result.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("example.com");
  });

  it("reports locally valid GitHub settings without claiming remote authentication", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const result = await checkReadiness(
      "github",
      {
        DATABASE_URL: "postgresql://test",
        APP_ID: "42",
        PRIVATE_KEY: privateKey,
        WEBHOOK_SECRET: "secret",
      },
      "/workspace",
      dependencies(),
    );
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.name === "github-app")?.detail).toContain(
      "remote installation is not checked",
    );
  });

  it("rejects incompatible tool versions", async () => {
    const deps = dependencies();
    deps.command = vi.fn().mockResolvedValue({ ok: true, stdout: "v18.20.0" });
    const result = await checkReadiness("local", {}, "/workspace", deps);
    expect(result.ready).toBe(false);
  });
});
