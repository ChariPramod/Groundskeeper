import type { AnalysisReport, AnalysisRequest, Claim } from "@groundskeeper/contracts";
import type { Delivery } from "./app.js";

export interface RepositoryIdentity {
  githubId: number;
  fullName: string;
  defaultBranch: string;
  account: string;
}
export interface RepositoryFile {
  path: string;
  content: string;
}
export interface SnapshotGateway {
  repository(fullName: string): Promise<RepositoryIdentity>;
  snapshot(fullName: string, commit: string): Promise<RepositoryFile[]>;
}
export interface RunInput {
  deliveryId: string;
  installationId: bigint;
  account: string;
  repository: { githubId: bigint; fullName: string; defaultBranch: string };
  beforeCommit: string;
  afterCommit: string;
  report: AnalysisReport;
}
export interface WorkerDependencies {
  gateway(installationId: number): Promise<SnapshotGateway>;
  parse(source: string, path: string): Claim[];
  analyze(request: AnalysisRequest): Promise<AnalysisReport>;
  persist(input: RunInput): Promise<unknown>;
  acknowledge(deliveryId: string): Promise<void>;
  completed?(identity: {
    deliveryId: string;
    installationId: bigint;
    repositoryId: bigint;
    beforeCommit: string;
    afterCommit: string;
  }): Promise<boolean>;
}

const COMMIT = /^[0-9a-f]{40}$/i;

/** One replayable unit. The report is committed before its delivery is acknowledged. */
export async function processPush(
  delivery: Delivery,
  dependencies: WorkerDependencies,
): Promise<void> {
  if (delivery.event !== "push") throw new Error("This worker accepts push deliveries only");
  if (
    !Number.isSafeInteger(delivery.installationId) ||
    delivery.installationId <= 0 ||
    !Number.isSafeInteger(delivery.repositoryId) ||
    !delivery.repositoryId ||
    delivery.repositoryId <= 0
  ) {
    throw new Error("Invalid installation or repository identity");
  }
  const { full_name: fullName, before, after, ref } = delivery.payload;
  if (typeof fullName !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("Invalid repository name");
  }
  for (const commit of [before, after]) {
    if (typeof commit !== "string" || !COMMIT.test(commit) || /^0+$/.test(commit)) {
      throw new Error(
        "Push requires two nonzero, full commit SHAs; initial pushes need a full-index job",
      );
    }
  }
  const beforeCommit = (before as string).toLowerCase();
  const afterCommit = (after as string).toLowerCase();
  if (
    await dependencies.completed?.({
      deliveryId: delivery.id,
      installationId: BigInt(delivery.installationId),
      repositoryId: BigInt(delivery.repositoryId),
      beforeCommit,
      afterCommit,
    })
  ) {
    await dependencies.acknowledge(delivery.id);
    return;
  }
  const gateway = await dependencies.gateway(delivery.installationId);
  const repository = await gateway.repository(fullName);
  if (repository.githubId !== delivery.repositoryId)
    throw new Error("Repository identity mismatch");
  if (ref !== `refs/heads/${repository.defaultBranch}`) {
    throw new Error("Delivery no longer targets the repository's default branch");
  }
  const [oldFiles, newFiles] = await Promise.all([
    gateway.snapshot(repository.fullName, beforeCommit),
    gateway.snapshot(repository.fullName, afterCommit),
  ]);
  const source = (files: RepositoryFile[]) =>
    files.filter((file) => /\.(py|ts|tsx)$/.test(file.path));
  const claims = newFiles
    .filter((file) => /\.(md|mdx)$/i.test(file.path))
    .flatMap((file) => dependencies.parse(file.content, file.path));
  if (claims.length > 10_000) throw new Error("Claim limit exceeded");
  const report = await dependencies.analyze({
    claims,
    before: source(oldFiles),
    after: source(newFiles),
  });
  await dependencies.persist({
    deliveryId: delivery.id,
    installationId: BigInt(delivery.installationId),
    account: repository.account,
    repository: {
      githubId: BigInt(repository.githubId),
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
    },
    beforeCommit,
    afterCommit,
    report,
  });
  await dependencies.acknowledge(delivery.id);
}
