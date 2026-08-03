# Local Official runner and verifier runtime

This bundle runs the AIQ Official runner and verifier in separate Linux arm64
containers. It does not make macOS an Official runtime. `create`, `validate`,
and `receipt` do not invoke Codex, claim a package, or send a verification.
It is also separate from the preregistered AIQ Core `1.0.2` candidate runtime.
That candidate's three-repeat calibration does not replace the Official
`72 × 17` run.

See `THIRD_PARTY.md` for the pinned runtime-image packages and licenses.

The stack has four non-root containers:

- `aiq-official-runner` uses uid/gid `10001:10001` and the reviewed
  bubblewrap seccomp profile.
- `aiq-official-runner-proxy` uses uid/gid `10002:10002`.
- `aiq-official-verifier` uses uid/gid `10003:10003` and Docker's default
  seccomp profile.
- `aiq-official-verifier-proxy` uses uid/gid `10004:10004`.

All four containers have a read-only root file system, no Linux capabilities,
`no-new-privileges`, no host port, and no Docker socket. The runner and
verifier use different internal networks and different egress proxies. The
runner proxy permits only the three approved Codex hosts and `example.com` for
the canary. The verifier proxy permits only `aiq.wiki`,
`xxnszykaeapolqdnhalx.supabase.co`, and `example.com`. It rejects OpenAI and
Codex hosts. No filter has a wildcard. Each proxy allows 128 clients. The
runner canary opens 64 concurrent allowed CONNECT tunnels before it repeats the
default-deny check. The verifier internal network is the RFC1918 subnet
`10.248.32.0/24`; confirm that the local Docker Engine and host VPN do not
already route it.

## Prepare host paths

Use a local Docker Engine or local VM that reports Linux `aarch64` and seccomp.
Do not use a remote Docker context.

On an Apple Silicon Mac with OrbStack, check the ordinary operator context and
the protected provisioning context before preparing paths. Both must resolve the
same local Unix socket and Linux `aarch64` daemon:

```sh
docker context inspect --format '{{.Endpoints.docker.Host}}'
docker info --format '{{.OSType}}/{{.Architecture}} {{json .SecurityOptions}}'
sudo env HOME="$HOME" DOCKER_CONTEXT="$(docker context show)" PATH="$PATH" \
  docker context inspect --format '{{.Endpoints.docker.Host}}'
sudo env HOME="$HOME" DOCKER_CONTEXT="$(docker context show)" PATH="$PATH" \
  docker info --format '{{.OSType}}/{{.Architecture}} {{json .SecurityOptions}}'
```

Each context command must report the same local `unix://` endpoint. Each info
command must report `linux/aarch64` and `seccomp`. Root is required for the
one-time numeric ownership and macOS flag provisioning below. The Official
manager can then run as the ordinary operator that owns its private state
directory and can access that verified Docker socket.
These host checks and the preparation below do not deploy the runtime or start a
real run.

Copy `operator.example.toml` outside Git and replace all placeholders. Use
absolute canonical paths. A declared path must not contain a symlink or a
group-writable or other-writable parent. No two declared paths can contain each
other. The runner and verifier can use the same exact tasks, evaluators,
evaluator runtime, toolchain, or corpus commitment path; all other roots must
be separate.

Freeze every non-secret read-only input before `create`. Remove all owner,
group, and other write bits from each file and directory. The manager rejects
symlinks, device nodes, sockets, FIFOs, unsafe hard links, and a file or path
that changes while it is read. The source must also be a clean Git worktree at
the configured 40-character commit. Run the manager from that exact declared
source tree so the Compose build context and image revision cannot diverge.
The source digest excludes only the root `.git` control entry; the commit and
clean status bind that control data.

On macOS, use dedicated AIQ trees and remove inherited ACLs before freezing
inputs or setting writable-root modes. Clear unexpected immutable flags only on
the exact dedicated mutable or non-secret input paths before provisioning:

```sh
chmod -RN /absolute/controlled/input /absolute/private/runtime-root
chflags -R nouchg,noschg /absolute/controlled/input /absolute/private/runtime-root
```

The manager creates a deterministic `aiq.frozen-tree.v1` SHA-256 summary for
the source, private tasks, baselines, evaluators, evaluator runtime, toolchain,
corpus commitment, capabilities, schedule, runner binary, Codex binary,
verifier binary, verifier tasks, verifier evaluators, verifier runtime,
verifier toolchain, verifier corpus commitment, and verifier environment. It
recomputes the summaries during `create`, `validate`, and `receipt`. A content
or metadata change makes validation evidence stale and stops the command.
The manager rejects a Mach-O or wrong-architecture executable. Codex can be a
static Linux AArch64 ELF; the AIQ runner and verifier must be Linux AArch64 PIE
files that use `/lib/ld-linux-aarch64.so.1`.

