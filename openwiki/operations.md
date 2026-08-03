---
type: 'Operations'
title: 'Operations and Validation'
description: 'Local validation, runner, verifier, database, Web, and Storage procedures.'
tags: ['operations', 'validation', 'runbook']
---

# Operations and Validation

## Hosted production state

The personal Vercel scope `acgbox` hosts project `aiq` at `https://aiq.wiki`.
The only Vercel project domains are the Production apex and `www.aiq.wiki`,
which preserves the request path and returns a `308` redirect to the apex. Both
domains report `configured_correctly`. The Cloudflare zone `aiq.wiki` in account
`Cloudflare@acg.box` has exactly two DNS-only CNAMEs, `@` and `www`, both
targeting `87af8e493f03b965.vercel-dns-017.com`. The removed project domain
`aiq-acgbox.vercel.app` returns `404 DEPLOYMENT_NOT_FOUND` and is not a public
origin.

The production environment-name set in [Web configuration](#web-configuration)
is configured; values remain outside Git. The personal Supabase organization
`ACG Box` hosts project `aiq`
(`xxnszykaeapolqdnhalx`). Its one-shot production schema and reference
initialization completed. The real database has 17 model configurations, three
production nodes, no published runs, and private `private-packages` and
`private-artifacts` buckets.

The apex home returns `200`. The production readiness endpoint returns `200`
with `bounded_dependency_probe_passed`, `scope_ready: true`, and production
mode. The empty real-data read path passes.

No benchmark or Storage schedule and no cloud runner or verifier worker exist.
A full real run has not been published. Official dispatch is blocked by the
managed-policy gate: `Official runs require an exclusive managed aiq_benchmark
allowlist and managed default; no model was invoked`. Current run work is
calibration-only. Calibration evidence is non-Official and cannot satisfy the
Official publication gate. This state is not final release acceptance.

## Toolchain

Use Node.js `24.18.0` or newer, npm `11.17.0` or newer, Rust `1.97.1`, and the
locked dependencies.

```sh
npm ci --ignore-scripts
```

The aggregate repository checks are:

```sh
cargo make fmt-check
cargo make check
cargo make lint
cargo make test
cargo make build
```

## Local synthetic demonstration

```sh
cargo run -p aiq-runner -- demo
npm run dev
```

Open `http://localhost:3000`. The development server uses synthetic seed data
when both browser-safe Supabase values are absent.

Validate the public examples:

```sh
cargo run -p aiq-runner -- matrix
cargo run -p aiq-runner -- validate \
  --public-tasks benchmarks/examples/tasks
```

## Subscription smokes

The smokes are ignored and opt in. Each consumes one Codex subscription attempt.

```sh
cargo make smoke-subscription
cargo make smoke-controlled-subscription
```

The public smoke uses a fixed checked-in example. The controlled smoke requires
operator-supplied private task, baseline, evaluator, corpus, runtime, toolchain,
workspace, artifact, and Codex inputs. Keep its public-safe summary separate from
private artifacts. Set `AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EXECUTION_ROOT` to a
new private absolute path outside the repository, Codex home, controlled inputs,
artifact root, and model toolchain.

## Controlled runner preparation

Before a live run:

1. Put the 72 private tasks, baseline workspaces, evaluator registry, current
   corpus commitment, Node.js runtime, and toolchain in controlled storage.
2. Verify the catalog digest is
   `sha256:b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc`.
3. Create distinct runner, verifier, and publisher Ed25519 identities.
4. Select separate absolute roots for source, task input, baseline workspaces,
   execution copies, evaluator files, replay, artifacts, checkpoints, and
   preflight output.
5. Configure the exact Codex executable, Codex home, private proxy, capability
   manifest, and approved schedule.

Use a protected credential source. Linux requires `auth.json` on a read-only
file-system mount. Local macOS validation requires a separate private Codex
home whose copied `auth.json` is owner immutable with `uchg`. Do not make the
active Codex profile immutable.

Use CLI help as the exact command authority:

```sh
cargo run -p aiq-runner -- admit-permissions --help
cargo run -p aiq-runner -- preflight --help
cargo run -p aiq-runner -- run --help
```

For Official work, run `admit-permissions` before paid preflight. It validates the
exact 72-by-17 inputs, schedule slot, conservative capacity, jobs, exclusive
managed policy, sandbox canaries, and planned preflight, checkpoint, run, score,
and package paths. Retain its private create-once
`aiq.official-permission-admission.v2` receipt and pass it as
`--official-admission` to `preflight`, `run`, `score`, and `package`. A cached or
refreshed preflight remains bound to that receipt and cannot authorize a changed
plan. Official run output uses an exact run-bound reservation; score and package
outputs are create-new. Keep every future-output parent owner-controlled and
single-writer because the runner takes nonblocking advisory locks before paid
probing and holds them through finalization.

An Official run must be non-synthetic and select the complete 17-by-72 matrix.
Repository support for admission does not prove the production managed policy has
passed. The `run` command defaults to calibration and accepts repeated `--task`
and `--model` arguments for a deterministic bounded subset. Calibration rejects
an Official admission receipt, can be replay-verified and published to its
separate public register, but never classifies or publishes as Official or ranking
eligible. Use `run --help` for the complete controlled input contract.

## Score, package, and submit

After execution:

```sh
cargo run -p aiq-runner -- score --help
cargo run -p aiq-runner -- package --help
cargo run -p aiq-runner -- submit --help
```

Keep `AIQ_RUNNER_SIGNING_KEY` only in the runner environment. `score` emits a
non-Official calibration score bundle when its saved run is calibration.
`package` binds the run's execution concurrency, signs the calibration payload,
and rejects a conflicting concurrency declaration. `submit` validates and
uploads every signed content-addressed artifact before sending the package to
`/api/submissions`. A queue receipt is not verification or publication.

`aiq-runner normalize` is an audit path that can report commitments-verified or
failed dispositions, but it cannot claim `evaluator_replayed`. Production replay
authority belongs only to `aiq-verifier`. Calibration must pass through that
verifier, which reconstructs the selected workspaces, replays evaluators,
recomputes scores and efficiency evidence, and emits the calibration stage and
attestation contracts from [Benchmark Method](benchmark-method.md).

## Bounded Official runtime

The local runtime in `deploy/official-runtime` requires Python 3.11 or newer and
a local Docker daemon reporting Linux `aarch64` with seccomp. Copy
`operator.example.toml` outside Git and supply canonical, non-overlapping,
symlink-free paths. Freeze every non-secret read-only input, keep the source
worktree clean at the declared commit, create runner writable roots as
`10001:10001` and verifier replay/record roots as `10003:10003`, and provide each
secret as a separate single-link mode-`0600` file. The manager records only secret
metadata, not secret content.

```sh
deploy/official-runtime/runtime.py create --config /controlled/operator.toml --state /controlled/runtime-state
deploy/official-runtime/runtime.py up --state /controlled/runtime-state
deploy/official-runtime/runtime.py validate --config /controlled/operator.toml --state /controlled/runtime-state
deploy/official-runtime/runtime.py receipt --config /controlled/operator.toml --state /controlled/runtime-state
```

Validation recomputes frozen-tree bindings and runs model-free canaries for the
runner sandbox, the separated networks, direct-egress denial, proxy allowlists,
and the verifier's lack of Codex access. Retain the private deployment receipt v2.
Run one runner command at a time and perform the separate permission-admission
sequence before paid work. Stop only this stack with
`runtime.py down --state /controlled/runtime-state`. The canonical path and mount
contract remains in `deploy/official-runtime/README.md`; this mechanism implements
the trust boundaries in [Architecture and Runtime](architecture-and-runtime.md)
but is not evidence of an active production worker.

## Verifier worker

Keep the verifier token and signing key only in the verifier environment. Provide
the private tasks, evaluator registry, corpus commitment, toolchain, runtime,
environment metadata, and a fresh replay root. In the bounded runtime, the
verifier has its own container, network, default-deny proxy, UID, replay root, and
record root, with no Codex binary or Codex home.

```sh
cargo run -p aiq-verifier -- --help
```

After a real package has been submitted and an operator authorizes a claim, run
one bounded worker through `aiq-verifier-entrypoint` as described by
`deploy/official-runtime/README.md`. The wrapper reads the secret files only at
worker startup, supplies them to the child, and writes create-new private JSONL
records. The worker claims bounded leases from `/api/claims`, reconstructs
workspaces, replays evaluators, and posts the stage and attestation to
`/api/verifications`. Production requires `evaluator_replayed`. For calibration,
the gateway stages the replayed evidence and immutable attestation under the
verifier role, then uses the distinct publisher role to reconcile retained
package and artifact evidence and publish only the non-Official calibration
marker. Public pages appear at `/calibrations` and `/calibrations/[id]`; absence
of rows is valid until a verified calibration has completed this transition.

## Fresh database initialization

The current production project has already completed this one-shot
initialization. Do not rerun it against that project. For a replacement empty
Supabase project, do not apply AIQ objects before initialization. Use a direct
PostgreSQL URL, not the public Data API URL.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The command uses one connection and one transaction. It rejects existing AIQ
schema or roles. The receipt must report 72 tasks, 17 model configurations, and
three production nodes. This one-shot behavior enforces the database boundary in
[Architecture and Runtime](architecture-and-runtime.md); the opt-in PostgreSQL 17
test also runs initialization twice and requires the second attempt to fail
without exposing the connection URL.

For a disposable database, run:

```sh
cargo make smoke-database
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/synthetic-demo.sql
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/integration.sql
```

`cargo make smoke-database` checks more than catalog grants: it switches to both
`anon` and `authenticated` and reads the security-invoker public views plus the
bounded trend RPC, including the bounded calibration evidence surfaces. This
exercises the public-read path described in [Architecture and Runtime](architecture-and-runtime.md).
Do not run the synthetic fixture in production.

## Web configuration

The production environment-name set below is configured for Vercel project
`acgbox/aiq`. Values remain outside Git. Preserve this name set and the
browser-safe/server-only boundary when rotating a value.

For the disposable AIQ Wiki read-only preview in the personal Vercel `acgbox`
scope/account and Supabase `ACG Box` organization, set only:

```text
AIQ_DEPLOYMENT_PROFILE=preview
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

Initialize that database with `cargo make init-preview-database`. The preview
profile fails closed unless Supabase exposes one exact preview-status row. That
row verifies the required 17-configuration shape, cardinalities, scoring
definition, synthetic-only boundary, and empty publication surface. The
application then serves explicitly synthetic checked-in fixtures. Do not set
production gateway variables for this stage. `/api/readiness` remains `503` by
design because it checks the production write and verification dependencies. The
complete setup and disposal boundary are in [Deployment Handoff](deployment-handoff.md).

To test the initialized database through loopback PostgREST and the built Next.js
application, run:

```sh
AIQ_PREVIEW_POSTGREST_URL='http://127.0.0.1:4180' \
cargo make smoke-preview-web
```

The smoke requires one canonical loopback HTTP origin. It checks the live anon
read path, all public pages and trend ranges, the 17 configurations, one 72-task
synthetic run, mobile overflow, accessibility, preview labels, `noindex`, and the
expected readiness `503`. The database initializer's real PostgreSQL 17 test is
separately opt in through `AIQ_DATABASE_PREVIEW_TEST_URL` and
`AIQ_DATABASE_PREVIEW_TEST_PSQL`.

For production, leave `AIQ_DEPLOYMENT_PROFILE` absent.

Set browser-safe values:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

Set server-only values:

```text
SUPABASE_URL
SUPABASE_SECRET_KEY
AIQ_RUNNER_SUBMISSION_TOKEN
AIQ_SUBMISSION_PACKAGE_BUCKET
AIQ_RUNNER_ARTIFACT_BUCKET
AIQ_VERIFIER_INGRESS_TOKEN
AIQ_SUPABASE_PUBLISHABLE_KEY
AIQ_SUPABASE_JWT_PRIVATE_JWK
AIQ_PUBLISHER_NODE_ID
```

Never add a `NEXT_PUBLIC_` alias for a server value.

Validate the Web application. On a fresh host, install the pinned Playwright
browsers first, as the checked-in CI job does:

```sh
npm exec --workspace @aiq/wiki-web -- \
  playwright install --with-deps chromium firefox webkit
npm run check
npm run lint
npm run test --workspace @aiq/wiki-web
npm run build --workspace @aiq/wiki-web
npm run test:browser --workspace @aiq/wiki-web
```

To validate a real PostgREST-to-Next public-read chain against a freshly
initialized disposable database, supply its loopback PostgREST origin:

```sh
AIQ_LIVE_POSTGREST_URL='http://127.0.0.1:4178' \
cargo make smoke-live-web
```

Local PostgREST must expose only `public` and use `anon` as its anonymous role.
The test harness supplies a fixed non-secret publishable-key-shaped value. Its
loopback proxy supplies the `/rest/v1` prefix that Supabase adds in production.

## Storage lifecycle

Both configured buckets must be private. The submission gateway registers exact
object digests and byte counts before queueing. The verifier resolves only
claim-bound objects.

Run one explicit lifecycle mode per invocation:

```sh
AIQ_STORAGE_LIFECYCLE_MODE=reconcile npm run storage:lifecycle
AIQ_STORAGE_LIFECYCLE_MODE=delete npm run storage:lifecycle
```

Run reconciliation first. Inspect unresolved mismatches before deletion. Active
references and legal holds block deletion.

## Failure handling

- If fresh database initialization fails after work starts, do not reuse the
  target. Inspect protected PostgreSQL logs, correct the input, and create a new
  empty project.
- If initialization rejects existing AIQ objects, the rejected attempt made no
  changes. Use a new project for the greenfield launch.
- If submission fails after Storage upload, preserve the object and run
  reconciliation.
- If a verifier lease expires, let the bounded claim protocol retry it.
- If a run stops, preserve the checkpoint and artifact root before resuming.
- Do not publish incomplete, synthetic, or identity-colliding production data.
