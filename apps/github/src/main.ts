import { Prisma, PrismaClient } from "@groundskeeper/database";
import { run } from "probot";
import { createApp } from "./app.js";
import { loadPrivateKey } from "./credentials.js";
import { workspaceRoot } from "./environment.js";

for (const key of ["DATABASE_URL", "APP_ID", "WEBHOOK_SECRET"]) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}
process.env.PRIVATE_KEY = await loadPrivateKey(process.env, workspaceRoot);
const database = new PrismaClient();
await database.$connect();

await run(
  createApp({
    async save(delivery) {
      try {
        await database.webhookDelivery.create({
          data: {
            ...delivery,
            installationId: BigInt(delivery.installationId),
            repositoryId: delivery.repositoryId ? BigInt(delivery.repositoryId) : null,
            payload: delivery.payload as Prisma.InputJsonObject,
          },
        });
        return true;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return false;
        }
        throw error; // A failed persist must fail delivery so GitHub can redeliver it.
      }
    },
  }),
);
