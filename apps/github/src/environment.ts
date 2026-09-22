import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Every entrypoint uses the workspace .env, regardless of pnpm's package cwd.
// Existing exported variables retain precedence.
export const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
