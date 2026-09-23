import { parseArgs } from "node:util";
import {
  ackDelivery,
  claimNextDelivery,
  failDelivery,
  type Prisma,
  PrismaClient,
  PUSH_MAX_ATTEMPTS,
  storeAnalysisRun,
} from "@groundskeeper/database";
import { extractClaims } from "@groundskeeper/parser";
import { Probot } from "probot";
import { analyzeLocally } from "./analysis.js";
import { loadPrivateKey } from "./credentials.js";
import { workspaceRoot } from "./environment.js";
import { processPullRequest } from "./pr-worker.js";
import { GitHubSnapshots } from "./snapshots.js";
import { processPush, type WorkerDependencies } from "./worker.js";

const { values } = parseArgs({
  options: { limit: { type: "string", default: "5" }, event: { type: "string", default: "all" } },
});
if (values.event !== "push" && values.event !== "pull_request" && values.event !== "all")
  throw new Error("--event must be all, push or pull_request");
const selectedEvent = values.event;
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("--limit must be 1–20");
for (const key of ["DATABASE_URL", "APP_ID"]) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}
const app = new Probot({
  appId: process.env.APP_ID,
  privateKey: await loadPrivateKey(process.env, workspaceRoot),
});
const database = new PrismaClient();
try {
  let examined = 0;
  for (; examined < limit; examined += 1) {
    const delivery = await claimNextDelivery(database, selectedEvent);
    if (!delivery) break;
    if (delivery.event !== "push" && delivery.event !== "pull_request")
      throw new Error("Unsupported claimed event");
    const event = delivery.event;
    const token = delivery.leaseToken;
    if (!token) throw new Error("Claimed delivery has no lease token");
    try {
      const input = {
        id: delivery.id,
        event: delivery.event,
        installationId: Number(delivery.installationId),
        repositoryId: delivery.repositoryId === null ? undefined : Number(delivery.repositoryId),
        payload: delivery.payload as Record<string, unknown>,
      };
      const dependencies: WorkerDependencies = {
        gateway: async (installationId) => new GitHubSnapshots(await app.auth(installationId)),
        parse: extractClaims,
        analyze: analyzeLocally,
        completed: async (identity) => {
          const existing = await database.analysisRun.findUnique({
            where: { deliveryId: identity.deliveryId },
            include: { repository: { include: { workspace: true } } },
          });
          if (!existing) return false;
          if (
            existing.repository.githubId !== identity.repositoryId ||
            existing.repository.workspace.installationId !== identity.installationId ||
            (identity.beforeCommit !== undefined &&
              existing.beforeCommit !== identity.beforeCommit) ||
            existing.afterCommit !== identity.afterCommit
          ) {
            throw new Error("Stored delivery identity conflicts with pending delivery");
          }
          return true;
        },
        persist: async (input) => {
          const result = await storeAnalysisRun(
            database,
            {
              ...input,
              report: input.report as unknown as Prisma.InputJsonObject,
            },
            token,
            event,
          );
          console.log(`Analysis run: ${result.runId} (installation ${input.installationId})`);
          return result;
        },
        acknowledge: async (id) => {
          if (!(await ackDelivery(database, id, token, event))) {
            throw new Error("Delivery lease was lost before acknowledgment");
          }
        },
      };
      if (event === "push") await processPush(input, dependencies);
      else {
        const result = await processPullRequest(input, {
          ...dependencies,
          client: (id) => app.auth(id),
        });
        console.log(`Pull request delivery disposition: ${result}`);
      }
      console.log(`Processed ${event} ${delivery.id}`);
    } catch (error) {
      const recorded = await failDelivery(
        database,
        delivery.id,
        token,
        error instanceof Error ? error.name : "UnknownError",
        event,
      );
      // Avoid source-bearing error messages; operators can inspect queue metadata.
      console.error(
        `Delivery ${delivery.id} failed; ${
          recorded
            ? delivery.attemptCount >= PUSH_MAX_ATTEMPTS
              ? "attempt limit reached"
              : "retry scheduled"
            : "lease no longer owned; queue state unchanged"
        }`,
      );
      process.exitCode = 1;
    }
  }
  console.log(`Examined ${examined} claimed ${selectedEvent} deliveries`);
} finally {
  await database.$disconnect();
}
