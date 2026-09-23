import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { setTeamMembership } from "./team-access.js";

// Operator-only: requires the database credential, never available through a web endpoint.
async function main() {
  const { values } = parseArgs({
    options: {
      action: { type: "string" },
      installation: { type: "string" },
      user: { type: "string" },
    },
    strict: true,
  });
  if (
    !["grant", "revoke"].includes(values.action ?? "") ||
    !/^[1-9]\d{0,18}$/.test(values.installation ?? "") ||
    !/^[1-9]\d{0,18}$/.test(values.user ?? "") ||
    !process.env.DATABASE_URL
  )
    throw new Error(
      "Usage: DATABASE_URL=… pnpm team:access --action grant|revoke --installation NUMERIC_ID --user GITHUB_NUMERIC_ID",
    );
  const db = new PrismaClient();
  try {
    await setTeamMembership(
      db,
      BigInt(values.installation as string),
      BigInt(values.user as string),
      values.action === "grant",
    );
    console.log(
      `Membership ${values.action === "grant" ? "granted" : "revoked, including all existing sessions"}.`,
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error(
    "Membership update failed. Check command arguments, database connectivity, and existing installation. No credentials were logged.",
  );
  process.exitCode = 1;
});
