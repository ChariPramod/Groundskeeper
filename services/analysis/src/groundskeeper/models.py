"""Canonical wire models. Generate TypeScript contracts with `pnpm contracts`."""

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ClaimStatus(StrEnum):
    UNKNOWN = "unknown"
    VERIFIED = "verified"
    STALE = "stale"
    UNVERIFIABLE = "unverifiable"


class Position(Model):
    start_line: int = Field(ge=1)
    start_column: int = Field(ge=1)
    end_line: int = Field(ge=1)
    end_column: int = Field(ge=1)

    @model_validator(mode="after")
    def ordered(self):
        if (self.end_line, self.end_column) < (self.start_line, self.start_column):
            raise ValueError("end position must follow start position")
        return self


class Reference(Model):
    kind: Literal["identifier", "url", "path", "flag"]
    value: str = Field(min_length=1)


class Claim(Model):
    id: str
    page: str = Field(min_length=1)
    anchor: str
    kind: Literal["paragraph", "code", "table_row", "image"]
    text: str
    position: Position
    references: list[Reference] = Field(default_factory=list)
    language: str | None = None
    runnable: bool = False
    session: str | None = Field(
        default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", max_length=64
    )
    expected_output: str | None = None
    status: ClaimStatus = ClaimStatus.UNKNOWN
    last_verified: datetime | None = None
    verification_method: str | None = None


class Symbol(Model):
    id: str
    path: str
    name: str
    qualified_name: str
    kind: str
    language: str
    start_line: int
    end_line: int
    fingerprint: str


class ClaimLink(Model):
    claim_id: str
    symbol_id: str
    match: str
    confidence: float = Field(ge=0, le=1)


class SourceFile(Model):
    path: str = Field(min_length=1)
    content: str = Field(max_length=2_000_000)


class AnalysisRequest(Model):
    claims: list[Claim] = Field(max_length=10_000)
    before: list[SourceFile] = Field(max_length=2_000)
    after: list[SourceFile] = Field(max_length=2_000)

    @model_validator(mode="after")
    def unique_ids(self):
        for values in (
            [claim.id for claim in self.claims],
            [source.path for source in self.before],
            [source.path for source in self.after],
        ):
            if len(values) != len(set(values)):
                raise ValueError("claim IDs and paths within each snapshot must be unique")
        return self


class Impact(Model):
    claim_id: str
    symbol_ids: list[str]
    reason: str


class Health(Model):
    total_claims: int
    linked_claims: int
    affected_claims: int
    link_coverage: float
    verified_share: float
    statuses: dict[str, int]


class AnalysisReport(Model):
    schema_version: str = "1"
    claims: list[Claim]
    symbols: list[Symbol]
    links: list[ClaimLink]
    changed_symbol_ids: list[str]
    impacts: list[Impact]
    health: Health
    warnings: list[str]


class ChangeBudget(Model):
    max_pages: int = Field(default=3, ge=0, le=100)
    max_prs: int = Field(default=1, ge=0, le=10)
    max_lines_changed: int = Field(default=150, ge=0, le=10_000)
