"""Bounded, same-corpus comparisons of v2 authored evaluation reports.

Reports are untrusted input. Derived scores are recalculated rather than used as
truth, and comparisons never claim general accuracy or reconstruct absent links.
"""

import json
import math
import os
import re
import stat
import tempfile
from pathlib import Path

MAX_BASELINE_BYTES = 5 * 1024 * 1024
MAX_CASES = 1000
MAX_LABELS = 10000
MAX_DETAILS = 100
MAX_DETAIL_LABELS = 50
COUNT_KEYS = ("true_positive", "false_positive", "false_negative", "true_negative")
METRIC_KEYS = ("precision", "recall", "f1", "accuracy")
LINK_FAILURE = "target link confidence differs from ambiguity label"
SYNTAX_FAILURE = "invalid syntax was accepted"
TRUTH_SUFFIX = ": affected claim retained a truth status"
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:/-]{1,200}\Z")
TOP_KEYS = {
    "schema_version",
    "dataset",
    "corpus_sha256",
    "scope",
    "passed",
    "case_count",
    "claim_count",
    "rejection_case_count",
    "confusion_matrix",
    "metrics",
    "groups",
    "cases",
}
CASE_KEYS = {
    "name",
    "category",
    "language",
    "expected_affected",
    "actual_affected",
    "false_positives",
    "false_negatives",
    "safety_failures",
    "rejected_invalid_syntax",
    "confusion_matrix",
    "passed",
}


class ComparisonError(ValueError):
    """Controlled error messages intentionally exclude input values and file paths."""


def _require(condition: bool) -> None:
    if not condition:
        raise ComparisonError("Invalid evaluation report: schema or derived values disagree.")


def _integer(value: object, maximum: int = 10_000_000) -> bool:
    return type(value) is int and 0 <= value <= maximum


def _identifier(value: object) -> bool:
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def _labels(value: object, maximum: int = MAX_LABELS) -> set[str]:
    _require(isinstance(value, list) and len(value) <= maximum)
    _require(all(_identifier(label) for label in value))
    _require(len(set(value)) == len(value))
    return set(value)


def _counts(value: object) -> dict[str, int]:
    _require(isinstance(value, dict) and set(value) == set(COUNT_KEYS))
    _require(all(_integer(count) for count in value.values()))
    return value


def _score(counts: dict[str, int]) -> dict[str, float | None]:
    tp, fp, fn, tn = (counts[key] for key in COUNT_KEYS)
    return {
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
        "accuracy": (tp + tn) / (tp + fp + fn + tn) if tp + fp + fn + tn else None,
    }


def _validate_metrics(value: object, counts: dict[str, int]) -> None:
    _require(isinstance(value, dict) and set(value) == set(METRIC_KEYS))
    for key, expected in _score(counts).items():
        actual = value[key]
        _require(
            actual is None
            if expected is None
            else type(actual) in (int, float) and 0 <= actual <= 1 and actual == expected
        )


def _safety_codes(value: object) -> set[str]:
    _require(isinstance(value, list) and len(value) <= MAX_LABELS)
    _require(all(isinstance(message, str) and len(message) <= 250 for message in value))
    _require(len(set(value)) == len(value))
    result = set()
    for message in value:
        if message == LINK_FAILURE:
            result.add("link_confidence")
        elif message == SYNTAX_FAILURE:
            result.add("syntax_accepted")
        elif message.endswith(TRUTH_SUFFIX) and _identifier(message[: -len(TRUTH_SUFFIX)]):
            result.add("truth_status:" + message[: -len(TRUTH_SUFFIX)])
        else:
            raise ComparisonError("Invalid evaluation report: unknown safety assertion.")
    return result


