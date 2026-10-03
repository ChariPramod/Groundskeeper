# Storage maintenance

Expired sessions no longer authorize requests, but they occupy storage until removed. This operator-only CLI reports installation-scoped counts and can remove a bounded batch of expired sessions. It does not prune evidence, audit history, or webhook delivery identities.

## Inspect before applying

From the repository root, using the normal root `.env` or an exported `DATABASE_URL`:

```sh
pnpm db:maintenance --installation-id 42
pnpm db:maintenance --installation-id 42 --limit 250
```

Both are dry runs. No rows are deleted. `--installation-id` is required and must fit a positive signed 64-bit ID. `--limit` defaults to 100 and accepts integers from 1 through 1000. Invalid, unknown, or repeated options fail before connecting. A missing installation fails closed.

To apply one bounded batch:

```sh
pnpm db:maintenance --installation-id 42 --limit 250 --apply
```

The tool prints schema-version-2 JSON with diagnostics mode, installation, database observation time, batch limit, scoped counts **before cleanup**, matched batch count, actual deleted session count, and `expiredSessionsRemain`. `deletedSessions` is always zero in dry-run mode. Row counts and relation byte sizes are decimal strings to preserve PostgreSQL bigint precision. No session hashes, user names, tokens, payloads, database credentials, or stored error messages appear.

`expiredSessionsRemain` is an indexed existence check after the batch: in apply mode it reflects rows left after deletion; in dry-run mode all eligible rows remain. It includes rows skipped because another transaction holds a lock, so zero deletions with `true` means cleanup is not finished. It is advisory at the transaction observation time; concurrent work and future expirations can change it. Use another dry run to inspect remaining expired sessions after applying. One invocation processes at most one batch. There is no automatic scheduler or unbounded cleanup loop. Schedule this command only in an operator environment with the appropriate database credentials and monitor failures.

## Bounded summary mode

For recurring cleanup or when full-history diagnostics exceed their deadline, explicitly select summary mode:

```sh
pnpm db:maintenance --installation-id 42 --diagnostics summary --limit 250
pnpm db:maintenance --installation-id 42 --diagnostics summary --limit 250 --apply
```

Both use the same bounded, installation-scoped session query, expiry checks, locks, and deadlines. Summary mode skips exact history counts and relation-size collection entirely. It reads workspace identity, observation time, at most one eligible batch, and an indexed existence check; it does not read reports, verification history, or audit history. The output declares `diagnostics: "summary"`, `scopedCountsBeforeCleanup: null`, and `relationBytes: null`. A missing metric is never presented as zero. This keeps safe session cleanup independent of the size or availability of unrelated history diagnostics.

`--diagnostics exact` remains the default and retains exact counts. There is no silent fallback from exact to summary: a diagnostic failure aborts that transaction, and the operator can rerun with the explicit summary option. Schema version 2 applies to both modes; JSON consumers must accept null skipped diagnostics and the new fields. No migration is required for these maintenance changes.

## Scope and diagnostics

Counts are scoped to the requested installation and include sessions, expired sessions, analysis runs, verification runs, review audit events, team access audit events, and webhook deliveries. Relation sizes include tables, indexes, and associated storage for selected tables in the connected database schema. They are explicitly labeled **database-wide**, including every installation using those relations; they are not per-tenant byte estimates. Each relation reports total `bytes`, `tableBytes` (including TOAST and auxiliary storage), and `indexBytes`; total bytes equal table plus index bytes. Counts and sizes are diagnostics taken before cleanup and can change with concurrent activity. The two session counts share one conditional-aggregate scan.

Exact count queries can be expensive on very large tables. They have statement deadlines and fail rather than printing partial success. Deleted tuples do not imply immediate filesystem shrinkage: PostgreSQL's normal vacuum/reuse lifecycle is separate from this command. The CLI does not run VACUUM or alter tables/indexes.

## Safety and concurrency

Only `TeamSession` rows for the selected installation with `expiresAt <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')` are eligible. Expiry uses transaction database time explicitly converted to UTC, matching Prisma timestamp storage even when database sessions use another time zone and avoiding dependence on an operator laptop clock. Apply locks a stable expiry/key-ordered batch with `FOR UPDATE SKIP LOCKED`, then rechecks both installation and expiry in the delete statement. Active sessions and other installations remain untouched. Concurrent cleanup jobs skip each other's locked sessions; a locked or concurrently changed row can reduce the batch result.

Diagnostics and deletion run in one transaction. Connection and pool waits are bounded to five seconds with one connection; transaction acquisition is five seconds, transaction duration fifteen seconds, each SQL statement four seconds, and lock waits two seconds. Errors roll back cleanup and produce sanitized output. If the client loses the commit response, rerunning is safe because eligibility is rechecked and already-deleted sessions are absent.

The command **never deletes** analysis runs, verification evidence, shared-review events, team access events, or webhook deliveries. Processed delivery IDs continue preventing duplicate webhook processing. This is not a general data-retention policy; durable-record retention needs a separate design that preserves provenance, recovery, and replay guarantees.

## Validation

Unit tests cover strict CLI parsing, numeric bounds, dry-run defaults, bounded connection parameters, sanitized invalid URLs, and fail-closed unknown installations. The opt-in PostgreSQL integration tests use isolated schemas to verify dry-run immutability, scoped batch limits, concurrent cleaners, locked-row skipping, active/foreign session preservation, and preservation of analysis, verification, review audit, team access audit, and webhook rows. Tests exercise both diagnostics modes concurrently, verify remaining-work signals even when all remaining rows are locked, validate table/index totals, and prove that summary cleanup succeeds without querying any durable-history tables while exact diagnostics fail closed when unavailable.

```sh
pnpm exec vitest run packages/database/src/maintenance.test.ts
DATABASE_TEST_URL='postgresql://…' pnpm exec vitest run packages/database/src/maintenance.test.ts
```

Apply current migrations to the test database first. Without `DATABASE_TEST_URL`, the PostgreSQL tests are explicitly skipped; unit passes alone are not real database proof.

## Generated-summary migration capacity

The report-summary migration adds STORED generated columns to `AnalysisRun` and `VerificationRun`. PostgreSQL must compute existing rows and rewrite both tables; this takes an `ACCESS EXCLUSIVE` table lock. The accompanying nonconcurrent index builds also block writes. This is not an online, zero-copy backfill, even though the original report values remain unchanged.

Before applying it to a populated or capacity-limited hosted database, take a recoverable backup, measure current table/index sizes and available storage, allow headroom for rewritten tables, indexes and WAL, and rehearse the migration on a representative restored database. Schedule a quiet maintenance window based on the rehearsal's measured duration. Small synthetic migration tests establish correctness, not production migration time or storage requirements. Do not infer that deleting expired sessions supplies enough space for a report-table rewrite.

The migration currently has no explicit SQL lock deadline. A conflicting long transaction can delay lock acquisition; monitor migration activity and use an operator-configured lock timeout appropriate for the environment. A timed-out migration may require normal Prisma migration failure recovery before retrying. Keep schema functions versioned: generated columns copied with `LIKE INCLUDING ALL` retain dependencies on the original function definitions, so dropping those functions is not a harmless cleanup operation.
