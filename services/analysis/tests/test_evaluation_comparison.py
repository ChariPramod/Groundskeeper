import copy
import importlib.util
import json
import os
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from groundskeeper.evaluation import _score, evaluate, synthetic_cases
from groundskeeper.evaluation_comparison import (
    COUNT_KEYS,
    LINK_FAILURE,
    MAX_BASELINE_BYTES,
    ComparisonError,
    compare_reports,
    load_baseline,
    protect_baseline,
    validate_report,
    write_report,
)


@pytest.fixture(scope="module")
def healthy():
    return evaluate()


def refresh(report):
    """Build coherent old reports after deliberately mutating their recorded predictions."""
    for case in report["cases"]:
        expected, actual = set(case["expected_affected"]), set(case["actual_affected"])
        case["false_positives"] = sorted(actual - expected)
        case["false_negatives"] = sorted(expected - actual)
        if (
            not case["rejected_invalid_syntax"]
            and "invalid syntax was accepted" not in case["safety_failures"]
        ):
            total = sum(case["confusion_matrix"].values())
            case["confusion_matrix"] = {
                "true_positive": len(actual & expected),
                "false_positive": len(actual - expected),
                "false_negative": len(expected - actual),
                "true_negative": total - len(actual | expected),
            }
        case["passed"] = actual == expected and not case["safety_failures"]
    report["confusion_matrix"] = {
        key: sum(case["confusion_matrix"][key] for case in report["cases"]) for key in COUNT_KEYS
    }
    report["metrics"] = _score(report["confusion_matrix"])
    report["passed"] = bool(report["cases"]) and all(case["passed"] for case in report["cases"])
    for dimension, groups in report["groups"].items():
        for label, group in groups.items():
            members = [case for case in report["cases"] if case[dimension] == label]
            group["confusion_matrix"] = {
                key: sum(case["confusion_matrix"][key] for case in members) for key in COUNT_KEYS
            }
            group["metrics"] = _score(group["confusion_matrix"])
            group["passed"] = all(case["passed"] for case in members)
    return report


def test_unchanged_report_and_reordered_cases_are_comparable(healthy):
    baseline = copy.deepcopy(healthy)
    baseline["cases"].reverse()
    baseline["comparison"] = {"ignored_historical_result": "not evidence"}
    comparison = compare_reports(healthy, baseline)
    assert comparison["passed"]
    assert comparison["counts"]["changed_cases"] == 0
    assert comparison["changed_cases"] == []
    assert comparison["metrics"]["accuracy"]["delta"] == 0
    assert "ignored_historical_result" not in json.dumps(comparison)


def test_new_wrong_claim_regresses_and_removing_it_improves(healthy):
    worse = copy.deepcopy(healthy)
    worse["cases"][0]["actual_affected"] = []
    refresh(worse)
    regression = compare_reports(worse, healthy)
    assert not regression["passed"]
    assert regression["counts"]["new_false_negatives"] == 1
    assert regression["confusion_matrix"]["false_negative"]["delta"] == 1
    assert regression["changed_cases"][0]["changes"]["new_false_negatives"] == ["target"]
    improvement = compare_reports(healthy, worse)
    assert improvement["passed"]
    assert improvement["counts"]["improved_cases"] == 1
    assert improvement["counts"]["resolved_false_negatives"] == 1


def test_relocation_of_same_number_of_errors_is_a_regression(healthy):
    old, new = copy.deepcopy(healthy), copy.deepcopy(healthy)
    old["cases"][0]["actual_affected"] = []
    new["cases"][1]["actual_affected"] = []
    refresh(old)
    refresh(new)
    comparison = compare_reports(new, old)
    assert comparison["metrics"]["accuracy"]["delta"] == 0
    assert not comparison["passed"]
    assert comparison["counts"]["regressed_cases"] == 1
    assert comparison["counts"]["improved_cases"] == 1


