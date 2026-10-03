# Hosted team access and administration

The dashboard supports GitHub OAuth with an explicit allowlist of numeric GitHub user IDs for one installation per deployment. Viewers read evidence and shared reviews; reviewers also save review decisions; admins additionally manage team membership in the browser. The server rechecks the role for each request, and database mutations check it again under transaction locks. A GitHub login rename does not change identity. Organization membership is not inferred.

The public deployment remains an explicit sample-data demo. Implemented authentication and administration code, local production-server tests, and CI do not establish that production OAuth and live infrastructure are configured.

## Configure and bootstrap the first admin

1. Apply database migrations with `pnpm db:migrate`. The current migration set contains **15 migrations**, including team roles, the workspace team version, membership audit records, the audit actor constraint, and the member-session lookup index. Apply the complete set before enabling live administration.
2. Register a GitHub OAuth App with callback `https://YOUR_DOMAIN/api/auth/callback` and homepage `https://YOUR_DOMAIN`. This is separate from the GitHub App receiving repository events.
3. Set server-only deployment variables:

```dotenv
DASHBOARD_MODE=live
DASHBOARD_INSTALLATION_ID=123
DATABASE_URL=postgresql://...
AUTH_ORIGIN=https://YOUR_DOMAIN
AUTH_SECRET=<random secret of at least 32 characters>
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
```

`AUTH_ORIGIN` must be an exact HTTPS origin without a trailing slash, path, username, or password. Use a stable domain. Generate a signing secret with `openssl rand -hex 32`. Never use `NEXT_PUBLIC_` prefixes for credentials. Existing exported environment variables take precedence over root environment-file values where a command loads that file; the operator membership command requires `DATABASE_URL` in its environment explicitly.

4. Ensure installation ingestion has created the workspace. Bootstrap an admin using its **numeric GitHub account ID**, not a login:

```sh
DATABASE_URL='...' pnpm team:access --action grant --installation 123 --user 456 --role admin
```

Existing members and unspecified CLI grants are reviewers, so an explicit first admin grant is necessary. This command requires database credentials and is not exposed through a public bootstrap endpoint.

5. Redeploy and select **Sign in with GitHub** in Connection settings. The server exchanges the authorization code, verifies the GitHub identity, checks membership, and issues its own session. No GitHub access token is retained or sent to the browser.
6. Open **Team access** as an admin to add another numeric GitHub user ID, change roles, or revoke access. Adding an ID grants permission to sign in; it does not verify that the ID corresponds to the intended person, send an invitation, or contact that user. Confirm the ID before granting access.

## Role boundaries

| Role | Evidence, operations, and shared review reads | Shared review edits | Team directory and membership administration |
| --- | --- | --- | --- |
| Viewer | Yes | No | No |
| Reviewer | Yes | Yes | No |
| Admin | Yes | Yes | Yes |

Viewer and reviewer accounts see role explanations and an admin-required message in Team access; they do not receive the private roster or mutation controls. Unknown or unavailable session roles also disable administration. UI restrictions are advisory: the API and database independently enforce them. Admin access does not authorize browser-triggered verification, repair publication, or GitHub writes.

Role changes apply to existing sessions on their next request. `GET /api/auth/session` returns the numeric GitHub ID, login, current role, and a derived storage scope for personal inbox presets; it exposes no session value or token hash.

## Membership changes, concurrency, and history

`GET /api/team` requires a current admin session. It returns up to 50 members ordered by numeric ID, an optional cursor, the current `Workspace.teamVersion`, and the **latest 20 membership events**. This is a bounded history view, not a complete audit export. A last-known login comes from a stored session and may be absent or outdated; the numeric ID remains authoritative. The `(workspaceId, githubUserId, createdAt, tokenHash)` session index supports this latest-session lookup and member revocation. A separate `(workspaceId, expiresAt, tokenHash)` index serves ordered expiry cleanup; neither index replaces authorization.

`PUT /api/team` accepts exactly `version`, `githubUserId` as a decimal string, and `role` (`viewer`, `reviewer`, `admin`, or `null` to revoke). It requires an exact configured Origin and JSON, with a 4 KiB streamed-body limit and five-second body deadline. Actor identity and installation come from the server session, never the submitted payload.

