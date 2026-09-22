"""Bounded stdin/stdout bridge for the trusted local GitHub worker."""

import sys

from groundskeeper.analysis import analyze
from groundskeeper.models import AnalysisRequest


def main():
    raw = sys.stdin.buffer.read(32_000_001)
    if len(raw) > 32_000_000:
        raise ValueError("Analysis input exceeds 32 MB")
    request = AnalysisRequest.model_validate_json(raw)
    sys.stdout.write(analyze(request).model_dump_json())


if __name__ == "__main__":
    main()
