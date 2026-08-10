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
`aiq-submission-packages` and `aiq-runner-artifacts` buckets. DNS handoff remains
in the personal Cloudflare account that owns `aiq.wiki`. The apex is
canonical, and `www.aiq.wiki` returns a path-preserving permanent `308`
redirect. Automatic Vercel project and branch aliases can be removed only
transiently because a later deployment can recreate or reassign them. A
deployment-specific URL is intrinsic to its retained deployment. The current
generated Vercel surfaces emit `noindex`.

The only production tuple is AIQ Core `1.0.7`, task scorer `1.0.6`, aggregate
scorer `1.0.8`, and measurement `2.0.0`. Production must remain without an
Official AIQ 2.0 publication until the retained complete calibration is replayed
without model calls to establish the fixed bank and a separate real signed
17-by-72 package passes native verifier replay. A
legacy publication is not a compatibility source or fallback. See [Benchmark
Method](benchmark-method.md) for evidence semantics and [Deployment
Handoff](deployment-handoff.md) for production acceptance checks.

Repository source now targets the public AIQ Core `1.0.7` candidate. Its task
scorer remains `1.0.6` and aggregate scorer is `1.0.8`. Its public metadata digest is
`sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1`,
and its public release digest is
`sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae`.
The public catalog is deterministic and identity-frozen. The prior controlled
tree and database commitment bind the retired bounded policy. Fresh independent
Core and Contrast seals, policy-v2 replay of the retained complete calibration,
fixed-bank admission v3, a real Official run, publication, and final deployment
are pending. This pre-release state does not claim that an Official production
matrix is live.

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

The single aggregate repository gate is:

```sh
cargo make verify
```

It runs formatting, static contracts, lint, all unit and integration tests, the
Rust build, one Web production build, and every local browser suite. Do not run
the component tasks before or after it in the same pass. Use
`cargo make test-typescript-coverage` only when a coverage report is needed.

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
   `sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1`,
   the release-policy identity is `aiq-core/1.0.7`, and the public catalog
   release-identity digest is
   `sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae`.
   Use the final clean-commit controlled regeneration for admission binding.
   Keep its scorer-manifest, evaluator, runtime task-set, generated-task tree,
   task-commitment manifest, and Core corpus identities distinct. Generate the
   separate Contrast corpus before release admission. Do not substitute one
   identity for another.
   Create new source-only Core and Contrast corpus commitments from the final
   clean source. Keep `runner.identity_kind` as `source_only` and
   `runner.built_binary_sha256` as null. Keep the Node.js and ripgrep identities
   in each corpus. This source-only rule and the signed per-run runner and Codex
   executable provenance are the executable product contracts.
3. Create distinct runner, verifier, and publisher Ed25519 identities.
4. Select separate absolute roots for source, task input, baseline workspaces,
   execution copies, evaluator files, replay, artifacts, checkpoints, and
   preflight output.
5. Create a private runtime directory that contains exactly the native `codex`
   executable and its `codex-code-mode-host` sibling. Configure that exact
   `codex` path, the separate Codex home, capability manifest, and approved
   schedule.

Use a separate private Codex home whose `auth.json` is copied from
`~/.codex/auth.json`, set to mode `0600`, and owner immutable with `uchg`. Do not
make the active Codex profile immutable. Build
`aiq-runner` and `aiq-verifier` with `cargo build --locked --release`. After the
final clean build, the operator generates a private, unsigned
`aiq.final-build-receipt.v2`. Record the exact source commit and tree identity
and SHA-256 values for the native runner, verifier, Codex executable, and Codex
code-mode host. Retain the receipt with private release records. The offline
native verifier validates it against the independently supplied receipt digest;
it is not a database input or public artifact. Node.js and ripgrep identities
remain bound by the corpus. Bind the actual runner and both Codex runtime
executables in the run plan and signed per-run provenance.

Pass the isolated home to every paid runner boundary with
`--codex-home "$AIQ_RELEASE_CODEX_HOME"`. The runner clears the inherited
environment and injects this directory as the Codex subprocess `CODEX_HOME`.
Do not set the shell's global `CODEX_HOME`, and do not give this directory to the
verifier. Preflight marks a configuration available only after Codex completes exactly
one command and writes the fixed 36-byte `AIQ_CAPABILITY_COMMAND_AND_WRITE_V1`
marker in a fresh disposable workspace. The runner retains it as
`capability-marker.txt`; the verifier resolves and checks those exact bytes
before publication. It does not invoke Codex or receive Codex credentials.

Use CLI help as the exact command authority:

```sh
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
cargo run -p aiq-runner -- seal-corpus --help
cargo run -p aiq-runner -- admit-permissions --help
cargo run -p aiq-runner -- preflight --help
cargo run -p aiq-runner -- run --help
```

Run both model-free corpus validators before `admit-permissions`. They validate
the controlled 72-task AIQ Core corpus and the separate six-unit Contrast
corpus. Their shared Rust validator now fails closed unless each runner subtree uses
`identity_kind: source_only` with a null `built_binary_sha256`. The checked Core
JSON schema enforces the same rule. Contrast has equivalent shared typed
enforcement even though it has no separate checked-in JSON schema. Contrast is
an operator-enforced release gate before admission. It is not an input to the
Official admission receipt and does not add cells to the 1,224-cell matrix.

