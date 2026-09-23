import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { workspaceRoot } from "./environment.js";
import { runWorkerChild } from "./worker-child.js";
import { createWorkerHealthServer } from "./worker-health.js";
import { interruptibleWait, superviseWorker, type WorkerHealth } from "./worker-loop.js";

const { values } = parseArgs({
  options: {
    event: { type: "string", default: "all" },
    port: { type: "string", default: process.env.WORKER_HEALTH_PORT ?? "9090" },
    host: { type: "string", default: process.env.WORKER_HEALTH_HOST ?? "127.0.0.1" },
    "poll-ms": { type: "string", default: "5000" },
  },
});
if (!["all", "push", "pull_request"].includes(values.event)) throw new Error("Invalid event");
const port = Number(values.port);
const pollMs = Number(values["poll-ms"]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid health port");
if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60_000)
  throw new Error("Poll interval must be 1000–60000 milliseconds");
const controller = new AbortController();
const health: WorkerHealth = {
  phase: "starting",
  startedAt: Date.now(),
  heartbeatAt: Date.now(),
  lastSuccessAt: null,
  consecutiveFailures: 0,
  completedBatches: 0,
};
const server = createWorkerHealthServer(health);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, values.host, resolve);
});
const stop = () => {
  health.phase = "stopping";
  controller.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const heartbeat = setInterval(() => {
  health.heartbeatAt = Date.now();
}, 5000);
try {
  await superviseWorker({
    signal: controller.signal,
    health,
    pollMs,
    maxBackoffMs: 60_000,
    wait: interruptibleWait,
    run: () =>
      runWorkerChild({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          fileURLToPath(new URL("./worker-main.ts", import.meta.url)),
          "--limit",
          "1",
          "--event",
          values.event,
        ],
        cwd: workspaceRoot,
        signal: controller.signal,
        timeoutMs: 240_000,
        shutdownGraceMs: 30_000,
      }),
    onState: (state) => console.log(JSON.stringify({ event: "worker_batch", ...state })),
  });
} finally {
  clearInterval(heartbeat);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
