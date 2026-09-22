import "./environment.js";
import { parseArgs } from "node:util";
import { checkReadiness, type ReadinessMode } from "./readiness.js";

try {
  const { values } = parseArgs({ options: { mode: { type: "string", default: "local" } } });
  if (!["local", "integration", "github"].includes(values.mode ?? "")) {
    throw new Error("--mode must be local, integration, or github");
  }
  const report = await checkReadiness(values.mode as ReadinessMode, process.env, process.cwd());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ready ? 0 : 2;
} catch {
  console.error("Readiness check could not complete; verify --mode and local setup");
  process.exitCode = 2;
}
