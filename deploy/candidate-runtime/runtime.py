#!/usr/bin/env python3
"""Operate the local Linux arm64 AIQ Core 1.0.2 candidate runtime."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
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
PROJECT = "aiq-candidate-runtime"
RUNNER_UID = 10001
VERIFIER_UID = 10003

READ_ONLY = {
    "repository_source": ("AIQ_REPOSITORY_SOURCE", "dir"),
    "core_tasks": ("AIQ_CORE_TASKS", "dir"),
    "contrast_tasks": ("AIQ_CONTRAST_TASKS", "dir"),
    "candidate_source": ("AIQ_CANDIDATE_SOURCE", "dir"),
    "core_workspaces": ("AIQ_CORE_WORKSPACES", "dir"),
    "contrast_workspaces": ("AIQ_CONTRAST_WORKSPACES", "dir"),
    "evaluators": ("AIQ_EVALUATORS", "dir"),
    "evaluator_runtime": ("AIQ_EVALUATOR_RUNTIME", "path"),
    "toolchain": ("AIQ_TOOLCHAIN", "dir"),
    "capabilities": ("AIQ_CAPABILITIES", "file"),
    "schedule": ("AIQ_SCHEDULE", "file"),
    "signed_admission": ("AIQ_SIGNED_ADMISSION", "file"),
    "corpus_manifest": ("AIQ_CORPUS_MANIFEST", "file"),
    "core_commitment": ("AIQ_CORE_COMMITMENT", "file"),
    "contrast_commitment": ("AIQ_CONTRAST_COMMITMENT", "file"),
    "trust_policy": ("AIQ_TRUST_POLICY", "file"),
    "plan_inputs": ("AIQ_PLAN_INPUTS", "file"),
    "codex_binary": ("AIQ_CODEX_BINARY", "executable"),
    "runner_binary": ("AIQ_RUNNER_BINARY", "executable"),
    "verifier_binary": ("AIQ_VERIFIER_BINARY", "executable"),
}
PROTECTED = {
    "codex_auth": ("AIQ_CODEX_AUTH", RUNNER_UID),
    "authorization_key": ("AIQ_AUTHORIZATION_KEY", RUNNER_UID),
    "runner_key": ("AIQ_RUNNER_KEY", RUNNER_UID),
    "verifier_key": ("AIQ_VERIFIER_KEY", VERIFIER_UID),
    "trust_policy_pin": ("AIQ_TRUST_POLICY_PIN", RUNNER_UID),
    "verifier_trust_policy_pin": ("AIQ_VERIFIER_TRUST_POLICY_PIN", VERIFIER_UID),
    "authority_key": (None, None),
    "promotion_key": (None, None),
}
WRITABLE = {
    "codex_home": ("AIQ_CODEX_HOME", RUNNER_UID, 0o711),
    "execution": ("AIQ_EXECUTION", RUNNER_UID, 0o700),
    "work": ("AIQ_WORK", RUNNER_UID, 0o700),
    "artifacts": ("AIQ_ARTIFACTS", RUNNER_UID, 0o700),
    "outputs": ("AIQ_OUTPUTS", RUNNER_UID, 0o700),
    "control": ("AIQ_CONTROL", RUNNER_UID, 0o700),
    "verifier_replay": ("AIQ_VERIFIER_REPLAY", RUNNER_UID, 0o700),
    "logs": (None, None, 0o700),
}
SHARED = ("artifacts", "outputs", "control", "verifier_replay")
STAGES = [
    "created", "up", "prepared",
    "repeat-01-ran", "repeat-01-verified", "repeat-01-finalized",
    "repeat-02-ran", "repeat-02-verified", "repeat-02-finalized",
    "repeat-03-ran", "repeat-03-verified", "repeat-03-finalized",
    "aggregated", "promoted",
]
ACTORS = {"runner": RUNNER_UID, "verifier": VERIFIER_UID}
SAFE_CHILD_ENV_NAMES = (
    "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY",
    "HOME", "PATH", "SSL_CERT_DIR", "SSL_CERT_FILE",
)
CANONICAL_TIMESTAMP = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")
CANONICAL_DIGEST = re.compile(r"\Asha256:(?!0{64}\Z)[0-9a-f]{64}\Z")


def fail(message: str) -> Never:
    raise SystemExit(f"candidate-runtime: {message}")


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Return the small explicit environment allowed for host child processes."""
    environment = {
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
    }
    for name in SAFE_CHILD_ENV_NAMES:
        if name in os.environ:
            environment[name] = os.environ[name]
    if extra:
        environment.update(extra)
    return environment


def canonical_path(value: object, label: str) -> Path:
    if not isinstance(value, str) or not value:
        fail(f"{label} must be a nonempty absolute path")
    path = Path(value)
    if not path.is_absolute() or not path.exists() or path.resolve() != path:
        fail(f"{label} must be an existing canonical absolute path")
    cursor = Path(path.anchor)
    for part in path.parts[1:]:
        cursor /= part
        if cursor.is_symlink():
            fail(f"{label} contains symbolic-link indirection")
        if cursor != path and cursor.stat().st_mode & 0o022:
            fail(f"{label} has an unsafe parent")
    return path


def private_file(path: Path, label: str, uid: int | None) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
        fail(f"{label} must be a single-link mode-0600 regular file")
    if uid is not None and (info.st_uid != uid or info.st_gid != uid):
        fail(f"{label} has the wrong service ownership")


def require_darwin_immutable(path: Path, label: str) -> None:
    if sys.platform != "darwin":
        return
    immutable = getattr(stat, "UF_IMMUTABLE", 0)
    if immutable == 0 or not getattr(path.stat(), "st_flags", 0) & immutable:
        fail(f"{label} must have the macOS owner-immutable flag")


