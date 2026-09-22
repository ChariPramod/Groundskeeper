import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { authorizeDashboard } from "./dashboard-data";
import { getDemoRepair, isRepairReviewData, type RepairReviewData } from "./repair-review-types";

// Mirrors repairs/engine.ts canonical serialization; the Next app deliberately avoids
// importing the CLI dependency graph. Contract tests guard the artifact digest format.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const artifactDigest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const MAX_BYTES = 32_000_000;
export async function readRepairFile(digest: string): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid artifact");
  const file = await open(
    resolve(process.cwd(), "../../.groundskeeper/repairs", `${digest}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid artifact");
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await file.read(bytes, total, bytes.length - total, total);
      if (!result.bytesRead) break;
      total += result.bytesRead;
    }
    if (total !== stat.size || total > MAX_BYTES) throw new Error("Invalid artifact");
    return JSON.parse(bytes.subarray(0, total).toString("utf8"));
  } finally {
    await file.close();
  }
}
export function mapRepairArtifact(
  raw: unknown,
  digest: string,
  installationId: bigint,
): RepairReviewData | null {
  const p = object(raw);
  if (
    p.installationId !== String(installationId) ||
    p.version !== 1 ||
    artifactDigest(raw) !== digest
  )
    return null;
  const summarize = (report: unknown) => {
    const counts = { passed: 0, failed: 0, skipped: 0, error: 0 };
    const evidence = object(report).evidence;
    if (Array.isArray(evidence))
      for (const e of evidence) {
        const outcome = object(e).outcome;
        if (
          outcome === "passed" ||
          outcome === "failed" ||
          outcome === "skipped" ||
          outcome === "error"
        )
          counts[outcome]++;
        else counts.error++;
      }
    return counts;
  };
  const result = {
    digest,
    proposalId: p.id,
    baseCommit: p.baseCommit,
    fullName: p.fullName,
    state: p.state,
    reasons: p.reasons,
    summary: p.summary,
    files: Array.isArray(p.files)
      ? p.files.map((f) => {
          const file = object(f);
          return { path: file.path, before: file.before, after: file.after };
        })
      : null,
    baseline: summarize(p.baseline),
    verification: summarize(p.verification),
  };
  if (
    !isRepairReviewData(result) ||
    result.files.some(
      (f) => Buffer.byteLength(f.before) > 200000 || Buffer.byteLength(f.after) > 200000,
    )
  )
    return null;
  return result;
}
export async function repairReviewResponse(
  request: Request,
  digest: string,
  env: Record<string, string | undefined> = process.env,
  read = readRepairFile,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store", Vary: "Authorization" };
  const response = (v: unknown, status = 200) => Response.json(v, { status, headers });
  if (!/^[a-f0-9]{64}$/.test(digest)) return response({ error: "Artifact not found." }, 404);
  if (!env.DASHBOARD_MODE || env.DASHBOARD_MODE === "demo") {
    const demo = getDemoRepair(digest);
    return demo ? response(demo) : response({ error: "Artifact not found." }, 404);
  }
  if (env.DASHBOARD_MODE !== "live")
    return response({ error: "Repair review is not configured." }, 503);
  const access = authorizeDashboard(request, env);
  if (access instanceof Response) return access;
  try {
    const artifact = mapRepairArtifact(await read(digest), digest, access.installationId);
    return artifact ? response(artifact) : response({ error: "Artifact not found." }, 404);
  } catch {
    return response(
      { error: "Artifact unavailable. Check its digest and local artifact directory, then retry." },
      404,
    );
  }
}
