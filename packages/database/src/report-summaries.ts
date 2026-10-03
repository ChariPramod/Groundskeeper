export type EvidenceOutcome = "passed" | "failed" | "skipped" | "error";
export interface AnalysisSummary {
  version: 1;
  affectedClaims: number;
  totalClaims: number;
}
export interface VerificationSummary {
  version: 1;
  evidenceCount: number;
  outcomes: EvidenceOutcome[];
  allPassed: boolean;
  hasFailed: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const outcome = (value: unknown): value is EvidenceOutcome =>
  value === "passed" || value === "failed" || value === "skipped" || value === "error";

/** Unknown versions or malformed projections must never create a passing verdict. */
export function readAnalysisSummary(value: unknown): AnalysisSummary | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    !count(value.affectedClaims) ||
    !count(value.totalClaims)
  )
    return null;
  return { version: 1, affectedClaims: value.affectedClaims, totalClaims: value.totalClaims };
}
export function readVerificationSummary(value: unknown): VerificationSummary | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    !count(value.evidenceCount) ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length !== Math.min(value.evidenceCount, 100) ||
    !value.outcomes.every(outcome) ||
    typeof value.allPassed !== "boolean" ||
    typeof value.hasFailed !== "boolean"
  )
    return null;
  const visibleFailed = value.outcomes.includes("failed");
  const visiblePassed =
    value.outcomes.length > 0 && value.outcomes.every((item) => item === "passed");
  if (
    (visibleFailed && !value.hasFailed) ||
    (value.allPassed && (!visiblePassed || value.hasFailed)) ||
    (value.evidenceCount <= 100 &&
      (value.allPassed !== visiblePassed || value.hasFailed !== visibleFailed))
  )
    return null;
  return {
    version: 1,
    evidenceCount: value.evidenceCount,
    outcomes: [...value.outcomes],
    allPassed: value.allPassed,
    hasFailed: value.hasFailed,
  };
}
