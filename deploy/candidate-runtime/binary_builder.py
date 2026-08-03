#!/usr/bin/env python3
"""Validate and publish the candidate Linux arm64 binaries."""

from __future__ import annotations

import argparse
import os
import stat
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from runtime_binary import validate_linux_aarch64_elf

BINARIES = ("aiq-runner", "aiq-verifier")


def validate_binary(path: Path) -> None:
    """Require a regular executable Linux arm64 PIE with the expected loader."""
    service_uid = 10001 if path.name == "aiq-runner" else 10003
    validate_linux_aarch64_elf(
        path,
        path.name,
        allow_static=False,
        require_pie=True,
        service_uid=service_uid,
    )


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def publish_binaries(staging: Path, target: Path) -> None:
    """Publish into a newly created target without following or replacing paths."""

    if not target.is_absolute():
        raise ValueError("the output directory must be absolute")
    parent = target.parent
    if parent.resolve(strict=True) != parent:
        raise ValueError("the output parent must use its canonical path")
    if target.name in ("", ".", ".."):
        raise ValueError("the output directory name is invalid")

    for name in BINARIES:
        validate_binary(staging / name)

    parent_flags = os.O_RDONLY | os.O_DIRECTORY
    if hasattr(os, "O_CLOEXEC"):
        parent_flags |= os.O_CLOEXEC
    parent_fd = os.open(parent, parent_flags)
    target_fd = -1
    created = False
    published_names: list[str] = []
    try:
        os.mkdir(target.name, mode=0o700, dir_fd=parent_fd)
        created = True
        target_flags = os.O_RDONLY | os.O_DIRECTORY
        if hasattr(os, "O_CLOEXEC"):
            target_flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            target_flags |= os.O_NOFOLLOW
        target_fd = os.open(target.name, target_flags, dir_fd=parent_fd)
        identity = os.fstat(target_fd)

        for name in BINARIES:
            os.link(staging / name, name, dst_dir_fd=target_fd, follow_symlinks=False)
            published_names.append(name)
            os.unlink(staging / name)
        os.fchmod(target_fd, 0o755)
        os.fsync(target_fd)

        published = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(published.st_mode) or not _same_identity(identity, published):
            raise RuntimeError("the output directory changed during publication")
        os.fsync(parent_fd)
        created = False
    except FileExistsError as error:
        raise ValueError("the output directory already exists") from error
    finally:
        if created and target_fd >= 0:
            for name in published_names:
                try:
                    os.unlink(name, dir_fd=target_fd)
                except FileNotFoundError:
                    pass
            try:
                current = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
                if _same_identity(os.fstat(target_fd), current):
                    os.rmdir(target.name, dir_fd=parent_fd)
            except OSError:
                pass
        if target_fd >= 0:
            os.close(target_fd)
        os.close(parent_fd)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("staging", type=Path)
    parser.add_argument("target", type=Path)
    arguments = parser.parse_args()
    publish_binaries(arguments.staging, arguments.target)


if __name__ == "__main__":
    main()
