import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from groundskeeper.models import Claim, Position, SourceFile
from groundskeeper.verification.docker import DockerSandbox, SandboxResult
from groundskeeper.verification.models import SandboxLimits
from groundskeeper.verification.process import ProcessResult, run_bounded
from groundskeeper.verification.service import output_matches, verify
from groundskeeper.verification.snapshot import Snapshot, read_sources


def block(**values):
    return Claim(
        **(
            {
                "id": "claim",
                "page": "guide.md",
                "anchor": "start",
                "kind": "code",
                "text": "print('hello')",
                "language": "python",
                "runnable": True,
                "expected_output": "hello",
                "position": Position(start_line=1, start_column=1, end_line=3, end_column=4),
            }
            | values
        )
    )


class StubSandbox:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def run(self, code, snapshot, limits):
        self.calls.append(code)
        return self.result


@pytest.mark.parametrize(
    "result,outcome,status",
    [
        (SandboxResult(exit_code=0, stdout="hello\n"), "passed", "verified"),
        (SandboxResult(exit_code=0, stdout="goodbye\n"), "failed", "stale"),
        (SandboxResult(exit_code=1, stderr="AttributeError: send"), "failed", "stale"),
        (SandboxResult(error="Docker unavailable"), "error", "unknown"),
        (SandboxResult(error="Sandbox wall-clock limit exceeded"), "error", "unknown"),
        (SandboxResult(error="Sandbox output limit exceeded"), "error", "unknown"),
        (SandboxResult(), "error", "unknown"),
    ],
)
def test_verdicts_separate_evidence_from_infrastructure(result, outcome, status):
    snapshot = Snapshot.create([])
    report = verify([block()], snapshot, sandbox=StubSandbox(result))
    assert report.outcomes[outcome] == 1
    assert report.claims[0].status == status
    evidence = report.evidence[0]
    assert evidence.source_digest == snapshot.digest
    assert evidence.finished_at >= evidence.started_at
    assert bool(report.claims[0].last_verified) == (outcome in ("passed", "failed"))


def test_only_opted_in_supported_code_runs_and_budget_is_bounded():
    sandbox = StubSandbox(SandboxResult(exit_code=0, stdout="hello\n"))
    claims = [
        block(id="prose", kind="paragraph"),
        block(id="not-opted-in", runnable=False),
        block(id="shell", language="sh"),
        block(id="first"),
        block(id="second"),
    ]
    report = verify(
        claims, Snapshot.create([]), limits=SandboxLimits(max_blocks=1), sandbox=sandbox
    )
    assert len(sandbox.calls) == 1
    assert [claim.status for claim in report.claims] == [
        "unknown",
        "unverifiable",
        "unverifiable",
        "verified",
        "unknown",
    ]
    assert report.outcomes == {"passed": 1, "failed": 0, "error": 0, "skipped": 3}
    assert "budget" in report.evidence[-1].reason


def test_zero_budget_and_oversized_blocks_never_start_a_sandbox():
    sandbox = StubSandbox(SandboxResult())
    report = verify(
        [block()], Snapshot.create([]), limits=SandboxLimits(max_blocks=0), sandbox=sandbox
    )
    assert report.claims[0].status == "unknown"
    verify([block(text="a" * 65_537)], Snapshot.create([]), sandbox=sandbox)
    assert sandbox.calls == []


def test_evidence_digest_changes_with_expected_output_even_for_same_claim_id():
    sandbox = StubSandbox(SandboxResult(exit_code=0, stdout="hello"))
    a = verify([block()], Snapshot.create([]), sandbox=sandbox)
    b = verify([block(expected_output="bye")], Snapshot.create([]), sandbox=sandbox)
    assert a.evidence[0].claim_digest != b.evidence[0].claim_digest
    assert a.id != b.id


def test_output_comparison_preserves_meaningful_whitespace():
    assert output_matches("hello\r\n", "hello")
    assert output_matches("", "")
    assert not output_matches("hello\n\n", "hello")
    assert not output_matches(" hello\n", "hello")
    assert not output_matches("hello \n", "hello")


def test_snapshot_prunes_dependencies_and_never_copies_secrets_or_symlinks(tmp_path):
    (tmp_path / "client.py").write_text("value = 1")
    (tmp_path / ".env").write_text("TOKEN=private")
    (tmp_path / "private.pem").write_text("private")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "ignored.py").write_text("raise Exception()")
    (tmp_path / "alias.py").symlink_to(tmp_path / "client.py")
    snapshot = Snapshot.create(read_sources(tmp_path, (".py",)))
    assert [source.path for source in snapshot.files] == ["client.py"]
    snapshot.materialize(tmp_path / "copy")
    assert (tmp_path / "copy/client.py").read_text() == "value = 1"
    assert (
        Snapshot.create([SourceFile(path="client.py", content="value = 2")]).digest
        != snapshot.digest
    )


