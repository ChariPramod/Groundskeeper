import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AnalysisReport } from "@groundskeeper/contracts";
import { type Prisma, PrismaClient, storeVerificationRun } from "@groundskeeper/database";
import { Probot } from "probot";
import { loadPrivateKey } from "./credentials.js";
import { workspaceRoot } from "./environment.js";
import { writeImmutableJson } from "./repairs/artifacts.js";
import { GitHubSnapshots } from "./snapshots.js";
import { verifyLocally, verifyStoredRun } from "./verify-run.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "analysis-run": { type: "string" },
      "installation-id": { type: "string" },
      image: { type: "string", default: "python:3.12-slim" },
      "max-blocks": { type: "string", default: "10" },
    },
  });
  if (
    !values["analysis-run"] ||
    !values["installation-id"] ||
    !/^\d+$/.test(values["installation-id"])
  ) {
    throw new Error(
      "Usage: pnpm verify:run --analysis-run <id> --installation-id <id> [--image <image>]",
    );
  }
  for (const key of ["DATABASE_URL", "APP_ID"]) {
    if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  const database = new PrismaClient();
  const app = new Probot({
    appId: process.env.APP_ID,
    privateKey: await loadPrivateKey(process.env, workspaceRoot),
  });
  try {
    const report = await verifyStoredRun(
      values["analysis-run"],
      BigInt(values["installation-id"]),
      {
        image: values.image ?? "python:3.12-slim",
        maxBlocks: Number(values["max-blocks"]),
      },
      {
        load: async (id, installationId) => {
          const run = await database.analysisRun.findFirst({
            where: { id, repository: { workspace: { installationId } } },
            include: { repository: { include: { workspace: true } } },
          });
          return run
            ? {
                id: run.id,
                installationId: run.repository.workspace.installationId,
                repositoryId: run.repository.githubId,
                fullName: run.repository.fullName,
                afterCommit: run.afterCommit,
                report: run.report as unknown as AnalysisReport,
              }
            : null;
        },
        gateway: async (installationId) => new GitHubSnapshots(await app.auth(installationId)),
        execute: verifyLocally,
        saveArtifact: async (report) => {
          if (!/^[a-f0-9]{32}$/.test(report.id)) throw new Error("Invalid evidence report ID");
          const digest = createHash("sha256")
            .update(`${JSON.stringify(report, null, 2)}\n`)
            .digest("hex");
          const path = await writeImmutableJson(
            join(workspaceRoot, ".groundskeeper/verifications"),
            digest,
            report,
          );
          console.log(`Evidence artifact: ${path}`);
          console.log(`Evidence SHA-256: ${digest}`);
          console.log(
            "Recovery: pnpm verify:import --analysis-run <same-analysis-id> --installation-id <same-installation-id> --artifact <path-above> --sha256 <digest-above>",
          );
        },
        persist: (input) =>
          storeVerificationRun(database, {
            ...input,
            report: input.report as unknown as Prisma.InputJsonObject,
          }),
      },
    );
    console.log(`Stored verification ${report.id}: ${JSON.stringify(report.outcomes)}`);
    process.exitCode = report.outcomes.error ? 2 : report.outcomes.failed ? 1 : 0;
  } catch (error) {
    console.error(
      `Verification failed (${error instanceof Error ? error.name : "UnknownError"}); no GitHub changes were made`,
    );
    process.exitCode = 2;
  } finally {
    await database.$disconnect();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Verification setup failed");
  process.exitCode = 2;
});
