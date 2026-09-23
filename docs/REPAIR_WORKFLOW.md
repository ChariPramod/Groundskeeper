# Review, repair, and publication workflow

This iteration connects reproducible documentation failures to bounded repair proposals, independent verification and explicitly approved draft pull requests. It also adds manual PR analysis, neutral GitHub checks and deeper dashboard review. It does not claim that failures are impossible: unsupported inputs and unavailable dependencies stop publication while retaining evidence for recovery.

## 1. Inspect a finding

Start the dashboard with `pnpm dev`, open a run, and inspect its documentation excerpt, affected symbols and execution reason. Live details use the same installation-scoped access token as the overview. Source excerpts are rendered as text, capped at 4,000 characters; raw sandbox output and webhook payloads are omitted from this view.

Owner, notes and dismissal are **local browser annotations**. They do not change execution outcomes, notify teammates, or provide a shared audit log. If browser storage is blocked, annotations remain in memory for the open review. Live detail errors show a retry without replacing the parent dashboard data.

## 2. Try the repair fixture

```sh
pnpm repair:demo
```

This runs the real parser, Python analysis bridge and verifier against `examples/tutorial`. It requires no database or GitHub credentials. A ready Docker runtime with the cached `python:3.12-slim` image is needed for successful execution. Without it, the command exits 2 and saves a **blocked** artifact. This is an intentional failure-path demonstration, not successful Docker validation.

Inspect the printed artifact digest:

```sh
pnpm repair:inspect --artifact <artifact-sha256>
```

The fixture uses a synthetic repository identity and is not publishable against a real stored run.

## 3. Prepare a real proposal

First finish the real GitHub/Postgres/Docker setup in `PROJECT_HANDOFF.md`. Apply the new publication-reservation migration:

```sh
pnpm db:generate
pnpm db:migrate
pnpm db:status
pnpm repair:prepare --analysis-run <id> --installation-id <id>
```

Preparation fetches the immutable after-commit snapshot for the owned stored analysis, reproduces the original failure, constructs a candidate, and executes the amended examples afresh. It saves an immutable JSON artifact under `.groundskeeper/repairs/` before any publication.

Automatic suggestions are deliberately narrow: **an opted-in Python block that exits successfully but whose stdout differs from its adjacent output assertion**. The replacement updates that assertion, preserves line endings, and chooses a safe fence delimiter even when stdout contains Markdown fences. Treat the new expected output as a suggestion: a changed program result may be a code regression rather than the desired documentation behavior. Review the semantics before approving.

For a reviewed function-name, argument, or example-code edit, supply a JSON file containing one to three full replacement documentation pages:

```json
[
  {
    "path": "docs/quickstart.md",
    "after": "# Quickstart\n\n...complete replacement Markdown...\n"
  }
]
```

```sh
pnpm repair:prepare --analysis-run <id> --installation-id <id> --replacements /path/to/replacements.json
```

Manual replacements do not bypass verification. The engine rejects removed blocks, removed/blanked assertions, changed opt-in or tutorial session metadata, unsupported languages and incomplete execution. It executes all code blocks on the changed pages, not just the selected failing block. Every changed-page code block currently must be opted-in Python; mixed-language/non-executable code pages are blocked. Bounds are three existing pages, 150 conservatively counted added/removed lines, 200 KB per documentation page, and ten verification execution units including tutorial replay costs. An automatically selected page that requires no change blocks that batch; narrow the manual replacement set after inspection.

## 4. Review the exact artifact

```sh
pnpm repair:inspect --artifact <artifact-sha256>
```

Inspection prints escaped JSON containing the actual before/after page text, pinned commit, baseline/post outcomes, blockers and proposal ID. The dashboard's Repairs view can also show a locally saved artifact when connected in live mode. Demo repairs are clearly illustrative.

There are two identifiers:

- **Artifact SHA-256:** hashes the entire immutable artifact, including evidence. It is the filename and is checked on read.
- **Proposal ID:** hashes the repository/run/commit/runtime and exact page replacements. It is the explicit approval value and determines the review branch.

The same patch can produce a new artifact with fresh execution evidence while retaining its proposal ID. Files are written to a private temporary file, synchronized, and linked into place without overwriting an existing artifact. Readers reject traversal, symlinks, oversized files and digest mismatches. Artifacts can contain repository documentation and execution output; keep `.groundskeeper` private and out of version control.

## 5. Explicitly publish a draft PR

Grant the development GitHub App **Contents: write** and **Pull requests: write** only when you intend to use publication. Existing read-only analysis/verification does not need these permissions. Install the updated permission grant on the chosen development repository.

After inspecting the exact proposal:

```sh
pnpm repair:publish --artifact <artifact-sha256> --approve <proposal-id>
```

The command reconstructs the proposal from the authoritative owned analysis and pinned repository snapshot, reproduces the original failure and reruns the patch. The patch ID and resolved runtime image identity must still match the reviewed artifact. A failed, missing, partial or changed verification stops publication.

