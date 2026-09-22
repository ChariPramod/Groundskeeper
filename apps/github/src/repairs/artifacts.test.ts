import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readRepairArtifact, repairLineChanges, writeImmutableJson } from "./artifacts.js";

it("atomically stores artifacts without overwrites and permits identical retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "gk-repair-"));
  try {
    const key = "a".repeat(64);
    const paths = await Promise.all([
      writeImmutableJson(root, key, { safe: true }),
      writeImmutableJson(root, key, { safe: true }),
    ]);
    expect(paths[0]).toBe(paths[1]);
    await expect(writeImmutableJson(root, key, { safe: false })).rejects.toThrow("different data");
    expect(JSON.parse(await readFile(paths[0] as string, "utf8"))).toEqual({ safe: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects traversal, symlinks and corrupt artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gk-repair-"));
  try {
    await expect(readRepairArtifact(root, "../secret")).rejects.toThrow("SHA-256");
    const key = "a".repeat(64);
    await writeFile(join(root, "other.json"), "{}");
    await symlink(join(root, "other.json"), join(root, `${key}.json`));
    await expect(readRepairArtifact(root, key)).rejects.toThrow();
    const second = "b".repeat(64);
    await writeFile(join(root, `${second}.json`), "{}");
    await expect(readRepairArtifact(root, second)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("budgets additions and removals, including intervening lines conservatively", () => {
  expect(repairLineChanges([{ before: "a\nb\nc", after: "a\nx\nc" }])).toBe(2);
  expect(repairLineChanges([{ before: "a", after: "a" }])).toBe(0);
  expect(repairLineChanges([{ before: "a\nb\nc", after: "x\nb\ny" }])).toBe(6);
});

it("retains a blocked proposal as an inspectable fallback and detects later tampering", async () => {
  const { prepareRepair } = await import("./engine.js");
  const { saveRepairArtifact } = await import("./artifacts.js");
  const root = await mkdtemp(join(tmpdir(), "gk-blocked-"));
  try {
    const proposal = await prepareRepair(
      {
        analysis: {
          id: "fixture",
          installationId: "1",
          repositoryId: "2",
          fullName: "team/docs",
          defaultBranch: "main",
          baseCommit: "a".repeat(40),
          report: {
            schema_version: "1",
            claims: [],
            impacts: [],
            links: [],
            symbols: [],
            changed_symbol_ids: [],
            warnings: [],
            health: {
              total_claims: 0,
              linked_claims: 0,
              affected_claims: 0,
              link_coverage: 0,
              verified_share: 0,
              statuses: {},
            },
          },
        },
        files: [],
      },
      async () => {
        throw new Error("must not execute");
      },
    );
    expect(proposal.state).toBe("blocked");
    const saved = await saveRepairArtifact(root, proposal);
    expect(await readRepairArtifact(root, saved.digest)).toEqual(proposal);
    await writeFile(saved.path, JSON.stringify({ ...proposal, reasons: ["tampered"] }));
    await expect(readRepairArtifact(root, saved.digest)).rejects.toThrow("integrity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
