"use client";
import { useEffect, useState } from "react";
export type TeamRole = "viewer" | "reviewer" | "admin";
export function useTeamSession(enabled: boolean) {
  const [session, setSession] = useState<{ login: string; role: TeamRole } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) {
      setSession(null);
      setError("");
      return;
    }
    let current = true;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok) throw new Error("Session unavailable");
        const data = await response.json();
        if (
          !data ||
          typeof data.login !== "string" ||
          !/^[A-Za-z0-9-]{1,39}$/.test(data.login) ||
          !["viewer", "reviewer", "admin"].includes(data.role)
        )
          throw new Error("Invalid session");
        if (current && !request.signal.aborted) {
          setSession({ login: data.login, role: data.role });
          setError("");
        }
      } catch {
        if (current && !request.signal.aborted) {
          setSession(null);
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
  }, [enabled]);
  return { session, error };
}
