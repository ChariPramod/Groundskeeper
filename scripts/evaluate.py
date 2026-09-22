"""Run with `uv run python scripts/evaluate.py [--output report.json]`."""

import argparse
import json
from pathlib import Path

from groundskeeper.evaluation import evaluate


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate synthetic candidate-drift labels")
    parser.add_argument("--output", type=Path, help="Also write the JSON report to this path")
    args = parser.parse_args()
    report = evaluate()
    payload = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if args.output:
        args.output.write_text(payload)
    print(payload, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
