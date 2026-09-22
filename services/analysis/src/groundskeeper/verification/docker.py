"""Docker is an execution boundary, never an optional fallback to the host."""

import json
import re
import tempfile
import time
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from groundskeeper.verification.models import SandboxLimits
from groundskeeper.verification.process import ProcessResult, run_bounded
from groundskeeper.verification.snapshot import Snapshot

DEFAULT_IMAGE = "python:3.12-slim"


@dataclass(frozen=True)
class SandboxResult:
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    image_id: str | None = None
    error: str | None = None


class Sandbox(Protocol):
    def run(self, code: str, snapshot: Snapshot, limits: SandboxLimits) -> SandboxResult: ...


class SandboxError(Exception):
    pass


class DockerSandbox:
    def __init__(self, image: str = DEFAULT_IMAGE, invoke=run_bounded):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", image):
            raise ValueError("Invalid container image reference")
        self.image = image
        self.invoke = invoke

    def run(self, code: str, snapshot: Snapshot, limits: SandboxLimits) -> SandboxResult:
        deadline = time.monotonic() + limits.timeout_seconds
        name = f"groundskeeper-{uuid.uuid4().hex}"
        result = SandboxResult()
        created = False

        def invoke(arguments: list[str], output_limit: int = 4096) -> ProcessResult:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SandboxError("Sandbox wall-clock limit exceeded")
            return self.invoke(["docker", *arguments], remaining, output_limit)

        def checked(arguments: list[str]) -> str:
            response = invoke(arguments)
            if response.failure or response.returncode:
                raise SandboxError(response.failure or response.stderr or "Docker command failed")
            return response.stdout.strip()

        with tempfile.TemporaryDirectory(prefix="groundskeeper-") as temporary:
            try:
                image_id = checked(["image", "inspect", self.image, "--format", "{{.Id}}"])
                if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
                    raise SandboxError("Docker did not return a content-addressed image ID")
                result = replace(result, image_id=image_id)
                root = Path(temporary)
                snapshot.materialize(root / "source")
                script = root / "snippet"
                script.mkdir(mode=0o755)
                script.chmod(0o755)
                (script / "main.py").write_text(code, encoding="utf-8")
                (script / "main.py").chmod(0o444)
                # Mark before create: a timed-out CLI can still have created the container.
                created = True
                checked(
                    [
                        "create",
                        "--name",
                        name,
                        "--pull",
                        "never",
                        "--network",
                        "none",
                        "--read-only",
                        "--cap-drop",
                        "ALL",
                        "--security-opt",
                        "no-new-privileges",
                        "--user",
                        "65534:65534",
                        "--memory",
                        f"{limits.memory_mb}m",
                        "--memory-swap",
                        f"{limits.memory_mb}m",
                        "--cpus",
                        "1",
                        "--pids-limit",
                        "64",
                        "--ulimit",
                        "nofile=64:64",
                        "--init",
                        "--log-driver",
                        "none",
                        "--tmpfs",
                        "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
                        "--mount",
                        f"type=bind,src={root / 'source'},dst=/workspace,readonly",
                        "--mount",
                        f"type=bind,src={script},dst=/snippet,readonly",
                        "--workdir",
                        "/workspace",
                        "--env",
                        "PYTHONDONTWRITEBYTECODE=1",
                        "--env",
                        "PYTHONPATH=/workspace",
                        "--env",
                        "PYTHONIOENCODING=utf-8",
                        "--entrypoint",
                        "python",
                        image_id,
                        "-B",
                        "-u",
                        "/snippet/main.py",
                    ]
                )
                attached = invoke(["start", "--attach", name], limits.output_bytes)
                result = replace(result, stdout=attached.stdout, stderr=attached.stderr)
                if attached.failure:
                    raise SandboxError(attached.failure)
                state = json.loads(checked(["inspect", name, "--format", "{{json .State}}"]))
                if not isinstance(state, dict):
                    raise SandboxError("Docker returned an invalid container state")
                if state.get("OOMKilled"):
                    raise SandboxError("Sandbox memory limit exceeded")
                if state.get("Error") or state.get("Status") != "exited":
                    raise SandboxError(state.get("Error") or "Container did not complete execution")
                exit_code = state.get("ExitCode")
                if type(exit_code) is not int or not 0 <= exit_code <= 255:
                    raise SandboxError("Docker did not report the program's exit code")
                if attached.returncode != exit_code:
                    raise SandboxError("Docker attachment failed; output may be incomplete")
                result = replace(result, exit_code=exit_code)
            except FileNotFoundError:
                result = replace(
                    result, error="Docker is not installed; no code was run on the host"
                )
            except (SandboxError, OSError, ValueError) as error:
                result = replace(result, error=str(error))
            finally:
                if created:
                    try:
                        cleanup = self.invoke(["docker", "rm", "--force", name], 5, 4096)
                        if cleanup.failure or (
                            cleanup.returncode and "No such container" not in cleanup.stderr
                        ):
                            result = replace(result, error=f"Container cleanup failed for {name}")
                    except OSError:
                        result = replace(result, error=f"Container cleanup failed for {name}")
        return result
