"use client";
import { Activity, AlertTriangle, Clock3, Copy, RefreshCw, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import {
  demoOperations,
  isOperationsData,
  type OperationsData,
  recoveryCommands,
} from "../lib/operations-types";
import { Button } from "./ui/button";

const timestamp = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not observed";
function Command({ value }: { value: string }) {
  const [notice, setNotice] = useState("");
  return (
    <div className="mt-2 rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 select-all break-all text-xs leading-6">{value}</code>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Copy command"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setNotice("Copied.");
            } catch {
              setNotice("Copy unavailable. Select the command text to copy it manually.");
            }
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
      {notice && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
export function OperationsCenter({
  mode,
  token,
  refreshKey = 0,
}: {
  mode: "demo" | "live";
  token: string;
  refreshKey?: number;
}) {
  const [snapshot, setSnapshot] = useState<{
    data: OperationsData;
    mode: string;
    token: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const data = snapshot?.mode === mode && snapshot.token === token ? snapshot.data : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh counters explicitly reload the snapshot.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let active = true;
    setLoading(true);
    setError("");
    async function load() {
      try {
        const result: unknown =
          mode === "demo"
            ? demoOperations()
            : await (async () => {
                const response = await fetch("/api/operations", {
                  cache: "no-store",
                  credentials: "same-origin",
                  signal: controller.signal,
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (!response.ok) {
                  if (active && (response.status === 401 || response.status === 403))
                    setSnapshot(null);
                  throw new Error(
                    response.status === 401 || response.status === 403
                      ? "Sign in again to access this workspace."
                      : "Operations data is unavailable. Retry to refresh.",
                  );
                }
                return response.json();
              })();
        if (!isOperationsData(result) || result.mode !== mode)
          throw new Error("Operations response could not be validated.");
        if (active) setSnapshot({ data: result, mode, token });
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error && cause.name !== "AbortError"
              ? cause.message
              : "Operations request timed out. Retry to refresh.",
          );
      } finally {
        clearTimeout(timer);
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode, token, refresh, refreshKey]);
  return (
    <section className="flex flex-col gap-6" aria-label="Operations center">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex gap-3">
          <span className="h-fit rounded-xl bg-emerald-100 p-3 text-emerald-800">
            <Activity className="size-5" />
          </span>
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Operations center</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Queue activity and persisted analysis for this workspace. Read-only visibility with
              operator recovery guidance.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={loading}
        >
          <RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {mode === "demo" && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          Sample operations data. These jobs and counts do not describe a running installation.
          Recovery commands below are illustrative.
        </p>
      )}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div>
            <h3 className="font-medium">Worker health: unknown</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              No worker heartbeat is recorded. A reachable dashboard or an empty queue does not
              prove background processing, GitHub access, or verification is functioning.
            </p>
          </div>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          {error}{" "}
          {data
            ? "Showing the last successful snapshot; these counts may be out of date."
            : "No operations snapshot is available."}
        </div>
      )}
      {!data && (
        <p
          role="status"
          className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground"
        >
          {loading
            ? "Loading queue observations…"
            : "Queue and analysis activity are unknown until a snapshot loads."}
        </p>
      )}
      {data && (
        <>
          <p className="text-xs text-muted-foreground">
            {mode === "demo" ? "Sample timestamp" : "Snapshot captured"}:{" "}
            {timestamp(data.generatedAt)} · Push and pull-request jobs only · All matching jobs
            counted
          </p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(["pending", "processing", "retrying", "failed"] as const).map((status) => (
              <div key={status} className="rounded-2xl border border-border bg-card p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {status}
                </p>
                <p
                  className={`mt-3 text-3xl font-semibold tabular-nums ${status === "failed" && data.queue.failed ? "text-red-700" : ""}`}
                >
                  {data.queue[status]}
                </p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-border bg-card p-5">
              <Clock3 className="mb-3 size-4 text-muted-foreground" />
              <p className="text-sm font-medium">Oldest unfinished job</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {timestamp(data.queue.oldestUnfinishedAt)}
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-sm font-medium">Analyses persisted in 24 hours</p>
              <p className="mt-3 text-3xl font-semibold tabular-nums">
                {data.analyses.completedLast24Hours}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Saved analysis runs, not verified examples.
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-sm font-medium">Latest persisted analysis</p>
              <p className="mt-3 text-sm text-muted-foreground">
                {timestamp(data.analyses.latestAt)}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                No recent run can mean inactivity or a processing issue.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <Terminal className="size-4" />
              <h3 className="font-semibold">Jobs needing investigation</h3>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {data.queue.failed} terminal failures · {data.queue.stalled} potentially stalled jobs.
              Showing up to 10, oldest first. A stall means an expired lease or an eligible inactive
              job waiting at least 15 minutes; it is a signal to investigate.
            </p>
            {data.jobs.length === 0 ? (
              <p className="mt-5 rounded-xl bg-muted/40 p-4 text-sm">
                No failed or potentially stalled jobs observed. Worker health remains unknown.
              </p>
            ) : (
              <div className="mt-5 space-y-5">
                {data.jobs.map((job) => {
                  const commands = recoveryCommands(data, job);
                  return (
                    <article key={job.id} className="rounded-xl border border-border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <code className="break-all text-xs">{job.id}</code>
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900">
                          {job.status}
                        </span>
                      </div>
                      <p className="mt-3 text-xs text-muted-foreground">
                        {job.event} · {job.attempts} attempts · Received {timestamp(job.receivedAt)}{" "}
                        · Next attempt {timestamp(job.nextAttemptAt)}
                      </p>
                      <p className="mt-4 text-sm font-medium">
                        1. Inspect the queue from your configured operator environment
                      </p>
                      <Command value={commands.inspect} />
                      {commands.retry ? (
                        <>
                          <p className="mt-4 text-sm font-medium">
                            2. After fixing the cause, explicitly return this terminal job to the
                            queue
                          </p>
                          <Command value={commands.retry} />
                        </>
                      ) : (
                        <p className="mt-4 text-sm text-muted-foreground">
                          Inspect worker logs and dependency availability. The running worker can
                          reclaim expired leases; this screen does not force retries.
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
