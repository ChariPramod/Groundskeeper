# Synthetic drift evaluation

Run from the repository root:

```sh
uv run python scripts/evaluate.py
uv run python scripts/evaluate.py --output /tmp/groundskeeper-evaluation.json
```

Both commands print deterministic JSON. `--output` also writes the same report to the supplied path (overwriting it). The process exits 0 when every predicted affected-claim set matches its labels, or 1 when any label differs. Input or execution failures also fail the command rather than producing a passing report.

The `synthetic-drift-v1` dataset has 18 cases: nine mutations in each of Python and TypeScript. Each case contains a target claim and a control claim linked to a separate, unchanged declaration, giving 36 independently scored case/claim pairs.

| Mutation | Expected target label | Purpose |
| --- | --- | --- |
| Rename | Affected | Retain links to removed declarations |
| Default change | Affected | Track signature behavior |
| Removed parameter | Affected | Track incompatible signatures |
| Changed return value | Affected | Track implementation changes |
| Moved file | Affected | Retain a relative path reference to the old location |
| Comments | Unaffected | Ignore comments within and outside declarations |
| Whitespace | Unaffected | Ignore source formatting |
| Unrelated symbol | Unaffected | Avoid propagating an unrelated declaration change |
| Identifier substring | Unaffected | Do not link `resend` to `send` |

The unchanged control claim must remain unaffected in every case. Expected labels are authored explicitly, independently of the analysis result. Cases use the production `Claim`, `SourceFile`, and `AnalysisRequest` models, tree-sitter source parsing, symbol fingerprinting, exact linking, and `analyze` entry point. They do not invoke the Markdown extractor: their claims are hand-authored wire objects.

The initial baseline is 10 true positives, 26 true negatives, zero false positives, and zero false negatives. Precision, recall, F1, and accuracy are each 1.0 **on these synthetic fixtures only**. Reports include actual and expected IDs and per-case false positives/negatives. Ratios without a denominator are JSON `null`, including precision and recall on an empty dataset.

This is a regression gate for candidate selection, not a measurement of verified documentation staleness. A changed implementation does not prove prose false. This small, intentionally clear fixture suite does not establish public-repository performance, ambiguity resolution, Markdown extraction quality, executable-example accuracy, repair quality, or confidence calibration. No repository code is executed during the evaluation.

Next, add a separately versioned, permissively licensed public-repository corpus with pinned before/after commits, extracted real claims, independently reviewed labels, provenance, and separate candidate-selection and verified-staleness metrics. Preserve these synthetic controls as a fast regression gate as that corpus grows.
