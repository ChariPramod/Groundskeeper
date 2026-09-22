import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AnalysisReport } from "@groundskeeper/contracts";
import {
  assertRepairPublicationLease,
  finishRepairPublication,
  PrismaClient,
  releaseRepairPublicationLease,
  reserveRepairPublication,
} from "@groundskeeper/database";
import { Probot } from "probot";
import { CommandInputError } from "./command-errors.js";
import { loadPrivateKey } from "./credentials.js";
import { workspaceRoot } from "./environment.js";
import {
  readRepairArtifact,
  repairLineChanges,
  saveRepairArtifact,
  writeImmutableJson,
} from "./repairs/artifacts.js";
import { prepareRepair, validateRepairProposal } from "./repairs/engine.js";
import { publishRepair } from "./repairs/publish.js";
import type { PrepareRepairInput, RepairProposal } from "./repairs/types.js";
import { GitHubSnapshots } from "./snapshots.js";
import { verifyLocally } from "./verify-run.js";

const artifacts = join(workspaceRoot, ".groundskeeper/repairs");
async function readReplacements(path: string): Promise<{ path: string; after: string }[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile())
      throw new CommandInputError("Replacement input must be a regular JSON file");
    const bytes = Buffer.alloc(700_001);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 700_000) throw new CommandInputError("Replacement JSON exceeds 700 KB");
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 3 ||
      value.some((item) => !item || typeof item.path !== "string" || typeof item.after !== "string")
    ) {
      throw new CommandInputError(
        "Replacement JSON must contain one to three {path, after} objects",
      );
    }
    return value;
  } finally {
    await file.close();
  }
}
function imageIds(p: RepairProposal) {
  return [...new Set(p.verification?.evidence.map((e) => e.image_id) ?? [])].sort().join(",");
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "analysis-run": { type: "string" },
      "installation-id": { type: "string" },
      artifact: { type: "string" },
      approve: { type: "string" },
      replacements: { type: "string" },
      image: { type: "string" },
    },
  });
  const action = positionals[0];
  if (positionals.length !== 1 || !["prepare", "inspect", "publish"].includes(action ?? ""))
    throw new CommandInputError("Repair action must be prepare, inspect, or publish");
  const proposal = values.artifact ? await readRepairArtifact(artifacts, values.artifact) : null;
  if (action === "inspect") {
    if (!proposal) throw new CommandInputError("Provide --artifact <SHA-256>");
    console.log(
      JSON.stringify(
        {
          artifact: values.artifact,
          proposalId: proposal.id,
          state: proposal.state,
          reasons: proposal.reasons,
          repository: proposal.fullName,
          baseCommit: proposal.baseCommit,
          summary: proposal.summary,
          baseline: proposal.baseline?.outcomes,
          verification: proposal.verification?.outcomes,
          changes: proposal.files,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (
    action === "publish" &&
    (!proposal || !validateRepairProposal(proposal) || values.approve !== proposal.id)
  ) {
    throw new CommandInputError(
      "Publishing requires a verified artifact and --approve with its exact proposal ID; inspect it first",
    );
  }
  const analysisRunId = proposal?.analysisRunId ?? values["analysis-run"];
  const installation = proposal?.installationId ?? values["installation-id"];
  if (
    !analysisRunId ||
    !installation ||
    !/^[1-9]\d*$/.test(installation) ||
    BigInt(installation) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new CommandInputError("Provide a stored analysis run and valid installation ID");
  for (const key of ["DATABASE_URL", "APP_ID"])
    if (!process.env[key]) throw new CommandInputError(`Missing ${key}`);
  const installationId = BigInt(installation);
  const db = new PrismaClient();
  let lease: { analysisRunId: string; token: string } | null = null;
  try {
    const run = await db.analysisRun.findFirst({
      where: { id: analysisRunId, repository: { workspace: { installationId } } },
      include: { repository: true },
    });
    if (!run) throw new CommandInputError("Analysis not found in this installation");
    const app = new Probot({
      appId: process.env.APP_ID,
      privateKey: await loadPrivateKey(process.env, workspaceRoot),
    });
    const client = await app.auth(Number(installationId));
    const gateway = new GitHubSnapshots(client);
    const repository = await gateway.repository(run.repository.fullName);
    if (BigInt(repository.githubId) !== run.repository.githubId)
      throw new CommandInputError("Repository identity mismatch");
    const files = await gateway.snapshot(repository.fullName, run.afterCommit);
    const input: PrepareRepairInput = {
      analysis: {
        id: run.id,
        installationId: installation,
        repositoryId: run.repository.githubId.toString(),
        fullName: repository.fullName,
        baseCommit: run.afterCommit,
        defaultBranch: repository.defaultBranch,
        report: run.report as unknown as AnalysisReport,
      },
      files,
      image: proposal?.image ?? values.image ?? "python:3.12-slim",
      replacements: proposal
        ? proposal.files.map((file) => ({ path: file.path, after: file.after }))
        : values.replacements
          ? await readReplacements(values.replacements)
          : undefined,
    };
    if (
      proposal &&
      (proposal.baseCommit !== run.afterCommit ||
        proposal.repositoryId !== input.analysis.repositoryId ||
        proposal.fullName !== input.analysis.fullName ||
        proposal.defaultBranch !== repository.defaultBranch ||
        proposal.files.some(
          (file) => files.find((source) => source.path === file.path)?.content !== file.before,
        ))
    ) {
      throw new CommandInputError(
        "Approved proposal no longer matches the authoritative analysis and pinned snapshot",
      );
    }
    // Both preparation and publication run the original and repaired examples afresh.
    const fresh = await prepareRepair(input, verifyLocally);
    const saved = await saveRepairArtifact(artifacts, fresh);
    console.log(`Repair artifact: ${saved.path}`);
    console.log(
      JSON.stringify(
        {
          state: fresh.state,
          proposalId: fresh.id,
          artifact: saved.digest,
          reasons: fresh.reasons,
          files: fresh.files.map((f) => f.path),
        },
        null,
        2,
      ),
    );
    if (fresh.state !== "verified") {
      process.exitCode = 2;
      return;
    }
    if (action === "prepare") {
      console.log(`Review with: pnpm repair:inspect --artifact ${saved.digest}`);
      return;
    }
    if (
      !proposal ||
      !fresh.verification ||
      fresh.id !== proposal.id ||
      imageIds(fresh) !== imageIds(proposal)
    )
      throw new CommandInputError(
        "Fresh verification differs from the reviewed proposal or runtime; review a new artifact",
      );
    const reservation = await reserveRepairPublication(db, {
      analysisRunId: run.id,
      installationId,
      proposalId: proposal.id,
      pages: proposal.files.length,
      linesChanged: repairLineChanges(proposal.files),
    });
    if (reservation.url) {
      console.log(`Already published: ${reservation.url}`);
      return;
    }
    if (!reservation.token) throw new CommandInputError("Publication lease unavailable");
    lease = { analysisRunId: run.id, token: reservation.token };
    const published = await publishRepair(
      { ...fresh, verification: fresh.verification },
      values.approve ?? "",
      client,
      () => assertRepairPublicationLease(db, run.id, fresh.id, reservation.token as string),
    );
    // Keep an immutable receipt if database finalization fails after the remote PR exists.
    const receipt = { proposalId: fresh.id, artifact: saved.digest, ...published };
    const receiptKey = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    const receiptPath = await writeImmutableJson(join(artifacts, "receipts"), receiptKey, receipt);
    console.log(`Publication receipt: ${receiptPath}`);
    console.log(`Draft pull request: ${published.url}`);
    await finishRepairPublication(db, run.id, reservation.token, published.url);
    lease = null;
  } finally {
    if (lease)
      await releaseRepairPublicationLease(db, lease.analysisRunId, lease.token).catch(
        () => undefined,
      );
    await db.$disconnect();
  }
}
await main().catch((error) => {
  if (error instanceof CommandInputError) console.error(error.message);
  console.error(
    `Repair command failed (${error instanceof Error ? error.name : "UnknownError"}). Inspect the saved artifact; restore services and retry the same approved artifact after publication failures.`,
  );
  process.exitCode = 2;
});