def test_link_safety_regression_is_visible_with_perfect_candidate_metrics(healthy):
    current = copy.deepcopy(healthy)
    case = next(case for case in current["cases"] if case["category"] == "ambiguous_identifier")
    case["safety_failures"] = [LINK_FAILURE]
    refresh(current)
    comparison = compare_reports(current, healthy)
    assert current["metrics"]["accuracy"] == 1
    assert not comparison["passed"]
    assert comparison["counts"]["link_safety_changed_cases"] == 1
    assert comparison["safety_failures"] == {"baseline": 0, "current": 1, "delta": 1}
    assert comparison["changed_cases"][0]["changes"]["new_safety_failures"] == ["link_confidence"]


def test_lost_syntax_rejection_is_a_regression_without_scoring_it_as_negative(healthy):
    current = copy.deepcopy(healthy)
    case = next(case for case in current["cases"] if case["category"] == "invalid_syntax")
    case["rejected_invalid_syntax"] = False
    case["safety_failures"] = ["invalid syntax was accepted"]
    refresh(current)
    comparison = compare_reports(current, healthy)
    assert not comparison["passed"]
    assert comparison["syntax_rejections"] == {"baseline": 2, "current": 1, "delta": -1}
    assert comparison["metrics"]["accuracy"]["delta"] == 0


def test_new_safety_failure_cannot_hide_behind_a_smaller_total(healthy):
    old, new = copy.deepcopy(healthy), copy.deepcopy(healthy)
    old["cases"][0]["safety_failures"] = [
        "target: affected claim retained a truth status",
        LINK_FAILURE,
    ]
    new["cases"][1]["safety_failures"] = ["target: affected claim retained a truth status"]
    refresh(old)
    refresh(new)
    comparison = compare_reports(new, old)
    assert comparison["safety_failures"]["delta"] == -1
    assert not comparison["passed"]
    assert comparison["counts"]["new_safety_failures"] == 1
    assert comparison["counts"]["resolved_safety_failures"] == 2


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r.update(schema_version="3"),
        lambda r: r.update(case_count=True),
        lambda r: r.update(passed=False),
        lambda r: r.update(claim_count=r["claim_count"] - 1),
        lambda r: r.update(rejection_case_count=0),
        lambda r: r["metrics"].update(accuracy=0.5),
        lambda r: r["metrics"].update(accuracy=float("nan")),
        lambda r: r["metrics"].update(accuracy=True),
        lambda r: r["groups"]["language"]["python"]["metrics"].update(accuracy=0.8),
        lambda r: r["groups"]["language"]["python"].update(passed=False),
        lambda r: r["cases"][0].update(false_positives=["invented"]),
        lambda r: r["cases"][0].update(actual_affected=["target", "target"]),
        lambda r: r["cases"][0].update(safety_failures=["PRIVATE_SOURCE_BODY"]),
        lambda r: r["cases"][0]["confusion_matrix"].update(true_positive=0),
        lambda r: r["cases"][0]["confusion_matrix"].update(true_negative=-1),
        lambda r: r["cases"][0].update(extra="PRIVATE_SOURCE_BODY"),
        lambda r: r["cases"][1].update(name=r["cases"][0]["name"]),
        lambda r: r["metrics"].update(accuracy=10**1000),
        lambda r: r["cases"].append(copy.deepcopy(r["cases"][0])),
    ],
)
def test_tampered_report_is_rejected_without_echoing_values(healthy, mutation):
    report = copy.deepcopy(healthy)
    mutation(report)
    with pytest.raises(ComparisonError) as error:
        validate_report(report)
    assert "PRIVATE" not in str(error.value)


def test_equal_hash_does_not_bypass_expected_labels_or_per_case_coverage(healthy):
    baseline = copy.deepcopy(healthy)
    baseline["cases"][0]["expected_affected"] = []
    refresh(baseline)
    with pytest.raises(ComparisonError, match="Incompatible"):
        compare_reports(healthy, baseline)
    baseline = copy.deepcopy(healthy)
    baseline["cases"][0]["confusion_matrix"]["true_negative"] += 1
    baseline["cases"][1]["confusion_matrix"]["true_negative"] -= 1
    refresh(baseline)
    with pytest.raises(ComparisonError, match="Incompatible"):
        compare_reports(healthy, baseline)


