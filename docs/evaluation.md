# Candidate selection and safety evaluation

Run from the repository root:

```sh
uv run python scripts/evaluate.py
uv run python scripts/evaluate.py --output /tmp/groundskeeper-evaluation.json
uv run pytest services/analysis/tests/test_evaluation.py services/analysis/tests/test_evaluation_comparison.py -q
```

The CLI prints deterministic JSON and exits 0 only when every affected-claim label and safety assertion passes and any requested baseline comparison has no regressions. A failing current case or a regression exits 1. Invalid or incompatible baselines, engine failures, and output failures exit 2 with a controlled message on stderr and no report on stdout. Unexpected execution failures cannot be counted as successful syntax rejection. Empty suites fail closed. `--output` writes the identical report through an atomic replacement of the chosen path; it cannot overwrite a baseline used by the same command.

## Versioned regression corpus

`authored-drift-v2` has **38 authored cases**, covering 19 categories in each of Python and TypeScript. Each case contains a target and a separate control claim. Two malformed-input cases must reject analysis and are excluded from accuracy denominators: the remaining 36 cases supply **72 scored case/claim pairs**.

The report schema is version 2. It includes a SHA-256 of the complete ordered corpus inputs and labels, per-category and per-language confusion matrices and metrics, per-case predictions and safety failures, and separate rejection coverage. The corpus digest and category counts are pinned in a unit test. Intentional fixture changes require reviewing and updating that pin. Custom suites are labeled `custom`; their results are never labeled as the built-in corpus.

| Category | Expected behavior |
| --- | --- |
| Rename, default change, removed parameter, changed output | Flag the linked claim as a candidate requiring verification |
| Moved file, deleted file | Preserve old path links and flag the claim |
| Comments, whitespace | Ignore source formatting and comments |
| Unrelated symbol | Leave the unrelated claim unaffected |
| Identifier substring, case sensitivity | Avoid linking `resend` or `SEND` to `send` |
| Ambiguous identifier | Flag possible impact with link confidence exactly 0.5 for two declarations |
| Explicit identifier | Link a structured reference even without the identifier in prose |
| Encoded relative path | Resolve percent encoding and the path fragment consistently |
| Unlinked prose | Leave unmatched prose unverified; absence of a candidate is not proof of correctness |
| Instruction-like prose | Treat instructions embedded in documentation as ordinary text; never grant verified status |
| Previously verified claim | Reset affected claims to unknown when code changes |
| Unsupported language | Do not invent candidate links for unsupported Rust source |
| Invalid syntax | Reject incomplete Python/TypeScript input instead of returning a clean report |

The baseline is 22 true positives, 50 true negatives, zero false positives, and zero false negatives, **only on these authored fixtures**. Ratios without a denominator are JSON `null`. In particular, malformed-input rejection has no precision, recall, or accuracy score. The gate checks every case, so high aggregate scores cannot hide a failing language or category.

Safety assertions are independent of candidate accuracy. The evaluation tests deliberately mutate analysis results to show the gate fails when ambiguous links become overconfident, changed claims become falsely verified, or malformed source is silently accepted—even if aggregate candidate accuracy looks perfect. Other tests cover mislabeled false positives/negatives, corpus identity changes, unexpected engine errors, duplicate names, unknown labels, deterministic results, and CLI exit behavior.

## Compare a change against a saved baseline

Capture the baseline before changing the implementation, then compare the same corpus after the change:

```sh
mkdir -p .groundskeeper/evals
pnpm eval --output .groundskeeper/evals/baseline.json

# Make an implementation change without editing the corpus inputs or labels.
pnpm eval --baseline .groundskeeper/evals/baseline.json \
  --output .groundskeeper/evals/current.json
```

Existing schema-v2 reports produced by `pnpm eval` are valid baselines. A report emitted with a comparison can also serve as a later baseline; its old comparison is ignored because only that report's case results are evidence for the new comparison. There is no automatic baseline promotion.

Both reports must have the same schema, dataset, corpus hash, case identities, category/language labels, expected affected-claim sets, and scored/rejection coverage. Result-array order and label-array order do not change compatibility. A changed corpus is rejected as incompatible with exit 2, even if its aggregate accuracy looks better. Review fixture changes separately and explicitly capture a new baseline after that review.

The comparison adds a `comparison` object with its own schema version `1`. The enclosing evaluation report remains schema version `2`. It includes:

- Baseline/current/delta values for confusion counts, precision, recall, F1, accuracy, passed-case count, safety-failure count, and actual syntax rejections. Undefined ratios and their deltas remain `null`.
- Counts of changed, regressed, and improved cases, new/resolved false positives and false negatives, and new/resolved safety assertions.
- Per-case classification changes and link-confidence safety changes, identified by case/category/language. These reports do not contain link graphs or actual confidence values, so the comparison does not claim to measure arbitrary link changes.
- Up to 100 changed-case details, with up to 50 labels per change list and explicit truncation flags. Aggregate counts and the regression gate use all validated cases, even when the displayed detail is truncated. No source bodies or prior comparison payloads are copied into the comparison.

A new wrong claim, a new safety assertion failure, or a lost required syntax rejection fails the comparison. Replacing one failure with a different failure is a regression even when accuracy is unchanged. A smaller total safety-failure count cannot hide a newly failing assertion elsewhere. A case can both improve and regress if it resolves one problem while introducing another.

`comparison.passed` means that no new regressions were found. The original report's `passed` field still means that every current case passes. Both must be true for exit 0; an improvement over a failing baseline does not waive remaining current failures. Candidate metrics remain separate from safety checks, so an overconfident ambiguous link can fail the comparison even with 100% candidate-label accuracy.

## Baseline and artifact integrity

Baseline input is treated as untrusted data. The reader requires a regular file of at most 5 MiB, refuses final-component symlinks, uses a nonblocking open so a FIFO cannot hang the command, and detects size/mtime changes during reading. JSON duplicate keys, nonfinite numbers, malformed schema, unknown safety assertions, duplicate identities, and contradictory derived values are rejected. Reports are limited to 1,000 cases. Confusion matrices, false-positive/negative sets, group totals, pass flags, and all metrics are checked against case results rather than trusted as supplied.

The corpus hash identifies the authored inputs and labels. It does not authenticate a historical execution, and schema validation is not a signature. Preserve reviewed baselines in a trusted artifact store or source-control workflow rather than accepting an unexplained report as performance evidence.

Output protection compares resolved paths and file identity, so an output path, symlink, or hard link pointing at the baseline is rejected. A completed report is written to a temporary file in the output directory, flushed and synced, then atomically replaces the chosen output. A failed replacement retains the existing output and cleans up the temporary file. The parent directory must already exist. Invalid comparison input never replaces an existing output artifact.

Tests cover compatible reports, reordered result rows, improvements, regressions with unchanged aggregate metrics, link-confidence safety regressions, lost syntax rejection, decreased failure totals with a new failure, tampered metrics/counts/groups, invalid JSON and NaN/Infinity, incompatible corpora, detail bounds, filesystem guards, output failure recovery, CLI exit codes, and redacted errors.

## What this proves and what it does not

Cases exercise production wire models, tree-sitter parsing, semantic fingerprints, exact linking, and the analysis entry point. Their claims are hand-authored wire objects. They do **not** exercise Markdown extraction, execute examples, contact GitHub, use a hosted worker, or measure end-to-end repair quality. The repository's parser, verifier, Docker, persistence, webhook, and browser tests validate those components separately; they are not additional accuracy observations in this corpus.

The numeric link confidence is ambiguity dilution (`1 / matching declarations`), not calibrated probability that documentation is stale. An implementation change is a reason to investigate, not a truth label. Unsupported or unlinked content remains a coverage limitation even when its expected candidate label is negative.

This suite is a deterministic regression gate, **not production accuracy, a public-repository benchmark, or operational proof**. No repository code runs during this evaluation. The fixtures are authored for this repository; no third-party corpus or license claim is implied.

## CI and the next evidence needed

Run the CLI as a required CI step, alongside the evaluation unit tests, and retain its JSON artifact even when it fails. Compare results only when corpus digests match. On corpus changes, review input changes and expected labels rather than accepting a new aggregate score automatically.

Before reporting general accuracy or product readiness:

1. Add a separately versioned, permissively licensed public-repository corpus with pinned before/after commits and stored provenance/license text. Extract actual documentation through the production parser.
2. Have labels reviewed independently. Keep candidate impact, verified staleness, ambiguity, and unsupported cases separate; maintain a held-out set that did not drive implementation.
3. Measure executable-example outcomes and repair acceptance independently, including infrastructure errors, skipped work, and false repairs. Do not drop unknown/error outcomes from coverage reporting.
4. Record a hosted pilot from signed webhook through durable queue, worker processing, persisted evidence, authorized dashboard reads, and human-approved repair. Include duplicate delivery, worker interruption, and database outage recovery.
5. Track queue age, retry exhaustion, processing latency, verification error rate, and tenant isolation separately from documentation detection quality.
