"""Bounded prefix replay for explicitly named, page-local Python tutorials."""

from collections import defaultdict, deque

from groundskeeper.models import Claim

PREFIX_FAILURE_EXIT = 120
MAX_SESSION_BLOCKS = 100


def tutorial_prerequisites(claims: list[Claim]) -> dict[str, list[Claim]]:
    groups: dict[tuple[str, str], list[Claim]] = defaultdict(list)
    for claim in claims:
        if claim.kind == "code" and claim.session is not None:
            groups[claim.page, claim.session].append(claim)
            if len(groups[claim.page, claim.session]) > MAX_SESSION_BLOCKS:
                raise ValueError("Tutorial sessions are limited to 100 code blocks")
    prerequisites: dict[str, list[Claim]] = {}
    for members in groups.values():
        members.sort(
            key=lambda claim: (
                claim.position.start_line,
                claim.position.start_column,
                claim.position.end_line,
                claim.position.end_column,
                claim.id,
            )
        )
        for index, claim in enumerate(members):
            prerequisites[claim.id] = members[:index]
    return prerequisites


def execution_order(claims: list[Claim], prerequisites: dict[str, list[Claim]]) -> list[Claim]:
    """Sort each session in its existing slots; preserve unrelated input ordering."""
    groups: dict[tuple[str, str], list[Claim]] = defaultdict(list)
    for claim in claims:
        if claim.id in prerequisites and claim.session is not None:
            groups[claim.page, claim.session].append(claim)
    queues = {
        key: deque(sorted(members, key=lambda claim: len(prerequisites[claim.id])))
        for key, members in groups.items()
    }
    return [
        queues[claim.page, claim.session].popleft()
        if claim.id in prerequisites and claim.session is not None
        else claim
        for claim in claims
    ]


def replay_script(claim: Claim, prerequisites: list[Claim]) -> str:
    """Generate sandbox input only. No example code executes on the verifier host.

    Prefix output is discarded, not buffered or asserted again. Each prefix's stdout
    contract was checked in its own earlier execution. The wrapper uses a separate
    locals scope so ordinary example variable names cannot overwrite its controls.
    """
    prefix = [(item.text, f"{item.page}:{item.position.start_line}") for item in prerequisites]
    target_filename = f"{claim.page}:{claim.position.start_line}"
    return f"""def _groundskeeper_replay():
    import contextlib
    import os
    import sys
    scope = {{"__name__": "__main__", "__file__": __file__}}
    try:
        with open(os.devnull, "w") as sink:
            saved_stdout, saved_stderr = os.dup(1), os.dup(2)
            try:
                os.dup2(sink.fileno(), 1)
                os.dup2(sink.fileno(), 2)
                with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                    for code, filename in {prefix!r}:
                        exec(compile(code, filename, "exec"), scope)
            finally:
                os.dup2(saved_stdout, 1)
                os.dup2(saved_stderr, 2)
                os.close(saved_stdout)
                os.close(saved_stderr)
    except BaseException:
        sys.exit({PREFIX_FAILURE_EXIT})
    exec(compile({claim.text!r}, {target_filename!r}, "exec"), scope)
_groundskeeper_replay()
"""
