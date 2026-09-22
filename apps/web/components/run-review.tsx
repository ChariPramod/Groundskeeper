"use client";

import { AlertCircle, CheckCircle2, FileCode2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { getDemoReview } from "../lib/review-demo";
import { isRunReviewData, type RunReviewData } from "../lib/review-types";
import { Button } from "./ui/button";

type Annotation = { owner: string; note: string; dismissed: boolean; updatedAt: string };
const empty: Annotation = { owner: "", note: "", dismissed: false, updatedAt: "" };

function LocalReview({ storageKey }: { storageKey: string }) {
  const [annotation, setAnnotation] = useState<Annotation>(empty);
  const [storageAvailable, setStorageAvailable] = useState(true);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        setAnnotation({
          owner: typeof saved.owner === "string" ? saved.owner.slice(0, 100) : "",
          note: typeof saved.note === "string" ? saved.note.slice(0, 2000) : "",
          dismissed: saved.dismissed === true,
          updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : "",
        });
      }
    } catch {
      setStorageAvailable(false);
    }
  }, [storageKey]);
  function update(change: Partial<Annotation>) {
    const next = { ...annotation, ...change, updatedAt: new Date().toISOString() };
    setAnnotation(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      setStorageAvailable(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">Your local review</h4>
        <span className="text-xs text-muted-foreground">This browser only</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Owner, notes, and dismissal are private browser annotations. They do not change verification
        results or notify your team.
      </p>
      {!storageAvailable && (
        <p role="status" className="text-xs text-amber-700">
          Browser storage is unavailable or unreadable. Changes remain in memory while this review
          is open.
        </p>
      )}
      <label className="block text-xs font-medium">
        Owner
        <input
          maxLength={100}
          value={annotation.owner}
          onChange={(e) => update({ owner: e.target.value })}
          placeholder="Unassigned"
          className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="block text-xs font-medium">
        Review note
        <textarea
          maxLength={2000}
          value={annotation.note}
          onChange={(e) => update({ note: e.target.value })}
          placeholder="Record what needs attention…"
          className="mt-1 block min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        onClick={() => update({ dismissed: !annotation.dismissed })}
      >
        {annotation.dismissed ? "Reopen local review" : "Dismiss locally"}
      </Button>
      {annotation.dismissed && (
        <span className="ml-3 text-xs text-muted-foreground">Dismissed in this browser</span>
      )}
    </section>
  );
}

export function RunReview({
  runId,
  token,
  mode,
}: {
  runId: string;
  token: string;
  mode: "demo" | "live";
}) {
  const [data, setData] = useState<RunReviewData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly triggers a fresh request.
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setData(null);
    setError("");
    setLoading(true);
    const timeout = setTimeout(() => controller.abort(), 15000);
    async function load() {
      try {
        const result =
          mode === "demo"
            ? getDemoReview(runId)
            : await (async () => {
                const response = await fetch(`/api/review/${encodeURIComponent(runId)}`, {
                  headers: { Authorization: `Bearer ${token}` },
                  cache: "no-store",
                  signal: controller.signal,
                });
                if (!response.ok)
                  throw new Error(
                    response.status === 401
                      ? "Reconnect with a valid access token to review this run."
                      : response.status === 404
                        ? "This run is unavailable for the connected installation."
                        : "Review details are temporarily unavailable. Try again.",
                  );
                return response.json();
              })();
        if (
          !isRunReviewData(result) ||
          result.id !== runId ||
          result.mode !== mode ||
          !Array.isArray(result.findings)
        )
          throw new Error("Review details could not be loaded. Try again.");
        if (current) setData(result);
      } catch (cause) {
        if (current)
          setError(
            cause instanceof Error && cause.name !== "AbortError"
              ? cause.message
              : "The review request timed out. Try again.",
          );
      } finally {
        clearTimeout(timeout);
        if (current) setLoading(false);
      }
    }
    void load();
    return () => {
      current = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [runId, token, mode, attempt]);
  if (loading)
    return (
      <p role="status" className="py-6 text-sm text-muted-foreground">
        Loading documentation and evidence…
      </p>
    );
  if (!data || error)
    return (
      <div className="space-y-3 rounded-xl border border-border p-4">
        <p role="alert" className="text-sm">
          {error}
        </p>
        <Button size="sm" variant="outline" onClick={() => setAttempt((v) => v + 1)}>
          <RotateCcw />
          Retry details
        </Button>
      </div>
    );
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <FileCode2 className="size-4 text-emerald-700" /> Documentation review
      </div>
      {mode === "demo" && (
        <p className="text-xs text-muted-foreground">
          Illustrative excerpts and findings from sample repositories.
        </p>
      )}
      {data.truncated && (
        <p className="text-xs text-muted-foreground">
          Showing {data.findings.length} of {data.totalClaims} claims, prioritizing affected
          documentation. Excerpts are limited to 4,000 characters. Full details remain in the stored
          report.
        </p>
      )}
      {data.findings.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No documentation claims were recorded for this run.
        </p>
      )}
      {data.findings.map((finding) => (
        <article key={finding.id} className="overflow-hidden rounded-xl border border-border">
          <div className="flex items-center justify-between gap-3 bg-muted/40 px-4 py-3">
            <span className="break-all font-mono text-xs">
              {finding.page}:{finding.line}
            </span>
            <span className="shrink-0 text-xs font-medium">
              {finding.execution?.status ?? "Not verified"}
            </span>
          </div>
          <div className="space-y-4 p-4">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#142b21] p-4 font-mono text-xs leading-relaxed text-emerald-50">
              {finding.text || "No excerpt available."}
            </pre>
            {finding.impact && (
              <p className="flex gap-2 text-sm">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                {finding.impact}
              </p>
            )}
            {finding.symbols.length > 0 && (
              <div className="space-y-1 text-xs">
                <p className="font-medium">Linked changed symbols</p>
                {finding.symbols.map((s) => (
                  <p
                    key={`${s.path}:${s.name}`}
                    className="break-all font-mono text-muted-foreground"
                  >
                    {s.name} · {s.path}
                  </p>
                ))}
              </div>
            )}
            <p className="flex gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="size-4 shrink-0" />
              {finding.execution?.reason ||
                "No execution evidence is available. This finding remains unverified."}
            </p>
          </div>
        </article>
      ))}
      <LocalReview
        key={`${mode}:${data.repository}:${runId}`}
        storageKey={`groundskeeper:review:v1:${mode}:${data.repository}:${runId}`}
      />
    </div>
  );
}