def validate_report(value: object) -> dict:
    """Validate old v2 reports and v2 reports carrying an auxiliary comparison."""
    _require(isinstance(value, dict) and set(value) in (TOP_KEYS, TOP_KEYS | {"comparison"}))
    _require(value["schema_version"] == "2" and value["dataset"] in ("authored-drift-v2", "custom"))
    _require(
        isinstance(value["corpus_sha256"], str)
        and re.fullmatch(r"[a-f0-9]{64}", value["corpus_sha256"]) is not None
    )
    _require(isinstance(value["scope"], str) and 0 < len(value["scope"]) <= 500)
    _require(type(value["passed"]) is bool)
    if "comparison" in value:
        # Historical comparisons are not evidence for this comparison. Never echo them.
        _require(isinstance(value["comparison"], dict))
    cases = value["cases"]
    _require(isinstance(cases, list) and len(cases) <= MAX_CASES)
    _require(_integer(value["case_count"], MAX_CASES) and value["case_count"] == len(cases))
    _require(_integer(value["claim_count"]) and _integer(value["rejection_case_count"], MAX_CASES))
    totals = dict.fromkeys(COUNT_KEYS, 0)
    rejection_count = 0
    names = set()
    for case in cases:
        _require(isinstance(case, dict) and set(case) == CASE_KEYS)
        _require(all(_identifier(case[key]) for key in ("name", "category", "language")))
        _require(case["name"] not in names)
        names.add(case["name"])
        expected, actual = (_labels(case[key]) for key in ("expected_affected", "actual_affected"))
        _require(_labels(case["false_positives"]) == actual - expected)
        _require(_labels(case["false_negatives"]) == expected - actual)
        safety = _safety_codes(case["safety_failures"])
        _require(
            type(case["passed"]) is bool and case["passed"] == (actual == expected and not safety)
        )
        _require(type(case["rejected_invalid_syntax"]) is bool)
        rejected = case["rejected_invalid_syntax"]
        _require(not rejected or (not actual and not safety))
        _require(
            all(
                code.removeprefix("truth_status:") in actual
                for code in safety
                if code.startswith("truth_status:")
            )
        )
        rejection_case = rejected or "syntax_accepted" in safety
        rejection_count += rejection_case
        local = _counts(case["confusion_matrix"])
        if rejection_case:
            _require(all(count == 0 for count in local.values()))
        else:
            _require(local["true_positive"] == len(actual & expected))
            _require(local["false_positive"] == len(actual - expected))
            _require(local["false_negative"] == len(expected - actual))
        for key in COUNT_KEYS:
            totals[key] += local[key]
    _require(_counts(value["confusion_matrix"]) == totals)
    _require(value["claim_count"] == sum(totals.values()))
    _require(value["rejection_case_count"] == rejection_count)
    _require(value["passed"] == (bool(cases) and all(case["passed"] for case in cases)))
    _validate_metrics(value["metrics"], totals)
    groups = value["groups"]
    _require(isinstance(groups, dict) and set(groups) == {"category", "language"})
    for dimension in ("category", "language"):
        group = groups[dimension]
        _require(isinstance(group, dict) and set(group) == {case[dimension] for case in cases})
        for label, summary in group.items():
            members = [case for case in cases if case[dimension] == label]
            subtotal = {
                key: sum(case["confusion_matrix"][key] for case in members) for key in COUNT_KEYS
            }
            _require(
                isinstance(summary, dict)
                and set(summary) == {"case_count", "passed", "confusion_matrix", "metrics"}
            )
            _require(
                _integer(summary["case_count"], MAX_CASES) and summary["case_count"] == len(members)
            )
            _require(
                type(summary["passed"]) is bool
                and summary["passed"] == all(case["passed"] for case in members)
            )
            _require(_counts(summary["confusion_matrix"]) == subtotal)
            _validate_metrics(summary["metrics"], subtotal)
    return value


def _delta(before: int | float | None, after: int | float | None) -> dict:
    return {
        "baseline": before,
        "current": after,
        "delta": after - before if before is not None and after is not None else None,
    }


