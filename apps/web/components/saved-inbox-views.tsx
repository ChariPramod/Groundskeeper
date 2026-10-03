"use client";

import { Bookmark, BookmarkPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReviewInboxFilters } from "../lib/review-inbox-types";
import {
  decodeSavedViews,
  encodeSavedViews,
  MAX_SAVED_VIEWS,
  type SavedInboxView,
  savedViewsKey,
} from "../lib/saved-inbox-views";
import { Button } from "./ui/button";

const fieldClass =
  "h-9 min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Parent keys this component by scope so a changed identity never sees old presets. */
export function SavedInboxViews({
  scope,
  filters,
  busy,
  onApply,
}: {
  scope: string | null;
  filters: ReviewInboxFilters | null;
  busy: boolean;
  onApply: (filters: ReviewInboxFilters) => void;
}) {
  const [views, setViews] = useState<SavedInboxView[]>([]);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  useEffect(() => {
    if (!scope) return;
    try {
      setViews(decodeSavedViews(localStorage.getItem(savedViewsKey(scope))));
    } catch {
      setWarning(
        "Saved views could not be read. You can save a new set; current filters are unchanged.",
      );
    }
    setReady(true);
  }, [scope]);
  const persist = (next: SavedInboxView[]) => {
    if (!scope) return;
    setViews(next);
    try {
      localStorage.setItem(savedViewsKey(scope), encodeSavedViews(next));
      setWarning("");
    } catch {
      setWarning(
        "Browser storage is unavailable. Views work for this visit but will not survive a reload.",
      );
    }
  };
  const existing = views.find((view) => view.name.toLowerCase() === name.trim().toLowerCase());
  const chosen = views.find((view) => view.name === selected);
  const atLimit = views.length >= MAX_SAVED_VIEWS && !existing;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Bookmark className="size-4 text-emerald-700" /> Saved views
        </h3>
        <p className="text-xs text-muted-foreground">
          Private to this browser · {views.length}/{MAX_SAVED_VIEWS} views
        </p>
      </div>
      {!scope ? (
        <p className="text-sm text-muted-foreground">
          Confirm your team session to save personal views.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1.5 text-xs font-medium">
            Saved inbox view
            <select
              className={fieldClass}
              value={selected}
              disabled={!ready || !views.length}
              onChange={(event) => {
                setSelected(event.target.value);
                setNotice("");
              }}
            >
              <option value="">Choose a view</option>
              {views.map((view) => (
                <option key={view.name} value={view.name}>
                  {view.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!chosen || busy}
            onClick={() => {
              if (chosen) {
                onApply({ ...chosen.filters });
                setNotice(`Selected “${chosen.name}”.`);
              }
            }}
          >
            Load view
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!chosen || busy}
            aria-label="Delete selected view"
            onClick={() => {
              if (chosen) {
                persist(views.filter((view) => view.name !== chosen.name));
                setSelected("");
                setNotice(`Deleted “${chosen.name}”.`);
              }
            }}
          >
            <Trash2 />
          </Button>
          <label className="flex min-w-40 flex-1 flex-col gap-1.5 text-xs font-medium">
            View name
            <input
              className={fieldClass}
              value={name}
              maxLength={40}
              placeholder="e.g. Unassigned SDK reviews"
              disabled={!ready}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || !filters || busy || !name.trim() || atLimit}
            onClick={() => {
              if (!filters) return;
              const saved = {
                name: name.trim(),
                filters: {
                  ...filters,
                  owner: filters.owner.trim(),
                  repository: filters.repository.trim(),
                },
              };
              persist(
                existing
                  ? views.map((view) => (view === existing ? saved : view))
                  : [...views, saved],
              );
              setSelected(saved.name);
              setName("");
              setNotice(`${existing ? "Updated" : "Saved"} “${saved.name}”.`);
            }}
          >
            <BookmarkPlus />
            {existing ? "Update view" : "Save view"}
          </Button>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {atLimit
          ? "Eight views saved. Update an existing name or delete a view to make room."
          : !filters
            ? "Apply your filters before saving a view."
            : "Saves applied filters only. Names and filters stay on this device; delete them when using a shared browser."}
      </p>
      <p role="status" className="mt-2 text-xs text-emerald-800">
        {notice}
      </p>
      {warning && (
        <p role="alert" className="mt-2 text-xs text-amber-800">
          {warning}
        </p>
      )}
    </div>
  );
}
