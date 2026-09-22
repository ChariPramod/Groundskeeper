import { createHash } from "node:crypto";
import type { AnalysisReport, Claim, VerificationReport } from "@groundskeeper/contracts";
import { extractClaims } from "@groundskeeper/parser";
import type { VerificationInput } from "../verify-run.js";
import type { PrepareRepairInput, RepairProposal } from "./types.js";

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
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
/** Digest the entire artifact, including evidence. Store this separately from the artifact. */
export function repairArtifactDigest(proposal: RepairProposal): string {
  return hash(proposal);
}
/** Match Python snapshot serialization exactly (UTF-8, separators with spaces). */
export function repairSourceDigest(files: { path: string; content: string }[]): string {
  const serialized = `[${files
    .filter((f) => f.path.endsWith(".py"))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((f) => `[${JSON.stringify(f.path)}, ${JSON.stringify(f.content)}]`)
    .join(", ")}]`;
  return createHash("sha256").update(serialized).digest("hex");
}
export function validateRepairArtifact(p: RepairProposal): boolean {
  try {
    if (
      p?.version !== 1 ||
      !["blocked", "verified"].includes(p.state) ||
      !Array.isArray(p.files) ||
      p.files.length > 3 ||
      !Array.isArray(p.reasons) ||
      !p.reasons.every((r) => typeof r === "string" && r.length <= 1000)
    )
      return false;
    if (
      ![
        p.id,
        p.analysisRunId,
        p.installationId,
        p.repositoryId,
        p.fullName,
        p.baseCommit,
        p.defaultBranch,
        p.image,
        p.createdAt,
        p.summary,
      ].every((v) => typeof v === "string" && v.length <= 2000)
    )
      return false;
    if (
      !p.files.every(
        (f) =>
          f &&
          typeof f.path === "string" &&
          safePath(f.path) &&
          /\.mdx?$/i.test(f.path) &&
          typeof f.before === "string" &&
          typeof f.after === "string" &&
          Buffer.byteLength(f.before) <= 200_000 &&
          Buffer.byteLength(f.after) <= 200_000,
      ) ||
      p.id !== proposalId(p)
    )
      return false;
    if (p.state === "verified") return validateRepairProposal(p);
    return (
      p.reasons.length > 0 &&
      (p.baseline === null || typeof p.baseline === "object") &&
      (p.verification === null || typeof p.verification === "object")
    );
  } catch {
    return false;
  }
}
function proposalId(p: RepairProposal): string {
  return hash([
    p.version,
    p.analysisRunId,
    p.installationId,
    p.repositoryId,
    p.fullName,
    p.baseCommit,
    p.defaultBranch,
    p.image,
    p.files,
  ]);
}
function safePath(path: string): boolean {
  return (
    Boolean(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    Array.from(path).every((c) => c.charCodeAt(0) >= 32) &&
    path.split("/").every((part) => part !== ".." && part !== "." && part !== "")
  );
}
function codeClaims(source: string, path: string): Claim[] {
  return extractClaims(source, path).filter((c) => c.kind === "code");
}
function selectedAnalysis(report: AnalysisReport, claims: Claim[]): AnalysisReport {
  return {
    ...report,
    claims,
    links: [],
    impacts: claims.map((c) => ({
      claim_id: c.id,
      symbol_ids: [],
      reason: "Verify complete changed documentation page",
    })),
  };
}
function contract(c: Claim): unknown {
  return [
    c.id,
    c.page,
    c.text,
    c.language,
    c.runnable,
    c.session ?? null,
    c.expected_output ?? null,
    c.position,
  ];
}
function coverage(report: VerificationReport, claims: Claim[], image: string): boolean {
  const ids = new Set(claims.map((c) => c.id));
  return (
    ids.size > 0 &&
    report.image === image &&
    /^[a-f0-9]{64}$/.test(report.source_digest) &&
    report.claims.length === ids.size &&
    report.evidence.length === ids.size &&
    new Set(report.evidence.map((e) => e.claim_id)).size === ids.size &&
    report.claims.every((c) =>
      claims.some((original) => canonical(contract(original)) === canonical(contract(c))),
    ) &&
    report.evidence.every(
      (e) =>
        ids.has(e.claim_id) &&
        e.source_digest === report.source_digest &&
        /^[a-f0-9]{64}$/.test(e.claim_digest),
    )
  );
}
function imageIds(report: VerificationReport): string[] {
  return [
    ...new Set(
      report.evidence
        .filter((e) => e.outcome === "passed" || e.outcome === "failed")
        .map((e) => e.image_id ?? ""),
    ),
  ].sort();
}
function lineChanges(before: string, after: string): number {
  const a = before.split(/\r?\n/),
    b = after.split(/\r?\n/);
  let start = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < Math.min(a.length, b.length) - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return a.length + b.length - 2 * start - 2 * end;
}
/** Conservative output-only edit. Nested/indented fences are deliberately refused. */
function replaceOutput(source: string, claim: Claim, stdout: string): string {
  if (
    Buffer.byteLength(stdout) > 16_384 ||
    Array.from(stdout).some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))
  )
    throw new Error("Observed output exceeds the safe assertion format");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  let start = claim.position.end_line;
  while (lines[start]?.trim() === "") start++;
  const opening = lines[start]?.match(/^(`{3,}|~{3,})output\s*$/);
  if (!opening || claim.position.start_column !== 1)
    throw new Error("Output assertion fence is ambiguous or nested");
  const fence = opening[1] ?? "";
  let end = start + 1;
  while (
    end < lines.length &&
    !new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(lines[end] ?? "")
  )
    end++;
  if (
    end === lines.length ||
    lines.slice(start + 1, end).join("\n") !== claim.expected_output?.replace(/\r\n/g, "\n")
  )
    throw new Error("Output assertion does not match parsed claim");
  const actual = stdout.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const longest = Math.max(2, ...Array.from(actual.matchAll(/`+/g), (m) => m[0].length));
  const delimiter = "`".repeat(longest + 1);
  lines.splice(start, end - start + 1, `${delimiter}output`, ...actual.split("\n"), delimiter);
  return lines.join(newline);
}
export function validateRepairProposal(p: RepairProposal): boolean {
  try {
    if (
      p.version !== 1 ||
      p.id !== proposalId(p) ||
      p.state !== "verified" ||
      p.reasons.length ||
      !p.baseline ||
      !p.verification ||
      p.files.length < 1 ||
      p.files.length > 3
    )
      return false;
    if (
      !/^[a-f0-9]{40}$/i.test(p.baseCommit) ||
      /^0+$/.test(p.baseCommit) ||
      !/^[1-9]\d*$/.test(p.installationId) ||
      !/^[1-9]\d*$/.test(p.repositoryId)
    )
      return false;
    if (
      new Set(p.files.map((f) => f.path)).size !== p.files.length ||
      p.files.some(
        (f) =>
          !safePath(f.path) ||
          !/\.mdx?$/i.test(f.path) ||
          f.before === f.after ||
          Buffer.byteLength(f.after) > 200_000,
      ) ||
      p.files.reduce((n, f) => n + lineChanges(f.before, f.after), 0) > 150
    )
      return false;
    const before = p.files.flatMap((f) => codeClaims(f.before, f.path));
    const after = p.files.flatMap((f) => codeClaims(f.after, f.path));
    if (
      !metadataPreserved(before, after) ||
      !coverage(p.baseline, before, p.image) ||
      !coverage(p.verification, after, p.image) ||
      !p.baseline.evidence.some((e) => e.outcome === "failed")
    )
      return false;
    const images = imageIds(p.baseline);
    return (
      images.length === 1 &&
      Boolean(images[0]) &&
      canonical(images) === canonical(imageIds(p.verification)) &&
      p.baseline.source_digest === p.verification.source_digest &&
      p.verification.evidence.every(
        (e) => e.outcome === "passed" && e.status === "verified" && e.exit_code === 0,
      )
    );
  } catch {
    return false;
  }
}
function metadataPreserved(before: Claim[], after: Claim[]): boolean {
  return (
    before.length === after.length &&
    before.every((c, i) => {
      const next = after[i];
      return (
        next &&
        c.page === next.page &&
        c.language === next.language &&
        c.runnable === next.runnable &&
        (c.session ?? null) === (next.session ?? null) &&
        (c.expected_output == null ||
          (next.expected_output != null &&
            (!c.expected_output.trim() || Boolean(next.expected_output.trim()))))
      );
    })
  );
}

