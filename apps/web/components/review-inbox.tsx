"use client";

import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Inbox,
  RefreshCw,
  Search,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardRun } from "../lib/dashboard-types";
import {
  demoReviewInbox,
  fetchReviewInbox,
  ReviewInboxAccessError,
} from "../lib/review-inbox-client";
import {
  defaultInboxFilters,
  type ReviewInboxFilters,
  type ReviewInboxPage,
} from "../lib/review-inbox-types";
import { InboxExport } from "./inbox-export";
import { SavedInboxViews } from "./saved-inbox-views";
import { Button } from "./ui/button";

type Snapshot = {
  data: ReviewInboxPage;
  filters: ReviewInboxFilters;
  cursors: (string | null)[];
  page: number;
};
const fieldClass =
  "mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const sameFilters = (a: ReviewInboxFilters, b: ReviewInboxFilters) =>
  a.status === b.status &&
  a.owner.trim() === b.owner.trim() &&
  a.repository.trim() === b.repository.trim() &&
  a.unassigned === b.unassigned;

export function ReviewInbox({
  mode,
  onOpenRun,
  refreshKey = 0,
  viewScope = null,
}: {
  mode: "demo" | "live";
  onOpenRun: (run: DashboardRun) => void;
  refreshKey?: number;
  viewScope?: string | null;
}) {
  const [draft, setDraft] = useState<ReviewInboxFilters>(defaultInboxFilters);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    async (filters: ReviewInboxFilters, cursors: (string | null)[] = [null], page = 0) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setError("");
      try {
        const data =
          mode === "demo"
            ? demoReviewInbox(filters)
            : await fetchReviewInbox(
                filters,
                cursors[page] ?? null,
                AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
              );
        if (controller.signal.aborted) return;
        const value = { data, filters, cursors, page };
        snapshotRef.current = value;
        setSnapshot(value);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ReviewInboxAccessError) {
          snapshotRef.current = null;
          setSnapshot(null);
        }
        setError(
          cause instanceof Error &&
            !["TypeError", "TimeoutError", "SyntaxError"].includes(cause.name)
            ? cause.message
            : "The inbox could not be loaded. Check your connection and retry. Your last loaded reviews are unchanged.",
        );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [mode],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Parent increments refreshKey after a shared review save.
  useEffect(() => {
    // A completed shared save refreshes the active filters and restarts the traversal.
    const previous = snapshotRef.current;
    void load(previous?.data.mode === mode ? previous.filters : defaultInboxFilters);
    return () => active.current?.abort();
  }, [load, mode, refreshKey]);
  const current = snapshot?.data.mode === mode ? snapshot : null;
  const dirty = current && !sameFilters(draft, current.filters);
  const clear = () => {
    setDraft(defaultInboxFilters);
    void load(defaultInboxFilters);
  };
  const applied = current?.filters;
  const savedScope = mode === "demo" ? "demo" : viewScope ? `live:${viewScope}` : null;
  return (
    <section className="flex flex-col gap-6" aria-labelledby="review-inbox-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Team workflow
          </p>
          <h2 id="review-inbox-title" className="text-2xl font-semibold tracking-tight">
            Review inbox
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Find the reviews that need an owner, pick up a teammate’s work, and keep decisions
            beside the evidence.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void load(current?.filters ?? draft)}
          disabled={busy}
        >
          <RefreshCw className={busy ? "animate-spin motion-reduce:animate-none" : ""} /> Refresh
          inbox
        </Button>
      </div>
      {mode === "demo" && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Demo inbox · Sample assignments and notes. Filters work locally; these records are not
          connected to your team or saved to a backend.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load(draft);
        }}
        className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs font-medium">
            Review status
            <select
              className={fieldClass}
              value={draft.status}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value as ReviewInboxFilters["status"] })
              }
            >
              <option value="open">Open reviews</option>
              <option value="dismissed">Dismissed reviews</option>
              <option value="all">All reviews</option>
            </select>
          </label>
          <label className="text-xs font-medium">
            Owner · exact label
            <input
              className={fieldClass}
              maxLength={100}
              value={draft.owner}
              disabled={draft.unassigned}
              placeholder="e.g. maya"
              onChange={(event) => setDraft({ ...draft, owner: event.target.value })}
            />
          </label>
          <label className="text-xs font-medium sm:col-span-2">
            Repository · full name
            <input
              className={fieldClass}
              maxLength={201}
              value={draft.repository}
              placeholder="e.g. acme/python-sdk"
              pattern="[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}"
              onChange={(event) => setDraft({ ...draft, repository: event.target.value })}
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.unassigned}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  unassigned: event.target.checked,
                  owner: event.target.checked ? "" : draft.owner,
                })
              }
              className="size-4 accent-emerald-700"
            />{" "}
            Unassigned only
          </label>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={clear} disabled={busy}>
              <X /> Clear filters
            </Button>
            <Button type="submit" disabled={busy}>
              <Search /> Apply filters
            </Button>
          </div>
        </div>
      </form>
      <SavedInboxViews
        key={savedScope ?? "unconfirmed"}
        scope={savedScope}
        filters={!dirty ? (applied ?? null) : null}
        busy={busy}
        onApply={(filters) => {
          setDraft(filters);
          void load(filters);
        }}
      />
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p>{error}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(draft)}>
            Retry inbox
          </Button>
        </div>
      )}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
      >
        <p>
          {busy
            ? "Loading reviews…"
            : current
              ? `${current.data.rows.length} ${current.data.rows.length === 1 ? "review" : "reviews"} on this page`
              : "No reviews loaded"}
          {dirty && " · New filters have not been applied"}
        </p>
        {applied && (
          <p>
            Showing: {applied.status}
            {applied.unassigned
              ? " · unassigned"
              : applied.owner
                ? ` · owner: ${applied.owner}`
                : " · any owner"}
            {applied.repository ? ` · ${applied.repository}` : " · all repositories"}
          </p>
        )}
      </div>
      <div
        className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
        aria-busy={busy}
      >
        {!current && busy ? (
          <div className="space-y-4 p-6" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="h-20 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : current?.data.rows.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <Inbox className="mx-auto mb-4 size-9 text-muted-foreground" />
            <h3 className="font-semibold">No reviews match these filters</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Try another owner or repository, or include dismissed reviews. New analyses will
              appear here after processing.
            </p>
            <Button className="mt-5" variant="outline" onClick={clear} disabled={busy}>
              Clear filters
            </Button>
          </div>
        ) : current ? (
          <ul className="divide-y divide-border">
            {current.data.rows.map((run) => (
              <li key={run.id} className="p-5 transition-colors hover:bg-muted/30 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-md px-2 py-1 text-[11px] font-medium ${run.review.dismissed ? "bg-muted text-muted-foreground" : "bg-emerald-50 text-emerald-800"}`}
                      >
                        {run.review.dismissed ? "Dismissed" : "Open"}
                      </span>
                      <span
                        className={`rounded-md px-2 py-1 text-[11px] font-medium ${run.status === "needs-review" ? "bg-amber-50 text-amber-800" : "bg-muted text-muted-foreground"}`}
                      >
                        {run.status === "needs-review"
                          ? "Evidence needs review"
                          : run.status === "verified"
                            ? "Selected examples passed"
                            : "Verification unknown"}
                      </span>
                    </div>
                    <h3 className="break-all text-sm font-semibold">{run.repository.fullName}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <code>
                        {run.beforeCommit.slice(0, 8)} → {run.afterCommit.slice(0, 8)}
                      </code>{" "}
                      ·{" "}
                      <time dateTime={run.createdAt}>
                        {new Date(run.createdAt).toLocaleString()}
                      </time>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenRun(run)}
                    aria-label={`Review ${run.repository.fullName} at ${run.afterCommit.slice(0, 8)}`}
                  >
                    Review evidence <ArrowRight />
                  </Button>
                </div>
                {run.review.noteSnippet && (
                  <p className="mt-3 max-w-3xl break-words text-sm text-muted-foreground">
                    {run.review.noteSnippet}
                    {run.review.noteSnippet.length === 160 ? "…" : ""}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                  <span
                    className={`inline-flex items-center gap-1.5 ${run.review.owner ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    <UserRound className="size-3.5" />
                    {run.review.owner || "Unassigned"}
                  </span>
                  <span className="text-muted-foreground">
                    {run.affectedClaims} affected / {run.totalClaims} claims
                  </span>
                  {run.review.version > 0 && (
                    <span className="text-muted-foreground">Review v{run.review.version}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Use Retry inbox after restoring team access or your connection.
          </p>
        )}
      </div>
      {current && <InboxExport snapshot={current} stale={!!error} busy={busy} />}
      {current && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Page {current.page + 1} · Newest analyses first. Review status does not change
            verification evidence.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !!dirty || current.page === 0}
              onClick={() => void load(current.filters, current.cursors, current.page - 1)}
            >
              <ChevronLeft /> Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !!dirty || !current.data.nextCursor}
              onClick={() =>
                void load(
                  current.filters,
                  [...current.cursors.slice(0, current.page + 1), current.data.nextCursor],
                  current.page + 1,
                )
              }
            >
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
