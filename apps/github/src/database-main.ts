import "./environment.js";
import { spawn } from "node:child_process";
import { workspaceRoot } from "./environment.js";

const command = process.argv[2];
const scripts: Record<string, string> = {
  generate: "generate",
  migrate: "migrate",
  validate: "validate",
  status: "status",
};
if (!command || !scripts[command] || process.argv.length !== 3) {
  console.error("Database command must be generate, migrate, validate, or status");
  process.exitCode = 2;
} else {
  const child = spawn("pnpm", ["--filter", "@groundskeeper/database", scripts[command]], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", () => {
    console.error("Unable to start the Prisma command");
    process.exitCode = 2;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 2;
  });
}
