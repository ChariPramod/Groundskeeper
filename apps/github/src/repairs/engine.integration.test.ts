import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractClaims } from "@groundskeeper/parser";
import { expect, it } from "vitest";
import { analyzeLocally } from "../analysis.js";
import { verifyLocally } from "../verify-run.js";
import { prepareRepair, validateRepairProposal } from "./engine.js";

it.skipIf(process.env.GROUNDSKEEPER_DOCKER_TEST !== "1")(
  "repairs the actual tutorial output and independently verifies all steps in real Docker",
  async () => {
    const load = (path: string) => readFile(resolve("examples/tutorial", path), "utf8");
    const [docs, before, after] = await Promise.all([
      load("docs/quickstart.md"),
      load("before/client.py"),
      load("after/client.py"),
    ]);
    const report = await analyzeLocally({
      claims: extractClaims(docs, "docs/quickstart.md"),
      before: [{ path: "client.py", content: before }],
      after: [{ path: "client.py", content: after }],
    });
    const proposal = await prepareRepair(
      {
        analysis: {
          id: "tutorial",
          installationId: "1",
          repositoryId: "1",
          fullName: "test/tutorial",
          baseCommit: "b".repeat(40),
          defaultBranch: "main",
          report,
        },
        files: [
          { path: "client.py", content: after },
          { path: "docs/quickstart.md", content: docs },
        ],
      },
      verifyLocally,
    );
    expect(proposal.reasons).toEqual([]);
    expect(validateRepairProposal(proposal)).toBe(true);
    expect(proposal.baseline?.outcomes.failed).toBe(1);
    expect(proposal.verification?.outcomes.passed).toBe(3);
    expect(proposal.verification?.evidence.every((item) => item.outcome === "passed")).toBe(true);
    expect(proposal.files[0]?.after).toContain("delivered: hello");
  },
  360_000,
);
