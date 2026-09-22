import { parseArgs } from "node:util";
import type { AnalysisReport } from "@groundskeeper/contracts";
import { type Prisma, PrismaClient, storeVerificationRun } from "@groundskeeper/database";
import { Probot } from "probot";
import { CommandInputError } from "./command-errors.js";
import { loadPrivateKey } from "./credentials.js";
import { workspaceRoot } from "./environment.js";
import { GitHubSnapshots } from "./snapshots.js";
import { importVerification, readVerificationArtifact } from "./verification-import.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "analysis-run": { type: "string" },
      "installation-id": { type: "string" },
      artifact: { type: "string" },
      sha256: { type: "string" },
    },
  });
  const id = values["analysis-run"],
    installation = values["installation-id"];
  if (
    !id ||
    !installation ||
    !/^[1-9]\d*$/.test(installation) ||
    BigInt(installation) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !values.artifact ||
    !values.sha256
  )
    throw new CommandInputError(
      "Usage: pnpm verify:import --analysis-run <id> --installation-id <id> --artifact <path> --sha256 <digest>",
    );
  const artifact = await readVerificationArtifact(values.artifact, values.sha256);
  for (const key of ["DATABASE_URL", "APP_ID"])
    if (!process.env[key]) throw new CommandInputError(`Missing ${key}`);
  const app = new Probot({
    appId: process.env.APP_ID,
    privateKey: await loadPrivateKey(process.env, workspaceRoot),
  });
  const database = new PrismaClient();
  try {
    const result = await importVerification(id, BigInt(installation), artifact, {
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
      persist: (input) =>
        storeVerificationRun(database, {
          ...input,
          report: input.report as unknown as Prisma.InputJsonObject,
        }),
    });
    console.log(`Evidence import complete: ${JSON.stringify(result)}`);
  } finally {
    await database.$disconnect();
  }
}
await main().catch((error: unknown) => {
  if (error instanceof CommandInputError) console.error(error.message);
  console.error(
    `Evidence import failed (${error instanceof Error ? error.name : "UnknownError"}). The artifact is unchanged; restore dependencies and retry the same import.`,
  );
  process.exitCode = 2;
});
