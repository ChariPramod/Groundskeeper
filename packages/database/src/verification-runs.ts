import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

export interface StoreVerificationRunInput {
  analysisRunId: string;
  installationId: bigint;
  repositoryId: bigint;
  afterCommit: string;
  report: Prisma.InputJsonObject;
}

export class VerificationRunConflictError extends Error {
  constructor(id: string) {
    super(`Verification run ${id} already has a different result or identity`);
    this.name = "VerificationRunConflictError";
  }
}

export class VerificationRunOwnershipError extends Error {
  constructor() {
    super("Verification analysis run does not match the installation, repository, and commit");
    this.name = "VerificationRunOwnershipError";
  }
}

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
  throw new TypeError("Verification report must contain only JSON values");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sessionKey(claim: Record<string, unknown>): string | null {
  return typeof claim.session === "string" && claim.session.length > 0
    ? JSON.stringify([claim.page, claim.session])
    : null;
}

function validate(input: StoreVerificationRunInput): { id: string; sourceDigest: string } {
  const report = input.report;
  if (
    !input.analysisRunId.trim() ||
    input.installationId <= 0n ||
    input.repositoryId <= 0n ||
    !/^[a-f0-9]{40}$/i.test(input.afterCommit) ||
    /^0{40}$/.test(input.afterCommit)
  ) {
    throw new TypeError("Verification requires a valid analysis identity and full nonzero commit");
  }
  if (
    report.schema_version !== "1" ||
    typeof report.id !== "string" ||
    !report.id.trim() ||
    typeof report.source_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.source_digest) ||
    typeof report.created_at !== "string" ||
    !Number.isFinite(Date.parse(report.created_at)) ||
    typeof report.image !== "string" ||
    !report.image.trim() ||
    !Array.isArray(report.claims) ||
    !Array.isArray(report.evidence)
  ) {
    throw new TypeError("Invalid verification report structure");
  }
  for (const counts of [report.outcomes, report.statuses]) {
    if (
      !object(counts) ||
      Object.values(counts).some(
        (count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0,
      )
    ) {
      throw new TypeError("Invalid verification report counts");
    }
  }
  const ids = new Set<string>();
  for (const evidence of report.evidence) {
    if (
      !object(evidence) ||
      typeof evidence.id !== "string" ||
      !evidence.id.trim() ||
      ids.has(evidence.id) ||
      typeof evidence.claim_id !== "string" ||
      !evidence.claim_id.trim() ||
      evidence.source_digest !== report.source_digest ||
      !["passed", "failed", "error", "skipped"].includes(String(evidence.outcome))
    ) {
      throw new TypeError("Invalid verification evidence or source digest");
    }
    ids.add(evidence.id);
  }
  return { id: report.id, sourceDigest: report.source_digest };
}

