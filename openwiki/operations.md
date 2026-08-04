---
type: 'Operations'
title: 'Operations and Validation'
description: 'Local validation, runner, verifier, database, Web, and Storage procedures.'
tags: ['operations', 'validation', 'runbook']
---

# Operations and Validation

## Release status

AIQ production is live at `https://aiq.wiki` from the approved source. Vercel
scope `acgbox` hosts project `aiq`; Supabase organization `ACG Box` hosts project
`aiq` on PostgreSQL 17.6 with reference `xxnszykaeapolqdnhalx` and private
`aiq-submission-packages` and `aiq-runner-artifacts` buckets. The first Official
launch publication was deployed from merge commit
`725b88954359ab8f0950f896674b3e8684d3ae85`. This commit is historical launch
evidence, not the identity of every later production deployment. The apex is
canonical, and `www.aiq.wiki` returns a path-preserving permanent `308`
redirect. Automatic Vercel project and branch aliases can be removed only
transiently because a later deployment can recreate or reassign them. A
deployment-specific URL is intrinsic to its retained deployment. The current
generated Vercel surfaces emit `noindex`.

The live production data remains one real, non-synthetic historical Official
AIQ Core `1.0.2` matrix. The native Apple Silicon macOS runner completed its 17
configurations and 72 tasks each, or 1,224
task-level results. The native verifier replayed it, and the distinct publisher
published it as `trusted_verified`. Of the results, 1,218 completed and 6
failed. Outcomes are 329 `correct`, 259 `partial`, 630 `incorrect`, 5 `timeout`,
and 1 `budget_exhausted`. Signed batch wall time is 5,844,411 ms
(`1:37:24.411`). Cost coverage is 1,208
`estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage`. The $125.403257240 subtotal is a Standard
API-equivalent estimate for priced results, not actual ChatGPT subscription
spend or a complete matrix total. Missing values are not zero. See
[Benchmark Method](benchmark-method.md) for evidence semantics and
[Deployment Handoff](deployment-handoff.md) for production acceptance checks.

Public views contain 17 runs, 1,224 results, 17 leaderboard rows, 17
model-efficiency rows, and 17 model-matrix rows. Publication created 4,395
artifact bindings, including 19 capability artifacts.

Repository source now accepts AIQ Core and scoring `1.0.3`. Final native build
verification, operator acceptance of that build, the first `1.0.3` run, and
publication are pending; this source-head change does not claim that `1.0.3` is
live.

No cloud runner or verifier worker and no recurring benchmark or Storage
schedule exist. The repository validates supplied schedule occurrences but does
not create a scheduler. The twice-daily benchmark schedule and its next run are
pending operator work; do not authorize recurring automation through this
runbook.

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
   `sha256:0e315fe2bbcf0efe59ddcd69173addf89ef0fb281ec3ef523234bdc01b3d66a1`,
   the release-policy identity is `aiq-core/1.0.3`, and the catalog
   release-identity digest is
   `sha256:0dd4f11c49a1e295a75e6ca1e3b7b4f9c38e0160b9eda75ca75a47703e47f80d`.
   Verify scorer-manifest identity
   `sha256:c898902ef5a604ce2db735819c98d7ebb127733b069bb69bd9a32e26cca8ba4d`
   and evaluator identity
   `sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`.
   Verify runtime `task_set_hash`
   `sha256:1a7a8e5f37efeb03cf3a2a92a94370ef67ec3b7a6eb385bd5ec3c844713afb0e`.
   Do not substitute controlled generated-task tree identity
   `sha256:cb5c72fc4ce31c40afd078ddc644177148000ee4792303312b58df7054881145`.
   Create new source-only Core and Contrast corpus commitments from the final
   clean source. Keep `runner.identity_kind` as `source_only` and
   `runner.built_binary_sha256` as null. Keep the Node.js and ripgrep identities
   in each corpus. This source-only rule and the signed per-run runner and Codex
   executable provenance are the executable product contracts.
3. Create distinct runner, verifier, and publisher Ed25519 identities.
4. Select separate absolute roots for source, task input, baseline workspaces,
   execution copies, evaluator files, replay, artifacts, checkpoints, and
   preflight output.
5. Configure the exact native Codex executable, separate Codex home, capability
   manifest, and approved schedule.

Use a separate private Codex home whose copied `auth.json` is owner immutable
with `uchg`. Do not make the active Codex profile immutable. Build
`aiq-runner` and `aiq-verifier` with `cargo build --locked --release`. After the
final clean build, the operator generates a private, unsigned audit receipt.
Record the exact source commit and tree identity and SHA-256 values for the
native runner, verifier, Node.js, and ripgrep executables. Retain the receipt with
private release records. The repository does not validate or publish it, and it
is not a database input. Bind the actual runner and Codex executables in the run
plan and signed per-run provenance.

Use CLI help as the exact command authority:

```sh
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
cargo run -p aiq-runner -- admit-permissions --help
cargo run -p aiq-runner -- preflight --help
cargo run -p aiq-runner -- run --help
```

Run both model-free corpus validators before `admit-permissions`. They validate
the controlled 72-task AIQ Core corpus and the separate six-unit Contrast
corpus. Their shared Rust validator now fails closed unless each runner subtree uses
`identity_kind: source_only` with a null `built_binary_sha256`. The checked Core
JSON schema enforces the same rule. Contrast has equivalent shared typed
enforcement even though it has no separate checked-in JSON schema.

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
paid run. The current production publication used one complete 17-by-72
Official matrix.

