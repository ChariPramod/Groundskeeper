"""Explicit, bounded source snapshots; never mount a user's checkout into a sandbox."""

import errno
import hashlib
import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from groundskeeper.models import SourceFile

IGNORE = {".git", ".venv", "node_modules", "dist", ".groundskeeper", "__pycache__"}
MAX_FILES = 1_000
MAX_BYTES = 10_000_000


def read_sources(
    root: Path, suffixes: tuple[str, ...] = (".py", ".ts", ".tsx")
) -> list[SourceFile]:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"Source directory does not exist: {root}")
    result: list[SourceFile] = []
    size = 0

    def fail(error: OSError):
        raise error

    for directory, folders, files, directory_fd in os.fwalk(
        root, onerror=fail, follow_symlinks=False
    ):
        folders[:] = sorted(name for name in folders if name not in IGNORE)
        for name in sorted(files):
            path = Path(directory) / name
            if path.suffix not in suffixes:
                continue
            # Open relative to the traversed directory, without following links. Checking
            # is_symlink()/is_file() before opening leaves a checkout mutation race.
            try:
                descriptor = os.open(
                    name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd
                )
            except OSError as error:
                if error.errno == errno.ELOOP:
                    continue
                raise
            with os.fdopen(descriptor, "rb") as handle:
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    continue
                # Bound the read itself, not just the resulting Pydantic object.
                content = handle.read(min(2_000_001, MAX_BYTES - size + 1))
            size += len(content)
            if len(content) > 2_000_000 or size > MAX_BYTES or len(result) >= MAX_FILES:
                raise ValueError("Source snapshot exceeds the 1,000 file / 10 MB limits")
            result.append(
                SourceFile(path=path.relative_to(root).as_posix(), content=content.decode())
            )
    return sorted(result, key=lambda source: source.path)


@dataclass(frozen=True)
class SnapshotFile:
    path: str
    content: str


@dataclass(frozen=True)
class Snapshot:
    files: tuple[SnapshotFile, ...]
    digest: str

    @classmethod
    def create(cls, files: list[SourceFile]) -> "Snapshot":
        ordered = sorted(files, key=lambda source: source.path)
        seen: set[str] = set()
        size = 0
        for source in ordered:
            path = PurePosixPath(source.path)
            if (
                path.is_absolute()
                or ".." in path.parts
                or "\\" in source.path
                or "\x00" in source.path
                or path.as_posix() != source.path
                or path.suffix != ".py"
                or source.path in seen
            ):
                raise ValueError(f"Invalid Python snapshot path: {source.path}")
            seen.add(source.path)
            size += len(source.content.encode())
        if len(ordered) > MAX_FILES or size > MAX_BYTES:
            raise ValueError("Source snapshot exceeds the 1,000 file / 10 MB limits")
        digest = hashlib.sha256(
            json.dumps(
                [(source.path, source.content) for source in ordered], ensure_ascii=False
            ).encode()
        ).hexdigest()
        return cls(tuple(SnapshotFile(source.path, source.content) for source in ordered), digest)

    def materialize(self, root: Path) -> None:
        root.mkdir(mode=0o755)
        root.chmod(0o755)
        for source in self.files:
            path = root / source.path
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            # The container's unprivileged user must be able to traverse directories,
            # including when the service uses a restrictive host umask.
            for parent in path.relative_to(root).parents:
                (root / parent).chmod(0o755)
            path.write_text(source.content, encoding="utf-8")
            path.chmod(0o444)