def metadata(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def content_binding(path: Path, exclude_git: bool = False) -> dict[str, object]:
    """Bind a frozen tree without following links or accepting concurrent mutation."""
    digest = hashlib.sha256()
    entries = 0
    byte_count = 0

    def add(record: dict[str, object]) -> None:
        nonlocal entries
        digest.update(canonical_bytes(record) + b"\n")
        entries += 1

    def scan(candidate: Path, display: str) -> None:
        nonlocal byte_count
        before = candidate.lstat()
        if stat.S_ISLNK(before.st_mode) or stat.S_IMODE(before.st_mode) & 0o222:
            fail("read-only input contains a link or writable entry")
        if stat.S_ISDIR(before.st_mode):
            add({"path": display, "type": "directory", "mode": f"{stat.S_IMODE(before.st_mode):04o}"})
            for child in sorted(candidate.iterdir(), key=lambda value: value.name):
                if exclude_git and display == "." and child.name == ".git":
                    continue
                scan(child, child.name if display == "." else f"{display}/{child.name}")
        elif stat.S_ISREG(before.st_mode) and before.st_nlink == 1:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(candidate, flags)
            try:
                opened = os.fstat(descriptor)
                file_digest = hashlib.sha256()
                while block := os.read(descriptor, 1024 * 1024):
                    file_digest.update(block)
                after_open = os.fstat(descriptor)
            finally:
                os.close(descriptor)
            after = candidate.lstat()
            if metadata(before) != metadata(opened) or metadata(opened) != metadata(after_open) or metadata(before) != metadata(after):
                fail("read-only input changed while it was bound")
            byte_count += before.st_size
            add({"path": display, "type": "file", "mode": f"{stat.S_IMODE(before.st_mode):04o}", "size": before.st_size, "sha256": file_digest.hexdigest()})
        else:
            fail("read-only input contains a special or linked file")
        if metadata(before) != metadata(candidate.lstat()):
            fail("read-only input changed while it was bound")

    root = path.lstat()
    scan(path, ".")
    return {"algorithm": "sha256", "manifest_format": "aiq.frozen-tree.v1", "digest": f"sha256:{digest.hexdigest()}", "entries": entries, "bytes": byte_count, "identity": [root.st_dev, root.st_ino]}


def load_config(
    path: Path,
    shared_owner: int = RUNNER_UID,
) -> tuple[dict[str, str], dict[str, Path], str, dict[str, object]]:
    if shared_owner not in ACTORS.values():
        fail("shared-owner identity is invalid")
    config_path = canonical_path(str(path), "--config")
    with config_path.open("rb") as handle:
        config = tomllib.load(handle)
    read_only = config.get("read_only")
    protected = config.get("protected")
    writable = config.get("writable")
    commit = config.get("source_commit")
    if not isinstance(read_only, dict) or not isinstance(protected, dict) or not isinstance(writable, dict):
        fail("config needs [read_only], [protected], and [writable] tables")
    if not isinstance(commit, str) or len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
        fail("source_commit must contain 40 lowercase hexadecimal characters")
    trust_paths: dict[str, Path] = {}
    for name in ("signed_admission", "trust_policy"):
        candidate = canonical_path(read_only.get(name), f"read_only.{name}")
        if not candidate.is_file() or candidate.stat().st_mode & 0o222:
            fail(f"read_only.{name} must be a frozen regular file")
        trust_paths[f"read_only.{name}"] = candidate
    for name in ("trust_policy_pin", "verifier_trust_policy_pin"):
        _, uid = PROTECTED[name]
        candidate = canonical_path(protected.get(name), f"protected.{name}")
        private_file(candidate, f"protected.{name}", uid)
        trust_paths[f"protected.{name}"] = candidate
    runner_pin = trust_paths["protected.trust_policy_pin"].read_text().strip()
    verifier_pin = trust_paths["protected.verifier_trust_policy_pin"].read_text().strip()
    if not CANONICAL_DIGEST.fullmatch(runner_pin) or verifier_pin != runner_pin:
        fail("protected trust-policy pins must contain the same canonical nonzero SHA-256 digest")
    verify_admission(trust_paths)

    env: dict[str, str] = {"AIQ_SOURCE_COMMIT": commit}
    paths: dict[str, Path] = {}
    bindings: dict[str, object] = {}
    for name, (variable, kind) in READ_ONLY.items():
        candidate = trust_paths.get(f"read_only.{name}")
        if candidate is None:
            candidate = canonical_path(read_only.get(name), f"read_only.{name}")
        if kind == "dir" and not candidate.is_dir() or kind == "file" and not candidate.is_file():
            fail(f"read_only.{name} has the wrong type")
        if kind == "executable" and (not candidate.is_file() or not os.access(candidate, os.X_OK)):
            fail(f"read_only.{name} must be executable")
        if kind == "path" and not (candidate.is_file() or candidate.is_dir()):
            fail(f"read_only.{name} has the wrong type")
        if candidate.stat().st_mode & 0o222:
            fail(f"read_only.{name} must be frozen")
        if name in {"codex_binary", "runner_binary", "verifier_binary"}:
            try:
                validate_linux_aarch64_elf(
                    candidate,
                    f"read_only.{name}",
                    allow_static=name == "codex_binary",
                    require_pie=name != "codex_binary",
                    service_uid=VERIFIER_UID if name == "verifier_binary" else RUNNER_UID,
                )
            except ValueError as error:
                fail(str(error))
        paths[f"read_only.{name}"] = candidate
        env[variable] = str(candidate)
        bindings[name] = content_binding(candidate, exclude_git=name == "repository_source")
    for name, (variable, uid) in PROTECTED.items():
        candidate = trust_paths.get(f"protected.{name}")
        if candidate is None:
            candidate = canonical_path(protected.get(name), f"protected.{name}")
            private_file(candidate, f"protected.{name}", uid)
        if name == "codex_auth":
            require_darwin_immutable(candidate, "protected.codex_auth")
        paths[f"protected.{name}"] = candidate
        if variable is not None:
            env[variable] = str(candidate)
    env["AIQ_TRUST_POLICY_DIGEST"] = runner_pin
    for name, (variable, configured_uid, mode) in WRITABLE.items():
        candidate = canonical_path(writable.get(name), f"writable.{name}")
        info = candidate.stat()
        uid = shared_owner if name in SHARED else configured_uid
        if not candidate.is_dir() or stat.S_IMODE(info.st_mode) != mode:
            fail(f"writable.{name} has the wrong type or mode")
        if uid is not None and (info.st_uid != uid or info.st_gid != uid):
            fail(f"writable.{name} has the wrong service ownership")
        paths[f"writable.{name}"] = candidate
        if variable is not None:
            env[variable] = str(candidate)
    values = list(paths.items())
    for index, (left_name, left) in enumerate(values):
        for right_name, right in values[index + 1:]:
            common = Path(os.path.commonpath((left, right)))
            if common in (left, right):
                allowed = {left_name, right_name} == {"writable.codex_home", "protected.codex_auth"}
                if not allowed:
                    fail("declared roots must not overlap")
    source = paths["read_only.repository_source"]
    if source != ROOT.parent.parent:
        fail("repository_source must contain this runtime bundle")
    result = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], text=True, capture_output=True, env=child_env())
    if result.returncode != 0 or result.stdout.strip() != commit:
        fail("repository source commit does not match source_commit")
    result = subprocess.run(
        ["git", "-C", str(source), "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
        text=True, capture_output=True, env=child_env(),
    )
    if result.returncode != 0 or result.stdout:
        fail("repository source must be clean, including untracked files")
    return env, paths, commit, bindings


def state_path(path: Path, create: bool) -> Path:
    if not path.is_absolute():
        fail("--state must be absolute")
    if create:
        path.mkdir(mode=0o700)
        fsync_directory(path.parent)
    path = canonical_path(str(path), "--state")
    if stat.S_IMODE(path.stat().st_mode) != 0o700:
        fail("--state must have mode 0700")
    return path


def validate_state_separation(state: Path, paths: dict[str, Path]) -> None:
    for candidate in paths.values():
        common = Path(os.path.commonpath((state, candidate)))
        if common in (state, candidate):
            fail("state directory overlaps a declared operator root")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def unlink_exact(path: Path, identity: tuple[int, int]) -> None:
    try:
        current = path.lstat()
    except FileNotFoundError:
        return
    if (
        not stat.S_ISREG(current.st_mode)
        or current.st_nlink != 1
        or (current.st_dev, current.st_ino) != identity
    ):
        fail("durable-write rollback target changed identity")
    path.unlink()


def write_new(path: Path, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    opened = os.fstat(descriptor)
    identity = (opened.st_dev, opened.st_ino)
    closed = False
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(descriptor, view):]
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
        os.close(descriptor)
        closed = True
        fsync_directory(path.parent)
    except BaseException:
        if not closed:
            os.close(descriptor)
            closed = True
        unlink_exact(path, identity)
        try:
            fsync_directory(path.parent)
        except OSError:
            pass
        raise
    finally:
        if not closed:
            os.close(descriptor)


def write_replace(path: Path, data: bytes) -> None:
    previous: bytes | None = None
    previous_mode = 0o600
    previous_owner = (os.getuid(), os.getgid())
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1 or stat.S_IMODE(existing.st_mode) != 0o600:
            fail("replace target must be a single-link mode-0600 regular file")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(descriptor)
            chunks: list[bytes] = []
            while block := os.read(descriptor, 1024 * 1024):
                chunks.append(block)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        if metadata(existing) != metadata(opened) or metadata(opened) != metadata(after) or metadata(existing) != metadata(path.lstat()):
            fail("replace target changed while it was read")
        previous = b"".join(chunks)
        previous_mode = stat.S_IMODE(existing.st_mode)
        previous_owner = (existing.st_uid, existing.st_gid)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.0.tmp")
    installed: tuple[int, int] | None = None
    try:
        for counter in range(1000):
            temporary = path.with_name(f".{path.name}.{os.getpid()}.{counter}.tmp")
            try:
                write_new(temporary, data)
                break
            except FileExistsError:
                continue
        else:
            fail("could not allocate a private replace temporary")
        temp_info = temporary.lstat()
        installed = (temp_info.st_dev, temp_info.st_ino)
        os.replace(temporary, path)
        fsync_directory(path.parent)
    except BaseException:
        if installed is not None:
            try:
                current = path.lstat()
            except FileNotFoundError:
                current = None
            if current is not None and (current.st_dev, current.st_ino) == installed:
                if previous is None:
                    unlink_exact(path, installed)
                else:
                    rollback = path.with_name(f".{path.name}.{os.getpid()}.rollback")
                    write_new(rollback, previous)
                    os.chmod(rollback, previous_mode)
                    os.chown(rollback, *previous_owner)
                    descriptor = os.open(rollback, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                    os.replace(rollback, path)
                try:
                    fsync_directory(path.parent)
                except OSError:
                    pass
        raise
    finally:
        try:
            info = temporary.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1:
                temporary.unlink()
        except FileNotFoundError:
            pass


def env_payload(env: dict[str, str]) -> bytes:
    for key, value in env.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            fail("Compose environment contains an unsafe variable name")
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            fail("Compose environment values contain unsafe characters")
        # Compose parses a quoted value after only the first equals sign. JSON
        # string quoting also protects spaces, hashes, quotes, and backslashes.
    return "".join(f"{key}={json.dumps(value, ensure_ascii=False)}\n" for key, value in sorted(env.items())).encode()


def compose(state: Path, *arguments: str, capture: bool = False) -> subprocess.CompletedProcess[str]:
    command = ["docker", "compose", "--project-name", PROJECT, "--env-file", str(state / "compose.env"), "--file", str(COMPOSE), *arguments]
    return subprocess.run(command, text=True, capture_output=capture, check=False, env=child_env())


def validate_docker_host() -> None:
    context = subprocess.run(
        ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        text=True, capture_output=True, env=child_env(),
    )
    if context.returncode != 0 or not context.stdout.strip().startswith("unix://"):
        fail("Docker must use a local Unix-socket context")
    result = subprocess.run(
        ["docker", "info", "--format", "{{json .}}"],
        text=True, capture_output=True, env=child_env(),
    )
    if result.returncode != 0:
        fail("Docker daemon information is unavailable")
    info = json.loads(result.stdout)
    security = " ".join(info.get("SecurityOptions", []))
    if info.get("OSType") != "linux" or info.get("Architecture") != "aarch64" or "seccomp" not in security:
        fail("Docker daemon must be Linux arm64 with seccomp")


def run_private(state: Path, label: str, command: list[str], env: dict[str, str] | None = None) -> str:
    logs = json.loads((state / "runtime-state.json").read_text())["logs"]
    log_root = Path(logs)
    number = len(list(log_root.glob("*.log"))) + 1
    target = log_root / f"{number:04}-{label}.log"
    result = subprocess.run(command, text=True, capture_output=True, env=child_env(env))
    write_new(target, (result.stdout + result.stderr).encode())
    if result.returncode != 0:
        public_event(state, label, "failed")
        fail(f"{label} failed; private log retained")
    public_event(state, label, "passed")
    return result.stdout


def public_event(state: Path, operation: str, status: str) -> None:
    document = {"schema_version": "aiq.candidate-runtime-status.v1", "operation": operation, "status": status}
    path = state / "public-status.jsonl"
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0))
    try:
        payload = canonical_bytes(document) + b"\n"
        view = memoryview(payload)
        while view:
            view = view[os.write(descriptor, view):]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def verify_admission(paths: dict[str, Path]) -> None:
    result = subprocess.run([
        "node", "--experimental-strip-types", str(ROOT / "verify-admission.ts"),
        str(paths["read_only.signed_admission"]), str(paths["read_only.trust_policy"]),
        str(paths["protected.trust_policy_pin"]),
    ], text=True, capture_output=True, env=child_env())
    if result.returncode != 0 or result.stdout != "admission_trusted=true\n":
        fail("signed admission is not trusted by the protected policy; no paid command was invoked")