def test_different_corpus_is_not_a_trend(healthy):
    changed = evaluate([replace(synthetic_cases()[0], name="other")])
    with pytest.raises(ComparisonError, match="Incompatible"):
        compare_reports(healthy, changed)


def test_empty_suite_still_fails_and_null_metrics_are_preserved():
    empty = evaluate([])
    comparison = compare_reports(empty, empty)
    assert not comparison["current_passed"]
    assert comparison["metrics"]["precision"] == {"baseline": None, "current": None, "delta": None}
    assert not empty["passed"]


def test_detailed_deltas_are_bounded_and_totals_remain_complete():
    cases = [replace(synthetic_cases()[0], name=f"case-{index}") for index in range(105)]
    baseline = evaluate(cases)
    current = copy.deepcopy(baseline)
    for case in current["cases"]:
        case["actual_affected"] = []
    refresh(current)
    comparison = compare_reports(current, baseline)
    assert len(comparison["changed_cases"]) == 100
    assert comparison["details_truncated"]
    assert comparison["counts"]["regressed_cases"] == 105
    assert not comparison["passed"]


def test_reader_rejects_symlink_fifo_directory_oversized_and_invalid_json(tmp_path, healthy):
    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps(healthy))
    symlink = tmp_path / "link.json"
    symlink.symlink_to(baseline)
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo)
    oversized = tmp_path / "oversized.json"
    with oversized.open("wb") as stream:
        stream.truncate(MAX_BASELINE_BYTES + 1)
    for path in (symlink, fifo, oversized, tmp_path):
        with pytest.raises(ComparisonError):
            load_baseline(path)
    for invalid in (
        b'{"x":1,"x":2}',
        b'{"x": NaN}',
        b'{"x":Infinity}',
        b'{"x":1e999}',
        b"\xff",
        b"{",
        b"[" * 2000,
    ):
        baseline.write_bytes(invalid)
        with pytest.raises(ComparisonError):
            load_baseline(baseline)


def test_path_and_inode_guards_protect_baseline(tmp_path, healthy):
    baseline = tmp_path / "baseline.json"
    original = json.dumps(healthy)
    baseline.write_text(original)
    _, identity = load_baseline(baseline)
    hardlink = tmp_path / "hardlink.json"
    hardlink.hardlink_to(baseline)
    symlink = tmp_path / "symlink.json"
    symlink.symlink_to(baseline)
    for target in (baseline, tmp_path / "." / "baseline.json", hardlink, symlink):
        with pytest.raises(ComparisonError, match="overwrite"):
            protect_baseline(target, baseline, identity)
        with pytest.raises(ComparisonError, match="overwrite"):
            write_report(target, "replacement", baseline, identity)
    assert baseline.read_text() == original


def test_atomic_replace_failure_preserves_output_and_cleans_temporary(tmp_path, monkeypatch):
    output = tmp_path / "current.json"
    output.write_text("previous report")

    def fail(*_args):
        raise OSError("PRIVATE_OS_ERROR")

    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(ComparisonError, match="atomically"):
        write_report(output, "new report")
    assert output.read_text() == "previous report"
    assert not list(tmp_path.glob(".groundskeeper-eval-*.tmp"))


