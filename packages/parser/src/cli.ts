import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { Claim } from "@groundskeeper/contracts";
import { extractClaims } from "./index.js";

const { values } = parseArgs({ options: { root: { type: "string" } }, strict: true });
if (!values.root) throw new Error("Usage: pnpm index --root <docs-directory>");
const root = resolve(values.root);
const ignored = new Set(["node_modules", ".git", ".venv", "dist", ".groundskeeper"]);
const claims: Claim[] = [];
async function scan(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if ([".md", ".mdx"].includes(extname(entry.name).toLowerCase())) {
      claims.push(
        ...extractClaims(await readFile(path, "utf8"), relative(root, path).split(sep).join("/")),
      );
    }
  }
}
await scan(root);
process.stdout.write(`${JSON.stringify(claims, null, 2)}\n`);
