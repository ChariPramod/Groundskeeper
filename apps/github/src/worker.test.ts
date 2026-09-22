import { createHash } from "node:crypto";
import { extractClaims } from "@groundskeeper/parser";
import { expect, it, vi } from "vitest";
import { analyzeLocally } from "./analysis.js";
import { GitHubSnapshots } from "./snapshots.js";
import { processPush, type WorkerDependencies } from "./worker.js";

const commitResponse = { data: { sha: "a".repeat(40), tree: { sha: "d".repeat(40) } } };

const delivery = {
  id: "delivery-test",
  event: "push",
  installationId: 42,
  repositoryId: 7,
  payload: {
    full_name: "team/docs",
    before: "a".repeat(40),
    after: "b".repeat(40),
    ref: "refs/heads/main",
  },
};
function dependencies() {
  const order: string[] = [];
  const snapshot = vi.fn(async (_name: string, sha: string) => [
    { path: "README.md", content: "Call `send`." },
    {
      path: "client.py",
      content: sha.startsWith("a")
        ? "def send():\n    return 1\n"
        : "def deliver():\n    return 1\n",
    },
  ]);
  const deps: WorkerDependencies = {
    gateway: vi.fn(async () => ({
      repository: async () => ({
        githubId: 7,
        fullName: "team/docs",
        account: "team",
        defaultBranch: "main",
      }),
      snapshot,
    })),
    parse: extractClaims,
    analyze: analyzeLocally,
    persist: vi.fn(async () => {
      order.push("persist");
    }),
    acknowledge: vi.fn(async () => {
      order.push("ack");
    }),
  };
  return { deps, order, snapshot };
}

it("processes exact commits through the real parser/Python bridge and persists before ack", async () => {
  const { deps, order, snapshot } = dependencies();
  await processPush(delivery, deps);
  expect(order).toEqual(["persist", "ack"]);
  expect(snapshot.mock.calls.map((call) => call[1])).toEqual([
    delivery.payload.before,
    delivery.payload.after,
  ]);
  expect(deps.persist).toHaveBeenCalledWith(
    expect.objectContaining({
      installationId: 42n,
      repository: { githubId: 7n, fullName: "team/docs", defaultBranch: "main" },
      report: expect.objectContaining({ health: expect.objectContaining({ affected_claims: 1 }) }),
    }),
  );
});

it("never acknowledges a failed persistence, and retry replays the same input", async () => {
  const { deps } = dependencies();
  deps.persist = vi
    .fn()
    .mockRejectedValueOnce(new Error("database down"))
    .mockResolvedValue(undefined);
  await expect(processPush(delivery, deps)).rejects.toThrow("database down");
  expect(deps.acknowledge).not.toHaveBeenCalled();
  await processPush(delivery, deps);
  expect(deps.acknowledge).toHaveBeenCalledOnce();
  const calls = vi.mocked(deps.persist).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
});

it("acknowledges an existing matching run without network or reanalysis", async () => {
  const { deps, order } = dependencies();
  deps.completed = vi.fn().mockResolvedValue(true);
  await processPush(delivery, deps);
  expect(order).toEqual(["ack"]);
  expect(deps.gateway).not.toHaveBeenCalled();
  expect(deps.persist).not.toHaveBeenCalled();
});

it("does not acknowledge a conflicting stored identity", async () => {
  const { deps } = dependencies();
  deps.completed = vi.fn().mockRejectedValue(new Error("identity conflict"));
  await expect(processPush(delivery, deps)).rejects.toThrow("identity conflict");
  expect(deps.acknowledge).not.toHaveBeenCalled();
});

it("recovers a persisted result after lease loss without recomputing it", async () => {
  const { deps } = dependencies();
  let persisted = false;
  deps.completed = vi.fn(async () => persisted);
  deps.persist = vi.fn(async () => {
    persisted = true;
  });
  deps.acknowledge = vi
    .fn()
    .mockRejectedValueOnce(new Error("Lease lost"))
    .mockResolvedValue(undefined);
  await expect(processPush(delivery, deps)).rejects.toThrow("Lease lost");
  await processPush(delivery, deps);
  expect(deps.persist).toHaveBeenCalledOnce();
  expect(deps.gateway).toHaveBeenCalledOnce();
  expect(deps.acknowledge).toHaveBeenCalledTimes(2);
});

it("rejects ambiguous commits and tenant/repository mismatches before persistence", async () => {
  const { deps } = dependencies();
  await expect(
    processPush({ ...delivery, payload: { ...delivery.payload, before: "main" } }, deps),
  ).rejects.toThrow("commit SHAs");
  await expect(processPush({ ...delivery, repositoryId: 99 }, deps)).rejects.toThrow(
    "identity mismatch",
  );
  await expect(
    processPush({ ...delivery, payload: { ...delivery.payload, ref: "refs/heads/other" } }, deps),
  ).rejects.toThrow("default branch");
  expect(deps.persist).not.toHaveBeenCalled();
  expect(deps.acknowledge).not.toHaveBeenCalled();
});

it("fails closed on truncated trees", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(commitResponse)
    .mockResolvedValue({ data: { truncated: true, tree: [] } });
  await expect(
    new GitHubSnapshots({ request }).snapshot("team/docs", "a".repeat(40)),
  ).rejects.toThrow("incomplete tree");
  expect(request).toHaveBeenCalledTimes(2);
});

it("ignores symlinks/dependencies and reads bounded blobs by object ID", async () => {
  const sha = createHash("sha1").update("blob 5\0hello").digest("hex");
  const request = vi
    .fn()
    .mockResolvedValueOnce(commitResponse)
    .mockResolvedValueOnce({
      data: {
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", mode: "100644", sha, size: 5 },
          { path: "secret.py", type: "blob", mode: "120000", sha, size: 5 },
          { path: "node_modules/a.ts", type: "blob", mode: "100644", sha, size: 5 },
        ],
      },
    })
    .mockResolvedValueOnce({
      data: { encoding: "base64", content: Buffer.from("hello").toString("base64") },
    });
  const result = await new GitHubSnapshots({ request }).snapshot("team/docs", "a".repeat(40));
  expect(result).toEqual([{ path: "README.md", content: "hello" }]);
  expect(request.mock.calls[2]?.[1].file_sha).toBe(sha);
});

it("rejects oversized blobs before fetching their content", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(commitResponse)
    .mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", mode: "100644", sha: "c".repeat(40), size: 2_000_001 },
        ],
      },
    });
  await expect(
    new GitHubSnapshots({ request }).snapshot("team/docs", "a".repeat(40)),
  ).rejects.toThrow("oversized blob");
  expect(request).toHaveBeenCalledTimes(2);
});