@pytest.fixture
def cli():
    path = Path(__file__).resolve().parents[3] / "scripts/evaluate.py"
    spec = importlib.util.spec_from_file_location("comparison_cli", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cli_unchanged_then_regressed_and_improved(tmp_path, healthy, cli, monkeypatch, capsys):
    baseline, output = tmp_path / "baseline.json", tmp_path / "current.json"
    baseline.write_text(json.dumps(healthy))
    monkeypatch.setattr(
        sys, "argv", ["evaluate.py", "--baseline", str(baseline), "--output", str(output)]
    )
    assert cli.main() == 0
    assert capsys.readouterr().out == output.read_text()
    assert json.loads(output.read_text())["comparison"]["passed"]
    worse = copy.deepcopy(healthy)
    worse["cases"][0]["actual_affected"] = []
    refresh(worse)
    monkeypatch.setattr(cli, "evaluate", lambda: copy.deepcopy(worse))
    assert cli.main() == 1
    result = json.loads(capsys.readouterr().out)
    assert not result["passed"] and not result["comparison"]["passed"]
    baseline.write_text(json.dumps(worse))
    monkeypatch.setattr(cli, "evaluate", lambda: copy.deepcopy(healthy))
    assert cli.main() == 0
    assert json.loads(capsys.readouterr().out)["comparison"]["counts"]["improved_cases"] == 1


def test_cli_rejects_bad_baseline_without_overwriting_output_or_leaking(
    tmp_path, healthy, cli, monkeypatch, capsys
):
    baseline, output = tmp_path / "PRIVATE_PATH.json", tmp_path / "current.json"
    output.write_text("existing artifact")
    monkeypatch.setattr(
        sys, "argv", ["evaluate.py", "--baseline", str(baseline), "--output", str(output)]
    )
    for value in (
        "PRIVATE_SOURCE",
        '{"x":NaN}',
        json.dumps({**healthy, "corpus_sha256": "0" * 64}),
    ):
        baseline.write_text(value)
        assert cli.main() == 2
        captured = capsys.readouterr()
        assert not captured.out
        assert "PRIVATE" not in captured.err and "Traceback" not in captured.err
        assert output.read_text() == "existing artifact"


def test_cli_baseline_cannot_be_output_and_engine_errors_are_redacted(
    tmp_path, healthy, cli, monkeypatch, capsys
):
    path = tmp_path / "baseline.json"
    original = json.dumps(healthy)
    path.write_text(original)
    monkeypatch.setattr(
        sys, "argv", ["evaluate.py", "--baseline", str(path), "--output", str(path)]
    )
    assert cli.main() == 2
    assert "overwrite" in capsys.readouterr().err
    assert path.read_text() == original
    monkeypatch.setattr(sys, "argv", ["evaluate.py"])

    def fail():
        raise RuntimeError("PRIVATE_ENGINE_SOURCE")

    monkeypatch.setattr(cli, "evaluate", fail)
    assert cli.main() == 2
    captured = capsys.readouterr()
    assert not captured.out and "PRIVATE" not in captured.err and "Traceback" not in captured.err


def test_reader_detects_baseline_changed_during_read(tmp_path, healthy, monkeypatch):
    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps(healthy))
    original = os.fstat
    calls = 0

    def changed(descriptor):
        nonlocal calls
        calls += 1
        metadata = original(descriptor)
        if calls == 2:
            return SimpleNamespace(st_size=metadata.st_size, st_mtime_ns=metadata.st_mtime_ns + 1)
        return metadata

    monkeypatch.setattr(os, "fstat", changed)
    with pytest.raises(ComparisonError, match="changed during reading"):
        load_baseline(baseline)


def test_comparison_cannot_make_remaining_current_failures_pass_cli(
    tmp_path, healthy, cli, monkeypatch, capsys
):
    old = copy.deepcopy(healthy)
    old["cases"][0]["actual_affected"] = []
    old["cases"][1]["actual_affected"] = []
    refresh(old)
    current = copy.deepcopy(old)
    current["cases"][1]["actual_affected"] = ["target"]
    refresh(current)
    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps(old))
    monkeypatch.setattr(sys, "argv", ["evaluate.py", "--baseline", str(baseline)])
    monkeypatch.setattr(cli, "evaluate", lambda: current)
    assert cli.main() == 1
    result = json.loads(capsys.readouterr().out)
    assert result["comparison"]["passed"]
    assert not result["passed"]
    assert result["comparison"]["counts"]["improved_cases"] == 1