Every membership mutation locks the workspace row **before touching member rows**. Browser mutations then recheck that the actor is still an admin and compare the submitted version with `Workspace.teamVersion`. A mismatch returns `409` without overwriting newer changes. Successful changes increment the version and append `TeamAccessEvent` atomically; an audit insert failure rolls back both membership and version. A no-op at the current version creates no synthetic change event. All supported browser and operator changes use this same engine.

An installation's final admin cannot be demoted or revoked, including through the operator CLI. Add another admin first. The workspace lock serializes concurrent removals so two admins cannot each remove the last remaining admin. The operator can bootstrap an installation that has no admin, but cannot bypass the final-admin protection.

Revocation deletes the membership and cascades deletion of its hashed sessions in the same transaction. Regranting membership does not resurrect old sessions. Membership audit events retain the actor and target numeric IDs after membership removal; shared-review history also persists. The new history starts with changes recorded by this release. Previous grants are not reconstructed or presented as invented events.

Operator examples:

```sh
DATABASE_URL='...' pnpm team:access --action grant --installation 123 --user 789 --role viewer
DATABASE_URL='...' pnpm team:access --action grant --installation 123 --user 789 --role reviewer
DATABASE_URL='...' pnpm team:access --action revoke --installation 123 --user 789
```

Operator events identify their source as `operator`; the system does not fabricate a human actor identity for a database-credential command. The CLI acquires the same workspace lock and records the same versioned audit as browser changes. It does not submit a browser version: the credentialed operator changes the current locked state, while still obeying final-admin protection.

## Browser recovery and demo behavior

The browser asks for confirmation before a team change. A conflict, timeout, or lost response requires a successful reload before another edit. The server may have committed even when the client did not receive success; an uncertain response is not proof that nothing changed. The interface reloads after a confirmed change too, and pauses editing if that reload fails. A permission rejection clears the private roster. Pagination is a fresh bounded snapshot on each request, not a frozen cross-request directory.

Demo Team access simulates membership changes only for the current visit, labels them as sample changes, and provides a sample reset. It makes no real grants, sends no invitations, and persists no production membership. It is not a substitute for the live path.

## Security, operating limits, and remaining setup

- OAuth uses signed, ten-minute browser-bound state and S256 PKCE. Failures clear the temporary cookie and require restarting sign-in.
- Session cookies use `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, and an eight-hour lifetime. The database stores SHA-256 hashes of random 256-bit tokens.
- Every authenticated read checks current membership and expiration. Logout is a same-origin POST that revokes the server session before clearing the cookie; a database failure remains visible.
- Any OAuth setting enables the OAuth boundary. Partial configuration fails closed; it cannot fall back to the legacy bearer token. Team administration always requires OAuth even if legacy dashboard reads are enabled.
- Membership transactions have a three-second acquisition limit, five-second duration, three-second lock timeout, and four-second statement timeout. Connection/pool waits are five seconds. Failures produce sanitized responses. Client deadlines do not prove transaction cancellation.
- Expired sessions can be cleaned with the separate bounded, dry-run-by-default [storage maintenance](STORAGE_MAINTENANCE.md) command. It does not delete audit or evidence records.
- Invitation emails, organization synchronization, enterprise SSO, and automatic installation lifecycle reconciliation are not implemented.

A real provider login still requires operator-owned OAuth credentials, migrated hosted Postgres, an ingested installation, and an approved account. Record a successful hosted login and admin workflow before claiming that deployment's team access is verified. Protocol reference: [GitHub OAuth authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## Validation

Tests cover strict input and origin boundaries, member/role authorization, hashed sessions, immediate role changes, cascading revocation, concurrent version conflicts and admin removals, last-admin protection, atomic audit rollback, numeric pagination, bounded history, malformed audit actor rejection, uncertain browser responses, and demo-only changes. PostgreSQL integration tests validate the actual lock, cascade, and transaction behavior; mocked API tests alone do not prove those guarantees.

See [shared review behavior](SHARED_REVIEWS.md), [system architecture](ARCHITECTURE.md), and [query/response contracts](QUERY_RESPONSE_ARCHITECTURE.md).
