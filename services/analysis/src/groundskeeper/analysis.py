import posixpath
import re
from collections import Counter, defaultdict
from urllib.parse import unquote, urlsplit

from groundskeeper.models import (
    AnalysisReport,
    AnalysisRequest,
    Claim,
    ClaimLink,
    ClaimStatus,
    Health,
    Impact,
    Symbol,
)
from groundskeeper.symbols import extract_symbols


def link_claims(claims: list[Claim], symbols: list[Symbol]) -> list[ClaimLink]:
    candidates: dict[str, list[Symbol]] = defaultdict(list)
    for symbol in symbols:
        if symbol.kind != "file":
            for name in {symbol.name, symbol.qualified_name}:
                candidates[name].append(symbol)
    files = {symbol.path: symbol for symbol in symbols if symbol.kind == "file"}
    links: dict[tuple[str, str], ClaimLink] = {}
    for claim in claims:
        tokens = set(re.findall(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*", claim.text))
        tokens.update(ref.value for ref in claim.references if ref.kind == "identifier")
        for token in sorted(tokens):
            matches = candidates.get(token, [])
            for symbol in matches:
                links[claim.id, symbol.id] = ClaimLink(
                    claim_id=claim.id,
                    symbol_id=symbol.id,
                    match=f"identifier:{token}",
                    confidence=1.0 / len(matches),
                )
        for ref in claim.references:
            if ref.kind != "path":
                continue
            path = unquote(urlsplit(ref.value).path)
            if not path:
                continue
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(claim.page), path))
            for candidate in {path.removeprefix("/"), resolved}:
                symbol = files.get(candidate)
                if symbol:
                    links[claim.id, symbol.id] = ClaimLink(
                        claim_id=claim.id,
                        symbol_id=symbol.id,
                        match=f"path:{ref.value}",
                        confidence=1,
                    )
    return sorted(links.values(), key=lambda link: (link.claim_id, link.symbol_id))


def analyze(request: AnalysisRequest) -> AnalysisReport:
    before = [symbol for source in request.before for symbol in extract_symbols(source)]
    after = [symbol for source in request.after for symbol in extract_symbols(source)]
    old = {symbol.id: symbol for symbol in before}
    new = {symbol.id: symbol for symbol in after}
    changed = {
        symbol_id
        for symbol_id in old.keys() | new.keys()
        if symbol_id not in old
        or symbol_id not in new
        or old[symbol_id].fingerprint != new[symbol_id].fingerprint
    }
    # Keep removed declarations in the link graph: rename/delete drift depends on them.
    symbols = sorted(
        (old | new).values(), key=lambda symbol: (symbol.path, symbol.start_line, symbol.id)
    )
    links = link_claims(request.claims, symbols)
    affected: dict[str, set[str]] = defaultdict(set)
    for link in links:
        if link.symbol_id in changed:
            affected[link.claim_id].add(link.symbol_id)
    impacts = [
        Impact(
            claim_id=claim_id,
            symbol_ids=sorted(symbol_ids),
            reason="A linked declaration changed or disappeared; verification is required.",
        )
        for claim_id, symbol_ids in sorted(affected.items())
    ]
    # A successful check of the old code is not proof for the changed code.
    claims = [
        claim.model_copy(update={"status": ClaimStatus.UNKNOWN}) if claim.id in affected else claim
        for claim in request.claims
    ]
    statuses = Counter(claim.status for claim in claims)
    total = len(claims)
    linked = len({link.claim_id for link in links})
    return AnalysisReport(
        claims=claims,
        symbols=symbols,
        links=links,
        changed_symbol_ids=sorted(changed),
        impacts=impacts,
        health=Health(
            total_claims=total,
            linked_claims=linked,
            affected_claims=len(impacts),
            link_coverage=linked / total if total else 0,
            verified_share=statuses["verified"] / total if total else 0,
            statuses={
                status: statuses[status]
                for status in ("unknown", "verified", "stale", "unverifiable")
            },
        ),
        warnings=[
            "Exact identifier links are candidates, not proof that prose is true or false.",
            "Symbols contain the union of both snapshots so deleted references remain traceable.",
            "This analysis does not execute code. Use the verify CLI for opted-in Python blocks.",
            "API/config/CLI introspection and fuzzy linking are not yet implemented.",
        ],
    )
