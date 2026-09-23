import type { Delivery } from "./app.js";
import { analyzePullRequest, PullRequestNotAnalyzableError } from "./pr-analysis.js";
import type { GitHubReader } from "./snapshots.js";
import type { WorkerDependencies } from "./worker.js";

/** Analyze an actionable, still-current PR delivery; never execute code or publish checks. */
export async function processPullRequest(
  delivery: Delivery,
  dependencies: WorkerDependencies & { client(installationId: number): Promise<GitHubReader> },
): Promise<"analyzed" | "replayed" | "ignored"> {
  if (delivery.event !== "pull_request") throw new Error("Expected pull request delivery");
  const { action, number, full_name: fullName, base_sha: base, head_sha: head } = delivery.payload;
  if (
    !Number.isSafeInteger(delivery.installationId) ||
    delivery.installationId <= 0 ||
    !Number.isSafeInteger(delivery.repositoryId) ||
    !delivery.repositoryId ||
    delivery.repositoryId <= 0
  )
    throw new Error("Invalid pull request installation or repository identity");
  if (
    !["opened", "synchronize", "reopened", "ready_for_review", "edited"].includes(String(action))
  ) {
    await dependencies.acknowledge(delivery.id);
    return "ignored";
  }
  if (
    typeof fullName !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(fullName) ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  )
    throw new Error("Invalid pull request routing metadata");
  // Older inbox rows lack commit identities. Do not analyze newer code as that old event.
  if (base === undefined && head === undefined) {
    await dependencies.acknowledge(delivery.id);
    return "ignored";
  }
  if (
    typeof base !== "string" ||
    typeof head !== "string" ||
    ![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha))
  )
    throw new Error("Invalid pinned pull request commits");
  if (
    await dependencies.completed?.({
      deliveryId: delivery.id,
      installationId: BigInt(delivery.installationId),
      repositoryId: BigInt(delivery.repositoryId),
      afterCommit: head,
    })
  ) {
    await dependencies.acknowledge(delivery.id);
    return "replayed";
  }
  try {
    await analyzePullRequest(
      {
        fullName,
        installationId: BigInt(delivery.installationId),
        repositoryId: BigInt(delivery.repositoryId),
        pullNumber: number,
        expectedCommits: { base, head },
      },
      {
        client: await dependencies.client(delivery.installationId),
        gateway: await dependencies.gateway(delivery.installationId),
        parse: dependencies.parse,
        analyze: dependencies.analyze,
        persist: async (input) => {
          // The inbox delivery owns the lease and replay identity, not the manual CLI's synthetic ID.
          await dependencies.persist({ ...input, deliveryId: delivery.id });
          return { runId: delivery.id };
        },
      },
    );
  } catch (error) {
    if (!(error instanceof PullRequestNotAnalyzableError)) throw error;
    await dependencies.acknowledge(delivery.id);
    return "ignored";
  }
  await dependencies.acknowledge(delivery.id);
  return "analyzed";
}
