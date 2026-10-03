# Review inbox

The inbox turns stored analyses and shared review state into a team work queue. Open it from the dashboard navigation, narrow the results by review status, owner, or repository, then open the evidence for a run. Shared review saves refresh the inbox without discarding the current filters.

## Behavior

- Open, dismissed, and all-review views. A run without a saved shared review is open and unassigned.
- Exact owner labels and full repository names match without case sensitivity. Owner labels remain free text; assignment does not notify anyone or grant access.
- An unassigned filter clears the owner field to avoid contradictory searches.
- Server pagination returns up to 20 runs, newest first. The opaque next cursor contains the last returned creation time and ID. Every page reapplies workspace authorization; cursor contents never grant access.
- Opening a row loads the existing evidence review, including shared notes, ownership, versioned changes, and audit history where team access is enabled.
- A completed shared save reloads the first page under the active filters. Dismissing a review therefore removes it from an open-review view.
- Review status remains independent of analysis and verification outcomes. Dismissing a review does not certify that examples passed.
- Notes are clipped to 160 characters in the inbox. Full notes remain in the individual review.

## Access and deployment

`GET /api/reviews` is a live, OAuth-team endpoint. It uses the same session and explicit installation membership boundary as shared review reads. A legacy dashboard bearer token does not grant access to this endpoint or to shared metadata. The dashboard can continue to use bearer access for its existing analysis views.

The existing live database, migrated shared-review schema, GitHub OAuth configuration, installation ID, and active team membership are required. No new environment variables, dependencies, background services, or paid infrastructure are needed. This feature can be deployed before connecting live infrastructure: the demo inbox uses stable sample records entirely in the browser and explicitly labels sample assignments and notes.

Supported query parameters:

| Parameter | Accepted value |
| --- | --- |
| `status` | `open` (default), `dismissed`, or `all` |
| `owner` | Exact label, trimmed, maximum 100 characters |
| `unassigned` | `true` or `false`; cannot combine true with a nonempty owner |
| `repository` | Full `owner/repository` name, maximum 100 characters per segment |
| `cursor` | Opaque cursor returned by a previous page |

Unknown or repeated parameters and malformed cursors are rejected. Page size and ordering cannot be supplied by a client. Repository names and owners use parameterized Prisma comparisons. Queries are constrained to the authenticated installation and bounded to 21 rows: 20 results and one lookahead row. Responses use `no-store` and vary by cookie and authorization.

The API projects counts, summarized evidence outcomes, shared review labels, and short note excerpts. It does not return source claim excerpts or sandbox output. The database currently stores report documents as JSON, so this bounded query still reads the selected reports to derive summaries; materialized summary columns are a future optimization if report sizes or traffic warrant it.

## Failure and refresh behavior

- Requests have a 15-second browser timeout; database connection, pool, and transaction waits are bounded.
- A failed live load never substitutes demo rows. On a temporary outage the last successful page stays visible alongside an explicit error. A rejected or revoked session clears the visible private rows and prompts the user to restore access.
- The UI distinguishes entered filters from the filters attached to the displayed results. A failed search cannot silently relabel old results.
- Starting another request aborts the prior one; stale responses cannot replace the latest result.
- Pagination is disabled while entered filters differ from the loaded filters. Applying or clearing filters starts at page one.
- Refresh starts a fresh traversal. New analyses inserted after page one do not get duplicated onto subsequent pages because pagination uses creation time and ID, rather than offsets.
- Shared review state is mutable, so a team change during a traversal can change membership of subsequent filtered pages. Refresh restarts the view; this is not a point-in-time snapshot of all reviews.

## Validation

28 unit tests cover installation scoping, filter validation, tied-timestamp cursors, pagination boundaries, bounded projection, database cleanup on failure, authentication failures, revoked-access responses, demo filtering, response validation, and prevention of demo fallback in live mode. Web TypeScript and Biome checks pass.

Real database and browser validation should run through the repository's hosted and end-to-end suites after integration. Successful local or CI checks do not imply a provisioned public live database; deployment readiness remains dependent on the configured hosting and credentials.
