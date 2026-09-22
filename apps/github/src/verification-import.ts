import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { VerificationReport } from "@groundskeeper/contracts";
import { runPythonJson } from "./analysis.js";
import type { VerificationRunDependencies } from "./verify-run.js";

/** Check the exact saved bytes before interpreting them; never follow a file symlink. */
export async function readVerificationArtifact(path: string, sha256: string): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("A full artifact SHA-256 is required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32_000_000) throw new Error("Invalid evidence file");
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const bytes = buffer.subarray(0, total);
    if (total !== stat.size || createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("Evidence artifact integrity check failed");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await file.close();
  }
}

type Dependencies = Pick<VerificationRunDependencies, "load" | "gateway" | "persist">;

/** Reconcile saved evidence only; this path has no executor or GitHub write capability. */
export async function importVerification(
  analysisRunId: string,
  installationId: bigint,
  artifact: unknown,
  dependencies: Dependencies,
): Promise<unknown> {
  if (
    !analysisRunId.trim() ||
    installationId <= 0n ||
    installationId > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Invalid analysis identity");
  const run = await dependencies.load(analysisRunId, installationId);
  if (!run || run.id !== analysisRunId || run.installationId !== installationId)
    throw new Error("Analysis not found in this installation");
  if (!/^[a-f0-9]{40}$/.test(run.afterCommit) || /^0+$/.test(run.afterCommit))
    throw new Error("Invalid analysis commit");
  const gateway = await dependencies.gateway(Number(installationId));
  const repository = await gateway.repository(run.fullName);
  if (BigInt(repository.githubId) !== run.repositoryId) throw new Error("Repository mismatch");
  const sources = (await gateway.snapshot(repository.fullName, run.afterCommit)).filter((file) =>
    file.path.endsWith(".py"),
  );
  const validation = await runPythonJson<{ valid: boolean }>(
    "groundskeeper.verification_import",
    { analysis: run.report, sources, evidence_report: artifact },
    30_000,
  );
  if (validation.valid !== true) throw new Error("Evidence validation failed");
  return dependencies.persist({
    analysisRunId: run.id,
    installationId,
    repositoryId: run.repositoryId,
    afterCommit: run.afterCommit,
    // Preserve the exact artifact, including its original report ID and timestamps.
    report: artifact as VerificationReport,
  });
}
