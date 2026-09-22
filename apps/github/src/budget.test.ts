import { expect, it } from "vitest";
import { assertReviewBranch, assertWithinBudget } from "./budget.js";

it("enforces each run limit, permits exact limits and permits a zero budget", () => {
  expect(() => assertWithinBudget({ pages: 3, prs: 1, linesChanged: 150 })).not.toThrow();
  for (const usage of [
    { pages: 4, prs: 1, linesChanged: 150 },
    { pages: 3, prs: 2, linesChanged: 150 },
    { pages: 3, prs: 1, linesChanged: 151 },
    { pages: -1, prs: 0, linesChanged: 0 },
    { pages: Number.NaN, prs: 0, linesChanged: 0 },
  ])
    expect(() => assertWithinBudget(usage)).toThrow();
  expect(() =>
    assertWithinBudget(
      { pages: 0, prs: 0, linesChanged: 0 },
      { max_pages: 0, max_prs: 0, max_lines_changed: 0 },
    ),
  ).not.toThrow();
});

it("rejects default branch writes including fully qualified refs", () => {
  expect(() => assertReviewBranch("refs/heads/main", "main")).toThrow();
  expect(() => assertReviewBranch("groundskeeper/run-1", "groundskeeper/run-1")).toThrow();
  expect(() => assertReviewBranch("feature/changes", "main")).toThrow();
  expect(() => assertReviewBranch("groundskeeper/run-1", "main")).not.toThrow();
});
