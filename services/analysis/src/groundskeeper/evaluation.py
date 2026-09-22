"""Deterministic synthetic evaluation of candidate drift, not truth verification."""

from collections.abc import Sequence
from dataclasses import dataclass

from groundskeeper.analysis import analyze
from groundskeeper.models import AnalysisRequest, Claim, Position, Reference, SourceFile


@dataclass(frozen=True)
class EvaluationCase:
    name: str
    category: str
    language: str
    request: AnalysisRequest
    expected_affected: frozenset[str]


def _claim(claim_id: str, text: str, path: str | None = None) -> Claim:
    return Claim(
        id=claim_id,
        page="docs/guide.md",
        anchor="usage",
        kind="paragraph",
        text=text,
        position=Position(start_line=1, start_column=1, end_line=1, end_column=len(text) + 1),
        references=[Reference(kind="path", value=path)] if path else [],
    )


def synthetic_cases() -> list[EvaluationCase]:
    """Return independent positive mutations and negative controls in both languages."""
    cases = []
    for language, extension in (("python", "py"), ("typescript", "ts")):
        if language == "python":
            original = "def send(timeout=30):\n    return 'ok'\n"
            unrelated = "\ndef health():\n    return 'ready'\n"
            mutations = {
                "rename": original.replace("send(", "deliver("),
                "default_change": original.replace("30", "60"),
                "removed_parameter": original.replace("timeout=30", ""),
                "changed_output": original.replace("'ok'", "'queued'"),
                "moved_file": original,
                "comments": "# usage\n"
                + original.replace("    return", "    # result\n    return"),
                "whitespace": original.replace("    return", "  return") + "\n",
                "unrelated_symbol": original,
                "identifier_substring": original.replace("'ok'", "'queued'"),
            }
        else:
            original = "export function send(timeout = 30) { return 'ok'; }\n"
            unrelated = "export function health() { return 'ready'; }\n"
            mutations = {
                "rename": original.replace("send(", "deliver("),
                "default_change": original.replace("30", "60"),
                "removed_parameter": original.replace("timeout = 30", ""),
                "changed_output": original.replace("'ok'", "'queued'"),
                "moved_file": original,
                "comments": "// usage\n" + original.replace("return", "/* result */ return"),
                "whitespace": original.replace(" { return ", "\n{\n  return ").replace(
                    "; }", ";\n}"
                ),
                "unrelated_symbol": original,
                "identifier_substring": original.replace("'ok'", "'queued'"),
            }
        positives = {
            "rename",
            "default_change",
            "removed_parameter",
            "changed_output",
            "moved_file",
        }
        for category, changed in mutations.items():
            name = f"{language}/{category}"
            target = _claim("target", "Call send to deliver a message.")
            if category == "moved_file":
                target = _claim("target", "Read the client source.", f"../client.{extension}")
            elif category == "identifier_substring":
                target = _claim("target", "Use resend to retry a message.")
            # This second claim must stay unaffected even when the target drifts.
            control = _claim("control", "Call readiness to check service availability.")
            stable = SourceFile(
                path=f"status.{extension}",
                content=(
                    "def readiness():\n    return True\n"
                    if language == "python"
                    else "export function readiness() { return true; }\n"
                ),
            )
            before = [SourceFile(path=f"client.{extension}", content=original + unrelated)]
            after = [
                SourceFile(
                    path=f"{'moved' if category == 'moved_file' else 'client'}.{extension}",
                    content=changed
                    + (
                        unrelated.replace("'ready'", "'healthy'")
                        if category == "unrelated_symbol"
                        else unrelated
                    ),
                )
            ]
            cases.append(
                EvaluationCase(
                    name=name,
                    category=category,
                    language=language,
                    request=AnalysisRequest(
                        claims=[target, control], before=[*before, stable], after=[*after, stable]
                    ),
                    expected_affected=frozenset({"target"} if category in positives else ()),
                )
            )
    return cases


def evaluate(cases: Sequence[EvaluationCase] | None = None) -> dict:
    """Score each case/claim pair; null ratios mean the denominator was zero."""
    selected = list(synthetic_cases() if cases is None else cases)
    if len({case.name for case in selected}) != len(selected):
        raise ValueError("evaluation case names must be unique")
    counts = {"true_positive": 0, "false_positive": 0, "false_negative": 0, "true_negative": 0}
    results = []
    for case in selected:
        claim_ids = {claim.id for claim in case.request.claims}
        if not case.expected_affected <= claim_ids:
            raise ValueError(f"{case.name}: expected labels reference unknown claims")
        report = analyze(case.request)
        actual = {impact.claim_id for impact in report.impacts}
        expected = case.expected_affected
        counts["true_positive"] += len(actual & expected)
        counts["false_positive"] += len(actual - expected)
        counts["false_negative"] += len(expected - actual)
        counts["true_negative"] += len(claim_ids - actual - expected)
        results.append(
            {
                "name": case.name,
                "category": case.category,
                "language": case.language,
                "expected_affected": sorted(expected),
                "actual_affected": sorted(actual),
                "false_positives": sorted(actual - expected),
                "false_negatives": sorted(expected - actual),
                "passed": actual == expected,
            }
        )
    tp, fp, fn = counts["true_positive"], counts["false_positive"], counts["false_negative"]
    total = sum(counts.values())
    return {
        "schema_version": "1",
        "dataset": "synthetic-drift-v1",
        "scope": (
            "Candidate drift on hand-authored claims; not verified staleness or a public corpus."
        ),
        "passed": all(result["passed"] for result in results),
        "case_count": len(results),
        "claim_count": total,
        "confusion_matrix": counts,
        "metrics": {
            "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / (tp + fn) if tp + fn else None,
            "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
            "accuracy": (tp + counts["true_negative"]) / total if total else None,
        },
        "cases": results,
    }
