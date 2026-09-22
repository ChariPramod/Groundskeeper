import io
import json
import subprocess
import sys

import pytest
from groundskeeper.analysis import analyze
from groundskeeper.models import AnalysisRequest, Claim, Impact, Position, SourceFile
from groundskeeper.verification.docker import SandboxResult
from groundskeeper.verification.models import SandboxLimits, VerificationReport
from groundskeeper.verification.snapshot import Snapshot
from groundskeeper.worker_verification import WorkerVerificationRequest, main, verify_analysis


def block(claim_id, **values):
    return Claim(
        **(
            dict(
                id=claim_id,
                page="guide.md",
                anchor="",
                kind="code",
                text="print(value)",
                language="python",
                runnable=True,
                position=Position(start_line=1, start_column=1, end_line=3, end_column=1),
            )
            | values
        )
    )


def request_for(claims, affected=None, **values):
    analysis = analyze(AnalysisRequest(claims=claims, before=[], after=[]))
    analysis.impacts = [
        Impact(claim_id=claim_id, symbol_ids=[], reason="changed")
        for claim_id in (affected if affected is not None else [claim.id for claim in claims])
    ]
    return WorkerVerificationRequest(
        analysis=analysis,
        sources=[SourceFile(path="client.py", content="value = 2")],
        **values,
    )


class FakeSandbox:
    def __init__(self, result=None):
        self.calls = []
        self.result = result or SandboxResult(exit_code=0, stdout="2\n")

    def run(self, code, snapshot, limits):
        self.calls.append((code, snapshot, limits))
        return self.result


def test_selects_only_affected_code_in_page_position_order_with_exact_source_digest():
    request = request_for(
        [
            block("later-page", page="z.md"),
            block(
                "later-line",
                position=Position(start_line=4, start_column=1, end_line=6, end_column=1),
            ),
            block("unaffected"),
            block("prose", kind="paragraph"),
            block("first", expected_output="2"),
        ],
        affected=["later-page", "later-line", "prose", "first"],
        limits=SandboxLimits(max_blocks=1),
    )
    sandbox = FakeSandbox()
    report = verify_analysis(request, sandbox)
    assert [claim.id for claim in report.claims] == ["first", "later-line", "later-page"]
    assert [claim.status for claim in report.claims] == ["verified", "unknown", "unknown"]
    assert len(sandbox.calls) == 1
    assert sandbox.calls[0][1] == Snapshot.create(request.sources)
    assert report.source_digest == Snapshot.create(request.sources).digest
    assert all(item.source_digest == report.source_digest for item in report.evidence)
    assert request.analysis.claims[-1].status == "unknown"


def test_preserves_skipped_unsupported_and_unopted_claims_and_infrastructure_unknown():
    request = request_for(
        [
            block("unopted", runnable=False),
            block("unsupported", language="typescript"),
            block("runnable"),
        ]
    )
    sandbox = FakeSandbox(SandboxResult(error="Docker unavailable"))
    report = verify_analysis(request, sandbox)
    evidence = {item.claim_id: item for item in report.evidence}
    assert evidence["unopted"].outcome == "skipped"
    assert evidence["unsupported"].outcome == "skipped"
    assert evidence["runnable"].outcome == "error"
    assert evidence["runnable"].status == "unknown"
    assert report.outcomes == dict(passed=0, failed=0, error=1, skipped=2)
    assert len(sandbox.calls) == 1


@pytest.mark.parametrize("affected", [["missing"], ["claim", "claim"]])
def test_rejects_invalid_impact_claim_references(affected):
    with pytest.raises(ValueError, match="impact"):
        request_for([block("claim")], affected=affected)


def test_rejects_duplicate_claim_ids():
    request = request_for([block("claim")])
    raw = request.model_dump()
    raw["analysis"]["claims"] *= 2
    with pytest.raises(ValueError, match="claim IDs must be unique"):
        WorkerVerificationRequest.model_validate(raw)


@pytest.mark.parametrize("paths", [["a.py", "a.py"], ["../a.py"], ["a.ts"], ["./a.py"]])
def test_rejects_ambiguous_or_non_python_snapshots_before_execution(paths):
    request = request_for([block("claim")])
    request.sources = [SourceFile(path=path, content="") for path in paths]
    sandbox = FakeSandbox()
    with pytest.raises(ValueError, match="Invalid Python snapshot path"):
        verify_analysis(request, sandbox)
    assert sandbox.calls == []


def test_empty_selection_still_has_source_provenance():
    request = request_for([block("claim")], affected=[])
    sandbox = FakeSandbox()
    report = verify_analysis(request, sandbox)
    assert report.claims == report.evidence == sandbox.calls == []
    assert report.source_digest == Snapshot.create(request.sources).digest


def test_affected_session_selects_setup_and_later_steps_without_cross_page_leakage():
    request = request_for(
        [
            block("setup", session="quickstart", text="value = 2"),
            block(
                "target",
                session="quickstart",
                position=Position(start_line=5, start_column=1, end_line=7, end_column=1),
            ),
            block(
                "later",
                session="quickstart",
                position=Position(start_line=9, start_column=1, end_line=11, end_column=1),
            ),
            block("other-page", session="quickstart", page="other.md"),
            block("other-session", session="separate"),
            block("standalone"),
        ],
        affected=["target"],
        limits=SandboxLimits(max_blocks=0),
    )
    sandbox = FakeSandbox()
    report = verify_analysis(request, sandbox)
    assert [claim.id for claim in report.claims] == ["setup", "target", "later"]
    assert all(claim.status == "unknown" for claim in report.claims)
    assert sandbox.calls == []


def test_subprocess_emits_valid_report_and_budget_unknown_without_docker():
    request = request_for([block("claim")], limits=SandboxLimits(max_blocks=0))
    result = subprocess.run(
        [sys.executable, "-m", "groundskeeper.worker_verification"],
        input=request.model_dump_json(),
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    report = VerificationReport.model_validate(json.loads(result.stdout))
    assert report.image == "python:3.12-slim"
    assert report.claims[0].status == "unknown"
    assert report.evidence[0].outcome == "skipped"
    assert "budget" in report.evidence[0].reason
    assert report.evidence[0].limits.timeout_seconds == 10


def test_stdin_is_bounded_before_json_parsing(monkeypatch):
    class BoundedInput:
        def read(self, size):
            assert size == 32_000_001
            return b" " * size

    class Input:
        buffer = BoundedInput()

    output = io.StringIO()
    monkeypatch.setattr(sys, "stdin", Input())
    monkeypatch.setattr(sys, "stdout", output)
    with pytest.raises(ValueError, match="exceeds 32 MB"):
        main()
    assert output.getvalue() == ""
