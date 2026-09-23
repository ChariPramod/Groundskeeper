import type { AnalysisReport, AnalysisRequest, Claim } from "@groundskeeper/contracts";
import type { GitHubReader } from "./snapshots.js";
import type { RunInput, SnapshotGateway } from "./worker.js";

export interface PullAnalysisInput {
  fullName: string;
  installationId: bigint;
  repositoryId: bigint;
  pullNumber: number;
  expectedCommits?: { base: string; head: string };
}
export class PullRequestNotAnalyzableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestNotAnalyzableError";
  }
}
export async function analyzePullRequest(
  input: PullAnalysisInput,
  dependencies: {
    client: GitHubReader;
    gateway: SnapshotGateway;
    parse(source: string, page: string): Claim[];
    analyze(request: AnalysisRequest): Promise<AnalysisReport>;
    persist(input: RunInput): Promise<{ runId: string }>;
  },
): Promise<{ runId: string; report: AnalysisReport; headCommit: string }> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.fullName) ||
    input.installationId <= 0n ||
    input.repositoryId <= 0n ||
    !Number.isSafeInteger(input.pullNumber) ||
    input.pullNumber <= 0
  )
    throw new Error("Invalid pull request identity");
  const [owner, repo] = input.fullName.split("/");
  const repository = await dependencies.gateway.repository(input.fullName);
  if (BigInt(repository.githubId) !== input.repositoryId)
    throw new Error("Repository identity mismatch");
  const { data } = await dependencies.client.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { owner, repo, pull_number: input.pullNumber, request: { timeout: 15_000 } },
  );
  const pull = data as {
    number: number;
    state: string;
    base: { sha: string; repo: { id: number } };
    head: { sha: string; repo: { id: number } };
  };
  if (
    pull.number !== input.pullNumber ||
    pull.state !== "open" ||
    String(pull.base?.repo?.id) !== input.repositoryId.toString() ||
    String(pull.head?.repo?.id) !== input.repositoryId.toString()
  )
    throw new PullRequestNotAnalyzableError(
      "Only open same-repository pull requests are supported; forks require separate access handling",
    );
  if (
    input.expectedCommits &&
    (pull.base.sha !== input.expectedCommits.base || pull.head.sha !== input.expectedCommits.head)
  )
    throw new PullRequestNotAnalyzableError("Pull request delivery has been superseded");
  for (const sha of [pull.base.sha, pull.head.sha])
    if (!/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha))
      throw new Error("Pull request has invalid pinned commits");
  // A PR's target branch can advance independently. Diff the common ancestor
  // against the pinned head, not the latest target snapshot.
  const { data: comparisonData } = await dependencies.client.request(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    {
      owner,
      repo,
      basehead: `${pull.base.sha}...${pull.head.sha}`,
      per_page: 1,
      page: 1,
      request: { timeout: 15_000 },
    },
  );
  const comparison = comparisonData as {
    base_commit?: { sha?: string };
    merge_base_commit?: { sha?: string };
  };
  const beforeCommit = comparison?.merge_base_commit?.sha;
  if (
    comparison?.base_commit?.sha !== pull.base.sha ||
    typeof beforeCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(beforeCommit) ||
    /^0+$/.test(beforeCommit)
  )
    throw new Error("Pull request comparison has an invalid pinned merge base");
  const [before, after] = await Promise.all([
    dependencies.gateway.snapshot(input.fullName, beforeCommit),
    dependencies.gateway.snapshot(input.fullName, pull.head.sha),
  ]);
  const claims = after
    .filter((file) => /\.mdx?$/i.test(file.path))
    .flatMap((file) => dependencies.parse(file.content, file.path));
  if (claims.length > 10_000) throw new Error("Claim limit exceeded");
  const source = (files: typeof before) => files.filter((file) => /\.(py|ts|tsx)$/.test(file.path));
  const report = await dependencies.analyze({
    claims,
    before: source(before),
    after: source(after),
  });
  const stored = await dependencies.persist({
    deliveryId: `pull:${input.installationId}:${input.repositoryId}:${input.pullNumber}:${beforeCommit}:${pull.head.sha}`,
    installationId: input.installationId,
    account: repository.account,
    repository: {
      githubId: input.repositoryId,
      fullName: input.fullName,
      defaultBranch: repository.defaultBranch,
    },
    beforeCommit,
    afterCommit: pull.head.sha,
    report,
  });
  return { runId: stored.runId, report, headCommit: pull.head.sha };
}
