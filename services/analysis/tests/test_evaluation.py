import importlib.util
import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from groundskeeper.evaluation import boundary_cases, evaluate, synthetic_cases
from groundskeeper.models import ClaimStatus


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
    assert report == evaluate(cases)


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


def test_extended_corpus_is_pinned_and_covers_safety_categories():
    report = evaluate()
    assert report["passed"]
    assert (
        report["corpus_sha256"]
        == "aa0b13c909ec725c1e63134842f3a82e95bf71a81e63ac0b5d40c7e2ba69c6c8"
    )
    assert report["case_count"] == 38
    assert report["claim_count"] == 72
    assert report["rejection_case_count"] == 2
    assert len(report["groups"]["category"]) == 19
    assert all(group["case_count"] == 2 for group in report["groups"]["category"].values())
    assert report["groups"]["category"]["invalid_syntax"]["metrics"]["accuracy"] is None
    assert report["confusion_matrix"] == {
        "true_positive": 22,
        "true_negative": 50,
        "false_positive": 0,
        "false_negative": 0,
    }
    assert report == evaluate()


def test_empty_suite_cannot_pass_gate():
    assert not evaluate([])["passed"]


def test_corpus_digest_changes_when_labels_or_source_change():
    case = synthetic_cases()[0]
    digest = evaluate([case])["corpus_sha256"]
    assert evaluate([replace(case, expected_affected=frozenset())])["corpus_sha256"] != digest
    changed = case.request.model_copy(
        update={
            "claims": [
                claim.model_copy(update={"text": claim.text + " Extra."})
                for claim in case.request.claims
            ]
        }
    )
    assert evaluate([replace(case, request=changed)])["corpus_sha256"] != digest


def test_safety_gate_detects_overconfident_ambiguous_links(monkeypatch):
    import groundskeeper.evaluation as module

    production = module.analyze

    def overconfident(request):
        report = production(request)
        return report.model_copy(
            update={"links": [link.model_copy(update={"confidence": 1.0}) for link in report.links]}
        )

    monkeypatch.setattr(module, "analyze", overconfident)
    case = next(case for case in boundary_cases() if case.category == "ambiguous_identifier")
    report = evaluate([case])
    assert not report["passed"]
    assert report["metrics"]["accuracy"] == 1
    assert report["cases"][0]["safety_failures"] == [
        "target link confidence differs from ambiguity label"
    ]


def test_safety_gate_detects_false_verification(monkeypatch):
    import groundskeeper.evaluation as module

    production = module.analyze

    def falsely_verified(request):
        report = production(request)
        return report.model_copy(
            update={
                "claims": [
                    claim.model_copy(update={"status": ClaimStatus.VERIFIED})
                    for claim in report.claims
                ]
            }
        )

    monkeypatch.setattr(module, "analyze", falsely_verified)
    report = evaluate([synthetic_cases()[0]])
    assert not report["passed"]
    assert report["cases"][0]["safety_failures"] == [
        "target: affected claim retained a truth status"
    ]


def test_syntax_gate_detects_silent_acceptance(monkeypatch):
    import groundskeeper.evaluation as module

    production = module.analyze
    monkeypatch.setattr(
        module,
        "analyze",
        lambda request: production(request.model_copy(update={"before": [], "after": []})),
    )
    case = next(case for case in boundary_cases() if case.rejects_invalid_syntax)
    report = evaluate([case])
    assert not report["passed"]
    assert report["cases"][0]["safety_failures"] == ["invalid syntax was accepted"]


def test_unexpected_engine_failure_does_not_become_an_expected_rejection(monkeypatch):
    import groundskeeper.evaluation as module

    def fail(request):
        raise ValueError("Unexpected engine failure")

    monkeypatch.setattr(module, "analyze", fail)
    case = next(case for case in boundary_cases() if case.rejects_invalid_syntax)
    with pytest.raises(ValueError, match="Unexpected engine failure"):
        evaluate([case])
