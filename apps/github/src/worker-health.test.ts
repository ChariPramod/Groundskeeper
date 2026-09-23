import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createWorkerHealthServer } from "./worker-health.js";
import type { WorkerHealth } from "./worker-loop.js";

it("serves liveness during recovery and readiness only after a successful batch", async () => {
  const health: WorkerHealth = {
    phase: "starting",
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    lastSuccessAt: null,
    consecutiveFailures: 0,
    completedBatches: 0,
  };
  const server = createWorkerHealthServer(health);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    expect((await fetch(`${origin}/health/live`)).status).toBe(200);
    const initial = await fetch(`${origin}/health/ready`);
    expect(initial.status).toBe(503);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    Object.assign(health, { phase: "idle", lastSuccessAt: Date.now() });
    const healthy = await fetch(`${origin}/health/ready`);
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ ready: true, phase: "idle" });
    health.phase = "backoff";
    expect((await fetch(`${origin}/health/ready`)).status).toBe(503);
    expect((await fetch(`${origin}/health/live`)).status).toBe(200);
    health.phase = "stopping";
    expect((await fetch(`${origin}/health/ready`)).status).toBe(503);
    expect((await fetch(`${origin}/health/ready`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${origin}/unknown`)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
