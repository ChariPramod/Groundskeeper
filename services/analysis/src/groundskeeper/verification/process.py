"""Bound the Docker CLI's output and wall clock independently of container limits."""

import os
import selectors
import signal
import subprocess
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str
    failure: str | None = None


def run_bounded(command: list[str], timeout: float, output_limit: int) -> ProcessResult:
    with subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    ) as process:
        output = {"stdout": bytearray(), "stderr": bytearray()}
        failure = None
        deadline = time.monotonic() + timeout
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ, "stdout")
                selector.register(process.stderr, selectors.EVENT_READ, "stderr")
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        failure = "Sandbox wall-clock limit exceeded"
                        break
                    for key, _ in selector.select(min(remaining, 0.1)):
                        chunk = os.read(key.fileobj.fileno(), 8192)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        capacity = output_limit - sum(map(len, output.values()))
                        output[key.data].extend(chunk[:capacity])
                        if len(chunk) > capacity:
                            failure = "Sandbox output limit exceeded"
                            break
                    if failure:
                        break
            if failure is None:
                try:
                    process.wait(timeout=max(0.001, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    failure = "Sandbox wall-clock limit exceeded"
        finally:
            # Also terminate child processes that inherited the CLI's pipes.
            if failure or process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.wait()
        return ProcessResult(
            process.returncode,
            output["stdout"].decode(errors="replace"),
            output["stderr"].decode(errors="replace"),
            failure,
        )
