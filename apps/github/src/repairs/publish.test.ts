import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type PublishableRepair, publishRepair } from "./publish.js";

const base = "a".repeat(40),
  baseTree = "b".repeat(40),
  newTree = "c".repeat(40),
  head = "d".repeat(40);
const proposal: PublishableRepair = {
  id: "f".repeat(64),
  fullName: "acme/sdk",
  repositoryId: "1",
  installationId: "2",
  baseCommit: base,
  defaultBranch: "main",
  files: [{ path: "README.md", before: "old\n", after: "new\n" }],
  summary: "secret output should not be published",
  analysisRunId: "analysis1",
  verification: { id: "verification1", outcomes: [] },
  state: "verified",
};
const branch = `groundskeeper/${proposal.id.slice(0, 32)}`;
function hash(text: string) {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");
}
function fake() {
  const calls: { route: string; params: Record<string, unknown> }[] = [];
  const state = {
    branch: false,
    pull: false,
    closed: false,
    advanced: false,
    badTree: false,
    badParent: false,
    truncated: false,
    wrongSource: false,
    wrongRepo: false,
    advanceAfterTree: false,
    wrongPullUrl: false,
    failAfterPull: false,
    denied: false,
  };
  const pull = () => ({
    number: 3,
    html_url: state.wrongPullUrl
      ? "https://evil.example/pull/3"
      : "https://github.com/acme/sdk/pull/3",
    draft: true,
    state: state.closed ? "closed" : "open",
    head: { sha: head, ref: branch, repo: { id: 1 } },
    base: { ref: "main", repo: { id: 1 } },
  });
  return {
    state,
    calls,
    async request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }> {
      calls.push({ route, params });
      if (state.denied) throw Object.assign(new Error("SECRET_TOKEN"), { status: 403 });
      if (route === "GET /repos/{owner}/{repo}")
        return {
          data: { id: state.wrongRepo ? 8 : 1, full_name: "acme/sdk", default_branch: "main" },
        };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        if (params.ref === "heads/main")
          return { data: { object: { type: "commit", sha: state.advanced ? head : base } } };
        if (!state.branch) throw Object.assign(new Error("missing"), { status: 404 });
        return { data: { object: { type: "commit", sha: head } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}")
        return {
          data: {
            sha: params.commit_sha,
            tree: { sha: params.commit_sha === base ? baseTree : newTree },
            parents: [{ sha: state.badParent ? head : base }],
          },
        };
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        const isBase = params.tree_sha === baseTree;
        return {
          data: {
            sha: params.tree_sha,
            truncated: state.truncated,
            tree: [
              {
                path: "README.md",
                type: "blob",
                mode: "100644",
                sha: hash(isBase ? (state.wrongSource ? "bad" : "old\n") : "new\n"),
              },
              ...(!isBase && state.badTree
                ? [{ path: "injected.py", type: "blob", mode: "100644", sha: base }]
                : []),
            ],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") return { data: state.pull ? [pull()] : [] };
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        if (state.advanceAfterTree) state.advanced = true;
        return { data: { sha: newTree } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/commits") return { data: { sha: head } };
      if (route === "POST /repos/{owner}/{repo}/git/refs") {
        state.branch = true;
        return { data: {} };
      }
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        state.pull = true;
        if (state.failAfterPull) {
          state.failAfterPull = false;
          throw new Error("connection lost after remote success");
        }
        return { data: pull() };
      }
      throw new Error(`Unexpected route ${route}`);
    },
  };
}
const writes = (client: ReturnType<typeof fake>) =>
  client.calls.filter((call) => call.route.startsWith("POST"));
describe("approved draft repair publication", () => {
  it("creates one bounded draft without default-branch updates and fences every mutation", async () => {
    const client = fake();
    let fences = 0;
    const result = await publishRepair(proposal, proposal.id, client, async () => {
      fences++;
    });
    expect(result).toEqual({
      url: "https://github.com/acme/sdk/pull/3",
      number: 3,
      branch,
      reused: false,
    });
    expect(fences).toBe(4);
    expect(writes(client).map((c) => c.route)).toEqual([
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
      "POST /repos/{owner}/{repo}/git/refs",
      "POST /repos/{owner}/{repo}/pulls",
    ]);
    expect(writes(client).at(-1)?.params).toMatchObject({
      draft: true,
      maintainer_can_modify: false,
      base: "main",
      head: branch,
    });
    expect(JSON.stringify(writes(client))).not.toContain(proposal.summary);
  });
  it("rejects blocked, unapproved, oversized, duplicate, and traversal proposals without API calls", async () => {
    const invalid: PublishableRepair[] = [
      { ...proposal, state: "blocked" },
      { ...proposal, files: Array(4).fill(proposal.files[0]) },
      { ...proposal, files: [{ path: "../a.md", before: "a", after: "b" }] },
      { ...proposal, files: [{ path: "a.md", before: "a", after: "b\n".repeat(151) }] },
    ];
    for (const item of invalid) {
      const client = fake();
      await expect(publishRepair(item, item.id, client)).rejects.toThrow();
      expect(client.calls).toHaveLength(0);
    }
    const client = fake();
    await expect(publishRepair(proposal, "different", client)).rejects.toThrow("approval");
    expect(client.calls).toHaveLength(0);
  });
  it.each(["advanced", "wrongSource", "wrongRepo", "truncated"] as const)(
    "rejects %s before any mutation",
    async (flag) => {
      const client = fake();
      client.state[flag] = true;
      await expect(publishRepair(proposal, proposal.id, client)).rejects.toThrow();
      expect(writes(client)).toHaveLength(0);
    },
  );
  it.each(["badTree", "badParent"] as const)(
    "never overwrites a competing branch with %s",
    async (flag) => {
      const client = fake();
      client.state.branch = true;
      client.state[flag] = true;
      await expect(publishRepair(proposal, proposal.id, client)).rejects.toThrow();
      expect(writes(client)).toHaveLength(0);
    },
  );
  it("resumes after branch creation without creating another commit", async () => {
    const client = fake();
    client.state.branch = true;
    await publishRepair(proposal, proposal.id, client);
    expect(writes(client).map((c) => c.route)).toEqual(["POST /repos/{owner}/{repo}/pulls"]);
  });
  it("recovers a lost PR response without creating a second PR", async () => {
    const client = fake();
    client.state.failAfterPull = true;
    await expect(publishRepair(proposal, proposal.id, client)).rejects.toThrow(
      "retry the same proposal",
    );
    const count = writes(client).length;
    expect((await publishRepair(proposal, proposal.id, client)).reused).toBe(true);
    expect(writes(client)).toHaveLength(count);
  });
  it("returns the existing closed PR without recreating it", async () => {
    const client = fake();
    Object.assign(client.state, { branch: true, pull: true, closed: true });
    expect((await publishRepair(proposal, proposal.id, client)).reused).toBe(true);
    expect(writes(client)).toHaveLength(0);
  });
  it("stops when ownership is lost and sanitizes remote errors", async () => {
    const client = fake();
    await expect(
      publishRepair(proposal, proposal.id, client, async () => {
        throw new Error("lease lost SECRET");
      }),
    ).rejects.toThrow("publication failed");
    expect(writes(client)).toHaveLength(0);
    client.state.denied = true;
    await expect(publishRepair(proposal, proposal.id, client)).rejects.not.toThrow("SECRET_TOKEN");
  });
  it("leaves only unattached objects when the default branch advances before ref creation", async () => {
    const client = fake();
    client.state.advanceAfterTree = true;
    await expect(publishRepair(proposal, proposal.id, client)).rejects.toThrow("advanced");
    expect(writes(client).map((call) => call.route)).toEqual([
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
    ]);
    expect(client.state.branch).toBe(false);
  });
  it("rejects an arbitrary returned PR URL", async () => {
    const client = fake();
    Object.assign(client.state, { branch: true, pull: true, wrongPullUrl: true });
    await expect(publishRepair(proposal, proposal.id, client)).rejects.toThrow("does not match");
    expect(writes(client)).toHaveLength(0);
  });
});