def compare_reports(current: object, baseline: object) -> dict:
    current, baseline = validate_report(current), validate_report(baseline)
    before = {case["name"]: case for case in baseline["cases"]}
    after = {case["name"]: case for case in current["cases"]}
    incompatible = ComparisonError(
        "Incompatible baseline: use the same schema, corpus, case labels, and coverage."
    )
    if any(
        current[key] != baseline[key]
        for key in (
            "schema_version",
            "dataset",
            "corpus_sha256",
            "claim_count",
            "rejection_case_count",
        )
    ) or set(before) != set(after):
        raise incompatible
    for name, case in after.items():
        old = before[name]
        if (
            any(case[key] != old[key] for key in ("category", "language"))
            or set(case["expected_affected"]) != set(old["expected_affected"])
            or sum(case["confusion_matrix"].values()) != sum(old["confusion_matrix"].values())
        ):
            raise incompatible
        old_rejection = old["rejected_invalid_syntax"] or SYNTAX_FAILURE in old["safety_failures"]
        new_rejection = case["rejected_invalid_syntax"] or SYNTAX_FAILURE in case["safety_failures"]
        if old_rejection != new_rejection:
            raise incompatible
    counts = dict.fromkeys(
        (
            "changed_cases",
            "classification_changed_cases",
            "link_safety_changed_cases",
            "regressed_cases",
            "improved_cases",
            "new_false_positives",
            "resolved_false_positives",
            "new_false_negatives",
            "resolved_false_negatives",
            "new_safety_failures",
            "resolved_safety_failures",
        ),
        0,
    )
    details = []
    truncated = False
    for name in sorted(after):
        old, case = before[name], after[name]
        old_safety, new_safety = (_safety_codes(item["safety_failures"]) for item in (old, case))
        differences = {}
        for field in ("false_positives", "false_negatives"):
            differences["new_" + field] = sorted(set(case[field]) - set(old[field]))
            differences["resolved_" + field] = sorted(set(old[field]) - set(case[field]))
        differences["new_safety_failures"] = sorted(new_safety - old_safety)
        differences["resolved_safety_failures"] = sorted(old_safety - new_safety)
        regression = any(
            differences[key]
            for key in ("new_false_positives", "new_false_negatives", "new_safety_failures")
        ) or (old["rejected_invalid_syntax"] and not case["rejected_invalid_syntax"])
        improvement = any(
            differences[key]
            for key in (
                "resolved_false_positives",
                "resolved_false_negatives",
                "resolved_safety_failures",
            )
        ) or (not old["rejected_invalid_syntax"] and case["rejected_invalid_syntax"])
        classification = set(case["actual_affected"]) != set(old["actual_affected"])
        link = ("link_confidence" in old_safety) != ("link_confidence" in new_safety)
        if not (regression or improvement or classification):
            continue
        counts["changed_cases"] += 1
        counts["classification_changed_cases"] += classification
        counts["link_safety_changed_cases"] += link
        counts["regressed_cases"] += bool(regression)
        counts["improved_cases"] += bool(improvement)
        for key, labels in differences.items():
            counts[key] += len(labels)
        if len(details) >= MAX_DETAILS:
            truncated = True
            continue
        clipped = any(len(labels) > MAX_DETAIL_LABELS for labels in differences.values())
        truncated |= clipped
        details.append(
            {
                "name": name,
                "category": case["category"],
                "language": case["language"],
                "baseline_passed": old["passed"],
                "current_passed": case["passed"],
                "regressed": bool(regression),
                "improved": bool(improvement),
                "classification_changed": classification,
                "link_safety_changed": link,
                "rejected_invalid_syntax": {
                    "baseline": old["rejected_invalid_syntax"],
                    "current": case["rejected_invalid_syntax"],
                },
                "changes": {key: labels[:MAX_DETAIL_LABELS] for key, labels in differences.items()},
                "details_truncated": clipped,
            }
        )
    return {
        "schema_version": "1",
        "corpus_sha256": current["corpus_sha256"],
        "baseline_passed": baseline["passed"],
        "current_passed": current["passed"],
        "passed": counts["regressed_cases"] == 0,
        "counts": counts,
        "confusion_matrix": {
            key: _delta(baseline["confusion_matrix"][key], current["confusion_matrix"][key])
            for key in COUNT_KEYS
        },
        "metrics": {
            key: _delta(baseline["metrics"][key], current["metrics"][key]) for key in METRIC_KEYS
        },
        "safety_failures": _delta(
            sum(len(case["safety_failures"]) for case in before.values()),
            sum(len(case["safety_failures"]) for case in after.values()),
        ),
        "passed_cases": _delta(
            sum(case["passed"] for case in before.values()),
            sum(case["passed"] for case in after.values()),
        ),
        "syntax_rejections": _delta(
            sum(case["rejected_invalid_syntax"] for case in before.values()),
            sum(case["rejected_invalid_syntax"] for case in after.values()),
        ),
        "changed_cases": details,
        "details_truncated": truncated,
    }


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ComparisonError("Invalid baseline JSON: duplicate keys are not accepted.")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ComparisonError("Invalid baseline JSON: nonfinite numbers are not accepted.")


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ComparisonError("Invalid baseline JSON: nonfinite numbers are not accepted.")
    return number


def load_baseline(path: Path) -> tuple[dict, tuple[int, int]]:
    """Do not follow a symlink, block on a FIFO, or read an unbounded report."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BASELINE_BYTES:
                raise ComparisonError("Baseline must be a regular JSON file of at most 5 MiB.")
            raw = source.read(MAX_BASELINE_BYTES + 1)
            after = os.fstat(source.fileno())
        if len(raw) > MAX_BASELINE_BYTES or (before.st_size, before.st_mtime_ns) != (
            after.st_size,
            after.st_mtime_ns,
        ):
            raise ComparisonError("Baseline changed during reading or exceeded the 5 MiB limit.")
        report = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
        return validate_report(report), (before.st_dev, before.st_ino)
    except ComparisonError:
        raise
    except (OSError, UnicodeError, ValueError, RecursionError, OverflowError):
        raise ComparisonError("Could not read a valid, regular baseline JSON report.") from None


def protect_baseline(output: Path, baseline: Path, identity: tuple[int, int]) -> None:
    try:
        if output.resolve() == baseline.resolve():
            raise ComparisonError("Output must not overwrite the baseline report.")
        try:
            target = output.stat()
        except FileNotFoundError:
            return
        if (target.st_dev, target.st_ino) == identity:
            raise ComparisonError("Output must not overwrite the baseline report.")
    except OSError:
        raise ComparisonError("Could not validate the output location.") from None


def write_report(
    output: Path,
    payload: str,
    baseline: Path | None = None,
    identity: tuple[int, int] | None = None,
) -> None:
    """Replace a user-selected output atomically; retain an old file on write failure."""
    temporary = None
    try:
        if baseline is not None and identity is not None:
            protect_baseline(output, baseline, identity)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=output.parent,
            prefix=".groundskeeper-eval-",
            suffix=".tmp",
            delete=False,
        ) as target:
            temporary = Path(target.name)
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        if baseline is not None and identity is not None:
            protect_baseline(output, baseline, identity)
        os.replace(temporary, output)
    except OSError:
        raise ComparisonError("Could not atomically write the evaluation report.") from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