def actor_state(state: Path) -> dict[str, object]:
    value = json.loads((state / "runtime-state.json").read_text())
    validate_actor_state(value)
    if value.get("handoff_pending") is not None:
        complete_handoff(state, value)
        value = json.loads((state / "runtime-state.json").read_text())
        validate_actor_state(value)
    return value


def validate_actor_state(value: object) -> None:
    if not isinstance(value, dict):
        fail("runtime state is invalid")
    expected = {"schema_version", "actor", "transition", "stage", "logs", "shared_roots", "source_commit"}
    if value.get("handoff_pending") is not None:
        expected.add("handoff_pending")
    if set(value) != expected:
        fail("runtime state has unsupported or missing fields")
    if (
        value.get("schema_version") != "aiq.candidate-runtime-state.v1"
        or value.get("actor") not in ACTORS
        or type(value.get("transition")) is not int
        or int(value["transition"]) < 0
        or value.get("stage") not in ["initializing", *STAGES]
        or not isinstance(value.get("logs"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", str(value.get("source_commit")))
    ):
        fail("runtime state contract is invalid")
    roots = value.get("shared_roots")
    if not isinstance(roots, dict) or set(roots) != set(SHARED):
        fail("runtime shared-root state is invalid")
    for root in roots.values():
        if (
            not isinstance(root, dict)
            or set(root) != {"path", "identity"}
            or not isinstance(root["path"], str)
            or not Path(root["path"]).is_absolute()
            or not isinstance(root["identity"], list)
            or len(root["identity"]) != 2
            or any(type(item) is not int or item < 0 for item in root["identity"])
        ):
            fail("runtime shared-root record is invalid")


def save_actor_state(state: Path, value: dict[str, object]) -> None:
    validate_actor_state(value)
    write_replace(state / "runtime-state.json", (json.dumps(value, sort_keys=True) + "\n").encode())


def require_stage(state: Path, expected: str) -> dict[str, object]:
    runtime = actor_state(state)
    if runtime.get("stage") != expected:
        fail(f"operation requires stage {expected}")
    return runtime


def advance_stage(state: Path, expected: str, target: str) -> None:
    runtime = require_stage(state, expected)
    if STAGES.index(target) != STAGES.index(expected) + 1:
        fail("invalid stage transition")
    runtime["stage"] = target
    save_actor_state(state, runtime)


def safe_tree(root: Path, expected_root: list[int], owner: int | None = None) -> list[dict[str, object]]:
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or [info.st_dev, info.st_ino] != expected_root:
        fail("shared root identity changed")
    paths = [root]
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        for name in [*directories, *files]:
            path = Path(current) / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
                fail("shared root contains an unsupported entry")
            if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink != 1:
                fail("shared root contains a linked file")
            paths.append(path)
    entries = []
    for path in paths:
        info = path.lstat()
        expected_mode = 0o700 if stat.S_ISDIR(info.st_mode) else 0o600
        if stat.S_IMODE(info.st_mode) != expected_mode:
            fail("shared root entry has an unexpected mode")
        if owner is not None and (info.st_uid, info.st_gid) != (owner, owner):
            fail("shared root entry has unexpected ownership")
        entries.append({
            "relative": "." if path == root else path.relative_to(root).as_posix(),
            "identity": [info.st_dev, info.st_ino],
            "mode": expected_mode,
        })
    return entries


def validate_shared_actor(state: Path, owner: int) -> None:
    runtime = json.loads((state / "runtime-state.json").read_text())
    validate_actor_state(runtime)
    for label in SHARED:
        record = runtime["shared_roots"][label]
        safe_tree(Path(record["path"]), record["identity"], owner)


def seal_shared_file(path: Path, owner: int) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail("host-produced shared output is not a single-link regular file")
    os.chmod(path, 0o600, follow_symlinks=False)
    os.chown(path, owner, owner, follow_symlinks=False)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(path.parent)


def sync_handoff_tree(root: Path, entries: list[dict[str, object]]) -> None:
    """Persist ownership metadata before the handoff journal can be cleared."""
    for entry in reversed(entries):
        path = root if entry["relative"] == "." else root / str(entry["relative"])
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            fsync_directory(path)
        else:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    fsync_directory(root.parent)


def complete_handoff(state: Path, runtime: dict[str, object]) -> None:
    pending = runtime.get("handoff_pending")
    if not isinstance(pending, dict):
        fail("handoff journal is invalid")
    if set(pending) != {"from", "to", "roots", "stage_from", "stage_to"} or pending.get("from") not in ACTORS or pending.get("to") not in ACTORS:
        fail("handoff journal actors are invalid")
    stage_from = pending.get("stage_from")
    stage_to = pending.get("stage_to")
    if (stage_from is None) != (stage_to is None):
        fail("handoff journal stage transition is incomplete")
    if stage_from is not None:
        if (
            runtime.get("stage") != stage_from
            or stage_from not in STAGES
            or stage_to not in STAGES
            or STAGES.index(str(stage_to)) != STAGES.index(str(stage_from)) + 1
        ):
            fail("handoff journal stage transition is invalid")
    source_uid = ACTORS[str(pending["from"])]
    destination_uid = ACTORS[str(pending["to"])]
    if source_uid == destination_uid or runtime.get("actor") != pending.get("from"):
        fail("handoff journal actors are invalid")
    for actor in ("runner", "verifier"):
        if compose(state, "stop", actor, capture=True).returncode != 0:
            fail("cannot stop both actors for ownership transfer")
    journal_roots = pending.get("roots")
    if not isinstance(journal_roots, dict) or set(journal_roots) != set(SHARED):
        fail("handoff journal roots are invalid")
    entry_count = 0
    for label in SHARED:
        root_record = runtime["shared_roots"][label]
        root = Path(root_record["path"])
        recorded = journal_roots[label]
        if not isinstance(recorded, list):
            fail("handoff journal entries are invalid")
        current = safe_tree(root, root_record["identity"])
        if current != recorded:
            fail("shared tree changed during handoff")
        entry_count += len(recorded)
        for entry in current:
            path = root if entry["relative"] == "." else root / str(entry["relative"])
            info = path.lstat()
            if info.st_uid not in (source_uid, destination_uid) or info.st_gid != info.st_uid:
                fail("shared entry ownership is outside the journaled transition")
        for entry in reversed(current):
            path = root if entry["relative"] == "." else root / str(entry["relative"])
            os.chown(path, destination_uid, destination_uid, follow_symlinks=False)
        safe_tree(root, root_record["identity"], destination_uid)
        sync_handoff_tree(root, current)
    target = str(pending["to"])
    if compose(state, "start", target, capture=True).returncode != 0:
        fail("target actor could not start; handoff journal retained for recovery")
    transition = int(runtime["transition"]) + 1
    receipt = {"schema_version": "aiq.candidate-runtime-handoff.v1", "transition": transition, "from": pending["from"], "to": target, "root_labels": list(SHARED), "entry_count": entry_count}
    receipt_path = state / "receipts" / f"handoff-{transition:04}.json"
    payload = canonical_bytes(receipt) + b"\n"
    if receipt_path.exists():
        if receipt_path.read_bytes() != payload:
            fail("handoff receipt conflicts with the pending journal")
    else:
        write_new(receipt_path, payload)
    runtime["actor"] = target
    runtime["transition"] = transition
    if stage_to is not None:
        runtime["stage"] = stage_to
    del runtime["handoff_pending"]
    save_actor_state(state, runtime)
    public_event(state, "handoff", "passed")


def handoff(
    state: Path,
    target: str,
    stage_from: str | None = None,
    stage_to: str | None = None,
) -> None:
    validate_docker_host()
    runtime = actor_state(state)
    current = runtime["actor"]
    if target not in ("runner", "verifier") or current == target:
        fail("invalid actor handoff")
    if (stage_from is None) != (stage_to is None):
        fail("handoff stage transition is incomplete")
    if stage_from is not None and runtime.get("stage") != stage_from:
        fail("handoff stage source does not match runtime state")
    source_uid = ACTORS[str(current)]
    for actor in ACTORS:
        if compose(state, "stop", actor, capture=True).returncode != 0:
            fail("cannot stop both actors for ownership transfer")
    roots: dict[str, list[dict[str, object]]] = {}
    for label in SHARED:
        record = runtime["shared_roots"][label]
        roots[label] = safe_tree(Path(record["path"]), record["identity"], source_uid)
    runtime["handoff_pending"] = {
        "from": current,
        "to": target,
        "roots": roots,
        "stage_from": stage_from,
        "stage_to": stage_to,
    }
    save_actor_state(state, runtime)
    complete_handoff(state, runtime)


def create(config: Path, state_arg: Path) -> None:
    env, paths, commit, bindings = load_config(config)
    verify_admission(paths)
    validate_docker_host()
    state = state_path(state_arg, True)
    validate_state_separation(state, paths)
    write_new(state / "compose.env", env_payload(env))
    (state / "receipts").mkdir(mode=0o700)
    fsync_directory(state)
    runtime = {
        "schema_version": "aiq.candidate-runtime-state.v1", "actor": "runner", "transition": 0,
        "stage": "initializing",
        "logs": str(paths["writable.logs"]),
        "shared_roots": {name: {"path": str(paths[f"writable.{name}"]), "identity": [paths[f"writable.{name}"].stat().st_dev, paths[f"writable.{name}"].stat().st_ino]} for name in SHARED},
        "source_commit": commit,
    }
    write_new(state / "runtime-state.json", (json.dumps(runtime, sort_keys=True) + "\n").encode())
    write_new(state / "content-bindings.json", canonical_bytes({"schema_version": "aiq.candidate-runtime-content-bindings.v1", "source_commit": commit, "inputs": bindings}) + b"\n")
    write_new(state / "public-status.jsonl", b"")
    result = compose(state, "config", "--quiet", capture=True)
    if result.returncode != 0:
        fail("Compose configuration is invalid")
    result = compose(state, "build", "--pull", capture=True)
    if result.returncode != 0:
        fail("candidate images could not be built")
    result = compose(state, "create", "--force-recreate", capture=True)
    if result.returncode != 0:
        fail("candidate containers could not be created")
    runtime["stage"] = "created"
    save_actor_state(state, runtime)
    public_event(state, "create", "passed")


def up(state_arg: Path) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    require_stage(state, "created")
    result = compose(state, "up", "--detach", "--no-build", "runner_proxy", "verifier_proxy", "runner", capture=True)
    if result.returncode != 0:
        fail("candidate runtime could not start")
    advance_stage(state, "created", "up")
    public_event(state, "up", "passed")


def live_container(state: Path, role: str) -> dict[str, object]:
    result = compose(state, "ps", "--all", "--quiet", role, capture=True)
    if result.returncode != 0 or not result.stdout.strip():
        fail(f"{role} container is absent")
    inspected = subprocess.run(["docker", "inspect", result.stdout.strip()], text=True, capture_output=True, env=child_env())
    if inspected.returncode != 0:
        fail(f"cannot inspect {role} container")
    return json.loads(inspected.stdout)[0]


def validate_runtime(config: Path, state_arg: Path) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    require_stage(state, "up")
    paths = configured(config, state, trust=True)
    containers = {role: live_container(state, role) for role in ("runner", "runner_proxy", "verifier", "verifier_proxy")}
    users = {"runner": "10001:10001", "runner_proxy": "10002:10002", "verifier": "10003:10003", "verifier_proxy": "10004:10004"}
    images = {role: f"aiq-candidate-{role.replace('_', '-')}:local" for role in users}
    for role, container in containers.items():
        host = container["HostConfig"]
        if container["Config"]["User"] != users[role] or host["ReadonlyRootfs"] is not True or host["Privileged"] is not False:
            fail("live runtime user or isolation policy is not exact")
        if host["CapDrop"] != ["ALL"] or "no-new-privileges:true" not in host["SecurityOpt"] or host["PortBindings"]:
            fail("live runtime capability or port policy is not exact")
        if "unconfined" in " ".join(host["SecurityOpt"]):
            fail("live runtime uses an unconfined security policy")
        if container["Config"]["Image"] != images[role]:
            fail("live runtime uses an unexpected image tag")
        if any("docker.sock" in mount.get("Source", "") for mount in container["Mounts"]):
            fail("live runtime exposes a Docker socket")
        labels = container["Config"].get("Labels") or {}
        if labels.get("org.opencontainers.image.revision") != actor_state(state)["source_commit"]:
            fail("live image is not bound to the configured source commit")
        image = subprocess.run(
            ["docker", "image", "inspect", container["Image"]], text=True, capture_output=True,
            env=child_env(),
        )
        if image.returncode != 0:
            fail("live image cannot be inspected")
        image_data = json.loads(image.stdout)[0]
        if image_data.get("Architecture") != "arm64" or image_data.get("Os") != "linux":
            fail("live image is not Linux arm64")
    if set(containers["runner"]["NetworkSettings"]["Networks"]) != {"aiq-candidate-runner-internal"}:
        fail("runner network attachment is not exact")
    if set(containers["verifier"]["NetworkSettings"]["Networks"]) != {"aiq-candidate-verifier-internal"}:
        fail("verifier network attachment is not exact")
    if set(containers["runner_proxy"]["NetworkSettings"]["Networks"]) != {
        "aiq-candidate-runner-internal", "aiq-candidate-runner-proxy-egress"
    }:
        fail("runner proxy network attachment is not exact")
    if set(containers["verifier_proxy"]["NetworkSettings"]["Networks"]) != {
        "aiq-candidate-verifier-internal", "aiq-candidate-verifier-proxy-egress"
    }:
        fail("verifier proxy network attachment is not exact")
    if containers["runner_proxy"]["NetworkSettings"]["Networks"]["aiq-candidate-runner-internal"]["IPAddress"] != "10.248.34.2":
        fail("runner proxy internal address is not exact")
    if containers["verifier_proxy"]["NetworkSettings"]["Networks"]["aiq-candidate-verifier-internal"]["IPAddress"] != "10.248.36.2":
        fail("verifier proxy internal address is not exact")
    if containers["runner_proxy"]["Mounts"] or containers["verifier_proxy"]["Mounts"]:
        fail("a proxy exposes an unexpected mount")
    runner_expected = {
        "/inputs/core-tasks": (paths["read_only.core_tasks"], False),
        "/inputs/contrast-tasks": (paths["read_only.contrast_tasks"], False),
        "/inputs/candidate-source": (paths["read_only.candidate_source"], False),
        "/inputs/core-workspaces": (paths["read_only.core_workspaces"], False),
        "/inputs/contrast-workspaces": (paths["read_only.contrast_workspaces"], False),
        "/inputs/evaluators": (paths["read_only.evaluators"], False),
        "/inputs/evaluator-runtime": (paths["read_only.evaluator_runtime"], False),
        "/inputs/toolchain": (paths["read_only.toolchain"], False),
        "/inputs/capabilities.json": (paths["read_only.capabilities"], False),
        "/inputs/schedule.json": (paths["read_only.schedule"], False),
        "/inputs/signed-admission.json": (paths["read_only.signed_admission"], False),
        "/inputs/corpus-manifest.json": (paths["read_only.corpus_manifest"], False),
        "/inputs/core-commitment.json": (paths["read_only.core_commitment"], False),
        "/inputs/contrast-commitment.json": (paths["read_only.contrast_commitment"], False),
        "/inputs/release-trust-policy.json": (paths["read_only.trust_policy"], False),
        "/inputs/plan-inputs.json": (paths["read_only.plan_inputs"], False),
        "/inputs/bin/codex": (paths["read_only.codex_binary"], False),
        "/inputs/bin/aiq-runner": (paths["read_only.runner_binary"], False),
        "/codex-home": (paths["writable.codex_home"], True),
        "/codex-home/auth.json": (paths["protected.codex_auth"], False),
        "/run/secrets/authorization-key": (paths["protected.authorization_key"], False),
        "/run/secrets/runner-key": (paths["protected.runner_key"], False),
        "/run/secrets/trust-policy-pin": (paths["protected.trust_policy_pin"], False),
        "/candidate/execution": (paths["writable.execution"], True),
        "/candidate/work": (paths["writable.work"], True),
        "/candidate/artifacts": (paths["writable.artifacts"], True),
        "/candidate/outputs": (paths["writable.outputs"], True),
        "/control": (paths["writable.control"], True),
        "/candidate/verifier-replay": (paths["writable.verifier_replay"], False),
    }
    verifier_expected = {
        "/inputs/core-tasks": (paths["read_only.core_tasks"], False),
        "/inputs/contrast-tasks": (paths["read_only.contrast_tasks"], False),
        "/inputs/candidate-source": (paths["read_only.candidate_source"], False),
        "/inputs/evaluators": (paths["read_only.evaluators"], False),
        "/inputs/evaluator-runtime": (paths["read_only.evaluator_runtime"], False),
        "/inputs/signed-admission.json": (paths["read_only.signed_admission"], False),
        "/inputs/corpus-manifest.json": (paths["read_only.corpus_manifest"], False),
        "/inputs/core-commitment.json": (paths["read_only.core_commitment"], False),
        "/inputs/contrast-commitment.json": (paths["read_only.contrast_commitment"], False),
        "/inputs/release-trust-policy.json": (paths["read_only.trust_policy"], False),
        "/inputs/bin/aiq-verifier": (paths["read_only.verifier_binary"], False),
        "/run/secrets/verifier-key": (paths["protected.verifier_key"], False),
        "/run/secrets/trust-policy-pin": (paths["protected.verifier_trust_policy_pin"], False),
        "/candidate/artifacts": (paths["writable.artifacts"], False),
        "/candidate/outputs": (paths["writable.outputs"], True),
        "/control": (paths["writable.control"], False),
        "/candidate/verifier-replay": (paths["writable.verifier_replay"], True),
    }
    for role, expected_mounts in (("runner", runner_expected), ("verifier", verifier_expected)):
        if any(item["Type"] != "bind" for item in containers[role]["Mounts"]):
            fail(f"{role} exposes a non-bind mount")
        observed_mounts = {item["Destination"]: (Path(item["Source"]), item["RW"]) for item in containers[role]["Mounts"]}
        if observed_mounts != expected_mounts:
            fail(f"{role} mount policy is not exact")
    verifier_environment = "\n".join(containers["verifier"]["Config"].get("Env") or [])
    if "CODEX_HOME=" in verifier_environment or "AIQ_CANDIDATE_RUNNER_SIGNING_KEY=" in verifier_environment:
        fail("verifier environment exposes runner-only state")
    expected_pin = paths["protected.trust_policy_pin"].read_text().strip()
    if paths["protected.verifier_trust_policy_pin"].read_text().strip() != expected_pin:
        fail("runner and verifier trust-policy pins differ")
    for role in ("runner", "verifier"):
        environment = set(containers[role]["Config"].get("Env") or [])
        if f"AIQ_TRUST_POLICY_DIGEST={expected_pin}" not in environment:
            fail("protected trust-policy pin is absent from an actor")
    runner_canary = exec_actor(state, "runner", "runner-canary", ["/usr/local/bin/aiq-candidate-entrypoint", "canary"])
    handoff(state, "verifier")
    verifier_canary = exec_actor(state, "verifier", "verifier-canary", ["/usr/local/bin/aiq-candidate-verifier-entrypoint", "canary"])
    handoff(state, "runner")
    if "role=runner model_invoked=false" not in runner_canary or "role=verifier model_invoked=false" not in verifier_canary:
        fail("a model-free actor canary result is absent")
    binding = {
        "stage": "up",
        "container_ids": {role: value["Id"] for role, value in containers.items()},
        "image_ids": {role: value["Image"] for role, value in containers.items()},
        "network_ids": {
            f"{role}:{name}": network["NetworkID"]
            for role, value in containers.items()
            for name, network in value["NetworkSettings"]["Networks"].items()
        },
        "model_invoked": False,
    }
    write_replace(state / "validation.json", canonical_bytes(binding) + b"\n")
    public_event(state, "validate", "passed")


def deployment_receipt(config: Path, state_arg: Path) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    require_stage(state, "up")
    configured(config, state, trust=True)
    validation = json.loads((state / "validation.json").read_text())
    current_ids = {role: live_container(state, role)["Id"] for role in ("runner", "runner_proxy", "verifier", "verifier_proxy")}
    current_images = {role: live_container(state, role)["Image"] for role in ("runner", "runner_proxy", "verifier", "verifier_proxy")}
    current_networks = {
        f"{role}:{name}": network["NetworkID"]
        for role in ("runner", "runner_proxy", "verifier", "verifier_proxy")
        for name, network in live_container(state, role)["NetworkSettings"]["Networks"].items()
    }
    if validation != {"stage": "up", "container_ids": current_ids, "image_ids": current_images, "network_ids": current_networks, "model_invoked": False}:
        fail("validation evidence is absent or stale")
    receipt = {"schema_version": "aiq.candidate-runtime-deployment-receipt.v1", "source_commit": actor_state(state)["source_commit"], "roles": ["runner", "runner_proxy", "verifier", "verifier_proxy"], "network_topology": ["runner_internal", "runner_proxy_egress", "verifier_internal", "verifier_proxy_egress"], "model_invoked": False}
    target = state / "receipts" / "deployment.json"
    payload = canonical_bytes(receipt) + b"\n"
    if target.exists():
        if target.read_bytes() != payload:
            fail("deployment receipt conflicts with current validation")
    else:
        write_new(target, payload)
    public_event(state, "receipt", "passed")


def down(state_arg: Path) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    actor_state(state)
    if compose(state, "down", "--remove-orphans", "--timeout", "10", capture=True).returncode != 0:
        fail("candidate runtime could not stop")
    remaining = compose(state, "ps", "--all", "--quiet", capture=True)
    if remaining.returncode != 0 or remaining.stdout.strip():
        fail("candidate runtime resources remain after down")
    public_event(state, "down", "passed")


def exec_actor(state: Path, actor: str, label: str, arguments: list[str]) -> str:
    runtime = actor_state(state)
    if runtime["actor"] != actor:
        fail(f"{actor} is not the active shared-root actor")
    return run_private(state, label, ["docker", "compose", "--project-name", PROJECT, "--env-file", str(state / "compose.env"), "--file", str(COMPOSE), "exec", "--no-TTY", actor, *arguments])


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def configured(config: Path, state: Path, trust: bool = False) -> dict[str, Path]:
    runtime = actor_state(state)
    env, paths, commit, bindings = load_config(
        config,
        shared_owner=ACTORS[str(runtime["actor"])],
    )
    validate_state_separation(state, paths)
    if trust:
        verify_admission(paths)
    recorded = json.loads((state / "content-bindings.json").read_text())
    expected = {"schema_version": "aiq.candidate-runtime-content-bindings.v1", "source_commit": commit, "inputs": bindings}
    if recorded != expected:
        fail("frozen operator inputs changed after create")
    if (state / "compose.env").read_bytes() != env_payload(env):
        fail("private Compose environment changed or does not match config")
    return paths


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_utc(value: object, label: str) -> datetime:
    if not isinstance(value, str) or not CANONICAL_TIMESTAMP.fullmatch(value):
        fail(f"{label} must be a canonical millisecond UTC timestamp")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        fail(f"{label} is not a valid UTC timestamp")
    if parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
        fail(f"{label} is not canonical")
    return parsed


def repeat_partition(paths: dict[str, Path], index: int, observed: str | None = None) -> tuple[str, str]:
    if index not in (1, 2, 3):
        fail("repeat index must be 1, 2, or 3")
    admission = json.loads(paths["read_only.signed_admission"].read_text())
    schedule = admission.get("repeat_schedule")
    if not isinstance(schedule, list) or len(schedule) != 3:
        fail("trusted admission does not contain exactly three repeats")
    repeat_ids: list[str] = []
    boundaries: list[datetime] = []
    for position, repeat in enumerate(schedule, 1):
        if not isinstance(repeat, dict) or not isinstance(repeat.get("repeat_id"), str):
            fail("trusted admission repeat schedule is invalid")
        repeat_ids.append(repeat["repeat_id"])
        boundaries.append(parse_utc(repeat.get("scheduled_at"), f"repeat {position} scheduled_at"))
    if len(set(repeat_ids)) != 3 or boundaries != sorted(boundaries) or len(set(boundaries)) != 3:
        fail("trusted admission repeat partitions are not distinct and ordered")
    end = parse_utc(admission.get("collection_not_after"), "collection_not_after")
    if end <= boundaries[-1]:
        fail("trusted admission final repeat partition is empty")
    current = observed or utc_now()
    instant = parse_utc(current, "trusted host observation time")
    upper = boundaries[index] if index < 3 else end
    if instant < boundaries[index - 1] or instant >= upper:
        fail("current trusted host time is outside the exact signed repeat partition")
    return repeat_ids[index - 1], current


def write_expectations(paths: dict[str, Path], index: int | None, name: str, owner: int) -> Path:
    control = paths["writable.control"]
    authorization_bytes = (control / "authorization.json").read_bytes().rstrip(b"\n")
    authorization = json.loads(authorization_bytes)
    plan = authorization["plan"]
    if index is None:
        observed = utc_now()
    else:
        repeat_id, _ = plan_units(control, index)
        scheduled_repeat_id, observed = repeat_partition(paths, index)
        if repeat_id != scheduled_repeat_id:
            fail("signed plan repeat does not match its admission partition")
    expectations = {
        "authorization_path": "/control/authorization.json", "authorization_sha256": sha(authorization_bytes),
        "authorization_signer_node_id": authorization["signer"]["node_id"],
        "authorization_signer_public_key": authorization["signer"]["public_key"],
        "signed_admission_path": "/inputs/signed-admission.json", "signed_admission_sha256": plan["signed_admission_sha256"],
        "signed_admission_key_id": plan["signed_admission_key_id"],
        "release_trust_policy_path": "/inputs/release-trust-policy.json",
        "release_trust_policy_sha256": plan["release_trust_policy_sha256"],
        "execution_plan_sha256": plan["execution_plan_digest"],
        "corpus_manifest_path": "/inputs/corpus-manifest.json", "corpus_manifest_sha256": plan["corpus_manifest_sha256"],
        "core_corpus_commitment_path": "/inputs/core-commitment.json", "core_corpus_commitment_sha256": plan["core_corpus_commitment_sha256"],
        "contrast_corpus_commitment_path": "/inputs/contrast-commitment.json", "contrast_corpus_commitment_sha256": plan["contrast_corpus_commitment_sha256"],
        "verifier_replay_root": "/candidate/verifier-replay", "observed_at": observed,
    }
    target = control / name
    write_replace(target, canonical_bytes(expectations) + b"\n")
    os.chown(target, owner, owner)
    descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(target.parent)
    return target


def prepare(config: Path, state_arg: Path) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    require_stage(state, "up")
    paths = configured(config, state, trust=True)
    exec_actor(state, "runner", "candidate-plan", ["/usr/local/bin/aiq-candidate-entrypoint", "plan"])
    exec_actor(state, "runner", "candidate-authorize", ["/usr/local/bin/aiq-candidate-entrypoint", "authorize"])
    validate_plan_partitions(paths)
    write_expectations(paths, None, "expectations-preparation.json", RUNNER_UID)
    exec_actor(state, "runner", "validate-core-corpus", ["/usr/local/bin/aiq-candidate-entrypoint", "validate-core"])
    exec_actor(state, "runner", "validate-contrast-corpus", ["/usr/local/bin/aiq-candidate-entrypoint", "validate-contrast"])
    validate_shared_actor(state, RUNNER_UID)
    advance_stage(state, "up", "prepared")
    public_event(state, "prepare", "passed")


def plan_units(control: Path, index: int) -> tuple[str, list[str]]:
    if index not in (1, 2, 3):
        fail("repeat index must be 1, 2, or 3")
    authorization = json.loads((control / "authorization.json").read_text())
    all_units = authorization.get("plan", {}).get("execution_units")
    if not isinstance(all_units, list):
        fail("signed plan execution units are invalid")
    expected = [f"repeat-{index:02}-core"] + [
        f"repeat-{index:02}-contrast-{contrast:02}-{arm}"
        for contrast in range(1, 4) for arm in ("reference", "challenge")
    ]
    by_id = {unit.get("unit_id"): unit for unit in all_units if isinstance(unit, dict)}
    if len(by_id) != len(all_units) or any(unit_id not in by_id for unit_id in expected):
        fail("signed plan does not contain the fixed seven-unit repeat")
    repeat_ids = {by_id[unit_id].get("repeat_id") for unit_id in expected}
    if len(repeat_ids) != 1 or not all(isinstance(value, str) for value in repeat_ids):
        fail("signed plan repeat IDs are inconsistent")
    return str(next(iter(repeat_ids))), expected


def validate_plan_partitions(paths: dict[str, Path]) -> None:
    control = paths["writable.control"]
    admission = json.loads(paths["read_only.signed_admission"].read_text())
    schedule = admission.get("repeat_schedule")
    if not isinstance(schedule, list) or len(schedule) != 3:
        fail("trusted admission does not contain exactly three repeats")
    observed_units: list[str] = []
    for index, repeat in enumerate(schedule, 1):
        repeat_id, units = plan_units(control, index)
        if not isinstance(repeat, dict) or repeat_id != repeat.get("repeat_id"):
            fail("signed plan repeat ordering does not match the admission")
        observed_units.extend(units)
    authorization = json.loads((control / "authorization.json").read_text())
    all_units = authorization["plan"]["execution_units"]
    if len(all_units) != 21 or {unit.get("unit_id") for unit in all_units} != set(observed_units):
        fail("signed plan is not the exact fixed 21-unit plan")


def reservation_mode(control: Path, outputs: Path, index: int) -> str:
    if index != 1:
        return "resume-exact-plan"
    plan = json.loads((control / "authorization.json").read_text())["plan"]
    planned = [value for unit in plan["execution_units"] for value in unit["outputs"].values()]
    planned.extend(plan["aggregate_outputs"].values())
    prefix = "/candidate/outputs/"
    if len(planned) != 86 or any(not isinstance(value, str) or not value.startswith(prefix) for value in planned):
        fail("signed plan does not define the exact 86 output reservations")
    host = [outputs / value.removeprefix(prefix) for value in planned]
    present = [path.exists() for path in host]
    if all(present):
        return "resume-exact-plan"
    if any(present):
        fail("output reservation set is partial; exact resume is unsafe")
    return "fresh"


def run_repeat(config: Path, state_arg: Path, index: int) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    expected = "prepared" if index == 1 else f"repeat-{index - 1:02}-finalized"
    require_stage(state, expected)
    paths = configured(config, state, trust=True)
    repeat_id, _ = plan_units(paths["writable.control"], index)
    name = f"expectations-repeat-{index:02}-run.json"
    write_expectations(paths, index, name, RUNNER_UID)
    mode = reservation_mode(paths["writable.control"], paths["writable.outputs"], index)
    exec_actor(state, "runner", f"run-repeat-{index:02}", ["/usr/local/bin/aiq-candidate-entrypoint", "run-repeat", f"/control/{name}", repeat_id, mode])
    validate_shared_actor(state, RUNNER_UID)
    handoff(state, "verifier", expected, f"repeat-{index:02}-ran")


def verify_repeat(config: Path, state_arg: Path, index: int) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    expected = f"repeat-{index:02}-ran"
    require_stage(state, expected)
    paths = configured(config, state, trust=True)
    _, units = plan_units(paths["writable.control"], index)
    name = f"expectations-repeat-{index:02}-verify.json"
    write_expectations(paths, index, name, VERIFIER_UID)
    for unit in units:
        exec_actor(state, "verifier", f"verify-{unit}", ["/usr/local/bin/aiq-candidate-verifier-entrypoint", "verify-unit", unit, f"/control/{name}"])
    validate_shared_actor(state, VERIFIER_UID)
    handoff(state, "runner", expected, f"repeat-{index:02}-verified")


def finalize_repeat(config: Path, state_arg: Path, index: int) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    expected = f"repeat-{index:02}-verified"
    require_stage(state, expected)
    paths = configured(config, state, trust=True)
    repeat_id, _ = plan_units(paths["writable.control"], index)
    name = f"expectations-repeat-{index:02}-finalize.json"
    write_expectations(paths, index, name, RUNNER_UID)
    exec_actor(state, "runner", f"finalize-repeat-{index:02}", ["/usr/local/bin/aiq-candidate-entrypoint", "finalize-repeat", f"/control/{name}", repeat_id])
    validate_shared_actor(state, RUNNER_UID)
    advance_stage(state, expected, f"repeat-{index:02}-finalized")


def release_command(paths: dict[str, Path], arguments: list[str], key_name: str | None = None) -> tuple[list[str], dict[str, str]]:
    command = ["node", "--experimental-strip-types", str(paths["read_only.repository_source"] / "scripts/candidates/aiq-core-1.0.2/candidate-release.ts"), *arguments]
    environment: dict[str, str] = {}
    environment["AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256"] = paths["protected.trust_policy_pin"].read_text().strip()
    if key_name is not None:
        environment["AIQ_CANDIDATE_RELEASE_KEY"] = paths[f"protected.{key_name}"].read_text()
    return command, environment


def aggregate(config: Path, state_arg: Path, authority_key_id: str) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    require_stage(state, "repeat-03-finalized")
    paths = configured(config, state, trust=True)
    write_expectations(paths, 3, "expectations-aggregate.json", RUNNER_UID)
    expectations = "/control/expectations-aggregate.json"
    exec_actor(state, "runner", "derive-aggregate-source", ["/usr/local/bin/aiq-candidate-entrypoint", "derive-source", expectations])
    exec_actor(state, "runner", "release-authority-input", ["/usr/local/bin/aiq-candidate-entrypoint", "authority-input", expectations, authority_key_id])
    control = paths["writable.control"]
    command, environment = release_command(paths, [
        "sign-authority", "--input", str(control / "release-authority-input.json"),
        "--trust-policy", str(paths["read_only.trust_policy"]), "--key-env", "AIQ_CANDIDATE_RELEASE_KEY",
        "--output", str(control / "release-authority.json"),
    ], "authority_key")
    run_private(state, "sign-release-authority", command, environment)
    seal_shared_file(control / "release-authority.json", RUNNER_UID)
    exec_actor(state, "runner", "aggregate-expectations", ["/usr/local/bin/aiq-candidate-entrypoint", "aggregate-expectations", expectations])
    exec_actor(state, "runner", "candidate-aggregate", ["/usr/local/bin/aiq-candidate-entrypoint", "aggregate"])
    evidence = paths["writable.outputs"] / "aggregate-release-gate-evidence.json"
    result = control / "release-gate-result.json"
    command, environment = release_command(paths, [
        "evaluate", "--authority", str(control / "release-authority.json"), "--evidence", str(evidence),
        "--trust-policy", str(paths["read_only.trust_policy"]), "--output", str(result),
    ])
    run_private(state, "evaluate-release-gate", command, environment)
    seal_shared_file(result, RUNNER_UID)
    validate_shared_actor(state, RUNNER_UID)
    advance_stage(state, "repeat-03-finalized", "aggregated")


def promote(config: Path, state_arg: Path, promotion_key_id: str, issued_at: str) -> None:
    validate_docker_host()
    state = state_path(state_arg, False)
    require_stage(state, "aggregated")
    paths = configured(config, state, trust=True)
    control = paths["writable.control"]
    evidence = paths["writable.outputs"] / "aggregate-release-gate-evidence.json"
    common = ["--authority", str(control / "release-authority.json"), "--evidence", str(evidence), "--trust-policy", str(paths["read_only.trust_policy"])]
    command, environment = release_command(paths, ["issue-receipt", *common, "--key-env", "AIQ_CANDIDATE_RELEASE_KEY", "--key-id", promotion_key_id, "--issued-at", issued_at, "--output", str(control / "promotion-receipt.json")], "promotion_key")
    run_private(state, "issue-promotion-receipt", command, environment)
    seal_shared_file(control / "promotion-receipt.json", RUNNER_UID)
    command, environment = release_command(paths, ["release-manifest", *common, "--receipt", str(control / "promotion-receipt.json"), "--output", str(control / "released-manifest.json")])
    run_private(state, "create-released-manifest", command, environment)
    seal_shared_file(control / "released-manifest.json", RUNNER_UID)
    command, environment = release_command(paths, ["verify-manifest", *common, "--receipt", str(control / "promotion-receipt.json"), "--manifest", str(control / "released-manifest.json")])
    run_private(state, "verify-released-manifest", command, environment)
    validate_shared_actor(state, RUNNER_UID)
    advance_stage(state, "aggregated", "promoted")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("create", "validate", "receipt", "prepare", "run-repeat", "verify-repeat", "finalize-repeat"):
        item = sub.add_parser(name); item.add_argument("--config", required=True, type=Path); item.add_argument("--state", required=True, type=Path)
        if "repeat" in name: item.add_argument("--repeat", required=True, type=int, choices=(1, 2, 3))
    for name in ("up", "down"):
        item = sub.add_parser(name); item.add_argument("--state", required=True, type=Path)
    item = sub.add_parser("handoff"); item.add_argument("--state", required=True, type=Path); item.add_argument("--to", required=True, choices=("runner", "verifier"))
    item = sub.add_parser("aggregate"); item.add_argument("--config", required=True, type=Path); item.add_argument("--state", required=True, type=Path); item.add_argument("--authority-key-id", required=True)
    item = sub.add_parser("promote"); item.add_argument("--config", required=True, type=Path); item.add_argument("--state", required=True, type=Path); item.add_argument("--promotion-key-id", required=True); item.add_argument("--issued-at", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "create": create(args.config, args.state)
    elif args.command == "up": up(args.state)
    elif args.command == "validate": validate_runtime(args.config, args.state)
    elif args.command == "receipt": deployment_receipt(args.config, args.state)
    elif args.command == "down": down(args.state)
    elif args.command == "prepare": prepare(args.config, args.state)
    elif args.command == "run-repeat": run_repeat(args.config, args.state, args.repeat)
    elif args.command == "verify-repeat": verify_repeat(args.config, args.state, args.repeat)
    elif args.command == "finalize-repeat": finalize_repeat(args.config, args.state, args.repeat)
    elif args.command == "handoff": handoff(state_path(args.state, False), args.to)
    elif args.command == "aggregate": aggregate(args.config, args.state, args.authority_key_id)
    elif args.command == "promote": promote(args.config, args.state, args.promotion_key_id, args.issued_at)


if __name__ == "__main__":
    main()