function validateClaims(analysis: unknown, report: Prisma.InputJsonObject): void {
  if (!object(analysis) || !Array.isArray(analysis.claims) || !Array.isArray(analysis.impacts)) {
    throw new TypeError("Owning analysis report has no valid claims and impacts");
  }
  const impacted = new Set(analysis.impacts.filter(object).map((impact) => impact.claim_id));
  const codeClaims = analysis.claims.filter(object).filter((claim) => claim.kind === "code");
  const activeSessions = new Set(
    codeClaims
      .filter((claim) => impacted.has(claim.id))
      .map(sessionKey)
      .filter((key) => key !== null),
  );
  const allowed = new Map(
    codeClaims
      .filter((claim) => impacted.has(claim.id) || activeSessions.has(sessionKey(claim) ?? ""))
      .map((claim) => [claim.id, claim] as const),
  );
  const actualOutcomes: Record<string, number> = {};
  const actualStatuses: Record<string, number> = {};
  const selected = new Map<string, string>();
  for (const claim of report.claims as unknown[]) {
    if (
      !object(claim) ||
      typeof claim.id !== "string" ||
      !allowed.has(claim.id) ||
      selected.has(claim.id)
    ) {
      throw new TypeError("Verification claims must uniquely reference affected code claims");
    }
    if (!["unknown", "verified", "stale", "unverifiable"].includes(String(claim.status))) {
      throw new TypeError("Invalid verification claim status");
    }
    const original = allowed.get(claim.id);
    for (const field of [
      "page",
      "kind",
      "text",
      "language",
      "runnable",
      "expected_output",
      "session",
    ]) {
      const defaultValue = field === "runnable" ? false : null;
      if ((claim[field] ?? defaultValue) !== (original?.[field] ?? defaultValue)) {
        throw new TypeError(`Verification claim assertion differs from analysis: ${field}`);
      }
    }
    if (canonicalJson(claim.position ?? null) !== canonicalJson(original?.position ?? null)) {
      throw new TypeError("Verification claim assertion differs from analysis: position");
    }
    const status = String(claim.status);
    actualStatuses[status] = (actualStatuses[status] ?? 0) + 1;
    selected.set(claim.id, status);
  }
  const selectedSessions = new Set(
    [...allowed.values()].filter((claim) => selected.has(String(claim.id))).map(sessionKey),
  );
  for (const claim of allowed.values()) {
    const key = sessionKey(claim);
    if (key !== null && selectedSessions.has(key) && !selected.has(String(claim.id))) {
      throw new TypeError(
        "Verification must include every code claim in a selected tutorial session",
      );
    }
  }
  const evidenced = new Set<string>();
  for (const evidence of report.evidence as unknown[]) {
    if (
      !object(evidence) ||
      typeof evidence.claim_id !== "string" ||
      !selected.has(evidence.claim_id) ||
      evidenced.has(evidence.claim_id)
    ) {
      throw new TypeError(
        "Verification evidence must uniquely reference selected affected code claims",
      );
    }
    const outcome = String(evidence.outcome);
    const allowedStatuses: Record<string, string[]> = {
      passed: ["verified"],
      failed: ["stale"],
      error: ["unknown"],
      skipped: ["unknown", "unverifiable"],
    };
    if (
      evidence.status !== selected.get(evidence.claim_id) ||
      !allowedStatuses[outcome]?.includes(String(evidence.status))
    ) {
      throw new TypeError("Verification evidence status disagrees with its claim or outcome");
    }
    actualOutcomes[outcome] = (actualOutcomes[outcome] ?? 0) + 1;
    evidenced.add(evidence.claim_id);
  }
  for (const [provided, actual] of [
    [report.outcomes, actualOutcomes],
    [report.statuses, actualStatuses],
  ] as const) {
    const counts = provided as Record<string, number>;
    for (const key of new Set([...Object.keys(counts), ...Object.keys(actual)])) {
      if ((counts[key] ?? 0) !== (actual[key] ?? 0)) {
        throw new TypeError("Verification counts do not match claims and evidence");
      }
    }
  }
  if (selected.size !== evidenced.size) {
    throw new TypeError("Every selected verification claim requires evidence");
  }
}

/** Store immutable execution evidence against its owning, pinned analysis run. */
export async function storeVerificationRun(
  database: PrismaClient,
  input: StoreVerificationRunInput,
): Promise<{ runId: string; created: boolean }> {
  const { id, sourceDigest } = validate(input);
  const inputDigest = createHash("sha256")
    .update(
      canonicalJson({
        analysisRunId: input.analysisRunId,
        report: input.report,
      }),
    )
    .digest("hex");
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await database.$transaction(async (tx) => {
        const owner = await tx.analysisRun.findUnique({
          where: { id: input.analysisRunId },
          include: { repository: { include: { workspace: true } } },
        });
        if (
          !owner ||
          owner.afterCommit !== input.afterCommit.toLowerCase() ||
          owner.repository.githubId !== input.repositoryId ||
          owner.repository.workspace.installationId !== input.installationId
        ) {
          throw new VerificationRunOwnershipError();
        }
        validateClaims(owner.report, input.report);
        const existing = await tx.verificationRun.findUnique({ where: { id } });
        if (existing) {
          if (existing.inputDigest !== inputDigest) throw new VerificationRunConflictError(id);
          return { runId: id, created: false };
        }
        await tx.verificationRun.create({
          data: {
            id,
            analysisRunId: input.analysisRunId,
            sourceDigest,
            inputDigest,
            report: input.report,
          },
        });
        return { runId: id, created: true };
      });
    } catch (error) {
      if (
        attempt < 2 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2002" || error.code === "P2034")
      )
        continue;
      throw error;
    }
  }
}
