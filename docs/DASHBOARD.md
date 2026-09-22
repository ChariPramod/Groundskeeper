# Groundskeeper dashboard

The dashboard is a read-only workspace for the pipeline built in previous iterations. It uses Next.js App Router, TypeScript, Tailwind CSS v4, shadcn/ui Button and Dialog primitives, Lucide icons, Motion transitions and a selectively used Magic UI Number Ticker. Its warm green visual system, repository cards, responsive navigation and evidence views are implemented locally in `apps/web`.

## Run it

From the project root:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev
```

Open the local URL printed by Next.js (normally http://127.0.0.1:3000; an occupied port causes Next.js to choose the next available one). The server binds to loopback. The default demo uses four repositories, seven analysis runs and four queue deliveries. All sample data is visibly labeled and uses a fixed timestamp; it is not activity from a GitHub account.

For the production build:

```sh
pnpm build
pnpm web:start
```

There are no runtime font, image, or component-CDN dependencies. Dependencies must be installed before building.

## What you can do

- Review counts, runs with evidence and items needing attention.
- Search repository names, run IDs or commit hashes; filter runs by status; press `/` to focus search.
- Open a run for commit IDs, affected/indexed claim counts, bounded documentation excerpts, impact context and execution outcomes. Add browser-local owner, notes and dismissal; these do not alter execution evidence. Escape closes the dialog and focus returns to its trigger.
- Select a repository to scope the activity list.
- Inspect pending, processing, retrying and terminal deliveries in the work queue.
- Export the loaded dashboard snapshot as JSON. The filename and content retain the demo/live label. This is a summary export, not the complete underlying verification artifact.
- Review repair artifacts by SHA-256 in the Repairs workspace, including before/after pages and recorded evidence summaries.
- Refresh data, configure the connection, or explicitly explore a sample workspace.

Queue retries and execution remain explicit CLI operations. The interface does not create branches or PRs, run examples, or modify repository content. `Verified` summarizes recorded example outcomes; it does not certify an entire repository. Evidence coverage is the proportion of the loaded recent runs that contain evidence, not code coverage or an accuracy score. Impact flags remain conservative even when some examples pass.

## Connect saved data

1. Configure Postgres, generate the client and apply all migrations using the root commands documented in `PROJECT_HANDOFF.md`.
2. Produce at least one persisted analysis using the GitHub worker. Verification is a separate command.
3. Copy `apps/web/.env.example` to `apps/web/.env.local` if that local file does not already exist. Set `DASHBOARD_MODE=live`, the positive numeric `DASHBOARD_INSTALLATION_ID`, a strong `DASHBOARD_ACCESS_TOKEN`, and `DATABASE_URL`.
4. Restart the web server. Open Connection settings and enter the same access token.

The web app uses Next.js environment loading from **apps/web/.env.local**, while the worker and database wrappers use the root `.env`. Exported environment variables can also be used. Never put these credentials in `NEXT_PUBLIC_*` variables. The browser keeps the entered token only in React memory for the current tab; a reload clears it.

Live requests require a constant-time checked Bearer token. The server scopes repository, run and queue queries to the configured installation and limits each collection to 50 records. Runs use the most recent stored verification and display at most 100 evidence summaries. The overview omits source text. Detail routes return bounded documentation excerpts or reviewed before/after pages; sandbox stdout/stderr, webhook payloads and raw error messages are not returned. Responses disable caching. Repositories without a persisted analysis are not yet discovered by this dashboard.

This is a local operator interface with a shared access token, not a hosted multi-user product. User accounts, per-user sessions, deployment access controls and rate limiting remain future work. No live GitHub or Postgres integration has been validated on the original development machine.

## Fallback and recovery behavior

- Demo mode is the explicit default. Selecting demo while connected is an explicit user choice.
- Live mode without complete configuration returns a safe error and never silently returns fixtures.
- API failures, lost connectivity, a ten-second request timeout, invalid JSON and invalid response shapes preserve the last successfully loaded in-memory view.
- The UI shows that retained data may be stale and offers a retry. A failed initial connection offers connection settings and demo exploration.
- Database connections have bounded connection/pool/transaction timeouts and disconnect after the read.
- Empty data and no search matches have distinct empty states. A page-level error boundary offers recovery if rendering fails.
- Clipboard failure leaves the selectable run ID visible for manual copying.
- Motion respects reduced-motion preferences; native CSS also reduces animations and transitions.

## Tests

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:web
```

`test:web` builds the production web app and runs Chromium tests against separate loopback servers on ports 4173 (demo) and 4174 (live configuration pointing at an intentionally unavailable local database). It covers search/filter clearing, repository drill-down, evidence dialogs, queue navigation, JSON export, backend and malformed-response recovery, mobile navigation/overflow, reduced-motion hydration, and explicit fallback from an unavailable live database. It does not require GitHub, Docker or Postgres. A fresh Linux CI worker may need `pnpm exec playwright install --with-deps chromium`.

Data tests cover installation scoping, authentication, safe errors, bounded queries, evidence projection and request/DTO validation. Actual PostgreSQL execution remains part of the separate service-validation milestone.

## Remaining iterations

1. Validate live dashboard reads alongside the real GitHub → analysis → verification smoke test.
2. Add cursor pagination and repository discovery beyond the latest bounded view.
3. Add operator actions only behind deliberate authorization, with job progress, idempotency and audit records.
4. Add hosted user/session authorization before exposing this interface beyond local use.
5. Expand artifact inspection beyond the implemented repair diffs and bounded claim details, preserving output redaction and tenant ownership.

Component provenance: [shadcn/ui](https://ui.shadcn.com/docs/installation/manual) Button and Dialog and [Magic UI Number Ticker](https://magicui.design/docs/components/number-ticker) were installed from their public registries; upstream licenses are retained beside the components. [Motion reduced-motion guidance](https://motion.dev/docs/react-use-reduced-motion) informs the accessible animation behavior. Project-specific layout and botanical artwork use local CSS.

## Detailed review and repair recovery

Review APIs share installation/token authorization and validate bounded response shapes. A failed detail request leaves the loaded overview usable. Local annotations use keys scoped by mode, run and repository; blocked browser storage falls back to memory with a visible notice. These annotations are not shared or auditable server state.

The Repairs view reads only immutable local artifacts by their full SHA-256 digest. The server rejects malformed, altered, oversized, nonregular or cross-installation artifacts. A failed lookup retains the previous view with a stale/error notice and hides its publish command. Switching credentials or mode clears retained live artifacts. Demo repair pages are explicitly illustrative. Publication always runs through the CLI with fresh verification; a displayed recorded state alone is insufficient. See [REPAIR_WORKFLOW.md](REPAIR_WORKFLOW.md).

The production Chromium suite now has 12 tests, including annotation persistence/storage failure, repair lookup recovery and unavailable review details. Successful real database access still needs external-service validation.
