"""Validate saved evidence against authoritative inputs without executing examples."""

import re
import sys
from collections import Counter

from groundskeeper.models import ClaimStatus
from groundskeeper.verification.models import VerificationReport
from groundskeeper.verification.service import claim_digest, output_matches
from groundskeeper.verification.snapshot import Snapshot
from groundskeeper.verification.tutorial import tutorial_prerequisites
from groundskeeper.worker_verification import (
    MAX_INPUT_BYTES,
    WorkerVerificationRequest,
    select_claims,
)


class ImportRequest(WorkerVerificationRequest):
    evidence_report: VerificationReport


def validate_import(request: ImportRequest) -> None:
    report = request.evidence_report
    originals = {claim.id: claim for claim in select_claims(request.analysis)}
    if report.schema_version != "1" or not re.fullmatch(r"[a-f0-9]{32}", report.id):
        raise ValueError("Invalid report identity")
    if report.source_digest != Snapshot.create(request.sources).digest:
        raise ValueError("Evidence does not match the pinned source snapshot")
    if len(report.claims) != len(originals) or {c.id for c in report.claims} != originals.keys():
        raise ValueError("Evidence must cover the complete affected claim selection")
    if (
        len(report.evidence) != len(originals)
        or {e.claim_id for e in report.evidence} != originals.keys()
    ):
        raise ValueError("Evidence must uniquely cover all selected claims")
    if len({e.id for e in report.evidence}) != len(report.evidence):
        raise ValueError("Duplicate evidence identity")
    claims = {claim.id: claim for claim in report.claims}
    prefixes = tutorial_prerequisites(list(originals.values()))
    mutable = {"status", "last_verified", "verification_method"}
    for claim in report.claims:
        if claim.model_dump(exclude=mutable) != originals[claim.id].model_dump(exclude=mutable):
            raise ValueError("Saved claim differs from the owning analysis")
    verdicts = {
        "passed": {ClaimStatus.VERIFIED},
        "failed": {ClaimStatus.STALE},
        "error": {ClaimStatus.UNKNOWN},
        "skipped": {ClaimStatus.UNKNOWN, ClaimStatus.UNVERIFIABLE},
    }
    for item in report.evidence:
        original = originals[item.claim_id]
        claim = claims[item.claim_id]
        if (
            item.source_digest != report.source_digest
            or item.claim_digest != claim_digest(original, prefixes.get(original.id, []))
            or item.expected_output != original.expected_output
            or item.status != claim.status
            or item.status not in verdicts[item.outcome]
            or item.finished_at < item.started_at
            or item.finished_at > report.created_at
        ):
            raise ValueError("Evidence integrity check failed")
        executed = item.outcome in ("passed", "failed")
        if (
            claim.last_verified != (item.finished_at if executed else None)
            or claim.verification_method != ("python_execution" if executed else None)
            or (executed and (not original.runnable or original.language not in ("py", "python")))
            or (executed and (item.image_id is None or item.exit_code is None))
            or (item.outcome == "passed" and item.exit_code != 0)
            or (
                item.outcome == "passed"
                and original.expected_output is not None
                and not output_matches(item.stdout, original.expected_output)
            )
        ):
            raise ValueError("Evidence verdict contradicts its execution fields")
    expected_outcomes = Counter(item.outcome for item in report.evidence)
    expected_statuses = Counter(claim.status for claim in report.claims)
    for provided, actual, keys in (
        (report.outcomes, expected_outcomes, set(verdicts)),
        (report.statuses, expected_statuses, {value.value for value in ClaimStatus}),
    ):
        if set(provided) - keys or any(provided.get(key, 0) != actual[key] for key in keys):
            raise ValueError("Evidence summary counts are inconsistent")


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Import request exceeds 32 MB")
    validate_import(ImportRequest.model_validate_json(raw))
    sys.stdout.write('{"valid":true}')


if __name__ == "__main__":
    main()
