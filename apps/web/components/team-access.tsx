"use client";

import {
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeDemoTeam,
  changeTeam,
  demoTeam,
  fetchTeam,
  TeamRequestError,
} from "../lib/team-management-client";
import type { TeamChange, TeamDirectory, TeamRole } from "../lib/team-management-types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const roles = ["viewer", "reviewer", "admin"] as const;
const fieldClass =
  "h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const timestamp = (value: string) =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));

function MemberRow({
  member,
  disabled,
  onChange,
}: {
  member: TeamDirectory["members"][number];
  disabled: boolean;
  onChange: (role: TeamRole | null) => void;
}) {
  const [role, setRole] = useState(member.role);
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
          <UserRound className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="break-all text-sm font-semibold">GitHub user #{member.githubUserId}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {member.lastKnownLogin
              ? `Last signed in as @${member.lastKnownLogin}`
              : "No recorded sign-in"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Added {timestamp(member.createdAt)} UTC
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Role for GitHub user ${member.githubUserId}`}
          className={`${fieldClass} capitalize`}
          value={role}
          disabled={disabled}
          onChange={(event) => setRole(event.target.value as TeamRole)}
        >
          {roles.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          disabled={disabled || role === member.role}
          onClick={() => onChange(role)}
        >
          Review change
        </Button>
        <Button
          variant="ghost"
          className="text-red-700"
          disabled={disabled}
          onClick={() => onChange(null)}
          aria-label={`Remove GitHub user ${member.githubUserId}`}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

export function TeamAccess({
  mode,
  role,
  onChanged,
}: {
  mode: "demo" | "live";
  role: TeamRole | null;
  onChanged: () => void;
}) {
  const allowed = mode === "demo" || role === "admin";
  const [data, setData] = useState<TeamDirectory | null>(null);
  const dataRef = useRef<TeamDirectory | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const [target, setTarget] = useState("");
  const [newRole, setNewRole] = useState<TeamRole>("viewer");
  const [pending, setPending] = useState<TeamChange | null>(null);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const resetAccess = useCallback(() => {
    dataRef.current = null;
    setData(null);
    setPending(null);
    setTarget("");
    setMustReload(true);
  }, []);
  const load = useCallback(
    async (nextCursors: (string | null)[] = [null], nextPage = 0) => {
      read.current?.abort();
      const controller = new AbortController();
      read.current = controller;
      setLoading(true);
      setError("");
      try {
        const value =
          mode === "demo"
            ? (dataRef.current ?? demoTeam())
            : await fetchTeam(
                nextCursors[nextPage] ?? null,
                AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
              );
        if (controller.signal.aborted) return;
        dataRef.current = value;
        setData(value);
        setCursors(nextCursors);
        setPage(nextPage);
        setMustReload(false);
        setPending(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof TeamRequestError && [401, 403].includes(cause.status)) resetAccess();
        setError(
          cause instanceof TeamRequestError
            ? cause.message
            : "Team access could not be loaded. Your last loaded team is unchanged; retry to refresh it.",
        );
        setMustReload(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [mode, resetAccess],
  );
  useEffect(() => {
    if (allowed) void load();
    else resetAccess();
    return () => {
      read.current?.abort();
      write.current?.abort();
    };
  }, [allowed, load, resetAccess]);
  const prepare = (change: TeamChange) => {
    trigger.current = document.activeElement as HTMLElement;
    setNotice("");
    setPending(change);
  };
  const save = async () => {
    if (!pending || !data || saving || mustReload) return;
    const controller = new AbortController();
    write.current = controller;
    setSaving(true);
    setError("");
    try {
      if (mode === "demo") {
        const value = changeDemoTeam(data, pending);
        dataRef.current = value;
        setData(value);
        setNotice("Sample team updated for this visit. No real access changed.");
        setPending(null);
        setTarget("");
      } else {
        const result = await changeTeam(
          pending,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        );
        if (controller.signal.aborted) return;
        setNotice(
          result.changed
            ? "Team access updated. Reloading the directory…"
            : "This teammate already has the requested access.",
        );
        setPending(null);
        setTarget("");
        // Never use the old roster/version for another edit if this reload fails.
        setMustReload(true);
        onChanged();
        await load();
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof TeamRequestError && [401, 403].includes(cause.status)) resetAccess();
      setMustReload(true);
      setError(
        cause instanceof TeamRequestError
          ? cause.message
          : "The result of this change could not be confirmed. Reload the team before making another change.",
      );
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };
  const locked = loading || saving || mustReload;
  return (
    <section className="flex flex-col gap-6" aria-labelledby="team-access-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            People & permissions
          </p>
          <h2
            ref={heading}
            tabIndex={-1}
            id="team-access-title"
            className="text-2xl font-semibold tracking-tight"
          >
            Team access
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Give each teammate the access they need, with a record of every change.
          </p>
        </div>
        {allowed && (
          <Button
            variant="outline"
            onClick={() => {
              setNotice("");
              void load();
            }}
            disabled={loading || saving}
          >
            <RefreshCw className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
            {mustReload ? "Reload team" : "Refresh team"}
          </Button>
        )}
      </div>
      {mode === "demo" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            Sample team · Changes last for this visit. No invitations are sent or real accounts
            changed.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || saving}
            onClick={() => {
              const value = demoTeam();
              dataRef.current = value;
              setData(value);
              setMustReload(false);
              setError("");
              setNotice("Sample team reset.");
              setTarget("");
              setPending(null);
            }}
          >
            Reset sample team
          </Button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { name: "Viewer", icon: Eye, text: "Read evidence, reviews, and operational status." },
          {
            name: "Reviewer",
            icon: CheckCheck,
            text: "Also assign reviews, write notes, and record decisions.",
          },
          {
            name: "Admin",
            icon: ShieldCheck,
            text: "Also add teammates, change roles, and remove access.",
          },
        ].map(({ name, icon: Icon, text }) => (
          <div key={name} className="rounded-xl border border-border bg-card p-4">
            <Icon className="mb-3 size-5 text-emerald-700" />
            <h3 className="text-sm font-semibold">{name}</h3>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
      {!allowed ? (
        <div className="rounded-2xl border border-border bg-card p-6">
          <ShieldCheck className="mb-3 size-6 text-emerald-700" />
          <h3 className="text-base font-semibold">An admin account is required.</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {role
              ? `You have ${role} access. Ask a workspace admin to manage membership.`
              : "Sign in with an approved admin account. Your workspace operator configures the first admin."}
          </p>
        </div>
      ) : (
        <>
          {error && (
            <div
              role="alert"
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
            >
              <p>{error}</p>
              {mustReload && (
                <p className="mt-2">
                  Editing is paused until a successful reload confirms the current team.
                </p>
              )}
            </div>
          )}
          <p role="status" className={notice ? "text-sm text-emerald-800" : "sr-only"}>
            {notice}
          </p>
          {data ? (
            <>
              <form
                className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const id = target.trim();
                  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
                    setError("Enter a positive GitHub numeric ID within the supported range.");
                    return;
                  }
                  prepare({ version: data.version, githubUserId: id, role: newRole });
                }}
              >
                <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
                  <UserPlus className="size-4 text-emerald-700" /> Add or update a teammate
                </h3>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex min-w-40 flex-1 flex-col gap-1.5 text-xs font-medium">
                    GitHub numeric ID
                    <input
                      className={fieldClass}
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                      inputMode="numeric"
                      pattern="[1-9][0-9]{0,18}"
                      maxLength={19}
                      required
                      placeholder="e.g. 1234567"
                      disabled={locked}
                    />
                  </label>
                  <label className="flex min-w-32 flex-col gap-1.5 text-xs font-medium">
                    Access role
                    <select
                      className={`${fieldClass} capitalize`}
                      value={newRole}
                      onChange={(event) => setNewRole(event.target.value as TeamRole)}
                      disabled={locked}
                    >
                      {roles.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button type="submit" disabled={locked}>
                    <UserPlus /> Review access
                  </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Use the teammate’s numeric GitHub ID, which stays the same if their username
                  changes. This grants access when they sign in; it does not send an invitation.
                </p>
              </form>
              <div
                className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
                aria-busy={loading}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4 sm:px-5">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Users className="size-4 text-emerald-700" /> Members
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {data.members.length} on this page
                  </p>
                </div>
                <ul className="divide-y divide-border">
                  {data.members.map((member) => (
                    <MemberRow
                      key={`${member.githubUserId}:${data.version}`}
                      member={member}
                      disabled={locked}
                      onChange={(nextRole) =>
                        prepare({
                          version: data.version,
                          githubUserId: member.githubUserId,
                          role: nextRole,
                        })
                      }
                    />
                  ))}
                </ul>
                {!data.members.length && (
                  <p className="p-6 text-sm text-muted-foreground">
                    No members on this page. Refresh the team to restart.
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
                  <p className="text-xs text-muted-foreground">
                    Page {page + 1} · Ordered by GitHub ID
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={locked || page === 0}
                      onClick={() => void load(cursors, page - 1)}
                    >
                      <ChevronLeft />
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={locked || !data.nextCursor}
                      onClick={() =>
                        void load([...cursors.slice(0, page + 1), data.nextCursor], page + 1)
                      }
                    >
                      Next
                      <ChevronRight />
                    </Button>
                  </div>
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <History className="size-4 text-emerald-700" />
                  Recent access history
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">
                  Latest 20 recorded changes. Changes made before access history was enabled are not
                  listed.
                </p>
                <ol className="mt-4 divide-y divide-border">
                  {data.events.map((event) => (
                    <li
                      key={event.version}
                      className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm"
                    >
                      <div>
                        <p className="font-medium">
                          User #{event.githubUserId} · {event.previousRole ?? "No access"} →{" "}
                          {event.newRole ?? "Access removed"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {event.actor.source === "operator"
                            ? "Workspace operator"
                            : `@${event.actor.login} · GitHub #${event.actor.githubUserId}`}{" "}
                          · Version {event.version}
                        </p>
                      </div>
                      <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
                        {timestamp(event.createdAt)} UTC
                      </time>
                    </li>
                  ))}
                </ol>
                {!data.events.length && (
                  <p className="mt-4 text-sm text-muted-foreground">
                    No recorded access changes yet.
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
              {loading
                ? "Loading the team…"
                : "Team details are unavailable. Restore admin access and reload."}
            </p>
          )}
        </>
      )}
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open && !saving) setPending(null);
        }}
      >
        <DialogContent
          className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
            else heading.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {pending?.role === null ? "Remove team access?" : "Confirm team access"}
            </DialogTitle>
            <DialogDescription>
              {pending?.role === null
                ? `GitHub user #${pending.githubUserId} will lose access and all their active sessions will be revoked. Their review and access history will remain.`
                : `Set GitHub user #${pending?.githubUserId} to ${pending?.role} access in this workspace.`}
            </DialogDescription>
          </DialogHeader>
          {pending?.role === "admin" && (
            <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              Admins can manage every teammate’s access. At least one admin must remain.
            </p>
          )}
          {mode === "demo" && (
            <p className="text-sm text-muted-foreground">This changes the sample team only.</p>
          )}
          {mustReload && (
            <p role="alert" className="text-sm text-amber-900">
              {error || "Reload the team before trying again."}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={saving} onClick={() => setPending(null)}>
              {mustReload ? "Close" : "Cancel"}
            </Button>
            {mustReload ? (
              <Button disabled={loading || saving} onClick={() => void load()}>
                Reload team
              </Button>
            ) : (
              <Button
                variant={pending?.role === null ? "destructive" : "default"}
                disabled={saving || loading}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : pending?.role === null ? "Remove access" : "Confirm access"}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
