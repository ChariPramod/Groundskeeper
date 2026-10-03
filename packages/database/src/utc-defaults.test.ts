import { randomInt, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, it } from "vitest";

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "database timestamp defaults record UTC in sessions west and east of UTC",
  async () => {
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("connection_limit", "1");
    const db = new PrismaClient({ datasourceUrl: url.toString() });
    const installationId = BigInt(randomInt(1, 2 ** 48 - 1));
    const id = `utc-defaults-${randomUUID()}`;
    try {
      for (const zone of ["America/Los_Angeles", "Asia/Kolkata"]) {
        await db.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
        const before = Date.now();
        const workspace = await db.workspace.create({ data: { installationId, account: "test" } });
        const delivery = await db.webhookDelivery.create({
          data: { id, installationId, event: "push", payload: {} },
        });
        const after = Date.now();
        for (const timestamp of [workspace.createdAt, delivery.receivedAt]) {
          expect(timestamp.getTime()).toBeGreaterThanOrEqual(before - 1000);
          expect(timestamp.getTime()).toBeLessThanOrEqual(after + 1000);
        }
        await db.webhookDelivery.delete({ where: { id } });
        await db.workspace.delete({ where: { installationId } });
      }
      const columns = await db.$queryRaw<
        { table_name: string; column_name: string; column_default: string }[]
      >`
        SELECT table_name, column_name, column_default FROM information_schema.columns
        WHERE table_schema = ${url.searchParams.get("schema") ?? "public"}
          AND data_type = 'timestamp without time zone' AND column_default IS NOT NULL`;
      expect(columns.map((column) => `${column.table_name}.${column.column_name}`).sort()).toEqual(
        [
          "Workspace.createdAt",
          "AnalysisRun.createdAt",
          "Page.indexedAt",
          "Evidence.createdAt",
          "WebhookDelivery.receivedAt",
          "VerificationRun.createdAt",
          "RepairPublication.createdAt",
          "TeamMember.createdAt",
          "TeamAccessEvent.createdAt",
          "TeamSession.createdAt",
          "SharedReviewEvent.createdAt",
        ].sort(),
      );
      for (const column of columns) expect(column.column_default).toContain("AT TIME ZONE 'UTC'");
    } finally {
      await db.webhookDelivery.deleteMany({ where: { id } });
      await db.workspace.deleteMany({ where: { installationId } });
      await db.$disconnect();
    }
  },
);
