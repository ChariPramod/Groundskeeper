"""Bounded verification bridge for analysis of a worker's pinned source snapshot."""

import sys

from pydantic import Field, model_validator

from groundskeeper.models import AnalysisReport, Model, SourceFile
from groundskeeper.verification.docker import DEFAULT_IMAGE, Sandbox
from groundskeeper.verification.models import SandboxLimits, VerificationReport
from groundskeeper.verification.service import verify
from groundskeeper.verification.snapshot import Snapshot

MAX_INPUT_BYTES = 32_000_000


class WorkerVerificationRequest(Model):
    analysis: AnalysisReport
    sources: list[SourceFile] = Field(max_length=1_000)
    image: str = DEFAULT_IMAGE
    limits: SandboxLimits = Field(default_factory=SandboxLimits)

    @model_validator(mode="after")
    def valid_selection(self):
        claims = [claim.id for claim in self.analysis.claims]
        impacts = [impact.claim_id for impact in self.analysis.impacts]
        if len(claims) > 10_000:
            raise ValueError("Analysis exceeds the 10,000 claim limit")
        if len(set(claims)) != len(claims):
            raise ValueError("Analysis claim IDs must be unique")
        if len(set(impacts)) != len(impacts):
            raise ValueError("Analysis impact claim IDs must be unique")
        if not set(impacts).issubset(claims):
            raise ValueError("Analysis impact references an unknown claim")
        return self


def verify_analysis(
    request: WorkerVerificationRequest, sandbox: Sandbox | None = None
) -> VerificationReport:
    """Verify affected code and its explicitly declared tutorial session.

    The caller supplies the Python files from the same immutable head used by analysis.
    The resulting digest binds evidence to these supplied bytes; this bridge does not
    fetch a repository or establish that the caller supplied a particular Git commit.
    """
    snapshot = Snapshot.create(request.sources)
    affected = {impact.claim_id for impact in request.analysis.impacts}
    affected_sessions = {
        (claim.page, claim.session)
        for claim in request.analysis.claims
        if claim.kind == "code" and claim.id in affected and claim.session is not None
    }
    claims = sorted(
        (
            claim
            for claim in request.analysis.claims
            if claim.kind == "code"
            and (claim.id in affected or (claim.page, claim.session) in affected_sessions)
        ),
        key=lambda claim: (
            claim.page,
            claim.position.start_line,
            claim.position.start_column,
            claim.position.end_line,
            claim.position.end_column,
            claim.id,
        ),
    )
    return verify(claims, snapshot, image=request.image, limits=request.limits, sandbox=sandbox)


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Verification input exceeds 32 MB")
    request = WorkerVerificationRequest.model_validate_json(raw)
    sys.stdout.write(verify_analysis(request).model_dump_json())


if __name__ == "__main__":
    main()
