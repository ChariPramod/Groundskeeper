import { createHash } from "node:crypto";
import type { GitHubReader } from "../snapshots.js";

export interface PublishableRepair {
  id: string;
  fullName: string;
  repositoryId: string;
  installationId: string;
  baseCommit: string;
  defaultBranch: string;
  files: { path: string; before: string; after: string }[];
  summary: string;
  analysisRunId: string;
  verification: { id: string; outcomes: unknown };
  state: "verified" | "blocked";
}
export interface PublishedRepair {
  url: string;
  number: number;
  branch: string;
  reused: boolean;
}
class PublicationError extends Error {}
function requireSafe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PublicationError(message);
}
const SHA = /^[a-f0-9]{40}$/;
function blob(text: string) {
  const bytes = Buffer.from(text);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
// Conservative bound: the entire region between the first and last changed lines counts.
function changedLines(before: string, after: string) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return endA + endB - 2 * start;
}
type Entry = { path: string; type: string; mode: string; sha: string };
type Commit = { sha: string; tree: { sha: string }; parents: { sha: string }[] };
type Pull = {
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
  head: { sha: string; ref: string; repo: { id: number } };
  base: { ref: string; repo: { id: number } };
};

/** Installation-authenticated client required. Never updates refs or merges a PR. */
export async function publishRepair(
  proposal: PublishableRepair,
  approval: string,
  client: GitHubReader,
  beforeWrite?: () => Promise<void>,
): Promise<PublishedRepair> {
  try {
    requireSafe(
      proposal.state === "verified" &&
        approval === proposal.id &&
        /^[a-f0-9]{64}$/.test(proposal.id),
      "Exact approval of a verified proposal is required",
    );
    requireSafe(
      SHA.test(proposal.baseCommit) && /^[\w.-]+\/[\w.-]+$/.test(proposal.fullName),
      "Invalid publication identity",
    );
    requireSafe(
      /^\d+$/.test(proposal.repositoryId) &&
        /^\d+$/.test(proposal.installationId) &&
        proposal.defaultBranch &&
        proposal.verification?.id &&
        proposal.analysisRunId,
      "Missing publication evidence",
    );
    requireSafe(
      proposal.files.length > 0 &&
        proposal.files.length <= 3 &&
        new Set(proposal.files.map((f) => f.path)).size === proposal.files.length,
      "Repair exceeds the three-page budget",
    );
    requireSafe(
      proposal.files.every(
        (f) =>
          /\.(md|mdx)$/i.test(f.path) &&
          !f.path.startsWith("/") &&
          !f.path.includes("\\") &&
          [...f.path].every((character) => character.charCodeAt(0) >= 32) &&
          f.path.split("/").every((p) => p && p !== "." && p !== ".." && p !== ".git") &&
          f.before !== f.after &&
          Buffer.byteLength(f.before) <= 1_000_000 &&
          Buffer.byteLength(f.after) <= 1_000_000,
      ),
      "Repair must modify existing bounded Markdown pages",
    );
    requireSafe(
      proposal.files.reduce((n, f) => n + changedLines(f.before, f.after), 0) <= 150,
      "Repair exceeds the 150-line budget",
    );
    const [owner, repo] = proposal.fullName.split("/");
    const branch = `groundskeeper/${proposal.id.slice(0, 32)}`;
    const deadline = Date.now() + 120_000;
    async function request<T>(route: string, parameters: Record<string, unknown> = {}): Promise<T> {
      const remaining = deadline - Date.now();
      requireSafe(remaining > 0, "Publication timed out; retry the same proposal to recover");
      if (route.startsWith("POST ")) await beforeWrite?.();
      return (
        await client.request(route, {
          owner,
          repo,
          ...parameters,
          request: { timeout: Math.min(15_000, remaining), signal: AbortSignal.timeout(remaining) },
        })
      ).data as T;
    }
    async function ref(name: string, optional = false): Promise<string | undefined> {
      try {
        const value = await request<{ object: { type: string; sha: string } }>(
          "GET /repos/{owner}/{repo}/git/ref/{ref}",
          { ref: `heads/${name}` },
        );
        requireSafe(
          value.object?.type === "commit" && SHA.test(value.object.sha),
          "Invalid branch reference",
        );
        return value.object.sha;
      } catch (error) {
        if (optional && (error as { status?: number }).status === 404) return undefined;
        throw error;
      }
    }
    const repository = await request<{ id: number; full_name: string; default_branch: string }>(
      "GET /repos/{owner}/{repo}",
    );
    requireSafe(
      String(repository.id) === proposal.repositoryId &&
        repository.full_name.toLowerCase() === proposal.fullName.toLowerCase() &&
        repository.default_branch === proposal.defaultBranch,
      "Repository identity or default branch changed",
    );
    async function checkBase() {
      requireSafe(
        (await ref(proposal.defaultBranch)) === proposal.baseCommit,
        "Default branch advanced; rebuild and reverify the proposal",
      );
    }
    await checkBase();
    async function commit(sha: string) {
      const value = await request<Commit>("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        commit_sha: sha,
      });
      requireSafe(
        value.sha === sha && SHA.test(value.tree?.sha) && Array.isArray(value.parents),
        "Invalid Git commit",
      );
      return value;
    }
    async function tree(sha: string) {
      const value = await request<{ sha: string; truncated: boolean; tree: Entry[] }>(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        { tree_sha: sha, recursive: "1" },
      );
      requireSafe(
        value.sha === sha &&
          value.truncated === false &&
          Array.isArray(value.tree) &&
          value.tree.length <= 100_000,
        "Cannot verify an incomplete repository tree",
      );
      const entries = new Map<string, Entry>();
      for (const entry of value.tree) {
        requireSafe(
          typeof entry.path === "string" &&
            typeof entry.mode === "string" &&
            ["blob", "tree", "commit"].includes(entry.type) &&
            SHA.test(entry.sha) &&
            !entries.has(entry.path),
          "Invalid repository tree entry",
        );
        entries.set(entry.path, entry);
      }
      return entries;
    }
    const base = await commit(proposal.baseCommit);
    const expected = await tree(base.tree.sha);
    for (const file of proposal.files) {
      const entry = expected.get(file.path);
      requireSafe(
        entry?.type === "blob" && entry.mode === "100644" && entry.sha === blob(file.before),
        "Approved source no longer matches the immutable base",
      );
      expected.set(file.path, { ...entry, sha: blob(file.after) });
    }
    async function verifyTree(sha: string) {
      const actual = await tree(sha);
      requireSafe(
        actual.size === expected.size &&
          [...expected].every(([path, entry]) => {
            const value = actual.get(path);
            return (
              value?.type === entry.type &&
              value.mode === entry.mode &&
              (entry.type === "tree" || value.sha === entry.sha)
            );
          }),
        "Repair branch contains changes outside the approved proposal",
      );
    }
    async function verifyCommit(sha: string) {
      const value = await commit(sha);
      requireSafe(
        value.parents.length === 1 && value.parents[0]?.sha === proposal.baseCommit,
        "Repair branch has an unexpected parent",
      );
      await verifyTree(value.tree.sha);
    }
    let head = await ref(branch, true);
    if (head) await verifyCommit(head);
    const pulls = await request<Pull[]>("GET /repos/{owner}/{repo}/pulls", {
      state: "all",
      head: `${owner}:${branch}`,
      base: proposal.defaultBranch,
      per_page: 100,
    });
    requireSafe(
      Array.isArray(pulls) && pulls.length <= 1,
      "Repair branch has ambiguous pull requests",
    );
    function result(pull: Pull, reused: boolean): PublishedRepair {
      requireSafe(
        pull.head?.ref === branch &&
          pull.base?.ref === proposal.defaultBranch &&
          String(pull.head.repo?.id) === proposal.repositoryId &&
          String(pull.base.repo?.id) === proposal.repositoryId &&
          pull.head.sha === head &&
          Number.isSafeInteger(pull.number) &&
          pull.number > 0 &&
          pull.html_url === `https://github.com/${repository.full_name}/pull/${pull.number}`,
        "Pull request does not match the approved repair",
      );
      requireSafe(
        pull.state === "closed" || pull.draft === true,
        "Existing pull request is no longer a draft; review it manually",
      );
      return { url: pull.html_url, number: pull.number, branch, reused };
    }
    if (pulls[0]) {
      requireSafe(head, "Existing pull request branch is missing; review it manually");
      return result(pulls[0], true);
    }
    if (!head) {
      const created = await request<{ sha: string }>("POST /repos/{owner}/{repo}/git/trees", {
        base_tree: base.tree.sha,
        tree: proposal.files.map((file) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          content: file.after,
        })),
      });
      requireSafe(SHA.test(created.sha), "Invalid created tree");
      await verifyTree(created.sha);
      const createdCommit = await request<{ sha: string }>(
        "POST /repos/{owner}/{repo}/git/commits",
        {
          message: `docs: verified repair ${proposal.id.slice(0, 12)}`,
          tree: created.sha,
          parents: [proposal.baseCommit],
        },
      );
      requireSafe(SHA.test(createdCommit.sha), "Invalid created commit");
      head = createdCommit.sha;
      await verifyCommit(head);
      await checkBase();
      await request("POST /repos/{owner}/{repo}/git/refs", {
        ref: `refs/heads/${branch}`,
        sha: head,
      });
    }
    await checkBase();
    requireSafe((await ref(branch)) === head, "Repair branch changed before publication");
    const pull = await request<Pull>("POST /repos/{owner}/{repo}/pulls", {
      title: "docs: repair verified documentation example",
      body: `Verified documentation repair.\n\nBase: ${proposal.baseCommit}\nAnalysis run: ${proposal.analysisRunId.replace(/[^\w-]/g, "").slice(0, 100)}\nVerification: ${proposal.verification.id.replace(/[^\w-]/g, "").slice(0, 100)}\nProposal: ${proposal.id}\n\nPlease review the diff and evidence before merging.`,
      head: branch,
      base: proposal.defaultBranch,
      draft: true,
      maintainer_can_modify: false,
    });
    return result(pull, false);
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    throw new PublicationError(
      "GitHub publication failed; check app permissions or connectivity, then retry the same proposal to recover. No default-branch write was requested.",
    );
  }
}
