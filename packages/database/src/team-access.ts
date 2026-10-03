import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, TeamRole } from "@prisma/client";

export interface TeamChange {
  version: number;
  githubUserId: string;
  role: TeamRole | null;
}
export interface TeamChangeResult {
  version: number;
  changed: boolean;
}
export interface TeamDirectory {
  version: number;
  members: {
    githubUserId: string;
    role: TeamRole;
    createdAt: string;
    lastKnownLogin: string | null;
  }[];
  nextCursor: string | null;
  events: {
    version: number;
    actor: { source: "member" | "operator"; githubUserId: string | null; login: string | null };
    githubUserId: string;
    previousRole: TeamRole | null;
    newRole: TeamRole | null;
    createdAt: string;
  }[];
}

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
export class TeamInputError extends Error {}
export class TeamPermissionError extends Error {}
export class TeamConflictError extends Error {}
export class TeamLastAdminError extends Error {}
export type TeamActor =
  | { source: "operator" }
  | { source: "member"; githubUserId: bigint; login: string };
const validId = (value: unknown): value is bigint =>
  typeof value === "bigint" && value > 0n && value <= 9223372036854775807n;
const validVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647;
function validateActor(actor: TeamActor) {
  if (
    !actor ||
    (actor.source !== "operator" && actor.source !== "member") ||
    (actor.source === "member" &&
      (!validId(actor.githubUserId) ||
        typeof actor.login !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(actor.login)))
  )
    throw new TeamInputError("Invalid team actor");
}
async function limits(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '3000ms'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
}
async function requireAdmin(tx: Prisma.TransactionClient, workspaceId: string, actor: TeamActor) {
  if (actor.source === "operator") return;
  const member = await tx.teamMember.findUnique({
    where: { workspaceId_githubUserId: { workspaceId, githubUserId: actor.githubUserId } },
    select: { role: true },
  });
  if (member?.role !== "admin")
    throw new TeamPermissionError("An active admin membership is required");
}

/** The workspace row serializes changes before any membership row is touched. */
export async function changeTeamMembership(
  db: PrismaClient,
  input: {
    installationId: bigint;
    targetGithubUserId: bigint;
    role: TeamRole | null;
    expectedVersion?: number;
    actor: TeamActor;
  },
): Promise<TeamChangeResult> {
  validateActor(input.actor);
  if (
    !validId(input.installationId) ||
    !validId(input.targetGithubUserId) ||
    !(input.role === null || isTeamRole(input.role)) ||
    (input.expectedVersion !== undefined && !validVersion(input.expectedVersion)) ||
    (input.actor.source === "member" && input.expectedVersion === undefined)
  )
    throw new TeamInputError("Invalid team change");
  return db.$transaction(
    async (tx) => {
      await limits(tx);
      const rows = await tx.$queryRaw<{ id: string; teamVersion: number }[]>`
      SELECT id, "teamVersion" FROM "Workspace" WHERE "installationId" = ${input.installationId} FOR UPDATE`;
      const workspace = rows[0];
      if (!workspace) throw new TeamPermissionError("Workspace is unavailable");
      await requireAdmin(tx, workspace.id, input.actor);
      if (input.expectedVersion !== undefined && input.expectedVersion !== workspace.teamVersion)
        throw new TeamConflictError("Team membership changed. Refresh before retrying.");
      const identity = { workspaceId: workspace.id, githubUserId: input.targetGithubUserId };
      const existing = await tx.teamMember.findUnique({
        where: { workspaceId_githubUserId: identity },
        select: { role: true },
      });
      const previousRole = existing?.role ?? null;
      if (previousRole === input.role) return { version: workspace.teamVersion, changed: false };
      if (
        previousRole === "admin" &&
        input.role !== "admin" &&
        (await tx.teamMember.count({ where: { workspaceId: workspace.id, role: "admin" } })) <= 1
      )
        throw new TeamLastAdminError("Add another admin before changing the last admin's access.");
      if (workspace.teamVersion >= 2147483647)
        throw new TeamConflictError("Team version limit reached.");
      if (input.role === null) await tx.teamMember.deleteMany({ where: identity });
      else
        await tx.teamMember.upsert({
          where: { workspaceId_githubUserId: identity },
          create: { ...identity, role: input.role },
          update: { role: input.role },
        });
      const version = workspace.teamVersion + 1;
      await tx.workspace.update({
        where: { id: workspace.id },
        data: { teamVersion: version },
        select: { id: true },
      });
      await tx.teamAccessEvent.create({
        data: {
          workspaceId: workspace.id,
          version,
          actorSource: input.actor.source,
          actorGithubUserId: input.actor.source === "member" ? input.actor.githubUserId : null,
          actorLogin: input.actor.source === "member" ? input.actor.login : null,
          targetGithubUserId: input.targetGithubUserId,
          previousRole,
          newRole: input.role,
        },
        select: { id: true },
      });
      return { version, changed: true };
    },
    { maxWait: 3000, timeout: 5000 },
  );
}

