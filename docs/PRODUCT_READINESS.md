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

- Shared review ownership, notes, and status are still browser-local; implement persistent, versioned review records and an actor audit trail before claiming collaborative review workflows.
- All approved members currently share read access; add explicit roles and audited administrative operations when write collaboration is implemented.
- Add a held-out, versioned public-repository evaluation corpus and separately measure execution correctness and recovery behavior.
- Hosted sandbox verification needs an appropriately isolated execution service. The analysis worker deliberately has no Docker socket and does not execute repository examples.
- Repair artifacts still live on the operator filesystem; durable artifact storage, retention, and hosted retrieval remain required for a fully hosted repair workflow.

Nothing is described as break-proof. Tests cover specific safety and recovery properties; hosted operational claims require the acceptance evidence above.

## Validation record (2026-09-22)

Local validation passed lint, TypeScript checks, production Next build, 238 TypeScript tests (eight service-dependent tests skipped), 109 Python tests (four Docker tests skipped), the authored evaluation gate, and 14 dashboard browser tests. Additional authentication tests exercise bounded database transactions and sanitized timeout failures.

GitHub CI exercised the new real PostgreSQL production-server/browser smoke successfully on `b1e311c`. Vercel deployed that revision successfully; a browser check loaded five demo rows without page errors. Public health returned `mode: demo`, `liveReady: false`; the unconfigured OAuth endpoint returned 503 as intended. These observations verify the hosted demo, not a live GitHub installation or background worker. See subsequent CI runs for final container and service validation of the latest revision.
