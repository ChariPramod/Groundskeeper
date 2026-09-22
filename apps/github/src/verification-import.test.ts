import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractClaims } from "@groundskeeper/parser";
import { expect, it, vi } from "vitest";
import { analyzeLocally } from "./analysis.js";
import { importVerification, readVerificationArtifact } from "./verification-import.js";
import { verifyLocally } from "./verify-run.js";

it("accepts exact artifact bytes and rejects tampering, malformed JSON and symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gk-import-"));
  try {
    const path = join(dir, "evidence.json");
    const body = '{"id":"saved"}\n';
    const digest = createHash("sha256").update(body).digest("hex");
    await writeFile(path, body);
    expect(await readVerificationArtifact(path, digest)).toEqual({ id: "saved" });
    await symlink(path, join(dir, "link"));
    await expect(readVerificationArtifact(join(dir, "link"), digest)).rejects.toThrow();
    await expect(readVerificationArtifact(path, "bad")).rejects.toThrow("SHA-256");
    await writeFile(path, `${body} `);
    await expect(readVerificationArtifact(path, digest)).rejects.toThrow("integrity");
    await writeFile(path, "{");
    await expect(
      readVerificationArtifact(path, createHash("sha256").update("{").digest("hex")),
    ).rejects.toThrow();
    await expect(readVerificationArtifact(dir, digest)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const sources = [{ path: "client.py", content: "def deliver(): pass" }];
  const analysis = await analyzeLocally({
    claims: extractClaims("```python groundskeeper:run\nsend()\n```", "README.md"),
    before: [{ path: "client.py", content: "def send(): pass" }],
    after: sources,
  });
  const report = await verifyLocally({
    analysis,
    sources,
    image: "python:3.12-slim",
    limits: { max_blocks: 0, timeout_seconds: 10 },
  });
  const snapshot = vi.fn().mockResolvedValue(sources);
  const persist = vi.fn().mockResolvedValue({ runId: report.id, created: true });
  const dependencies = {
    load: vi.fn().mockResolvedValue({
      id: "analysis",
      installationId: 42n,
      repositoryId: 7n,
      fullName: "team/docs",
      afterCommit: "b".repeat(40),
      report: analysis,
    }),
    gateway: vi.fn().mockResolvedValue({
      repository: async () => ({ githubId: 7, fullName: "team/docs" }),
      snapshot,
    }),
    persist,
  };
  return { report, dependencies, snapshot };
}

it("imports real bridge evidence without rewriting its identity and supports retry after DB failure", async () => {
  const { report, dependencies, snapshot } = await fixture();
  dependencies.persist.mockRejectedValueOnce(new Error("DB unavailable"));
  await expect(importVerification("analysis", 42n, report, dependencies)).rejects.toThrow(
    "DB unavailable",
  );
  await importVerification("analysis", 42n, report, dependencies);
  expect(snapshot).toHaveBeenCalledWith("team/docs", "b".repeat(40));
  expect(dependencies.persist).toHaveBeenLastCalledWith(
    expect.objectContaining({ report, analysisRunId: "analysis", installationId: 42n }),
  );
  expect(dependencies.persist.mock.calls[1]?.[0].report).toBe(report);
});

it("rejects cross-installation import before GitHub reads", async () => {
  const { report, dependencies } = await fixture();
  await expect(importVerification("analysis", 43n, report, dependencies)).rejects.toThrow(
    "not found",
  );
  expect(dependencies.gateway).not.toHaveBeenCalled();
  expect(dependencies.persist).not.toHaveBeenCalled();
});

it("rejects a valid-shaped artifact for different source bytes before persistence", async () => {
  const { report, dependencies, snapshot } = await fixture();
  snapshot.mockResolvedValue([{ path: "client.py", content: "other" }]);
  await expect(importVerification("analysis", 42n, report, dependencies)).rejects.toThrow();
  expect(dependencies.persist).not.toHaveBeenCalled();
});

it("rejects malformed reports before persistence", async () => {
  const { dependencies } = await fixture();
  await expect(importVerification("analysis", 42n, { id: "bad" }, dependencies)).rejects.toThrow();
  expect(dependencies.persist).not.toHaveBeenCalled();
});