export async function readTeamDirectory(
  db: PrismaClient,
  input: {
    installationId: bigint;
    actor: Extract<TeamActor, { source: "member" }>;
    cursor?: bigint;
  },
): Promise<TeamDirectory> {
  validateActor(input.actor);
  if (
    input.actor.source !== "member" ||
    !validId(input.installationId) ||
    (input.cursor !== undefined && !validId(input.cursor))
  )
    throw new TeamInputError("Invalid team query");
  return db.$transaction(
    async (tx) => {
      await limits(tx);
      const rows = await tx.$queryRaw<{ id: string; teamVersion: number }[]>`
      SELECT id, "teamVersion" FROM "Workspace" WHERE "installationId" = ${input.installationId} FOR SHARE`;
      const workspace = rows[0];
      if (!workspace) throw new TeamPermissionError("Workspace is unavailable");
      await requireAdmin(tx, workspace.id, input.actor);
      const [members, events] = await Promise.all([
        // Prisma's nested relation take can load every session before slicing.
        // Materialize the member page first, then let the matching index stop each
        // lateral lookup at one login. Token hashes are ordering keys only.
        tx.$queryRaw<
          {
            githubUserId: bigint;
            role: TeamRole;
            createdAt: Date;
            lastKnownLogin: string | null;
          }[]
        >`
          WITH member_page AS MATERIALIZED (
            SELECT "githubUserId", role, "createdAt"
            FROM "TeamMember"
            WHERE "workspaceId" = ${workspace.id} AND "githubUserId" > ${input.cursor ?? 0n}
            ORDER BY "githubUserId" ASC LIMIT 51
          )
          SELECT m."githubUserId", m.role, m."createdAt", latest.login AS "lastKnownLogin"
          FROM member_page m
          LEFT JOIN LATERAL (
            SELECT s.login FROM "TeamSession" s
            WHERE s."workspaceId" = ${workspace.id} AND s."githubUserId" = m."githubUserId"
            ORDER BY s."createdAt" DESC, s."tokenHash" DESC LIMIT 1
          ) latest ON true
          ORDER BY m."githubUserId" ASC`,
        tx.teamAccessEvent.findMany({
          where: { workspaceId: workspace.id },
          take: 20,
          orderBy: { version: "desc" },
          select: {
            version: true,
            actorSource: true,
            actorGithubUserId: true,
            actorLogin: true,
            targetGithubUserId: true,
            previousRole: true,
            newRole: true,
            createdAt: true,
          },
        }),
      ]);
      const page = members.slice(0, 50);
      return {
        version: workspace.teamVersion,
        members: page.map((member) => ({
          githubUserId: member.githubUserId.toString(),
          role: member.role,
          createdAt: member.createdAt.toISOString(),
          lastKnownLogin: member.lastKnownLogin,
        })),
        nextCursor: members.length > 50 ? (page.at(-1)?.githubUserId.toString() ?? null) : null,
        events: events.map((event) => ({
          version: event.version,
          actor: {
            source: event.actorSource as "member" | "operator",
            githubUserId: event.actorGithubUserId?.toString() ?? null,
            login: event.actorLogin,
          },
          githubUserId: event.targetGithubUserId.toString(),
          previousRole: event.previousRole,
          newRole: event.newRole,
          createdAt: event.createdAt.toISOString(),
        })),
      };
    },
    { maxWait: 3000, timeout: 5000, isolationLevel: "RepeatableRead" },
  );
}

/** Operator bootstrap and CLI changes share the same locked, audited mutation engine. */
export async function setTeamMembership(
  db: PrismaClient,
  installationId: bigint,
  githubUserId: bigint,
  enabled: boolean,
  role: TeamRole = "reviewer",
) {
  if (!isTeamRole(role)) throw new TeamInputError("Invalid team role");
  return changeTeamMembership(db, {
    installationId,
    targetGithubUserId: githubUserId,
    role: enabled ? role : null,
    actor: { source: "operator" },
  });
}