@pytest.mark.parametrize(
    "path", ["../escape.py", "/absolute.py", "a/../../b.py", "a\\b.py", "./a.py", "a.txt"]
)
def test_snapshot_rejects_unsafe_or_unsupported_paths(path):
    with pytest.raises(ValueError, match="Invalid Python snapshot path"):
        Snapshot.create([SourceFile(path=path, content="")])


def test_process_capture_limits_do_not_buffer_unbounded_output():
    result = run_bounded([sys.executable, "-c", "print('x' * 1000000)"], 2, 1024)
    assert result.failure == "Sandbox output limit exceeded"
    assert len(result.stdout.encode()) + len(result.stderr.encode()) <= 1024
    result = run_bounded([sys.executable, "-c", "import time; time.sleep(10)"], 0.1, 1024)
    assert result.failure == "Sandbox wall-clock limit exceeded"
    result = run_bounded([sys.executable, "-c", "print('ok')"], 2, 1024)
    assert result.stdout == "ok\n" and result.returncode == 0 and result.failure is None


class FakeDocker:
    def __init__(self, *, exit_code=0, failure=None, oom=False, cleanup_failure=False):
        self.commands = []
        self.exit_code = exit_code
        self.failure = failure
        self.oom = oom
        self.cleanup_failure = cleanup_failure

    def __call__(self, command, timeout, output_limit):
        self.commands.append(command)
        assert timeout > 0
        if command[1:3] == ["image", "inspect"]:
            return ProcessResult(0, "sha256:" + "a" * 64, "")
        if command[1] == "create":
            mounts = [command[i + 1] for i, value in enumerate(command) if value == "--mount"]
            for mount in mounts:
                path = Path(mount.split("src=")[1].split(",")[0])
                assert path.exists()
                assert mount.endswith(",readonly")
            return ProcessResult(0, "container", "")
        if command[1] == "start":
            return ProcessResult(self.exit_code, "hello\n", "", self.failure)
        if command[1] == "inspect":
            return ProcessResult(
                0,
                json.dumps(
                    {
                        "Status": "exited",
                        "ExitCode": self.exit_code,
                        "OOMKilled": self.oom,
                    }
                ),
                "",
            )
        if command[1] == "rm":
            return ProcessResult(1 if self.cleanup_failure else 0, "", "cleanup failure")
        raise AssertionError(command)


def test_docker_uses_bounded_readonly_copies_and_an_immutable_image():
    docker = FakeDocker()
    result = DockerSandbox(invoke=docker).run(
        "print('hello')", Snapshot.create([]), SandboxLimits()
    )
    assert result.exit_code == 0 and result.error is None
    create = next(command for command in docker.commands if command[1] == "create")
    for flag, value in [
        ("--network", "none"),
        ("--cap-drop", "ALL"),
        ("--user", "65534:65534"),
        ("--security-opt", "no-new-privileges"),
        ("--pids-limit", "64"),
        ("--pull", "never"),
        ("--memory", "128m"),
        ("--memory-swap", "128m"),
        ("--log-driver", "none"),
    ]:
        assert create[create.index(flag) + 1] == value
    assert "--read-only" in create
    assert "sha256:" + "a" * 64 in create
    assert docker.commands[-1][1:3] == ["rm", "--force"]


@pytest.mark.parametrize(
    "options",
    [
        {"failure": "Sandbox wall-clock limit exceeded"},
        {"failure": "Sandbox output limit exceeded"},
        {"oom": True},
        {"cleanup_failure": True},
    ],
)
def test_docker_resource_and_cleanup_failures_are_infrastructure_errors(options):
    docker = FakeDocker(**options)
    result = DockerSandbox(invoke=docker).run("", Snapshot.create([]), SandboxLimits())
    assert result.error
    assert docker.commands[-1][1:3] == ["rm", "--force"]


def test_program_exit_125_is_not_confused_with_docker_startup_failure():
    result = DockerSandbox(invoke=FakeDocker(exit_code=125)).run(
        "", Snapshot.create([]), SandboxLimits()
    )
    assert result.exit_code == 125 and result.error is None


def test_missing_docker_never_falls_back_to_host_execution():
    def unavailable(*args):
        raise FileNotFoundError("docker")

    result = DockerSandbox(invoke=unavailable).run(
        "raise Exception()", Snapshot.create([]), SandboxLimits()
    )
    assert "not installed" in result.error
    assert result.exit_code is None


