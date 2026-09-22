import type { VerificationReport } from "@groundskeeper/contracts";
import { extractClaims } from "@groundskeeper/parser";
import { describe, expect, it } from "vitest";
import type { VerificationInput } from "../verify-run.js";
import {
  prepareRepair,
  repairArtifactDigest,
  repairSourceDigest,
  validateRepairArtifact,
  validateRepairProposal,
} from "./engine.js";
import type { PrepareRepairInput } from "./types.js";

const page = '```python groundskeeper:run\nprint("new")\n```\n\n```output\nold\n```\n';
function input(content = page): PrepareRepairInput {
  const claims = extractClaims(content, "README.md");
  return {
    analysis: {
      id: "run",
      installationId: "1",
      repositoryId: "2",
      fullName: "a/b",
      baseCommit: "a".repeat(40),
      defaultBranch: "main",
      report: {
        claims,
        symbols: [],
        links: [],
        changed_symbol_ids: [],
        impacts: claims
          .filter((c) => c.kind === "code")
          .map((c) => ({ claim_id: c.id, symbol_ids: [], reason: "changed" })),
        health: {
          total_claims: claims.length,
          linked_claims: 0,
          affected_claims: 1,
          link_coverage: 0,
          verified_share: 0,
          statuses: {},
        },
        warnings: [],
      },
    },
    files: [{ path: "README.md", content }],
  };
}
function executor(stdout = "new\n", change?: (r: VerificationReport, n: number) => void) {
  let n = 0;
  return async (i: VerificationInput): Promise<VerificationReport> => {
    n++;
    const r: VerificationReport = {
      id: `v${n}`,
      created_at: new Date().toISOString(),
      source_digest: repairSourceDigest(i.sources),
      image: i.image,
      claims: i.analysis.claims,
      evidence: i.analysis.claims.map((c) => {
        const passed = c.expected_output === stdout.replace(/\n$/, "");
        return {
          id: c.id,
          claim_id: c.id,
          claim_digest: "b".repeat(64),
          source_digest: repairSourceDigest(i.sources),
          outcome: passed ? "passed" : "failed",
          status: passed ? "verified" : "stale",
          reason: "stdout",
          started_at: "",
          finished_at: "",
          image_id: "sha256:image",
          exit_code: 0,
          stdout,
          expected_output: c.expected_output,
          limits: {},
        };
      }),
      outcomes: {},
      statuses: {},
    };
    change?.(r, n);
    return r;
  };
}
describe("repair preparation", () => {
  it("reproduces, edits only output, reverifies, and detects artifact tampering", async () => {
    const p = await prepareRepair(input(), executor());
    expect(p.state).toBe("verified");
    expect(validateRepairProposal(p)).toBe(true);
    expect(p.files[0]?.after).toBe(page.replace("old", "new"));
    const digest = repairArtifactDigest(p);
    const file = p.files[0];
    if (!file) throw new Error("Missing fixture file");
    file.after += "tampered";
    expect(validateRepairProposal(p)).toBe(false);
    expect(repairArtifactDigest(p)).not.toBe(digest);
  });
  it("has deterministic content identity independent of evidence timestamp", async () => {
    expect((await prepareRepair(input(), executor())).id).toBe(
      (await prepareRepair(input(), executor())).id,
    );
  });
  it("preserves CRLF", async () => {
    const p = await prepareRepair(input(page.replace(/\n/g, "\r\n")), executor());
    expect(p.state).toBe("verified");
    expect(p.files[0]?.after).toContain("new\r\n");
  });
  it("escapes malicious fence-like output without adding executable blocks", async () => {
    const p = await prepareRepair(
      input(),
      executor("```\n```python groundskeeper:run\nevil()\n```\n"),
    );
    expect(p.state).toBe("verified");
    expect(
      extractClaims(p.files[0]?.after ?? "", "README.md").filter((c) => c.kind === "code"),
    ).toHaveLength(1);
  });
  it.each(["runtime", "coverage", "source", "image", "skipped"])(
    "blocks failed %s evidence",
    async (kind) => {
      const run = executor("new\n", (r, n) => {
        if (kind === "runtime") throw new Error("Docker unavailable");
        if (n === 2) {
          if (kind === "coverage") r.evidence = [];
          if (kind === "source") r.source_digest = "c".repeat(64);
          if (kind === "image" && r.evidence[0]) r.evidence[0].image_id = "different";
          if (kind === "skipped" && r.evidence[0]) r.evidence[0].outcome = "skipped";
        }
      });
      expect((await prepareRepair(input(), run)).state).toBe("blocked");
    },
  );
  it("requires independent failure reproduction", async () => {
    expect((await prepareRepair(input(page.replace("old", "new")), executor())).state).toBe(
      "blocked",
    );
  });
  it.each([
    page.replace(" groundskeeper:run", ""),
    page.replace("old", ""),
    page.replace(/```output[\s\S]*$/, ""),
    "Just prose",
    page.replace("python", "javascript"),
  ])("blocks manual weakening", async (after) => {
    const i = input();
    i.replacements = [{ path: "README.md", after }];
    expect((await prepareRepair(i, executor())).state).toBe("blocked");
  });
  it("supports explicit manual patches that preserve verification contracts", async () => {
    const i = input();
    i.replacements = [{ path: "README.md", after: page.replace("old", "new") }];
    expect((await prepareRepair(i, executor())).state).toBe("verified");
  });
  it("blocks unsupported neighboring code rather than ignoring it", async () => {
    expect(
      (await prepareRepair(input(`${page}\n\`\`\`bash\necho hello\n\`\`\``), executor())).state,
    ).toBe("blocked");
  });
  it("rejects oversized and no-op patches", async () => {
    for (const after of [page, "x".repeat(200001)]) {
      const i = input();
      i.replacements = [{ path: "README.md", after }];
      expect((await prepareRepair(i, executor())).state).toBe("blocked");
    }
  });
  it("refuses automatic nonzero-exit repair", async () => {
    expect(
      (
        await prepareRepair(
          input(),
          executor("new\n", (r) => {
            if (r.evidence[0]) r.evidence[0].exit_code = 1;
          }),
        )
      ).state,
    ).toBe("blocked");
  });
});

