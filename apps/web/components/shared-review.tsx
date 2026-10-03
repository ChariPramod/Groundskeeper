"use client";

import { History, Save, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSharedReviewData,
  type SharedReviewData,
  type SharedReviewFields,
} from "../lib/shared-review-types";
import { Button } from "./ui/button";

const empty: SharedReviewFields = { owner: "", note: "", dismissed: false };

export function SharedReview({ runId }: { runId: string }) {
  const [saved, setSaved] = useState<SharedReviewData | null>(null);
  const [draft, setDraft] = useState<SharedReviewFields>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const active = useRef<AbortController | null>(null);
  const perform = useCallback(
    async (body?: SharedReviewFields & { version: number }) => {
      if (pending.current) return;
      pending.current = true;
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch(`/api/review/${encodeURIComponent(runId)}/state`, {
          method: body ? "PUT" : "GET",
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok)
          throw new Error(
            response.status === 409
              ? "Someone changed this review. Your draft is still below. Reload the latest review before saving again."
              : response.status === 401 || response.status === 403
                ? "Your team access is unavailable. Sign in again or ask your operator to restore access. Your draft has not been cleared."
                : "The shared review could not be confirmed. Your draft has not been cleared. Reload before trying to save again.",
          );
        const result: unknown = await response.json();
        if (
          !isSharedReviewData(result) ||
          result.runId !== runId ||
          (body && result.version !== body.version + 1)
        )
          throw new Error(
            "The server returned an unexpected review. Reload to confirm the saved state.",
          );
        if (controller.signal.aborted) return;
        setSaved(result);
        setDraft({ owner: result.owner, note: result.note, dismissed: result.dismissed });
        setUncertain(false);
        setNotice(body ? "Shared review saved." : "");
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (body) setUncertain(true);
        setError(
          cause instanceof Error && cause.name !== "TimeoutError"
            ? cause.message
            : "Request timed out. Reload to confirm the saved state. Your draft has not been cleared.",
        );
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          pending.current = false;
        }
      }
    },
    [runId],
  );
  useEffect(() => {
    pending.current = false;
    void perform();
    return () => active.current?.abort();
  }, [perform]);
  const dirty =
    saved &&
    (draft.owner !== saved.owner ||
      draft.note !== saved.note ||
      draft.dismissed !== saved.dismissed);
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-muted/30 p-4"
      aria-label="Shared team review"
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Users className="size-4" />
        <h4>Shared team review</h4>
      </div>
      <p className="text-xs text-muted-foreground">
        Visible to approved workspace members. Review status does not change verification evidence.
        Owner is a label; assigning it does not send a notification.
      </p>
      {error && (
        <p role="alert" className="text-sm text-amber-800">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-xs">
          {saved ? "Saving or reloading shared review…" : "Loading shared review…"}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-emerald-700">
          {notice}
        </p>
      )}
      {saved && (
        <>
          <label className="block text-xs font-medium">
            Team owner
            <input
              maxLength={100}
              value={draft.owner}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
              placeholder="Unassigned"
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs font-medium">
            Team review note
            <textarea
              maxLength={2000}
              value={draft.note}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="Record what needs attention…"
              className="mt-1 block min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={draft.dismissed}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, dismissed: e.target.checked })}
            />
            Dismissed for the team
          </label>
          <p className="text-xs text-muted-foreground">
            Version {saved.version} ·{" "}
            {dirty
              ? "Unsaved changes — keep this review open until saved."
              : "Up to date with the last loaded version."}
          </p>
          <Button
            size="sm"
            disabled={busy || uncertain || !dirty}
            onClick={() => void perform({ ...draft, version: saved.version })}
          >
            <Save />
            Save shared review
          </Button>
        </>
      )}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform()}>
        {dirty ? "Reload latest (discards draft)" : "Reload shared review"}
      </Button>
      {saved && saved.events.length > 0 && (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-xs font-medium">
            <History className="mr-1 inline size-3" />
            Recent review history
          </summary>
          <ol className="mt-3 space-y-3">
            {saved.events.map((event) => (
              <li key={event.version} className="space-y-1 border-t border-border pt-2 text-xs">
                <p className="font-medium">
                  v{event.version} · {event.actorLogin} ·{" "}
                  {new Date(event.createdAt).toLocaleString()}
                </p>
                <p>
                  {event.dismissed ? "Dismissed" : "Open"} · Owner: {event.owner || "Unassigned"}
                </p>
                {event.note && (
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">
                    {event.note}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the latest {saved.events.length} changes.
          </p>
        </details>
      )}
    </section>
  );
}