Use `seal-corpus` to create a new complete Core or Contrast seal from retained
controlled assets. This is unchanged-corpus sealing, not task-content generation
and not predecessor commitment patching. Supply the exact task, baseline,
acceptance, evaluator, Node.js plus ripgrep, source, and typed runtime-authority
inputs. The command derives versioned fixture, acceptance, leakage-review,
harness, source, and runtime identities. It installs one new private directory
atomically only after the production corpus validator and every runtime baseline
manifest check pass. The sealed evaluator runtime resolves to the single Node
executable under `toolchain`; no second runtime copy is retained. Run it
independently for candidate A and candidate B, then
require recursive byte equality between their complete sealed output directories
before release use. Successful stdout is the canonical commitment digest required
by the Contrast validator. The acceptance directory must satisfy the
corpus-kind policy: Core requires `adversarial_format`, `alternate_correct`,
`gold`, and `partial`, permits only the reviewed optional classes `empty` and
`timeout`, and records the observed classes per task; Contrast requires exactly
`challenge`, `empty`, `format`, `near_miss`, `reference`, and `tamper` with no
optional classes. The generated authoring input and harness manifests preserve
those required, optional, and per-task class lists for independent validation.
Do not use temporary `jq`-modified commitments or diagnostic r13/r14 outputs as
sealer inputs.

For each corpus kind, run the same command twice with independent retained input
copies and different new output paths. The release identifier must be the same
because it is part of the sealed identity. Substitute only controlled local paths:

```sh
cargo run --locked -p aiq-runner -- seal-corpus \
  --corpus-kind "$AIQ_CORPUS_KIND" \
  --release-id "$AIQ_RELEASE_ID" \
  --tasks-root "$AIQ_CANDIDATE_TASKS" \
  --baselines-root "$AIQ_CANDIDATE_BASELINES" \
  --acceptance-root "$AIQ_CANDIDATE_ACCEPTANCE" \
  --evaluator-root "$AIQ_CANDIDATE_EVALUATOR" \
  --evaluator-runtime "$AIQ_CANDIDATE_NODE" \
  --codex-toolchain-root "$AIQ_CANDIDATE_TOOLCHAIN" \
  --source-root "$AIQ_SOURCE_ROOT" \
  --source-commit "$AIQ_SOURCE_COMMIT" \
  --source-tree "$AIQ_SOURCE_TREE" \
  --runtime-authority "$AIQ_RUNTIME_AUTHORITY" \
  --output "$AIQ_SEALED_OUTPUT"
```

Run this once for candidate A and once for candidate B. Then require an empty
recursive comparison before either output can become release authority:

```sh
diff -ru -- "$AIQ_SEALED_CANDIDATE_A" "$AIQ_SEALED_CANDIDATE_B"
```

For Official work, run `admit-permissions` before paid preflight. It validates the
exact 72-by-17 inputs, schedule slot, jobs, and planned
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

Permission-canary evidence v2 retains the read-only, write-denial, and network
denial boundaries. It also directly executes the committed Node.js and ripgrep
absolute paths. A corpus, toolchain, or permission-evidence digest change
invalidates the complete downstream chain. Create a new admission, preflight,
checkpoint, run, score, package, verifier environment, replay stage, and
attestation. Do not reuse evidence from the changed plan.

An Official run must be non-synthetic and select the complete 17-by-72 matrix.
This is one run with 1,224 task-model cells, not 1,224 runs. Use the admitted
`--jobs` value throughout the plan. Capacity evidence reports the model duration
as unbounded and does not claim a schedule fit. Do not start a second scheduled
run while the first remains active.
Repository support for admission does not prove that the production permission
canaries pass on the selected host. The `run` command defaults to calibration
and accepts repeated `--task` and `--model` arguments for a deterministic
bounded subset. Calibration rejects
an Official admission receipt, can be replay-verified and published to its
separate public register, but never classifies or publishes as Official or ranking
eligible. Use `run --help` for the complete controlled input contract.

Earlier bounded runs remain immutable failed release evidence and cannot be
relabeled or mixed with the new corpus. All 72 formal model tasks use null
wall-time, step, and tool-call limits. The runner still records usage as
auxiliary evidence, and hard safety boundaries remain separate. Regenerate and
revalidate the controlled catalog, task-commitment manifest, and evaluator
bindings. The complete current calibration already exists and is replayed
without model calls. Policy v2 records the informative-task rate as a
descriptive target. It keeps complete coverage, non-uniformity, universal floor
and ceiling, domain, and model-spread checks as hard gates. An operator cannot
override a hard-gate failure. The interrupted `1.0.3` Official attempt remains
rejected, unpublished calibration evidence after an already-conclusive ceiling
failure. Do not publish hidden responses or hidden task details. Real
calibration remains permanently non-Official even after signed verifier
admission and distinct publication to the calibration register.

## Score, package, and submit

