#!/usr/bin/env python3
"""Manage the bounded local Linux arm64 Official runner and verifier stack."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tomllib
from typing import Never

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from runtime_binary import validate_linux_aarch64_elf

COMPOSE = ROOT / "compose.yaml"
PROJECT = "aiq-official-runtime"
CONTAINERS = {
    "runner": "aiq-official-runner",
    "runner_proxy": "aiq-official-runner-proxy",
    "verifier": "aiq-official-verifier",
    "verifier_proxy": "aiq-official-verifier-proxy",
}
REQUIREMENTS = ROOT.parent.parent / "config" / "codex-requirements.example.toml"
SECCOMP = ROOT / "seccomp-bwrap.json"

READ_ONLY = {
    "source": ("AIQ_SOURCE", "dir"),
    "hidden_tasks": ("AIQ_HIDDEN_TASKS", "dir"),
    "baselines": ("AIQ_BASELINES", "dir"),
    "evaluators": ("AIQ_EVALUATORS", "dir"),
    "evaluator_runtime": ("AIQ_EVALUATOR_RUNTIME", "path"),
    "toolchain": ("AIQ_TOOLCHAIN", "dir"),
    "corpus_commitment": ("AIQ_CORPUS_COMMITMENT", "file"),
    "capabilities": ("AIQ_CAPABILITIES", "file"),
    "schedule": ("AIQ_SCHEDULE", "file"),
    "codex_binary": ("AIQ_CODEX_BINARY", "executable"),
    "runner_binary": ("AIQ_RUNNER_BINARY", "executable"),
    "verifier_binary": ("AIQ_VERIFIER_BINARY", "executable"),
    "verifier_tasks": ("AIQ_VERIFIER_TASKS", "dir"),
    "verifier_evaluators": ("AIQ_VERIFIER_EVALUATORS", "dir"),
    "verifier_evaluator_runtime": ("AIQ_VERIFIER_EVALUATOR_RUNTIME", "path"),
    "verifier_toolchain": ("AIQ_VERIFIER_TOOLCHAIN", "dir"),
    "verifier_corpus_commitment": ("AIQ_VERIFIER_CORPUS_COMMITMENT", "file"),
    "verifier_environment": ("AIQ_VERIFIER_ENVIRONMENT", "file"),
}

SECRETS = {
    "codex_auth": ("AIQ_CODEX_AUTH", 10001),
    "runner_signing_key": ("AIQ_RUNNER_SIGNING_KEY_FILE", 10001),
    "runner_submission_token": ("AIQ_RUNNER_SUBMISSION_TOKEN_FILE", 10001),
    "verifier_token": ("AIQ_VERIFIER_TOKEN_FILE", 10003),
    "verifier_signing_key": ("AIQ_VERIFIER_SIGNING_KEY_FILE", 10003),
}

WRITABLE = {
    "codex_home": ("AIQ_CODEX_HOME", 10001, 0o711),
    "execution": ("AIQ_EXECUTION", 10001, 0o700),
    "artifacts": ("AIQ_ARTIFACTS", 10001, 0o700),
    "checkpoints": ("AIQ_CHECKPOINTS", 10001, 0o700),
    "preflight": ("AIQ_PREFLIGHT", 10001, 0o700),
    "admission": ("AIQ_ADMISSION", 10001, 0o700),
    "results": ("AIQ_RESULTS", 10001, 0o700),
    "verifier_replay": ("AIQ_VERIFIER_REPLAY", 10003, 0o700),
    "verifier_records": ("AIQ_VERIFIER_RECORDS", 10003, 0o700),
}

RUNNER_MOUNTS = {
    "AIQ_SOURCE": ("/inputs/source", True),
    "AIQ_HIDDEN_TASKS": ("/inputs/tasks", True),
    "AIQ_BASELINES": ("/inputs/baselines", True),
    "AIQ_EVALUATORS": ("/inputs/evaluators", True),
    "AIQ_EVALUATOR_RUNTIME": ("/inputs/evaluator-runtime", True),
    "AIQ_TOOLCHAIN": ("/inputs/toolchain", True),
    "AIQ_CORPUS_COMMITMENT": ("/inputs/corpus-commitment.json", True),
    "AIQ_CAPABILITIES": ("/inputs/capabilities.json", True),
    "AIQ_SCHEDULE": ("/inputs/schedule.json", True),
    "AIQ_CODEX_BINARY": ("/inputs/bin/codex", True),
    "AIQ_RUNNER_BINARY": ("/inputs/bin/aiq-runner", True),
    "AIQ_CODEX_HOME": ("/codex-home", False),
    "AIQ_CODEX_AUTH": ("/codex-home/auth.json", True),
    "AIQ_RUNNER_SIGNING_KEY_FILE": ("/run/secrets/runner-signing-key", True),
    "AIQ_RUNNER_SUBMISSION_TOKEN_FILE": ("/run/secrets/runner-submission-token", True),
    "AIQ_EXECUTION": ("/execution", False),
    "AIQ_ARTIFACTS": ("/output/artifacts", False),
    "AIQ_CHECKPOINTS": ("/output/checkpoints", False),
    "AIQ_PREFLIGHT": ("/output/preflight", False),
    "AIQ_ADMISSION": ("/output/admission", False),
    "AIQ_RESULTS": ("/output/results", False),
}

VERIFIER_MOUNTS = {
    "AIQ_VERIFIER_BINARY": ("/inputs/bin/aiq-verifier", True),
    "AIQ_VERIFIER_TASKS": ("/inputs/tasks", True),
    "AIQ_VERIFIER_EVALUATORS": ("/inputs/evaluators", True),
    "AIQ_VERIFIER_EVALUATOR_RUNTIME": ("/inputs/evaluator-runtime", True),
    "AIQ_VERIFIER_TOOLCHAIN": ("/inputs/toolchain", True),
    "AIQ_VERIFIER_CORPUS_COMMITMENT": ("/inputs/corpus-commitment.json", True),
    "AIQ_VERIFIER_ENVIRONMENT": ("/inputs/verifier-environment.json", True),
    "AIQ_VERIFIER_TOKEN_FILE": ("/run/secrets/verifier-token", True),
    "AIQ_VERIFIER_SIGNING_KEY_FILE": ("/run/secrets/verifier-signing-key", True),
    "AIQ_VERIFIER_REPLAY": ("/replay", False),
    "AIQ_VERIFIER_RECORDS": ("/records", False),
}

MOUNTS = RUNNER_MOUNTS | VERIFIER_MOUNTS
RUNNER_COMMANDS = frozenset(("admit-permissions", "preflight", "run", "score", "package", "submit"))


def fail(message: str) -> Never:
    raise SystemExit(f"official-runtime: {message}")


def run(*args: str, capture: bool = False, check: bool = True) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def load_config(path: Path) -> dict[str, object]:
    if not path.is_absolute():
        fail("--config must be an absolute path")
    path = declared_path(str(path), "--config")
    if not path.is_file():
        fail("--config must be a regular file")
    if unsafe_write_bits(path):
        fail("--config must not be writable by group or other")
    with path.open("rb") as handle:
        value = tomllib.load(handle)
    return value


def declared_path(value: object, label: str) -> Path:
    if not isinstance(value, str) or not value:
        fail(f"{label} must be a non-empty path string")
    path = Path(value)
    if not path.is_absolute():
        fail(f"{label} must be absolute")
    cursor = Path(path.anchor)
    for part in path.parts[1:]:
        cursor /= part
        try:
            if cursor.is_symlink():
                fail(f"{label} contains symlink component {cursor}")
            if cursor.exists() and cursor != path and unsafe_write_bits(cursor):
                fail(f"{label} has group- or other-writable path component {cursor}")
        except OSError as error:
            fail(f"cannot inspect {label}: {error}")
    if not path.exists():
        fail(f"{label} does not exist")
    if path.resolve() != path:
        fail(f"{label} is not canonical")
    return path


def unsafe_write_bits(path: Path) -> bool:
    return bool(stat.S_IMODE(path.stat().st_mode) & 0o022)


def validate_kind(path: Path, kind: str, label: str) -> None:
    if kind == "dir" and not path.is_dir():
        fail(f"{label} must be a directory")
    if kind in {"file", "private_file", "executable"} and not path.is_file():
        fail(f"{label} must be a regular file")
    if kind == "path" and not (path.is_file() or path.is_dir()):
        fail(f"{label} must be a regular file or directory")
    if stat.S_IMODE(path.stat().st_mode) & 0o222:
        fail(f"{label} must have no owner, group, or other write bit")
    if kind == "executable" and not os.access(path, os.X_OK):
        fail(f"{label} must be executable")


def validate_secret(path: Path, label: str, service_uid: int) -> dict[str, object]:
    info = path.stat()
    if not path.is_file() or info.st_nlink != 1:
        fail(f"{label} must be a singly linked regular file")
    if info.st_uid != service_uid or info.st_gid != service_uid:
        fail(f"{label} must be owned by uid/gid {service_uid}:{service_uid}")
    if stat.S_IMODE(info.st_mode) != 0o600:
        fail(f"{label} must have exact mode 0600")
    return {
        "owner": f"{info.st_uid}:{info.st_gid}",
        "mode": "0600",
        "links": 1,
        "mount_policy": "read_only_file",
        "content_digest_recorded": False,
    }


def require_darwin_immutable(path: Path, label: str) -> None:
    if sys.platform != "darwin":
        return
    immutable = getattr(stat, "UF_IMMUTABLE", 0)
    if immutable == 0 or not getattr(path.stat(), "st_flags", 0) & immutable:
        fail(f"{label} must have the macOS owner-immutable flag")


def validate_empty_mountpoint(path: Path, label: str, service_uid: int) -> dict[str, object]:
    try:
        info = path.lstat()
    except FileNotFoundError:
        fail(f"{label} must be an existing empty regular file")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail(f"{label} must be a singly linked non-symlink regular file")
    if info.st_uid != service_uid or info.st_gid != service_uid:
        fail(f"{label} must be owned by uid/gid {service_uid}:{service_uid}")
    if stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != 0:
        fail(f"{label} must be empty and have exact mode 0600")
    return {
        "owner": f"{info.st_uid}:{info.st_gid}",
        "mode": "0600",
        "links": 1,
        "bytes": 0,
        "purpose": "nested_read_only_bind_mountpoint",
    }


def validate_writable(
    path: Path,
    label: str,
    service_uid: int,
    expected_mode: int = 0o700,
    service_gid: int | None = None,
) -> None:
    info = path.stat()
    expected_gid = service_uid if service_gid is None else service_gid
    if not path.is_dir() or info.st_uid != service_uid or info.st_gid != expected_gid:
        fail(f"{label} must be a directory owned by uid/gid {service_uid}:{expected_gid}")
    if stat.S_IMODE(info.st_mode) != expected_mode:
        fail(f"{label} must have mode {expected_mode:04o}")


def _metadata(info: os.stat_result) -> tuple[int, int, int, int, int, int, int]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def content_binding(path: Path, *, exclude_root: frozenset[str] = frozenset()) -> dict[str, object]:
    """Hash one frozen regular file or directory without following links."""
    digest = hashlib.sha256()
    entry_count = 0
    byte_count = 0

    def add(record: dict[str, object]) -> None:
        nonlocal entry_count
        digest.update(json.dumps(record, sort_keys=True, separators=(",", ":")).encode())
        digest.update(b"\n")
        entry_count += 1

    def scan_file(parent_fd: int | None, name: str | None, display: str, root: Path | None = None) -> None:
        nonlocal byte_count
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(root if root is not None else name, flags, dir_fd=parent_fd)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                fail(f"read-only input has a special file or unsafe hard link: {path / display}")
            if stat.S_IMODE(before.st_mode) & 0o222:
                fail(f"read-only input entry has a write bit: {path / display}")
            file_digest = hashlib.sha256()
            while True:
                block = os.read(descriptor, 1024 * 1024)
                if not block:
                    break
                file_digest.update(block)
            after = os.fstat(descriptor)
            if _metadata(before) != _metadata(after):
                fail(f"read-only input changed while hashing: {path / display}")
            byte_count += before.st_size
            add({
                "path": display,
                "type": "file",
                "mode": f"{stat.S_IMODE(before.st_mode):04o}",
                "size": before.st_size,
                "sha256": file_digest.hexdigest(),
            })
        finally:
            os.close(descriptor)

    def scan_directory(parent_fd: int | None, name: str | None, display: str, root: Path | None = None) -> None:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(root if root is not None else name, flags, dir_fd=parent_fd)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISDIR(before.st_mode):
                fail(f"read-only input is not a directory: {path / display}")
            if stat.S_IMODE(before.st_mode) & 0o222:
                fail(f"read-only input directory has a write bit: {path / display}")
            add({"path": display, "type": "directory", "mode": f"{stat.S_IMODE(before.st_mode):04o}"})
            with os.scandir(descriptor) as iterator:
                names = sorted(entry.name for entry in iterator)
            for child in names:
                if display == "." and child in exclude_root:
                    continue
                child_info = os.stat(child, dir_fd=descriptor, follow_symlinks=False)
                child_display = child if display == "." else f"{display}/{child}"
                if stat.S_ISLNK(child_info.st_mode):
                    fail(f"read-only input contains a symlink: {path / child_display}")
                if stat.S_ISDIR(child_info.st_mode):
                    scan_directory(descriptor, child, child_display)
                elif stat.S_ISREG(child_info.st_mode):
                    scan_file(descriptor, child, child_display)
                else:
                    fail(f"read-only input contains a special file: {path / child_display}")
            after = os.fstat(descriptor)
            if _metadata(before) != _metadata(after):
                fail(f"read-only input directory changed while hashing: {path / display}")
        finally:
            os.close(descriptor)

    root_info = os.stat(path, follow_symlinks=False)
    if stat.S_ISREG(root_info.st_mode):
        scan_file(None, None, ".", path)
        kind = "file"
    elif stat.S_ISDIR(root_info.st_mode):
        scan_directory(None, None, ".", path)
        kind = "directory"
    else:
        fail(f"read-only input is a special file: {path}")
    final_info = os.stat(path, follow_symlinks=False)
    if _metadata(root_info) != _metadata(final_info):
        fail(f"read-only input path changed while hashing: {path}")
    return {
        "algorithm": "sha256",
        "manifest_format": "aiq.frozen-tree.v1",
        "type": kind,
        "digest": f"sha256:{digest.hexdigest()}",
        "entries": entry_count,
        "bytes": byte_count,
        "host_identity": {"device": root_info.st_dev, "inode": root_info.st_ino},
    }


def validate_no_overlap(paths: dict[str, Path]) -> None:
    shared_read_only = {
        frozenset(("read_only.hidden_tasks", "read_only.verifier_tasks")),
        frozenset(("read_only.evaluators", "read_only.verifier_evaluators")),
        frozenset(("read_only.evaluator_runtime", "read_only.verifier_evaluator_runtime")),
        frozenset(("read_only.toolchain", "read_only.verifier_toolchain")),
        frozenset(("read_only.corpus_commitment", "read_only.verifier_corpus_commitment")),
    }
    items = list(paths.items())
    for index, (left_name, left) in enumerate(items):
        for right_name, right in items[index + 1 :]:
            common = Path(os.path.commonpath((left, right)))
            if common == left or common == right:
                if left == right and frozenset((left_name, right_name)) in shared_read_only:
                    continue
                fail(f"{left_name} and {right_name} overlap")


def validate_source(source: Path, expected: object) -> str:
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{40}", expected):
        fail("source_commit must be exactly 40 lowercase hexadecimal characters")
    actual = subprocess.run(
        ("git", "-C", str(source), "rev-parse", "HEAD"),
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout.strip()
    if actual != expected:
        fail("source HEAD does not match source_commit")
    status = subprocess.run(
        ("git", "-C", str(source), "status", "--porcelain=v1", "--untracked-files=all"),
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout
    if status:
        fail("source worktree must be clean, including untracked files")
    return actual


def validate_config_shape(
    config: dict[str, object],
) -> tuple[dict[str, object], dict[str, object]]:
    if set(config) != {"source_commit", "read_only", "writable"}:
        fail("config must contain only source_commit, [read_only], and [writable]")
    read_only = config.get("read_only")
    writable = config.get("writable")
    if not isinstance(read_only, dict) or not isinstance(writable, dict):
        fail("config needs [read_only] and [writable] tables")
    if set(read_only) != set(READ_ONLY) | set(SECRETS):
        fail("[read_only] must contain the exact supported path key set")
    if set(writable) != set(WRITABLE):
        fail("[writable] must contain the exact supported path key set")
    return read_only, writable


def validated_config(config_path: Path) -> tuple[dict[str, str], str, dict[str, object]]:
    config = load_config(config_path)
    read_only, writable = validate_config_shape(config)

    env: dict[str, str] = {}
    paths: dict[str, Path] = {}
    inputs: dict[str, object] = {}
    for name, (variable, kind) in READ_ONLY.items():
        path = declared_path(read_only.get(name), f"read_only.{name}")
        validate_kind(path, kind, f"read_only.{name}")
        if name in {"codex_binary", "runner_binary", "verifier_binary"}:
            try:
                validate_linux_aarch64_elf(
                    path,
                    f"read_only.{name}",
                    allow_static=name == "codex_binary",
                    require_pie=name != "codex_binary",
                    service_uid=10003 if name == "verifier_binary" else 10001,
                )
            except ValueError as error:
                fail(str(error))
        paths[f"read_only.{name}"] = path
        env[variable] = str(path)
        inputs[name] = {
            "mount_source": str(path),
            **content_binding(path, exclude_root=frozenset({".git"}) if name == "source" else frozenset()),
        }
    secret_metadata: dict[str, object] = {}
    for name, (variable, service_uid) in SECRETS.items():
        path = declared_path(read_only.get(name), f"read_only.{name}")
        secret_metadata[name] = validate_secret(path, f"read_only.{name}", service_uid)
        if name == "codex_auth":
            require_darwin_immutable(path, "read_only.codex_auth")
        paths[f"read_only.{name}"] = path
        env[variable] = str(path)
    for name, (variable, service_uid, expected_mode) in WRITABLE.items():
        path = declared_path(writable.get(name), f"writable.{name}")
        validate_writable(path, f"writable.{name}", service_uid, expected_mode)
        paths[f"writable.{name}"] = path
        env[variable] = str(path)

    mountpoints = {
        "codex_auth": validate_empty_mountpoint(
            paths["writable.codex_home"] / "auth.json",
            "writable.codex_home/auth.json mountpoint",
            10001,
        )
    }

    validate_no_overlap(paths)
    if paths["read_only.source"] != ROOT.parent.parent:
        fail("read_only.source must be the source tree that contains this runtime manager")
    commit = validate_source(paths["read_only.source"], config.get("source_commit"))
    env["AIQ_SOURCE_COMMIT"] = commit
    return env, commit, {
        "inputs": inputs,
        "secrets": secret_metadata,
        "mountpoints": mountpoints,
    }


def validate_docker_host() -> None:
    endpoint = run(
        "docker",
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
        capture=True,
    )
    if not endpoint.startswith("unix://"):
        fail("Docker must use a local Unix-socket context")
    info = json.loads(run("docker", "info", "--format", "{{json .}}", capture=True))
    if info.get("OSType") != "linux" or info.get("Architecture") != "aarch64":
        fail("Docker daemon must be Linux arm64")
    security = " ".join(info.get("SecurityOptions", []))
    if "seccomp" not in security:
        fail("Docker daemon does not report seccomp support")


def prepare_state(state: Path, *, create: bool) -> Path:
    if not state.is_absolute():
        fail("--state must be an absolute path")
    cursor = Path(state.anchor)
    for index, part in enumerate(state.parts[1:]):
        cursor /= part
        if not cursor.exists() and index != len(state.parts[1:]) - 1:
            fail(f"--state parent does not exist: {cursor}")
        if cursor.is_symlink():
            fail(f"--state contains symlink component {cursor}")
        if cursor.exists() and cursor != state and unsafe_write_bits(cursor):
            fail(f"--state has group- or other-writable component {cursor}")
    if not state.exists():
        if not create:
            fail("state directory does not exist; run create first")
        state.mkdir(mode=0o700, parents=False)
    if state.resolve() != state:
        fail("--state must be canonical")
    validate_writable(state, "state", os.getuid(), 0o700, os.getgid())
    return state / "compose.env"


def env_payload(env: dict[str, str]) -> bytes:
    for value in env.values():
        if "\n" in value or "\r" in value:
            fail("paths must not contain newlines")
    return "".join(f"{key}={json.dumps(value)}\n" for key, value in sorted(env.items())).encode()


def parse_env_payload(content: bytes) -> dict[str, str]:
    parsed: dict[str, str] = {}
    try:
        lines = content.decode().splitlines()
        for line in lines:
            key, encoded = line.split("=", 1)
            value = json.loads(encoded)
            if not key or key in parsed or not isinstance(value, str):
                fail("Compose environment has invalid or duplicate entries")
            parsed[key] = value
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        fail("Compose environment is not in the generated exact format")
    if content != env_payload(parsed):
        fail("Compose environment is not in canonical generated form")
    expected_keys = set(MOUNTS) | {"AIQ_SOURCE_COMMIT"}
    if set(parsed) != expected_keys:
        fail("Compose environment does not have the exact generated key set")
    if not re.fullmatch(r"[0-9a-f]{40}", parsed["AIQ_SOURCE_COMMIT"]):
        fail("Compose environment has an invalid source commit")
    for variable in MOUNTS:
        declared_path(parsed[variable], f"Compose environment {variable}")
    return parsed


def validate_private_output(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        fail(f"refuse unsafe output path {path}")
    if info.st_uid != os.getuid() or info.st_nlink != 1:
        fail(f"output path has unsafe ownership or links: {path}")


def atomic_write_private(path: Path, payload: bytes) -> None:
    validate_private_output(path)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(temporary, flags, 0o600)
    except FileExistsError:
        fail(f"temporary output already exists: {temporary}")
    identity = os.fstat(descriptor)

    def cleanup_temporary() -> None:
        try:
            current = temporary.lstat()
        except FileNotFoundError:
            return
        if (
            stat.S_ISREG(current.st_mode)
            and current.st_uid == os.getuid()
            and current.st_nlink == 1
            and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino)
        ):
            temporary.unlink()

    try:
        view = memoryview(payload)
        while view:
            view = view[os.write(descriptor, view) :]
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    except BaseException:
        cleanup_temporary()
        raise
    finally:
        os.close(descriptor)
    try:
        os.replace(temporary, path)
    except BaseException:
        cleanup_temporary()
        raise
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def write_env(path: Path, env: dict[str, str]) -> None:
    atomic_write_private(path, env_payload(env))


def compose_args(env_file: Path) -> tuple[str, ...]:
    return (
        "docker",
        "compose",
        "--project-name",
        PROJECT,
        "--env-file",
        str(env_file),
        "--file",
        str(COMPOSE),
    )


def require_env_file(env_file: Path, expected: dict[str, str] | None = None) -> dict[str, str]:
    if not env_file.is_file() or env_file.is_symlink():
        fail("run create first; the private Compose environment is absent")
    info = env_file.stat()
    if info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
        fail("Compose environment must be private, singly linked, and owned by this user")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(env_file, flags)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            content = handle.read()
    finally:
        os.close(descriptor)
    parsed = parse_env_payload(content)
    if expected is not None and parsed != expected:
        fail("Compose environment does not match the supplied operator config")
    return parsed


def inspect(name: str) -> dict[str, object]:
    return json.loads(run("docker", "inspect", name, capture=True))[0]


def assert_mount_policy(
    container: dict[str, object],
    env: dict[str, str],
    policy: dict[str, tuple[str, bool]],
) -> None:
    expected = {
        destination: {"source": env[variable], "read_only": read_only}
        for variable, (destination, read_only) in policy.items()
    }
    actual: dict[str, dict[str, object]] = {}
    for mount in container["Mounts"]:
        if mount["Type"] != "bind":
            fail("live container has an unexpected non-bind mount")
        actual[mount["Destination"]] = {
            "source": mount["Source"],
            "read_only": not mount["RW"],
        }
    if actual != expected:
        fail("live runner bind mounts do not match the supplied operator config")


def assert_runtime(env: dict[str, str]) -> dict[str, dict[str, object]]:
    containers = {role: inspect(name) for role, name in CONTAINERS.items()}
    for role, container in containers.items():
        name = CONTAINERS[role]
        host = container["HostConfig"]
        if host["ReadonlyRootfs"] is not True or host["Privileged"] is not False:
            fail(f"{name} does not have the required root-filesystem and privilege policy")
        if host["CapDrop"] != ["ALL"]:
            fail(f"{name} does not drop all capabilities")
        if "no-new-privileges:true" not in host["SecurityOpt"]:
            fail(f"{name} does not set no-new-privileges")
        if host["NetworkMode"] == "host":
            fail(f"{name} uses host networking")
        if host.get("Binds") and any("docker.sock" in bind for bind in host["Binds"]):
            fail(f"{name} mounts a Docker socket")
        if host["PortBindings"]:
            fail(f"{name} publishes a host port")
        if "unconfined" in " ".join(host["SecurityOpt"]):
            fail(f"{name} uses an unconfined security policy")
    expected_users = {
        "runner": "10001:10001",
        "runner_proxy": "10002:10002",
        "verifier": "10003:10003",
        "verifier_proxy": "10004:10004",
    }
    expected_images = {
        "runner": "aiq-official-runner:local",
        "runner_proxy": "aiq-official-runner-proxy:local",
        "verifier": "aiq-official-verifier:local",
        "verifier_proxy": "aiq-official-verifier-proxy:local",
    }
    for role, container in containers.items():
        if container["Config"]["User"] != expected_users[role]:
            fail(f"{role} does not use exact uid/gid {expected_users[role]}")
        if container["Config"]["Image"] != expected_images[role]:
            fail(f"{role} does not use the exact local image tag")
    if containers["runner_proxy"]["Mounts"] or containers["verifier_proxy"]["Mounts"]:
        fail("a proxy has an unexpected mount")
    security_options = containers["runner"]["HostConfig"]["SecurityOpt"]
    security = " ".join(security_options)
    profile_options = [option for option in security_options if option.startswith("seccomp=")]
    if "unconfined" in security or len(profile_options) != 1:
        fail("runner custom seccomp policy is not active")
    if json.loads(profile_options[0].removeprefix("seccomp=")) != json.loads(SECCOMP.read_text()):
        fail("active runner seccomp policy does not match the reviewed profile")
    for role in ("runner_proxy", "verifier", "verifier_proxy"):
        options = containers[role]["HostConfig"]["SecurityOpt"]
        if any(option.startswith("seccomp=") for option in options):
            fail(f"{role} must use Docker's default seccomp profile")
    runner = containers["runner"]
    runner_proxy = containers["runner_proxy"]
    verifier = containers["verifier"]
    verifier_proxy = containers["verifier_proxy"]
    if set(runner["NetworkSettings"]["Networks"]) != {"aiq-official-runner-internal"}:
        fail("runner must attach only to its internal network")
    if set(verifier["NetworkSettings"]["Networks"]) != {"aiq-official-verifier-internal"}:
        fail("verifier must attach only to its own internal network")
    expected_proxy_networks = {
        "runner_proxy": {"aiq-official-runner-internal", "aiq-official-runner-proxy-egress"},
        "verifier_proxy": {"aiq-official-verifier-internal", "aiq-official-verifier-proxy-egress"},
    }
    for role, expected in expected_proxy_networks.items():
        if set(containers[role]["NetworkSettings"]["Networks"]) != expected:
            fail(f"{role} network topology is not exact")
    if runner_proxy["NetworkSettings"]["Networks"]["aiq-official-runner-internal"]["IPAddress"] != "172.30.0.2":
        fail("runner proxy internal endpoint is not 172.30.0.2")
    if verifier_proxy["NetworkSettings"]["Networks"]["aiq-official-verifier-internal"]["IPAddress"] != "10.248.32.2":
        fail("verifier proxy internal endpoint is not 10.248.32.2")
    assert_mount_policy(runner, env, RUNNER_MOUNTS)
    assert_mount_policy(verifier, env, VERIFIER_MOUNTS)
    verifier_environment = "\n".join(verifier["Config"].get("Env") or [])
    for forbidden in ("CODEX_HOME=", "AIQ_VERIFIER_INGRESS_TOKEN=", "AIQ_VERIFIER_SIGNING_KEY="):
        if forbidden in verifier_environment:
            fail(f"verifier environment exposes forbidden entry {forbidden}")
    runner_environment = "\n".join(runner["Config"].get("Env") or [])
    for forbidden in ("AIQ_RUNNER_SIGNING_KEY=", "AIQ_RUNNER_SUBMISSION_TOKEN="):
        if forbidden in runner_environment:
            fail(f"runner environment exposes forbidden entry {forbidden}")
    return containers


def assert_image_commit(containers: dict[str, dict[str, object]], commit: str) -> None:
    for role, container in containers.items():
        labels = container["Config"].get("Labels") or {}
        if labels.get("org.opencontainers.image.revision") != commit:
            fail(f"{role} image is not bound to the configured source commit")


def requirements_binding() -> dict[str, str]:
    ownership_mode = run(
        "docker",
        "exec",
        CONTAINERS["runner"],
        "stat",
        "-c",
        "%u:%g:%a",
        "/etc/codex/requirements.toml",
        capture=True,
    )
    container_digest = run(
        "docker",
        "exec",
        CONTAINERS["runner"],
        "sha256sum",
        "/etc/codex/requirements.toml",
        capture=True,
    ).split()[0]
    expected = sha256(REQUIREMENTS)
    if f"sha256:{container_digest}" != expected or ownership_mode != "0:0:444":
        fail("container requirements readback does not match the baked contract")
    return {"digest": expected, "ownership_mode": ownership_mode}


def secret_mount_metadata() -> dict[str, str]:
    targets = {
        "codex_auth": (CONTAINERS["runner"], "/codex-home/auth.json", "10001:10001:600:1"),
        "runner_signing_key": (
            CONTAINERS["runner"],
            "/run/secrets/runner-signing-key",
            "10001:10001:600:1",
        ),
        "runner_submission_token": (
            CONTAINERS["runner"],
            "/run/secrets/runner-submission-token",
            "10001:10001:600:1",
        ),
        "verifier_token": (CONTAINERS["verifier"], "/run/secrets/verifier-token", "10003:10003:600:1"),
        "verifier_signing_key": (
            CONTAINERS["verifier"],
            "/run/secrets/verifier-signing-key",
            "10003:10003:600:1",
        ),
    }
    observed = {}
    for name, (container, target, expected) in targets.items():
        value = run(
            "docker", "exec", container, "stat", "-c", "%u:%g:%a:%h", target, capture=True
        )
        if value != expected:
            fail(f"{name} secret mount metadata is not exact")
        observed[name] = value
    return observed


def default_seccomp_binding() -> dict[str, str]:
    observed = {}
    for role in ("runner_proxy", "verifier", "verifier_proxy"):
        value = run(
            "docker",
            "exec",
            CONTAINERS[role],
            "sh",
            "-c",
            "awk '/^Seccomp:/ { print $2 }' /proc/self/status",
            capture=True,
        )
        if value != "2":
            fail(f"{role} does not have Docker's default seccomp enforcement")
        observed[role] = "filtering"
    return observed


def runtime_binding(
    env_file: Path,
    commit: str,
    containers: dict[str, dict[str, object]],
    content: dict[str, object],
) -> dict[str, object]:
    network_ids: dict[str, str] = {}
    for role, container in containers.items():
        for network_name, network in container["NetworkSettings"]["Networks"].items():
            network_ids[f"{role}:{network_name}"] = network["NetworkID"]
    return {
        "source_commit": commit,
        "compose_env_digest": sha256(env_file),
        "containers": {role: container["Id"] for role, container in containers.items()},
        "images": {role: container["Image"] for role, container in containers.items()},
        "requirements": requirements_binding(),
        "secret_mount_metadata": secret_mount_metadata(),
        "default_seccomp": default_seccomp_binding(),
        "seccomp_digest": sha256(SECCOMP),
        "networks": network_ids,
        "content": content,
    }


def read_private_json(path: Path) -> dict[str, object]:
    validate_private_output(path)
    if not path.exists():
        fail(f"required private evidence is absent: {path.name}")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            fail(f"private evidence has unsafe metadata: {path.name}")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            value = json.load(handle)
    finally:
        os.close(descriptor)
    if not isinstance(value, dict):
        fail(f"private evidence is not a JSON object: {path.name}")
    return value


def require_current_evidence(evidence: dict[str, object], binding: dict[str, object]) -> None:
    if evidence.get("model_invoked") is not False or evidence.get("binding") != binding:
        fail("run validate before receipt; validation evidence is absent or stale")


def validate_state_separation(state: Path, env: dict[str, str]) -> None:
    for variable in MOUNTS:
        candidate = Path(env[variable])
        common = Path(os.path.commonpath((state, candidate)))
        if common == state or common == candidate:
            fail(f"state directory overlaps {variable}")


def require_created_content(state: Path, content: dict[str, object]) -> None:
    recorded = read_private_json(state / "content-bindings.json")
    if recorded.get("schema_version") != "aiq.official-runtime-content-bindings.v1":
        fail("created content bindings use an unsupported schema")
    if recorded.get("content") != content:
        fail("read-only input content or secret metadata changed; run create again")


def receipt_content(content: dict[str, object]) -> dict[str, object]:
    inputs = {}
    for name, binding in content["inputs"].items():
        inputs[name] = {key: value for key, value in binding.items() if key != "mount_source"}
    return {
        "inputs": inputs,
        "secrets": content["secrets"],
        "mountpoints": content["mountpoints"],
    }


def create(config: Path, state: Path) -> None:
    env, commit, content = validated_config(config)
    validate_docker_host()
    env_file = prepare_state(state, create=True)
    validate_state_separation(state, env)
    write_env(env_file, env)
    atomic_write_private(
        state / "content-bindings.json",
        (json.dumps({
            "schema_version": "aiq.official-runtime-content-bindings.v1",
            "source_commit": commit,
            "content": content,
        }, sort_keys=True) + "\n").encode(),
    )
    args = compose_args(env_file)
    run(*args, "config", "--quiet")
    run(*args, "build", "--pull")
    run(*args, "create", "--force-recreate")
    repeated_env, repeated_commit, repeated_content = validated_config(config)
    if (repeated_env, repeated_commit, repeated_content) != (env, commit, content):
        fail("operator inputs changed while the stack was created")


def up(state: Path) -> None:
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    env = require_env_file(env_file)
    validate_state_separation(state, env)
    run(*compose_args(env_file), "up", "--detach", "--no-build")


def validate(config: Path, state: Path) -> None:
    env, commit, content = validated_config(config)
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    require_env_file(env_file, env)
    validate_state_separation(state, env)
    require_created_content(state, content)
    containers = assert_runtime(env)
    assert_image_commit(containers, commit)
    runner_output = run(
        *compose_args(env_file),
        "exec",
        "--no-TTY",
        "runner",
        "/usr/local/bin/aiq-runtime-canary",
        capture=True,
    )
    verifier_output = run(
        *compose_args(env_file),
        "exec",
        "--no-TTY",
        "verifier",
        "/usr/local/bin/aiq-verifier-canary",
        capture=True,
    )
    if "model_invoked=false" not in runner_output or "model_invoked=false" not in verifier_output:
        fail("a model-free canary result is absent")
    repeated_env, repeated_commit, repeated_content = validated_config(config)
    if (repeated_env, repeated_commit, repeated_content) != (env, commit, content):
        fail("operator inputs changed during validation")
    evidence = {
        "schema_version": "aiq.official-runtime-validation.v2",
        "binding": runtime_binding(env_file, commit, containers, content),
        "canary": {"runner": runner_output, "verifier": verifier_output},
        "model_invoked": False,
    }
    atomic_write_private(
        state / "validation.json",
        (json.dumps(evidence, sort_keys=True) + "\n").encode(),
    )
    print(runner_output)
    print(verifier_output)


def receipt(config: Path, state: Path) -> None:
    env, commit, content = validated_config(config)
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    require_env_file(env_file, env)
    validate_state_separation(state, env)
    require_created_content(state, content)
    containers = assert_runtime(env)
    assert_image_commit(containers, commit)
    evidence = read_private_json(state / "validation.json")
    current_binding = runtime_binding(env_file, commit, containers, content)
    require_current_evidence(evidence, current_binding)
    docker_version = json.loads(
        run("docker", "version", "--format", "{{json .Server}}", capture=True)
    )
    mounts = {
        role: sorted(
            [
                {"destination": mount["Destination"], "mode": "rw" if mount["RW"] else "ro"}
                for mount in container["Mounts"]
                if mount["Type"] == "bind"
            ],
            key=lambda item: item["destination"],
        )
        for role, container in containers.items()
    }
    payload = {
        "schema_version": "aiq.official-runtime-deployment-receipt.v2",
        "source_commit": commit,
        "platform": {"os": docker_version["Os"], "architecture": docker_version["Arch"]},
        "docker": {"version": docker_version["Version"], "security_options": ["seccomp"]},
        "images": {role: container["Image"] for role, container in containers.items()},
        "content_bindings": receipt_content(content),
        "requirements": {
            "digest": current_binding["requirements"]["digest"],
            "container_ownership_mode": current_binding["requirements"]["ownership_mode"],
            "path": "/etc/codex/requirements.toml",
        },
        "seccomp": {
            "digest": sha256(SECCOMP),
            "active": True,
            "profile": "moby-default-v0.2.3+bubblewrap",
        },
        "network_topology": {
            "runner": ["aiq-official-runner-internal"],
            "runner_proxy": ["aiq-official-runner-internal", "aiq-official-runner-proxy-egress"],
            "runner_proxy_endpoint": "172.30.0.2:3128",
            "verifier": ["aiq-official-verifier-internal"],
            "verifier_proxy": ["aiq-official-verifier-internal", "aiq-official-verifier-proxy-egress"],
            "verifier_proxy_endpoint": "10.248.32.2:3128",
            "host_ports": [],
        },
        "mount_policy": mounts,
        "model_invoked": False,
    }
    repeated_env, repeated_commit, repeated_content = validated_config(config)
    if (repeated_env, repeated_commit, repeated_content) != (env, commit, content):
        fail("operator inputs changed while the receipt was created")
    destination = state / "deployment-receipt.json"
    atomic_write_private(
        destination,
        (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode(),
    )
    print(destination)


def runner_command(config: Path, state: Path, command: str, command_args: list[str]) -> None:
    if command not in RUNNER_COMMANDS:
        fail(f"unsupported runner command {command}")
    env, commit, content = validated_config(config)
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    require_env_file(env_file, env)
    validate_state_separation(state, env)
    require_created_content(state, content)
    containers = assert_runtime(env)
    assert_image_commit(containers, commit)
    evidence = read_private_json(state / "validation.json")
    require_current_evidence(evidence, runtime_binding(env_file, commit, containers, content))
    if command_args[:1] == ["--"]:
        command_args = command_args[1:]
    run(
        *compose_args(env_file),
        "exec",
        "--no-TTY",
        "runner",
        "/usr/local/bin/aiq-runtime-entrypoint",
        command,
        *command_args,
    )
    repeated_env, repeated_commit, repeated_content = validated_config(config)
    if (repeated_env, repeated_commit, repeated_content) != (env, commit, content):
        fail("operator inputs changed while the runner command executed")


def down(state: Path) -> None:
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    env = require_env_file(env_file)
    validate_state_separation(state, env)
    run(*compose_args(env_file), "down", "--remove-orphans", "--timeout", "10")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("create", "up", "validate", "receipt", "down", *sorted(RUNNER_COMMANDS)),
    )
    parser.add_argument("--config", type=Path)
    parser.add_argument("--state", required=True, type=Path)
    args, command_args = parser.parse_known_args()
    config_commands = {"create", "validate", "receipt", *RUNNER_COMMANDS}
    if args.command in config_commands and args.config is None:
        parser.error(f"{args.command} requires --config")
    if args.command not in RUNNER_COMMANDS and command_args:
        parser.error(f"unrecognized arguments: {' '.join(command_args)}")
    if args.command == "create":
        create(args.config, args.state)
    elif args.command == "up":
        up(args.state)
    elif args.command == "validate":
        validate(args.config, args.state)
    elif args.command == "receipt":
        receipt(args.config, args.state)
    elif args.command == "down":
        down(args.state)
    else:
        runner_command(args.config, args.state, args.command, command_args)


if __name__ == "__main__":
    main()
