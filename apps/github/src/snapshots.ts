import { createHash } from "node:crypto";
import type { RepositoryFile, RepositoryIdentity, SnapshotGateway } from "./worker.js";

export interface GitHubReader {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}
type TreeEntry = { path?: string; type?: string; mode?: string; sha?: string; size?: number };
const IGNORE = new Set([".git", ".venv", "node_modules", "dist", ".groundskeeper", "__pycache__"]);

/** Fetch blobs, never clone/import code or extract an archive. Fail closed on partial trees. */
export class GitHubSnapshots implements SnapshotGateway {
  constructor(private readonly client: GitHubReader) {}

  private async read(route: string, parameters: Record<string, unknown>) {
    return this.client.request(route, { ...parameters, request: { timeout: 15_000 } });
  }

  async repository(fullName: string): Promise<RepositoryIdentity> {
    const [owner, repo] = fullName.split("/");
    const { data } = await this.read("GET /repos/{owner}/{repo}", { owner, repo });
    const item = data as {
      id: number;
      full_name: string;
      default_branch: string;
      owner: { login: string };
    };
    if (
      !Number.isSafeInteger(item.id) ||
      typeof item.full_name !== "string" ||
      typeof item.default_branch !== "string" ||
      typeof item.owner?.login !== "string"
    ) {
      throw new Error("GitHub returned invalid repository metadata");
    }
    return {
      githubId: item.id,
      fullName: item.full_name,
      defaultBranch: item.default_branch,
      account: item.owner.login,
    };
  }

  async snapshot(fullName: string, commit: string): Promise<RepositoryFile[]> {
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("Snapshot requires a full commit SHA");
    const [owner, repo] = fullName.split("/");
    const deadline = Date.now() + 120_000;
    const read = (route: string, parameters: Record<string, unknown>) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Snapshot exceeded two minutes");
      return this.client.request(route, {
        ...parameters,
        request: { timeout: Math.min(15_000, remaining), signal: AbortSignal.timeout(remaining) },
      });
    };
    const { data: commitData } = await read("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner,
      repo,
      commit_sha: commit,
    });
    const object = commitData as { sha?: string; tree?: { sha?: string } };
    if (
      object.sha?.toLowerCase() !== commit.toLowerCase() ||
      !object.tree?.sha ||
      !/^[0-9a-f]{40}$/i.test(object.tree.sha)
    )
      throw new Error("GitHub returned an invalid commit");
    const { data } = await read("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: object.tree.sha,
      recursive: "1",
    });
    const tree = data as { truncated?: boolean; tree?: TreeEntry[] };
    if (tree.truncated !== false || !Array.isArray(tree.tree))
      throw new Error("GitHub returned an incomplete tree");
    const entries = tree.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode !== "120000" &&
        entry.path &&
        /\.(md|mdx|py|ts|tsx)$/i.test(entry.path) &&
        !entry.path.split("/").some((part) => IGNORE.has(part)),
    );
    if (entries.length > 1000) throw new Error("Snapshot exceeds 1,000 files");
    const files: RepositoryFile[] = [];
    let total = 0;
    for (const entry of entries.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""))) {
      if (
        !entry.path ||
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path.split("/").some((part) => part === ".." || part === "." || !part) ||
        !entry.sha ||
        !/^[0-9a-f]{40}$/i.test(entry.sha)
      )
        throw new Error("Invalid tree entry");
      if (entry.size === undefined || entry.size > 2_000_000 || entry.size < 0)
        throw new Error("Invalid or oversized blob");
      if (total + entry.size > 10_000_000) throw new Error("Snapshot exceeds 10 MB");
      const { data: blobData } = await read("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner,
        repo,
        file_sha: entry.sha,
      });
      const blob = blobData as { encoding?: string; content?: string };
      if (
        blob.encoding !== "base64" ||
        typeof blob.content !== "string" ||
        blob.content.length > 2_800_000
      ) {
        throw new Error("Invalid blob encoding or size");
      }
      const bytes = Buffer.from(blob.content, "base64");
      total += bytes.length;
      if (bytes.length !== entry.size || bytes.length > 2_000_000 || total > 10_000_000)
        throw new Error("Blob size mismatch");
      const blobId = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (blobId !== entry.sha.toLowerCase())
        throw new Error("Blob content does not match its object ID");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      files.push({ path: entry.path, content });
    }
    return files;
  }
}
