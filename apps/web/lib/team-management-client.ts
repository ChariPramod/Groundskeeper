import {
  isTeamChangeResult,
  isTeamDirectory,
  type TeamChange,
  type TeamDirectory,
} from "./team-management-types";

export class TeamRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? "Admin access is no longer available. Sign in with an approved admin account."
        : response.status === 409
          ? "This change conflicts with the current team or would remove its last admin. Reload the team before trying again."
          : "Team access is temporarily unavailable. Reload to confirm the latest state.";
    throw new TeamRequestError(message, response.status);
  }
  return response.json();
}
export async function fetchTeam(
  cursor: string | null,
  signal: AbortSignal,
): Promise<TeamDirectory> {
  const response = await fetch(
    `/api/team${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    { cache: "no-store", signal },
  );
  const value = await readResponse(response);
  if (!isTeamDirectory(value)) throw new Error("Invalid team response");
  return value;
}
export async function changeTeam(change: TeamChange, signal: AbortSignal) {
  const response = await fetch("/api/team", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
    cache: "no-store",
    signal,
  });
  const value = await readResponse(response);
  if (!isTeamChangeResult(value) || value.version !== change.version + (value.changed ? 1 : 0))
    throw new Error("Invalid team change response");
  return value;
}

export function demoTeam(): TeamDirectory {
  return {
    version: 3,
    members: [
      {
        githubUserId: "1001",
        role: "admin",
        lastKnownLogin: "maya",
        createdAt: "2026-09-21T10:00:00.000Z",
      },
      {
        githubUserId: "1002",
        role: "reviewer",
        lastKnownLogin: "alex",
        createdAt: "2026-09-21T11:00:00.000Z",
      },
      {
        githubUserId: "1003",
        role: "viewer",
        lastKnownLogin: null,
        createdAt: "2026-09-22T11:00:00.000Z",
      },
    ],
    nextCursor: null,
    events: [
      {
        version: 3,
        actor: { source: "member" as const, githubUserId: "1001", login: "maya" },
        githubUserId: "1003",
        previousRole: null,
        newRole: "viewer",
        createdAt: "2026-09-22T11:00:00.000Z",
      },
      {
        version: 2,
        actor: { source: "member" as const, githubUserId: "1001", login: "maya" },
        githubUserId: "1002",
        previousRole: null,
        newRole: "reviewer",
        createdAt: "2026-09-21T11:00:00.000Z",
      },
      {
        version: 1,
        actor: { source: "operator", githubUserId: null, login: null },
        githubUserId: "1001",
        previousRole: null,
        newRole: "admin",
        createdAt: "2026-09-21T10:00:00.000Z",
      },
    ],
  };
}

export function changeDemoTeam(current: TeamDirectory, change: TeamChange): TeamDirectory {
  if (current.members.find((member) => member.githubUserId === "1001")?.role !== "admin")
    throw new TeamRequestError(
      "The sample admin no longer has admin access. Reset the sample team to continue.",
      403,
    );
  if (change.version !== current.version)
    throw new TeamRequestError("Reload before changing this sample team.", 409);
  const previous = current.members.find((member) => member.githubUserId === change.githubUserId);
  if (previous?.role === change.role || (!previous && change.role === null)) return current;
  if (
    previous?.role === "admin" &&
    change.role !== "admin" &&
    current.members.filter((member) => member.role === "admin").length === 1
  )
    throw new TeamRequestError(
      "Add another admin before removing or changing the last admin.",
      409,
    );
  if (!previous && current.members.length >= 50)
    throw new TeamRequestError(
      "The sample team is limited to 50 members. Reset the demo to start again.",
      409,
    );
  const createdAt = new Date().toISOString();
  const members = current.members.filter((member) => member.githubUserId !== change.githubUserId);
  if (change.role)
    members.push({
      githubUserId: change.githubUserId,
      role: change.role,
      lastKnownLogin: previous?.lastKnownLogin ?? null,
      createdAt: previous?.createdAt ?? createdAt,
    });
  members.sort((a, b) => (BigInt(a.githubUserId) < BigInt(b.githubUserId) ? -1 : 1));
  return {
    version: current.version + 1,
    members,
    nextCursor: null,
    events: [
      {
        version: current.version + 1,
        actor: { source: "member" as const, githubUserId: "1001", login: "maya" },
        githubUserId: change.githubUserId,
        previousRole: previous?.role ?? null,
        newRole: change.role,
        createdAt,
      },
      ...current.events,
    ].slice(0, 20),
  };
}
