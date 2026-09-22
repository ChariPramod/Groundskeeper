# Implementation status

This file tracks shipped code separately from the original execution plan.

## Implemented locally

- pnpm/uv monorepo, locked dependencies, lint/type/build/test commands, and GitHub Actions workflow.
- Pydantic claim/report/budget models with generated JSON Schema and TypeScript contracts.
- Prisma relational schema and generated initial Postgres migration.
- remark-based Markdown/MDX structural claim extraction and a JSON CLI.
- Python/TypeScript/TSX tree-sitter declaration extraction, exact candidate links, snapshot-based drift mapping, and health reports.
- FastAPI `/healthz` and `/v1/analyze`, plus a combined local analysis CLI.
- Probot routing, signature validation, and a Postgres inbox adapter; duplicate deliveries are ignored.
- Change-budget and review-branch preflight functions.
- A deterministic local demo and tests across parsing, linking, drift, API, webhooks, and budgets.
- Initial Docker verification for opted-in standalone Python blocks, including output comparison and distinct infrastructure errors.
- Evidence reports with source/claim digests, resolved image ID, limits, timestamps, stdout/stderr, and exit code; existing files are not overwritten.
- Corrected claim IDs covering link destinations and execution metadata, plus bounded source snapshots that prune dependency directories.

## Validation boundaries

- The fixture covers rename, default, parameter, output, deletion, and file-move scenarios in tests. No public-repo accuracy claims have been made.
- Postgres persistence has a CI integration test. The initial local machine has neither Docker nor Postgres, so a live migration/persistence run is pending.
- No GitHub App installation has been created or tested against an external organization.
- The Docker verifier is implemented. Local tests exercise its controls and verdicts through a test transport; actual container execution requires Docker and is covered by opt-in CI tests. No live Docker run has been performed on the initial development machine.
- A finite push worker consumes eligible push deliveries and persists immutable, tenant-scoped analysis reports. An explicit verification command now links execution-evidence reports to these runs. Full mutable index synchronization remains pending.
- No model calls, hosting, paid infrastructure or actual GitHub writes have been performed. Repair proposals and explicit publication code are implemented; external validation is pending.

The **push → pinned analysis → explicit isolated verification → database evidence** path is implemented, with live deployment checks and production queue handling still pending. Verification is explicitly invoked per stored run rather than automatically triggered by every push. Explicit draft PR creation now requires independent verification and concurrent publication reservation; their real-service behavior still needs validation. See [the iteration review](iteration-review.md) for findings and priorities.

## September 20 iteration

- Added `pnpm worker --limit 5`: exact commit/blob loading, source integrity checks, real parser-to-Python analysis, persistence-before-acknowledgement and stored-run replay recovery.
- Added `AnalysisRun` storage and webhook retry metadata in two additive migrations. Failure cooldown is five minutes; the later queue iteration below adds leases and terminal disposition.
- Hardened source reads against symlink/FIFO races and Docker attachment/result handling.
- Added `pnpm eval`: 18 deterministic synthetic cases / 36 independently authored labels, with CI regression gating.
- Local tests use a mocked GitHub transport and real parser/analyzer. Docker, Postgres and a live GitHub installation remain unavailable for end-to-end external validation.

The ongoing iteration sequence is in [active-plan.md](active-plan.md).

## Stored-run verification iteration

- Added `pnpm verify:run --analysis-run <id> --installation-id <id>` with an explicit runtime image and bounded block count.
- Source is refetched at the stored after-commit using installation authentication and blob-integrity checks; only Python source is passed to the Docker verifier.
- Added a validated Python bridge that selects affected code deterministically and preserves unsupported/non-opted/budget-limited evidence.
- Added `VerificationRun` relation and additive migration, installation/repository/commit ownership checks, immutable report storage and conflicting replay rejection.
- Local JSON evidence is saved before database persistence. Each explicit execution produces a new report ID; replaying the same report through storage is idempotent.
- Tests use real TypeScript/Python bridges with zero execution budget and stub execution results; live Docker/Postgres/GitHub validation remains pending.

## Tutorial-session iteration

- Added validated `groundskeeper:session=<name>` metadata to Python fences and the cross-language claim contract; unannotated claim IDs remain stable.
- Verification reconstructs prior session setup in a fresh container for each target, with output suppression during setup, shared per-container limits, and budget charges for every replayed block.
- Earlier failed/unverified session steps block later execution as `unknown`. Session evidence includes ordered prerequisite digests.
- Stored-run selection expands an impacted session to all code members on the same page. Persistence rejects missing members and changed session/source-position assertions.
- Added `examples/tutorial` with before/after source and opt-in Docker coverage. Live runtime validation remains pending; local controlled-fixture tests exercise replay scripts and cross-language selection/storage.

