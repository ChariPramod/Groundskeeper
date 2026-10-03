# Query and response architecture

The web server is the authorization and projection boundary. The browser never receives database credentials, GitHub App secrets, lease tokens, or raw sandbox streams. Each live query derives its installation scope from server configuration and an authenticated session or permitted legacy token; it never trusts a client-supplied workspace identity.

The current public deployment is a demo. The sequences below describe implemented live paths that become active once live infrastructure and credentials are configured. Demo data is explicit and never substitutes for a failed live request.

## Read path: filtered review inbox

![Review inbox query and response sequence](diagrams/query-read-sequence.svg)

[Mermaid source](diagrams/query-read-sequence.mmd) · [Open scalable SVG](diagrams/query-read-sequence.svg)

The inbox accepts a strict allowlist of query parameters. Status is `open`, `dismissed`, or `all`; owner and repository use exact, case-insensitive matching; unassigned means either no shared review or an empty owner. A missing review is open. Repeated/unknown fields, contradictory owner/unassigned filters, invalid names, and malformed cursors are rejected.

Results use descending creation time and ID. The server reads 21 rows, returns at most 20, and derives the next cursor from the final returned row. The following page applies `createdAt < cursorTime OR (createdAt = cursorTime AND id < cursorId)` inside the same installation boundary. A cursor is an opaque position, not an access grant. New rows inserted above the first page do not shift offsets; changing review state during pagination can change membership of later filtered pages, so this is not a frozen cross-request snapshot.

PostgreSQL `STORED` generated summaries remove large report JSON from dashboard and inbox list queries. `gk_analysis_summary_v1(report)` derives health counts; `gk_verification_summary_v1(report)` derives a bounded outcome list and full-set `allPassed`/`hasFailed` flags. Readers validate summary versions and shape. Missing or invalid summaries cannot create a verified verdict or trigger a full-report fallback. Valid impact or failure evidence can still produce needs-review; without that evidence the result stays unknown. Detailed review is the separate, explicit path for bounded claim excerpts.

After a successful response, the browser validates its shape and live mode before replacing the displayed snapshot. Changing filters starts a new traversal. Aborted or superseded requests cannot overwrite newer results. A temporary failure keeps the last successful page labeled with its actual applied filters; rejected team access clears private rows. Saved views persist at most eight names and applied filter sets locally and reissue the same authorized query when selected. Demo and live namespaces are separate. The live namespace uses a server-derived SHA-256 installation/user scope; it is an identifier, not a credential or access grant. Storage failures are visible and fall back to the current in-memory view list.

## Write path: shared review with optimistic concurrency

![Shared review write and response sequence](diagrams/query-write-sequence.svg)

[Mermaid source](diagrams/query-write-sequence.mmd) · [Open scalable SVG](diagrams/query-write-sequence.svg)

The request contains exactly `version`, `owner`, `note`, and `dismissed`. The API checks the configured HTTPS origin, team session, current write role, JSON content type, and bounded body before calling the database module. Reviewers and admins may write; viewers may read. The database repeats the role check under a membership lock, so a role change between the HTTP check and the transaction cannot bypass enforcement.

The transaction locks the member against concurrent revoke and locks the owned analysis to serialize initial writes. It compares the expected version with the stored version (zero when absent). A mismatch returns `409`. An existing row is updated with a version predicate; the first state is created under the same run lock. Both paths append the actor-attributed event in the same transaction before returning the saved state and latest 20 events.

A successful save replaces the editor's confirmed state and refreshes the inbox under the current filters. A failed or ambiguous save retains the draft and requires a reload before retrying. The server may commit before a response is lost, so a network error is never described as proof that nothing was saved. No browser retry silently overwrites a teammate's later version.

## Route contracts

“Dashboard access” means a current OAuth team session when OAuth is configured, or a constant-time checked bearer token only when OAuth is entirely unconfigured. “Team access” always requires the OAuth session and current installation membership. All successful data responses use `Cache-Control: no-store`; private routes vary on cookie/authorization as applicable.

