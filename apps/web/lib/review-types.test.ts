import { expect, it } from "vitest";
import { getDemoReview } from "./review-demo";
import { isRunReviewData } from "./review-types";

it("rejects malformed review responses before rendering nested fields", () => {
  const valid = getDemoReview("run-1042");
  expect(isRunReviewData(valid)).toBe(true);
  expect(isRunReviewData({ ...valid, findings: [null] })).toBe(false);
  expect(
    isRunReviewData({ ...valid, findings: [{ ...valid?.findings[0], symbols: [null] }] }),
  ).toBe(false);
  expect(
    isRunReviewData({ ...valid, findings: [{ ...valid?.findings[0], execution: "passed" }] }),
  ).toBe(false);
  expect(isRunReviewData(null)).toBe(false);
});
