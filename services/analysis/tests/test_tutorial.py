"""Tutorial verification, using trusted literal fixtures for wrapper-only host tests.

Production example execution always uses Sandbox.run. No repository/user snippets are
executed by the subprocess fixtures here; Docker integration remains explicitly opt-in.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from groundskeeper.models import Claim, Position
from groundskeeper.verification.docker import SandboxResult
from groundskeeper.verification.models import SandboxLimits
from groundskeeper.verification.service import claim_digest, verify
from groundskeeper.verification.snapshot import Snapshot, read_sources
from groundskeeper.verification.tutorial import replay_script, tutorial_prerequisites


def step(id="first", line=1, **values):
    return Claim(
        **{
            "id": id,
            "page": "tutorial.md",
            "anchor": "start",
            "kind": "code",
            "text": "value = 7",
            "position": Position(start_line=line, start_column=1, end_line=line + 2, end_column=1),
            "language": "python",
            "runnable": True,
            "session": "example",
        }
        | values
    )


class RecordingSandbox:
    def __init__(self, *results):
        self.results = iter(results)
        self.calls = []

    def run(self, code, snapshot, limits):
        self.calls.append(code)
        return next(self.results, SandboxResult(exit_code=0))


def test_session_order_is_source_order_but_report_preserves_input_order():
    first = step()
    last = step("last", 10, text="print(value)")
    sandbox = RecordingSandbox()
    report = verify([last, first], Snapshot.create([]), sandbox=sandbox)
    assert sandbox.calls == [replay_script(first, []), replay_script(last, [first])]
    assert [claim.id for claim in report.claims] == ["last", "first"]
    assert [item.claim_id for item in report.evidence] == ["last", "first"]
    assert report.outcomes["passed"] == 2
    assert "prefix replay (1 prerequisite blocks)" in report.evidence[0].reason
    assert report.evidence[0].claim_digest == claim_digest(last, [first])


def test_session_groups_do_not_cross_pages_or_session_names():
    a = step()
    b = step("other-page", 10, page="other.md")
    c = step("other-session", 20, session="different")
    sandbox = RecordingSandbox()
    verify([a, b, c], Snapshot.create([]), sandbox=sandbox)
    assert sandbox.calls == [replay_script(item, []) for item in [a, b, c]]


@pytest.mark.parametrize(
    "first,result",
    [
        (step(), SandboxResult(exit_code=1)),
        (step(), SandboxResult(error="Docker unavailable")),
        (step(runnable=False), SandboxResult(exit_code=0)),
        (step(language="bash"), SandboxResult(exit_code=0)),
        (step(expected_output="required"), SandboxResult(exit_code=0)),
    ],
)
def test_unverified_predecessor_skips_later_steps_without_cascading_staleness(first, result):
    sandbox = RecordingSandbox(result)
    report = verify(
        [first, step("next", 10), step("last", 20)], Snapshot.create([]), sandbox=sandbox
    )
    assert len(sandbox.calls) <= 1
    for item in report.evidence[1:]:
        assert item.outcome == "skipped"
        assert item.status == "unknown"
        assert "earlier unverified" in item.reason


def test_prefix_replay_charges_every_reexecuted_block_to_budget():
    sandbox = RecordingSandbox()
    report = verify(
        [step(), step("second", 10), step("third", 20), step("standalone", 30, session=None)],
        Snapshot.create([]),
        sandbox=sandbox,
        limits=SandboxLimits(max_blocks=4),
    )
    assert len(sandbox.calls) == 3  # cost 1 + 2; third costs 3; standalone costs 1
    assert report.evidence[2].status == "unknown"
    assert "budget" in report.evidence[2].reason
    assert report.evidence[3].outcome == "passed"
    assert sandbox.calls[-1] == "value = 7"


def test_aggregate_prefix_input_limit_is_bounded():
    first = step(text="#" + "x" * 33_000)
    second = step("second", 10, text="#" + "y" * 33_000)
    sandbox = RecordingSandbox()
    report = verify([first, second], Snapshot.create([]), sandbox=sandbox)
    assert len(sandbox.calls) == 1
    assert report.evidence[1].outcome == "skipped"
    assert "64 KiB" in report.evidence[1].reason


def test_reserved_replay_exit_is_unknown_while_standalone_retains_original_behavior():
    sandbox = RecordingSandbox(*[SandboxResult(exit_code=120)] * 2)
    report = verify(
        [step(), step("second", 10), step("standalone", 20, session=None)],
        Snapshot.create([]),
        sandbox=sandbox,
    )
    assert [(item.outcome, item.status) for item in report.evidence] == [
        ("error", "unknown"),
        ("skipped", "unknown"),
        ("failed", "stale"),
    ]


def test_digest_binds_to_entire_ordered_prefix_contract():
    first, second, third = step(), step("second", 10, text="value += 1"), step("third", 20)
    prefix = tutorial_prerequisites([third, first, second])[third.id]
    assert prefix == [first, second]
    original = claim_digest(third, prefix)
    assert original != claim_digest(third, [second, first])
    assert original != claim_digest(third, [first])
    for change in ({"text": "value = 8"}, {"expected_output": "8"}, {"session": "other"}):
        assert original != claim_digest(third, [first.model_copy(update=change), second])
    assert claim_digest(first) != claim_digest(first.model_copy(update={"session": None}))


def test_session_size_is_rejected_before_any_execution():
    sandbox = RecordingSandbox()
    with pytest.raises(ValueError, match="limited to 100"):
        verify(
            [step(str(index), index + 1) for index in range(101)],
            Snapshot.create([]),
            sandbox=sandbox,
        )
    assert sandbox.calls == []


def test_tied_positions_have_deterministic_id_order():
    a, b = step("a"), step("b")
    assert tutorial_prerequisites([b, a])[b.id] == [a]


def test_trusted_fixture_replay_restores_variables_files_and_only_target_output(tmp_path):
    # All code is a trusted test literal, never user or repository example content.
    first = step(
        text="import sys\nvalue = 7\nprint('hidden')\nprint('hidden', file=sys.stderr)\n"
        "open('generated.txt', 'w').write('fixture')",
        expected_output="hidden",
    )
    second = step("second", 10, text="print(value, open('generated.txt').read())")
    result = subprocess.run(
        [sys.executable, "-c", "__file__ = 'fixture.py'\n" + replay_script(second, [first])],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "7 fixture\n"
    assert result.stderr == ""
    script = replay_script(second, [first])
    assert "open(os.devnull" in script
    assert "StringIO" not in script
    assert "expected_output" not in script  # Prefix stdout is not asserted against hidden output.


@pytest.mark.parametrize("code", ["raise ValueError('broken')", "raise SystemExit(0)", "invalid ("])
def test_trusted_fixture_prefix_failure_uses_reserved_exit(code):
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "__file__ = 'fixture.py'\n"
            + replay_script(step("second", 10, text="print('must not run')"), [step(text=code)]),
        ],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 120
    assert result.stdout == result.stderr == ""


def test_trusted_fixture_prefix_discards_native_and_child_process_output():
    first = step(
        text="import os, subprocess, sys\nos.write(1, b'hidden stdout')\n"
        "os.write(2, b'hidden stderr')\n"
        "subprocess.run([sys.executable, '-c', \"print('hidden child')\"])"
    )
    target = step("second", 10, text="print('target')")
    result = subprocess.run(
        [sys.executable, "-c", "__file__ = 'fixture.py'\n" + replay_script(target, [first])],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "target\n"
    assert result.stderr == ""


@pytest.mark.skipif(
    os.getenv("GROUNDSKEEPER_DOCKER_TEST") != "1", reason="Docker integration is opt-in"
)
def test_real_docker_replays_tutorial_and_reports_target_assertion_failure():
    first = step(
        text="import os\nos.chdir('/tmp')\nvalue = 7\n"
        "open('generated.txt', 'w').write('fixture')\nprint('setup')",
        expected_output="setup",
    )
    second = step(
        "second", 10, text="print(value, open('generated.txt').read())", expected_output="7 fixture"
    )
    third = step("third", 20, text="print(value + 1)", expected_output="9")
    report = verify(
        [third, second, first],
        Snapshot.create([]),
        limits=SandboxLimits(max_blocks=6, timeout_seconds=30),
    )
    assert report.outcomes == {"passed": 2, "failed": 1, "error": 0, "skipped": 0}, (
        report.model_dump_json()
    )
    assert report.evidence[0].stdout == "8\n"
    assert report.evidence[1].stdout == "7 fixture\n"


@pytest.mark.skipif(
    os.getenv("GROUNDSKEEPER_DOCKER_TEST") != "1", reason="Docker integration is opt-in"
)
def test_real_docker_verifies_tutorial_fixture_without_cascading_failures():
    from groundskeeper.cli import parse_claims

    root = Path(__file__).resolve().parents[3] / "examples/tutorial"
    claims = parse_claims(root / "docs")
    before = Snapshot.create(read_sources(root / "before", (".py",)))
    after = Snapshot.create(read_sources(root / "after", (".py",)))
    limits = SandboxLimits(max_blocks=6, timeout_seconds=30)
    good = verify(claims, before, limits=limits)
    bad = verify(claims, after, limits=limits)
    assert good.outcomes == {"passed": 3, "failed": 0, "error": 0, "skipped": 0}, (
        good.model_dump_json()
    )
    assert bad.outcomes == {"passed": 1, "failed": 1, "error": 0, "skipped": 1}, (
        bad.model_dump_json()
    )
    assert bad.evidence[-1].status == "unknown"
    assert "earlier unverified" in bad.evidence[-1].reason
