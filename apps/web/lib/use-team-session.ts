"use client";
import { useCallback, useEffect, useState } from "react";
export type TeamRole = "viewer" | "reviewer" | "admin";
export function useTeamSession(enabled: boolean) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [session, setSession] = useState<{
    login: string;
    role: TeamRole;
    viewScope: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [accessRejected, setAccessRejected] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh rechecks permissions after a membership change.
  useEffect(() => {
    if (!enabled) {
      setSession(null);
      setError("");
      setAccessRejected(false);
      return;
    }
    let current = true;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      let rejected = false;
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok) {
          rejected = response.status === 401 || response.status === 403;
          throw new Error("Session unavailable");
        }
        const data = await response.json();
        if (
          !data ||
          typeof data.login !== "string" ||
          !/^[A-Za-z0-9-]{1,39}$/.test(data.login) ||
          !["viewer", "reviewer", "admin"].includes(data.role)
        )
          throw new Error("Invalid session");
        if (current && !request.signal.aborted) {
          setSession({
            login: data.login,
            role: data.role,
            viewScope:
              typeof data.viewScope === "string" && /^[a-f0-9]{64}$/.test(data.viewScope)
                ? data.viewScope
                : null,
          });
          setError("");
          setAccessRejected(false);
        }
      } catch {
        if (current && !request.signal.aborted) {
          setSession(null);
          setAccessRejected(rejected);
          setError(
            "Unable to confirm your role. Shared editing is disabled until your session is available.",
          );
        }
      }
    };
    void load();
    window.addEventListener("focus", load);
    return () => {
      current = false;
      controller?.abort();
      window.removeEventListener("focus", load);
    };
  }, [enabled, revision]);
  return { session, error, refresh, accessRejected };
}
