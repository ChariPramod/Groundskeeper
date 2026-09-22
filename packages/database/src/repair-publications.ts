import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export interface RepairReservationInput {
  analysisRunId: string;
  installationId: bigint;
  proposalId: string;
  pages: number;
  linesChanged: number;
}
export class RepairReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairReservationError";
  }
}

/** Durable, installation-scoped single-PR budget. Ambiguous remote failures never free the proposal reservation. */
export async function reserveRepairPublication(
  database: PrismaClient,
  input: RepairReservationInput,
) {
  if (
    !/^[a-f0-9]{64}$/.test(input.proposalId) ||
    input.installationId <= 0n ||
    !Number.isSafeInteger(input.pages) ||
    input.pages < 1 ||
    input.pages > 3 ||
    !Number.isSafeInteger(input.linesChanged) ||
    input.linesChanged < 1 ||
    input.linesChanged > 150
  ) {
    throw new RepairReservationError("Invalid repair reservation");
  }
  return database.$transaction(async (tx) => {
    // Lock the owning analysis to serialize creation and enforce its single publication budget.
    const ownership = await tx.$queryRaw<
      { maxPages: number; maxPrs: number; maxLinesChanged: number }[]
    >`
      SELECT r."maxPages", r."maxPrs", r."maxLinesChanged"
      FROM "AnalysisRun" a JOIN "Repository" r ON r.id = a."repositoryId"
      JOIN "Workspace" w ON w.id = r."workspaceId"
      WHERE a.id = ${input.analysisRunId} AND w."installationId" = ${input.installationId}
      FOR UPDATE OF a, r
    `;
    const budget = ownership[0];
    if (
      !budget ||
      budget.maxPrs < 1 ||
      input.pages > budget.maxPages ||
      input.linesChanged > budget.maxLinesChanged
    ) {
      throw new RepairReservationError(
        "Analysis ownership or repository change budget denied publication",
      );
    }
    const existing = await tx.repairPublication.findUnique({
      where: { analysisRunId: input.analysisRunId },
    });
    if (existing && existing.proposalId !== input.proposalId) {
      throw new RepairReservationError(
        "Another proposal already reserved this analysis publication budget",
      );
    }
    if (existing?.pullRequestUrl) return { token: null, url: existing.pullRequestUrl };
    if (!existing)
      await tx.repairPublication.create({
        data: { analysisRunId: input.analysisRunId, proposalId: input.proposalId },
      });
    const token = randomUUID();
    const claimed = await tx.$executeRaw`
      UPDATE "RepairPublication" SET "leaseToken" = ${token}, "leaseExpiresAt" = clock_timestamp() + interval '10 minutes'
      WHERE "analysisRunId" = ${input.analysisRunId} AND "proposalId" = ${input.proposalId}
        AND "pullRequestUrl" IS NULL AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
    `;
    if (claimed !== 1)
      throw new RepairReservationError(
        "Another publisher holds the active lease; retry after it completes or expires",
      );
    return { token, url: null };
  });
}

export async function assertRepairPublicationLease(
  database: PrismaClient,
  analysisRunId: string,
  proposalId: string,
  token: string,
) {
  const rows = await database.$queryRaw<{ analysisRunId: string }[]>`
    SELECT "analysisRunId" FROM "RepairPublication"
    WHERE "analysisRunId" = ${analysisRunId} AND "proposalId" = ${proposalId} AND "leaseToken" = ${token}
      AND "leaseExpiresAt" > clock_timestamp() AND "pullRequestUrl" IS NULL
  `;
  if (rows.length !== 1)
    throw new RepairReservationError("Publication lease expired or is no longer owned");
}
export async function finishRepairPublication(
  database: PrismaClient,
  analysisRunId: string,
  token: string,
  url: string,
) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url))
    throw new RepairReservationError("Invalid pull request URL");
  const changed = await database.$executeRaw`
    UPDATE "RepairPublication" SET "pullRequestUrl" = ${url}, "leaseToken" = NULL, "leaseExpiresAt" = NULL
    WHERE "analysisRunId" = ${analysisRunId} AND "leaseToken" = ${token}
      AND "leaseExpiresAt" > clock_timestamp() AND "pullRequestUrl" IS NULL
  `;
  if (changed !== 1)
    throw new RepairReservationError(
      "Could not finalize the publication lease; retain the receipt and retry the same proposal",
    );
}
export async function releaseRepairPublicationLease(
  database: PrismaClient,
  analysisRunId: string,
  token: string,
) {
  await database.$executeRaw`
    UPDATE "RepairPublication" SET "leaseToken" = NULL, "leaseExpiresAt" = NULL
    WHERE "analysisRunId" = ${analysisRunId} AND "leaseToken" = ${token} AND "pullRequestUrl" IS NULL
  `;
}
