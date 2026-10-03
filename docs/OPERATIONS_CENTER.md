# Operations center

The dashboard's Operations view reads `/api/operations` for the authenticated installation. It provides a bounded database snapshot, not a worker health check. Demo mode explicitly shows sample observations and illustrative commands.

## Observations

All unfinished `push` and `pull_request` deliveries are counted, rather than just the ten displayed jobs. Unsupported installation events are excluded. Queue states form a partition:

- **Failed:** a terminal failure timestamp exists.
- **Processing:** not terminal and its lease expires after the snapshot time.
- **Retrying:** not terminal, no active lease, and at least one prior attempt.
- **Pending:** not terminal, no active lease, and no prior attempts.

Potentially stalled work is a separate subset of unfinished nonterminal jobs. It includes expired leases, or inactive jobs received at least 15 minutes ago whose next-attempt time is absent or due. A future scheduled retry is not treated as old waiting work; an expired lease remains an investigation signal. Counts of stalled work overlap pending/retrying counts and must not be added to the total.

The view also shows the oldest unfinished delivery, the number of persisted analysis runs created within the preceding 24 hours, and the latest persisted run. Persisted analysis is not the same as successful example verification. No recent analysis can reflect either inactivity or a processing problem.

Up to ten failed or potentially stalled jobs appear oldest first, with only delivery ID, event, attempt count, received time, next-attempt time, and investigation status. Payloads, error text, source, credentials, and lease tokens are excluded.

## Interpreting health honestly

**Worker health is always unknown in this view.** There is no worker heartbeat. A loaded endpoint proves an authorized database read succeeded at the displayed snapshot time. An empty queue does not prove that webhook receipt, GitHub access, background processing, Docker execution, or the complete pipeline works.

The existing hosted integration tests and separately recorded pilot evidence remain necessary. Do not use this view alone as a readiness gate.

## Recovery

The browser cannot mutate the queue. For each job, first inspect its queue from an operator environment with the correct `DATABASE_URL`:

```sh
pnpm queue --installation-id '42' --event 'push'
```

Inspect logs and fix the underlying dependency or configuration failure. For a terminal job only, the view then supplies an explicit recovery command:

```sh
pnpm queue --installation-id '42' --event 'push' --retry-failed 'delivery-id'
```

These match the existing queue CLI and preserve its installation/event scoping. The command resets a matching terminal delivery; it does not execute analysis. A working background worker must subsequently process it. Expired leases can be reclaimed by the worker, so stalled jobs do not receive terminal-retry commands. The Copy button falls back to selectable command text if clipboard permission is unavailable.

CLI queue inspection can include stored error text; the browser intentionally does not. Keep operator command output within the appropriate environment.

## Access, consistency, and fallbacks

The endpoint uses the dashboard's fail-closed authorization boundary: configured team OAuth takes precedence, with no bearer fallback when OAuth is partially configured. A legacy dashboard bearer deployment can read the same installation-scoped operational observations. No queue mutation is exposed.

Every delivery and analysis query is scoped by installation. Counts and summaries run in one repeatable-read transaction with five-second connection/pool limits, a four-second per-statement limit, and a ten-second transaction limit. Large queues may time out rather than return partial counts. Data and errors use `Cache-Control: no-store` and vary by Cookie and Authorization.

Refresh retains the last successful snapshot on outages and clearly labels it as out of date. Changing mode or credentials hides the previous snapshot immediately. Authentication denial clears it. An initial load failure shows unknown state, never zeros masquerading as healthy observations. Both the component refresh and the global workspace refresh trigger another read; requests have a 15-second client deadline and late responses are ignored after cancellation.

## Validation

Unit tests cover authorization/configuration failure, installation filters on every query, unsupported-event exclusion, all-queue counts independent of displayed samples, bounded transactions, field redaction, unknown health for empty installations, runtime response validation, sanitized outages, guaranteed disconnect, and shell-quoted inspect-first recovery commands. Production browser and database smoke checks should additionally exercise the mounted view and real authenticated tenant boundaries.
