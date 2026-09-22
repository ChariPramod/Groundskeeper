import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { loadPrivateKey } from "./credentials.js";

export type ReadinessMode = "local" | "integration" | "github";
export interface ReadinessCheck {
  name: string;
  required: boolean;
  status: "ready" | "missing" | "error";
  detail: string;
  action?: string;
}
export interface CommandResult {
  ok: boolean;
  stdout: string;
}
export interface ReadinessDependencies {
  command(program: string, args: string[]): Promise<CommandResult>;
  exists(path: string): Promise<boolean>;
  database(url: string): Promise<boolean>;
}

export const readinessDependencies: ReadinessDependencies = {
  command: (program, args) =>
    new Promise((resolve) => {
      execFile(program, args, { timeout: 10_000, maxBuffer: 65_536 }, (error, stdout) => {
        resolve({ ok: !error, stdout: error ? "" : stdout.trim() });
      });
    }),
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  database: async (value) => {
    try {
      const url = new URL(value);
      if (!["postgres:", "postgresql:"].includes(url.protocol)) return false;
      url.searchParams.set("connect_timeout", "5");
      url.searchParams.set("pool_timeout", "5");
      const { PrismaClient } = await import("@groundskeeper/database");
      const client = new PrismaClient({ datasourceUrl: url.toString() });
      try {
        await client.$queryRaw`SELECT 1`;
        return true;
      } finally {
        await client.$disconnect();
      }
    } catch {
      return false;
    }
  },
};

/** Read-only checks. Never include env values, command stderr, keys or URLs in the report. */
export async function checkReadiness(
  mode: ReadinessMode,
  env: NodeJS.ProcessEnv,
  cwd: string,
  dependencies: ReadinessDependencies = readinessDependencies,
) {
  const checks: ReadinessCheck[] = [];
  const requirements = (name: string) =>
    ["node", "pnpm", "uv"].includes(name) ||
    (mode === "integration" &&
      ["docker", "docker-daemon", "python-image", "test-database"].includes(name)) ||
    (mode === "github" && ["database", "github-app"].includes(name));
  const add = (name: string, status: ReadinessCheck["status"], detail: string, action?: string) => {
    checks.push({
      name,
      required: requirements(name),
      status,
      detail,
      ...(action ? { action } : {}),
    });
  };
  const tools = await Promise.all(
    ["node", "pnpm", "uv"].map(async (program) => ({
      program,
      result: await dependencies.command(program, ["--version"]),
    })),
  );
  for (const { program, result } of tools) {
    const version = result.stdout.match(/(?:^v|^uv\s+|^)(\d+)\.(\d+)\.(\d+)/);
    const major = Number(version?.[1]);
    const minor = Number(version?.[2]);
    const compatible =
      result.ok &&
      !!version &&
      (program === "node"
        ? (major === 22 && minor >= 17) || major === 23 || major === 24
        : program === "pnpm"
          ? major === 10
          : true);
    add(
      program,
      compatible ? "ready" : result.ok ? "error" : "missing",
      compatible
        ? `${program} ${version?.[1]}.${version?.[2]}.${version?.[3]} is available`
        : `${program} is missing or incompatible`,
      compatible ? undefined : `Install the ${program} version documented in README.md`,
    );
  }
  const git = await dependencies.exists(join(cwd, ".git"));
  add(
    "git",
    git ? "ready" : "missing",
    git ? "Git metadata is present" : "Workspace is not initialized as a Git repository",
    git ? undefined : "Initialize Git and choose a remote when ready to enable GitHub CI",
  );
  const docker = await dependencies.command("docker", ["--version"]);
  add(
    "docker",
    docker.ok ? "ready" : "missing",
    docker.ok ? "Docker CLI is installed" : "Docker CLI is not available",
    docker.ok ? undefined : "Install and start a Docker-compatible runtime",
  );
  let daemon = false;
  if (docker.ok)
    daemon = (await dependencies.command("docker", ["info", "--format", "{{.ServerVersion}}"])).ok;
  add(
    "docker-daemon",
    daemon ? "ready" : "missing",
    daemon ? "Docker daemon responds" : "Docker daemon is unavailable",
    daemon ? undefined : "Start Docker, then rerun readiness checks",
  );
  const image =
    daemon &&
    (
      await dependencies.command("docker", [
        "image",
        "inspect",
        "python:3.12-slim",
        "--format",
        "{{.Id}}",
      ])
    ).ok;
  add(
    "python-image",
    image ? "ready" : "missing",
    image ? "Default Python sandbox image is cached" : "Default Python sandbox image is not ready",
    image ? undefined : "Run docker pull python:3.12-slim after starting Docker",
  );
  for (const [name, variable] of [
    ["database", "DATABASE_URL"],
    ["test-database", "DATABASE_TEST_URL"],
  ] as const) {
    if (!env[variable]) {
      add(name, "missing", `${variable} is unset`, `Configure ${variable} and apply migrations`);
    } else if (requirements(name)) {
      const ready = await dependencies.database(env[variable]);
      add(
        name,
        ready ? "ready" : "error",
        ready
          ? "Postgres accepts a read-only connection check"
          : "Database connection or generated client is unavailable",
        ready
          ? undefined
          : "Check credentials/connectivity and run pnpm db:generate; raw errors are intentionally omitted",
      );
    } else {
      // Presence is not a successful connectivity check; explicitly mark it as unverified.
      add(
        name,
        "missing",
        `${variable} is configured; connectivity not checked in ${mode} mode`,
        `Run pnpm run doctor --mode ${name === "database" ? "github" : "integration"}`,
      );
    }
  }
  const missing = ["APP_ID", "WEBHOOK_SECRET"].filter((key) => !env[key]);
  if (!env.PRIVATE_KEY && !env.PRIVATE_KEY_PATH) missing.push("PRIVATE_KEY or PRIVATE_KEY_PATH");
  let valid = missing.length === 0;
  if (valid) {
    const appId = Number(env.APP_ID);
    valid = Number.isSafeInteger(appId) && appId > 0;
    try {
      await loadPrivateKey(env, cwd);
    } catch {
      valid = false;
    }
  }
  add(
    "github-app",
    valid ? "ready" : "missing",
    valid
      ? "GitHub App settings have valid local syntax; remote installation is not checked"
      : missing.length
        ? `Missing settings: ${missing.join(", ")}`
        : "GitHub App ID or RSA private key is invalid",
    valid ? undefined : "Create/configure your development GitHub App; see docs/PROJECT_HANDOFF.md",
  );
  return {
    mode,
    ready: checks.every((check) => !check.required || check.status === "ready"),
    checks,
  };
}
