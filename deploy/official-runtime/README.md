# Local Official runner runtime

This bundle lets an arm64 Mac host the AIQ Official runner in a Linux arm64
container. It does not make macOS an Official runtime. It does not invoke Codex
or start an AIQ run.

The runner is a non-root container with a read-only root file system, no Linux
capabilities, `no-new-privileges`, and a reviewed seccomp policy. It has only an
internal network. A non-root Tinyproxy sidecar has the internal network and one
egress network. The proxy listens at `172.30.0.2:3128` inside the internal
network. It accepts clients only from `172.30.0.0/24`, permits CONNECT only on
port 443, and uses an exact host filter. It does not publish a host port, use
credentials, intercept TLS, or retain request logs.

## Host preparation

Use Docker Engine and Compose with Linux arm64 support and seccomp enabled. Do
not use a remote Docker context. Docker Desktop or another local Linux VM must
support unprivileged user namespaces.

Copy `operator.example.toml` outside the repository. Replace every placeholder.
Create each writable directory with mode `0700`. Put `auth.json` in a separate
private directory with mode `0600`; do not put it below the Codex home. The host
script does not read or print this file. It validates only its type, owner, mode,
and path separation.

Every declared input must exist, use an absolute canonical path, and have no
symlink in the declared path. Read-only inputs must not be writable by group or
other. The source worktree must be clean at the exact 40-character commit in the
operator file. No two declared paths can contain each other.

The committed proxy filter includes the explicitly approved Codex HTTPS hosts and
`example.com` for the harmless canary. Review this fixed filter when the Codex
service endpoint contract changes. Do not add a wildcard.

## Commands

Use one absolute private state directory. `create` validates host paths, writes
one mode-`0600` Compose environment file, builds pinned images, and creates only
the `aiq-official-runtime` stack.

```sh
deploy/official-runtime/runtime.py create \
  --config /absolute/private/operator.toml \
  --state /absolute/private/official-runtime-state

deploy/official-runtime/runtime.py up \
  --state /absolute/private/official-runtime-state

deploy/official-runtime/runtime.py validate \
  --config /absolute/private/operator.toml \
  --state /absolute/private/official-runtime-state

deploy/official-runtime/runtime.py receipt \
  --config /absolute/private/operator.toml \
  --state /absolute/private/official-runtime-state

deploy/official-runtime/runtime.py down \
  --state /absolute/private/official-runtime-state
```

`validate` checks the live container configuration and runs a disposable,
model-free bubblewrap canary. The canary proves these facts:

- Linux arm64 and uid/gid `10001:10001` are active.
- The outer seccomp filter is active and the container root is read-only.
- Bubblewrap creates unprivileged user, process, UTS, IPC, mount, and
  network namespaces.
- The inner root is read-only, its private `/tmp` is writable, and its network
  namespace cannot reach the external endpoint.
- The runner cannot use direct external HTTPS.
- HTTPS through `172.30.0.2:3128` reaches `https://example.com/` without auth.
- The proxy denies an HTTPS host that is outside its exact filter.

Any failed proof stops validation. This includes Docker Desktop or VM behavior
that gives the internal runner network direct egress or blocks the inner
sandbox.

`receipt` requires current validation evidence. It writes a non-secret JSON
receipt in the private state directory. The receipt binds the source commit,
local image content IDs, Docker version and architecture, requirements digest
and container ownership/mode, seccomp digest, exact network topology, and mount
read/write policy. It always records `model_invoked: false`.

`down` targets the exact project and container/network names. It does not remove
images, volumes, unrelated containers, or unrelated networks. The state
directory, two local images, and Docker build cache remain until the operator
removes them.

## Running the binary

After validation, use `/inputs/bin/aiq-runner` inside
`aiq-official-runner`. The exact `preflight`, `admit-permissions`, and `run`
arguments come from the mounted binary's `--help` output and the checked-in AIQ
runner authority. Write only to `/execution`, `/output/artifacts`,
`/output/checkpoints`, `/output/preflight`, `/output/admission`, or
`/output/results`. The Codex home is writable at `/codex-home`, except
`/codex-home/auth.json`, which is a separate read-only bind mount.

The mounted source, private tasks, baselines, evaluator assets and runtime,
toolchain, corpus commitment, capabilities, schedule, Codex binary, and runner
binary are read-only. The runner has no Docker socket and cannot control the
outer runtime.

## Static validation

This check is deterministic and does not need Docker or a model:

```sh
python3 deploy/official-runtime/test_static.py
docker compose --project-name aiq-official-runtime \
  --env-file /absolute/private/official-runtime-state/compose.env \
  --file deploy/official-runtime/compose.yaml config --quiet
```
