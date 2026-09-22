import { spawn } from "node:child_process";
import type { AnalysisReport, AnalysisRequest } from "@groundskeeper/contracts";

/** Invoke only our trusted analysis module; repository content travels as JSON data. */
export async function analyzeLocally(request: AnalysisRequest): Promise<AnalysisReport> {
  return runPythonJson<AnalysisReport>("groundskeeper.worker_analysis", request, 60_000);
}

export async function runPythonJson<T>(
  module: "groundskeeper.worker_analysis" | "groundskeeper.worker_verification",
  request: unknown,
  timeoutMs: number,
): Promise<T> {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 32_000_000) throw new Error("Analysis input exceeds 32 MB");
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--locked", "python", "-m", module], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const terminate = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      failure = new Error("Python worker exceeded its wall-clock limit");
      terminate();
      reject(failure);
    }, timeoutMs);
    for (const [stream, output] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32_000_000) {
          failure = new Error("Analysis output exceeds 32 MB");
          terminate();
          reject(failure);
        } else output.push(chunk);
      });
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          new Error(`Analysis failed: ${Buffer.concat(stderr).toString().slice(0, 4000)}`),
        );
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString()) as T);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}
