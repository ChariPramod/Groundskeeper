# Product readiness and remaining work

## Implemented in this increment

- Evaluation now covers 38 authored cases across 19 categories in Python and TypeScript. Reports include category/language confusion matrices, a corpus hash, and independent safety gates. Mutation tests prove that false verification, overconfident ambiguity, and silently accepted malformed syntax fail evaluation. This is regression evidence, not a claim of accuracy on unseen public repositories. See [evaluation](evaluation.md).
- Background analysis has a supervised process: sequential batches, bounded execution time, graceful shutdown, capped retry delay, and HTTP liveness/readiness. Durable delivery leases and fencing remain the recovery mechanism. Push and pull-request work both appear in the queue. See [worker operations](WORKER_OPERATIONS.md).
- Team access uses GitHub OAuth with PKCE, signed short-lived state, secure cookies, hashed server-side sessions, and explicit installation membership by numeric GitHub identity. Revoking membership deletes sessions; expired sessions and cross-installation access are denied. Partial OAuth configuration fails closed rather than enabling the shared-token path. See [team access](TEAM_ACCESS.md).
- `/api/health` distinguishes demo from live readiness. Live readiness requires valid authentication configuration and reachable database tables. It does not prove GitHub permissions or worker health.
- CI checks the production Next server against real PostgreSQL, tests session isolation/revocation, builds the worker container, and retains the evaluation report. The production-server smoke test uses isolated test records and verifies authenticated data and tenant isolation without mocking API responses.
- Vercel configuration no longer forces demo mode. Default behavior remains demo until an operator explicitly supplies live configuration.

## Infrastructure needed from the account owner