def test_cli_writes_evidence_and_refuses_to_overwrite_it(tmp_path):
    root = Path(__file__).resolve().parents[3]
    output = tmp_path / "report.json"
    command = [
        "uv",
        "run",
        "groundskeeper",
        "verify",
        "--docs",
        "examples/demo/docs",
        "--source",
        "examples/demo/before",
        "--max-blocks",
        "0",
        "--output",
        str(output),
    ]
    result = subprocess.run(command, cwd=root, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    content = output.read_bytes()
    report = json.loads(content)
    assert report["outcomes"]["skipped"] == 1
    assert report["evidence"][0]["source_digest"]
    result = subprocess.run(command, cwd=root, capture_output=True, text=True)
    assert result.returncode == 2
    assert "overwrite" in result.stderr
    assert output.read_bytes() == content


@pytest.mark.skipif(
    os.getenv("GROUNDSKEEPER_DOCKER_TEST") != "1", reason="Docker integration is opt-in"
)
def test_real_docker_verifies_demo_and_detects_removed_method():
    from groundskeeper.cli import parse_claims

    root = Path(__file__).resolve().parents[3]
    claims = parse_claims(root / "examples/demo/docs")
    before = Snapshot.create(read_sources(root / "examples/demo/before", (".py",)))
    after = Snapshot.create(read_sources(root / "examples/demo/after", (".py",)))
    good = verify(claims, before, limits=SandboxLimits(timeout_seconds=30))
    bad = verify(claims, after, limits=SandboxLimits(timeout_seconds=30))
    assert good.outcomes["passed"] == 1, good.model_dump_json()
    assert bad.outcomes["failed"] == 1, bad.model_dump_json()
    assert "AttributeError" in bad.evidence[0].stderr
    assert good.source_digest != bad.source_digest


@pytest.mark.skipif(
    os.getenv("GROUNDSKEEPER_DOCKER_TEST") != "1", reason="Docker integration is opt-in"
)
def test_real_docker_denies_network_source_writes_and_host_environment(monkeypatch):
    monkeypatch.setenv("GROUNDSKEEPER_TEST_SECRET", "must-not-enter-container")
    code = """import os, socket
assert 'GROUNDSKEEPER_TEST_SECRET' not in os.environ
try:
    open('/workspace/created.py', 'w').write('no')
except OSError:
    print('read-only')
with socket.socket() as connection:
    connection.settimeout(1)
    try:
        connection.connect(('1.1.1.1', 80))
    except OSError:
        print('no-network')
"""
    report = verify(
        [block(text=code, expected_output="read-only\nno-network")],
        Snapshot.create([]),
        limits=SandboxLimits(timeout_seconds=30),
    )
    assert report.outcomes["passed"] == 1, report.model_dump_json()


def test_snapshot_reads_never_follow_a_file_replaced_with_a_symlink(tmp_path, monkeypatch):
    root = tmp_path / "checkout"
    root.mkdir()
    source = root / "client.py"
    source.write_text("public = True")
    secret = tmp_path / "secret.py"
    secret.write_text("TOKEN = 'private'")
    original_open = os.open

    def racing_open(path, flags, *args, **kwargs):
        if path == "client.py":
            source.unlink()
            source.symlink_to(secret)
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", racing_open)
    assert read_sources(root, (".py",)) == []


def test_snapshot_ignores_fifo_without_blocking(tmp_path):
    os.mkfifo(tmp_path / "stream.py")
    assert read_sources(tmp_path, (".py",)) == []


def test_snapshot_materialization_is_readable_under_restrictive_umask(tmp_path):
    snapshot = Snapshot.create([SourceFile(path="package/nested/client.py", content="x = 'é'")])
    old_umask = os.umask(0o077)
    try:
        snapshot.materialize(tmp_path / "source")
    finally:
        os.umask(old_umask)
    for path in (tmp_path / "source").rglob("*"):
        assert path.stat().st_mode & 0o777 == (0o755 if path.is_dir() else 0o444)
    assert (tmp_path / "source").stat().st_mode & 0o777 == 0o755
    assert (tmp_path / "source/package/nested/client.py").read_bytes() == "x = 'é'".encode()


def test_snapshot_rejects_nul_path_before_materialization():
    with pytest.raises(ValueError, match="Invalid Python snapshot path"):
        Snapshot.create([SourceFile(path="nul\x00.py", content="")])


@pytest.mark.parametrize("exit_code", [0, 1, 125])
def test_docker_attachment_failure_never_becomes_a_program_verdict(exit_code):
    docker = FakeDocker(exit_code=exit_code)

    def failed_attach(command, timeout, output_limit):
        result = docker(command, timeout, output_limit)
        if command[1] == "start":
            return ProcessResult(126, "partial", "attachment failed")
        return result

    result = DockerSandbox(invoke=failed_attach).run("", Snapshot.create([]), SandboxLimits())
    assert result.exit_code is None
    assert "attachment failed" in result.error
    assert docker.commands[-1][1:3] == ["rm", "--force"]


@pytest.mark.parametrize("exit_code", [True, -1, 256, "0"])
def test_docker_rejects_invalid_exit_code_evidence(exit_code):
    result = DockerSandbox(invoke=FakeDocker(exit_code=exit_code)).run(
        "", Snapshot.create([]), SandboxLimits()
    )
    assert result.exit_code is None
    assert "exit code" in result.error
