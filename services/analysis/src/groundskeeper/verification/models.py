from datetime import datetime
from typing import Literal

from pydantic import Field

from groundskeeper.models import Claim, ClaimStatus, Model


class SandboxLimits(Model):
    timeout_seconds: float = Field(default=10, gt=0, le=60)
    memory_mb: int = Field(default=128, ge=64, le=512)
    output_bytes: int = Field(default=65_536, ge=256, le=1_048_576)
    max_blocks: int = Field(default=10, ge=0, le=100)


class VerificationEvidence(Model):
    id: str
    claim_id: str
    claim_digest: str
    source_digest: str
    method: Literal["python_execution"] = "python_execution"
    outcome: Literal["passed", "failed", "error", "skipped"]
    status: ClaimStatus
    reason: str
    started_at: datetime
    finished_at: datetime
    image_id: str | None = None
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    expected_output: str | None = None
    limits: SandboxLimits


class VerificationReport(Model):
    schema_version: str = "1"
    id: str
    created_at: datetime
    source_digest: str
    image: str
    claims: list[Claim]
    evidence: list[VerificationEvidence]
    outcomes: dict[str, int]
    statuses: dict[str, int]