Scoring consumes evaluator-backed semantic task scores only. Elapsed time,
tokens, tool use, and estimated cost are retained as independent efficiency
evidence and never change AIQ, Rasch ability, quality, strict pass, ranking, or
intervals.

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
paid run. The accepted production publication must use one complete 17-by-72
Official matrix under the sole production tuple.

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

Use `aiq-verifier diagnose-rescore --help` for offline candidate-evaluator
diagnosis. This mode first verifies the signed source package, artifacts,
provenance, and complete source evaluator replay. It then replays the preserved
matrix cells with the candidate source, tasks, evaluators, runtime, and
toolchain. Its output is one create-new, permanently non-Official and
non-ranking diagnostic. The command cannot publish and does not create a stage
or attestation.

Use `aiq-runner historical-diagnostic-rescore --help` only for preserved
legacy result arrays whose runtime failures incorrectly carried a zero task
score. It normalizes those cells in memory, recomputes coverage-only reports,
and writes an explicitly non-Official, non-ranking diagnostic. It never mutates
the source file, signs evidence, or enters a publication path.

## Fresh database initialization

AIQ Core `1.0.7` uses one greenfield desired state with no migration chain. Use
this flow with the existing target Supabase project after its AIQ namespace is
empty. If residue exists, remove only `aiq_private`, the AIQ-owned roles, and the
exact AIQ-owned public views and RPC overloads. Preserve all Supabase-managed and
non-AIQ objects. This cleanup is a deployment prerequisite, not a migration or
compatibility path. Do not apply AIQ objects or create AIQ Storage buckets
before initialization. Do not reset or initialize until the new real signed
17-by-72 package passes native verifier replay. Use the exact direct or
port-5432 session-pooler PostgreSQL URL, not the public Data API URL.

```sh
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The command uses one connection and one transaction. It rejects existing AIQ
schema or roles. After the controlled corpus passes the model-free checks and
the operator verifies the final native build as specified in
[Deployment Handoff](deployment-handoff.md), prepare a separately controlled
production reference containing a non-synthetic AIQ Core `1.0.7` corpus
commitment, a canonical millisecond UTC `published_at`, and the three production
identities. Retain the private final-build audit receipt separately; database
initialization does not consume or validate it. Initialization validates the
production-reference fields and bindings. The repository defines one greenfield
desired state. The initialization receipt must report aggregate scoring `1.0.8`,
both catalog identities, 72 tasks, 17 model configurations, three production
nodes, 40 private tables with enabled and forced RLS, 12 security-invoker public
views, and two hardened gateway roles. This one-shot behavior enforces the
database boundary in [Architecture and Runtime](architecture-and-runtime.md);
the opt-in PostgreSQL 17 test also runs initialization twice and requires the
second attempt to fail without exposing the connection URL.

Against an already initialized disposable production-shape database, run the
read/RLS smoke test and the rollback-only calibration publication proof:

```sh
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' cargo make smoke-database
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' \
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
cargo make verify
```

For a Web-only rerun, `npm run test:browser --workspace @aiq/web` builds once and
runs all local browser suites. Do not also run its individual suite scripts.

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
AIQ_PRODUCTION_ORIGIN='https://aiq.wiki' \
AIQ_PRODUCTION_EXPECTED_BENCHMARK_VERSION='<benchmark-version>' \
AIQ_PRODUCTION_EXPECTED_SCORING_VERSION='<scoring-version>' \
AIQ_PRODUCTION_EXPECTED_MATRIX_BATCH_ID='<run_sha256-id>' \
AIQ_PRODUCTION_EXPECTED_RUNNER_COMMIT='<git-commit>' \
AIQ_PRODUCTION_EXPECTED_CORPUS_RELEASE_ID='<corpus-release-id>' \
AIQ_PRODUCTION_EXPECTED_CORPUS_COMMITMENT='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_CATALOG_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_TASK_SET_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_PROMPT_SET_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_ESTIMATED_COST_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_CONTEXT_BAND_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_MISSING_USAGE_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_PRICED_COST_SUBTOTAL_USD_NANOS='<integer-nanodollars>' \
npm run test:browser:production --workspace @aiq/web
```

Page traffic is read-only. The gate also sends intentional unauthenticated POST
probes to five write routes and requires uncached `401` responses with no public
side effects. It checks the exact 17-run and 1,224-result public inventory,
efficiency semantics, readiness response, mobile layout, selected accessibility
rules, exact accepted matrix-batch and runner identity, cost-status distribution,
and priced nanodollar subtotal. It deliberately fails when
later runs appear until the release contract is revised. The local
published-data mock is already part of `verify` and `test:browser`. Run
`npm run test:browser:production-contract --workspace @aiq/web` only as a
targeted rerun. These commands validate the public surface accepted in
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
  changes. Remove only the exact AIQ-owned objects, preserve all
  Supabase-managed and non-AIQ objects, and retry the existing target after its
  AIQ namespace is empty.
- If submission fails after Storage upload, preserve the object and run
  reconciliation.
- If a verifier lease expires, let the bounded claim protocol retry it.
- If a run stops, preserve the checkpoint and artifact root before resuming.
- Do not publish incomplete, synthetic, or identity-colliding production data.