## Setup readiness iteration — September 21, 2026

Added mode-specific readiness reports (`pnpm run doctor`), an explicit integration gate, shared root `.env` loading, normalized RSA key/file inputs for all GitHub entrypoints, and root-level ingress/schema/status commands. The [detailed handoff](PROJECT_HANDOFF.md) separates operator setup from the remaining engineering backlog and includes a two-commit end-to-end smoke test.

Validation: 153 tests passed; seven Postgres/Docker tests skipped because services are unavailable. Lint, types, build, Ruff formatting and Prisma schema validation passed. The explicit integration command correctly exits 2 for missing Docker/test database prerequisites. Next: provision services and record live evidence, validate queue leasing/terminal recovery, then add installation indexing before unattended operation.

## Delivery lease iteration — September 21, 2026

Replaced batch selection with one-at-a-time atomic PostgreSQL claims using row locks and `SKIP LOCKED`. Each claim receives a ten-minute lease and consumes one of five attempts. Persistence and acknowledgment require the current, unexpired token. Failure clears the lease and schedules a five-minute retry, or marks an exhausted delivery terminal. Expired crashes can be reclaimed; exhausted crashes are terminalized during the next claim.

Added installation-scoped queue inspection and explicit terminal retry (`pnpm queue`), an additive migration, persistence-fence coverage, and tests for concurrent claims, crash recovery, stale owners and operator recovery. A stored analysis survives acknowledgment failure and is reused on replay. No heartbeat or automatic cancellation of expired computation is implemented. Live PostgreSQL checks remain separate from local unit coverage; follow the [handoff](PROJECT_HANDOFF.md) to apply migrations and run the service gate.

Lease iteration validation: 156 tests passed (65 TypeScript, 91 Python); eight service tests skipped (four PostgreSQL, four Docker). Build, lint, type checks, formatting, Prisma client generation and schema validation passed. The additive migration and concurrent SQL behavior still require the documented real-service run.

## Visual workspace

Implemented a local read-only dashboard under `apps/web` with the requested frontend stack. Added server-scoped data reads, safe demo/live separation, malformed-response/timeout fallback, metadata export, responsive navigation, keyboard dialog recovery and reduced-motion support. Added 44 data/client unit tests and Chromium workflow coverage. Production build and existing checks pass; successful live PostgreSQL access is still unvalidated. See the [dashboard guide](DASHBOARD.md) and [handoff](PROJECT_HANDOFF.md) for setup and remaining scope.

Dashboard iteration validation: 208 tests passed (109 TypeScript unit, 91 Python, eight production Chromium browser tests). Eight PostgreSQL/Docker tests remain skipped. Production build, lint, types and formatting passed. Desktop and mobile screenshots were visually inspected; reduced-motion hydration and table overflow issues were fixed and covered by browser tests.

## Review and repair iteration — September 21, 2026

Implemented richer claim/excerpt/impact review, browser-local owner/notes/dismissal, a repair diff workspace, immutable tamper-checked artifacts, conservative output-assertion repairs and manual full-page replacements. Independent baseline reproduction and complete successful patched verification are mandatory. Infrastructure failures retain blocked artifacts.

Added explicit draft PR publishing with fresh verification, exact snapshot/image checks, atomic one-proposal-per-analysis budget reservation, fenced leases, create-only deterministic branches and partial-failure reconciliation. Added explicit same-repository PR analysis against the merge base and neutral informational check publication. No browser GitHub writes or automatic PR-event worker is enabled.

Validation: **294 tests passed** (191 TypeScript, 91 Python, 12 production Chromium); **10 service tests skipped** (five Postgres, five Docker). Schema validation and production web build passed. Missing Docker was exercised through the real repair demo and produced a blocked artifact. Successful real service operation and remote draft/check creation remain pending. See [REPAIR_WORKFLOW.md](REPAIR_WORKFLOW.md) for commands and recovery, and [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for operator tasks.

Next: run the development-repository service smoke test; then prioritize shared review history, installation/PR lifecycle processing, measured verification coverage, and hosted authorization. Earlier validation totals below/above record historical iterations.

## Evidence recovery iteration

Implemented `pnpm verify:import` to restore saved execution reports after database failures without rerunning examples. Added bounded checksum-checked artifact reads, shared affected-claim selection, source/claim/tutorial validation, original identity preservation, safe errors and atomic immutable evidence writes. See [EVIDENCE_RECOVERY.md](EVIDENCE_RECOVERY.md) for commands and trust boundaries.
