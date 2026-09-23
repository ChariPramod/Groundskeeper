# Iterative delivery plan

Updated September 20, 2026. This plan builds on the local claim index, drift mapper, Docker verifier, and durable webhook inbox. The v1 goal remains verified, reviewable documentation fixes.

## Iteration 1: make incoming changes useful

Connect the inbox to a bounded, read-only push worker. Fetch repository content at exact before/after commits through installation-scoped GitHub authentication, parse documentation at the after commit, run analysis, and persist an immutable report scoped to the installation and repository. Acknowledge delivery only after persistence. Replays must be idempotent; conflicting delivery reuse must fail.

In parallel, harden verification at file/process boundaries and add a deterministic synthetic drift evaluation with negative controls. These are prerequisites for trusting later repairs, not substitutes for a public-repository evaluation.

Acceptance: unit and cross-language tests pass, schema migration is generated, worker refuses incomplete/truncated snapshots, failed jobs remain retryable, and analysis reports never trigger GitHub writes. Live database/GitHub/container checks are reported separately from simulated tests.

Iteration 1 implementation status: the finite push worker, immutable run persistence, retry cooldown, verification hardening and synthetic regression gate are implemented. Local unit/cross-language validation is complete; external GitHub/Postgres/Docker validation remains pending. This does not mark the complete v1 launch done.

## Iteration 2: connect execution evidence

Persist verification runs against the same immutable commits and source digests. Select affected runnable examples within a bounded verification budget. Add explicit runtime configuration and ordered tutorial sessions. Run Docker integration tests and inspect infrastructure failures before allowing any automated repair.

Iteration 2 progress: explicit `verify:run` orchestration now loads an installation-scoped analysis, refetches its after-commit, selects affected code blocks, runs the existing verifier and stores an immutable `VerificationRun`. A local artifact is saved first so a database failure does not discard execution evidence. Limits are ten blocks at ten seconds each, with the existing resource controls. Runtime image selection is explicit; skipped and infrastructure-error evidence is retained. Named ordered sessions now reconstruct state by bounded prefix replay, with dependency-aware selection and evidence integrity checks. Live Docker/database validation remains pending, so this iteration is not yet complete.

## Iteration 3: prove detection quality

Expand the synthetic benchmark to permissively licensed public repositories, inspect claim/link samples, and publish precision, recall, false-stale rate and verification coverage. Add links and CLI checks where they improve coverage. Prioritize measured failures over increasing claim counts.

## Iteration 4: reviewable repair

Add minimal repair proposals, independently executed QA, atomic concurrent budget reservation and PR drafts containing evidence. Start on a fork. No direct default-branch writes. A failed or unavailable verifier must never produce an automatically published fix.

## Deferred

External-page screenshots, CMS/wiki targets, scheduled autonomous loops and learned conventions remain behind the original version fences. Production readiness additionally needs installation lifecycle synchronization, adaptive queue backoff, service authentication, tenant access controls and hosted sandbox isolation.

Tutorial verification progress: explicit page-scoped session annotations, source-ordered replay, execution-cost budgets and dependency failure propagation are implemented. A three-step fixture covers setup, an output assertion and a dependent follow-up. Prefix replay deliberately avoids persistent containers; nondeterministic setup and interactive shells remain outside this model.

## Setup readiness iteration — September 21, 2026

Added mode-specific readiness reports (`pnpm run doctor`), an explicit integration gate, shared root `.env` loading, normalized RSA key/file inputs for all GitHub entrypoints, and root-level ingress/schema/status commands. The [detailed handoff](PROJECT_HANDOFF.md) separates operator setup from the remaining engineering backlog and includes a two-commit end-to-end smoke test.

Validation: 153 tests passed; seven Postgres/Docker tests skipped because services are unavailable. Lint, types, build, Ruff formatting and Prisma schema validation passed. The explicit integration command correctly exits 2 for missing Docker/test database prerequisites. Next: provision services and record live evidence, validate queue leasing/terminal recovery, then add installation indexing before unattended operation.

## Delivery lease iteration — September 21, 2026

