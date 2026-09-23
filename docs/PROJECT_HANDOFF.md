# Groundskeeper: implementation and operator handoff

Updated: **September 21, 2026**. This document describes the current implementation, evidence available so far, and the remaining setup and product work. It complements [README.md](../README.md), [the active plan](active-plan.md), and [the original execution plan](../Groundskeeper%20Execution%20Plan.md).

## 1. Where the project stands

Groundskeeper can identify documentation claims, connect them to changed Python/TypeScript code, and explicitly execute opted-in Python examples to collect evidence. A GitHub push can enter a durable inbox, become a commit-pinned analysis report, and then be explicitly verified with evidence saved locally and in Postgres.

The bounded repair workflow is now implemented: output-assertion repair proposals, manual page replacements, independent baseline and patched verification, immutable artifacts, atomic publication reservation, and explicit draft PR creation. Detailed review, local annotations, repair diffs, explicit PR analysis and neutral GitHub checks are available. Production scheduling, general automatic rewriting and hosted user authorization remain pending. No model API key is needed. See [REPAIR_WORKFLOW.md](REPAIR_WORKFLOW.md) for exact commands and recovery rules.

The most valuable next milestone is a real development-installation run through GitHub, Postgres, and Docker. Until that succeeds, unattended publication would build on an unproven operational path.

## 2. What has been built

| Area | Implemented behavior | Important boundary |
| --- | --- | --- |
| Documentation parser | Markdown/MDX paragraphs, list/admonition content, table rows, images, fenced code, headings, links, positions and stable claim IDs | Structural claim candidates; no semantic sentence-level truth detector; MDX is parsed, not evaluated |
| Symbol extraction | Python and TypeScript/TSX declarations through tree-sitter | Imports/re-exports, overload resolution, general configuration and CLI schemas are not modeled |
| Linking and drift | Identifier/path linking, ambiguity handling, renames, deletions, moves, body/default changes | Affected means “needs checking,” not “proven stale”; formatting-only changes are ignored |
| Local entry points | Index CLI, analysis CLI, reproducible demo, JSON reports and FastAPI analysis endpoint | API is local/internal and has no tenant authentication |
| Python execution | Explicit `groundskeeper:run` opt-in, expected stdout, bounded Docker execution, unique evidence files | Only Python source is copied; no network, implicit dependency installation or host fallback |
| Tutorial sessions | Page-scoped `groundskeeper:session=<name>`, source ordering, prefix replay, dependency-aware outcomes and budgets | Each step reconstructs state in a fresh container; setup must be deterministic |
| GitHub ingress | Signed Probot events, durable inbox, duplicate delivery handling, default-branch filtering | Push and PR analysis jobs are processed; installation lifecycle events remain pending |
| Push worker | Finite batch, installation authentication, exact commit snapshots, blob-hash checks, size/deadline limits, atomic leases, bounded retries, terminal recovery and replay recovery | Live concurrency checks, full indexing and continuous scheduling remain pending |
| Analysis persistence | Immutable reports, installation-scoped identity and delivery idempotency | Worker stores report snapshots rather than rebuilding mutable Page/Claim tables |
| Stored-run verification | Loads owned analysis, refetches its exact after-commit, selects affected code/session members, writes local artifact before persistence | Explicit invocation; not automatic on every push; unaffected prose/code is outside coverage |
| Evidence persistence | Immutable verification attempts, ownership/commit/claim/session integrity checks, idempotent report replay | Explicit `verify:import` validates and replays saved evidence without executing examples |
| Change limits | Validated contracts and preflight guards: 3 pages, 1 PR, 150 changed lines by default | Publisher enforces atomic reservation and independent QA; real PostgreSQL/GitHub validation pending |
| Quality checks | TS/Python tests, lint/type/format/build checks, generated contracts, synthetic drift evaluation, opt-in service tests in CI | Fixtures and simulated transports do not establish production accuracy or isolation |
| Visual workspace | Next.js/TypeScript/Tailwind v4 dashboard, searchable activity, evidence dialogs, repository drill-down, queue inspection and JSON export | Demo works locally; live reads require installation-scoped token setup; no browser mutations or hosted accounts |
| Operational tooling | `pnpm run doctor` readiness checks, `pnpm test:integration` explicit live-service gate, root-aware environment loading and flexible PEM configuration | These diagnose and test available services; they do not install Docker or register a GitHub App |