1. Choose/connect PostgreSQL and a persistent worker host. Neon and Railway were suggested. The owner has confirmed **free tiers only ($0 paid spend)**; account connections are still pending. Do not upgrade plans, enable paid overages, or assume trial credits sustain an always-on worker. Railway currently provides $1/month credit after its limited trial; verify quota behavior before deployment and allow processing to pause at the free limit. See [Railway free-plan terms](https://docs.railway.com/pricing/free-trial). Do not place credentials in git or chat: configure secrets in the hosting services.
2. Configure a GitHub App installation and its credentials for webhook ingress and background repository reads. Supply the webhook secret to ingress, and the App identity/private key to the worker through secret storage.
3. Configure the database connection in web, ingress, and worker runtimes; run `pnpm db:migrate` before enabling live mode.
4. Register a GitHub OAuth application with the deployed origin and `/api/auth/callback`. Configure the values listed in `TEAM_ACCESS.md`, then grant the first member with `pnpm team:access`.
5. Set `DASHBOARD_MODE=live` and the installation ID only after the database, membership, and OAuth settings are ready. The deployed demo does not demonstrate hosted repository processing.

## Required acceptance checks after provisioning

- Sign in through GitHub as an approved member; confirm an unapproved identity is denied. Revoke an active member and confirm their next data request is denied.
- Deliver a signed push and a pull-request event to hosted ingress. Observe each traverse the durable queue and appear in the hosted dashboard with its pinned commits.
- Restart the worker during processing, wait for lease recovery, and verify one stored result without duplicate publication. Exercise database outage/recovery and terminal retry handling.
- Configure external alerts for readiness failure, expired leases, terminal failures, and queue age. Establish backup retention and perform a database restore drill.
- Record deployed revisions, timestamps, delivery IDs, results, and the observation window. A CI production-server test is not a hosted end-to-end soak test.

## Product work remaining

- Shared ownership, notes, and status now persist for OAuth team sessions with optimistic version conflicts and an actor audit trail. See [shared reviews](SHARED_REVIEWS.md). Hosted acceptance remains pending; demo and token-only sessions retain local annotations.
- Viewer/reviewer/admin roles restrict shared edits. Admins can now manage membership in the web workspace with version conflicts, last-admin protection, atomic access history, and session revocation. The operator CLI bootstraps the first admin and uses the same audited change engine. Invitation delivery, organization synchronization, and a complete audit-export workflow remain future work.
- Add a held-out, versioned public-repository evaluation corpus and separately measure execution correctness and recovery behavior.
- Hosted sandbox verification needs an appropriately isolated execution service. The analysis worker deliberately has no Docker socket and does not execute repository examples.
- Repair artifacts still live on the operator filesystem; durable artifact storage, retention, and hosted retrieval remain required for a fully hosted repair workflow.

Nothing is described as break-proof. Tests cover specific safety and recovery properties; hosted operational claims require the acceptance evidence above.

## Validation record (2026-09-22)

Local validation passed lint, TypeScript checks, production Next build, 238 TypeScript tests (eight service-dependent tests skipped), 109 Python tests (four Docker tests skipped), the authored evaluation gate, and 14 dashboard browser tests. Additional authentication tests exercise bounded database transactions and sanitized timeout failures.

GitHub CI exercised the new real PostgreSQL production-server/browser smoke successfully on `b1e311c`. Vercel deployed that revision successfully; a browser check loaded five demo rows without page errors. Public health returned `mode: demo`, `liveReady: false`; the unconfigured OAuth endpoint returned 503 as intended. These observations verify the hosted demo, not a live GitHub installation or background worker. See subsequent CI runs for final container and service validation of the latest revision.

## Workflow iteration — October 2026

- [Review inbox](REVIEW_INBOX.md): server-side owner, repository and review-status filters with stable cursor pagination. Shared notes remain OAuth-only; permission denial clears previously loaded inbox data.
- [Operations center](OPERATIONS_CENTER.md): installation-scoped aggregate queue counts, failed/stalled delivery diagnostics, and operator recovery commands. Counts cover the matching queue, not only the dashboard's latest 50 rows. Worker health stays unknown without a recorded heartbeat.
- Viewer/reviewer/admin roles, immediate privilege changes, and safe current-session identity.
- Keyboard quick actions (`Ctrl+K` / `Cmd+K`) for navigation and searching loaded runs; accessible focus, empty results, and keyboard selection.
- Hosted production-server smoke coverage now includes role downgrade/elevation, inbox authorization and filters, operations tenant isolation, and output redaction.

Before live activation, apply both the shared-review and role migrations with `pnpm db:migrate`. New UI features can be explored in the explicitly labeled demo while infrastructure connections are deferred. No paid service was provisioned in this iteration.

## Architecture, query and storage iteration — October 2026

Implemented:

- [Overall architecture](ARCHITECTURE.md) and [query/response architecture](QUERY_RESPONSE_ARCHITECTURE.md), with editable Mermaid sources and accessible SVG exports. These cover ingestion, worker recovery, authorization, filtered reads, versioned writes, and actual deployment boundaries.
- Database-generated compact analysis/verification summaries. Dashboard and inbox queries select summaries; detailed evidence still uses the immutable original reports. All evidence contributes to verdict flags even when only the first 100 outcomes are displayed. Invalid summary versions fail closed.
- Composite indexes for ordered repository runs, latest verification, tenant queues, and installation-scoped expiry cleanup. Replay checks and report inserts return only the required identity/digest fields.
- Explicit UTC timestamp defaults and UTC lease/expiry comparisons, tested in database sessions west and east of UTC. Existing historical timestamps are preserved: if a previous deployment used non-UTC PostgreSQL sessions, investigate its historical clock offset separately instead of blindly shifting all records.
- `pnpm db:maintenance`: storage diagnostics and a dry run by default, with bounded, installation-scoped expired-session cleanup behind `--apply`. It preserves reports, audit history and delivery replay protection. See [maintenance instructions](STORAGE_MAINTENANCE.md).
- Eight personal saved inbox views with named filters, update/delete, installation/user isolation, and visible browser-storage fallback. A changed session scope resets the inbox, pending reads, drafts, and preset list. These are local preferences, not shared team records.
- Live readiness now checks the summary columns needed by list queries, so a missing summary migration cannot be reported as a ready database.

Measured in PostgreSQL using synthetic reports with repeated source/output text:

| Projection | Full report JSON | Summary JSON | Fewer transferred bytes |
| --- | ---: | ---: | ---: |
| Analysis (200 claim bodies) | 492,867 | 55 | 99.99% |
| Verification (150 evidence records) | 373,064 | 1,089 | 99.71% |

These measurements compare JSON text byte lengths, not response latency or physical disk savings. Summaries add a small amount of stored data to avoid repeatedly reading/transferring large reports. Original report storage remains intact; PostgreSQL compression and indexes have separate costs. No production workload benchmark is claimed.

Before live activation:

1. Apply all migrations with `pnpm db:migrate`, including report summaries, UTC defaults, and scoped session expiry indexing. For an existing populated database, follow the backup, free-space and maintenance-window guidance: stored generated columns rewrite tables under exclusive locks.
2. Run `pnpm db:maintenance --installation-id YOUR_INSTALLATION_ID` and inspect the dry-run diagnostics. Add `--limit 250 --apply` only when you intend to remove a batch of expired sessions. No cleanup scheduler has been provisioned.
3. Complete the infrastructure and hosted acceptance steps earlier in this document. The public Vercel demo can show the UI and saved views, but cannot prove live GitHub ingestion or background processing. No paid resources were provisioned.

Validation for this increment: the full local check passed with 345 TypeScript tests against real PostgreSQL and 109 Python tests; a subsequent migration-readiness regression also passed (346 TypeScript tests in total). The production Next build and all 27 browser tests passed, including an in-place identity change. The production-server smoke passed against real PostgreSQL with seeded team sessions, including tenant isolation, tied-timestamp inbox pagination, role changes, version conflicts, audit records and operations projections. Prisma validation and migration drift checks passed. Desktop and 390px mobile saved-view screens were inspected without overflow or browser errors. One TypeScript and four Python Docker-dependent tests remain for Docker-enabled CI; no hosted OAuth login or background-worker acceptance is implied by these local checks.


## Team administration and regression iteration — October 2026

Implemented:

- Admin-only **Team access** screen: bounded member pages, last-known sign-in labels, add/change/remove confirmations, role explanations, and the latest 20 access events. GitHub numeric IDs are authoritative; granting an ID does not contact or verify the intended person.
- `GET/PUT /api/team` derives actor and installation from the server session. Mutations serialize on the workspace, recheck current admin membership, require the roster version, and record membership plus history atomically. Stale changes fail; the last admin cannot be removed or demoted. Removed memberships revoke hashed sessions, and regranting access does not resurrect old sessions.
- Operator grants/revocations use the same audited engine. Existing reviewers stay reviewers; an operator must explicitly grant the first admin. New audit history starts with recorded changes rather than reconstructing old events.
- Rejected dashboard/session access clears loaded reports, evidence dialogs, quick-action results and export data. Superseded requests cannot repopulate a cleared workspace. Temporary outages still retain the last good snapshot.
- Team UI failures preserve uncertainty: a conflicting, invalid, or lost write response pauses editing until a successful reload. Permission loss clears the private roster. The demo runs the same interaction pattern with local sample data and a reset control; nothing is sent to a backend.
- Operations snapshots consolidate nine data reads into three: queue aggregates, analysis aggregates, and bounded recovery jobs. Tenant filtering, repeatable-read consistency, UTC cutoffs, and redacted output are preserved. A matching session index supports latest-login lookup and revocation. Query count is measured; production latency has not been benchmarked.
- Evaluation `--baseline` comparisons validate schema, corpus identity, labels, coverage, counts and derived scores. New false positives/negatives or safety failures fail the comparison even when another case improves. Details are bounded; malformed/incompatible baselines fail clearly, and atomic output cannot overwrite the baseline through path aliases. This compares authored fixtures, not held-out real-world accuracy.

Owner steps before live use:

1. Run `pnpm db:migrate` for all 15 migrations, including team version/audit tables, actor constraints and the member/session index. The prior report-summary migration still carries its documented table-rewrite requirements.
2. Once infrastructure is connected and the installation exists, bootstrap the first admin using `DATABASE_URL='…' pnpm team:access --action grant --installation INSTALLATION_ID --user GITHUB_NUMERIC_ID --role admin`. Keep credentials in your operator environment. Default CLI grants remain reviewers.
3. Verify a real hosted GitHub login, then exercise adding a viewer, changing a role, conflicting edits and revocation using separate accounts. The automated hosted-style smoke uses seeded sessions; it does not verify a real OAuth provider exchange.
4. Save an evaluation report before a change and compare a new report using `--baseline`. Preserve the baseline and review per-case changes, not only aggregate scores. A changed corpus needs a reviewed new baseline.

Next iteration priorities remain a provenance-backed public-repository evaluation corpus, durable hosted repair artifacts, complete audit export/retention design, and real hosted worker recovery evidence. Infrastructure connections remain deferred, and no paid resource was provisioned.

Validation for this iteration: lint, type checks, 388 TypeScript tests against real PostgreSQL, and 146 Python tests passed locally. All 32 production-build browser tests passed, including access-rejection clearing and a delayed-response race. The production-server/PostgreSQL smoke passed with actual admin HTTP requests, origin checks, version conflicts, audit records, final-admin protection, foreign-session denial and revocation. Prisma migration validation/drift checks passed. Desktop and 390px mobile team screens and the confirmation dialog were inspected without horizontal overflow or browser errors. Evaluation comparisons were also exercised with actual 38-case report artifacts. One TypeScript and four Python Docker tests require Docker-enabled CI. Hosted OAuth provider login and live worker processing remain separate acceptance steps.
