"use client";
import { ArrowUpRight, Command, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DashboardRun } from "../lib/dashboard-types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export function QuickActions({
  views,
  navigate,
  runs,
  onOpenRun,
}: {
  views: string[];
  navigate: (view: string) => void;
  runs: DashboardRun[];
  onOpenRun: (run: DashboardRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // Keep keyboard shortcuts out of other dialogs and text-editing workflows.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if ((event.target as HTMLElement)?.closest('[role="dialog"]')) return;
        event.preventDefault();
        setOpen(true);
        setQuery("");
        setIndex(0);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const normalized = query.trim().toLowerCase();
  const actions = [
    ...views
      .filter((view) => view.toLowerCase().includes(normalized))
      .map((view) => ({
        id: view,
        title: view,
        detail: "Workspace",
        perform: () => navigate(view),
      })),
    ...(normalized
      ? runs
          .filter((run) =>
            `${run.repository.fullName} ${run.id} ${run.afterCommit}`
              .toLowerCase()
              .includes(normalized),
          )
          .slice(0, 6)
          .map((run) => ({
            id: run.id,
            title: run.repository.fullName,
            detail: `${run.afterCommit.slice(0, 7)} · ${run.status.replaceAll("-", " ")}`,
            perform: () => onOpenRun(run),
          }))
      : []),
  ];
  const choose = (selected: number) => {
    const action = actions[selected];
    if (!action) return;
    setOpen(false);
    window.setTimeout(action.perform, 0);
  };
  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="sm"
        aria-label="Open quick actions"
        onClick={() => {
          setOpen(true);
          setQuery("");
          setIndex(0);
        }}
      >
        <Command className="size-4" />
        <span className="hidden sm:inline">Quick actions</span>
        <kbd className="hidden rounded border px-1 text-xs sm:inline">⌘/Ctrl K</kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-xl rounded-2xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Go anywhere</DialogTitle>
            <DialogDescription>
              Jump to a workspace tool or search the latest loaded runs.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-input px-3">
            <Search className="size-4 text-muted-foreground" />
            <input
              ref={input}
              aria-label="Search quick actions"
              placeholder="Try review inbox, operations, or a repository…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
              className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none"
              role="combobox"
              aria-expanded="true"
              aria-controls="quick-action-results"
              aria-autocomplete="list"
              aria-activedescendant={actions[index] ? `quick-action-${index}` : undefined}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = actions.length
                    ? (index + (event.key === "ArrowDown" ? 1 : actions.length - 1)) %
                      actions.length
                    : 0;
                  setIndex(next);
                  list.current?.children[next]?.scrollIntoView({ block: "nearest" });
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  choose(index);
                }
              }}
            />
          </div>
          <div
            ref={list}
            id="quick-action-results"
            role="listbox"
            aria-label="Quick action results"
            className="max-h-80 space-y-1 overflow-auto"
          >
            {actions.map((action, i) => (
              <div
                key={action.id}
                id={`quick-action-${i}`}
                role="option"
                aria-selected={i === index}
                className={`flex cursor-pointer items-center justify-between rounded-lg px-3 py-3 ${i === index ? "bg-emerald-50 text-emerald-950" : "hover:bg-muted"}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(i)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") choose(i);
                }}
                tabIndex={-1}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{action.title}</p>
                  <p className="text-xs text-muted-foreground">{action.detail}</p>
                </div>
                <ArrowUpRight className="size-4" />
              </div>
            ))}
            {!actions.length && (
              <p className="p-4 text-sm text-muted-foreground">
                No matching actions or loaded runs.
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">↑↓ to move · Enter to open · Esc to close</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
