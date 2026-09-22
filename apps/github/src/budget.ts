import type { ChangeBudget } from "@groundskeeper/contracts";

export const DEFAULT_BUDGET = { max_pages: 3, max_prs: 1, max_lines_changed: 150 } as const;
export interface ChangeUsage {
  pages: number;
  prs: number;
  linesChanged: number;
}

/** Pure preflight guard. Call with total run usage, including the proposed change. */
export function assertWithinBudget(
  usage: ChangeUsage,
  budget: ChangeBudget = DEFAULT_BUDGET,
): void {
  const limits = { ...DEFAULT_BUDGET, ...budget };
  for (const value of [...Object.values(usage), ...Object.values(limits)]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Budget values must be nonnegative integers");
  }
  if (usage.pages > limits.max_pages) throw new Error("Page budget exceeded");
  if (usage.prs > limits.max_prs) throw new Error("PR budget exceeded");
  if (usage.linesChanged > limits.max_lines_changed) throw new Error("Line budget exceeded");
}

export function assertReviewBranch(branch: string, defaultBranch: string): void {
  const normalize = (value: string) => value.replace(/^refs\/heads\//, "");
  if (!branch || !defaultBranch || normalize(branch) === normalize(defaultBranch)) {
    throw new Error("Groundskeeper never writes to a default branch");
  }
  if (!/^groundskeeper\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalize(branch))) {
    throw new Error("Changes must use a groundskeeper/<run-id> review branch");
  }
}
