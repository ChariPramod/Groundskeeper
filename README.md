# Groundskeeper

[Hosted demo](https://temporary-racing-aurora-75uu7zy.vercel.app) · [Interactive walkthrough](https://temporary-racing-aurora-75uu7zy.vercel.app/walkthrough) · [Presenter guide](docs/PRESENTING.md) · [Deployment setup](docs/DEPLOYMENT.md)

Documentation maintenance backed by evidence: index what docs claim, link those claims to code, detect possible drift, and eventually verify fixes by execution before opening reviewable PRs.

**Status: local analysis, review, and verified repair workflow implemented.** Commit-pinned analysis and isolated Python verification now feed a detailed review workspace and bounded repair artifacts. Explicit CLI commands can independently reverify a repair and open a draft PR, or analyze an existing same-repository PR and publish a neutral informational check. Successful real Docker/Postgres/GitHub validation remains pending. See the [repair workflow](docs/REPAIR_WORKFLOW.md) and [operator handoff](docs/PROJECT_HANDOFF.md).

## Run the demo

Prerequisites: Node.js 22.17+, pnpm 10.33, and uv. Python 3.12 is selected by `.python-version`; uv can provision it. No database, Docker, GitHub credentials, or model API key is needed for local analysis.

```sh
pnpm install --frozen-lockfile
uv sync --locked
pnpm db:generate
pnpm demo
```

The demo compares two small Python/TypeScript snapshots against a Markdown quickstart. It renames a method, changes a Python default, and changes a TypeScript default. The report finds **4 affected claims out of 6**, links **5 of 6**, and leaves the unchanged readiness claim unaffected. These are fixture results, not public-repository evaluation metrics.

Read `.groundskeeper/demo.json` for claims, source positions, symbols, links, affected claims, and health metrics. All claims begin as `unknown`. An affected claim needs verification; a changed symbol alone never proves a claim is `stale`.

## Analyze your own checkout

Supply existing directories containing the docs and the two code snapshots. The tool parses files without importing or executing the inspected code.

```sh
uv run groundskeeper analyze \
  --docs /path/to/docs \
  --before /path/to/old-code \
  --after /path/to/new-code \
  --output .groundskeeper/report.json
```

Run this CLI from the monorepo after installing both workspaces. It invokes the workspace's TypeScript parser through pnpm. Snapshots are complete directory trees, not individual diff hunks. Missing files in `after` count as deletions. Paths in the report are relative to each supplied root; align roots if you want cross-file path links to resolve.

To extract only documentation claims:

```sh
pnpm --silent index --root /path/to/docs
```

Supported today:

- Markdown and MDX paragraphs, list/admonition paragraphs, table rows, images, and fenced code. MDX is parsed without evaluating imports or expressions. Frontmatter is skipped.
- Heading anchors, source spans, links, inline identifiers, and CLI-flag references. IDs remain stable when unrelated lines are inserted; changing the text, heading, link targets, language, execution marker, or expected output changes the ID. Re-index documents created with the initial parser to adopt the corrected identity scheme.
- Python declarations and TypeScript/TSX functions, classes, methods, variables, interfaces, types, and enums through tree-sitter.
- Exact identifier and path linking, with lower confidence for ambiguous names. Renames, removals, body/default changes, and file moves can affect linked claims. Comments and formatting alone do not cause declaration drift.
- JSON health reports and a stateless FastAPI analysis endpoint.

This is conservative structural extraction: paragraphs and table rows are claim candidates, not semantic sentence-level assertions. Symbol extraction does not yet model imports/re-exports, overload resolution, CLI options, OpenAPI operations, or arbitrary configuration keys. Fuzzy linking and semantic staleness classification are pending. Invalid supported-language syntax fails the analysis rather than producing a partial index.

The analysis command parses code blocks without executing them. Execution is a separate explicit command.

## Verify executable examples

An opt-in fence uses `python groundskeeper:run` (or `py groundskeeper:run`). An immediately following `output` fence supplies expected stdout. See [the demo quickstart](examples/demo/docs/quickstart.md) for a complete example.

Install/start Docker and explicitly prepare the runtime image, then verify the unchanged demo:

```sh
docker pull python:3.12-slim
uv run groundskeeper verify --docs examples/demo/docs --source examples/demo/before
```

The example should pass against `before`. Against the renamed method in `after`, it should fail with evidence showing the missing `send` method:

```sh
uv run groundskeeper verify --docs examples/demo/docs --source examples/demo/after
```

These expectations have real Docker integration tests in CI. Docker is unavailable on the initial development machine, so local checks validate the runner's controls and verdicts using a test transport. Running `verify` without Docker produces an infrastructure error report; it never executes repository code on the host.

Reports are written to unique files under `.groundskeeper/verifications/`. Use `--output <new-file>` to choose a path; existing files are never overwritten. Evidence includes source and claim digests, the resolved Docker image ID, timestamps, execution limits, exit code, stdout/stderr, and the expected output. A successful block verifies that block only, not surrounding prose.

| Outcome | Claim status | Meaning |
| --- | --- | --- |
| `passed` | `verified` | Exit code 0 and matching stdout when an output assertion exists |
| `failed` | `stale` | Nonzero example exit or mismatched expected stdout in the selected runtime |
| `error` | `unknown` | Missing Docker/image, daemon error, resource limit, or failed cleanup |
| `skipped` | `unverifiable` or `unknown` | No opt-in, unsupported/oversized block, or exhausted budget |

CLI exit codes: **0** for no observed failures (possibly skipped work), **1** for failed examples, **2** for infrastructure/input errors. Always inspect skipped counts and coverage before treating a run as a release gate.

The runner copies only Python source files into a temporary snapshot and runs each block in a fresh non-root container with no network, a read-only filesystem, dropped capabilities, no new privileges, and CPU/memory/PID/time/output limits. It never mounts the original checkout or injects the host environment. The source reader prunes dependency directories and symlinks and caps snapshots at 1,000 files / 10 MB. Default limits are 10 block executions (including replayed setup), 10 seconds per container including setup, 128 MB RAM, and 64 KiB combined stdout/stderr; cleanup has a separate five-second cap. `--timeout` and `--max-blocks` adjust bounded limits; `--max-blocks 0` executes nothing.

Unannotated Python blocks remain standalone. Named tutorial sessions reconstruct shared state through bounded prefix replay, described below. Install any needed dependencies in a trusted runtime image ahead of time and select it with `--image`; the runner never pulls images or installs packages implicitly. Non-code fixtures, environment secrets, TypeScript execution, links/CLI verification, and hosted multi-tenant sandboxing are not implemented yet.

## Ordered Python tutorials

Add `groundskeeper:session=<name>` alongside `groundskeeper:run` on every participating Python/py fence. Session names are 1–64 letters, digits, underscores or hyphens, beginning with a letter or digit. A session is scoped to one document; identical labels in different pages are independent. Missing opt-in, unsupported languages, duplicate markers and malformed names are parsing errors. See [the complete three-step example](examples/tutorial/docs/quickstart.md).

```sh
uv run groundskeeper verify --docs examples/tutorial/docs --source examples/tutorial/before
uv run groundskeeper verify --docs examples/tutorial/docs --source examples/tutorial/after
```

With Docker and the prepared Python image, the unchanged example should pass all three steps. The changed source should pass setup, fail the second step's output assertion, and leave the third step `unknown` because its prerequisite failed. This behavior is covered by an opt-in real Docker test; it has not run on the initial development machine.

Steps execute in source order. For each step, a fresh container replays all earlier blocks in that page/session and then executes the target. Variables and temporary files are reconstructed; no container persists between checks. Earlier setup stdout/stderr is discarded during replay because its output assertion was already checked in its own execution. The target's output is checked normally. These tutorials should use deterministic setup: replay is not a persistent interactive shell, and changing external state between runs is unsupported.

Replay consumes budget. Three steps cost **1 + 2 + 3 = 6** block executions; four cost 10. If a predecessor fails, errors, or is skipped, later members are skipped with `unknown`, preventing cascaded stale findings. A prefix replay exception is also `unknown`; exit code 120 is reserved for this condition in session execution, so a target explicitly using it is conservatively treated as unknown. The 64 KiB code limit applies to prefix plus target. Sessions above 100 blocks are rejected before building execution plans.

When verifying a stored analysis, a change affecting any code member selects the entire named session, including setup and later steps. The evidence digest binds each target to its ordered prerequisites. Storage verifies session membership and source positions and rejects partial session reports. Standalone claim IDs and execution behavior remain compatible; session membership changes claim identity.

## Local analysis API

```sh
uv run uvicorn groundskeeper.api:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/docs` for the request schema. `POST /v1/analyze` accepts `claims`, `before`, and `after`; source snapshots contain `{ "path": "client.py", "content": "..." }` objects. `GET /healthz` checks process health. This service is local/internal only: tenant authentication and deployment hardening are not implemented. It does not persist analysis results yet.

## Database and GitHub App

The schema includes workspaces, repositories, pages, claims, symbols, links, verification evidence, and an idempotent webhook inbox. Prisma is pinned to 6.19 for this initial schema/client setup; dependencies are locked.

With Docker available:

```sh
docker compose up -d --wait
export DATABASE_URL=postgresql://groundskeeper:groundskeeper@localhost:5432/groundskeeper
pnpm db:generate
pnpm db:migrate
DATABASE_TEST_URL="$DATABASE_URL" pnpm test
```

Create a development GitHub App with repository metadata and contents read access and pull requests read access. Subscribe to push and pull request events; installation events are handled too. Configure its webhook endpoint as `/api/github/webhooks` on your development relay or reachable host. Follow the [Probot development setup](https://probot.github.io/docs/development/) to obtain the app ID, private key, webhook secret, and optional relay URL.

Copy `.env.example` to `.env`, fill in those values, then start from the repository root so `.env` is loaded:

```sh
pnpm exec tsx apps/github/src/main.ts
```

Probot validates webhook signatures. Installation, repository-selection, pull-request, and default-branch push events enter the durable inbox; feature-branch and deleted-branch pushes are ignored. Duplicate delivery IDs are accepted without inserting another record. Database failures fail the request rather than acknowledging a lost event. The inbox stores routing metadata, not commit bodies or source files.

### Process queued pushes

After applying the migrations, run from the workspace root with the same `.env`:

```sh
pnpm worker --limit 5
```

This finite worker selects up to 5 eligible push deliveries (maximum 20), authenticates as each installation, confirms repository identity, and fetches Markdown/MDX and Python/TypeScript/TSX blobs at the exact before/after commits. It validates blob hashes and rejects truncated trees, invalid UTF-8, or snapshots exceeding 1,000 files / 10 MB. Each source file is capped at 2 MB. Snapshots have a two-minute deadline; analysis has a 60-second deadline and 32 MB input/output caps. Repository content is parsed as data, never executed by the worker.

An immutable `AnalysisRun` stores the report and commit IDs under its installation-scoped repository. Persistence precedes acknowledgement. Identical deliveries are idempotent; conflicting reuse is rejected. A matching stored run can be acknowledged without refetching or reanalyzing. Each worker atomically claims one delivery at a time with a ten-minute lease. Database-clock expiry permits crash recovery; a lease token fences persistence, acknowledgment and failure updates. Failures retry after five minutes, up to five claimed attempts, then retain a terminal `failedAt` marker for operator inspection. Expired fifth-attempt leases are marked terminal on the next claim. A process that outlives its lease may still compute, but cannot persist or acknowledge with its stale token.

This is a manually invoked development worker, not a continuously running production queue. Concurrent claims use PostgreSQL row locking; live concurrency validation remains pending locally. Leases are fixed-duration with no heartbeat or cancellation of expired computation. Installation lifecycle processing remains pending. A terminal job needs operator inspection before an explicit retry; only a bounded error class is stored. Initial pushes with an all-zero before SHA require a future full-index job and are deferred. Docs and code must currently live in the same repository. The worker analyzes docs at the after commit and stores complete report snapshots; it does not rebuild the mutable `Page`/`Claim` tables or automatically execute the Docker verifier. Use the explicit command below for execution.

No GitHub write operations are implemented. No live installation or Postgres run has been performed in this local environment. The API remains development-only until service authentication and lifecycle handling are complete. GitHub access uses the documented [commit/tree](https://docs.github.com/en/rest/git/trees) and [blob](https://docs.github.com/en/rest/git/blobs) APIs.

Inspect up to 100 unprocessed pushes for an installation, including terminal failures:

```sh
pnpm queue --installation-id <installation-id>
pnpm queue --installation-id <installation-id> --retry-failed <delivery-id>
```

Retry resets the attempt budget only for a matching terminal, unprocessed push in that installation. It preserves the payload and any existing analysis. Normal GitHub redelivery remains idempotent and does not reset failures. Apply the new migration with `pnpm db:migrate` before using the worker. These are operator commands using local database credentials, not a public authorization boundary.

## Verify a stored analysis run

Apply migrations with `pnpm db:migrate`, then use the analysis run ID printed by `pnpm worker`:

```sh
docker pull python:3.12-slim
pnpm verify:run --analysis-run <run-id> --installation-id <installation-id>
```

The command checks installation ownership and repository identity, refetches Python source at the analysis run's exact after-commit, and verifies affected code blocks in page/position order, expanding named tutorial sessions to include their setup and later steps. Other unaffected examples and surrounding prose are not included in its coverage. Non-opted or unsupported affected blocks produce skipped evidence. A run with no affected code produces an empty report rather than implying the whole repository is verified.

Use `--image <trusted-local-image>` for a prepared runtime and `--max-blocks 0–10` to bound execution. Each target plus its replayed prefix shares a ten-second timeout, with five seconds available for each container cleanup. The Python bridge has a three-minute outer deadline. Source retrieval is independently bounded by the snapshot limits. `--max-blocks 0` exercises selection and persistence without executing examples, but still requires the database and GitHub access.

A unique local report is written under `.groundskeeper/verifications/` before the immutable database `VerificationRun` is stored against the owning analysis. Storage checks installation, repository, commit, and evidence selection. The analysis report remains unchanged; its candidate-drift findings and execution verdicts are separate records. A failed example or unavailable Docker still produces stored evidence; infrastructure errors remain `unknown`.

Each explicit invocation is a new execution attempt with a new report ID. Replaying the exact same report through the storage function is idempotent, while conflicting reuse of its ID is rejected. If database persistence fails after execution, the local artifact is retained; explicit recovery is available through `pnpm verify:import` (see [evidence recovery](docs/EVIDENCE_RECOVERY.md)). Nothing is written to GitHub. Exit codes match the local verifier: 0 for no observed failures (possibly empty/skipped work), 1 for failed examples, and 2 for infrastructure/input/persistence errors.

This command is development tooling with local database credentials, not a public multi-tenant API. Live GitHub/Postgres/Docker integration validation is still pending on the initial machine.

## Change-budget promise

Groundskeeper never commits directly to a repository's default branch. Proposed changes must use a `groundskeeper/<proposal-prefix>` branch for review. Default per-run limits are **3 pages, 1 PR, and 150 changed lines**. Zero budgets disable changes.

The explicit repair publisher requires fresh independent verification, atomic database budget reservation, a fenced publication lease, exact base/head checks, and an explicit proposal approval ID. It only creates review branches and draft PRs. Failed verification produces a blocked local artifact. See [commands, limits, and partial-failure recovery](docs/REPAIR_WORKFLOW.md).

## Workspace and checks

| Path | Responsibility |
| --- | --- |
| `apps/github` | Probot ingress and change-budget guards |
| `packages/contracts` | Generated JSON schemas and TypeScript types |
| `packages/parser` | remark Markdown/MDX extraction and JSON CLI |
| `packages/database` | Prisma schema, initial migration, persistence smoke test |
| `services/analysis` | Pydantic models, tree-sitter symbols, drift analysis, Docker verifier, FastAPI/CLI |
| `examples/demo` | Small reproducible before/after fixture |

Pydantic models are the wire-contract source of truth. After editing them, run `pnpm contracts` and commit the generated files. Prisma maps those entities into relational storage, with database IDs separate from document/symbol stable keys. Cross-language integration tests exercise real parser output through Pydantic.

```sh
pnpm check
pnpm build
uv run ruff format --check .
```

CI runs those checks, verifies contract regeneration, applies the migration to Postgres, exercises persistence and webhook deduplication, and runs the demo. It also pulls the explicit Python runtime and runs real Docker execution/isolation tests. Locally, the Postgres smoke test is skipped unless `DATABASE_TEST_URL` is supplied; it rolls back its test transaction. Real Docker tests require `GROUNDSKEEPER_DOCKER_TEST=1`. No live GitHub installation is needed for webhook signature/routing tests.

## Next work

1. Validate queue leasing and crash recovery against live Postgres/GitHub, then add installation/full-index lifecycle jobs.
2. Validate stored-run verification against live services, then extend runtime/dependency configuration, TypeScript, CLI assertions, and links.
3. Build and inspect a permissively licensed public-repo corpus; generate labeled mutations and report precision/recall. The demo is not a substitute for this evaluation.
4. Validate the implemented repair drafts, independent QA, atomic publication reservation and draft PR recovery on a development repository; then expand repair coverage using measured failures.

A local read-only dashboard is now implemented by explicit scope expansion. Screenshots of external pages, wiki/CMS connectors, and the long-running maintenance loop remain deferred.

## Active iterations and evaluation

The [active plan](docs/active-plan.md) sequences incoming-change analysis, execution evidence, public-repository evaluation, then reviewable repairs. Run `pnpm eval` for the deterministic synthetic drift gate: 18 cases and 36 labels, covering both Python and TypeScript. Its baseline is 10 true positives and 26 true negatives with no mismatches; these are small synthetic fixtures, not evidence of public-repository accuracy. See [evaluation details](docs/evaluation.md).

## Setup readiness and handoff

The [project handoff](docs/PROJECT_HANDOFF.md) records what is implemented, what has been validated, and detailed steps for provisioning services and running a GitHub-to-verification smoke test. Start here when resuming work.

```sh
pnpm run doctor
pnpm run doctor --mode integration
pnpm run doctor --mode github
pnpm test:integration
```

Use `pnpm run doctor` explicitly: `pnpm doctor` invokes pnpm's own built-in command. Local mode checks development tools; integration mode requires Docker and an explicit `DATABASE_TEST_URL`; GitHub mode checks database connectivity and local App credential syntax. None creates services or proves remote GitHub access. The integration command fails when prerequisites are missing instead of silently skipping service tests.

The root database and GitHub commands load the workspace `.env`, preserving exported variables. `PRIVATE_KEY` accepts multiline, escaped-newline or base64 PEM; alternatively set `PRIVATE_KEY_PATH` to an absolute or workspace-relative PEM file. Start ingress with `pnpm github:dev`; inspect migrations with `pnpm db:status`.

## Visual workspace

Run `pnpm dev` to open the new Next.js dashboard. The default sample workspace works without GitHub, Postgres or Docker. It includes searchable analysis runs, evidence dialogs, repository drill-down, queue monitoring, JSON exports, and explicit live-data connection settings. Refresh failures retain the last loaded view; invalid responses never replace valid data.

The interface uses TypeScript, Tailwind v4, shadcn/ui, Lucide, Motion and a selective Magic UI component. Read the [dashboard guide](docs/DASHBOARD.md) for live connection setup, fallback behavior and remaining work. The web app reads `apps/web/.env.local`; worker commands still read the root `.env`.

```sh
pnpm dev
pnpm exec playwright install chromium
pnpm test:web
```

The browser suite builds and tests the production app, including mobile/reduced-motion behavior, evidence-dialog keyboard focus, failure recovery, and an unavailable live database. Live success against Postgres/GitHub remains pending. The local dashboard is read-only and is not a hosted multi-user authorization system.
