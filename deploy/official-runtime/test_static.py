#!/usr/bin/env python3
"""Deterministic static checks for the Official runtime bundle."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
REPOSITORY = ROOT.parent.parent
SPEC = importlib.util.spec_from_file_location('official_runtime', ROOT / 'runtime.py')
assert SPEC is not None and SPEC.loader is not None
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class OfficialRuntimeStaticTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compose = (ROOT / "compose.yaml").read_text()

    def test_compose_keeps_exact_security_boundary(self) -> None:
        for required in (
            'name: aiq-official-runtime',
            'container_name: aiq-official-runner',
            'container_name: aiq-official-proxy',
            'platforms:\n        - linux/arm64',
            'read_only: true',
            'cap_drop:\n      - ALL',
            'no-new-privileges:true',
            'seccomp=./seccomp-bwrap.json',
            'internal: true',
            'ipv4_address: 172.30.0.2',
        ):
            self.assertIn(required, self.compose)
        for forbidden in (
            'privileged:',
            'network_mode: host',
            'seccomp=unconfined',
            '/var/run/docker.sock',
            '/run/docker.sock',
            'ports:',
        ):
            self.assertNotIn(forbidden, self.compose)
        self.assertEqual(self.compose.count('read_only: true'), 14)
        self.assertEqual(self.compose.count('container_name:'), 2)

    def test_mount_policy_has_all_scoped_roots(self) -> None:
        expected = {
            '/inputs/source': True,
            '/inputs/tasks': True,
            '/inputs/baselines': True,
            '/inputs/evaluators': True,
            '/inputs/evaluator-runtime': True,
            '/inputs/toolchain': True,
            '/inputs/corpus-commitment.json': True,
            '/inputs/capabilities.json': True,
            '/inputs/schedule.json': True,
            '/inputs/bin/codex': True,
            '/inputs/bin/aiq-runner': True,
            '/codex-home': False,
            '/codex-home/auth.json': True,
            '/execution': False,
            '/output/artifacts': False,
            '/output/checkpoints': False,
            '/output/preflight': False,
            '/output/admission': False,
            '/output/results': False,
        }
        for target, read_only in expected.items():
            pattern = rf'target: {re.escape(target)}\n(?P<flag>        read_only: true\n)?'
            match = re.search(pattern, self.compose)
            self.assertIsNotNone(match, target)
            self.assertEqual(match.group('flag') is not None, read_only, target)

    def test_requirements_are_exact_and_baked_immutable(self) -> None:
        requirements = REPOSITORY / 'config' / 'codex-requirements.example.toml'
        digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
        self.assertEqual(digest, 'f9f21149d8b9b85f1f24fd9c4078b2b1d0dd214f771f2de3a5ad690ef84801de')
        dockerfile = (ROOT / 'Dockerfile.runner').read_text()
        self.assertIn(
            'COPY --chown=0:0 --chmod=0444 config/codex-requirements.example.toml',
            dockerfile,
        )
        self.assertIn('/etc/codex/requirements.toml', dockerfile)

    def test_seccomp_is_default_deny_with_bounded_bubblewrap_delta(self) -> None:
        profile = json.loads((ROOT / 'seccomp-bwrap.json').read_text())
        self.assertEqual(profile['defaultAction'], 'SCMP_ACT_ERRNO')
        self.assertEqual(profile['defaultErrnoRet'], 1)
        delta = profile['syscalls'][-1]
        self.assertEqual(delta['action'], 'SCMP_ACT_ALLOW')
        self.assertEqual(
            delta['names'],
            ['clone', 'mount', 'pivot_root', 'umount2', 'unshare'],
        )
        forbidden = {'bpf', 'keyctl', 'setns', 'socketcall'}
        self.assertTrue(forbidden.isdisjoint(delta['names']))
        self.assertTrue(
            any(
                rule.get('names') == ['clone3'] and rule.get('action') == 'SCMP_ACT_ERRNO'
                for rule in profile['syscalls']
            )
        )

    def test_project_image_license_is_exact(self) -> None:
        for name in ('Dockerfile.runner', 'Dockerfile.proxy'):
            dockerfile = (ROOT / name).read_text()
            self.assertIn('org.opencontainers.image.licenses="GPL-3.0-only"', dockerfile)
            self.assertNotIn('org.opencontainers.image.licenses="MIT"', dockerfile)

    def test_proxy_is_connect_only_and_not_public(self) -> None:
        config = (ROOT / 'tinyproxy.conf').read_text()
        self.assertIn('Allow 172.30.0.0/24', config)
        self.assertIn('ConnectPort 443', config)
        self.assertIn('FilterDefaultDeny Yes', config)
        self.assertIn('LogFile "/tmp/tinyproxy.log"', config)
        self.assertNotIn('BasicAuth', config)
        self.assertIn('tinyproxy-bin=1.11.1-2.1+deb12u1', (ROOT / 'Dockerfile.proxy').read_text())
        allowlist = (ROOT / 'proxy-filter.txt').read_text().splitlines()
        self.assertEqual(
            allowlist,
            [
                r'^api\.openai\.com:443$',
                r'^auth\.openai\.com:443$',
                r'^chatgpt\.com:443$',
                r'^example\.com:443$',
            ],
        )

    def test_private_atomic_write_rejects_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw).resolve()
            target = directory / 'target'
            target.write_bytes(b'unchanged')
            link = directory / 'output'
            link.symlink_to(target)
            with self.assertRaises(SystemExit):
                RUNTIME.atomic_write_private(link, b'replacement')
            self.assertEqual(target.read_bytes(), b'unchanged')

    def test_read_commands_do_not_create_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            missing = Path(raw).resolve() / 'missing'
            with self.assertRaises(SystemExit):
                RUNTIME.prepare_state(missing, create=False)
            self.assertFalse(missing.exists())

    def test_compose_environment_must_match_config_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw).resolve()
            env_file = directory / 'compose.env'
            generated = {variable: str(directory) for variable in RUNTIME.MOUNTS}
            generated['AIQ_SOURCE_COMMIT'] = 'a' * 40
            RUNTIME.write_env(env_file, generated)
            RUNTIME.require_env_file(env_file, generated)
            changed = dict(generated)
            changed['AIQ_SOURCE_COMMIT'] = 'b' * 40
            with self.assertRaises(SystemExit):
                RUNTIME.require_env_file(env_file, changed)

    def test_partial_or_relative_generated_environment_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            RUNTIME.parse_env_payload(RUNTIME.env_payload({'AIQ_SOURCE': '/controlled/source'}))
        generated = {variable: '/controlled/source' for variable in RUNTIME.MOUNTS}
        generated['AIQ_SOURCE_COMMIT'] = 'a' * 40
        generated['AIQ_SOURCE'] = 'relative/source'
        with self.assertRaises(SystemExit):
            RUNTIME.parse_env_payload(RUNTIME.env_payload(generated))

    def test_atomic_write_cleans_owned_temporary_after_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            destination = Path(raw).resolve() / 'output'
            with mock.patch.object(RUNTIME.os, 'write', side_effect=OSError('test failure')):
                with self.assertRaises(OSError):
                    RUNTIME.atomic_write_private(destination, b'payload')
            self.assertFalse((destination.parent / f'.output.tmp-{RUNTIME.os.getpid()}').exists())

    def test_live_mount_policy_rejects_source_or_mode_drift(self) -> None:
        env = {variable: f'/controlled/{index}' for index, variable in enumerate(RUNTIME.MOUNTS)}
        mounts = [
            {
                'Type': 'bind',
                'Source': env[variable],
                'Destination': destination,
                'RW': not read_only,
            }
            for variable, (destination, read_only) in RUNTIME.MOUNTS.items()
        ]
        RUNTIME.assert_mount_policy({'Mounts': mounts}, env)
        mounts[0]['Source'] = '/tampered/source'
        with self.assertRaises(SystemExit):
            RUNTIME.assert_mount_policy({'Mounts': mounts}, env)

    def test_live_runtime_rejects_user_port_seccomp_and_proxy_mount_drift(self) -> None:
        env = {variable: f'/controlled/{index}' for index, variable in enumerate(RUNTIME.MOUNTS)}
        runner_mounts = [
            {
                'Type': 'bind',
                'Source': env[variable],
                'Destination': destination,
                'RW': not read_only,
            }
            for variable, (destination, read_only) in RUNTIME.MOUNTS.items()
        ]
        seccomp = json.dumps(json.loads((ROOT / 'seccomp-bwrap.json').read_text()), separators=(',', ':'))
        base_host = {
            'ReadonlyRootfs': True,
            'Privileged': False,
            'CapDrop': ['ALL'],
            'NetworkMode': 'bridge',
            'Binds': [],
            'PortBindings': {},
        }
        runner = {
            'HostConfig': {**base_host, 'SecurityOpt': ['no-new-privileges:true', f'seccomp={seccomp}']},
            'Config': {'User': '10001:10001'},
            'Mounts': runner_mounts,
            'NetworkSettings': {
                'Networks': {
                    'aiq-official-runner-internal': {'IPAddress': '172.30.0.3'}
                }
            },
        }
        proxy = {
            'HostConfig': {**base_host, 'SecurityOpt': ['no-new-privileges:true']},
            'Config': {'User': '10002:10002'},
            'Mounts': [],
            'NetworkSettings': {
                'Networks': {
                    'aiq-official-runner-internal': {'IPAddress': '172.30.0.2'},
                    'aiq-official-proxy-egress': {'IPAddress': '172.31.0.2'},
                }
            },
        }
        with mock.patch.object(RUNTIME, 'inspect', side_effect=[runner, proxy]):
            RUNTIME.assert_runtime(env)

        mutations = (
            lambda _runner, changed: changed['Config'].__setitem__('User', '0:0'),
            lambda changed, _proxy: changed['HostConfig'].__setitem__('PortBindings', {'3128/tcp': [{}]}),
            lambda _runner, changed: changed['HostConfig'].__setitem__(
                'SecurityOpt', ['no-new-privileges:true', 'seccomp=unconfined']
            ),
            lambda _runner, changed: changed['Mounts'].append(
                {'Type': 'bind', 'Source': '/host', 'Destination': '/unexpected', 'RW': False}
            ),
        )
        for mutate in mutations:
            changed_runner = copy.deepcopy(runner)
            changed_proxy = copy.deepcopy(proxy)
            mutate(changed_runner, changed_proxy)
            with self.assertRaises(SystemExit), mock.patch.object(
                RUNTIME,
                'inspect',
                side_effect=[changed_runner, changed_proxy],
            ):
                RUNTIME.assert_runtime(env)

    def test_stale_validation_binding_is_rejected(self) -> None:
        binding = {'containers': {'runner': 'current'}}
        RUNTIME.require_current_evidence(
            {'binding': binding, 'model_invoked': False},
            binding,
        )
        with self.assertRaises(SystemExit):
            RUNTIME.require_current_evidence(
                {'binding': {'containers': {'runner': 'old'}}, 'model_invoked': False},
                binding,
            )

    def test_state_must_not_overlap_any_mount(self) -> None:
        env = {variable: f'/controlled/{index}' for index, variable in enumerate(RUNTIME.MOUNTS)}
        RUNTIME.validate_state_separation(Path('/private/state'), env)
        env['AIQ_EXECUTION'] = '/private/state/execution'
        with self.assertRaises(SystemExit):
            RUNTIME.validate_state_separation(Path('/private/state'), env)

    def test_source_cleanliness_includes_untracked_files(self) -> None:
        manager = (ROOT / 'runtime.py').read_text()
        self.assertIn('"status", "--porcelain=v1", "--untracked-files=all"', manager)

    def test_down_validates_local_docker_before_compose(self) -> None:
        manager = (ROOT / 'runtime.py').read_text()
        down_body = manager.split('def down(', 1)[1].split('\n\ndef main', 1)[0]
        self.assertLess(down_body.index('validate_docker_host()'), down_body.index('compose_args'))


if __name__ == '__main__':
    unittest.main()
