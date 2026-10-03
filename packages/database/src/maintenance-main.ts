import "../../../apps/github/src/environment.js";
import { PrismaClient } from "@prisma/client";
import {
  MaintenanceInputError,
  maintainStorage,
  maintenanceDatabaseUrl,
  parseMaintenanceArgs,
} from "./maintenance.js";

async function main() {
  const options = parseMaintenanceArgs(process.argv.slice(2));
  const db = new PrismaClient({ datasourceUrl: maintenanceDatabaseUrl(process.env.DATABASE_URL) });
  try {
    console.log(JSON.stringify(await maintainStorage(db, options), null, 2));
  } finally {
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error(
    error instanceof MaintenanceInputError
      ? error.message
      : "Storage maintenance failed. Check database availability and migrations; no credentials were logged. A failed transaction rolls back session cleanup.",
  );
  process.exitCode = 1;
});
