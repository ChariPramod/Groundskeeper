# Presenting Groundskeeper

## The one-sentence explanation

Groundskeeper helps teams keep software documentation accurate when their code changes: it finds affected instructions, tests supported examples, and prepares small fixes for a human to review.

## A three-minute demonstration

Open [the interactive walkthrough](https://temporary-racing-aurora-75uu7zy.vercel.app/walkthrough). It runs without credentials or live backend services. Say up front: “This is a fixed illustrative scenario showing the implemented workflow; these clicks do not execute code or create a PR.”

1. **The problem — 30 seconds.** A developer improves a greeting function, but the tutorial still shows the old output. Explain that documentation can quietly drift even when the software itself works.
2. **Detection — 30 seconds.** Advance to “Docs are flagged.” The example references the changed function. Groundskeeper identifies it as worth checking; it has not yet proven the documentation wrong.
3. **Evidence — 30 seconds.** Advance to “The example is checked.” Compare expected and observed output. The opted-in example exits successfully but its assertion fails. In the actual pipeline, execution happens in a bounded isolated Docker container against pinned source bytes.
4. **A small fix — 30 seconds.** Advance to “A fix is verified.” Show that the change updates only the expected output. Independent verification is required; a generated edit alone is insufficient.
5. **Human control — 30 seconds.** Advance to “A human reviews.” Explain the explicit CLI approval, fresh verification, change limits, separate branch and draft PR. A maintainer decides whether to merge.
6. **Failure behavior — 30 seconds.** Enable “Simulate unavailable runtime.” The final step now shows that no PR can be created. Missing infrastructure produces uncertainty, not a fabricated pass. Restart if demonstrating again.

Then open the dashboard to show activity, repository filtering, evidence details, local notes and repair diffs. Its records are also illustrative. Notes persist only in that browser; they are not a shared team audit trail.

## What we can demonstrate and claim

| Capability | Current evidence | Boundary to explain |
| --- | --- | --- |
| Hosted interface | Public Vercel app with automatic GitHub deployments and browser tests | Hosted records are sample data |
| Documentation analysis | Real Markdown/MDX parser and Python/TypeScript drift analysis, tested across languages | Conservative links; affected does not mean wrong |
| Example verification | Real Docker execution/isolation and tutorial tests passed in CI | Opted-in Python only; dependencies must be supplied in the runtime image |
| Review and repair | Implemented bounded repair engine, local artifacts, independent verification and draft PR adapter | Automatic edits focus on expected output; other page edits are explicitly supplied |
| Recovery | Queue leases, replay checks, immutable artifacts and `verify:import` | Local trusted operator tooling; artifacts are not cryptographically signed |
| GitHub integration | Public source and Vercel Git integration work; App ingress/worker/check/publisher code is tested | An installed-App end-to-end pilot and actual repair PR publication are still pending |

Test totals change as development proceeds. Show the latest [GitHub Actions result](https://github.com/ChariPramod/Groundskeeper/actions), rather than quoting an old total as evidence of current behavior. Passing CI is not a production accuracy benchmark.

## Questions people will ask

**Is it an AI chatbot?** No. The current flow uses parsing, change analysis, execution and constrained repair logic. No model API is needed. Future semantic assistance would still need verification and review.

**Does it automatically rewrite all documentation?** No. It focuses on small supported repairs with explicit approval. It does not prove every sentence, infer every import relationship, or automatically merge changes.

**Why not just run documentation examples in CI?** Example tests provide the execution layer. Groundskeeper connects code changes to candidate documentation, preserves evidence, organizes review and carries bounded repairs through publication. It complements existing tests.

**Does the website run arbitrary repository code?** No. The hosted demo runs neither examples nor repair publishing. The real executor is a separate isolated process/container workflow.

**Can a team use it in production today?** Treat it as an engineering prototype ready for a development-repository pilot. It still needs deployed worker infrastructure, an installed App trial, shared review state and hosted per-user authorization before a multi-user rollout.

## What “finished enough to present” means

For an explanatory product demo: a working link, one coherent story, a visible failure path, reproducible tests, a source repository, and clear limits. The walkthrough and this guide provide that package.

For a real customer pilot, the remaining work is more substantial:

1. **Prove a complete live loop.** Install the GitHub App on a development repository, deploy the ingress/worker with Postgres and Docker, change one documented function, persist analysis/evidence, and publish one verified draft repair. Record commit IDs, evidence IDs and the PR. Use PROJECT_HANDOFF.md and REPAIR_WORKFLOW.md.
2. **Measure usefulness.** Choose a small, appropriately licensed repository corpus; label true/false detections and measure verification coverage. The synthetic benchmark is a regression test, not market-facing accuracy evidence.
3. **Make it a team workspace.** Add user/session authorization, shared review ownership/history and a tenant-scoped durable artifact store. Keep the public demo separate from private repository data.
4. **Operate it reliably.** Add installation lifecycle processing, initial indexing and a supervised worker service with operational monitoring. Exercise retries and recovery under real failures.
5. **Expand only where the pilot shows value.** Consider TypeScript execution, CLI/link checks and additional repair types after identifying actual coverage gaps.

## Presentation fallback

If the hosted app is unavailable, run `pnpm dev` and open `/walkthrough` on the printed local URL. The walkthrough uses bundled sample data and requires no database, GitHub credentials or Docker. If a live pilot is unavailable, use this illustrative walkthrough and say so; do not describe its sample output as evidence from a real repository.
