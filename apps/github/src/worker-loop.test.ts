import { describe, expect, it } from "vitest";
import { runWorkerChild } from "./worker-child.js";
import {
  interruptibleWait,
  superviseWorker,
  type WorkerHealth,
  workerReady,
} from "./worker-loop.js";

const fresh = (): WorkerHealth => ({
  phase: "starting",
  startedAt: 0,
  heartbeatAt: 0,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  completedBatches: 0,
});

describe("worker supervisor", () => {
  it("contains thrown batches, bounds exponential backoff, and resets after recovery", async () => {
    const controller = new AbortController();
    const health = fresh();
    const delays: number[] = [];
    let calls = 0;
    await superviseWorker({
      signal: controller.signal,
      health,
      pollMs: 1000,
      maxBackoffMs: 4000,
      random: () => 1,
      now: () => 20,
      run: async () => {
        calls += 1;
        if (calls < 4) throw new Error("private data");
        return true;
      },
      wait: async (delay) => {
        delays.push(delay);
        if (calls === 4) controller.abort();
      },
    });
    expect(delays).toEqual([2000, 4000, 4000, 1000]);
    expect(health).toMatchObject({
      completedBatches: 1,
      consecutiveFailures: 0,
      lastSuccessAt: 20,
      phase: "stopped",
    });
    expect(JSON.stringify(health)).not.toContain("private data");
  });

  it("never overlaps batches and drains the active batch when stopped", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    let calls = 0;
    const batch = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const loop = superviseWorker({
      signal: controller.signal,
      health: fresh(),
      pollMs: 1000,
      maxBackoffMs: 4000,
      run: async () => {
        calls += 1;
        await batch;
        return true;
      },
      wait: async () => {
        throw new Error("must not wait after shutdown");
      },
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    controller.abort();
    finish();
    await loop;
    expect(calls).toBe(1);
  });

  it("does not claim a batch when already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    await superviseWorker({
      signal: controller.signal,
      health: fresh(),
      pollMs: 1000,
      maxBackoffMs: 4000,
      run: async () => {
        throw new Error("unexpected run");
      },
      wait: interruptibleWait,
    });
  });

  it("readiness requires proven batch access, fresh heartbeat, and a healthy phase", () => {
    const health = fresh();
    expect(workerReady(health, 0)).toBe(false);
    Object.assign(health, { phase: "idle", lastSuccessAt: 0 });
    expect(workerReady(health, 10)).toBe(true);
    expect(workerReady(health, 30_000)).toBe(false);
    for (const phase of ["starting", "backoff", "stopping", "stopped"] as const) {
      health.phase = phase;
      expect(workerReady(health, 0)).toBe(false);
    }
  });

  it("interrupts a long polling wait immediately", async () => {
    const controller = new AbortController();
    const pending = interruptibleWait(60_000, controller.signal);
    controller.abort();
    await pending;
    await interruptibleWait(60_000, controller.signal);
  });
});

const child = (script: string, overrides: Partial<Parameters<typeof runWorkerChild>[0]> = {}) =>
  runWorkerChild({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    timeoutMs: 2000,
    shutdownGraceMs: 30,
    ...overrides,
  });

describe("finite worker process boundary", () => {
  it("observes clean and failed exits", async () => {
    expect(await child("process.exit(0)")).toBe(true);
    expect(await child("process.exit(1)")).toBe(false);
  });
  it("kills a hung batch before resolving", async () => {
    expect(await child("setInterval(() => {}, 1000)", { timeoutMs: 50 })).toBe(false);
  });
  it("bounds shutdown for a hung batch", async () => {
    const controller = new AbortController();
    const pending = child("setInterval(() => {}, 1000)", { signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(false);
  });
  it("allows a finite batch to drain on shutdown", async () => {
    const controller = new AbortController();
    const pending = child("process.exit(0)", { signal: controller.signal, shutdownGraceMs: 1500 });
    controller.abort();
    expect(await pending).toBe(true);
  });
  it("contains spawn failures", async () => {
    expect(await child("", { command: "/missing-worker-executable" })).toBe(false);
  });
});