/** Produce a bounded draft; unavailable infrastructure always produces a blocked artifact. */
export async function prepareRepair(
  input: PrepareRepairInput,
  execute: (input: VerificationInput) => Promise<VerificationReport>,
): Promise<RepairProposal> {
  const identity = input.analysis;
  const p: RepairProposal = {
    version: 1,
    id: "",
    analysisRunId: identity.id,
    installationId: identity.installationId,
    repositoryId: identity.repositoryId,
    fullName: identity.fullName,
    baseCommit: identity.baseCommit,
    defaultBranch: identity.defaultBranch,
    image: input.image ?? "python:3.12-slim",
    createdAt: new Date().toISOString(),
    files: [],
    summary: "Documentation repair draft",
    baseline: null,
    verification: null,
    state: "blocked",
    reasons: [],
  };
  try {
    if (
      !/^[a-f0-9]{40}$/i.test(p.baseCommit) ||
      /^0+$/.test(p.baseCommit) ||
      !/^[1-9]\d*$/.test(p.installationId) ||
      !/^[1-9]\d*$/.test(p.repositoryId) ||
      !/^[\w.-]+\/[\w.-]+$/.test(p.fullName) ||
      !p.defaultBranch ||
      !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(p.image) ||
      !p.analysisRunId
    )
      throw new Error("Invalid pinned analysis identity");
    if (
      input.files.length > 1000 ||
      input.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 10_000_000 ||
      input.files.some((f) => !safePath(f.path)) ||
      new Set(input.files.map((f) => f.path)).size !== input.files.length
    )
      throw new Error("Invalid or oversized pinned snapshot");
    const affected = new Set(identity.report.impacts.map((i) => i.claim_id));
    const paths = input.replacements
      ? input.replacements.map((r) => r.path)
      : [
          ...new Set(
            identity.report.claims
              .filter((c) => c.kind === "code" && affected.has(c.id))
              .map((c) => c.page),
          ),
        ];
    if (
      !paths.length ||
      paths.length > 3 ||
      new Set(paths).size !== paths.length ||
      paths.some((path) => !/\.mdx?$/i.test(path))
    )
      throw new Error("Repair requires one to three existing Markdown pages");
    const pages = paths.map((path) => {
      const f = input.files.find((f) => f.path === path);
      if (!f || Buffer.byteLength(f.content) > 200_000)
        throw new Error("Documentation page missing or oversized");
      return f;
    });
    const before = pages.flatMap((f) => codeClaims(f.content, f.path));
    if (
      !before.length ||
      before.length > 10 ||
      before.some((c) => !c.runnable || !["py", "python"].includes(c.language ?? ""))
    )
      throw new Error("Every code block on changed pages must be opted-in supported Python");
    if (
      before.some(
        (c) =>
          !identity.report.claims.some(
            (original) => canonical(contract(c)) === canonical(contract(original)),
          ),
      )
    )
      throw new Error("Stored analysis does not match the pinned documentation snapshot");
    const run = async (claims: Claim[]) => {
      try {
        return await execute({
          analysis: selectedAnalysis(identity.report, claims),
          sources: input.files.filter((f) => f.path.endsWith(".py")),
          image: p.image,
          limits: { max_blocks: 10, timeout_seconds: 10 },
        });
      } catch {
        throw new Error(
          "Verification unavailable; restore the configured runtime and prepare the draft again",
        );
      }
    };
    p.baseline = await run(before);
    if (
      !coverage(p.baseline, before, p.image) ||
      p.baseline.source_digest !== repairSourceDigest(input.files) ||
      !p.baseline.evidence.some((e) => e.outcome === "failed")
    )
      throw new Error(
        "Baseline did not independently reproduce a documentation failure with complete evidence",
      );
    if (imageIds(p.baseline).length !== 1 || !imageIds(p.baseline)[0])
      throw new Error("Baseline runtime image identity is missing or inconsistent");
    for (const page of pages) {
      let after = input.replacements?.find((r) => r.path === page.path)?.after ?? page.content;
      if (!input.replacements) {
        for (const claim of before
          .filter((c) => c.page === page.path)
          .sort((a, b) => b.position.start_line - a.position.start_line)) {
          const evidence = p.baseline.evidence.find((e) => e.claim_id === claim.id);
          if (evidence?.outcome !== "failed") continue;
          if (
            evidence.exit_code !== 0 ||
            claim.expected_output == null ||
            typeof evidence.stdout !== "string" ||
            evidence.expected_output !== claim.expected_output
          )
            throw new Error(
              "Automatic repair only supports reproduced stdout assertion mismatches",
            );
          after = replaceOutput(after, claim, evidence.stdout);
        }
      }
      if (Buffer.byteLength(after) > 200_000)
        throw new Error("Replacement page exceeds the size budget");
      if (after !== page.content) p.files.push({ path: page.path, before: page.content, after });
    }
    if (
      !p.files.length ||
      p.files.length !== pages.length ||
      p.files.some((f) => Buffer.byteLength(f.after) > 200_000) ||
      p.files.reduce((n, f) => n + lineChanges(f.before, f.after), 0) > 150
    )
      throw new Error(
        "Repair is empty, leaves an unchanged selected page, or exceeds the change budget",
      );
    const after = p.files.flatMap((f) => codeClaims(f.after, f.path));
    if (!metadataPreserved(before, after))
      throw new Error(
        "Repair must preserve code blocks, opt-in, language, tutorial sessions, and assertions",
      );
    p.verification = await run(after);
    p.state = "verified";
    p.id = proposalId(p);
    if (!validateRepairProposal(p))
      throw new Error(
        "Reverification did not fully pass with the same source and runtime identity",
      );
    p.summary = `Verified repair of ${p.files.length} documentation page(s)`;
  } catch (error) {
    p.state = "blocked";
    p.reasons.push(
      error instanceof Error && !/docker|spawn|connection|ENOENT/i.test(error.message)
        ? error.message.slice(0, 240)
        : "Verification unavailable; restore the configured runtime and prepare the draft again",
    );
  }
  p.id = proposalId(p);
  return p;
}
