import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AnalysisReport } from "@groundskeeper/contracts";
import { type Prisma, PrismaClient, storeAnalysisRun } from "@groundskeeper/database";
import { extractClaims } from "@groundskeeper/parser";
import { Probot } from "probot";
import { analyzeLocally } from "./analysis.js";
import { publishAnalysisCheck } from "./check-run.js";
import { CommandInputError } from "./command-errors.js";
import { loadPrivateKey } from "./credentials.js";
import { workspaceRoot } from "./environment.js";
import { analyzePullRequest } from "./pr-analysis.js";
import { writeImmutableJson } from "./repairs/artifacts.js";
import { GitHubSnapshots } from "./snapshots.js";

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      "installation-id": { type: "string" },
      "analysis-run": { type: "string" },
      "publish-check": { type: "boolean", default: false },
    },
  });
  const action = positionals[0];
  if (positionals.length !== 1 || !["analyze", "check"].includes(action ?? ""))
    throw new CommandInputError("Expected analyze or check action");
  const installation = values["installation-id"] ?? "";
  if (!/^[1-9]\d*$/.test(installation) || BigInt(installation) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new CommandInputError("Valid installation ID required");
  for (const key of ["DATABASE_URL", "APP_ID"])
    if (!process.env[key]) throw new CommandInputError(`Missing ${key}`);
  const appId = Number(process.env.APP_ID);
  if (!Number.isSafeInteger(appId) || appId < 1) throw new CommandInputError("Invalid App ID");
  const db = new PrismaClient();
  try {
    const installationId = BigInt(installation);
    const app = new Probot({ appId, privateKey: await loadPrivateKey(process.env, workspaceRoot) });
    const client = await app.auth(Number(installationId));
    const gateway = new GitHubSnapshots(client);
    let runId = values["analysis-run"];
    if (action === "analyze") {
      const fullName = values.repo ?? "",
        pullNumber = Number(values.pr);
      if (
        !/^[\w.-]+\/[\w.-]+$/.test(fullName) ||
        !Number.isSafeInteger(pullNumber) ||
        pullNumber < 1
      )
        throw new CommandInputError("Provide --repo owner/name and --pr number");
      const repository = await gateway.repository(fullName);
      const result = await analyzePullRequest(
        { fullName, pullNumber, installationId, repositoryId: BigInt(repository.githubId) },
        {
          client,
          gateway,
          parse: extractClaims,
          analyze: analyzeLocally,
          persist: async (input) => {
            // Pinned analysis input survives a database outage; replay the same PR to persist it.
            const artifact = {
              ...input,
              installationId: input.installationId.toString(),
              repository: { ...input.repository, githubId: input.repository.githubId.toString() },
            };
            const key = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
            console.log(
              `PR analysis artifact: ${await writeImmutableJson(join(workspaceRoot, ".groundskeeper/pr-analyses"), key, artifact)}`,
            );
            return storeAnalysisRun(db, {
              ...input,
              report: input.report as unknown as Prisma.InputJsonObject,
            });
          },
        },
      );
      runId = result.runId;
      console.log(`Stored PR analysis: ${runId} at ${result.headCommit}`);
    }
    if (!values["publish-check"]) {
      if (action === "check")
        throw new CommandInputError(
          "Use --publish-check to explicitly authorize a GitHub check write",
        );
      return;
    }
    if (!runId) throw new CommandInputError("Provide --analysis-run");
    const run = await db.analysisRun.findFirst({
      where: { id: runId, repository: { workspace: { installationId } } },
      include: { repository: true },
    });
    if (!run) throw new CommandInputError("Analysis not found in this installation");
    // Hold an advisory lock so normal concurrent invocations cannot post duplicate checks.
    const check = await db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`groundskeeper-check:${run.id}`}, 0)) AS locked`;
        if (!rows[0]?.locked)
          throw new CommandInputError("Another check publisher is active; retry later");
        return publishAnalysisCheck(client, {
          fullName: run.repository.fullName,
          repositoryId: Number(run.repository.githubId),
          appId,
          analysisRunId: run.id,
          afterCommit: run.afterCommit,
          report: run.report as unknown as AnalysisReport,
        });
      },
      { timeout: 180_000, maxWait: 5_000 },
    );
    console.log(`Informational GitHub check: ${check.url}`);
  } finally {
    await db.$disconnect();
  }
}
await main().catch((error) => {
  if (error instanceof CommandInputError) console.error(error.message);
  console.error(
    `PR analysis/check failed (${error instanceof Error ? error.name : "UnknownError"}). Saved analysis remains available; check configuration and permissions, then retry.`,
  );
  process.exitCode = 2;
});