Before any GitHub mutation, Postgres reserves the analysis run's publication budget for that proposal. Repository page/line/PR limits are enforced, with a conservative single-PR-per-analysis cap. Another proposal cannot consume the same reservation. A ten-minute token lease serializes active publishers and is checked before each remote mutation.

The publisher checks the current default-branch head, exact original blob hashes and the entire resulting repository tree. It uses `groundskeeper/<proposal-prefix>` with a create-only branch reference. It never updates the default branch, force-pushes, merges, or replaces an existing conflicting branch. A moved default branch requires a new analysis/proposal. The created PR is a draft with commit, analysis, verification and proposal identifiers in its body.

An immutable local receipt is saved before database finalization. Retrying the **same** proposal validates and reuses its exact branch and existing PR after partial success. An existing closed PR prevents creation of another PR. A branch edited by someone else fails validation and requires manual review.

## 6. Analyze pull requests and report informational checks

The push worker remains finite and default-branch oriented. For an open same-repository PR:

```sh
pnpm pr:analyze --repo owner/repository --pr 123 --installation-id <id>
```

The command fetches the PR's immutable head and merge base, avoiding unrelated target-branch changes in the comparison. It parses documentation at the head, performs analysis, saves a local artifact and persists a scoped analysis run. Repeating the same PR/base/head combination is idempotent. Fork PRs, closed PRs, invalid identities and incomplete snapshots fail before persistence.

To write an informational check, grant **Checks: write** and explicitly request it:

```sh
pnpm check:run --analysis-run <id> --installation-id <id> --publish-check
# Or analyze and publish the check in one invocation:
pnpm pr:analyze --repo owner/repository --pr 123 --installation-id <id> --publish-check
```

Checks always conclude **neutral**. They report candidate drift, never claim that documentation passed execution, and do not act as a required verification gate. Up to 50 validated file/line annotations are included without source text or raw execution output. The adapter validates repository, commit and app identity, and reuses a matching check after a lost response. A database advisory lock serializes normal concurrent CLI calls. GitHub does not provide transactional exactly-once check creation; a lost database lock while an external request is in flight can still require manual reconciliation.

PR analysis now also runs from signed webhook deliveries through the finite worker; see [PULL_REQUEST_WORKER.md](PULL_REQUEST_WORKER.md). A supervised or scheduled worker process is still required. Fork support and merge-blocking verified checks remain future work. Draft repair publication targets an analyzed default-branch commit; a PR-head analysis can be reviewed and checked, but cannot publish a default-branch repair until its base policy is satisfied.

## 7. Recovery rules

| Failure | Preserved result | Next action |
| --- | --- | --- |
| Docker/image unavailable | Blocked proposal and available baseline evidence | Restore the runtime; prepare again |
| Original failure does not reproduce | Blocked artifact | Investigate nondeterminism or changed assumptions |
| Proposed examples fail, skip or lack evidence | Blocked patch artifact | Review/edit the replacement; prepare again |
| Artifact altered | No publication | Return to an intact saved artifact or regenerate |
| DB unavailable before reservation | Local verified artifact; no GitHub write | Restore DB and retry the same artifact |
| Another publisher owns lease | Durable proposal reservation | Wait for completion/expiry; retry same proposal |
| GitHub permissions/network failure | Artifact, durable reservation, possibly partial branch | Fix access; retry same proposal for reconciliation |
| Remote PR exists but DB finalization fails | Immutable local receipt when writable; remote branch/PR | Retry the same artifact; existing PR is recovered |
| Default head moved or branch was modified | Original evidence and branch left intact | Reanalyze/review; never overwrite another change |
| Browser storage unavailable | In-memory annotation | Keep the dialog open and copy important notes |

Reservations deliberately remain bound to one proposal after an ambiguous remote failure. There is no automated “free budget” or competing-proposal reset command. A changed proposal for the same reserved analysis requires operator reconciliation; a new independently analyzed commit produces a new run. Database cascades and operator-level SQL remain administrative capabilities, so do not treat local database credentials as a public tenant authorization boundary.

## 8. Validation and remaining work

Unit tests cover repair gates, source/image identity, injection-safe fences, tampering, immutable artifact writes, budgets, publication retries, stale heads, unexpected branch content, neutral checks and PR identity. PostgreSQL integration tests cover publication leases and competing proposals in an isolated schema. Browser tests cover detailed review, local annotations, unavailable storage and retained overview data when details fail.

Successful real Docker execution, Postgres reservation/migration behavior and GitHub draft/check creation remain unvalidated on this development machine. No real repository changes or GitHub messages were sent while implementing this feature. Run the live smoke test against a development repository before enabling unattended use.

Further work: persistent shared review ownership/history; authenticated browser execution actions; supervised worker scheduling; fork access handling; version/dependency-aware verification; safe automatic function/argument edits; hosted per-user authorization and production sandbox infrastructure.
