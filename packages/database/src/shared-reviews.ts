import type { Prisma, PrismaClient, TeamRole } from "@prisma/client";

export class SharedReviewInputError extends Error {}
export class SharedReviewNotFoundError extends Error {}
export class SharedReviewAccessError extends Error {}
export class SharedReviewPermissionError extends Error {}
export class SharedReviewConflictError extends Error {}

export interface SharedReviewIdentity {
  analysisRunId: string;
  installationId: bigint;
  actorGithubUserId: bigint;
}
export interface SharedReviewUpdate extends SharedReviewIdentity {
  actorLogin: string;
  expectedVersion: number;
  owner: string;
  note: string;
  dismissed: boolean;
}
export interface SharedReviewData {
  runId: string;
  version: number;
  owner: string;
  note: string;
  dismissed: boolean;
  updatedAt: string | null;
  events: {
    version: number;
    actorGithubUserId: string;
    actorLogin: string;
    owner: string;
    note: string;
    dismissed: boolean;
    createdAt: string;
  }[];
}
function validateIdentity(input: SharedReviewIdentity) {
  if (
    typeof input.analysisRunId !== "string" ||
    !input.analysisRunId.trim() ||
    input.analysisRunId.length > 200 ||
    typeof input.installationId !== "bigint" ||
    input.installationId <= 0n ||
    input.installationId > 9223372036854775807n ||
    typeof input.actorGithubUserId !== "bigint" ||
    input.actorGithubUserId <= 0n ||
    input.actorGithubUserId > 9223372036854775807n
  )
    throw new SharedReviewInputError("Invalid review identity");
}
function validateUpdate(input: SharedReviewUpdate) {
  validateIdentity(input);
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion >= 2147483647 ||
    typeof input.owner !== "string" ||
    input.owner.length > 100 ||
    input.owner.includes("\0") ||
    typeof input.note !== "string" ||
    input.note.length > 2000 ||
    input.note.includes("\0") ||
    typeof input.dismissed !== "boolean" ||
    typeof input.actorLogin !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(input.actorLogin)
  )
    throw new SharedReviewInputError("Invalid review state");
}

/** Lock membership against concurrent revoke, then the immutable run to serialize first writes. */
async function authorize(tx: Prisma.TransactionClient, input: SharedReviewIdentity, write = false) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '3000ms'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
  const members = await tx.$queryRaw<{ workspaceId: string; role: TeamRole }[]>`
    SELECT m."workspaceId", m.role FROM "TeamMember" m
    JOIN "Workspace" w ON w.id = m."workspaceId"
    WHERE w."installationId" = ${input.installationId} AND m."githubUserId" = ${input.actorGithubUserId}
    FOR SHARE OF m`;
  if (members.length !== 1) throw new SharedReviewAccessError("Team membership required");
  if (write && !(members[0]?.role === "reviewer" || members[0]?.role === "admin"))
    throw new SharedReviewPermissionError("Reviewer or admin role required");
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT a.id FROM "AnalysisRun" a JOIN "Repository" r ON r.id = a."repositoryId"
    WHERE a.id = ${input.analysisRunId} AND r."workspaceId" = ${members[0]?.workspaceId}
    FOR UPDATE OF a`;
  if (rows.length !== 1) throw new SharedReviewNotFoundError("Review not found");
}
async function snapshot(
  tx: Prisma.TransactionClient,
  analysisRunId: string,
): Promise<SharedReviewData> {
  const state = await tx.sharedReview.findUnique({ where: { analysisRunId } });
  const events = await tx.sharedReviewEvent.findMany({
    where: { analysisRunId },
    orderBy: { version: "desc" },
    take: 20,
    select: {
      version: true,
      actorGithubUserId: true,
      actorLogin: true,
      owner: true,
      note: true,
      dismissed: true,
      createdAt: true,
    },
  });
  return {
    runId: analysisRunId,
    version: state?.version ?? 0,
    owner: state?.owner ?? "",
    note: state?.note ?? "",
    dismissed: state?.dismissed ?? false,
    updatedAt: state?.updatedAt.toISOString() ?? null,
    events: events.map((event) => ({
      ...event,
      actorGithubUserId: event.actorGithubUserId.toString(),
      createdAt: event.createdAt.toISOString(),
    })),
  };
}
export async function readSharedReview(
  db: PrismaClient,
  input: SharedReviewIdentity,
): Promise<SharedReviewData> {
  validateIdentity(input);
  return db.$transaction(
    async (tx) => {
      await authorize(tx, input);
      return snapshot(tx, input.analysisRunId);
    },
    { maxWait: 3000, timeout: 5000 },
  );
}
export async function updateSharedReview(
  db: PrismaClient,
  input: SharedReviewUpdate,
): Promise<SharedReviewData> {
  validateUpdate(input);
  return db.$transaction(
    async (tx) => {
      await authorize(tx, input, true);
      const existing = await tx.sharedReview.findUnique({
        where: { analysisRunId: input.analysisRunId },
      });
      if ((existing?.version ?? 0) !== input.expectedVersion)
        throw new SharedReviewConflictError("Review changed; reload before saving");
      const data = {
        owner: input.owner,
        note: input.note,
        dismissed: input.dismissed,
        version: input.expectedVersion + 1,
      };
      if (existing) {
        const result = await tx.sharedReview.updateMany({
          where: { analysisRunId: input.analysisRunId, version: input.expectedVersion },
          data,
        });
        if (result.count !== 1)
          throw new SharedReviewConflictError("Review changed; reload before saving");
      } else
        await tx.sharedReview.create({ data: { analysisRunId: input.analysisRunId, ...data } });
      await tx.sharedReviewEvent.create({
        data: {
          analysisRunId: input.analysisRunId,
          actorGithubUserId: input.actorGithubUserId,
          actorLogin: input.actorLogin,
          ...data,
        },
      });
      return snapshot(tx, input.analysisRunId);
    },
    { maxWait: 3000, timeout: 5000 },
  );
}
