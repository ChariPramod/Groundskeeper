import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Probot } from "probot";
import { describe, expect, it, vi } from "vitest";
import { createApp, type DeliveryStore } from "./app.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

async function setup(store: DeliveryStore) {
  const app = new Probot({ appId: 1, privateKey, secret: "test-secret", logLevel: "fatal" });
  await app.load(createApp(store));
  return app;
}

function push(ref = "refs/heads/main", deleted = false) {
  // The handler needs only routing fields; Probot receives the same JSON shape over HTTP.
  return {
    id: "delivery-1",
    name: "push",
    payload: {
      installation: { id: 42 },
      repository: { id: 7, full_name: "team/docs", default_branch: "main" },
      ref,
      deleted,
      before: "a".repeat(40),
      after: "b".repeat(40),
      commits: [{ message: "do not store full commit data" }],
    },
  } as Parameters<Probot["receive"]>[0];
}

describe("webhook ingress", () => {
  it("records default-branch pushes with only routing metadata", async () => {
    const save = vi.fn().mockResolvedValue(true);
    const app = await setup({ save });
    await app.receive(push());
    expect(save).toHaveBeenCalledWith({
      id: "delivery-1",
      event: "push",
      installationId: 42,
      repositoryId: 7,
      payload: {
        full_name: "team/docs",
        ref: "refs/heads/main",
        before: "a".repeat(40),
        after: "b".repeat(40),
      },
    });
  });

  it("ignores feature branches and deleted branches", async () => {
    const save = vi.fn();
    const app = await setup({ save });
    await app.receive(push("refs/heads/feature"));
    await app.receive(push("refs/heads/main", true));
    expect(save).not.toHaveBeenCalled();
  });

  it("propagates persistence failures instead of acknowledging lost events", async () => {
    const app = await setup({ save: vi.fn().mockRejectedValue(new Error("database unavailable")) });
    await expect(app.receive(push())).rejects.toThrow("database unavailable");
  });

  it("rejects an invalid HTTP signature before invoking the store", async () => {
    const save = vi.fn();
    const app = await setup({ save });
    const middleware = await app.getNodeMiddleware();
    const server = createServer(middleware);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/github/webhooks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        body: JSON.stringify(push().payload),
      });
      expect(response.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

it("stores PR commit identities without retaining bodies or source", async () => {
  const save = vi.fn().mockResolvedValue(true);
  const app = await setup({ save });
  await app.receive({
    id: "pr-delivery",
    name: "pull_request",
    payload: {
      installation: { id: 42 },
      repository: { id: 7, full_name: "team/docs" },
      action: "synchronize",
      number: 3,
      pull_request: {
        base: { sha: "a".repeat(40) },
        head: { sha: "b".repeat(40) },
        body: "private text",
      },
    },
  } as Parameters<Probot["receive"]>[0]);
  expect(save).toHaveBeenCalledWith({
    id: "pr-delivery",
    event: "pull_request",
    installationId: 42,
    repositoryId: 7,
    payload: {
      action: "synchronize",
      number: 3,
      full_name: "team/docs",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
    },
  });
});
