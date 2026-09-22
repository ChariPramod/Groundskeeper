import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { repairArtifactDigest, validateRepairArtifact } from "./engine.js";
import type { RepairProposal } from "./types.js";

const MAX_BYTES = 32_000_000;
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);

/** Publish a complete file atomically without overwriting an existing artifact. */
export async function writeImmutableJson(
  directory: string,
  key: string,
  value: unknown,
): Promise<string> {
  if (!validKey(key)) throw new Error("Invalid artifact key");
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Artifact exceeds size limit");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${key}.json`);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(destination, "utf8")) !== body)
        throw new Error("Artifact key already contains different data");
    }
  } finally {
    await unlink(temporary);
  }
  return destination;
}
export async function saveRepairArtifact(directory: string, proposal: RepairProposal) {
  if (!validateRepairArtifact(proposal)) throw new Error("Invalid repair proposal");
  const digest = repairArtifactDigest(proposal);
  return { digest, path: await writeImmutableJson(directory, digest, proposal) };
}
export async function readRepairArtifact(
  directory: string,
  digest: string,
): Promise<RepairProposal> {
  if (!validKey(digest)) throw new Error("Artifact must be its full SHA-256 digest");
  const file = await open(
    join(directory, `${digest}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid repair artifact file");
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size || total > MAX_BYTES)
      throw new Error("Artifact changed while being read");
    const proposal = JSON.parse(bytes.subarray(0, total).toString("utf8")) as RepairProposal;
    if (!validateRepairArtifact(proposal) || repairArtifactDigest(proposal) !== digest)
      throw new Error("Artifact integrity check failed");
    return proposal;
  } finally {
    await file.close();
  }
}
export function repairLineChanges(files: { before: string; after: string }[]): number {
  return files.reduce((total, file) => {
    const before = file.before.split("\n"),
      after = file.after.split("\n");
    let start = 0,
      endA = before.length,
      endB = after.length;
    while (start < endA && start < endB && before[start] === after[start]) start++;
    while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
      endA--;
      endB--;
    }
    return total + endA + endB - 2 * start;
  }, 0);
}
