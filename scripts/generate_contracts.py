"""Pydantic is the single source for the parser's wire contract."""

import json
from pathlib import Path

from groundskeeper.models import AnalysisReport, AnalysisRequest, ChangeBudget, Claim
from groundskeeper.verification.models import SandboxLimits, VerificationReport

root = Path(__file__).resolve().parents[1] / "packages/contracts/src"
root.mkdir(parents=True, exist_ok=True)
for model in (
    Claim,
    AnalysisRequest,
    AnalysisReport,
    ChangeBudget,
    SandboxLimits,
    VerificationReport,
):
    (root / f"{model.__name__}.schema.json").write_text(
        json.dumps(model.model_json_schema(), indent=2) + "\n"
    )
