---
type: 'Operations'
title: 'Operations and Validation'
description: 'Local validation, runner, verifier, database, Web, and Storage procedures.'
tags: ['operations', 'validation', 'runbook']
---

# Operations and Validation

## Release status

Release acceptance is not complete. The intended personal resources are
Supabase organization `ACG Box`, Supabase project `aiq`, Vercel scope `acgbox`,
Vercel project `aiq`, and apex domain `https://aiq.wiki`. Do not infer their
current external state from repository text. Record it only after live checks.

Repository head defines one greenfield AIQ Core `1.0.2` contract, scoring
`1.0.2`, and one 12-view database desired state. A real Official run has not
started. The only Official path is the native macOS run, native verifier replay,
production publication, domain checks, and public read validation described
below.

## Toolchain

Use Node.js `24.15.0` or newer, npm `11.17.0` or newer, Rust `1.97.1`, and the
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
2. Verify the ordered task-metadata catalog digest is
   `sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937`,
   the release-policy identity is `aiq-core/1.0.2`, and the catalog
   release-identity digest is
   `sha256:54e8010f9c9ebc187574015dd6f8a62fd8025884d86c5cdd0d581551ab6095a6`.
3. Create distinct runner, verifier, and publisher Ed25519 identities.
4. Select separate absolute roots for source, task input, baseline workspaces,
   execution copies, evaluator files, replay, artifacts, checkpoints, and
   preflight output.
5. Configure the exact native Codex executable, separate Codex home, capability
   manifest, and approved schedule.

Use a separate private Codex home whose copied `auth.json` is owner immutable
with `uchg`. Do not make the active Codex profile immutable. Build
`aiq-runner` and `aiq-verifier` with `cargo build --locked --release`; bind the
exact Mach-O arm64 executable digests in the controlled corpus and run plan.

Use CLI help as the exact command authority:

```sh
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
cargo run -p aiq-runner -- admit-permissions --help
cargo run -p aiq-runner -- preflight --help
cargo run -p aiq-runner -- run --help
```

Run both model-free corpus validators before `admit-permissions`. They validate
the controlled 72-task AIQ Core corpus and the separate six-unit contrast corpus.

For Official work, run `admit-permissions` before paid preflight. It validates the
exact 72-by-17 inputs, schedule slot, conservative capacity, jobs, and planned
preflight, checkpoint, run, score, and package paths. The runner invokes Codex
with `--strict-config`, selects the explicit `aiq_benchmark` profile, disables
profile network access, and runs the sandbox canaries. External managed
requirements must be absent: remove any requirements file or provider-managed
requirements instead of installing the deleted
`config/codex-requirements.example.toml`. Any externally reported requirements
make the Official admission ineligible before a model is invoked. Retain the
private create-once `aiq.official-permission-admission.v2` receipt and pass it as
`--official-admission` to `preflight`, `run`, `score`, and `package`. A cached or
refreshed preflight remains bound to that receipt and cannot authorize a changed
plan. Official run output uses an exact run-bound reservation; score and package
outputs are create-new. Keep every future-output parent owner-controlled and
single-writer because the runner takes nonblocking advisory locks before paid
probing and holds them through finalization.

An Official run must be non-synthetic and select the complete 17-by-72 matrix.
Repository support for admission does not prove that the production permission
canaries pass on the selected host. The `run` command defaults to calibration
and accepts repeated `--task` and `--model` arguments for a deterministic
bounded subset. Calibration rejects
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

Expose the signing key only to `package` and the submission token only to
`submit`. Keep each secret in a distinct mode-`0600`, single-link file outside
the source repository and load it only for the active command. `score` emits a
non-Official calibration score bundle when its saved run is calibration.
`package` binds the run's execution concurrency, signs the calibration payload,
and rejects a conflicting concurrency declaration. `submit` validates and
uploads every signed content-addressed artifact before sending the package to
`/api/submissions`. It keeps at most eight artifact uploads in flight by default.
Use `--artifact-upload-concurrency` to select a value from 1 through 32 when the
controlled network requires a different bound. One shared HTTPS connection pool
serves the submission. Network failures, timeouts, HTTP 408, HTTP 429, and HTTP
5xx responses get at most three total attempts with a fixed 500 ms delay. Other
HTTP 4xx responses are terminal. The Web gateway records
`request_context.source` as `aiq-web` when it enqueues the submission. A queue
receipt is not verification or publication.

