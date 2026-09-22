import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractClaims } from "@groundskeeper/parser";
import { analyzeLocally } from "./analysis.js";
import { workspaceRoot } from "./environment.js";
import { saveRepairArtifact } from "./repairs/artifacts.js";
import { prepareRepair } from "./repairs/engine.js";
import { verifyLocally } from "./verify-run.js";

const load = (path: string) => readFile(join(workspaceRoot, "examples/tutorial", path), "utf8");
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
      id: "local-tutorial-fixture",
      installationId: "1",
      repositoryId: "1",
      fullName: "groundskeeper/local-tutorial-fixture",
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
const saved = await saveRepairArtifact(join(workspaceRoot, ".groundskeeper/repairs"), proposal);
console.log(
  JSON.stringify(
    {
      fixture: true,
      state: proposal.state,
      artifact: saved.digest,
      path: saved.path,
      reasons: proposal.reasons,
    },
    null,
    2,
  ),
);
console.log(`Inspect: pnpm repair:inspect --artifact ${saved.digest}`);
process.exitCode = proposal.state === "verified" ? 0 : 2;
