#!/usr/bin/env python3
"""Manage the bounded local Linux arm64 Official runner stack."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tomllib
from typing import Never

ROOT = Path(__file__).resolve().parent
COMPOSE = ROOT / "compose.yaml"
PROJECT = "aiq-official-runtime"
RUNNER = "aiq-official-runner"
PROXY = "aiq-official-proxy"
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
    "codex_auth": ("AIQ_CODEX_AUTH", "private_file"),
}

WRITABLE = {
    "codex_home": "AIQ_CODEX_HOME",
    "execution": "AIQ_EXECUTION",
    "artifacts": "AIQ_ARTIFACTS",
    "checkpoints": "AIQ_CHECKPOINTS",
    "preflight": "AIQ_PREFLIGHT",
    "admission": "AIQ_ADMISSION",
    "results": "AIQ_RESULTS",
}

MOUNTS = {
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
    "AIQ_EXECUTION": ("/execution", False),
    "AIQ_ARTIFACTS": ("/output/artifacts", False),
    "AIQ_CHECKPOINTS": ("/output/checkpoints", False),
    "AIQ_PREFLIGHT": ("/output/preflight", False),
    "AIQ_ADMISSION": ("/output/admission", False),
    "AIQ_RESULTS": ("/output/results", False),
}


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
    if unsafe_write_bits(path):
        fail(f"{label} must not be writable by group or other")
    if kind == "executable" and not os.access(path, os.X_OK):
        fail(f"{label} must be executable")
    if kind == "private_file":
        mode = stat.S_IMODE(path.stat().st_mode)
        if path.stat().st_uid != os.getuid() or mode & 0o077:
            fail(f"{label} must be owned by this user with mode 0600 or stricter")


def validate_writable(path: Path, label: str) -> None:
    info = path.stat()
    if not path.is_dir() or info.st_uid != os.getuid():
        fail(f"{label} must be a directory owned by this user")
    if stat.S_IMODE(info.st_mode) != 0o700:
        fail(f"{label} must have mode 0700")
    if not os.access(path, os.R_OK | os.W_OK | os.X_OK):
        fail(f"{label} is not readable, writable, and searchable")


def validate_no_overlap(paths: dict[str, Path]) -> None:
    items = list(paths.items())
    for index, (left_name, left) in enumerate(items):
        for right_name, right in items[index + 1 :]:
            common = Path(os.path.commonpath((left, right)))
            if common == left or common == right:
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


def validated_config(config_path: Path) -> tuple[dict[str, str], str]:
    config = load_config(config_path)
    read_only = config.get("read_only")
    writable = config.get("writable")
    if not isinstance(read_only, dict) or not isinstance(writable, dict):
        fail("config needs [read_only] and [writable] tables")

    env: dict[str, str] = {}
    paths: dict[str, Path] = {}
    for name, (variable, kind) in READ_ONLY.items():
        path = declared_path(read_only.get(name), f"read_only.{name}")
        validate_kind(path, kind, f"read_only.{name}")
        paths[f"read_only.{name}"] = path
        env[variable] = str(path)
    for name, variable in WRITABLE.items():
        path = declared_path(writable.get(name), f"writable.{name}")
        validate_writable(path, f"writable.{name}")
        paths[f"writable.{name}"] = path
        env[variable] = str(path)

    validate_no_overlap(paths)
    commit = validate_source(paths["read_only.source"], config.get("source_commit"))
    env["AIQ_SOURCE_COMMIT"] = commit
    return env, commit


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
    validate_writable(state, "state")
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


def assert_mount_policy(runner: dict[str, object], env: dict[str, str]) -> None:
    expected = {
        destination: {"source": env[variable], "read_only": read_only}
        for variable, (destination, read_only) in MOUNTS.items()
    }
    actual: dict[str, dict[str, object]] = {}
    for mount in runner["Mounts"]:
        if mount["Type"] != "bind":
            continue
        actual[mount["Destination"]] = {
            "source": mount["Source"],
            "read_only": not mount["RW"],
        }
    if actual != expected:
        fail("live runner bind mounts do not match the supplied operator config")


def assert_runtime(env: dict[str, str]) -> tuple[dict[str, object], dict[str, object]]:
    runner = inspect(RUNNER)
    proxy = inspect(PROXY)
    runner_host = runner["HostConfig"]
    proxy_host = proxy["HostConfig"]
    for name, host in ((RUNNER, runner_host), (PROXY, proxy_host)):
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
    if runner["Config"]["User"] != "10001:10001":
        fail("runner does not use uid/gid 10001:10001")
    if proxy["Config"]["User"] != "10002:10002":
        fail("proxy does not use uid/gid 10002:10002")
    if proxy["Mounts"]:
        fail("proxy has an unexpected mount")
    security_options = runner_host["SecurityOpt"]
    security = " ".join(security_options)
    profile_options = [option for option in security_options if option.startswith("seccomp=")]
    if "unconfined" in security or len(profile_options) != 1:
        fail("runner custom seccomp policy is not active")
    if json.loads(profile_options[0].removeprefix("seccomp=")) != json.loads(SECCOMP.read_text()):
        fail("active runner seccomp policy does not match the reviewed profile")
    if runner["NetworkSettings"]["Networks"].keys() != {"aiq-official-runner-internal"}:
        fail("runner must attach only to its internal network")
    proxy_networks = set(proxy["NetworkSettings"]["Networks"].keys())
    if proxy_networks != {"aiq-official-runner-internal", "aiq-official-proxy-egress"}:
        fail("proxy network topology is not exact")
    endpoint = proxy["NetworkSettings"]["Networks"]["aiq-official-runner-internal"]["IPAddress"]
    if endpoint != "172.30.0.2":
        fail("proxy internal endpoint is not 172.30.0.2")
    assert_mount_policy(runner, env)
    return runner, proxy


def assert_image_commit(runner: dict[str, object], proxy: dict[str, object], commit: str) -> None:
    for name, container in ((RUNNER, runner), (PROXY, proxy)):
        labels = container["Config"].get("Labels") or {}
        if labels.get("org.opencontainers.image.revision") != commit:
            fail(f"{name} image is not bound to the configured source commit")


def requirements_binding() -> dict[str, str]:
    ownership_mode = run(
        "docker",
        "exec",
        RUNNER,
        "stat",
        "-c",
        "%u:%g:%a",
        "/etc/codex/requirements.toml",
        capture=True,
    )
    container_digest = run(
        "docker",
        "exec",
        RUNNER,
        "sha256sum",
        "/etc/codex/requirements.toml",
        capture=True,
    ).split()[0]
    expected = sha256(REQUIREMENTS)
    if f"sha256:{container_digest}" != expected or ownership_mode != "0:0:444":
        fail("container requirements readback does not match the baked contract")
    return {"digest": expected, "ownership_mode": ownership_mode}


def runtime_binding(
    env_file: Path,
    commit: str,
    runner: dict[str, object],
    proxy: dict[str, object],
) -> dict[str, object]:
    runner_network = runner["NetworkSettings"]["Networks"]["aiq-official-runner-internal"]
    proxy_networks = proxy["NetworkSettings"]["Networks"]
    return {
        "source_commit": commit,
        "compose_env_digest": sha256(env_file),
        "containers": {"runner": runner["Id"], "proxy": proxy["Id"]},
        "images": {"runner": runner["Image"], "proxy": proxy["Image"]},
        "requirements": requirements_binding(),
        "seccomp_digest": sha256(SECCOMP),
        "networks": {
            "runner_internal": runner_network["NetworkID"],
            "proxy_internal": proxy_networks["aiq-official-runner-internal"]["NetworkID"],
            "proxy_egress": proxy_networks["aiq-official-proxy-egress"]["NetworkID"],
        },
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


def create(config: Path, state: Path) -> None:
    env, _ = validated_config(config)
    validate_docker_host()
    env_file = prepare_state(state, create=True)
    validate_state_separation(state, env)
    write_env(env_file, env)
    args = compose_args(env_file)
    run(*args, "config", "--quiet")
    run(*args, "build", "--pull")
    run(*args, "create", "--force-recreate")


def up(state: Path) -> None:
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    env = require_env_file(env_file)
    validate_state_separation(state, env)
    run(*compose_args(env_file), "up", "--detach", "--no-build")


def validate(config: Path, state: Path) -> None:
    env, commit = validated_config(config)
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    require_env_file(env_file, env)
    validate_state_separation(state, env)
    runner, proxy = assert_runtime(env)
    assert_image_commit(runner, proxy, commit)
    output = run(
        *compose_args(env_file),
        "exec",
        "--no-TTY",
        "runner",
        "/usr/local/bin/aiq-runtime-canary",
        capture=True,
    )
    if "model_invoked=false" not in output:
        fail("model-free canary result is absent")
    evidence = {
        "schema_version": "aiq.official-runtime-validation.v1",
        "binding": runtime_binding(env_file, commit, runner, proxy),
        "canary": output,
        "model_invoked": False,
    }
    atomic_write_private(
        state / "validation.json",
        (json.dumps(evidence, sort_keys=True) + "\n").encode(),
    )
    print(output)


def receipt(config: Path, state: Path) -> None:
    env, commit = validated_config(config)
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    require_env_file(env_file, env)
    validate_state_separation(state, env)
    runner, proxy = assert_runtime(env)
    assert_image_commit(runner, proxy, commit)
    evidence = read_private_json(state / "validation.json")
    current_binding = runtime_binding(env_file, commit, runner, proxy)
    require_current_evidence(evidence, current_binding)
    docker_version = json.loads(
        run("docker", "version", "--format", "{{json .Server}}", capture=True)
    )
    mounts = [
        {"destination": mount["Destination"], "mode": "rw" if mount["RW"] else "ro"}
        for mount in runner["Mounts"]
        if mount["Type"] == "bind"
    ]
    payload = {
        "schema_version": "aiq.official-runtime-deployment-receipt.v1",
        "source_commit": commit,
        "platform": {"os": docker_version["Os"], "architecture": docker_version["Arch"]},
        "docker": {"version": docker_version["Version"], "security_options": ["seccomp"]},
        "images": {
            "runner": runner["Image"],
            "proxy": proxy["Image"],
        },
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
            "proxy": ["aiq-official-runner-internal", "aiq-official-proxy-egress"],
            "proxy_endpoint": "172.30.0.2:3128",
            "host_ports": [],
        },
        "mount_policy": sorted(mounts, key=lambda item: item["destination"]),
        "model_invoked": False,
    }
    destination = state / "deployment-receipt.json"
    atomic_write_private(
        destination,
        (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode(),
    )
    print(destination)


def down(state: Path) -> None:
    validate_docker_host()
    env_file = prepare_state(state, create=False)
    env = require_env_file(env_file)
    validate_state_separation(state, env)
    run(*compose_args(env_file), "down", "--remove-orphans", "--timeout", "10")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "up", "validate", "receipt", "down"))
    parser.add_argument("--config", type=Path)
    parser.add_argument("--state", required=True, type=Path)
    args = parser.parse_args()
    if args.command in {"create", "validate", "receipt"} and args.config is None:
        parser.error(f"{args.command} requires --config")
    if args.command == "create":
        create(args.config, args.state)
    elif args.command == "up":
        up(args.state)
    elif args.command == "validate":
        validate(args.config, args.state)
    elif args.command == "receipt":
        receipt(args.config, args.state)
    else:
        down(args.state)


if __name__ == "__main__":
    main()