Earlier iterations additionally hardened claim identity when assertions/links change, bounded source snapshots, file-race handling, Docker output classification, and dependency propagation. These matter because a stale-looking document must not be “confirmed stale” just because infrastructure failed.

## 3. Implemented versus actually validated

The current iteration passed **294 tests** (191 TypeScript tests, 91 Python tests and 12 Chromium browser tests), plus lint, type checks, build, Ruff formatting and Prisma schema validation. **Ten service tests remain skipped locally** (five Postgres and five Docker). The explicit integration gate exits 2 with missing Docker and test-database prerequisites instead of reporting success. Successful live GitHub, Postgres and Docker behavior is still unvalidated on this machine. The browser suite did validate rejection of unauthorized access and explicit demo fallback when a deliberately unavailable database fails.

As inspected for this handoff:

- Docker and host `psql` are unavailable on this machine. Homebrew is present. Host `psql` is optional when using the Postgres container commands below.
- The current project directory has no Git repository metadata. Local tools can work, but commit/diff/remote and CI validation require a real checkout or deliberately initialized repository.
- Live GitHub installation authentication, end-to-end webhook processing, real Postgres persistence and real Docker execution are still pending here.
- CI is configured to run Postgres and Docker checks. A workflow file existing is not evidence that a remote CI run passed.
- `pnpm demo` has a deterministic target: **4 affected of 6 claims, 5 linked**.
- `pnpm eval` has 18 synthetic cases and 36 labels, with a baseline of 10 true positives and 26 true negatives. This is a regression gate, not a public-repository accuracy estimate.

Record the first successful integration run with its date, environment, command output, commit IDs and evidence IDs. Do not record secret values.

## 4. Where the implementation lives

| Path | Responsibility |
| --- | --- |
| `packages/parser/src/` | Markdown/MDX extraction and index CLI |
| `services/analysis/src/groundskeeper/` | Models, symbols, linking, drift, CLI/API, snapshots and execution |
| `services/analysis/src/groundskeeper/worker_analysis.py` | JSON bridge used by the TS worker |
| `services/analysis/src/groundskeeper/worker_verification.py` | Stored-run verification bridge |
| `apps/github/src/app.ts`, `main.ts` | Event routing and durable ingress |
| `apps/github/src/environment.ts`, `database-main.ts` | Workspace-root environment loading and database command wrapper |
| `apps/github/src/snapshots.ts` | Bounded commit-pinned GitHub source retrieval |
| `apps/github/src/worker.ts`, `worker-main.ts` | Push processing and finite queue runner |
| `apps/github/src/verify-run.ts`, `verify-main.ts` | Verification orchestration and CLI |
| `packages/database/src/analysis-runs.ts` | Analysis identity, transactions and idempotency |
| `packages/database/src/verification-runs.ts` | Evidence validation and immutable persistence |
| `packages/database/prisma/` | Schema and migrations |
| `packages/contracts/src/` | Generated JSON schemas and TS types; Pydantic is the source of truth |
| `examples/demo/`, `examples/tutorial/` | Reproducible before/after scenarios |
| `scripts/evaluate.py`, `docs/evaluation.md` | Synthetic regression evaluation |
| `.github/workflows/ci.yml`, `compose.yaml` | CI and local Postgres service |

Runtime flow:

```text
GitHub default-branch push
  -> signed Probot ingress -> WebhookDelivery
  -> explicit worker -> exact before/after snapshots -> parser + Python analysis
  -> immutable AnalysisRun -> delivery acknowledged
  -> explicit verify:run -> exact after-commit Python snapshot -> Docker
  -> unique local evidence JSON -> immutable VerificationRun
```

## 5. Your setup checklist, in order

The human-owned work is installing/starting desktop infrastructure, choosing the test repository, registering/installing the GitHub App, and supplying its credentials. The engineering backlog in section 10 remains implementation work that Codex can continue; you do not need to implement it manually.

### A. Establish the project checkout and dependencies

Use a real checkout of the intended project repository if one already exists. Preserve the current work when moving it; do not overwrite it with an older remote copy. If this is a new project, choose the remote and establish Git history before relying on CI or contract-diff checks. No remote URL has been assumed here.

From the Groundskeeper root:

```sh
node --version
pnpm --version
uv --version
pnpm install --frozen-lockfile
uv sync --locked
pnpm db:generate
pnpm run doctor
pnpm demo
pnpm eval
```

