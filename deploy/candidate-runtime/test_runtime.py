#!/usr/bin/env python3
"""Model-free tests for the candidate runtime boundary."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("candidate_runtime", ROOT / "runtime.py")
assert spec is not None and spec.loader is not None
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
builder_spec = importlib.util.spec_from_file_location("candidate_binary_builder", ROOT / "binary_builder.py")
assert builder_spec is not None and builder_spec.loader is not None
binary_builder = importlib.util.module_from_spec(builder_spec)
builder_spec.loader.exec_module(binary_builder)


def linux_arm64_elf(
    *,
    elf_type: int = 3,
    machine: int = 183,
    interpreter: bytes = b"/lib/ld-linux-aarch64.so.1\0",
    program_type: int = 3,
) -> bytes:
    header = struct.pack(
        "<16sHHIQQQIHHHHHH",
        b"\x7fELF\x02\x01\x01\x00" + b"\x00" * 8,
        elf_type,
        machine,
        1,
        0x1000,
        64,
        0,
        0,
        64,
        56,
        1,
        0,
        0,
        0,
    )
    program_header = struct.pack(
        "<IIQQQQQQ",
        program_type,
        4,
        120,
        0,
        0,
        len(interpreter),
        len(interpreter),
        1,
    )
    return header + program_header + interpreter


def write_test_binary(
    path: Path,
    *,
    elf_type: int = 3,
    machine: int = 183,
    interpreter: bytes | None = None,
    program_type: int = 3,
) -> None:
    arguments = {"elf_type": elf_type, "machine": machine, "program_type": program_type}
    if interpreter is not None:
        arguments["interpreter"] = interpreter
    path.write_bytes(linux_arm64_elf(**arguments))
    path.chmod(0o755)


class CandidateRuntimeTests(unittest.TestCase):
    def test_child_environment_drops_ambient_credentials(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"AWS_SECRET_ACCESS_KEY": "secret", "AIQ_DATABASE_URL": "secret", "HOME": "/operator"},
            clear=False,
        ):
            environment = runtime.child_env({"ONE_REQUIRED_VALUE": "value"})
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", environment)
        self.assertNotIn("AIQ_DATABASE_URL", environment)
        self.assertEqual(environment["ONE_REQUIRED_VALUE"], "value")
        self.assertEqual(environment["HOME"], "/operator")

    def test_candidate_manager_is_executable_and_entrypoints_set_private_umask(self) -> None:
        self.assertNotEqual((ROOT / "runtime.py").stat().st_mode & 0o111, 0)
        for name in ("runner-entrypoint.sh", "verifier-entrypoint.sh"):
            lines = (ROOT / name).read_text().splitlines()
            self.assertEqual(lines[2], "umask 077")

    def test_darwin_codex_auth_requires_owner_immutable_flag(self) -> None:
        immutable = getattr(runtime.stat, "UF_IMMUTABLE", 2)
        path = Path("/protected/auth.json")
        with (
            mock.patch.object(runtime.sys, "platform", "darwin"),
            mock.patch.object(Path, "stat", return_value=mock.Mock(st_flags=0)),
            self.assertRaisesRegex(SystemExit, "owner-immutable"),
        ):
            runtime.require_darwin_immutable(path, "protected.codex_auth")
        with (
            mock.patch.object(runtime.sys, "platform", "darwin"),
            mock.patch.object(Path, "stat", return_value=mock.Mock(st_flags=immutable)),
        ):
            runtime.require_darwin_immutable(path, "protected.codex_auth")

    def test_compose_environment_is_equals_safe_and_rejects_newlines(self) -> None:
        payload = runtime.env_payload({"AIQ_VALUE": "left=right # literal"})
        self.assertEqual(payload, b'AIQ_VALUE="left=right # literal"\n')
        with self.assertRaises(SystemExit):
            runtime.env_payload({"AIQ_VALUE": "unsafe\nvalue"})

    def test_invalid_admission_does_not_touch_other_operator_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            admission = root / "admission.json"
            policy = root / "policy.json"
            runner_pin = root / "runner-pin"
            verifier_pin = root / "verifier-pin"
            admission.write_text("{}")
            policy.write_text("{}")
            digest = f"sha256:{hashlib.sha256(b'{}').hexdigest()}\n"
            runner_pin.write_text(digest)
            verifier_pin.write_text(digest)
            admission.chmod(0o444)
            policy.chmod(0o444)
            runner_pin.chmod(0o600)
            verifier_pin.chmod(0o600)
            missing = "/definitely-absent-aiq-candidate-input"
            config = root / "operator.toml"
            config.write_text(
                f'''source_commit = "{'a' * 40}"

[read_only]
repository_source = "{missing}/repository"
core_tasks = "{missing}/core"
contrast_tasks = "{missing}/contrast"
candidate_source = "{missing}/source"
core_workspaces = "{missing}/core-workspaces"
contrast_workspaces = "{missing}/contrast-workspaces"
evaluators = "{missing}/evaluators"
evaluator_runtime = "{missing}/evaluator-runtime"
toolchain = "{missing}/toolchain"
capabilities = "{missing}/capabilities.json"
schedule = "{missing}/schedule.json"
signed_admission = "{admission}"
corpus_manifest = "{missing}/corpus-manifest.json"
core_commitment = "{missing}/core-commitment.json"
contrast_commitment = "{missing}/contrast-commitment.json"
trust_policy = "{policy}"
plan_inputs = "{missing}/plan-inputs.json"
codex_binary = "{missing}/codex"
runner_binary = "{missing}/aiq-runner"
verifier_binary = "{missing}/aiq-verifier"

[protected]
codex_auth = "{missing}/auth.json"
authorization_key = "{missing}/authorization-key"
runner_key = "{missing}/runner-key"
verifier_key = "{missing}/verifier-key"
trust_policy_pin = "{runner_pin}"
verifier_trust_policy_pin = "{verifier_pin}"
authority_key = "{missing}/authority-key"
promotion_key = "{missing}/promotion-key"

[writable]
codex_home = "{missing}/codex-home"
execution = "{missing}/execution"
work = "{missing}/work"
artifacts = "{missing}/artifacts"
outputs = "{missing}/outputs"
control = "{missing}/control"
verifier_replay = "{missing}/verifier-replay"
logs = "{missing}/logs"
'''
            )
            touched = []
            real_canonical_path = runtime.canonical_path

            def record_path(value, label):
                touched.append(label)
                if label.startswith("read_only.") and label not in {
                    "read_only.signed_admission",
                    "read_only.trust_policy",
                }:
                    raise AssertionError(f"touched protected input before trust: {label}")
                return real_canonical_path(value, label)

            with (
                mock.patch.object(runtime, "canonical_path", side_effect=record_path),
                mock.patch.object(runtime, "private_file"),
                mock.patch.object(runtime, "content_binding") as binding,
            ):
                with self.assertRaisesRegex(SystemExit, "signed admission is not trusted"):
                    runtime.load_config(config)
            self.assertEqual(
                touched,
                [
                    "--config",
                    "read_only.signed_admission",
                    "read_only.trust_policy",
                    "protected.trust_policy_pin",
                    "protected.verifier_trust_policy_pin",
                ],
            )
            binding.assert_not_called()

    def test_durable_create_and_replace_use_private_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "state.json"
            runtime.write_new(target, b"one\n")
            self.assertEqual(target.read_bytes(), b"one\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            runtime.write_replace(target, b"two\n")
            self.assertEqual(target.read_bytes(), b"two\n")
            self.assertFalse(list(root.glob(".*.tmp")))

    def test_replace_rolls_back_if_the_install_directory_sync_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state.json"
            runtime.write_new(target, b"old\n")
            real_sync = runtime.fsync_directory
            calls = 0

            def fail_install_sync(path: Path) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("injected directory sync failure")
                real_sync(path)

            with mock.patch.object(runtime, "fsync_directory", side_effect=fail_install_sync):
                with self.assertRaises(OSError):
                    runtime.write_replace(target, b"new\n")
            self.assertEqual(target.read_bytes(), b"old\n")

    def test_compose_has_separate_users_networks_and_exact_candidate_mounts(self) -> None:
        compose = (ROOT / "compose.yaml").read_text()
        for required in (
            'user: "10001:10001"', 'user: "10003:10003"',
            "/inputs/core-tasks", "/inputs/contrast-tasks", "/inputs/candidate-source",
            "/inputs/core-workspaces", "/inputs/contrast-workspaces", "/candidate/work",
            "/candidate/artifacts", "/candidate/outputs", "/candidate/verifier-replay",
            "/inputs/signed-admission.json", "/inputs/corpus-manifest.json",
            "/inputs/core-commitment.json", "/inputs/contrast-commitment.json",
            "/inputs/release-trust-policy.json", "AIQ_VERIFIER_TRUST_POLICY_PIN",
            "aiq-candidate-runner-internal", "aiq-candidate-verifier-internal",
        ):
            self.assertIn(required, compose)
        verifier = compose.split("  verifier:\n", 1)[1].split("networks:\n", 1)[0]
        self.assertNotIn("/codex-home", verifier)
        self.assertNotIn("/inputs/bin/codex", verifier)
        self.assertIn("read_only: true", verifier.split("/candidate/artifacts", 1)[1].split("}", 1)[0])

    def test_candidate_proxies_allow_only_their_candidate_actor_subnets(self) -> None:
        compose = (ROOT / "compose.yaml").read_text()
        self.assertIn("deploy/candidate-runtime/Dockerfile.proxy", compose)
        self.assertIn("deploy/candidate-runtime/Dockerfile.verifier-proxy", compose)
        runner_allow = [
            line
            for line in (ROOT / "tinyproxy.conf").read_text().splitlines()
            if line.startswith("Allow ")
        ]
        verifier_allow = [
            line
            for line in (ROOT / "tinyproxy-verifier.conf").read_text().splitlines()
            if line.startswith("Allow ")
        ]
        self.assertEqual(runner_allow, ["Allow 10.248.34.0/24"])
        self.assertEqual(verifier_allow, ["Allow 10.248.36.0/24"])
        for name in ("tinyproxy.conf", "tinyproxy-verifier.conf"):
            config = (ROOT / name).read_text()
            self.assertIn("MaxClients 128", config)
            self.assertNotIn("MaxClients 20", config)

    def test_runner_proxy_endpoint_agrees_with_the_rust_contract(self) -> None:
        compose = (ROOT / "compose.yaml").read_text()
        rust = (
            ROOT.parents[1] / "apps" / "aiq-runner" / "src" / "candidate_release_gate.rs"
        ).read_text()
        declaration = 'pub const CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT: &str = "'
        endpoint = rust.split(declaration, 1)[1].split('";', 1)[0]
        runner = compose.split("  runner:\n", 1)[1].split("  verifier_proxy:\n", 1)[0]

        self.assertEqual(endpoint, "http://10.248.34.2:3128")
        self.assertIn(f'HTTPS_PROXY: "{endpoint}"', runner)
        self.assertIn(f'HTTP_PROXY: "{endpoint}"', runner)
        self.assertEqual(runner.count(endpoint), 2)
        self.assertNotIn("172.34", rust)
        self.assertNotIn("172.34", compose)

    def test_create_makes_the_receipts_directory_once(self) -> None:
        source = (ROOT / "runtime.py").read_text()
        create = source.split("def create(", 1)[1].split("def up(", 1)[0]
        self.assertEqual(create.count('(state / "receipts").mkdir(mode=0o700)'), 1)

    def test_runner_canary_proves_proxy_capacity_before_default_deny(self) -> None:
        canary = (ROOT / "canary.sh").read_text()
        capacity = canary.index("probe_proxy_capacity")
        denial = canary.index("assert_proxy_denied")
        self.assertLess(capacity, denial)
        self.assertIn("connections=64", canary)
        self.assertIn("--limit-rate 128", canary)
        self.assertIn("proxy_capacity_checked=%s", canary)

    def test_entrypoints_load_only_role_specific_secret_files(self) -> None:
        runner = (ROOT / "runner-entrypoint.sh").read_text()
        verifier = (ROOT / "verifier-entrypoint.sh").read_text()
        self.assertIn("authorization-key", runner)
        self.assertIn("runner-key", runner)
        self.assertIn("trust-policy-pin", runner)
        self.assertNotIn("verifier-key", runner)
        self.assertIn("verifier-key", verifier)
        self.assertIn("trust-policy-pin", verifier)
        self.assertNotIn("authorization-key", verifier)
        self.assertNotIn("runner-key", verifier)

    def test_linux_arm64_builder_exports_both_pinned_binaries(self) -> None:
        dockerfile = (ROOT / "Dockerfile.binaries").read_text()
        script = (ROOT / "build-binaries.sh").read_text()
        workflow = (ROOT.parent.parent / ".github/workflows/language.yml").read_text()
        self.assertIn(
            "rust:1.97.1-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa",
            dockerfile,
        )
        self.assertIn(
            "cargo build --locked --release --package aiq-runner --package aiq-verifier",
            dockerfile,
        )
        self.assertIn("/aiq-runner", dockerfile)
        self.assertIn("/aiq-verifier", dockerfile)
        self.assertIn("/source/target/release/aiq-runner --version", dockerfile)
        self.assertIn("/source/target/release/aiq-verifier --version", dockerfile)
        self.assertIn("git status --porcelain=v1 --untracked-files=all", script)
        self.assertIn("git archive --format=tar", script)
        self.assertIn('"$context"', script)
        self.assertNotIn("ELF 64-bit .*ARM aarch64", script)
        self.assertIn("--platform linux/arm64", script)
        self.assertIn('binary_builder.py "$exported" "$target"', script)
        self.assertIn(
            "cargo build --locked --release --package aiq-runner --package aiq-verifier",
            workflow,
        )

    def test_linux_arm64_builder_rejects_invalid_output_before_build(self) -> None:
        script = ROOT / "build-binaries.sh"
        environment = {**os.environ, "AIQ_LINUX_ARM64_OUTPUT": "relative-output"}
        relative = subprocess.run(
            ["sh", str(script)],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(relative.returncode, 2)
        self.assertIn("new absolute directory", relative.stderr)

        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory).resolve() / "existing"
            existing.mkdir()
            environment["AIQ_LINUX_ARM64_OUTPUT"] = str(existing)
            occupied = subprocess.run(
                ["sh", str(script)],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(occupied.returncode, 2)
            self.assertIn("must not already exist", occupied.stderr)

    def test_linux_arm64_binary_validation_rejects_wrong_identity_and_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid = root / "valid"
            write_test_binary(valid)
            binary_builder.validate_binary(valid)

            for name, identity in (
                ("relocatable", {"elf_type": 1}),
                ("wrong-machine", {"machine": 62}),
            ):
                invalid = root / name
                write_test_binary(invalid, **identity)
                with self.assertRaises(ValueError):
                    binary_builder.validate_binary(invalid)

            wrong_loader = root / "wrong-loader"
            wrong_loader.write_bytes(linux_arm64_elf(interpreter=b"/not-linux\0"))
            wrong_loader.chmod(0o755)
            with self.assertRaises(ValueError):
                binary_builder.validate_binary(wrong_loader)

            symlink = root / "symlink"
            symlink.symlink_to(valid)
            with self.assertRaises(ValueError):
                binary_builder.validate_binary(symlink)

            non_executable = root / "non-executable"
            non_executable.write_bytes(linux_arm64_elf())
            non_executable.chmod(0o644)
            with self.assertRaises(ValueError):
                binary_builder.validate_binary(non_executable)

            directory_path = root / "directory"
            directory_path.mkdir()
            with self.assertRaises(ValueError):
                binary_builder.validate_binary(directory_path)

    def test_runtime_binary_policy_accepts_static_codex_but_not_static_aiq(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            static_codex = root / "codex"
            write_test_binary(
                static_codex,
                elf_type=2,
                interpreter=b"",
                program_type=0,
            )
            runtime.validate_linux_aarch64_elf(
                static_codex,
                "read_only.codex_binary",
                allow_static=True,
                require_pie=False,
                service_uid=runtime.RUNNER_UID,
            )
            with self.assertRaises(ValueError):
                runtime.validate_linux_aarch64_elf(
                    static_codex,
                    "read_only.runner_binary",
                    allow_static=False,
                    require_pie=True,
                    service_uid=runtime.RUNNER_UID,
                )

            macho = root / "mach-o"
            macho.write_bytes(b"\xcf\xfa\xed\xfe" + b"\0" * 124)
            macho.chmod(0o555)
            with self.assertRaisesRegex(ValueError, "ELF"):
                runtime.validate_linux_aarch64_elf(
                    macho,
                    "read_only.codex_binary",
                    allow_static=True,
                    require_pie=False,
                    service_uid=runtime.RUNNER_UID,
                )

    def test_linux_arm64_binary_publication_is_create_new(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            staging = root / "staging"
            staging.mkdir()
            for name in binary_builder.BINARIES:
                write_test_binary(staging / name)
            target = root / "published"
            binary_builder.publish_binaries(staging, target)
            self.assertEqual(set(path.name for path in target.iterdir()), set(binary_builder.BINARIES))
            for name in binary_builder.BINARIES:
                binary_builder.validate_binary(target / name)

            second_staging = root / "second-staging"
            second_staging.mkdir()
            for name in binary_builder.BINARIES:
                write_test_binary(second_staging / name)
            marker = target / "marker"
            marker.write_text("preserve\n")
            with self.assertRaises(ValueError):
                binary_builder.publish_binaries(second_staging, target)
            self.assertEqual(marker.read_text(), "preserve\n")
            self.assertEqual(
                set(path.name for path in second_staging.iterdir()),
                set(binary_builder.BINARIES),
            )

    def test_linux_arm64_binary_publication_loses_target_creation_race_safely(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            staging = root / "staging"
            staging.mkdir()
            for name in binary_builder.BINARIES:
                write_test_binary(staging / name)
            target = root / "published"
            original_mkdir = os.mkdir

            def racing_mkdir(path: str, mode: int = 0o777, *, dir_fd: int | None = None) -> None:
                original_mkdir(path, mode=mode, dir_fd=dir_fd)
                original_mkdir(path, mode=mode, dir_fd=dir_fd)

            with mock.patch.object(binary_builder.os, "mkdir", side_effect=racing_mkdir):
                with self.assertRaises(ValueError):
                    binary_builder.publish_binaries(staging, target)
            self.assertTrue(target.is_dir())
            self.assertEqual(list(target.iterdir()), [])
            self.assertEqual(
                set(path.name for path in staging.iterdir()),
                set(binary_builder.BINARIES),
            )

    def test_linux_arm64_binary_publication_does_not_replace_raced_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            staging = root / "staging"
            staging.mkdir()
            for name in binary_builder.BINARIES:
                write_test_binary(staging / name)
            target = root / "published"
            original_link = os.link

            def racing_link(
                source: os.PathLike[str],
                destination: str,
                *,
                dst_dir_fd: int,
                follow_symlinks: bool,
            ) -> None:
                descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dst_dir_fd)
                try:
                    os.write(descriptor, b"preserve\n")
                finally:
                    os.close(descriptor)
                original_link(
                    source,
                    destination,
                    dst_dir_fd=dst_dir_fd,
                    follow_symlinks=follow_symlinks,
                )

            with mock.patch.object(binary_builder.os, "link", side_effect=racing_link):
                with self.assertRaises(ValueError):
                    binary_builder.publish_binaries(staging, target)
            self.assertEqual((target / "aiq-runner").read_bytes(), b"preserve\n")
            self.assertEqual(
                set(path.name for path in staging.iterdir()),
                set(binary_builder.BINARIES),
            )

    def test_fixed_plan_has_21_units_84_unit_artifacts_and_two_aggregates(self) -> None:
        units = []
        for repeat in range(1, 4):
            units.append({"unit_id": f"repeat-{repeat:02}-core", "repeat_id": f"r{repeat}"})
            for contrast in range(1, 4):
                for arm in ("reference", "challenge"):
                    units.append({"unit_id": f"repeat-{repeat:02}-contrast-{contrast:02}-{arm}", "repeat_id": f"r{repeat}"})
        self.assertEqual(len(units), 21)
        self.assertEqual(len(units) * 4, 84)
        self.assertEqual(len(units) * 4 + 2, 86)
        with tempfile.TemporaryDirectory() as directory:
            control = Path(directory)
            (control / "authorization.json").write_text(json.dumps({"plan": {"execution_units": units}}))
            for repeat in range(1, 4):
                repeat_id, selected = runtime.plan_units(control, repeat)
                self.assertEqual(repeat_id, f"r{repeat}")
                self.assertEqual(len(selected), 7)

    def test_preparation_expectations_bind_trust_policy_and_validate_both_corpora(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            control = Path(directory)
            authorization = {
                "signer": {"node_id": "node_test", "public_key": "ab"},
                "plan": {
                    "signed_admission_sha256": f"sha256:{'1' * 64}",
                    "signed_admission_key_id": "authority-test",
                    "release_trust_policy_sha256": f"sha256:{'2' * 64}",
                    "execution_plan_digest": f"sha256:{'3' * 64}",
                    "corpus_manifest_sha256": f"sha256:{'4' * 64}",
                    "core_corpus_commitment_sha256": f"sha256:{'5' * 64}",
                    "contrast_corpus_commitment_sha256": f"sha256:{'6' * 64}",
                },
            }
            (control / "authorization.json").write_bytes(
                runtime.canonical_bytes(authorization) + b"\n"
            )
            with mock.patch.object(runtime.os, "chown"):
                target = runtime.write_expectations(
                    {"writable.control": control},
                    None,
                    "expectations-preparation.json",
                    os.getuid(),
                )
            expectations = json.loads(target.read_text())
            self.assertEqual(
                expectations["release_trust_policy_path"],
                "/inputs/release-trust-policy.json",
            )
            self.assertEqual(
                expectations["release_trust_policy_sha256"],
                authorization["plan"]["release_trust_policy_sha256"],
            )
            self.assertRegex(expectations["observed_at"], runtime.CANONICAL_TIMESTAMP)

        source = (ROOT / "runtime.py").read_text()
        prepare = source.split("def prepare(", 1)[1].split("def plan_units(", 1)[0]
        self.assertLess(prepare.index('"candidate-plan"'), prepare.index('"candidate-authorize"'))
        self.assertLess(prepare.index('"candidate-authorize"'), prepare.index('"validate-core-corpus"'))
        self.assertLess(prepare.index('"validate-core-corpus"'), prepare.index('"validate-contrast-corpus"'))
        self.assertLess(prepare.index('"validate-contrast-corpus"'), prepare.index('"prepared"'))
        runner = (ROOT / "runner-entrypoint.sh").read_text()
        self.assertIn("candidate validate-corpus", runner)
        self.assertIn("candidate validate-contrast-corpus", runner)

    def test_handoff_syncs_ownership_and_commits_actor_with_stage(self) -> None:
        source = (ROOT / "runtime.py").read_text()
        complete = source.split("def complete_handoff(", 1)[1].split("def handoff(", 1)[0]
        self.assertLess(complete.index("sync_handoff_tree"), complete.index('compose(state, "start"'))
        self.assertLess(complete.index('runtime["stage"] = stage_to'), complete.index("save_actor_state"))
        run_repeat = source.split("def run_repeat(", 1)[1].split("def verify_repeat(", 1)[0]
        verify_repeat = source.split("def verify_repeat(", 1)[1].split("def finalize_repeat(", 1)[0]
        self.assertIn('handoff(state, "verifier", expected, f"repeat-{index:02}-ran")', run_repeat)
        self.assertNotIn("advance_stage", run_repeat)
        self.assertIn('handoff(state, "runner", expected, f"repeat-{index:02}-verified")', verify_repeat)
        self.assertNotIn("advance_stage", verify_repeat)

    def test_configured_validates_shared_roots_for_the_persisted_actor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            commit = "a" * 40
            bindings = {"frozen": "binding"}
            recorded = {
                "schema_version": "aiq.candidate-runtime-content-bindings.v1",
                "source_commit": commit,
                "inputs": bindings,
            }
            (state / "content-bindings.json").write_text(json.dumps(recorded))
            (state / "compose.env").write_bytes(b"")
            config = state / "operator.toml"
            load = mock.Mock(return_value=({}, {}, commit, bindings))
            with (
                mock.patch.object(runtime, "actor_state", return_value={"actor": "verifier"}),
                mock.patch.object(runtime, "load_config", load),
                mock.patch.object(runtime, "validate_state_separation"),
            ):
                runtime.configured(config, state)
            load.assert_called_once_with(config, shared_owner=runtime.VERIFIER_UID)

    def test_handoff_recovers_mixed_ownership_and_persists_after_sync(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "receipts").mkdir()
            shared_roots = {}
            journal_roots = {}
            roots = []
            for index, label in enumerate(runtime.SHARED, 1):
                root = state / f"shared-{label}"
                root.mkdir()
                roots.append(root)
                identity = [root.stat().st_dev, root.stat().st_ino]
                shared_roots[label] = {"path": str(root), "identity": identity}
                journal_roots[label] = [
                    {"relative": ".", "identity": identity, "mode": 0o700}
                ]
            document = {
                "schema_version": "aiq.candidate-runtime-state.v1",
                "actor": "runner",
                "transition": 0,
                "stage": "prepared",
                "logs": str(state),
                "shared_roots": shared_roots,
                "source_commit": "a" * 40,
                "handoff_pending": {
                    "from": "runner",
                    "to": "verifier",
                    "roots": journal_roots,
                    "stage_from": "prepared",
                    "stage_to": "repeat-01-ran",
                },
            }
            events = []
            real_lstat = Path.lstat
            ownership = {
                root: runtime.RUNNER_UID if index % 2 == 0 else runtime.VERIFIER_UID
                for index, root in enumerate(roots)
            }

            def lstat_with_mixed_ownership(path: Path):
                if path in ownership:
                    return mock.Mock(st_uid=ownership[path], st_gid=ownership[path])
                return real_lstat(path)

            def safe_tree(root: Path, _identity, _owner=None):
                return journal_roots[root.name.removeprefix("shared-")]

            def compose(_state: Path, *arguments: str, capture=False):
                events.append(("compose", arguments, capture))
                return subprocess.CompletedProcess(arguments, 0, "", "")

            def sync(root: Path, _entries) -> None:
                events.append(("sync", root.name))

            real_save = runtime.save_actor_state

            def save(target: Path, value) -> None:
                events.append(("save", value["actor"], value["stage"]))
                real_save(target, value)

            with (
                mock.patch.object(Path, "lstat", lstat_with_mixed_ownership),
                mock.patch.object(runtime, "safe_tree", side_effect=safe_tree),
                mock.patch.object(runtime.os, "chown"),
                mock.patch.object(runtime, "sync_handoff_tree", side_effect=sync),
                mock.patch.object(runtime, "compose", side_effect=compose),
                mock.patch.object(runtime, "save_actor_state", side_effect=save),
                mock.patch.object(runtime, "public_event"),
            ):
                runtime.complete_handoff(state, document)

            persisted = json.loads((state / "runtime-state.json").read_text())
            self.assertEqual(persisted["actor"], "verifier")
            self.assertEqual(persisted["stage"], "repeat-01-ran")
            self.assertEqual(persisted["transition"], 1)
            self.assertNotIn("handoff_pending", persisted)
            last_sync = max(index for index, event in enumerate(events) if event[0] == "sync")
            start = next(
                index
                for index, event in enumerate(events)
                if event[0] == "compose" and event[1] == ("start", "verifier")
            )
            save_index = next(index for index, event in enumerate(events) if event[0] == "save")
            self.assertLess(last_sync, start)
            self.assertLess(start, save_index)

    def test_handoff_sync_failure_retains_the_durable_recovery_journal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "receipts").mkdir()
            shared_roots = {}
            journal_roots = {}
            roots = []
            for label in runtime.SHARED:
                root = state / f"shared-{label}"
                root.mkdir()
                roots.append(root)
                identity = [root.stat().st_dev, root.stat().st_ino]
                shared_roots[label] = {"path": str(root), "identity": identity}
                journal_roots[label] = [
                    {"relative": ".", "identity": identity, "mode": 0o700}
                ]
            document = {
                "schema_version": "aiq.candidate-runtime-state.v1",
                "actor": "runner",
                "transition": 0,
                "stage": "prepared",
                "logs": str(state),
                "shared_roots": shared_roots,
                "source_commit": "b" * 40,
                "handoff_pending": {
                    "from": "runner",
                    "to": "verifier",
                    "roots": journal_roots,
                    "stage_from": "prepared",
                    "stage_to": "repeat-01-ran",
                },
            }
            runtime.save_actor_state(state, document)
            starts = []
            real_lstat = Path.lstat

            def lstat_with_runner_ownership(path: Path):
                if path in roots:
                    return mock.Mock(st_uid=runtime.RUNNER_UID, st_gid=runtime.RUNNER_UID)
                return real_lstat(path)

            def safe_tree(root: Path, _identity, _owner=None):
                return journal_roots[root.name.removeprefix("shared-")]

            def compose(_state: Path, *arguments: str, capture=False):
                if arguments[:1] == ("start",):
                    starts.append(arguments)
                return subprocess.CompletedProcess(arguments, 0, "", "")

            with (
                mock.patch.object(Path, "lstat", lstat_with_runner_ownership),
                mock.patch.object(runtime, "safe_tree", side_effect=safe_tree),
                mock.patch.object(runtime.os, "chown"),
                mock.patch.object(runtime, "sync_handoff_tree", side_effect=OSError("injected sync failure")),
                mock.patch.object(runtime, "compose", side_effect=compose),
            ):
                with self.assertRaisesRegex(OSError, "injected sync failure"):
                    runtime.complete_handoff(state, document)

            persisted = json.loads((state / "runtime-state.json").read_text())
            self.assertEqual(persisted["actor"], "runner")
            self.assertEqual(persisted["stage"], "prepared")
            self.assertIn("handoff_pending", persisted)
            self.assertEqual(starts, [])

    def test_plan_rejects_cross_repeat_or_extra_units(self) -> None:
        units = []
        for repeat in range(1, 4):
            units.append({"unit_id": f"repeat-{repeat:02}-core", "repeat_id": f"repeat-{repeat:02}"})
            for contrast in range(1, 4):
                for arm in ("reference", "challenge"):
                    units.append({"unit_id": f"repeat-{repeat:02}-contrast-{contrast:02}-{arm}", "repeat_id": f"repeat-{repeat:02}"})
        with tempfile.TemporaryDirectory() as directory:
            control = Path(directory)
            units[1]["repeat_id"] = "repeat-02"
            (control / "authorization.json").write_text(json.dumps({"plan": {"execution_units": units}}))
            with self.assertRaises(SystemExit):
                runtime.plan_units(control, 1)

    def test_repeat_partition_uses_a_fresh_canonical_utc_observation(self) -> None:
        admission = {
            "repeat_schedule": [
                {"repeat_id": "repeat-01", "scheduled_at": "2026-08-03T10:00:00.000Z"},
                {"repeat_id": "repeat-02", "scheduled_at": "2026-08-03T11:00:00.000Z"},
                {"repeat_id": "repeat-03", "scheduled_at": "2026-08-03T12:00:00.000Z"},
            ],
            "collection_not_after": "2026-08-03T13:00:00.000Z",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "admission.json"
            path.write_text(json.dumps(admission))
            paths = {"read_only.signed_admission": path}
            repeat, observed = runtime.repeat_partition(paths, 2, "2026-08-03T11:30:00.000Z")
            self.assertEqual((repeat, observed), ("repeat-02", "2026-08-03T11:30:00.000Z"))
            with self.assertRaises(SystemExit):
                runtime.repeat_partition(paths, 2, "2026-08-03T12:00:00.000Z")

    def test_entrypoints_reject_cross_repeat_arguments_and_propagate_pin(self) -> None:
        runner = (ROOT / "runner-entrypoint.sh").read_text()
        verifier = (ROOT / "verifier-entrypoint.sh").read_text()
        self.assertIn("run-repeat:/control/expectations-repeat-01-run.json:repeat-01", runner)
        self.assertIn("/control/expectations-repeat-01-verify.json:repeat-01-core", verifier)
        for source in (runner, verifier):
            self.assertIn("AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256", source)
        rejected_runner = subprocess.run(
            ["sh", str(ROOT / "runner-entrypoint.sh"), "run-repeat", "/control/expectations-repeat-01-run.json", "repeat-02", "fresh"]
        )
        rejected_verifier = subprocess.run(
            ["sh", str(ROOT / "verifier-entrypoint.sh"), "verify-unit", "repeat-02-core", "/control/expectations-repeat-01-verify.json"]
        )
        self.assertEqual(rejected_runner.returncode, 64)
        self.assertEqual(rejected_verifier.returncode, 64)

    def test_promotion_verifies_the_manifest_after_creation(self) -> None:
        source = (ROOT / "runtime.py").read_text()
        self.assertLess(source.index('"create-released-manifest"'), source.index('"verify-released-manifest"'))

    def test_public_status_and_handoff_receipt_contracts_have_no_paths_or_digests(self) -> None:
        source = (ROOT / "runtime.py").read_text()
        receipt_source = source.split('receipt = {"schema_version": "aiq.candidate-runtime-handoff.v1"', 1)[1].split("write_new", 1)[0]
        self.assertNotIn('"path"', receipt_source)
        self.assertNotIn("sha256", receipt_source)
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "public-status.jsonl").write_text("")
            runtime.public_event(state, "unit", "failed")
            event = json.loads((state / "public-status.jsonl").read_text())
            self.assertEqual(set(event), {"schema_version", "operation", "status"})

    def test_admission_must_verify_under_the_protected_policy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generator = root / "fixture.mjs"
            generator.write_text(
                """
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const c=v=>v===null||typeof v==='boolean'||typeof v==='string'?JSON.stringify(v):typeof v==='number'?JSON.stringify(v):Array.isArray(v)?`[${v.map(c).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${c(v[k])}`).join(',')}}`;
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const der=publicKey.export({format:'der',type:'spki'}); const fp=`sha256:${createHash('sha256').update(der).digest('hex')}`;
const {publicKey:promotionPublicKey}=generateKeyPairSync('ed25519');
const promotionDer=promotionPublicKey.export({format:'der',type:'spki'}); const promotionFp=`sha256:${createHash('sha256').update(promotionDer).digest('hex')}`;
const policy={schema_version:'aiq.release-gate-trust.v1',release_identity:'aiq-core/1.0.2',authority_signers:[{key_id:'authority-test',algorithm:'ed25519',public_key_spki_base64:der.toString('base64'),public_key_fingerprint:fp}],promotion_signers:[{key_id:'promotion-test',algorithm:'ed25519',public_key_spki_base64:promotionDer.toString('base64'),public_key_fingerprint:promotionFp}]};
const admission={schema_version:'aiq.release-gate-admission.v1',signature_domain:'aiq.release-gate-admission.v1',signature_encoding:'aiq.sorted-key-json.v1',release_identity:'aiq-core/1.0.2',signer:{key_id:'authority-test',algorithm:'ed25519'},signature:''};
const {signature:ignored,...unsigned}=admission;
admission.signature=sign(null,Buffer.from(c(unsigned)),privateKey).toString('base64');
writeFileSync(process.argv[2],c(admission)); writeFileSync(process.argv[3],c(policy)); writeFileSync(process.argv[4],`sha256:${createHash('sha256').update(c(policy)).digest('hex')}\n`);
"""
            )
            admission, policy, pin = (root / name for name in ("admission.json", "policy.json", "pin"))
            subprocess.run(["node", str(generator), str(admission), str(policy), str(pin)], check=True)
            command = ["node", "--experimental-strip-types", str(ROOT / "verify-admission.ts"), str(admission), str(policy), str(pin)]
            valid = subprocess.run(command, text=True, capture_output=True)
            self.assertEqual(valid.returncode, 0, valid.stderr)
            admission_source = admission.read_text()
            policy_source = policy.read_text()
            invalid_sources = []
            changed = json.loads(admission_source); changed["release_identity"] = "aiq-core/9.9.9"
            invalid_sources.append(json.dumps(changed, separators=(",", ":"), sort_keys=True))
            invalid_sources.append(json.dumps(json.loads(admission_source), indent=2, sort_keys=True))
            invalid_sources.append(admission_source.replace(
                '"release_identity":"aiq-core/1.0.2"',
                '"release_identity":"aiq-core/1.0.2","release_identity":"aiq-core/1.0.2"',
                1,
            ))
            signature_changed = json.loads(admission_source)
            alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            signature = signature_changed["signature"]
            pad_index = alphabet.index(signature[-3])
            self.assertEqual(pad_index & 0x0F, 0)
            signature_changed["signature"] = f"{signature[:-3]}{alphabet[pad_index | 1]}=="
            invalid_sources.append(json.dumps(signature_changed, separators=(",", ":"), sort_keys=True))
            for source in invalid_sources:
                admission.write_text(source)
                invalid = subprocess.run(command, text=True, capture_output=True)
                self.assertNotEqual(invalid.returncode, 0)
                self.assertEqual(invalid.stderr, "candidate admission trust verification failed\n")
            admission.write_text(admission_source)
            changed_policy = json.loads(policy_source)
            changed_policy["authority_signers"][0]["public_key_spki_base64"] += " "
            changed_policy_source = json.dumps(
                changed_policy, separators=(",", ":"), sort_keys=True
            )
            policy.write_text(changed_policy_source)
            pin.write_text(
                f"sha256:{hashlib.sha256(changed_policy_source.encode()).hexdigest()}\n"
            )
            invalid = subprocess.run(command, text=True, capture_output=True)
            self.assertNotEqual(invalid.returncode, 0)
            self.assertEqual(invalid.stderr, "candidate admission trust verification failed\n")


if __name__ == "__main__":
    unittest.main()