Create runner writable directories with exact uid/gid `10001:10001` and mode
`0700`. Use mode `0711` only for the Codex home so the OCI runtime can install
the nested read-only `auth.json` mount. Before `create`, put a zero-byte
`auth.json` mountpoint in that directory with exact uid/gid `10001:10001`, mode
`0600`, and one link. This file is not a credential. Keep the real Codex
`auth.json` secret at the separate `read_only.codex_auth` path. Create verifier
replay and record directories with exact uid/gid `10003:10003` and mode `0700`.
Create the real Codex authentication file with exact owner `10001:10001` and
mode `0600`. Create the verifier token and Ed25519 signing key files with exact
owner `10003:10003` and mode `0600`. Put each real secret outside all other
declared roots. For example, use a protected administrator shell:

```sh
install -d -o 10001 -g 10001 -m 0700 /controlled/runner/execution
install -d -o 10001 -g 10001 -m 0711 /controlled/runner/codex-home
install -o 10001 -g 10001 -m 0600 /dev/null /controlled/runner/codex-home/auth.json
install -d -o 10003 -g 10003 -m 0700 /controlled/verifier/replay
install -o 10003 -g 10003 -m 0600 /protected/input/token /controlled/secrets/verifier-token
```

On macOS, the Codex authentication source must be a separate copy, not the
active profile. After its owner and mode are exact, protect that separate copy
for the complete run:

```sh
chflags uchg /absolute/private/path/to/auth.json
```

Clear `uchg` only on that separate copy when an operator intentionally replaces
it. The manager rejects a macOS Codex authentication copy without `uchg`.

Do not put a secret value in the TOML file. The TOML file contains only secret
file paths. The manager never opens or hashes Codex authentication, the
verifier token, or the verifier signing key. It records only owner, mode, link,
and read-only mount policy metadata. It also records the zero-byte mountpoint
metadata, never secret content. Compose does not put these values in an
environment variable or image. The verifier entrypoint reads the two verifier
files only when it starts a worker and does not print them.

## Create and validate the stack

Use one private absolute state directory. The state directory must have a safe
parent and must not overlap a mount.

```sh
deploy/official-runtime/runtime.py create \
  --config /controlled/operator.toml \
  --state /controlled/runtime-state

deploy/official-runtime/runtime.py up \
  --state /controlled/runtime-state

deploy/official-runtime/runtime.py validate \
  --config /controlled/operator.toml \
  --state /controlled/runtime-state

deploy/official-runtime/runtime.py receipt \
  --config /controlled/operator.toml \
  --state /controlled/runtime-state
```

The runner canary proves the outer and bubblewrap boundaries, rejects direct
HTTPS, permits `example.com` through the runner proxy, and rejects a host that
is not in the runner filter. The verifier canary proves its user and read-only
root, confirms that no Codex home or Codex binary is present, rejects direct
HTTPS, permits only the model-free canary request, and proves that its proxy
rejects both OpenAI and an unlisted host. It does not connect to the production
gateway or Storage and does not send a claim.

The private `deployment-receipt.json` uses schema v2. It records all four image
content IDs, exact networks and mount modes, the runner requirements and
seccomp digests, and every non-secret input digest. Secret entries explicitly
state `content_digest_recorded: false`.

## Run one verifier worker

Run this only after an operator has submitted a real package and has authorized
a claim. First use the mounted binary's `--help` output to confirm the current
CLI contract. Then run one bounded worker through the secret-file wrapper:

```sh
docker compose --project-name aiq-official-runtime \
  --env-file /controlled/runtime-state/compose.env \
  --file deploy/official-runtime/compose.yaml \
  exec --no-TTY verifier \
  /usr/local/bin/aiq-verifier-entrypoint worker \
  --max-claims 1 --max-idle-polls 1
```

The wrapper supplies the exact production gateway, mounted tasks, evaluator
inputs, toolchain, corpus commitment, environment, and replay root. It writes
the worker JSON lines to a new mode-private file below `/records`. The verifier
has no Codex mount and cannot reach a Codex or OpenAI host.

Use the runner binary at `/inputs/bin/aiq-runner` only after the separate
Official admission procedure passes. Write runner data only to the declared
writable roots. Start only one runner command at a time. The runner holds a
kernel advisory lock on every future-output parent before any paid preflight
and through finalization, and all AIQ writers must honor that lock. The exact
uid `10001`, private host directory modes, single runner container, and separate
writable mounts form the trusted single-writer boundary. A process that ignores
the lock must not receive uid `10001` or write access to these mounts.

## Stop the stack

```sh
deploy/official-runtime/runtime.py down \
  --state /controlled/runtime-state
```

`down` targets only this Compose project and its four exact containers and
networks. It does not remove images, volumes, state, build cache, or unrelated
resources.

## Static checks

```sh
python3 deploy/official-runtime/test_static.py
docker compose --project-name aiq-official-runtime \
  --env-file /controlled/runtime-state/compose.env \
  --file deploy/official-runtime/compose.yaml config --quiet
```