Use Node **22.17 or newer, below 25**, pnpm **10.33.0**, and uv. `.python-version` selects Python 3.12; `uv sync --locked` prepares the Python environment. CI pins Node 22.17.1 and uv 0.11.22. `db:generate` generates the Prisma client and does not require a running database.

`doctor` emits JSON without printing credentials and exits 0 when its selected mode's required checks pass, or 2 otherwise. It reports optional missing checks as well:

- `pnpm run doctor` (local): requires compatible Node, pnpm and uv. Missing Docker/GitHub/Git metadata does not make local readiness fail.
- `pnpm run doctor --mode integration`: additionally requires Docker, the daemon, cached `python:3.12-slim`, and a connection to the explicitly supplied `DATABASE_TEST_URL`.
- `pnpm run doctor --mode github`: additionally requires a connection to `DATABASE_URL` and locally valid App settings, including an RSA private key and webhook secret. It does not contact GitHub to prove installation access, and it does not require Docker.

`doctor` is also a pnpm built-in command, so include `run` exactly as shown to invoke this project’s readiness script.

Database connectivity is checked only for the database required by that mode. A configured URL reported as unverified in another mode is not a successful connection check. Connectivity uses `SELECT 1`; schema migrations are still a separate requirement. Git metadata is advisory in every mode. The full stored-run flow needs both GitHub-mode readiness and Docker readiness; passing one mode alone is insufficient.

For local quality checks:

```sh
pnpm check
pnpm build
uv run ruff format --check .
pnpm db:validate
```

Prisma schema validation needs a `DATABASE_URL` value but does not itself prove a database connection. Set the local URL from the next section if it is not configured yet. `pnpm check` can pass while service tests are skipped; use the explicit integration gate after provisioning services.

When Pydantic wire contracts change, regenerate them with `pnpm contracts`. In a Git checkout, inspect `git diff -- packages/contracts/src`; CI requires generated output to match tracked files. No Git metadata means this check cannot establish that generated files are committed.

### B. Start Docker and Postgres

Install and start a Docker-compatible runtime exposing the `docker` CLI and daemon, with Compose support. Confirm readiness before running tests:

```sh
docker version
docker compose version
docker compose up -d --wait
docker compose ps
docker pull python:3.12-slim
export DATABASE_URL='postgresql://groundskeeper:groundskeeper@localhost:5432/groundskeeper'
pnpm db:generate
pnpm db:migrate
pnpm db:status
```

The supplied Compose service runs Postgres 17, binds port 5432 to localhost, and persists data in `postgres-data`. These credentials are for local development. `db:migrate` uses `prisma migrate deploy` to apply existing migrations; it is not a reset. `pnpm db:status` reports applied/pending migrations. The root `db:generate`, `db:migrate`, `db:validate` and `db:status` scripts load the root `.env` before invoking Prisma; exported variables take precedence. Do not remove the volume when you intend to retain reports.

Create a separate integration-test database once:

```sh
docker compose exec -T postgres createdb -U groundskeeper groundskeeper_test
export DATABASE_TEST_URL='postgresql://groundskeeper:groundskeeper@localhost:5432/groundskeeper_test'
DATABASE_URL="$DATABASE_TEST_URL" pnpm db:migrate
pnpm run doctor --mode integration
pnpm test:integration
```

If `createdb` says the database already exists, keep it and continue. Use a dedicated disposable test database. The lease integration test creates and removes an isolated schema, so the test database user needs schema-creation permission. The integration gate requires an explicit test URL and available Docker instead of silently treating unavailable integration coverage as success. It is not necessary to install host `psql`; use `docker compose exec -T postgres psql` when inspecting this local database.

To exercise the existing service suites directly, with migrations already applied:

```sh
DATABASE_TEST_URL="$DATABASE_TEST_URL" pnpm test
GROUNDSKEEPER_DOCKER_TEST=1 uv run pytest services/analysis/tests/test_verification.py services/analysis/tests/test_tutorial.py -k real_docker
```

Success means the selected database and real Docker cases **ran and passed**, not that they were skipped. No GitHub credentials are required for these service tests.

### C. Inspect the local tutorial evidence

With the Python image present:

```sh
uv run groundskeeper verify --docs examples/tutorial/docs --source examples/tutorial/before
uv run groundskeeper verify --docs examples/tutorial/docs --source examples/tutorial/after
```

Expected code-block outcomes:

| Source | Expected evidence | Expected exit |
| --- | --- | --- |
| `before` | Three passed steps | 0 |
| `after` | Setup passed; step two failed expected stdout; step three skipped with `unknown` because its prerequisite failed | 1 |

