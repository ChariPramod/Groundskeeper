export interface WorkerHealth {
  phase: "starting" | "working" | "idle" | "backoff" | "stopping" | "stopped";
  startedAt: number;
  heartbeatAt: number;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  completedBatches: number;
}

export function workerReady(health: WorkerHealth, now = Date.now()): boolean {
  return (
    (health.phase === "working" || health.phase === "idle") &&
    health.lastSuccessAt !== null &&
    now - health.heartbeatAt < 30_000
  );
}

/** One batch at a time. A failed dependency must never create a hot retry loop. */
export async function superviseWorker(options: {
  signal: AbortSignal;
  health: WorkerHealth;
  run(): Promise<boolean>;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  pollMs: number;
  maxBackoffMs: number;
  random?: () => number;
  now?: () => number;
  onState?: (health: WorkerHealth) => void;
}): Promise<void> {
  const { health, signal } = options;
  const now = options.now ?? Date.now;
  while (!signal.aborted) {
    health.phase = "working";
    health.heartbeatAt = now();
    let success = false;
    try {
      success = await options.run();
    } catch {
      // Child errors contain no diagnostic text in health or structured logs.
    }
    health.heartbeatAt = now();
    if (signal.aborted) break;
    if (success) {
      health.completedBatches += 1;
      health.consecutiveFailures = 0;
      health.lastSuccessAt = now();
      health.phase = "idle";
    } else {
      health.consecutiveFailures += 1;
      health.phase = "backoff";
    }
    options.onState?.({ ...health });
    const cap = success
      ? options.pollMs
      : Math.min(
          options.maxBackoffMs,
          options.pollMs * 2 ** Math.min(health.consecutiveFailures, 20),
        );
    // Equal jitter preserves a positive minimum and bounds synchronized retries.
    const delay = success ? cap : Math.floor(cap * (0.5 + (options.random ?? Math.random)() / 2));
    await options.wait(delay, signal);
  }
  health.phase = "stopped";
  health.heartbeatAt = now();
}

export function interruptibleWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
