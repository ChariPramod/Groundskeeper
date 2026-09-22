"use client";
import { FileDiff, Search, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  demoRepairDigest,
  getDemoRepair,
  isRepairReviewData,
  type RepairReviewData,
} from "../lib/repair-review-types";
import { Button } from "./ui/button";

export function RepairReview({ mode, token }: { mode: "demo" | "live"; token: string }) {
  const [digest, setDigest] = useState(mode === "demo" ? demoRepairDigest : "");
  const [request, setRequest] = useState({
    digest: mode === "demo" ? demoRepairDigest : "",
    attempt: 0,
  });
  const [data, setData] = useState<RepairReviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDigest(mode === "demo" ? demoRepairDigest : "");
    setRequest({ digest: mode === "demo" ? demoRepairDigest : "", attempt: 0 });
  }, [mode]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: credentials and mode define the private data boundary.
  useEffect(() => {
    setData(null);
  }, [mode, token]);
  useEffect(() => {
    setError("");
    if (!request.digest) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    async function load() {
      try {
        const result =
          mode === "demo"
            ? getDemoRepair(request.digest)
            : await (async () => {
                const response = await fetch(`/api/repairs/${request.digest}`, {
                  headers: { Authorization: `Bearer ${token}` },
                  cache: "no-store",
                  signal: controller.signal,
                });
                if (!response.ok)
                  throw new Error(
                    response.status === 401
                      ? "Reconnect with a valid access token."
                      : response.status === 404
                        ? "Artifact not found for this installation. Check the digest and local artifact directory."
                        : "Artifact review is unavailable. Try again.",
                  );
                return response.json();
              })();
        if (!isRepairReviewData(result) || result.digest !== request.digest)
          throw new Error("Artifact details could not be validated. Check the digest and retry.");
        if (active) setData(result);
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error && cause.name !== "AbortError"
              ? cause.message
              : "Artifact request timed out. Try again.",
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
  }, [mode, token, request]);
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-emerald-100 p-3 text-emerald-800">
          <FileDiff className="size-5" />
        </div>
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Repair workspace</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Inspect a proposed documentation change and its recorded verification before publishing.
          </p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (/^[a-f0-9]{64}$/.test(digest.trim()))
            setRequest({ digest: digest.trim(), attempt: request.attempt + 1 });
          else {
            setError("Enter the complete 64-character SHA-256 artifact digest.");
          }
        }}
        className="rounded-xl border border-border bg-background p-5"
      >
        <label htmlFor="repair-digest" className="text-sm font-medium">
          Artifact SHA-256
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="repair-digest"
            value={digest}
            onChange={(e) => setDigest(e.target.value)}
            maxLength={64}
            placeholder="Paste the digest from pnpm repair:prepare"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
          <Button type="submit" disabled={loading}>
            <Search className="size-4" />
            {loading ? "Loading…" : "Review artifact"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {mode === "demo"
            ? "This is an illustrative sample. Switch to live mode to inspect a locally prepared artifact."
            : "Read-only access to artifacts prepared on this server for the connected installation."}
        </p>
      </form>
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {error}
          <Button
            variant="outline"
            size="sm"
            className="ml-3"
            onClick={() => setRequest((r) => ({ ...r, attempt: r.attempt + 1 }))}
          >
            Retry artifact
          </Button>
        </div>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking artifact integrity and loading the proposed changes…
        </p>
      )}
      {data && (error || loading || data.digest !== request.digest) && (
        <p
          role="status"
          className="break-all rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Showing the previously loaded artifact {data.digest}. These details are preserved for
          review; the latest request has not replaced them.
        </p>
      )}
      {data && (
        <>
          <section className="space-y-3 rounded-xl border border-border bg-background p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{data.summary}</h3>
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${data.state === "verified" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}
              >
                {data.state === "verified" ? "Recorded state: verified" : "Blocked"}
              </span>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {data.fullName} · base {data.baseCommit}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["baseline", "verification"] as const).map((stage) => (
                <div key={stage} className="rounded-lg bg-muted/40 p-3">
                  <p className="text-xs font-semibold">
                    {stage === "baseline" ? "Before repair" : "After repair"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {data[stage].passed} passed · {data[stage].failed} failed ·{" "}
                    {data[stage].skipped} skipped · {data[stage].error} errors
                  </p>
                </div>
              ))}
            </div>
            {data.reasons.length > 0 && (
              <div className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">Resolve before publishing</p>
                {data.reasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </div>
            )}
          </section>
          {data.files.map((file) => (
            <section
              key={file.path}
              className="overflow-hidden rounded-xl border border-border bg-background"
            >
              <h3 className="break-all border-b border-border px-5 py-3 font-mono text-sm">
                {file.path}
              </h3>
              <div className="grid gap-px bg-border lg:grid-cols-2">
                {(["before", "after"] as const).map((side) => (
                  <div key={side} className="min-w-0 bg-background p-4">
                    <p
                      className={`mb-2 text-xs font-semibold ${side === "before" ? "text-rose-700" : "text-emerald-700"}`}
                    >
                      {side === "before" ? "Current documentation" : "Proposed documentation"}
                    </p>
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                      {file[side]}
                    </pre>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <section className="space-y-2 rounded-xl border border-border bg-background p-5">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="size-4 text-emerald-700" />
              Publishing remains a separate approval
            </p>
            <p className="text-sm text-muted-foreground">
              This viewer never writes to GitHub. Recorded evidence is not a fresh execution. The
              publish command validates the artifact, checks the current repository head, and reruns
              verification before opening a draft pull request.
            </p>
            {mode === "live" &&
              data.state === "verified" &&
              !error &&
              !loading &&
              data.digest === request.digest && (
                <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{`pnpm repair:publish --artifact ${data.digest} --approve ${data.proposalId}`}</pre>
              )}
          </section>
        </>
      )}
      {!loading && !data && !error && (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Prepare a repair locally, then paste its artifact digest to inspect the proposal here.
        </p>
      )}
    </div>
  );
}
