# Local AIQ Core 1.0.2 candidate runtime

This bundle is separate from `deploy/official-runtime`. It runs the fixed,
non-Official release-gate calibration on one local Linux arm64 Docker Engine.
It never converts candidate evidence into an Official result. AIQ Core `1.0.1`
remains current; AIQ Core `1.0.2` is preregistered and not promoted. No real
candidate run has started, and no subscription limit has been observed.

The three-repeat plan contains 3,672 core observations (`72 × 17 × 3`) and 306
contrast observations (`3 × 2 × 17 × 3`), for 3,978 observations. It is
separate from a fresh Official `72 × 17` run. Signed unit artifacts retain
measured latency and available provider-token counters. The public aggregate
gate source, evidence, and result artifacts omit efficiency fields; verified
publication evidence owns the coverage-qualified aggregates and Standard
API-equivalent estimate.

The runner and verifier use different non-root users, images, networks, proxies,
and signing keys. Only the runner receives Codex and ChatGPT subscription
authentication. The verifier has no Codex binary, home, or allowed Codex egress.
See `../official-runtime/THIRD_PARTY.md` for the pinned runtime and builder-image
packages and licenses shared by both bundles.

## Security boundary

Before `create`, copy `operator.example.toml` outside Git. Replace placeholders
with canonical, nonoverlapping absolute paths. Freeze each read-only tree by
removing all write bits. Create all shared roots, including verifier replay, as
`10001:10001`; the manager transfers them to `10003:10003` only while the
verifier is active. Create private directories as mode `0700`. `codex_home` is mode
`0711`; its empty nested `auth.json` mountpoint and every secret file are
single-link mode `0600` files. Runner secrets belong to `10001:10001`; the
verifier key and verifier trust-policy pin belong to `10003:10003`. Authority
and promotion keys stay on the host and are never mounted into either actor.

The manager changes exact host ownership during each runner-to-verifier handoff
and writes into service-owned mode-`0700` roots. Run the complete manager
lifecycle from one protected root shell. Do not run only `create` with elevated
privileges and later run the handoff commands as an ordinary host user.

On an Apple Silicon Mac with OrbStack, preserve the ordinary operator's Docker
home and selected local context when the protected shell starts. Confirm the
root shell resolves the same local Unix socket and the same Linux `aarch64`
daemon before `create`:

```sh
AIQ_OPERATOR_HOME=$HOME
AIQ_OPERATOR_DOCKER_CONTEXT=$(docker context show)
sudo env HOME="$AIQ_OPERATOR_HOME" \
  DOCKER_CONTEXT="$AIQ_OPERATOR_DOCKER_CONTEXT" PATH="$PATH" /bin/zsh
docker context inspect --format '{{.Endpoints.docker.Host}}'
docker info --format '{{.OSType}}/{{.Architecture}} {{json .SecurityOptions}}'
```

The first command must report a local `unix://` endpoint. The second must report
`linux/aarch64` and `seccomp`. Keep this root shell for the commands below.
These checks and the path preparation below provision a local runtime only. They
do not deploy it or start model work.

Use dedicated host trees. On macOS, remove inherited ACLs before setting the
exact modes, and clear unexpected immutable flags before a mutable tree enters
the lifecycle:

```sh
chmod -RN /absolute/controlled/input /absolute/private/runtime-root
chflags -R nouchg,noschg /absolute/controlled/input /absolute/private/runtime-root
```

Apply those commands only to the exact dedicated AIQ paths. Freeze non-secret
inputs after ACL removal. Make a separate Codex authentication copy; never
change the active Codex profile. Set the copy to owner `10001:10001`, mode
`0600`, and then make it owner immutable for the complete run:

```sh
install -o 10001 -g 10001 -m 0600 \
  /absolute/path/to/separate-auth-copy /absolute/protected/path/to/auth.json
chflags uchg /absolute/protected/path/to/auth.json
```

Clear `uchg` only on that separate copy when an operator intentionally replaces
it. The manager rejects a macOS Codex authentication copy without `uchg`.

Build both frozen Linux arm64 binaries from one clean source commit. The builder
uses the official Rust `1.97.1-bookworm` multi-platform image pinned to OCI index
digest `sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa`.
The selected arm64 manifest identifies the upstream source revision
`rust-lang/docker-rust@40acf7919e2e27dc706918e42758a6f1c21e806b`.
The Docker context is a `git archive` of `HEAD`, so ignored files and files that
are not tracked cannot enter the build context.

```sh
AIQ_LINUX_ARM64_OUTPUT=/controlled/aiq-linux-arm64 \
  cargo make build-candidate-linux-arm64
```

The output directory is create-new and contains `aiq-runner` and
`aiq-verifier`. Use those two paths in the operator configuration. The command
rejects a dirty source worktree and never overwrites an existing output.
The manager also rejects a Mach-O or wrong-architecture executable. Codex can be
a static Linux AArch64 ELF; both AIQ binaries must be Linux AArch64 PIE files
that use `/lib/ld-linux-aarch64.so.1`.

The runner and verifier have separate protected trust-policy pin files. Both
contain the same canonical nonzero `sha256:...` digest of the public trust
policy. The manager verifies their equality and verifies the signed
admission's Ed25519 signature against that pinned policy before it builds or
starts a model-capable container. Rust then validates the complete admission,
plan, corpus, schedule, and output contract. This closes the pre-model trust gap:
an admission with a valid shape, digest, or key ID but an untrusted signature
cannot reach candidate planning, capability probing, or model dispatch.

