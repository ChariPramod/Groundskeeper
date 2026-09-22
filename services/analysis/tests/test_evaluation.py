import importlib.util
import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from groundskeeper.evaluation import evaluate, synthetic_cases


def test_synthetic_baseline_covers_languages_and_mutations():
    cases = synthetic_cases()
    assert len(cases) == 18
    assert {case.language for case in cases} == {"python", "typescript"}
    assert {case.category for case in cases} == {
        "rename",
        "default_change",
        "removed_parameter",
        "changed_output",
        "moved_file",
        "comments",
        "whitespace",
        "unrelated_symbol",
        "identifier_substring",
    }
    report = evaluate(cases)
    assert report["passed"]
    assert report["claim_count"] == 36
    assert report["confusion_matrix"] == {
        "true_positive": 10,
        "false_positive": 0,
        "false_negative": 0,
        "true_negative": 26,
    }
    assert report["metrics"] == {"precision": 1, "recall": 1, "f1": 1, "accuracy": 1}
    assert report == evaluate()


def test_metrics_and_regression_details_with_mismatched_labels():
    positive, negative = synthetic_cases()[0], synthetic_cases()[5]
    report = evaluate(
        [
            positive,
            replace(positive, name="false-positive", expected_affected=frozenset()),
            replace(negative, expected_affected=frozenset({"target"})),
        ]
    )
    assert not report["passed"]
    assert report["confusion_matrix"] == {
        "true_positive": 1,
        "false_positive": 1,
        "false_negative": 1,
        "true_negative": 3,
    }
    assert report["metrics"] == {
        "precision": 0.5,
        "recall": 0.5,
        "f1": 0.5,
        "accuracy": 4 / 6,
    }
    assert report["cases"][1]["false_positives"] == ["target"]
    assert report["cases"][2]["false_negatives"] == ["target"]


def test_empty_and_negative_only_evaluation_do_not_invent_perfect_ratios():
    assert all(value is None for value in evaluate([])["metrics"].values())
    metrics = evaluate([synthetic_cases()[5]])["metrics"]
    assert metrics == {"precision": None, "recall": None, "f1": None, "accuracy": 1}


def test_duplicate_names_and_unknown_labels_rejected():
    case = synthetic_cases()[0]
    with pytest.raises(ValueError, match="unique"):
        evaluate([case, case])
    with pytest.raises(ValueError, match="unknown claims"):
        evaluate([replace(case, expected_affected=frozenset({"missing"}))])


def test_cli_writes_identical_json_and_reports_regressions(tmp_path, monkeypatch, capsys):
    path = Path(__file__).resolve().parents[3] / "scripts/evaluate.py"
    spec = importlib.util.spec_from_file_location("evaluation_cli", path)
    assert spec and spec.loader
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    output = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", [str(path), "--output", str(output)])
    assert cli.main() == 0
    assert capsys.readouterr().out == output.read_text()
    assert json.loads(output.read_text())["passed"]

    case = replace(synthetic_cases()[0], expected_affected=frozenset())
    monkeypatch.setattr(cli, "evaluate", lambda: evaluate([case]))
    assert cli.main() == 1
    assert not json.loads(capsys.readouterr().out)["passed"]
