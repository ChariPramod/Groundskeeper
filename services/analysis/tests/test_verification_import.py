import pytest
from groundskeeper.analysis import analyze
from groundskeeper.models import AnalysisRequest, Claim, Impact, Position, SourceFile
from groundskeeper.verification.docker import SandboxResult
from groundskeeper.verification.models import SandboxLimits
from groundskeeper.verification_import import ImportRequest, validate_import
from groundskeeper.worker_verification import WorkerVerificationRequest, verify_analysis


class Sandbox:
    def run(self, code, snapshot, limits):
        return SandboxResult(exit_code=0, stdout="2\n", image_id="sha256:" + "a" * 64)


def fixture(max_blocks=10):
    claims = [
        Claim(
            id=str(i),
            page="guide.md",
            anchor="",
            kind="code",
            text="print(2)",
            language="python",
            runnable=True,
            expected_output="2",
            session="tutorial",
            position=Position(
                start_line=i * 4 + 1, start_column=1, end_line=i * 4 + 3, end_column=1
            ),
        )
        for i in range(2)
    ]
    analysis = analyze(AnalysisRequest(claims=claims, before=[], after=[]))
    analysis.impacts = [Impact(claim_id="1", symbol_ids=[], reason="changed")]
    request = WorkerVerificationRequest(
        analysis=analysis,
        sources=[SourceFile(path="client.py", content="value = 2")],
        limits=SandboxLimits(max_blocks=max_blocks),
    )
    report = verify_analysis(request, Sandbox())
    return ImportRequest(**request.model_dump(), evidence_report=report)


@pytest.mark.parametrize("budget", [0, 10])
def test_import_preserves_passed_and_skipped_reports_without_execution(budget, monkeypatch):
    request = fixture(budget)

    def forbidden(*args, **kwargs):
        raise AssertionError("Import must not execute")

    monkeypatch.setattr("groundskeeper.verification.docker.DockerSandbox.run", forbidden)
    before = request.evidence_report.model_dump_json()
    validate_import(request)
    assert request.evidence_report.model_dump_json() == before


@pytest.mark.parametrize(
    "mutation",
    [
        "source",
        "claim",
        "missing",
        "duplicate",
        "digest",
        "count",
        "output",
        "status",
        "time",
    ],
)
def test_rejects_inconsistent_evidence(mutation):
    request = fixture()
    report = request.evidence_report
    if mutation == "source":
        request.sources[0].content = "changed"
    elif mutation == "claim":
        report.claims[0].text = "different assertion"
    elif mutation == "missing":
        report.claims.pop()
        report.evidence.pop()
    elif mutation == "duplicate":
        report.evidence[1].id = report.evidence[0].id
    elif mutation == "digest":
        report.evidence[1].claim_digest = report.evidence[0].claim_digest
    elif mutation == "count":
        report.outcomes["passed"] = 10
    elif mutation == "output":
        report.evidence[0].stdout = "incorrect"
    elif mutation == "status":
        report.evidence[0].status = "stale"
    elif mutation == "time":
        report.evidence[0].finished_at = report.evidence[0].started_at.replace(year=2000)
    with pytest.raises(ValueError):
        validate_import(request)