The frozen plan-input JSON must use these exact container paths:

- `/inputs/{signed-admission,corpus-manifest,core-commitment,contrast-commitment}.json`;
- `/inputs/core-tasks`, `/inputs/contrast-tasks`, `/inputs/candidate-source`;
- `/inputs/core-workspaces`, `/inputs/contrast-workspaces`;
- `/inputs/evaluators`, `/inputs/evaluator-runtime`, `/inputs/toolchain`;
- `/inputs/capabilities.json`, `/inputs/schedule.json`, `/inputs/bin/{codex,aiq-runner}`;
- `/codex-home`, `/candidate/{execution,work,artifacts,outputs,verifier-replay}`;
- authorization `/control/authorization.json` and output root `/candidate/outputs`.

It must also use the exact runner proxy endpoint
`http://10.248.34.2:3128`. The candidate runner and verifier internal networks
are `10.248.34.0/24` and `10.248.36.0/24`. Confirm that the local Docker Engine
and host VPN do not already route those exact subnets. The proxies allow 128
clients, and the runner canary opens 64 concurrent allowed CONNECT tunnels
before it repeats the default-deny check. The signed plan binds the selected
runner job count; do not change it during a run.

## Create and prepare

The manager retains raw command output only in create-new mode-private files
below the declared log root. `public-status.jsonl` contains fixed operation and
status codes only. Handoff receipts contain actor names, transition numbers,
root labels, and entry counts. They contain no secret value, private path, or
digest of a private path.

```sh
deploy/candidate-runtime/runtime.py create \
  --config /controlled/candidate-operator.toml \
  --state /controlled/candidate-runtime-state
deploy/candidate-runtime/runtime.py up \
  --state /controlled/candidate-runtime-state
deploy/candidate-runtime/runtime.py validate \
  --config /controlled/candidate-operator.toml \
  --state /controlled/candidate-runtime-state
deploy/candidate-runtime/runtime.py receipt \
  --config /controlled/candidate-operator.toml \
  --state /controlled/candidate-runtime-state
deploy/candidate-runtime/runtime.py prepare \
  --config /controlled/candidate-operator.toml \
  --state /controlled/candidate-runtime-state
```

If `create` stops after it writes an `initializing` state, run `down` against
that exact state path, preserve the failed state for diagnosis, and retry with a
new empty state path. Do not delete, overwrite, or reuse the partial state.

`prepare` creates the deterministic 21-unit plan and signs its private execution
authorization. Each later operation records a just-in-time trusted host UTC
observation and validates it against the selected signed repeat partition.
There are no task, model, contrast-arm, or unit selectors.

The fixed source assembler runs from an isolated directory and embeds exact
copies of `release-gate-source-observations.schema.json` and
`release-gate-evidence.schema.json`. Tests require those embedded copies to
match the checked-in public schemas.

## Run the fixed three repeats

Run each repeat only in its signed time partition. Repeat one creates all 86
reservations. Later repeats reopen the exact plan. Each run command executes the
seven fixed units for that repeat. Each verification command derives the same
seven unit IDs from the signed plan.

```sh
for repeat in 1 2 3; do
  deploy/candidate-runtime/runtime.py run-repeat --repeat "$repeat" \
    --config /controlled/candidate-operator.toml \
    --state /controlled/candidate-runtime-state
  deploy/candidate-runtime/runtime.py verify-repeat --repeat "$repeat" \
    --config /controlled/candidate-operator.toml \
    --state /controlled/candidate-runtime-state
  deploy/candidate-runtime/runtime.py finalize-repeat --repeat "$repeat" \
    --config /controlled/candidate-operator.toml \
    --state /controlled/candidate-runtime-state
done
```

`run-repeat` stops the runner and transfers only the exact declared control,
artifact, and output roots to verifier UID 10003. It validates the saved root
inodes and rejects links or unsupported entries before transfer. `verify-repeat`
stops the verifier, replays all seven units, and transfers the same roots back to
runner UID 10001. A create-new private receipt records each transition. If a
command stops, repeat it with the same number; repeat one uses `fresh` only on
its first invocation and later work uses the signed exact-plan reservations.

## Aggregate and optional promotion receipt

After all three repeats are finalized, assemble the two public-safe aggregate
outputs and evaluate the gate:

```sh
deploy/candidate-runtime/runtime.py aggregate \
  --authority-key-id '<trusted-authority-key-id>' \
  --config /controlled/candidate-operator.toml \
  --state /controlled/candidate-runtime-state
```

Only when the gate passes and the promotion owner explicitly authorizes release,
issue the separate promotion receipt and released manifest:

```sh
deploy/candidate-runtime/runtime.py promote \
  --promotion-key-id '<trusted-promotion-key-id>' \
  --issued-at '2026-08-03T12:00:00.000Z' \
  --config /controlled/candidate-operator.toml \
  --state /controlled/candidate-runtime-state
```

Promotion artifacts authorize a separate repository and production cutover.
They do not submit candidate artifacts. After that separately validated cutover,
run a fresh Official 72-by-17 admission, execution, score, package, submission,
verifier replay, and publisher transition through `deploy/official-runtime`.
The promotion receipt `issued_at` must be a canonical timestamp that is equal to
or later than `evidence.collected_at`.

## Model-free checks

```sh
python3 deploy/candidate-runtime/test_runtime.py
python3 deploy/official-runtime/test_static.py
```
