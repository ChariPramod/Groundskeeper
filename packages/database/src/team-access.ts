import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, TeamRole } from "@prisma/client";

export type { TeamRole } from "@prisma/client";
export const teamRoles = ["viewer", "reviewer", "admin"] as const;
export function isTeamRole(value: unknown): value is TeamRole {
  return value === "viewer" || value === "reviewer" || value === "admin";
}
export function canReview(role: unknown): boolean {
  return role === "reviewer" || role === "admin";
}
export type TeamDatabase = Pick<PrismaClient, "teamMember" | "teamSession" | "workspace">;
export const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
export async function createTeamSession(
  db: TeamDatabase,
  installationId: bigint,
  githubUserId: bigint,
  login: string,
) {
  const member = await db.teamMember.findFirst({
    where: { githubUserId, workspace: { installationId } },
  });
  if (!member) return null;
  const token = randomBytes(32).toString("base64url");
  await db.teamSession.create({
    data: {
      tokenHash: sessionHash(token),
      workspaceId: member.workspaceId,
      githubUserId,
      login,
      expiresAt: new Date(Date.now() + 8 * 3600_000),
    },
  });
  return token;
}
export async function readTeamSession(db: TeamDatabase, installationId: bigint, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const session = await db.teamSession.findFirst({
    where: {
      tokenHash: sessionHash(token),
      expiresAt: { gt: new Date() },
      member: { workspace: { installationId } },
    },
    select: { githubUserId: true, login: true, member: { select: { role: true } } },
  });
  // Read current membership on every request; a session cannot cache an old privilege.
  if (!session || !isTeamRole(session.member.role)) return null;
  return { githubUserId: session.githubUserId, login: session.login, role: session.member.role };
}
export async function revokeTeamSession(db: TeamDatabase, token: string) {
  await db.teamSession.deleteMany({ where: { tokenHash: sessionHash(token) } });
}
export async function setTeamMembership(
  db: TeamDatabase,
  installationId: bigint,
  githubUserId: bigint,
  enabled: boolean,
  role: TeamRole = "reviewer",
) {
  if (
    installationId <= 0n ||
    installationId > 9223372036854775807n ||
    githubUserId <= 0n ||
    githubUserId > 9223372036854775807n
  )
    throw new Error("Positive numeric identities required");
  if (!isTeamRole(role)) throw new Error("Invalid team role");
  const workspace = await db.workspace.findUniqueOrThrow({ where: { installationId } });
  const identity = { workspaceId: workspace.id, githubUserId };
  if (enabled)
    await db.teamMember.upsert({
      where: { workspaceId_githubUserId: identity },
      create: { ...identity, role },
      update: { role },
    });
  else await db.teamMember.deleteMany({ where: identity }); // Cascades revoke all sessions atomically.
}
