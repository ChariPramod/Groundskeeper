# Pull-request inbox processing

The finite worker now processes both default-branch push and pull-request deliveries by default. It claims the oldest eligible event across those two types; installation lifecycle events remain untouched.

```sh
pnpm worker --limit 5
# Process only one event type when operating separate queues:
pnpm worker --event pull_request --limit 5
pnpm worker --event push --limit 5
```

Ingress records the PR number, action, repository identity, and base/head commit SHAs. It does not store PR bodies or repository source. The worker handles `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited` actions.

For a still-open same-repository PR whose base/head match the webhook, it resolves the pinned merge base, fetches exact source/documentation snapshots, analyzes documentation impact, and persists the report under the webhook delivery ID. Persistence precedes acknowledgment. Reports use the existing AnalysisRun schema and appear in the dashboard's analysis list.

## Recovery and concurrency

Push and PR processing share the existing database lease implementation. Claims use row locks with `SKIP LOCKED`; a ten-minute lease fences persistence, acknowledgment and failure updates. Failures retry after five minutes, with at most five attempts before becoming terminal. Persistence failure cannot acknowledge a delivery. If persistence succeeds but acknowledgment fails, replay checks the stored installation, repository and head identity and acknowledges without re-fetching or recomputing the report.

```sh
pnpm queue --event pull_request --installation-id <id>
pnpm queue --event pull_request --installation-id <id> --retry-failed <delivery-id>
```

Retry is explicitly installation-scoped. Stale lease holders cannot change the queue or persist reports. Separate delivery IDs may produce distinct analyses of identical commits; the idempotency boundary is the webhook delivery, not a global commit cache. Manual `pr:analyze` retains its existing synthetic run identity.

## Events that do not produce analysis

- Closed, forked or superseded PRs are acknowledged as ignored, without source snapshot reads. Fork analysis still requires a separate access design.
- Actions unrelated to analysis are acknowledged without GitHub requests.
- Older inbox records that lack both commit SHAs are acknowledged as ignored. Use explicit `pr:analyze` for their current state, or a fresh signed PR event. The worker never silently treats today's head as an old event's head.
- Malformed identities/partial commit metadata and infrastructure failures fail the attempt and follow bounded retry/terminal recovery.

The worker prints `analyzed`, `replayed` or `ignored` for PR dispositions. Those detailed dispositions are currently process logs; the database records processed/retry/terminal state, not a separate reason history.

## Operational boundaries

This is analysis automation, not automatic execution or publishing. PR processing does not run examples, post comments/checks, open repair PRs or merge code. `verify:run` and explicit check/publication commands remain separate. No extra GitHub write permission is required for this worker path.

A running ingress and recurring/supervised worker invocation are still required. The web deployment does not host that worker. The dashboard queue view currently shows push deliveries; use the event-specific queue CLI above for PR operations. New PR routing metadata needs the updated ingress deployed; no database migration is needed because existing JSON metadata and event-aware queue indexes support it.

Tests cover routing, pinned merge-base analysis, stale/closed/fork handling, failed writes, acknowledgment recovery and malformed input. The PostgreSQL concurrency suite runs the same claim/retry/lease-fence checks for both event types, including event separation and mixed-queue claiming.
