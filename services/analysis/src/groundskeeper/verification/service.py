import hashlib
import json
import uuid
from collections import Counter
from datetime import UTC, datetime

from groundskeeper.models import Claim, ClaimStatus
from groundskeeper.verification.docker import DEFAULT_IMAGE, DockerSandbox, Sandbox
from groundskeeper.verification.models import (
    SandboxLimits,
    VerificationEvidence,
    VerificationReport,
)
from groundskeeper.verification.snapshot import Snapshot
from groundskeeper.verification.tutorial import (
    PREFIX_FAILURE_EXIT,
    execution_order,
    replay_script,
    tutorial_prerequisites,
)


def claim_digest(claim: Claim, prerequisites: list[Claim] | None = None) -> str:
    """Evidence binds to content even when a caller supplies their own claim ID."""
    contract = {
        "page": claim.page,
        "text": claim.text,
        "language": claim.language,
        "runnable": claim.runnable,
        "expected_output": claim.expected_output,
    }
    if claim.session is not None:
        contract["session"] = claim.session
        contract["prerequisites"] = [claim_digest(item) for item in prerequisites or []]
    return hashlib.sha256(
        json.dumps(
            contract,
            sort_keys=True,
        ).encode()
    ).hexdigest()


def output_matches(actual: str, expected: str) -> bool:
    # A fence has no terminal newline; print() usually emits one. Preserve other whitespace.
    actual = actual.replace("\r\n", "\n")
    expected = expected.replace("\r\n", "\n")
    return actual == expected or actual == expected + "\n"


def verify(
    claims: list[Claim],
    snapshot: Snapshot,
    *,
    image: str = DEFAULT_IMAGE,
    limits: SandboxLimits | None = None,
    sandbox: Sandbox | None = None,
) -> VerificationReport:
    if len({claim.id for claim in claims}) != len(claims):
        raise ValueError("Claim IDs must be unique")
    limits = limits or SandboxLimits()
    sandbox = sandbox or DockerSandbox(image)
    evidence: list[VerificationEvidence] = []
    updated: list[Claim] = []
    prerequisites = tutorial_prerequisites(claims)
    outcomes_by_id: dict[str, str] = {}
    attempted = 0
    for claim in execution_order(claims, prerequisites):
        # This verifier proves executable blocks, not nearby prose.
        if claim.kind != "code":
            updated.append(claim)
            continue
        started = datetime.now(UTC)
        prefix = prerequisites.get(claim.id, [])
        execution_cost = len(prefix) + 1
        item = VerificationEvidence(
            id=uuid.uuid4().hex,
            claim_id=claim.id,
            claim_digest=claim_digest(claim, prefix),
            source_digest=snapshot.digest,
            outcome="skipped",
            status=ClaimStatus.UNVERIFIABLE,
            reason="Block is not opted in with groundskeeper:run",
            started_at=started,
            finished_at=started,
            expected_output=claim.expected_output,
            limits=limits,
        )
        if any(outcomes_by_id.get(item.id) != "passed" for item in prefix):
            item.reason = "Tutorial prefix replay blocked by an earlier unverified session step"
            item.status = ClaimStatus.UNKNOWN
        elif not claim.runnable:
            pass
        elif claim.language not in ("python", "py"):
            item.reason = "Only Python blocks are supported by this verifier"
        elif sum(len(step.text.encode()) for step in [*prefix, claim]) > 65_536:
            item.reason = "Block and tutorial prefix exceed the 64 KiB execution input limit"
        elif attempted + execution_cost > limits.max_blocks:
            item.reason = "Verification block budget exhausted"
            item.status = ClaimStatus.UNKNOWN
        else:
            attempted += execution_cost
            code = replay_script(claim, prefix) if claim.session is not None else claim.text
            result = sandbox.run(code, snapshot, limits)
            item.image_id = result.image_id
            item.stdout = result.stdout
            item.stderr = result.stderr
            item.exit_code = result.exit_code
            if result.error or result.exit_code is None:
                item.outcome = "error"
                item.status = ClaimStatus.UNKNOWN
                item.reason = result.error or "Sandbox returned no execution result"
            elif claim.session is not None and result.exit_code == PREFIX_FAILURE_EXIT:
                item.outcome = "error"
                item.status = ClaimStatus.UNKNOWN
                item.reason = "Tutorial prefix replay failed or the target used reserved exit 120"
            elif result.exit_code != 0:
                item.outcome = "failed"
                item.status = ClaimStatus.STALE
                item.reason = "The example exited with a nonzero status in the selected environment"
            elif claim.expected_output is not None and not output_matches(
                result.stdout, claim.expected_output
            ):
                item.outcome = "failed"
                item.status = ClaimStatus.STALE
                item.reason = "The example's stdout differs from its documented expected output"
            else:
                item.outcome = "passed"
                item.status = ClaimStatus.VERIFIED
                item.reason = (
                    "The example exited successfully and matched its expected stdout"
                    if claim.expected_output is not None
                    else "The example exited successfully; no stdout assertion was supplied"
                )
        if claim.session is not None:
            item.reason += f"; tutorial prefix replay ({len(prefix)} prerequisite blocks)"
        item.finished_at = datetime.now(UTC)
        evidence.append(item)
        outcomes_by_id[claim.id] = item.outcome
        updated.append(
            claim.model_copy(
                update={
                    "status": item.status,
                    "last_verified": item.finished_at
                    if item.outcome in ("passed", "failed")
                    else None,
                    "verification_method": "python_execution"
                    if item.outcome in ("passed", "failed")
                    else None,
                }
            )
        )
    input_order = {claim.id: index for index, claim in enumerate(claims)}
    updated.sort(key=lambda claim: input_order[claim.id])
    evidence.sort(key=lambda item: input_order[item.claim_id])
    outcomes = Counter(item.outcome for item in evidence)
    statuses = Counter(claim.status for claim in updated)
    return VerificationReport(
        id=uuid.uuid4().hex,
        created_at=datetime.now(UTC),
        source_digest=snapshot.digest,
        image=image,
        claims=updated,
        evidence=evidence,
        outcomes={value: outcomes[value] for value in ("passed", "failed", "error", "skipped")},
        statuses={value: statuses[value] for value in ClaimStatus},
    )
