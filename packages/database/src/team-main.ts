import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { isTeamRole, setTeamMembership } from "./team-access.js";

// Operator-only: requires the database credential, never available through a web endpoint.
async function main() {
  const { values } = parseArgs({
    options: {
      action: { type: "string" },
      installation: { type: "string" },
      user: { type: "string" },
      role: { type: "string" },
    },
    strict: true,
  });
  if (
    !["grant", "revoke"].includes(values.action ?? "") ||
    !/^[1-9]\d{0,18}$/.test(values.installation ?? "") ||
    !/^[1-9]\d{0,18}$/.test(values.user ?? "") ||
    !process.env.DATABASE_URL ||
    (values.role !== undefined && (values.action !== "grant" || !isTeamRole(values.role)))
  )
    throw new Error(
      "Usage: DATABASE_URL=… pnpm team:access --action grant|revoke --installation NUMERIC_ID --user GITHUB_NUMERIC_ID [--role viewer|reviewer|admin (grant only; defaults to reviewer)]",
    );
  const db = new PrismaClient();
  try {
    await setTeamMembership(
      db,
      BigInt(values.installation as string),
      BigInt(values.user as string),
      values.action === "grant",
      isTeamRole(values.role) ? values.role : "reviewer",
    );
    console.log(
      values.action === "grant"
        ? `Membership granted with ${values.role ?? "reviewer"} role. Existing sessions use this role immediately.`
        : "Membership revoked, including all existing sessions.",
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
