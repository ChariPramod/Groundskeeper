import { getDemoDashboard } from "./demo-data";
import type { RunReviewData } from "./review-types";
export function getDemoReview(id: string): RunReviewData | null {
  const run = getDemoDashboard().runs.find((r) => r.id === id);
  if (!run) return null;
  return {
    id,
    mode: "demo",
    repository: run.repository.fullName,
    beforeCommit: run.beforeCommit,
    afterCommit: run.afterCommit,
    totalClaims: run.totalClaims,
    truncated: true,
    findings: run.evidence.map((e, index) => ({
      id: e.id,
      page: index === 0 ? "docs/quickstart.md" : "docs/tutorial.md",
      line: 12 + index * 10,
      text:
        id === "run-1042" && index === 0
          ? "from acme import Client\nclient = Client(timeout=30)"
          : `# Illustrative documentation excerpt\n# ${e.label}`,
      impact: e.status === "failed" ? e.detail : null,
      symbols:
        e.status === "failed" ? [{ name: "Client.__init__", path: "src/acme/client.py" }] : [],
      execution: { status: e.status, reason: e.detail },
    })),
  };
}
