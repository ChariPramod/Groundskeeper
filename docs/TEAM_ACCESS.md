# Hosted team access

The hosted dashboard supports GitHub OAuth with an explicit allowlist of numeric GitHub user IDs for one installation per deployment. Approved members can read that installation's dashboard, review evidence, and repair artifacts. Membership administration is an operator command requiring database credentials, not a publicly reachable signup or administration endpoint. No organization membership is inferred. GitHub account renames do not change identity.

## Configure

1. Apply database migrations with `pnpm db:migrate`.
2. Register a GitHub OAuth App. Set the authorization callback URL to `https://YOUR_DOMAIN/api/auth/callback` and homepage to `https://YOUR_DOMAIN`. This OAuth App is separate from the GitHub App that receives repository events.
3. Set server-only variables on the web deployment:

```dotenv
DASHBOARD_MODE=live
DASHBOARD_INSTALLATION_ID=123
DATABASE_URL=postgresql://...
AUTH_ORIGIN=https://YOUR_DOMAIN
AUTH_SECRET=<random secret of at least 32 characters>
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
```

`AUTH_ORIGIN` must be an exact HTTPS origin without a trailing slash, path, username or password. Use a stable production domain. Generate the signing secret with `openssl rand -hex 32`. Never use a `NEXT_PUBLIC_` prefix for these values. Production OAuth requires HTTPS; the legacy access token flow remains usable on a local HTTP development server.

4. Confirm the workspace already exists from installation ingestion. Grant a specific GitHub numeric account ID (not its login):

```sh
DATABASE_URL='...' pnpm team:access --action grant --installation 123 --user 456
```

5. Redeploy, open Connection settings and select **Sign in with GitHub**. The application exchanges the authorization code on the server, verifies the GitHub identity, checks the installation allowlist, then issues its own session. The browser automatically loads live data after the redirect. No GitHub access token is retained or sent to the browser.
6. Revoke access immediately, including all existing sessions:

```sh
DATABASE_URL='...' pnpm team:access --action revoke --installation 123 --user 456
```

Deleting membership cascades all of that member's sessions. New sessions cannot be created without the membership foreign key. Expired session rows may be deleted by an operator for housekeeping; they never grant access after their expiration time.

## Security and failure behavior

- Login uses signed, ten-minute, browser-bound state and S256 PKCE. Callback failures clear the temporary cookie and instruct the user to restart sign-in.
- Session cookies have `__Host-` names, `Secure`, `HttpOnly`, `SameSite=Lax`, and an eight-hour fixed lifetime. Only SHA-256 hashes of randomly generated 256-bit session tokens are stored in the database.
- Every authenticated read checks current installation membership and session expiration. Logout is a same-origin POST and revokes the server session before clearing the browser cookie. If database revocation fails, logout returns an error so the user can retry.
- Supplying any OAuth setting enables the OAuth boundary. Partial configuration fails closed and does not silently fall back to the shared bearer token.
- With no OAuth settings, the previous explicit shared-token flow continues to work for local installations. Demo mode remains public and contains sample data only.
- GitHub requests are restricted to fixed endpoints, reject redirects and time out after 15 seconds. Errors do not expose provider tokens, database credentials, or stack traces.
- This release does not provide self-service invitation emails, organization synchronization, enterprise SSO, or a web administrator role. All allowed members have the same review privileges; operator-only membership management is the administrative boundary.

## Validation

Unit tests cover approved and denied membership, hashed session storage, tenant-scoped and expiry-filtered reads, cascading membership deletion queries, callback tampering/missing/duplicate/expired state, PKCE, safe provider/storage failures, origin enforcement, and fail-closed partial configuration. Existing dashboard, detailed review and repair authorization tests continue to pass.

A real provider login requires an operator-owned OAuth App, valid credentials, migrated hosted Postgres, an ingested installation and an approved account. Configuring the code does not demonstrate that deployment's successful OAuth exchange; complete and record this pilot before claiming hosted team access is verified.

Protocol reference: [GitHub's OAuth authorization documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
