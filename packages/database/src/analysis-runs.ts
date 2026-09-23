import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { PushLeaseLostError } from "./push-deliveries.js";

export interface StoreAnalysisRunInput {
  deliveryId: string;
  installationId: bigint;
  account: string;
  repository: { githubId: bigint; fullName: string; defaultBranch: string };
  beforeCommit: string;
  afterCommit: string;
  report: Prisma.InputJsonObject;
}

export class AnalysisRunConflictError extends Error {
  constructor(deliveryId: string) {
    super(`Analysis delivery ${deliveryId} already has a different result or identity`);
    this.name = "AnalysisRunConflictError";
  }
}

// Sorting keys makes an otherwise identical JSON report safe to redeliver.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Analysis report must contain only JSON values");
}

function validate(input: StoreAnalysisRunInput): void {
  for (const commit of [input.beforeCommit, input.afterCommit]) {
    if (!/^[a-f0-9]{40}$/i.test(commit) || /^0{40}$/.test(commit)) {
      throw new TypeError("Analysis commits must be full nonzero SHA-1 hashes");
    }
  }
  if (input.installationId <= 0n || input.repository.githubId <= 0n) {
    throw new TypeError("Installation and repository IDs must be positive");
  }
  for (const value of [
    input.deliveryId,
    input.account,
    input.repository.fullName,
    input.repository.defaultBranch,
  ]) {
    if (!value.trim()) throw new TypeError("Analysis identity fields must be nonempty");
  }
}

/** Append a result, or acknowledge an identical delivery. Never rewrites existing runs or indexes. */
export async function storeAnalysisRun(
  database: PrismaClient,
  input: StoreAnalysisRunInput,
  leaseToken?: string,
  event: "push" | "pull_request" = "push",
): Promise<{ runId: string; created: boolean }> {
  validate(input);
  const beforeCommit = input.beforeCommit.toLowerCase();
  const afterCommit = input.afterCommit.toLowerCase();
  const inputDigest = createHash("sha256")
    .update(
      canonicalJson({
        installationId: input.installationId.toString(),
        repositoryId: input.repository.githubId.toString(),
        beforeCommit,
        afterCommit,
        report: input.report,
      }),
    )
    .digest("hex");
  const existingResult = (existing: { id: string; inputDigest: string }) => {
    if (existing.inputDigest !== inputDigest) throw new AnalysisRunConflictError(input.deliveryId);
    return { runId: existing.id, created: false };
  };
  // Unique-key races can occur on the workspace, repository, or delivery. Retry the
  // whole transaction; an aborted transaction must never leak an orphan workspace.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await database.$transaction(async (tx) => {
        if (leaseToken !== undefined) {
          const owned = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "WebhookDelivery"
            WHERE id = ${input.deliveryId} AND event = ${event} AND "leaseToken" = ${leaseToken}
              AND "leaseExpiresAt" > clock_timestamp() AND "processedAt" IS NULL AND "failedAt" IS NULL
            FOR UPDATE
          `;
          if (owned.length !== 1) throw new PushLeaseLostError();
        }
        const existing = await tx.analysisRun.findUnique({
          where: { deliveryId: input.deliveryId },
        });
        if (existing) return existingResult(existing);
        const workspace = await tx.workspace.upsert({
          where: { installationId: input.installationId },
          create: { installationId: input.installationId, account: input.account },
          update: {},
        });
        const repository = await tx.repository.upsert({
          where: {
            workspaceId_githubId: {
              workspaceId: workspace.id,
              githubId: input.repository.githubId,
            },
          },
          create: { workspaceId: workspace.id, ...input.repository },
          update: {},
        });
        const run = await tx.analysisRun.create({
          data: {
            repositoryId: repository.id,
            deliveryId: input.deliveryId,
            beforeCommit,
            afterCommit,
            inputDigest,
            report: input.report,
          },
        });
        return { runId: run.id, created: true };
      });
    } catch (error) {
      if (
        attempt < 2 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2002" || error.code === "P2034")
      ) {
        continue;
      }
      throw error;
    }
  }
}
