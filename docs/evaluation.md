# Candidate selection and safety evaluation

Run from the repository root:

```sh
uv run python scripts/evaluate.py
uv run python scripts/evaluate.py --output /tmp/groundskeeper-evaluation.json
uv run pytest services/analysis/tests/test_evaluation.py -q
```

The CLI prints deterministic JSON and exits 0 only when every affected-claim label and safety assertion passes. Any mismatch exits 1. Unexpected execution failures fail the command; they cannot be counted as successful syntax rejection. Empty suites fail closed. `--output` writes the identical report to the supplied path, overwriting it.

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
