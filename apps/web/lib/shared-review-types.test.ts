import { expect, it } from "vitest";
import { isSharedReviewData } from "./shared-review-types";

const state = {
  runId: "run-1",
  version: 0,
  owner: "",
  note: "",
  dismissed: false,
  updatedAt: null,
  events: [],
};
it("accepts the empty persisted-state projection", () =>
  expect(isSharedReviewData(state)).toBe(true));
it.each([
  null,
  { ...state, version: -1 },
  { ...state, version: Number.MAX_SAFE_INTEGER + 1 },
  { ...state, owner: "a".repeat(101) },
  { ...state, note: "a".repeat(2001) },
  { ...state, dismissed: "false" },
  { ...state, updatedAt: "invalid" },
  { ...state, events: [null] },
  { ...state, events: Array(21).fill({}) },
])("rejects malformed shared review data", (value) =>
  expect(isSharedReviewData(value)).toBe(false),
);
it("accepts bounded audit data and rejects actor/version confusion", () => {
  const event = {
    version: 1,
    owner: "alice",
    note: "Reviewed",
    dismissed: true,
    actorGithubUserId: "7",
    actorLogin: "alice",
    createdAt: "2026-10-02T12:00:00Z",
  };
  expect(isSharedReviewData({ ...state, version: 1, events: [event] })).toBe(true);
  expect(
    isSharedReviewData({ ...state, version: 1, events: [{ ...event, actorGithubUserId: 7 }] }),
  ).toBe(false);
  expect(isSharedReviewData({ ...state, version: 1, events: [{ ...event, version: 2 }] })).toBe(
    false,
  );
});
