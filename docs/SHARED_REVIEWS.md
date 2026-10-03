# Shared team reviews

An OAuth-authenticated workspace member can save an owner label, review note, and dismissed/open status for an analysis run. These records are separate from immutable analysis and execution evidence: dismissing a review never changes a verification verdict. Owner labels do not grant access, notify users, or assign GitHub issues.

## Use

1. Apply migrations with `pnpm db:migrate` before enabling the new web revision for a live team. This adds `SharedReview` and `SharedReviewEvent`; existing browser annotations are not migrated or uploaded.
2. Configure [team access](TEAM_ACCESS.md), sign in, and open a run's documentation review.
3. Edit **Team owner**, **Team review note**, or **Dismissed for the team**, then select **Save shared review**. Edits remain an unsaved draft until the server confirms a save.
4. Expand **Recent review history** for the last 20 changes, including actor, version, time, owner, note, and status. All change events remain in the database until the parent run is deleted; UI history is bounded.

Demo and legacy shared-token sessions continue to use explicitly browser-local annotations. Shared state is available only through approved OAuth member sessions. All approved members currently have equal review-edit privileges; finer roles remain future work.

## Concurrent edits and failures

Each update supplies the last loaded version. Two writers starting from the same version cannot silently overwrite each other: exactly one can save, and the other receives a conflict. The database locks the installation membership against concurrent revocation and serializes writes to the run. State and its audit event commit in the same bounded transaction. If recording the event fails, the state change rolls back.

A conflict, timeout, malformed response, or failed save leaves the draft visible and disables another save until a successful reload. A network error can occur after the database commits, so the UI does not claim the write failed or retry it blindly. **Reload latest (discards draft)** explicitly replaces the draft with the current server version; copy any draft text you want to retain first. Drafts are in memory while the dialog is open and are not saved when it closes. Closing or reloading before a confirmed save can lose unsaved edits.

Unavailable shared storage is never replaced by local-only persistence under a shared label. Team access is checked on each API request and membership is checked again inside the persistence transaction. Revoking a member waits for any already-running review transaction; subsequent attempts are denied. Historical audit events retain the actor's numeric GitHub identity and login at save time after membership is revoked.

## API boundaries

- `GET /api/review/:id/state`: state and latest 20 events, scoped to the authenticated installation.
- `PUT /api/review/:id/state`: same-origin, JSON-only update with exactly `version`, `owner`, `note`, and `dismissed`.
- Owner maximum: 100 characters. Note maximum: 2,000 characters. Request maximum: 16 KB, with a five-second body-read deadline.
- Actor identity comes from the session, never from request JSON. Shared bearer tokens cannot read or change shared state.
- Conflict returns 409; inaccessible runs return 404; missing/revoked access is denied; database errors return a redacted 503. Responses are not cached.
- Transactions, database connection acquisition, lock waits, and SQL statements have explicit limits.

## Validation and remaining limits

Unit tests cover input/response validation, origin and OAuth boundaries, request limits/timeouts, conflict mapping, and redacted errors. Browser tests cover explicit saving, audit rendering, conflict draft retention, deliberate reload, and unavailable shared storage. Real PostgreSQL tests cover concurrent first writes, tenant isolation, revocation, and atomic rollback when audit insertion fails. The production-server smoke additionally exercises shared-review HTTP requests with real database-backed sessions. It seeds sessions directly and does not prove a real GitHub OAuth provider exchange.

Hosted live acceptance still awaits infrastructure and credentials. Shared notes have no notification system, full-history pagination/export, granular roles, or automatic merge. Database administrators can modify tables; the event history is application-append-only, not a tamper-proof ledger.
