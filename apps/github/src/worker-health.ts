import { createServer } from "node:http";
import { type WorkerHealth, workerReady } from "./worker-loop.js";

/** Private-network status only; never attach queue payloads or credential errors. */
export function createWorkerHealthServer(health: WorkerHealth) {
  return createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    if (
      request.method !== "GET" ||
      !["/health/live", "/health/ready"].includes(request.url ?? "")
    ) {
      response.writeHead(404).end('{"error":"not_found"}');
      return;
    }
    const ready = workerReady(health);
    response.statusCode = request.url === "/health/ready" && !ready ? 503 : 200;
    response.end(JSON.stringify({ ...health, ready }));
  });
}
