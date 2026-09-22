import "./environment.js";
import { spawn } from "node:child_process";
import { checkReadiness } from "./readiness.js";

// Require runtime readiness before enabling tests: missing prerequisites must not look green.
const report = await checkReadiness("integration", process.env, process.cwd());
if (!report.ready) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 2;
} else {
  const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { stdio: "inherit", env });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  // Does not create/reset a database or apply migrations implicitly.
  const database = await run("pnpm", ["exec", "vitest", "run", "packages/database/src"]);
  process.exitCode =
    database ||
    (await run(
      "uv",
      [
        "run",
        "pytest",
        "services/analysis/tests/test_verification.py",
        "services/analysis/tests/test_tutorial.py",
        "-k",
        "real_docker",
      ],
      { ...process.env, GROUNDSKEEPER_DOCKER_TEST: "1" },
    )) ||
    (await run(
      "pnpm",
      ["exec", "vitest", "run", "apps/github/src/repairs/engine.integration.test.ts"],
      { ...process.env, GROUNDSKEEPER_DOCKER_TEST: "1" },
    ));
}
