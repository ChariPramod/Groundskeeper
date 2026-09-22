import { extractClaims } from "@groundskeeper/parser";
import { expect, it, vi } from "vitest";
import { analyzeLocally } from "./analysis.js";
import { analyzePullRequest } from "./pr-analysis.js";
import type { RunInput } from "./worker.js";

const input = { fullName: "team/docs", installationId: 1n, repositoryId: 2n, pullNumber: 3 };
function setup() {
  const pull = {
    number: 3,
    state: "open",
    base: { sha: "a".repeat(40), repo: { id: 2 } },
    head: { sha: "b".repeat(40), repo: { id: 2 } },
  };
  const comparison = {
    base_commit: { sha: pull.base.sha },
    merge_base_commit: { sha: pull.base.sha },
  };
  return {
    pull,
    comparison,
    deps: {
      client: {
        request: vi.fn(async (route: string, _parameters: Record<string, unknown>) => ({
          data: route.includes("/compare/") ? comparison : pull,
        })),
      },
      gateway: {
        repository: async () => ({
          githubId: 2,
          fullName: "team/docs",
          defaultBranch: "main",
          account: "team",
        }),
        snapshot: vi.fn(async (_repo: string, sha: string) => [
          { path: "docs.md", content: "Use `send`." },
          {
            path: "client.py",
            content: sha.startsWith("a")
              ? "def send():\n    return 1\n"
              : "def deliver():\n    return 2\n",
          },
        ]),
      },
      parse: extractClaims,
      analyze: analyzeLocally,
      persist: vi.fn(async (_input: RunInput) => ({ runId: "run" })),
    },
  };
}
it("pins both sides of a PR and persists an idempotent scoped analysis", async () => {
  const { deps } = setup();
  const result = await analyzePullRequest(input, deps);
  expect(result.runId).toBe("run");
  expect(result.report.impacts.length).toBeGreaterThan(0);
  expect(deps.persist.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      deliveryId: expect.stringContaining("pull:1:2:3:"),
      beforeCommit: "a".repeat(40),
      afterCommit: "b".repeat(40),
    }),
  );
});
it("refuses closed or forked PRs before fetching snapshots", async () => {
  const { pull, deps } = setup();
  pull.head.repo.id = 999;
  await expect(analyzePullRequest(input, deps)).rejects.toThrow("same-repository");
  expect(deps.gateway.snapshot).not.toHaveBeenCalled();
  pull.head.repo.id = 2;
  pull.state = "closed";
  await expect(analyzePullRequest(input, deps)).rejects.toThrow("open");
});
it("does not persist when snapshot retrieval is incomplete", async () => {
  const { deps } = setup();
  deps.gateway.snapshot.mockRejectedValue(new Error("truncated"));
  await expect(analyzePullRequest(input, deps)).rejects.toThrow("truncated");
  expect(deps.persist).not.toHaveBeenCalled();
});

it("uses the merge base when unrelated target changes advanced the branch", async () => {
  const { deps, pull, comparison } = setup();
  pull.base.sha = "c".repeat(40);
  comparison.base_commit.sha = pull.base.sha;
  await analyzePullRequest(input, deps);
  expect(deps.gateway.snapshot.mock.calls).toEqual([
    ["team/docs", "a".repeat(40)],
    ["team/docs", "b".repeat(40)],
  ]);
  expect(deps.client.request).toHaveBeenCalledWith(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    expect.objectContaining({ basehead: `${pull.base.sha}...${pull.head.sha}` }),
  );
  expect(deps.persist.mock.calls[0]?.[0]).toMatchObject({
    beforeCommit: "a".repeat(40),
    deliveryId: `pull:1:2:3:${"a".repeat(40)}:${"b".repeat(40)}`,
  });
});
it.each(["main", "0".repeat(40), "a".repeat(39)])(
  "rejects invalid merge base %s before fetching or persisting",
  async (sha) => {
    const { deps, comparison } = setup();
    comparison.merge_base_commit.sha = sha;
    await expect(analyzePullRequest(input, deps)).rejects.toThrow("merge base");
    expect(deps.gateway.snapshot).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  },
);
it("rejects a comparison for the wrong base", async () => {
  const { deps, comparison } = setup();
  comparison.base_commit.sha = "c".repeat(40);
  await expect(analyzePullRequest(input, deps)).rejects.toThrow("merge base");
  expect(deps.gateway.snapshot).not.toHaveBeenCalled();
  expect(deps.persist).not.toHaveBeenCalled();
});
