import "./environment.js";
import { parseArgs } from "node:util";
import { PrismaClient, retryFailedPush } from "@groundskeeper/database";

const { values } = parseArgs({
  options: {
    "installation-id": { type: "string" },
    "retry-failed": { type: "string" },
  },
});
if (!values["installation-id"] || !/^[1-9]\d*$/.test(values["installation-id"])) {
  throw new Error("Provide --installation-id with a positive installation ID");
}
if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
const installationId = BigInt(values["installation-id"]);
const database = new PrismaClient();
try {
  if (values["retry-failed"]) {
    const retried = await retryFailedPush(database, values["retry-failed"], installationId);
    console.log(
      retried
        ? "Terminal delivery returned to the queue"
        : "No matching terminal delivery was changed",
    );
    if (!retried) process.exitCode = 1;
  } else {
    const rows = await database.webhookDelivery.findMany({
      where: { installationId, event: "push", processedAt: null },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: 100,
      select: {
        id: true,
        attemptCount: true,
        receivedAt: true,
        nextAttemptAt: true,
        leaseExpiresAt: true,
        failedAt: true,
        lastError: true,
      },
    });
    console.log(JSON.stringify({ deliveries: rows, limit: 100 }, null, 2));
  }
} finally {
  await database.$disconnect();
}
