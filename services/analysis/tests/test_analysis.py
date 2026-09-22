import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from groundskeeper.analysis import analyze, link_claims
from groundskeeper.api import app
from groundskeeper.models import AnalysisRequest, ChangeBudget, Claim, Position, SourceFile
from groundskeeper.symbols import extract_symbols
from pydantic import ValidationError


def claim(text: str, **kwargs) -> Claim:
    return Claim(
        id=kwargs.pop("id", "claim-1"),
        page="guide.md",
        anchor="setup",
        kind="paragraph",
        text=text,
        position=Position(start_line=1, start_column=1, end_line=1, end_column=10),
        **kwargs,
    )


def source(content: str, path: str = "client.py") -> SourceFile:
    return SourceFile(path=path, content=content)


def test_python_scopes_defaults_and_decorators():
    symbols = extract_symbols(
        source("TIMEOUT = 30\nclass Client:\n    def send(self):\n        pass\n")
    )
    assert {s.qualified_name for s in symbols} >= {"TIMEOUT", "Client", "Client.send"}
    old = extract_symbols(source("@cached\ndef send():\n    pass\n"))
    new = extract_symbols(source("@uncached\ndef send():\n    pass\n"))
    assert old[0].id == new[0].id
    assert old[0].fingerprint != new[0].fingerprint


@pytest.mark.parametrize("extension", ["ts", "tsx"])
def test_typescript_declarations(extension):
    symbols = extract_symbols(
        source(
            "export class Client { send(message: string) { return message; } }\n"
            "export const connect = (host: string) => host;\n"
            "export interface Options { timeout: number }\n",
            f"client.{extension}",
        )
    )
    assert {s.qualified_name for s in symbols} >= {"Client", "Client.send", "connect", "Options"}


@pytest.mark.parametrize(
    "before,after",
    [
        ("def send():\n    pass\n", "def deliver():\n    pass\n"),
        ("def send(timeout=30):\n    pass\n", "def send(timeout=60):\n    pass\n"),
        ("def send(timeout=30):\n    pass\n", "def send():\n    pass\n"),
        ("def send():\n    return 'ok'\n", "def send():\n    return 'ready'\n"),
        ("def send():\n    pass\n", ""),
    ],
)
def test_detects_rename_default_parameter_output_and_delete(before, after):
    report = analyze(
        AnalysisRequest(
            claims=[claim("Call send.")], before=[source(before)], after=[source(after)]
        )
    )
    assert [impact.claim_id for impact in report.impacts] == ["claim-1"]
    assert report.claims[0].status == "unknown"
    assert report.health.verified_share == 0


def test_no_drift_for_comments_whitespace_or_unrelated_changes():
    before = "def send():\n    return 'ok'\n\ndef other():\n    return 1\n"
    after = "# comment\ndef send():\n  return 'ok'\n\ndef other():\n    return 2\n"
    report = analyze(
        AnalysisRequest(
            claims=[claim("Call send.")], before=[source(before)], after=[source(after)]
        )
    )
    assert report.changed_symbol_ids
    assert not report.impacts


def test_string_whitespace_is_a_semantic_change():
    before = [source("def send():\n    return 'a b'\n")]
    after = [source("def send():\n    return 'a  b'\n")]
    assert analyze(AnalysisRequest(claims=[claim("send")], before=before, after=after)).impacts


def test_exact_boundaries_and_ambiguity():
    symbols = extract_symbols(source("def send():\n    pass\n"))
    symbols += extract_symbols(source("def send():\n    pass\n", "other.py"))
    assert not link_claims([claim("resend the message")], symbols)
    links = link_claims([claim("Call send")], symbols)
    assert len(links) == 2
    assert all(link.confidence == 0.5 for link in links)


def test_changed_verified_claim_requires_reverification():
    report = analyze(
        AnalysisRequest(
            claims=[claim("TIMEOUT", status="verified")],
            before=[source("TIMEOUT = 30")],
            after=[source("TIMEOUT = 60")],
        )
    )
    assert report.claims[0].status == "unknown"
    assert report.health.statuses["verified"] == 0


def test_file_move_retains_old_path_links():
    report = analyze(
        AnalysisRequest(
            claims=[claim("Read the source", references=[{"kind": "path", "value": "client.py"}])],
            before=[source("TIMEOUT = 30")],
            after=[source("TIMEOUT = 30", "moved.py")],
        )
    )
    assert len(report.impacts) == 1


def test_empty_index_has_finite_metrics():
    report = analyze(AnalysisRequest(claims=[], before=[], after=[]))
    assert report.health.link_coverage == 0
    assert report.health.verified_share == 0


def test_invalid_source_and_duplicate_paths_are_rejected():
    with pytest.raises(ValueError, match="invalid python syntax"):
        extract_symbols(source("def ("))
    with pytest.raises(ValidationError, match="unique"):
        AnalysisRequest(claims=[], before=[source("a=1"), source("a=2")], after=[])
    with pytest.raises(ValidationError):
        ChangeBudget(max_prs=-1)
    with pytest.raises(ValidationError):
        Position(start_line=2, start_column=1, end_line=1, end_column=1)


def test_api_returns_report_and_useful_invalid_source_error():
    with TestClient(app) as client:
        assert client.get("/healthz").json()["status"] == "ok"
        result = client.post("/v1/analyze", json={"claims": [], "before": [], "after": []})
        assert result.status_code == 200
        assert result.json()["schema_version"] == "1"
        result = client.post(
            "/v1/analyze",
            json={
                "claims": [],
                "before": [],
                "after": [{"path": "bad.py", "content": "def ("}],
            },
        )
        assert result.status_code == 422
        assert "bad.py" in result.json()["detail"]


def test_real_markdown_parser_to_python_analysis_contract():
    root = Path(__file__).resolve().parents[3]
    process = subprocess.run(
        ["pnpm", "exec", "tsx", "packages/parser/src/cli.ts", "--root", "examples/demo/docs"],
        cwd=root,
        text=True,
        capture_output=True,
        check=True,
    )
    claims = json.loads(process.stdout)
    from groundskeeper.cli import read_sources

    report = analyze(
        AnalysisRequest(
            claims=claims,
            before=read_sources(root / "examples/demo/before"),
            after=read_sources(root / "examples/demo/after"),
        )
    )
    affected = {impact.claim_id for impact in report.impacts}
    assert len(affected) == 4
    healthy = next(claim for claim in report.claims if "readiness" in claim.text)
    assert healthy.id not in affected
    assert report.health.total_claims == 6
    assert report.health.linked_claims == 5
    assert any(claim.runnable and claim.expected_output for claim in report.claims)
