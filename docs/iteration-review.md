# v1 iteration review

## Scope decision

The first build covers structural claim extraction and candidate drift. It does not yet deliver the execution plan's central promise: a verified fix in a reviewable PR. More UI or additional integrations would not close that gap.

This iteration adds the first execution boundary: **opted-in standalone Python example → bounded Docker execution → stdout/exit-code verdict → immutable local evidence report**. It also fixes an identity error that could make later evidence reuse unsafe.

## Findings and changes

| Finding | Change | Remaining boundary |
| --- | --- | --- |
| Claim IDs ignored link destinations, language, opt-in markers and expected output | Include those fields in claim identity; regression tests cover each | Re-index existing documents after this change |
| Drift candidates had no execution evidence | Python verifier, explicit stdout comparisons, distinct passed/failed/error/skipped outcomes | Python only; each block is self-contained, not a shared tutorial session |
| A failed container launch could be mistaken for stale docs | Infrastructure failures retain `unknown`; the runner reads container state separately from CLI exit status | Dependency errors inside the chosen image are example failures in that environment |
| No execution isolation existed | Non-root, no-network, read-only Docker containers; bounded copied Python source, CPU/memory/PID/output/time limits; cleanup | Real Docker checks run in CI; local machine has no Docker |
| A report had no execution provenance | Source and claim digests, resolved Docker image ID, timestamps, limits, stdout/stderr and exit code | No database evidence writer or retention policy yet |
| Source scanning descended into ignored dependency trees | Prune traversal before reading and bound snapshot size | No non-code resources, package installation, symlink targets or repository secrets are copied |

The source snapshot limit is 1,000 files / 10 MB, with 2 MB per source file. Code snippets are limited to 64 KiB. Execution defaults are 10 blocks per run, 10 seconds per block including Docker setup, 128 MB RAM, 64 KiB combined stdout/stderr, one CPU, and 64 PIDs. Cleanup gets an additional five seconds. A zero block budget runs nothing.

## What the verdict means

- `verified`: the opted-in Python block completed in the selected image; if an `output` fence exists, stdout matched it. This does not verify nearby prose.
- `stale`: the example failed or its stdout differed from the documented assertion in that environment.
- `unknown`: no relevant proof, exhausted run budget, or an infrastructure/resource/cleanup failure.
- `unverifiable`: the block was not opted in, uses an unsupported language, or exceeds the input limit.

One final stdout newline and CRLF line endings are normalized; other whitespace remains significant. Reports never overwrite an existing file. CLI exit codes are 0 for no observed failures (including skipped work), 1 for failed examples, and 2 for infrastructure/input errors. Consumers must inspect coverage and skipped counts before treating a run as a release gate.

## Next sequence

1. Run and harden the real Docker tests, including timeout/output exhaustion and cleanup. Docker is a development sandbox here; hosted multi-tenant verification still needs a stronger isolation and resource-management design.
2. Persist verification runs and evidence against pinned commits; connect the webhook inbox to a tenant-scoped worker. Preserve at-least-once delivery behavior and reserve budgets atomically.
3. Add ordered tutorial sessions, dependency/runtime configuration, TypeScript execution, and links/CLI verification. Avoid claiming a whole paragraph is verified just because one reference passes.
4. Build the permissive public-repo corpus and measure false-stale results before implementing independent repair/QA and PR publication.

Dashboard, screenshot regeneration, wiki/CMS adapters, learned conventions and scheduled autonomous maintenance remain deferred according to the original version fences.

Docker command options follow the official [container run reference](https://docs.docker.com/reference/cli/docker/container/run/) and [resource/runtime documentation](https://docs.docker.com/engine/containers/run/).
