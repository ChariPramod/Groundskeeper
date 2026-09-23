import { spawn } from "node:child_process";

/** Resolve only once the child closes: a timeout cannot overlap the next batch. */
export function runWorkerChild(options: {
  command: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  shutdownGraceMs: number;
}): Promise<boolean> {
  if (options.signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "inherit", "inherit"],
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const stop = () => {
      // Stop claiming now; the existing finite one-delivery batch may drain first.
      grace ??= setTimeout(kill, options.shutdownGraceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const finish = (success: boolean) => {
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal.removeEventListener("abort", stop);
      resolve(success);
    };
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0 && !timedOut));
  });
}