Replaced batch selection with one-at-a-time atomic PostgreSQL claims using row locks and `SKIP LOCKED`. Each claim receives a ten-minute lease and consumes one of five attempts. Persistence and acknowledgment require the current, unexpired token. Failure clears the lease and schedules a five-minute retry, or marks an exhausted delivery terminal. Expired crashes can be reclaimed; exhausted crashes are terminalized during the next claim.

Added installation-scoped queue inspection and explicit terminal retry (`pnpm queue`), an additive migration, persistence-fence coverage, and tests for concurrent claims, crash recovery, stale owners and operator recovery. A stored analysis survives acknowledgment failure and is reused on replay. No heartbeat or automatic cancellation of expired computation is implemented. Live PostgreSQL checks remain separate from local unit coverage; follow the [handoff](PROJECT_HANDOFF.md) to apply migrations and run the service gate.

Lease iteration validation: 156 tests passed (65 TypeScript, 91 Python); eight service tests skipped (four PostgreSQL, four Docker). Build, lint, type checks, formatting, Prisma client generation and schema validation passed. The additive migration and concurrent SQL behavior still require the documented real-service run.

## Visual workspace iteration — September 21, 2026

At the user's explicit request, expanded scope to a local read-only Next.js dashboard. Delivered overview metrics, searchable/filterable runs, evidence inspection, repository activity, queue visibility, summary export and live connection settings using TypeScript, Tailwind v4, shadcn/ui, Lucide, Motion and a selective Magic UI component. Demo/live identity stays visible; live failures never silently substitute fixtures. Added backend auth/scoping tests, client DTO/timeout tests and Chromium interaction/recovery checks, including reduced-motion hydration and mobile overflow regressions.

Next: validate a successful live database read after the integration setup, then add pagination and richer artifact inspection. Browser write operations and hosted authorization remain outside this completed increment. See [DASHBOARD.md](DASHBOARD.md).

Dashboard iteration validation: 208 tests passed (109 TypeScript unit, 91 Python, eight production Chromium browser tests). Eight PostgreSQL/Docker tests remain skipped. Production build, lint, types and formatting passed. Desktop and mobile screenshots were visually inspected; reduced-motion hydration and table overflow issues were fixed and covered by browser tests.

## Review and repair iteration — September 21, 2026

Implemented richer claim/excerpt/impact review, browser-local owner/notes/dismissal, a repair diff workspace, immutable tamper-checked artifacts, conservative output-assertion repairs and manual full-page replacements. Independent baseline reproduction and complete successful patched verification are mandatory. Infrastructure failures retain blocked artifacts.

Added explicit draft PR publishing with fresh verification, exact snapshot/image checks, atomic one-proposal-per-analysis budget reservation, fenced leases, create-only deterministic branches and partial-failure reconciliation. Added explicit same-repository PR analysis against the merge base and neutral informational check publication. No browser GitHub writes or automatic PR-event worker is enabled.

Validation: **294 tests passed** (191 TypeScript, 91 Python, 12 production Chromium); **10 service tests skipped** (five Postgres, five Docker). Schema validation and production web build passed. Missing Docker was exercised through the real repair demo and produced a blocked artifact. Successful real service operation and remote draft/check creation remain pending. See [REPAIR_WORKFLOW.md](REPAIR_WORKFLOW.md) for commands and recovery, and [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for operator tasks.

Next: run the development-repository service smoke test; then prioritize shared review history, installation/PR lifecycle processing, measured verification coverage, and hosted authorization. Earlier validation totals below/above record historical iterations.

## Evidence recovery iteration

Implemented `pnpm verify:import` to restore saved execution reports after database failures without rerunning examples. Added bounded checksum-checked artifact reads, shared affected-claim selection, source/claim/tutorial validation, original identity preservation, safe errors and atomic immutable evidence writes. See [EVIDENCE_RECOVERY.md](EVIDENCE_RECOVERY.md) for commands and trust boundaries.

## PR inbox processing

The finite worker now claims push and pull-request jobs, with an event filter for separate operation. Added pinned webhook commit metadata, merge-base analysis, closed/fork/superseded handling, acknowledgment replay, event-scoped persistence fencing and PR queue retry commands. PostgreSQL lease coverage now exercises both event types. See [PULL_REQUEST_WORKER.md](PULL_REQUEST_WORKER.md). Supervised hosting, installation lifecycle handling, initial indexing, shared review state and hosted authorization remain unfinished product work.
