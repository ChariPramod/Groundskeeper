export interface ReviewFinding {
  id: string;
  page: string;
  line: number;
  text: string;
  impact: string | null;
  symbols: { name: string; path: string }[];
  execution: { status: string; reason: string } | null;
}
export interface RunReviewData {
  id: string;
  mode: "demo" | "live";
  repository: string;
  beforeCommit: string;
  afterCommit: string;
  findings: ReviewFinding[];
  totalClaims: number;
  truncated: boolean;
}

/** Validate the network boundary before rendering nested response fields. */
export function isRunReviewData(value: unknown): value is RunReviewData {
  if (!value || typeof value !== "object") return false;
  const data = value as RunReviewData;
  return (
    typeof data.id === "string" &&
    ["live", "demo"].includes(data.mode) &&
    typeof data.repository === "string" &&
    typeof data.beforeCommit === "string" &&
    typeof data.afterCommit === "string" &&
    Number.isSafeInteger(data.totalClaims) &&
    data.totalClaims >= 0 &&
    typeof data.truncated === "boolean" &&
    Array.isArray(data.findings) &&
    data.findings.length <= 20 &&
    data.findings.every(
      (f) =>
        f &&
        typeof f.id === "string" &&
        typeof f.page === "string" &&
        Number.isSafeInteger(f.line) &&
        f.line > 0 &&
        typeof f.text === "string" &&
        f.text.length <= 4000 &&
        (f.impact === null || typeof f.impact === "string") &&
        Array.isArray(f.symbols) &&
        f.symbols.length <= 20 &&
        f.symbols.every((s) => s && typeof s.name === "string" && typeof s.path === "string") &&
        (f.execution === null ||
          (typeof f.execution === "object" &&
            ["passed", "failed", "skipped", "error"].includes(f.execution.status) &&
            typeof f.execution.reason === "string")),
    )
  );
}