The failing command is an intentional regression demonstration, not a failed setup. If Docker/image/cleanup fails, expect infrastructure `error` and exit 2 instead; that does not validate the expected regression behavior.

Three tutorial steps consume six execution units: 1 + 2 + 3. A fresh container replays the prefix for each target, so increasing session length increases cost. Runtime defaults allow ten units. Inspect the unique report under `.groundskeeper/verifications/`, including outcomes, per-claim statuses, source/claim digests, resolved image ID, stdout/stderr and limits.

### D. Register a development GitHub App

Choose a small test repository you control. Keep its docs and source in the same repository. Install the App only on that repository initially.

Configure repository permissions:

| Permission | Level | Purpose |
| --- | --- | --- |
| Metadata | Read-only | Repository identity |
| Contents | Read-only | Commit/tree/blob reads and push events |
| Pull requests | Read-only | Existing PR event ingress; PR processing is not built |

Subscribe to **Push** and **Pull request** events. The code also handles installation and installation-repository-selection events. The analysis/verification path needs no write permission. Optional `repair:publish` requires Contents and Pull requests write permission; explicit check publication requires Checks write permission. These commands are opt-in; the browser does not publish. GitHub documents how permissions control API and event access in [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) and [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

Set a webhook secret and generate/download the App private key. Record the numeric **App ID** separately from the **installation ID**; they are not interchangeable. The App ID authenticates the App, while the installation ID identifies its installed access to the test repository.

For a local development relay, create a Smee channel and set both the GitHub App's **Webhook URL** and local `WEBHOOK_PROXY_URL` to that channel URL. For a direct HTTPS tunnel or reachable server, configure the GitHub webhook URL to `https://<reachable-host>/api/github/webhooks` and omit `WEBHOOK_PROXY_URL`. Do not append that local path to a Smee channel URL. This distinction follows [Probot's development setup](https://probot.github.io/docs/development/).

Create `.env` from `.env.example` only if it does not already exist, and fill it in using an editor. Existing values should be preserved:

```dotenv
DATABASE_URL=postgresql://groundskeeper:groundskeeper@localhost:5432/groundskeeper
APP_ID=<numeric App ID>
PRIVATE_KEY=
PRIVATE_KEY_PATH=/absolute/path/to/downloaded-app-key.pem
WEBHOOK_SECRET=<your generated secret>
WEBHOOK_PROXY_URL=https://smee.io/<your channel>
```

Set `PRIVATE_KEY_PATH` to the actual downloaded PEM file; it may be absolute or relative to the workspace root. Alternatively, set `PRIVATE_KEY` to raw PEM, quoted multiline PEM, PEM containing literal `\n` escapes, or base64-encoded PEM. `PRIVATE_KEY` takes precedence when nonempty, so leave it blank when selecting a file path. All GitHub entrypoints and readiness checks use the same key-loading rules. Merely placing a PEM file in the directory does not select it: configure its path or value. `.env` and `*.pem` are ignored by the supplied `.gitignore`. Keep actual credentials out of documentation, terminal output and commits.

Ingress, worker, stored-run verification, doctor, integration checks and root database commands share workspace-root `.env` loading; already exported environment variables take precedence. Check settings, then run ingress from the project root:

```sh
pnpm run doctor --mode github
pnpm github:dev
```

Leave that process running. Use the App's recent delivery view to confirm deliveries are accepted. A valid webhook must first be persisted; a database failure should fail the request so the delivery can be retried.

### E. Perform one complete GitHub smoke test

Use two real, nonzero commits on the test repository's **default branch**. An initial push from an all-zero `before` SHA is not supported by the worker yet. Feature-branch pushes are intentionally ignored.

A predictable fixture is the tutorial already included here:

1. In your separate test repository, add `client.py` from `examples/tutorial/before/client.py` at its root, and the tutorial Markdown from `examples/tutorial/docs/quickstart.md` under `docs/quickstart.md`. Commit and push this baseline. Establish it before the App's first smoke-test change so it supplies a real before-commit.
2. Install the App on that test repository, if not already installed, and confirm ingress is running.
3. Change only the root `client.py` implementation to match `examples/tutorial/after/client.py` (`sent:` becomes `delivered:`). Keep the docs' expected output unchanged. Commit and push to the default branch through your normal permitted repository workflow.
4. In GitHub recent deliveries, inspect the push: its before/after values must be the two real commit SHAs, and the repository must match the installed test repository.
5. Process a finite batch from Groundskeeper's root:

```sh
pnpm worker --limit 5
```

6. Save the printed `Analysis run: <run-id> (installation <id>)`. Then run:

```sh
pnpm verify:run --analysis-run <run-id> --installation-id <installation-id>
```

7. Expect an artifact path followed by a stored verification ID and outcome counts. The changed `Client.send` claim should select the entire messaging session: setup passes, the changed output fails, and the dependent final step is unknown. Exit 1 is expected for this intentionally broken fixture.
8. Confirm the stored analysis has the exact GitHub before/after commits and the verification belongs to that analysis. The analysis remains unchanged; execution evidence is a separate record.

The worker reads Markdown/MDX/Python/TypeScript/TSX at exact commits and verifies blob hashes. It rejects truncated trees, invalid UTF-8 and oversized snapshots (1,000 files / 10 MB total, 2 MB per file). Source retrieval has a two-minute deadline, analysis a 60-second deadline, and the verification Python bridge a three-minute outer deadline. Start with a small test repository so size limits do not obscure the first integration result.

To inspect local database IDs without host `psql`:

```sh
docker compose exec -T postgres psql -U groundskeeper -d groundskeeper -c 'SELECT id, event, "processedAt", "attemptCount", "nextAttemptAt", "leaseExpiresAt", "failedAt", "lastError" FROM "WebhookDelivery" ORDER BY "receivedAt" DESC LIMIT 10;'
docker compose exec -T postgres psql -U groundskeeper -d groundskeeper -c 'SELECT id, "deliveryId", "beforeCommit", "afterCommit" FROM "AnalysisRun" ORDER BY "createdAt" DESC LIMIT 10;'
docker compose exec -T postgres psql -U groundskeeper -d groundskeeper -c 'SELECT id, "analysisRunId", "sourceDigest" FROM "VerificationRun" ORDER BY "createdAt" DESC LIMIT 10;'
```

A second explicit verification creates a new attempt ID. Redelivery of the same GitHub delivery must not create a second analysis. Keep local artifacts if persistence fails; they are written first, but explicit recovery is available via `verify:import`; see [EVIDENCE_RECOVERY.md](EVIDENCE_RECOVERY.md).

## 6. How to interpret results

| Evidence | Meaning | Operator action |
| --- | --- | --- |
| Affected claim in analysis | Linked implementation changed | Select it for verification/review; do not label stale from drift alone |
| `passed` / `verified` | Example exited successfully and matched any declared stdout | Trust only the checked block and runtime |
| `failed` / `stale` | Example errored or its stdout contradicted the assertion | Inspect the actual failure before proposing a repair |
| `error` / `unknown` | Runtime/infrastructure failure | Fix the environment and rerun; no documentation conclusion |
| `skipped` / `unknown` | Budget/dependency prevented evidence | Increase bounded coverage or address the predecessor |
| `skipped` / `unverifiable` | Unsupported or unannotated example | Add appropriate opt-in/support only when execution is meaningful |
| Empty stored-run report | No affected code was selected | Not evidence that all documentation is correct |

Exit 0 means no observed failures and may include skipped/empty work; exit 1 means failed examples; exit 2 means infrastructure/input/persistence failure. Assess coverage and statuses, not just the exit code.

`--max-blocks 0` on `verify:run` can exercise selection and persistence without executing examples, but still requires database and GitHub access. It is not a Docker integration test.

## 7. Success criteria for the first operational milestone

- [ ] Dependencies installed, Prisma client generated, local quality checks pass.
- [ ] Docker daemon and explicit Python image ready; migrations applied to development and test databases.
- [ ] `pnpm test:integration` runs the real service tests successfully without integration skips.
- [ ] Before/after tutorial evidence matches the expected outcomes above.
- [ ] App has only the required read permissions and is installed on the selected test repository.
- [ ] Signed default-branch push is durably received with two nonzero commit SHAs.
- [ ] Worker stores one owned immutable analysis and acknowledges the delivery afterward.
- [ ] `verify:run` stores commit-matched evidence, with the local artifact retained.
- [ ] Duplicate delivery does not create a duplicate analysis; explicit verification rerun gets its own ID.
- [ ] No GitHub content/branch/PR was created by Groundskeeper.
- [ ] The date, environment, run IDs, commit SHAs and redacted outputs are recorded as actual integration evidence.

## 8. Troubleshooting

| Symptom | Likely cause and next step |
| --- | --- |
| Prisma client import/generation error | Run `pnpm install --frozen-lockfile` and `pnpm db:generate` |
| Prisma URL/schema validation error | Provide `DATABASE_URL`; then distinguish schema validation from connectivity |
| Connection refused on 5432 | Check `docker compose ps`, database URL, and whether another local service owns the port |
| Missing table/column | Apply `pnpm db:migrate` to the exact URL used by that command/test |
| Docker unavailable/image missing | Start daemon and explicitly pull the selected image; there is no host-execution fallback |
| Python import error in example | Put Python source at the expected snapshot path; dependencies must already be in a trusted selected image |
| Tutorial later step unknown | Inspect the first failing/skipped predecessor and replay budget; this is deliberate cascade prevention |
| No webhook recorded | Check App installation, event subscriptions, relay/direct URL, signature secret and ingress process |
| Worker sees no pending pushes | Check default branch, event type, processed status, active lease, terminal status and five-minute retry cooldown |
| Pending installation or PR events remain | PR jobs now process by default; installation lifecycle events remain pending. Legacy PR events without pinned commits are ignored. |
| Initial push repeatedly fails | All-zero before commit is unsupported; produce a later default-branch change with real before/after SHAs |
| GitHub auth/repository error | Check App ID versus installation ID, actual PEM contents or configured key-file path, selected repository access and read permissions |
| Worker reports only an error class | Source/secret-bearing details are deliberately not retained in inbox error messages; inspect delivery identity and readiness first |
| Analysis exists but evidence does not | Verification is an explicit separate command; confirm ownership and exact run ID |
| Artifact exists after persistence failure | Retain it; investigate DB failure. A new explicit run is a new attempt; use `verify:import` with the original analysis, installation, artifact and checksum |
| Test command passes but service tests skipped | Supply explicit test DB URL and use `pnpm test:integration`; ordinary checks are insufficient |
| Contract diff/CI cannot run locally | This directory lacks `.git`; establish the intended checkout without losing current work |

Workers now atomically claim one delivery at a time with a ten-minute lease and use its token to fence persistence, acknowledgment and failure updates. Failed attempts wait five minutes; the fifth claimed attempt becomes terminal on failure, or after its lease expires and a subsequent claim performs cleanup (up to 100 exhausted rows per claim). Crashes consume an attempt. An expired process can still compute, but stale tokens cannot write results or change queue state. There is no heartbeat or automatic cancellation; live PostgreSQL concurrency testing remains pending on this machine.

Apply the new delivery-lease migration with `pnpm db:migrate`. Inspect pending/leased/terminal metadata (up to 100 oldest unprocessed pushes), resolve the cause, then explicitly retry a terminal delivery:

```sh
pnpm queue --installation-id <installation-id>
pnpm queue --installation-id <installation-id> --retry-failed <delivery-id>
```

The retry command resets the five-attempt budget only for an unprocessed terminal push owned by that installation. It preserves the original payload and any stored analysis; a matching persisted run can be acknowledged on retry without recomputation. GitHub redelivery alone does not reset terminal state. These local database operator commands are not a hosted tenant authorization layer.

## 9. Choices you need to make

1. **Development repository and account:** choose the repository used for the first App installation and smoke test; select your own account or organization with appropriate administrative access.
2. **Local runtime:** install/start Docker-compatible infrastructure and allocate enough resources for Postgres plus bounded Python containers.
3. **App credentials and delivery route:** register/install the App, keep its credentials locally, and choose Smee or a direct HTTPS endpoint.
4. **Project Git home:** establish the intended repository/remote for this workspace so work can be committed and CI run.
5. **Evaluation targets after integration:** choose a few representative repositories and documentation patterns you care about, with suitable licenses. Codex can inspect, build the corpus and implement improvements.

You do not need a production deployment, model key, paid sandbox service, GitHub write permissions or dashboard to validate the current milestone.

## 10. Engineering still to do, by priority

### P0: finish validating the existing pipeline

Run and record the real service suites and one installed-App flow. Investigate failures and add regression coverage for actual problems. A development smoke test is separate from production readiness. The new readiness/integration commands reduce setup ambiguity but cannot prove services that are absent.

### P1: make worker operation reliable

Atomic queue leases, bounded attempts, terminal markers, safe metadata inspection and explicit retry are now implemented. Validate the new PostgreSQL concurrency/crash-recovery tests against real services, then add adaptive backoff, error classification and long-running scheduling as needed. Process installation/uninstallation/repository-selection lifecycle changes. Add full indexing for initial/all-zero-before pushes. Acceptance: multiple workers do not execute one lease simultaneously, abandoned leases recover, and revoked installations cannot continue work.

### P1: recover execution evidence safely

Implemented `verify:import`: bounded checksum-checked reads, pinned GitHub source validation, claim/session/evidence checks, and immutable idempotent persistence. No Docker execution or GitHub writes occur. See [EVIDENCE_RECOVERY.md](EVIDENCE_RECOVERY.md). Hosted storage and signed provenance remain future work.

### P2: increase useful verification coverage

Add explicit runtime/dependency configuration, carefully scoped non-code fixtures, TypeScript execution, CLI assertions and link checks. Measure which coverage offers the most value before expanding languages. Maintain clear infrastructure-versus-example failures and bounded execution costs. Never interpret skipped work as correctness.

### P2: establish real detection quality

Build a permissively licensed public-repository corpus; inspect claim/link samples and labeled mutations. Report precision, recall, false-stale rate and execution coverage. Use measured failures to improve linking/import resolution. Synthetic cases remain regression controls, not headline product accuracy.

### P3: validate and expand the implemented repair workflow

Bounded proposals, independent QA, durable atomic publication reservation and evidence-bearing draft PRs are implemented. Follow [REPAIR_WORKFLOW.md](REPAIR_WORKFLOW.md) on a development repository after applying migrations. Test lost-response recovery and stale-head rejection before unattended use. Automatic repairs currently change expected output assertions only; other edits require reviewed full-page replacements. Shared review history, fork PR analysis and supervised worker scheduling remain future work.

### Production and later scope

Service authentication/authorization, complete tenant access controls, hosted sandbox isolation, credential operations, monitoring, retention, migrations/deployment operations and a durable scheduler are required before a hosted product. The local read-only dashboard was added at your explicit request. Hosted UI accounts, external-page screenshots, CMS/wiki connectors and long-running autonomous maintenance remain deferred.

## 11. Recording the next handoff

After a real integration run, append the date, project commit, OS/runtime versions, selected test repository, analysis and verification IDs, before/after commit SHAs, exact commands, observed outcomes, and remaining failures. Link the evidence artifacts through an appropriate private location rather than committing source-bearing reports or credentials. Keep implementation status and validated status separate when updating this document.

## 11. New visual workspace iteration

A working interface is now in `apps/web`, with responsive desktop/mobile layouts, shadcn/ui dialogs/buttons, Lucide icons, Motion transitions, a Magic UI number ticker and a local CSS botanical illustration. Start it with `pnpm dev` and open the loopback URL printed in the terminal. No service configuration is necessary for the clearly labeled sample workspace.

You can filter/search runs, inspect execution evidence and commits, open repository-specific activity, monitor queue state and download the loaded JSON summary. The backend serves a bounded read-only projection of saved records. It checks a Bearer token and installation ownership for live reads. It never returns webhook payloads, claim source text, raw errors or sandbox output.

Fallbacks cover absent services, authentication/configuration errors, request timeouts, invalid JSON and invalid DTOs, empty results, page errors and unavailable clipboard access. Refresh errors retain the current in-memory data and show an error; they never silently turn a live result into a sample. Demo exploration is an explicit choice. The browser keeps the token only in memory.

**Your next UI steps:**

1. Explore the default interface with `pnpm dev`.
2. Follow the existing Postgres/GitHub setup and persist a real analysis/verification.
3. Configure `apps/web/.env.local` with `DASHBOARD_MODE=live`, `DASHBOARD_INSTALLATION_ID`, `DASHBOARD_ACCESS_TOKEN` and `DATABASE_URL`. These server-only values must not use a `NEXT_PUBLIC_` prefix.
4. Restart the server and enter the token in Connection settings. Compare the displayed run/commit IDs with the saved reports.
5. Run `pnpm test:web` after installing Chromium with `pnpm exec playwright install chromium`.

The [dashboard guide](DASHBOARD.md) contains exact startup commands, component provenance, data limits, failure behavior and browser-test details. Engineering still needed: live successful-read validation, cursor pagination, repository discovery before first analysis, shared review history, and proper user/session authorization before hosting. Executing examples, retrying deliveries or creating repair PRs from the browser is not implemented.

## 12. Repair iteration handoff — September 21, 2026

The [repair workflow guide](REPAIR_WORKFLOW.md) documents all new commands, artifact identities, approval IDs, permissions, budgets and failure recovery. The Repairs dashboard shows before/after documentation; run details show excerpts, impact context and local owner/note/dismissal controls. Local annotations are browser-only, not a shared audit trail.

What you need to do, in order:

1. Complete Docker, database and development App setup above, then apply **all** migrations with `pnpm db:migrate`, including `202609210002_repair_publication`.
2. Run `pnpm test:integration` with a dedicated `DATABASE_TEST_URL` and the documented runtime image. Record successful service output; the ten skipped service tests are not proof of operation.
3. Complete the default-branch analysis smoke test and note the installation and analysis IDs.
4. Prepare a repair, inspect the exact artifact and its evidence, and verify the proposed page changes in the Repairs view or CLI. An unavailable runtime must remain blocked; `repair:demo` demonstrated this locally.
5. For a deliberate development-repository publication, grant the optional write permissions, approve the exact proposal ID and run the guide's publish command. Confirm a draft PR, unchanged default branch, and reuse on retry. No actual GitHub publication has been performed during implementation.
6. Analyze a same-repository open PR using `pr:analyze`. Add `--publish-check` only when you want the neutral informational check posted. Fork PRs and background PR event processing are unsupported.
7. Establish the project Git remote and run CI before deploying. Keep the dashboard local until per-user authorization and deployment controls exist.

Missing Docker produced a saved blocked proposal with infrastructure evidence; no host fallback or remote write occurred. Fresh verification is required even when publishing a previously verified artifact. If a remote operation partly succeeds, retry the same artifact so its deterministic branch/PR can be reconciled; do not manually free a reservation without investigating remote state.

## 13. Hosted preview — September 22, 2026

A Vercel demo deployment is available temporarily at https://temporary-racing-aurora-75uu7zy.vercel.app; claim it using the private link in the deployment conversation before expiry to retain it. See [DEPLOYMENT.md](DEPLOYMENT.md) for packaging, redeployment, and remaining live-service boundaries. No GitHub or database credentials were deployed. The actual analysis worker and Docker runtime still require the separate setup above.

## 14. Public source and continuous deployment — September 22, 2026

The project now has Git metadata and a public origin at https://github.com/ChariPramod/Groundskeeper. The claimed Vercel project is connected to GitHub and uses `apps/web` as its root. Earlier notes that this workspace lacks Git metadata are historical. See [DEPLOYMENT.md](DEPLOYMENT.md) for build settings and the boundary between the hosted demo and live worker infrastructure.

### First successful remote service validation

[GitHub Actions run 35793655067](https://github.com/ChariPramod/Groundskeeper/actions/runs/35793655067) passed on September 22, 2026 for commit `20aa9b5`: 196 TypeScript tests including five PostgreSQL tests, 91 Python tests, 12 production Chromium checks, four real Docker verification/isolation tests, and one real Docker repair test (304 total). Migration application, contracts, lint, types, builds, formatting, demo and evaluation also passed. The five Docker tests skipped by the ordinary test command ran successfully in the separate Docker steps. This supersedes the earlier lack of service-test evidence, while installed GitHub App end-to-end analysis and actual repair PR publication remain unvalidated.

## Evidence recovery iteration

Added safe explicit import of saved verification artifacts and atomic content-addressed evidence writes. The command preserves report identity and outcomes, validates authoritative source and claims, and relies on transaction-scoped ownership and replay checks. Operator steps and older-artifact compatibility are in [EVIDENCE_RECOVERY.md](EVIDENCE_RECOVERY.md).

## Presentation readiness

Added `/walkthrough`, a shareable five-step illustrative scenario with an unavailable-runtime path and reset control. It uses the existing repair demo fixture, never executes examples or publishes changes, and links back to the dashboard. [PRESENTING.md](PRESENTING.md) supplies a three-minute script, capability boundaries, common questions and the prioritized live-pilot checklist. This makes the implemented prototype easier to present; it does not close the live App/worker deployment or multi-user production gaps.

## PR worker product iteration

Connected signed pull-request inbox events to the finite analysis worker. Default processing covers both push and PR events in oldest-first order. PR processing pins event commits, uses the merge base, stores reports before acknowledgment, and shares event-scoped leases, crash recovery, terminal retries and immutable persistence. See [PULL_REQUEST_WORKER.md](PULL_REQUEST_WORKER.md) for deployment steps, ignored-event rules and remaining operational gaps. No presentation features were added in this iteration.