it("malformed untrusted artifacts fail closed", () => {
  expect(validateRepairProposal(null as never)).toBe(false);
  expect(validateRepairProposal({} as never)).toBe(false);
});
it("refuses stale analysis and path traversal before executing", async () => {
  for (const kind of ["stale", "path"]) {
    const i = input();
    if (kind === "stale" && i.files[0])
      i.files[0].content = page.replace('print("new")', 'print("other")');
    else i.files.push({ path: "../hidden.py", content: "" });
    let called = false;
    const result = await prepareRepair(i, async () => {
      called = true;
      throw new Error("should never execute");
    });
    expect(result.state).toBe("blocked");
    expect(called).toBe(false);
  }
});

it("blocked artifacts retain integrity and safe fallback shape", async () => {
  const p = await prepareRepair(input(), async () => {
    throw new Error("unavailable");
  });
  expect(validateRepairArtifact(p)).toBe(true);
  expect(validateRepairProposal(p)).toBe(false);
  p.id = "tampered";
  expect(validateRepairArtifact(p)).toBe(false);
});
it("rejects evidence from a different source snapshot", async () => {
  const p = await prepareRepair(
    input(),
    executor("new\n", (r) => {
      r.source_digest = "a".repeat(64);
      for (const e of r.evidence) e.source_digest = r.source_digest;
    }),
  );
  expect(p.state).toBe("blocked");
});

it("never exposes execution exception details in blocked fallback reasons", async () => {
  const p = await prepareRepair(input(), async () => {
    throw new Error("postgresql://admin:secret@private-host/db PRIVATE_KEY=private-value");
  });
  expect(p.state).toBe("blocked");
  expect(p.reasons.join(" ")).toContain("Verification unavailable");
  expect(JSON.stringify(p)).not.toContain("secret");
  expect(JSON.stringify(p)).not.toContain("private-value");
});
it("matches Python snapshot hashing for Unicode paths, escapes, and CRLF", () => {
  expect(
    repairSourceDigest([
      { path: "é.py", content: 'print("héllo")\n' },
      { path: "😀.py", content: 'x = "\\t"\n' },
      { path: "\ue000.py", content: "x = 1\r\n" },
      { path: "README.md", content: "Excluded documentation" },
    ]),
  ).toBe("5268da0ab8a247b8dfb9797e506fc91281bc43be79dfbdd3a17f46f49e26cd0a");
});
