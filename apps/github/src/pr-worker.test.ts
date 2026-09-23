import { extractClaims } from "@groundskeeper/parser";
import { expect, it, vi } from "vitest";
import { analyzeLocally } from "./analysis.js";
import type { Delivery } from "./app.js";
import { processPullRequest } from "./pr-worker.js";
import type { WorkerDependencies } from "./worker.js";

function setup() {
  const delivery: Delivery = {
    id: "hook-1",
    event: "pull_request",
    installationId: 1,
    repositoryId: 2,
    payload: {
      action: "synchronize",
      number: 3,
      full_name: "team/docs",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
    },
  };
  const pull = {
    number: 3,
    state: "open",
    base: { sha: "a".repeat(40), repo: { id: 2 } },
    head: { sha: "b".repeat(40), repo: { id: 2 } },
  };
  const request = vi.fn(async (route: string) => ({
    data: route.includes("/compare/")
      ? { base_commit: { sha: pull.base.sha }, merge_base_commit: { sha: "c".repeat(40) } }
      : pull,
  }));
  const order: string[] = [];
  const persist = vi.fn(async (_input: Parameters<WorkerDependencies["persist"]>[0]) => {
    order.push("persist");
  });
  const acknowledge = vi.fn(async (_id: string) => {
    order.push("ack");
  });
  const snapshot = vi.fn(async (_name: string, sha: string) => [
    { path: "guide.md", content: "Use `send`." },
    {
      path: "client.py",
      content: sha.startsWith("c") ? "def send(): pass" : "def deliver(): pass",
    },
  ]);
  const dependencies = {
    client: vi.fn(async () => ({ request })),
    gateway: vi.fn(async () => ({
      repository: async () => ({
        githubId: 2,
        fullName: "team/docs",
        account: "team",
        defaultBranch: "main",
      }),
      snapshot,
    })),
    parse: extractClaims,
    analyze: vi.fn(analyzeLocally),
    persist,
    acknowledge,
    completed: vi.fn(async () => false),
  };
  return { delivery, pull, dependencies, order, snapshot, request };
}
it("analyzes the pinned merge base and head under the inbox delivery lease identity", async () => {
  const { delivery, dependencies, order, snapshot } = setup();
  expect(await processPullRequest(delivery, dependencies)).toBe("analyzed");
  expect(order).toEqual(["persist", "ack"]);
  expect(snapshot).toHaveBeenCalledWith("team/docs", "c".repeat(40));
  expect(snapshot).toHaveBeenCalledWith("team/docs", "b".repeat(40));
  expect(dependencies.persist).toHaveBeenCalledWith(
    expect.objectContaining({
      deliveryId: "hook-1",
      beforeCommit: "c".repeat(40),
      afterCommit: "b".repeat(40),
    }),
  );
});
it("reuses persisted analysis after acknowledgment failure without fetching GitHub again", async () => {
  const { delivery, dependencies } = setup();
  dependencies.acknowledge.mockRejectedValueOnce(new Error("lease lost"));
  await expect(processPullRequest(delivery, dependencies)).rejects.toThrow("lease lost");
  dependencies.completed.mockResolvedValue(true);
  dependencies.client.mockClear();
  dependencies.gateway.mockClear();
  expect(await processPullRequest(delivery, dependencies)).toBe("replayed");
  expect(dependencies.persist).toHaveBeenCalledOnce();
  expect(dependencies.client).not.toHaveBeenCalled();
  expect(dependencies.gateway).not.toHaveBeenCalled();
});
it.each(["closed", "fork", "superseded"])(
  "acknowledges %s PR without snapshots or analysis",
  async (reason) => {
    const { delivery, dependencies, pull, snapshot } = setup();
    if (reason === "closed") pull.state = "closed";
    if (reason === "fork") pull.head.repo.id = 99;
    if (reason === "superseded") pull.head.sha = "d".repeat(40);
    expect(await processPullRequest(delivery, dependencies)).toBe("ignored");
    expect(snapshot).not.toHaveBeenCalled();
    expect(dependencies.persist).not.toHaveBeenCalled();
    expect(dependencies.acknowledge).toHaveBeenCalledOnce();
  },
);
it.each(["irrelevant", "legacy"])("acknowledges %s event without GitHub reads", async (reason) => {
  const { delivery, dependencies } = setup();
  if (reason === "irrelevant") delivery.payload.action = "labeled";
  else {
    delete delivery.payload.base_sha;
    delete delivery.payload.head_sha;
  }
  expect(await processPullRequest(delivery, dependencies)).toBe("ignored");
  expect(dependencies.client).not.toHaveBeenCalled();
});
it("does not acknowledge failed persistence", async () => {
  const { delivery, dependencies } = setup();
  dependencies.persist.mockRejectedValue(new Error("DB down"));
  await expect(processPullRequest(delivery, dependencies)).rejects.toThrow("DB down");
  expect(dependencies.acknowledge).not.toHaveBeenCalled();
});
it("does not acknowledge network failures", async () => {
  const { delivery, dependencies, request } = setup();
  request.mockRejectedValue(new Error("network"));
  await expect(processPullRequest(delivery, dependencies)).rejects.toThrow("network");
  expect(dependencies.persist).not.toHaveBeenCalled();
  expect(dependencies.acknowledge).not.toHaveBeenCalled();
});
it("rejects malformed commit metadata without a snapshot fallback", async () => {
  const { delivery, dependencies } = setup();
  delivery.payload.head_sha = "short";
  await expect(processPullRequest(delivery, dependencies)).rejects.toThrow("commits");
  expect(dependencies.client).not.toHaveBeenCalled();
  expect(dependencies.acknowledge).not.toHaveBeenCalled();
});