| Route | Live access and scope | Query and response boundary |
| --- | --- | --- |
| `GET /api/dashboard` | Dashboard access; installation-scoped repositories, runs, and deliveries | At most 50 repositories, 50 newest runs, and 50 unfinished push/PR deliveries. Compact analysis/latest-verification summaries; at most 100 displayed outcomes per run. |
| `GET /api/reviews` | Team access; installation scope reapplied on every page | Open/dismissed/all, exact owner, unassigned, exact repository; fixed 20-row keyset pages plus one lookahead. Counts, outcome summaries, owner, 160-character note snippet, version, and update time. No claim excerpts. |
| `GET /api/review/:id` | Dashboard access; run ID and installation checked together | One report; at most 20 findings, each with a claim excerpt capped at 4,000 characters and up to 20 linked changed symbols. Latest execution status/reason, no stdout/stderr. A missing or foreign run is `404`. |
| `GET /api/operations` | Dashboard access; installation-scoped unfinished push/PR deliveries and runs | Queue aggregates, oldest unfinished time, last analysis time, last-24-hour completion count, and at most 10 failed/stalled jobs. Repeatable-read snapshot. No payload, error text, or lease token; worker status remains unknown. |
| `GET /api/review/:id/state` | Team access; member and owned-run checks in a transaction | Current shared state and at most 20 latest audit events. Owner max 100 characters, note max 2,000. Does not grant access through the legacy bearer token. |
| `PUT /api/review/:id/state` | Reviewer/admin team access; exact origin; membership/role rechecked under lock | Strict JSON, body max 16 KiB, expected version, atomic state/event write. `409` on conflict, `403` after role/revoke failure, `404` for an unowned run. |
| `GET /api/repairs/:digest` | Dashboard access; artifact installation identity and content digest checked | A fixed local artifact path, 64-character SHA-256 digest, regular file/no-follow checks, and 32 MB maximum read. Bounded before/after documents plus evidence counts; no execution output. The public deployment has no automatic artifact upload. |
| `GET /api/auth/session` | Team access | Numeric GitHub identity as text, login, current role, and a derived storage scope. No cookie value, token hash, or infrastructure details. |
| `GET /api/health` | Public, redacted | Demo mode returns `liveReady: false`. Live checks configuration and schema access, including both generated summary columns; missing migrations return `503`. Does not verify webhook delivery, worker uptime, or sandbox availability. |

OAuth has separate login/callback routes using state and PKCE. Logout is a same-origin POST that revokes the current session and expires its cookie. These are identity operations rather than report queries. See [`team-auth.ts`](../apps/web/lib/team-auth.ts).

## Bounds, caching, and failure handling

| Boundary | Implementation limit or behavior |
| --- | --- |
| General live database readers | One connection per request client; five-second connection/pool limits; transaction max wait five seconds and timeout ten seconds; disconnect in `finally`. |
| Team session lookup | Five-second connection/pool and transaction bounds; reads current member role each time. |
| Shared review transaction | Three-second transaction acquisition and five-second transaction timeout; three-second lock timeout and four-second statement timeout. State and audit update commit together. |
| Operations snapshot | Repeatable-read transaction with a four-second statement timeout; queue and run aggregates share the snapshot. |
| Web readiness probe | Three-second connection/pool and transaction bounds; sanitized `503` on failure. |
| Request body | Shared review body limited to 16 KiB with a five-second stream deadline; malformed or extra fields rejected. |
| Browser waits | Dashboard and session reads use ten-second request deadlines; inbox and shared review requests use fifteen-second deadlines. New requests/unmount abort prior work. |
| Authentication failure | `401` for an absent/expired/unapproved session; `403` for a denied role, invalid write origin, or membership loss detected in the write transaction. Secrets and raw provider/database errors are withheld. |
| Temporary read failure | Sanitized `503`; no implicit demo switch. Inbox preserves the last good snapshot and its applied-filter label unless access has been rejected. |
| Write conflict or uncertain response | Preserve the draft; require a confirmed reload before another save. The latest server version is the concurrency authority. |
| Missing data | Installation-scoped `404` avoids revealing that a run or artifact belongs to another workspace. |
| Cache policy | `no-store` on data and auth responses; browser requests also opt out of caching. No shared response cache is used for private projections. |

A browser request deadline is not a distributed transaction deadline. Session lookup and the subsequent data query have their own server bounds; the database may still finish after the browser stops waiting. This is especially relevant for writes and is why the editor treats transport failure as uncertain.

## Implementation map

| Concern | Source |
| --- | --- |
| Versioned summary validation | [`report-summaries.ts`](../packages/database/src/report-summaries.ts) |
| Shared dashboard authorization and summary projection | [`dashboard-data.ts`](../apps/web/lib/dashboard-data.ts) |
| Inbox filters, keyset query, bounds, and API response | [`review-inbox-data.ts`](../apps/web/lib/review-inbox-data.ts) |
| Browser inbox validation and failure classification | [`review-inbox-client.ts`](../apps/web/lib/review-inbox-client.ts), [`review-inbox-types.ts`](../apps/web/lib/review-inbox-types.ts) |
| Applied-filter snapshots, pagination, saved views, and refresh | [`review-inbox.tsx`](../apps/web/components/review-inbox.tsx) |
| Detailed evidence projection | [`review-data.ts`](../apps/web/lib/review-data.ts) |
| Operations snapshot | [`operations-data.ts`](../apps/web/lib/operations-data.ts) |
| HTTP write boundary | [`shared-review-api.ts`](../apps/web/lib/shared-review-api.ts) |
| Membership locks, compare-and-update, audit transaction | [`shared-reviews.ts`](../packages/database/src/shared-reviews.ts) |
| Schema, generated summary functions, and indexes | [`schema.prisma`](../packages/database/prisma/schema.prisma), [`migrations`](../packages/database/prisma/migrations) |

Raw Mermaid sources and rendered SVGs are checked in together under [`docs/diagrams`](diagrams). SVG exports preserve readable text and can be opened independently of a Markdown renderer.

Diagrams were rendered with Mermaid CLI `12.0.0` and an existing Playwright Chromium executable, using the checked-in [renderer configuration](diagrams/mermaid.config.json). The CLI was run from the temporary pnpm cache; no application dependencies were added. Every source includes an accessible title and description, which are carried into its SVG export.
