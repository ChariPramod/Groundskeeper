"""Run with `uv run python scripts/evaluate.py [--baseline old.json] [--output new.json]`."""

import argparse
import json
import sys
from pathlib import Path

from groundskeeper.evaluation import evaluate
from groundskeeper.evaluation_comparison import (
    ComparisonError,
    compare_reports,
    load_baseline,
    protect_baseline,
    write_report,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate authored candidate labels and safety boundaries"
    )
    parser.add_argument("--output", type=Path, help="Atomically write the JSON report to this path")
    parser.add_argument("--baseline", type=Path, help="Compare with a compatible schema-v2 report")
    args = parser.parse_args()
    try:
        baseline, identity = load_baseline(args.baseline) if args.baseline else (None, None)
        if args.output and args.baseline and identity:
            protect_baseline(args.output, args.baseline, identity)
        report = evaluate()
        if baseline is not None:
            report["comparison"] = compare_reports(report, baseline)
        payload = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
        if args.output:
            write_report(args.output, payload, args.baseline, identity)
        print(payload, end="")
        return 0 if report["passed"] and report.get("comparison", {"passed": True})["passed"] else 1
    except ComparisonError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception:
        # Engine or I/O exceptions can contain repository text, credentials, or paths.
        print(
            "Evaluation could not complete. Inspect the inputs and runtime, then retry.",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
