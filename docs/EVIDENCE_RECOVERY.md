# Recover saved verification evidence

When verification finishes but Postgres persistence fails, the execution report remains on disk. `verify:import` validates and stores that same report without running Docker or creating another verification attempt. It never writes to GitHub.

## New artifacts

`pnpm verify:run` now writes an atomic, immutable artifact under the workspace's `.groundskeeper/verifications/<sha256>.json` and prints the exact file SHA-256. Keep that digest alongside the artifact.

After restoring the database, run from the project root:

```sh
pnpm verify:import --analysis-run <original-analysis-id> --installation-id <installation-id> --artifact <saved-file-path> --sha256 <printed-sha256>
```

The command needs `DATABASE_URL`, the existing GitHub App credentials, read access to the original repository, and the locked Python environment (`uv sync --locked`). Docker and its runtime image are not needed. It refetches Python sources at the owning analysis's exact commit, checks repository/installation identity, then validates the saved evidence against those bytes and the complete affected claim/tutorial selection.

A successful import exits 0 and prints `{runId, created}`. Repeating the same import returns `created: false`; it does not change the original report ID, timestamps, verdicts or counts. Exit 0 means persistence succeeded, not that all examples passed. Failed, skipped and infrastructure-error reports preserve their original outcomes. A conflicting report ID is rejected by the existing immutable storage layer.

## Validation and failure behavior

- File reads reject symlinks, nonregular files, files over 32 MB, size changes and checksum mismatches.
- The trusted Python validator checks the report schema, pinned source digest, original claim assertions, complete tutorial membership, prerequisite digests, evidence coverage, verdict fields and summary counts. Repository examples are never evaluated by this validator.
- Missing ownership, a changed repository identity, invalid evidence or unavailable GitHub/database/Python dependencies aborts the import. The local artifact remains unchanged. Fix the cause and retry the exact command.
- Database persistence rechecks ownership inside its transaction, rejects conflicting report identities and safely handles duplicate replay.
- CLI failures print an error class, not raw repository content, sandbox output or external stderr.

Checksums detect changed bytes relative to a trusted saved digest; they are not digital signatures or proof that execution occurred. Import only artifacts from your own trusted verifier. This local operator command is not an upload endpoint for untrusted users. Imported reports do not bypass the repair publisher's independent fresh verification requirement.

## Older artifacts

Existing `.groundskeeper/verifications/<report-id>.json` files are supported if they satisfy current validation. They did not record a separate digest. Inspect the trusted original file, calculate its SHA-256 (for example, `shasum -a 256 <path>`), and supply that value. Calculating a digest after a file was modified cannot establish its original integrity.

## Remaining work

Hosted durable artifact storage, authenticated browser import, shared audit history and signed verifier provenance remain separate work. This command recovers local evidence after a transient persistence failure; it does not provision live worker infrastructure.