`aiq-runner normalize` is an audit path that can report commitments-verified or
failed dispositions, but it cannot claim `evaluator_replayed`. Production replay
authority belongs only to `aiq-verifier`. Calibration must pass through that
verifier, which reconstructs the selected workspaces, replays evaluators,
recomputes scores and efficiency evidence, and emits the calibration stage and
attestation contracts from [Benchmark Method](benchmark-method.md).

## Native macOS Official runtime

Run the release binaries directly on the controlled Apple Silicon host. Keep the
source worktree clean at the declared commit. Keep private inputs and all output
roots canonical, non-overlapping, symlink-free, and writable only by the current
user. The runner uses the host's direct Codex connection. Linux and Docker remain
future deployment targets; first-release commands and acceptance run natively on
the Mac.

Run the Official commands one at a time in this order:

```text
target/release/aiq-runner admit-permissions ...
target/release/aiq-runner preflight ...
target/release/aiq-runner run ...
target/release/aiq-runner score ...
target/release/aiq-runner package ...
target/release/aiq-runner submit ...
```

`admit-permissions` is model-free. `preflight` is the first paid step. Only its
exact configuration probes and runnable task cells in `run` invoke models.
`score`, `package`, `submit`, verifier replay, and publication are model-free.
Pass the same private admission receipt through preflight, run, score, and
package. Keep the checkpoint, run reservation, artifacts, and preflight cache
after an interruption; resume the unchanged run instead of creating another
paid run. The first release executes one complete 17-by-72 Official matrix.

## Verifier worker

Keep the verifier token and signing key only in the verifier environment. Provide
the private tasks, evaluator registry, corpus commitment, toolchain, runtime,
environment metadata, and a fresh replay root. Do not provide the Codex home or
runner signing key to the verifier process.

```sh
cargo run -p aiq-verifier -- --help
```

After a real package has been submitted and an operator authorizes a claim, run
the native verifier for one bounded lease. The worker emits one compact
`aiq.verifier-record.v1` JSON object to standard output after each claimed
package. If the operator retains these objects in a create-once private JSONL
file, the operator shell owns that redirection and file creation. Offline
`verify-local` stage and attestation files are separate create-new outputs and
are not publication. The worker claims the lease from `/api/claims`,
reconstructs workspaces, replays evaluators, and posts the stage and attestation
to `/api/verifications`. Production requires `evaluator_replayed`. For calibration,
the gateway stages the replayed evidence and immutable attestation under the
verifier role, then uses the distinct publisher role to reconcile retained
package and artifact evidence and publish only the non-Official calibration
marker. Public pages appear at `/calibrations` and `/calibrations/[id]`; absence
of rows is valid until a verified calibration has completed this transition.

## Fresh database initialization

Create an empty Supabase database for this greenfield release. Do not apply any
AIQ objects before initialization. Use a direct PostgreSQL URL, not the public
Data API URL.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The command uses one connection and one transaction. It rejects existing AIQ
schema or roles. After the controlled corpus and final native binaries pass the
model-free checks in [Deployment Handoff](deployment-handoff.md), prepare a
separately controlled production reference containing a non-synthetic AIQ Core `1.0.2` corpus
commitment, a canonical millisecond UTC `published_at`, and the three production
identities. Initialization validates those fields and bindings. The repository
defines one greenfield desired state. The receipt
must report scoring `1.0.2`, both catalog identities, 72 tasks, 17 model
configurations, and three production nodes. This one-shot behavior enforces the
database boundary in [Architecture and Runtime](architecture-and-runtime.md);
the opt-in PostgreSQL 17 test also runs initialization twice and requires the
second attempt to fail without exposing the connection URL.

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

Configure the production environment-name set below for Vercel project
`acgbox/aiq`. Values remain outside Git. Preserve this name set and the
browser-safe/server-only boundary when rotating a value.

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
npm exec --workspace @aiq/web -- \
  playwright install --with-deps chromium firefox webkit
npm run check
npm run lint
npm run test --workspace @aiq/web
npm run build --workspace @aiq/web
npm run test:browser --workspace @aiq/web
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
