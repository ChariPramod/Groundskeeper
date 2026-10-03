import { describe, expect, it } from "vitest";
import { isTeamChangeResult, isTeamDirectory } from "./team-management-types";

const member = {
  githubUserId: "8",
  role: "viewer",
  lastKnownLogin: "alice",
  createdAt: "2026-10-03T12:00:00.000Z",
};
const event = {
  version: 1,
  actor: { source: "member", githubUserId: "7", login: "admin" },
  githubUserId: "8",
  previousRole: null,
  newRole: "viewer",
  createdAt: member.createdAt,
};
const directory = { version: 1, members: [member], events: [event], nextCursor: null };
describe("team response validation", () => {
  it("accepts bounded identities and keeps operator attribution distinct from members", () => {
    expect(isTeamDirectory(directory)).toBe(true);
    expect(
      isTeamDirectory({
        ...directory,
        events: [{ ...event, actor: { source: "operator", githubUserId: null, login: null } }],
      }),
    ).toBe(true);
    expect(isTeamDirectory({ ...directory, members: [{ ...member, lastKnownLogin: null }] })).toBe(
      true,
    );
  });
  it.each([
    null,
    [],
    {},
    { ...directory, members: Array(51).fill(member) },
    { ...directory, events: Array(21).fill(event) },
    { ...directory, version: Number.MAX_SAFE_INTEGER },
    { ...directory, nextCursor: "01" },
  ])("rejects unbounded or malformed directory %#", (value) => {
    expect(isTeamDirectory(value)).toBe(false);
  });
  it.each([
    { githubUserId: "9223372036854775808" },
    { githubUserId: 8 },
    { role: "owner" },
    { lastKnownLogin: "bad user" },
    { lastKnownLogin: undefined },
    { createdAt: "yesterday" },
    { createdAt: 123 },
  ])("rejects malformed member %#", (patch) => {
    expect(isTeamDirectory({ ...directory, members: [{ ...member, ...patch }] })).toBe(false);
  });
  it.each([
    { version: 0 },
    { version: 2 },
    { newRole: "owner" },
    { previousRole: undefined },
    { githubUserId: "0" },
    { actor: { source: "operator", githubUserId: "7", login: null } },
    { actor: { source: "operator", githubUserId: null, login: "forged" } },
    { actor: { source: "member", githubUserId: null, login: "missing-id" } },
    { actor: { source: "member", githubUserId: "7", login: null } },
    { actor: { source: "system", githubUserId: null, login: null } },
  ])("rejects untrustworthy audit identity or version %#", (patch) => {
    expect(isTeamDirectory({ ...directory, events: [{ ...event, ...patch }] })).toBe(false);
  });
  it("requires a bounded version and explicit mutation outcome", () => {
    expect(isTeamChangeResult({ version: 2147483647, changed: false })).toBe(true);
    for (const value of [
      null,
      {},
      { version: 2147483648, changed: true },
      { version: 1, changed: "true" },
      { version: 0.5, changed: false },
    ])
      expect(isTeamChangeResult(value)).toBe(false);
  });
});