## Verifier worker

Keep the verifier token and signing key only in the verifier environment. Provide
the private tasks, evaluator registry, corpus commitment, toolchain, runtime,
environment metadata, and a fresh replay root. Do not provide the Codex home or
runner signing key to the verifier process.

```sh
cargo run -p aiq-verifier -- --help
```

Use bounded replay parallelism for new claims. The default is four workers. Set
it explicitly when controlled evidence must record the selected value:

```sh
target/release/aiq-verifier --replay-jobs 4 ...
```

The default initial claim lease is 300 seconds. The worker maintains it every 300
seconds and renews it for 900 seconds while processing a package. Each gateway
request has a default 120-second timeout. After replay, gateway HTTP `408`,
`409`, `429`, and `5xx` responses retry the same prepared verification request
under the maintained lease. Other `4xx` responses are terminal. The default
retry budget is three attempts with exponential backoff that starts at 250 ms.
When that budget is exhausted, the worker acknowledges the claim so the queue
can retry it.

After a real package has been submitted and an operator authorizes a claim, run
the native verifier for one bounded lease. The worker emits one compact
`aiq.verifier-record.v2` JSON object to standard output after each claimed
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

AIQ Core `1.0.3` uses one greenfield desired state. For the current pre-launch
Supabase project, first verify the accepted private and public backups, remove
the historical AIQ schema and AIQ-owned roles in one operator-controlled reset,
remove the exact AIQ-owned public views and RPC overloads after reviewing the
live dependency closure, and then use this flow against that empty AIQ namespace.
Preserve Supabase-managed schemas, roles, extensions, and every non-AIQ object.
Do not run a migration chain or preserve a second compatibility state. Do not
apply any AIQ objects before initialization. Use a direct PostgreSQL URL, not the
public Data API URL.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The command uses one connection and one transaction. It rejects existing AIQ
schema or roles. After the controlled corpus passes the model-free checks and
the operator verifies the final native build as specified in
[Deployment Handoff](deployment-handoff.md), prepare a separately controlled
production reference containing a non-synthetic AIQ Core `1.0.3` corpus
commitment, a canonical millisecond UTC `published_at`, and the three production
identities. Retain the private final-build audit receipt separately; database
initialization does not consume or validate it. Initialization validates the
production-reference fields and bindings. The repository defines one greenfield
desired state. The initialization receipt must report scoring `1.0.3`,
both catalog identities, 72 tasks, 17 model configurations, three production
nodes, 40 private tables with enabled and forced RLS, 12 security-invoker public
views, and two hardened gateway roles. This one-shot behavior enforces the
database boundary in [Architecture and Runtime](architecture-and-runtime.md);
the opt-in PostgreSQL 17 test also runs initialization twice and requires the
second attempt to fail without exposing the connection URL.

Against an already initialized disposable production-shape database, run the
read/RLS smoke test and the rollback-only calibration publication proof:

```sh
AIQ_DATABASE_URL='<direct-connection-url>' cargo make smoke-database
AIQ_DATABASE_URL='<direct-connection-url>' \
  cargo make smoke-calibration-database
```

For the separate deterministic SQL integration flow, start with a fresh
disposable PostgreSQL 17 database and apply this exact sequence. Do not use the
database created by `init-database`:

```sh
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/schema.sql
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

When changing claim-bound artifact resolution, run the PostgreSQL 17 concurrency
regression against the freshly initialized disposable database:

```sh
AIQ_DATABASE_CONCURRENCY_TEST_PSQL=psql \
AIQ_DATABASE_CONCURRENCY_TEST_URL="$AIQ_DATABASE_URL" \
cargo make test-database-concurrency
```

The resolver locks the submission claim row before artifact binding can enter the
shared Storage deletion gate. This lock order serializes all artifact resolutions
for one lease and prevents parallel replay workers from deadlocking while retaining
one immutable binding, activation event, and active Storage reference per artifact.
The test blocks all six supported artifact kinds at the gate, releases them
concurrently, rejects SQLSTATE `40P01`, and repeats three parallel waves to prove
idempotence. CI runs this check against PostgreSQL 17.

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

After publishing an Official matrix or changing the production deployment, run
the bounded, secret-free production browser acceptance gate:

```sh
AIQ_PRODUCTION_ORIGIN=https://aiq.wiki npm run test:browser:production
```

Page traffic is read-only. The gate also sends intentional unauthenticated POST
probes to five write routes and requires uncached `401` responses with no public
side effects. It checks the exact 17-run and 1,224-result public inventory,
efficiency semantics, readiness response, mobile layout, and selected
accessibility rules. It deliberately fails when later runs appear until the
release contract is revised. Use
`npm run test:browser:production-contract --workspace @aiq/web` for the local
published-data mock. These commands validate the public surface accepted in
[Deployment Handoff](deployment-handoff.md); they do not start a server, deploy
resources, or create recurring automation.

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

- If fresh database initialization fails, inspect protected PostgreSQL logs and
  confirm that the transaction rolled back. Retry only after the AIQ namespace
  is empty.
- If initialization rejects existing AIQ objects, the rejected attempt made no
  changes. Verify the backups, remove only the exact historical AIQ objects, and
  retry the one greenfield initialization. Do not add a migration chain.
- If submission fails after Storage upload, preserve the object and run
  reconciliation.
- If a verifier lease expires, let the bounded claim protocol retry it.
- If a run stops, preserve the checkpoint and artifact root before resuming.
- Do not publish incomplete, synthetic, or identity-colliding production data.
