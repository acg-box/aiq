#!/usr/bin/env python3
"""Deterministic static checks for the Official runtime bundle."""

from __future__ import annotations

import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
REPOSITORY = ROOT.parent.parent
SPEC = importlib.util.spec_from_file_location("official_runtime", ROOT / "runtime.py")
assert SPEC is not None and SPEC.loader is not None
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


@contextmanager
def private_temp():
    """Create a Linux-compatible private temp root below a trusted ancestor."""
    with tempfile.TemporaryDirectory(prefix=".static-test-", dir=ROOT) as raw:
        yield Path(raw).resolve()


class OfficialRuntimeStaticTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compose = (ROOT / "compose.yaml").read_text()

    def test_compose_keeps_four_exact_security_boundaries(self) -> None:
        for name, user in (
            ("aiq-official-runner", "10001:10001"),
            ("aiq-official-runner-proxy", "10002:10002"),
            ("aiq-official-verifier", "10003:10003"),
            ("aiq-official-verifier-proxy", "10004:10004"),
        ):
            self.assertIn(f"container_name: {name}", self.compose)
            self.assertIn(f'user: "{user}"', self.compose)
        for required in (
            "name: aiq-official-runtime",
            "read_only: true",
            "cap_drop: [ALL]",
            "no-new-privileges:true",
            "seccomp=./seccomp-bwrap.json",
            "name: aiq-official-runner-internal",
            "name: aiq-official-verifier-internal",
            "internal: true",
            "ipv4_address: 172.30.0.2",
            "ipv4_address: 10.248.32.2",
        ):
            self.assertIn(required, self.compose)
        for forbidden in (
            "privileged:", "network_mode: host", "seccomp=unconfined",
            "/var/run/docker.sock", "/run/docker.sock", "ports:",
        ):
            self.assertNotIn(forbidden, self.compose)
        self.assertEqual(self.compose.count("container_name:"), 4)
        self.assertEqual(self.compose.count("read_only: true"), 25)

    def test_exact_mount_policy_is_declared(self) -> None:
        for variable, (target, read_only) in RUNTIME.MOUNTS.items():
            declaration = f'source: "${{{variable}}}", target: {target}'
            self.assertIn(declaration, self.compose)
            line = next(line for line in self.compose.splitlines() if declaration in line)
            self.assertEqual("read_only: true" in line, read_only, target)
        verifier_section = self.compose.split("  verifier:\n", 1)[1].split("\nnetworks:\n", 1)[0]
        self.assertNotIn("AIQ_CODEX", verifier_section)
        self.assertNotIn("/codex-home", verifier_section)
        self.assertNotIn("AIQ_VERIFIER_INGRESS_TOKEN=", verifier_section)
        self.assertNotIn("AIQ_VERIFIER_SIGNING_KEY=", verifier_section)

    def test_requirements_are_exact_and_baked_immutable(self) -> None:
        requirements = REPOSITORY / "config" / "codex-requirements.example.toml"
        digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
        self.assertEqual(digest, "f9f21149d8b9b85f1f24fd9c4078b2b1d0dd214f771f2de3a5ad690ef84801de")
        dockerfile = (ROOT / "Dockerfile.runner").read_text()
        self.assertIn("COPY --chown=0:0 --chmod=0444 config/codex-requirements.example.toml", dockerfile)

    def test_seccomp_is_default_deny_with_bounded_bubblewrap_delta(self) -> None:
        profile = json.loads((ROOT / "seccomp-bwrap.json").read_text())
        self.assertEqual(profile["defaultAction"], "SCMP_ACT_ERRNO")
        delta = profile["syscalls"][-1]
        self.assertEqual(delta["names"], ["clone", "mount", "pivot_root", "umount2", "unshare"])

    def test_proxy_filters_are_separate_exact_and_default_deny(self) -> None:
        runner = (ROOT / "runner-proxy-filter.txt").read_text().splitlines()
        verifier = (ROOT / "verifier-proxy-filter.txt").read_text().splitlines()
        self.assertEqual(runner, [
            r"^api\.openai\.com:443$", r"^auth\.openai\.com:443$",
            r"^chatgpt\.com:443$", r"^example\.com:443$",
        ])
        self.assertEqual(verifier, [
            r"^aiq\.wiki:443$",
            r"^xxnszykaeapolqdnhalx\.supabase\.co:443$",
            r"^example\.com:443$",
        ])
        self.assertFalse(any("openai" in host or "chatgpt" in host for host in verifier))
        for name in ("tinyproxy.conf", "tinyproxy-verifier.conf"):
            config = (ROOT / name).read_text()
            self.assertIn("ConnectPort 443", config)
            self.assertIn("MaxClients 128", config)
            self.assertNotIn("MaxClients 20", config)
            self.assertIn("FilterDefaultDeny Yes", config)
            self.assertNotIn("BasicAuth", config)

    def test_verifier_denial_canaries_require_exact_proxy_connect_rejection(self) -> None:
        canary = (ROOT / "verifier-canary.sh").read_text()
        self.assertIn("assert_proxy_denied 'an OpenAI host' 'https://api.openai.com/'", canary)
        self.assertIn(
            "assert_proxy_denied 'a host outside its filter' 'https://www.example.org/'",
            canary,
        )
        denial_function = canary.split("assert_proxy_denied() {", 1)[1].split("}\n", 1)[0]
        self.assertNotIn("--fail", denial_function)
        self.assertIn("--write-out '%{http_connect}'", denial_function)
        self.assertIn('[ "$connect_status" != 403 ]', denial_function)

    def test_runner_canary_proves_proxy_capacity_before_default_deny(self) -> None:
        canary = (ROOT / "runtime-canary.sh").read_text()
        capacity = canary.index("probe_proxy_capacity")
        denial = canary.index("proxy allowed a host outside its filter")
        self.assertLess(capacity, denial)
        self.assertIn("connections=64", canary)
        self.assertIn("--limit-rate 128", canary)
        self.assertIn("proxy_capacity_checked=64", canary)

    def test_verifier_wrapper_reads_secret_files_only_for_worker(self) -> None:
        wrapper = (ROOT / "verifier-entrypoint.sh").read_text()
        self.assertIn("AIQ_VERIFIER_INGRESS_TOKEN=\"$(cat \"$token_file\")\"", wrapper)
        self.assertIn("AIQ_VERIFIER_SIGNING_KEY=\"$(cat \"$signing_key_file\")\"", wrapper)
        self.assertNotIn("set -x", wrapper)
        self.assertIn("exec /inputs/bin/aiq-verifier", wrapper)
        self.assertIn("--endpoint https://aiq.wiki", wrapper)
        self.assertIn('>"$record"', wrapper)

    def test_frozen_tree_digest_is_deterministic_and_content_sensitive(self) -> None:
        with private_temp() as directory:
            tree = directory / "tree"
            tree.mkdir(mode=0o755)
            child = tree / "task.json"
            child.write_bytes(b"one")
            child.chmod(0o444)
            tree.chmod(0o555)
            first = RUNTIME.content_binding(tree)
            self.assertEqual(first, RUNTIME.content_binding(tree))
            tree.chmod(0o755)
            child.chmod(0o644)
            child.write_bytes(b"two")
            child.chmod(0o444)
            tree.chmod(0o555)
            second = RUNTIME.content_binding(tree)
            self.assertNotEqual(first["digest"], second["digest"])

    def test_frozen_tree_rejects_write_bits_symlink_special_and_hard_link(self) -> None:
        with private_temp() as directory:
            writable = directory / "writable"
            writable.write_bytes(b"x")
            with self.assertRaises(SystemExit):
                RUNTIME.content_binding(writable)
            writable.chmod(0o444)
            link = directory / "link"
            link.symlink_to(writable)
            with self.assertRaises((SystemExit, OSError)):
                RUNTIME.content_binding(link)
            hard = directory / "hard"
            os.link(writable, hard)
            with self.assertRaises(SystemExit):
                RUNTIME.content_binding(writable)
            fifo = directory / "fifo"
            os.mkfifo(fifo)
            with self.assertRaises(SystemExit):
                RUNTIME.content_binding(fifo)

    def test_secret_receipt_metadata_explicitly_omits_content_digest(self) -> None:
        metadata = {"owner": "10003:10003", "mode": "0600", "content_digest_recorded": False}
        mountpoint = {"bytes": 0, "purpose": "nested_read_only_bind_mountpoint"}
        content = {
            "inputs": {},
            "secrets": {"verifier_token": metadata},
            "mountpoints": {"codex_auth": mountpoint},
        }
        self.assertEqual(RUNTIME.receipt_content(content)["secrets"]["verifier_token"], metadata)
        self.assertEqual(RUNTIME.receipt_content(content)["mountpoints"]["codex_auth"], mountpoint)

    def test_codex_auth_mountpoint_is_empty_private_and_owned_by_runner(self) -> None:
        valid = os.stat_result((stat.S_IFREG | 0o600, 1, 1, 1, 10001, 10001, 0, 0, 0, 0))
        with mock.patch.object(Path, "lstat", return_value=valid):
            evidence = RUNTIME.validate_empty_mountpoint(Path("/codex-home/auth.json"), "test", 10001)
        self.assertEqual(evidence["bytes"], 0)

        nonempty = os.stat_result((stat.S_IFREG | 0o600, 1, 1, 1, 10001, 10001, 1, 0, 0, 0))
        with self.assertRaises(SystemExit), mock.patch.object(Path, "lstat", return_value=nonempty):
            RUNTIME.validate_empty_mountpoint(Path("/codex-home/auth.json"), "test", 10001)

    def test_darwin_codex_auth_requires_owner_immutable_flag(self) -> None:
        immutable = getattr(RUNTIME.stat, "UF_IMMUTABLE", 2)
        path = Path("/protected/auth.json")
        with (
            mock.patch.object(RUNTIME.sys, "platform", "darwin"),
            mock.patch.object(Path, "stat", return_value=mock.Mock(st_flags=0)),
            self.assertRaisesRegex(SystemExit, "owner-immutable"),
        ):
            RUNTIME.require_darwin_immutable(path, "read_only.codex_auth")
        with (
            mock.patch.object(RUNTIME.sys, "platform", "darwin"),
            mock.patch.object(Path, "stat", return_value=mock.Mock(st_flags=immutable)),
        ):
            RUNTIME.require_darwin_immutable(path, "read_only.codex_auth")

    def test_runtime_manager_uses_exact_linux_aarch64_binary_policy(self) -> None:
        source = (ROOT / "runtime.py").read_text()
        self.assertIn('name in {"codex_binary", "runner_binary", "verifier_binary"}', source)
        self.assertIn('allow_static=name == "codex_binary"', source)
        self.assertIn('require_pie=name != "codex_binary"', source)
        self.assertIn('service_uid=10003 if name == "verifier_binary" else 10001', source)

    def test_private_atomic_write_rejects_symlink(self) -> None:
        with private_temp() as directory:
            target = directory / "target"
            target.write_bytes(b"unchanged")
            link = directory / "output"
            link.symlink_to(target)
            with self.assertRaises(SystemExit):
                RUNTIME.atomic_write_private(link, b"replacement")
            self.assertEqual(target.read_bytes(), b"unchanged")

    def test_private_temp_uses_trusted_ancestor_and_rejects_unsafe_ancestor(self) -> None:
        with private_temp() as directory:
            value = directory / "input"
            value.write_bytes(b"x")
            self.assertEqual(RUNTIME.declared_path(str(value), "test"), value)
            unsafe = directory / "unsafe"
            unsafe.mkdir()
            unsafe.chmod(0o777)
            nested = unsafe / "input"
            nested.write_bytes(b"x")
            with self.assertRaises(SystemExit):
                RUNTIME.declared_path(str(nested), "unsafe test path")

    def test_compose_environment_matches_config_exactly(self) -> None:
        with private_temp() as directory:
            paths = directory / "paths"
            paths.mkdir()
            generated = {}
            for index, variable in enumerate(RUNTIME.MOUNTS):
                value = paths / str(index)
                value.write_bytes(b"")
                generated[variable] = str(value)
            generated["AIQ_SOURCE_COMMIT"] = "a" * 40
            env_file = directory / "compose.env"
            RUNTIME.write_env(env_file, generated)
            RUNTIME.require_env_file(env_file, generated)
            changed = dict(generated)
            changed["AIQ_SOURCE_COMMIT"] = "b" * 40
            with self.assertRaises(SystemExit):
                RUNTIME.require_env_file(env_file, changed)

    def test_partial_or_relative_environment_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            RUNTIME.parse_env_payload(RUNTIME.env_payload({"AIQ_SOURCE": "/controlled/source"}))

    def test_live_mount_policy_rejects_source_or_mode_drift(self) -> None:
        env = {variable: f"/controlled/{index}" for index, variable in enumerate(RUNTIME.RUNNER_MOUNTS)}
        mounts = [{"Type": "bind", "Source": env[variable], "Destination": destination, "RW": not read_only}
                  for variable, (destination, read_only) in RUNTIME.RUNNER_MOUNTS.items()]
        RUNTIME.assert_mount_policy({"Mounts": mounts}, env, RUNTIME.RUNNER_MOUNTS)
        mounts[0]["Source"] = "/tampered/source"
        with self.assertRaises(SystemExit):
            RUNTIME.assert_mount_policy({"Mounts": mounts}, env, RUNTIME.RUNNER_MOUNTS)

    def _containers(self):
        base_host = {"ReadonlyRootfs": True, "Privileged": False, "CapDrop": ["ALL"],
                     "NetworkMode": "bridge", "Binds": [], "PortBindings": {},
                     "SecurityOpt": ["no-new-privileges:true"]}
        users = {"runner": "10001:10001", "runner_proxy": "10002:10002",
                 "verifier": "10003:10003", "verifier_proxy": "10004:10004"}
        images = {role: f"aiq-official-{role.replace('_', '-')}:local" for role in users}
        images["runner_proxy"] = "aiq-official-runner-proxy:local"
        images["verifier_proxy"] = "aiq-official-verifier-proxy:local"
        networks = {
            "runner": {"aiq-official-runner-internal": {"IPAddress": "172.30.0.3"}},
            "runner_proxy": {"aiq-official-runner-internal": {"IPAddress": "172.30.0.2"},
                             "aiq-official-runner-proxy-egress": {"IPAddress": "172.31.0.2"}},
            "verifier": {"aiq-official-verifier-internal": {"IPAddress": "10.248.32.3"}},
            "verifier_proxy": {"aiq-official-verifier-internal": {"IPAddress": "10.248.32.2"},
                               "aiq-official-verifier-proxy-egress": {"IPAddress": "172.33.0.2"}},
        }
        env = {variable: f"/controlled/{index}" for index, variable in enumerate(RUNTIME.MOUNTS)}
        containers = {}
        for role in users:
            policy = RUNTIME.RUNNER_MOUNTS if role == "runner" else RUNTIME.VERIFIER_MOUNTS if role == "verifier" else {}
            mounts = [{"Type": "bind", "Source": env[variable], "Destination": destination, "RW": not read_only}
                      for variable, (destination, read_only) in policy.items()]
            host = copy.deepcopy(base_host)
            if role == "runner":
                seccomp = json.dumps(json.loads((ROOT / "seccomp-bwrap.json").read_text()), separators=(",", ":"))
                host["SecurityOpt"].append(f"seccomp={seccomp}")
            containers[role] = {"HostConfig": host, "Config": {"User": users[role], "Image": images[role], "Env": []},
                                "Mounts": mounts, "NetworkSettings": {"Networks": networks[role]}}
        return env, containers

    def test_live_runtime_rejects_verifier_user_port_mount_and_secret_env_drift(self) -> None:
        env, containers = self._containers()
        with mock.patch.object(RUNTIME, "inspect", side_effect=[containers[role] for role in RUNTIME.CONTAINERS]):
            RUNTIME.assert_runtime(env)
        mutations = (
            lambda changed: changed["verifier"]["Config"].__setitem__("User", "0:0"),
            lambda changed: changed["verifier_proxy"]["HostConfig"].__setitem__("PortBindings", {"3128/tcp": [{}]}),
            lambda changed: changed["verifier_proxy"]["Mounts"].append({"Type": "bind", "Source": "/host", "Destination": "/bad", "RW": False}),
            lambda changed: changed["verifier"]["Config"].__setitem__("Env", ["AIQ_VERIFIER_SIGNING_KEY=secret"]),
        )
        for mutate in mutations:
            changed = copy.deepcopy(containers)
            mutate(changed)
            with self.assertRaises(SystemExit), mock.patch.object(
                RUNTIME, "inspect", side_effect=[changed[role] for role in RUNTIME.CONTAINERS]
            ):
                RUNTIME.assert_runtime(env)

    def test_stale_validation_binding_is_rejected(self) -> None:
        binding = {"content": {"inputs": {"tasks": {"digest": "sha256:current"}}}}
        RUNTIME.require_current_evidence({"binding": binding, "model_invoked": False}, binding)
        with self.assertRaises(SystemExit):
            RUNTIME.require_current_evidence(
                {"binding": {"content": {"inputs": {"tasks": {"digest": "sha256:old"}}}}, "model_invoked": False},
                binding,
            )

    def test_build_context_is_the_declared_source_tree(self) -> None:
        manager = (ROOT / "runtime.py").read_text()
        self.assertIn('if paths["read_only.source"] != ROOT.parent.parent:', manager)

    def test_down_is_bounded_and_does_not_remove_images_or_volumes(self) -> None:
        manager = (ROOT / "runtime.py").read_text()
        down_body = manager.split("def down(", 1)[1].split("\n\ndef main", 1)[0]
        self.assertIn('"down", "--remove-orphans", "--timeout", "10"', down_body)
        self.assertNotIn("--rmi", down_body)
        self.assertNotIn("--volumes", down_body)


if __name__ == "__main__":
    unittest.main()
