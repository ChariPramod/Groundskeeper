export interface RepairReviewData {
  digest: string;
  proposalId: string;
  baseCommit: string;
  fullName: string;
  state: "blocked" | "verified";
  reasons: string[];
  summary: string;
  files: { path: string; before: string; after: string }[];
  baseline: Record<"passed" | "failed" | "skipped" | "error", number>;
  verification: Record<"passed" | "failed" | "skipped" | "error", number>;
}
export const demoRepairDigest = "d".repeat(64);
export function getDemoRepair(digest: string): RepairReviewData | null {
  if (digest !== demoRepairDigest) return null;
  return {
    digest,
    proposalId: "e".repeat(64),
    baseCommit: "a".repeat(40),
    fullName: "acme/python-sdk",
    state: "verified",
    reasons: [],
    summary: "Illustrative output assertion repair",
    files: [
      {
        path: "docs/quickstart.md",
        before: "```python groundskeeper:run\nprint(greet('Ada'))\n```\n```output\nHello Ada\n```",
        after: "```python groundskeeper:run\nprint(greet('Ada'))\n```\n```output\nHello, Ada!\n```",
      },
    ],
    baseline: { passed: 0, failed: 1, skipped: 0, error: 0 },
    verification: { passed: 1, failed: 0, skipped: 0, error: 0 },
  };
}
export function isRepairReviewData(value: unknown): value is RepairReviewData {
  if (!value || typeof value !== "object") return false;
  const d = value as RepairReviewData;
  const counts = (v: unknown) =>
    v &&
    typeof v === "object" &&
    ["passed", "failed", "skipped", "error"].every(
      (k) =>
        Number.isSafeInteger((v as Record<string, number>)[k]) &&
        ((v as Record<string, number>)[k] ?? -1) >= 0,
    );
  return (
    typeof d.digest === "string" &&
    /^[a-f0-9]{64}$/.test(d.digest) &&
    typeof d.proposalId === "string" &&
    /^[a-f0-9]{64}$/.test(d.proposalId) &&
    typeof d.baseCommit === "string" &&
    d.baseCommit.length <= 64 &&
    typeof d.fullName === "string" &&
    d.fullName.length <= 2000 &&
    ["blocked", "verified"].includes(d.state) &&
    typeof d.summary === "string" &&
    d.summary.length <= 2000 &&
    Array.isArray(d.reasons) &&
    d.reasons.length <= 100 &&
    d.reasons.every((r) => typeof r === "string" && r.length <= 1000) &&
    Array.isArray(d.files) &&
    d.files.length <= 3 &&
    d.files.every(
      (f) =>
        f &&
        typeof f.path === "string" &&
        f.path.length <= 2000 &&
        typeof f.before === "string" &&
        f.before.length <= 200000 &&
        typeof f.after === "string" &&
        f.after.length <= 200000,
    ) &&
    Boolean(counts(d.baseline)) &&
    Boolean(counts(d.verification))
  );
}
