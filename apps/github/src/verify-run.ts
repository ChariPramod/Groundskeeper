import type { AnalysisReport, VerificationReport } from "@groundskeeper/contracts";
import { runPythonJson } from "./analysis.js";
import type { RepositoryFile, SnapshotGateway } from "./worker.js";

export interface StoredAnalysis {
  id: string;
  installationId: bigint;
  repositoryId: bigint;
  fullName: string;
  afterCommit: string;
  report: AnalysisReport;
}
export interface VerificationOptions {
  image: string;
  maxBlocks: number;
}
export interface VerificationInput {
  analysis: AnalysisReport;
  sources: RepositoryFile[];
  image: string;
  limits: { max_blocks: number; timeout_seconds: number };
}
export interface VerificationRunDependencies {
  load(analysisRunId: string, installationId: bigint): Promise<StoredAnalysis | null>;
  gateway(installationId: number): Promise<SnapshotGateway>;
  execute(input: VerificationInput): Promise<VerificationReport>;
  persist(input: {
    analysisRunId: string;
    installationId: bigint;
    repositoryId: bigint;
    afterCommit: string;
    report: VerificationReport;
  }): Promise<unknown>;
  saveArtifact(report: VerificationReport): Promise<void>;
}

export function verifyLocally(input: VerificationInput): Promise<VerificationReport> {
  // Ten blocks at 10s plus 5s cleanup each, with margin for serialization/startup.
  return runPythonJson("groundskeeper.worker_verification", input, 180_000);
}

/** Explicitly verify a stored run. Push ingestion remains read-only analysis by default. */
export async function verifyStoredRun(
  analysisRunId: string,
  installationId: bigint,
  options: VerificationOptions,
  dependencies: VerificationRunDependencies,
): Promise<VerificationReport> {
  if (
    installationId <= 0n ||
    installationId > BigInt(Number.MAX_SAFE_INTEGER) ||
    !analysisRunId.trim()
  ) {
    throw new Error("Invalid analysis run or installation identity");
  }
  if (!Number.isInteger(options.maxBlocks) || options.maxBlocks < 0 || options.maxBlocks > 10) {
    throw new Error("--max-blocks must be 0–10");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(options.image))
    throw new Error("Invalid runtime image");
  const run = await dependencies.load(analysisRunId, installationId);
  if (!run || run.installationId !== installationId || run.id !== analysisRunId) {
    throw new Error("Analysis run not found in this installation");
  }
  if (!/^[a-f0-9]{40}$/i.test(run.afterCommit) || /^0+$/.test(run.afterCommit)) {
    throw new Error("Stored analysis does not identify a complete commit");
  }
  const gateway = await dependencies.gateway(Number(installationId));
  const repository = await gateway.repository(run.fullName);
  if (BigInt(repository.githubId) !== run.repositoryId)
    throw new Error("Repository identity mismatch");
  const files = await gateway.snapshot(repository.fullName, run.afterCommit);
  const report = await dependencies.execute({
    analysis: run.report,
    sources: files.filter((file) => file.path.endsWith(".py")),
    image: options.image,
    limits: { max_blocks: options.maxBlocks, timeout_seconds: 10 },
  });
  // Preserve evidence even if the database is temporarily unavailable.
  await dependencies.saveArtifact(report);
  await dependencies.persist({
    analysisRunId: run.id,
    installationId,
    repositoryId: run.repositoryId,
    afterCommit: run.afterCommit,
    report,
  });
  return report;
}
