import argparse
import json
import subprocess
from pathlib import Path

from groundskeeper.analysis import analyze
from groundskeeper.models import AnalysisRequest, Claim
from groundskeeper.verification.docker import DEFAULT_IMAGE
from groundskeeper.verification.models import SandboxLimits
from groundskeeper.verification.service import verify
from groundskeeper.verification.snapshot import Snapshot, read_sources


def parse_claims(docs: Path) -> list[Claim]:
    project = Path(__file__).resolve().parents[4]
    parsed = subprocess.run(
        [
            "pnpm",
            "exec",
            "tsx",
            str(project / "packages/parser/src/cli.ts"),
            "--root",
            str(docs.resolve()),
        ],
        cwd=project,
        capture_output=True,
        text=True,
        check=True,
    )
    return [Claim.model_validate(item) for item in json.loads(parsed.stdout)]


def main():
    parser = argparse.ArgumentParser(
        description="Build a claim index and report possible doc drift"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("analyze")
    command.add_argument("--docs", required=True, type=Path)
    command.add_argument("--before", required=True, type=Path)
    command.add_argument("--after", required=True, type=Path)
    command.add_argument("--output", type=Path)
    verification = commands.add_parser("verify", help="Verify opted-in Python blocks in Docker")
    verification.add_argument("--docs", required=True, type=Path)
    verification.add_argument("--source", required=True, type=Path)
    verification.add_argument("--output", type=Path)
    verification.add_argument("--image", default=DEFAULT_IMAGE)
    verification.add_argument("--timeout", type=float, default=10)
    verification.add_argument("--max-blocks", type=int, default=10)
    args = parser.parse_args()
    try:
        if args.command == "verify":
            limits = SandboxLimits(timeout_seconds=args.timeout, max_blocks=args.max_blocks)
            if args.output and args.output.exists():
                raise ValueError("Evidence reports cannot overwrite an existing output file")
            report = verify(
                parse_claims(args.docs),
                Snapshot.create(read_sources(args.source, (".py",))),
                image=args.image,
                limits=limits,
            )
            output = args.output or Path(".groundskeeper/verifications") / f"{report.id}.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("x") as handle:
                handle.write(report.model_dump_json(indent=2) + "\n")
            print(f"Evidence report: {output}")
            print(json.dumps(report.outcomes, indent=2))
            # Infrastructure failures are distinct from documentation failures in CI.
            parser.exit(2 if report.outcomes["error"] else 1 if report.outcomes["failed"] else 0)
        request = AnalysisRequest(
            claims=parse_claims(args.docs),
            before=read_sources(args.before),
            after=read_sources(args.after),
        )
        report = analyze(request)
        output = report.model_dump_json(indent=2) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(output)
            print(f"Report: {args.output}")
            print(report.health.model_dump_json(indent=2))
        else:
            print(output, end="")
    except subprocess.CalledProcessError as error:
        parser.exit(2, f"Markdown parsing failed:\n{error.stderr}")
    except (ValueError, OSError) as error:
        parser.exit(2, f"Groundskeeper failed: {error}\n")
