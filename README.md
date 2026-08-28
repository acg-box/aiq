# AIQ

AIQ records fixed-fixture AI and agent benchmark results. The repository
contains a Rust runner, a Rust verifier, a Next.js application, the public AIQ
Core catalog, and one declarative PostgreSQL schema.

AIQ production is live at [aiq.wiki](https://aiq.wiki). The personal Vercel
scope `acgbox` hosts project `aiq`. The personal Supabase organization `ACG Box`
hosts project `aiq` on PostgreSQL 17.6 with reference
`xxnszykaeapolqdnhalx`. The personal Cloudflare account that owns the
`aiq.wiki` zone owns DNS handoff. Production uses the private Storage buckets
`aiq-submission-packages` and `aiq-runner-artifacts`.

The only production tuple is AIQ Core `1.0.7`, task scorer `1.0.6`, aggregate
scoring `1.0.8`, and measurement `2.0.0`. Do not publish, preserve online,
migrate, or display a legacy tuple as production evidence. Production must
remain without an Official AIQ 2.0 publication until the retained complete,
non-synthetic, signed 17-by-72 calibration is replayed under policy v2 to
establish the fixed item bank and admission v3, and
a separate fresh 17-by-72 Official package passes native verifier replay and
all release gates.

Formal calibration and Official model and evaluator work has no
benchmark-enforced wall-time, step, tool-call, aggregate-evaluator, or
per-check deadline. The runner separately measures model and evaluator elapsed
time, agent steps, tool calls by type, tokens, and estimated cost. These values are auxiliary
evidence only and cannot change task score, AIQ, quality, strict pass, interval,
eligibility, or ranking. Functional preflight and hard safety boundaries remain
separate. A safety, runtime, provider, or infrastructure termination produces a
null semantic score, never a semantic zero.

All earlier bounded or deadline-bearing runs remain immutable failed release
evidence. They cannot be relabeled, composed with selected reruns, or published
under the active tuple.

## Product contract

- Repository source targets AIQ Core `1.0.7`, with 72 private controlled tasks
  in ten domains. Task evaluation stays at `1.0.6`; aggregate scoring is
  `1.0.8`.
- Every formal task encodes `wall_seconds: null`, `max_steps: null`, and
  `max_tool_calls: null`. Controlled evaluator configuration uses
  `aiq.evaluator-config.v2` with `completion_policy: natural_completion` and no
  aggregate or per-check deadline.
- The public `1.0.7` catalog is deterministic and identity-frozen. Fresh Core
  and Contrast seals, a policy-v2 fixed-bank admission from the unchanged
  complete calibration package, a separate complete Official run, publication,
  and deployment remain pending. No earlier publication is a fallback.
- The public catalog contains metadata and commitments, not private task content.
- Task scores use committed weighted binary checks. A failed hard gate or
  structural check sets the score to zero; otherwise the evaluator divides
  passed positive weight by total positive weight. The runner commits only one
  semantic evaluator result for each sealed response and workspace. A retryable
  evaluator process failure keeps that evidence pending and reruns only the
  evaluator on resume. The independent verifier executes the evaluator once and
  compares the parsed result and exact raw output digest. A failed verifier
  invocation releases the claim for a later model-free replay. A first
  successful replay with different output also requires a later confirmation
  attempt. Publication remains blocked until one exact replay matches.
- The source-head AIQ measurement contract is `2.0.0`: the Official ranking
  score is `100 × logistic(theta)` from the admitted fixed Rasch item bank;
  theta and its conditional Wald interval are reported separately from the raw
  equal-domain `qualityScore` diagnostic. This contract is not an IQ norm or a
  150-point scale.
- Calibration policy `aiq.official-calibration-policy.v2` reports the binary
  informative-task rate and its 0.50 descriptive target, but does not use that
  count as a release cliff. Complete semantic coverage, non-uniformity,
  universal floor and ceiling limits, domain checks, and model and latent
  spread remain hard gates.
- Strict pass is strict successes divided by all attributable tasks with a
  valid semantic task score. Partial scores remain in that denominator; only
  missing, infrastructure-invalid, runtime-failed, and unscored tasks are
  excluded. `invalid_tasks` records observed runtime or infrastructure
  failures, while `missing_tasks` is reserved for an expected cell with no
  result record. Runtime failures are not semantic zeros. The Wilson interval
  uses the same sample.
- The model matrix contains 17 configurations: six Sol, six Terra, and five Luna.
- The runner performs capability preflight, executes tasks, scores results, and
  creates signed `aiq.result-package.v4` envelopes.
- Every result keeps separate runner-observed model and evaluator elapsed time
  as `latency.wall_ms` and `latency.evaluator_ms`
  and, when Codex reports it, token usage and a versioned Standard
  API-equivalent cost estimate.
- AIQ, Rasch ability, quality, strict pass, ranking, and intervals use only
  evaluator-backed semantic task scores. Elapsed time, tokens, tool use, and
  estimated cost are independent efficiency evidence and never change a score.
- Public evidence labels time as `runner_observed`, provider token source as
  `provider_reported`, and verifier-checked token and cost evidence as
  `verifier_recomputed`. Unavailable evidence remains null, not zero.
- The verifier reconstructs submitted workspaces and replays deterministic
  evaluators before it signs `aiq.verifier-attestation.v4` evidence.
- The verifier also provides an offline `diagnose-rescore` audit. It first
  verifies and replays one source package, then scores the preserved cells with
  a candidate source, task, evaluator, runtime, and toolchain set. Its
  create-new report is permanently non-Official and non-ranking. It cannot
  publish or create an attestation.
- Production uses three distinct identities: runner, verifier, and publisher.
- The Web application reads public database views and sends controlled writes
  through server routes.

The source-head ordered task-metadata catalog digest is:

```text
sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1
```

Its public release digest is
`sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae`.
The release-policy identity is `aiq-core/1.0.7`. Do not infer any controlled
identity from these public digests. The reviewed evaluator identity is
`sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`.
The current no-deadline public-safe database task-set identity is
`sha256:777dc72d782a274e654bc8fa61479908c244675b148755fb36bb2c28a89acd72`,
and its task-commitment manifest identity is
`sha256:e3ab152dedd0182750ab59bce83efdf85a2e7b71288f11f57d7530ea96f3e30d`.
These are checked-in pre-seal bindings. Seal Core and Contrast twice from the
final clean identity commit, then run both model-free validators. Final
controlled corpus identities remain provisional until calibration accepts the
candidate.
The checked Core schema
requires `runner.identity_kind` to remain `source_only` and
`runner.built_binary_sha256` to remain null. The shared Rust validator now fails
closed on this runner subtree for both Core and Contrast. Contrast does not have
a separate checked-in JSON schema. Each corpus also binds the Node.js and ripgrep
identities. The source-only corpus rule and signed per-run runner and complete
Codex runtime provenance are the executable product contracts. The Codex runtime
is one private directory that contains exactly the `codex` executable and its
`codex-code-mode-host` sibling. After the final clean build, the operator retains
a private, unsigned audit receipt with the exact source commit and tree identity
and SHA-256 values for the native runner, verifier, Codex executable, and Codex
code-mode host. The offline native verifier validates this receipt against an
independently supplied receipt digest. It is not a database input or published
artifact. Node.js and ripgrep remain bound by the corpus commitment. Do not infer
a runtime hash from a generated-task tree digest. The accepted AIQ 2.0 publication
will be one batch of 17
configuration runs and 1,224 task-level executions.
Elapsed time, provider-token usage, and Standard API-equivalent cost are
reported separately from AIQ.

The Web application is a professional analysis workbench. Official evidence
presents calibrated ability with its conditional 95% interval. Synthetic fixtures
present descriptive quality with task-mix sensitivity and never appear as Official.
Scientific context also reports strict pass with a Wilson interval, sample count,
coverage, missing cells, runtime state, scoring method, and provenance. It keeps
semantic task outcomes separate from runtime, invalid, and missing cells. Cost
remains an estimated Standard API-equivalent comparison, not an actual ChatGPT or
Codex subscription bill. Charts use ECharts with SVG rendering and ARIA
descriptions. Users can select system, light, or dark color themes. Production
views must use only real evidence for the sole production tuple, not synthetic
or legacy data.

## Repository map

| Path                 | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `apps/aiq/`          | Scheduled observation orchestration, release validation, and cleanup      |
| `apps/aiq-runner/`   | Capability checks, task execution, scoring, packaging, and submission     |
| `apps/aiq-verifier/` | Queue claims, artifact reconstruction, evaluator replay, and attestations |
| `apps/web/`          | Public Next.js site and controlled server gateways                        |
| `benchmarks/`        | Public catalog, schemas, and synthetic examples                           |
| `databases/`         | Desired database state, fresh initializer, and disposable SQL checks      |
| `openwiki/`          | Architecture, method, operations, and deployment handoff                  |

Private tasks, expected outputs, controlled evaluators, signing keys, Codex
authentication, and production data must stay outside Git.

## Local synthetic demonstration

Use Node.js `24.15.0` or newer, the npm `11.17.0` version pinned by `package.json`,
the stable Rust toolchain selected by `rust-toolchain.toml`, and the locked
dependencies. `cargo make fmt`
also requires a separately managed nightly rustfmt toolchain.

```sh
npm ci --ignore-scripts
cargo run -p aiq-runner -- demo
npm run dev
```

Open `http://localhost:3000`. When both public Supabase variables are absent in
development, the site uses checked-in synthetic data. Production fails closed
when its configuration is incomplete.

Useful runner commands:

```sh
cargo run -p aiq-runner -- matrix
cargo run -p aiq-runner -- validate --public-tasks benchmarks/examples/tasks
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
cargo run -p aiq-runner -- --help
cargo run -p aiq-verifier -- --help
cargo run -p aiq-verifier -- diagnose-rescore --help
```

## Validation

Install the Playwright browsers once on a fresh host, then run the complete local
browser gate:

```sh
npm exec --workspace @aiq/web -- \
  playwright install --with-deps chromium firefox webkit
cargo make check
cargo make verify
```

`check` is the complete read-only source gate. It checks the database schema,
TypeScript, Rust and TypeScript lint rules, vstyle, and all Rust and TypeScript
tests. `verify` extends `check` with one Web build and every local browser
acceptance suite. `fmt` is an independent mutating action; it is not a dependency
of either gate. Native release builds, production browser checks, database
runtime checks, deployment, and publication remain separate contracts. Do not run
component tasks again in the same validation pass. Coverage instrumentation is
opt in with `cargo make test-typescript-coverage`.

The two subscription smokes are ignored and opt in. Each consumes one Codex
subscription attempt.

```sh
cargo make smoke-subscription
cargo make smoke-controlled-subscription
```

The public-task smoke validates a fixed example. The controlled-task smoke needs
operator-supplied private task, evaluator, corpus, runtime, workspace, and Codex
inputs. Neither smoke creates a benchmark result.

## Database initialization

`databases/schema.sql` is the sole desired database state.
`databases/init.ts` is the only production initialization entry point. There is
no migration chain. It opens
one PostgreSQL connection and applies the schema plus public reference data in
one transaction. It accepts the direct host or exact port-5432 session pooler
identity for personal Supabase project `xxnszykaeapolqdnhalx`. An explicit
test/development override accepts
only a loopback target and cannot apply in production. It rejects a database
that already contains the AIQ schema, gateway roles, or either exact AIQ
Storage bucket identity. Apply this one greenfield desired state to the existing
target project only after its AIQ namespace is empty. If AIQ residue exists, the
operator must
remove only `aiq_private`, the two AIQ gateway roles, and the exact AIQ-owned
public views and RPC overloads. Preserve all Supabase-managed and non-AIQ
objects. This cleanup is a deployment prerequisite, not a migration or
compatibility path. The schema creates the `aiq-submission-packages` and
`aiq-runner-artifacts` Storage buckets as private. The preflight rejects either
existing bucket identity. Do not create the buckets in a separate operator step.
The preflight enumerates the 12 canonical public view names and all public RPC
names from the desired state. It rejects every overload of those exact RPC
names without matching unrelated public objects.

```sh
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

For an empty AIQ namespace, the production reference must contain the real
controlled, non-synthetic AIQ Core `1.0.7` corpus commitment, its real canonical
`published_at` timestamp, and
exactly three public identities: runner, verifier, and publisher. Prepare it
only after the controlled corpus passes model-free validation, the operator
verifies the final native build, and one real signed non-synthetic 17-by-72
package passes native verifier replay; the repository contains no substitute
production reference. Retain the private final-build audit receipt separately.
Database initialization does not accept or validate that receipt.
A successful initialization receipt must report aggregate scoring `1.0.8`, both public
catalog identities, 72 tasks, 17 model configurations, and three nodes.

Use one initialized disposable database for production-shape smoke and
calibration publication checks:

```sh
cargo make smoke-database
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' cargo make smoke-calibration-database
```

Use a separate fresh PostgreSQL 17 database for the deterministic synthetic
flow:

```sh
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/schema.sql
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/synthetic-demo.sql
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/integration.sql
```

Do not apply the synthetic flow to the initialized production-shape database
or to production.

## Production data flow

1. The runner validates the controlled corpus, toolchain, and capability
   manifest.
2. It executes the selected tasks and runs each formal evaluator against the
   sealed model evidence. A retryable evaluator process failure keeps the model
   evidence pending for evaluator-only recovery. The runner writes
   content-addressed artifacts.
3. It scores the run, records efficiency evidence, and signs one v4 result
   package.
4. `POST /api/submissions` stores the exact package bytes and queues the package
   as unverified.
5. The verifier claims the package, reconstructs the workspaces, and executes
   each deterministic evaluator once for that claim attempt. An operational
   replay failure releases the claim for retry without changing the retained
   package or invoking a model.
6. `POST /api/verifications` stages the normalized batch and records the signed
   verifier attestation.
7. A distinct publisher identity completes publication through the gateway.
8. Public security-invoker views supply the Web application.

Official means a complete, non-synthetic 17-by-72 run with valid task-set
`1.0.7`, task-scorer `1.0.6`, aggregate-scorer `1.0.8`, and measurement `2.0.0`
bindings that completed this flow and was published as
`trusted_verified`. A complete synthetic fixture uses the
`synthetic_complete` classification, has no Official AIQ value, and is never
ranking eligible. There is one submission, native verification, and publication
path.

## Official paid-work boundary

The only Official execution and publication path runs `aiq-runner` and
`aiq-verifier` natively on the controlled Apple Silicon macOS host with direct
network access. Use the release binaries in this order:
`admit-permissions`, `preflight`, `run`, `score`, `package`, `submit`, and then
verifier replay. `admit-permissions` is model-free; `preflight` is the first paid
step. Only its exact configuration probes and runnable task cells in `run`
invoke models. Scoring, packaging, submission, verifier replay, and publication
do not invoke models. The same private admission receipt binds preflight through
package.
Provide the runner signing key only to `package`, the submission token only to
`submit`, and verifier credentials only to the verifier command.
The source runner targets native macOS. Linux and Docker remain future
deployment targets. A frozen `aiq` release built from this source starts the
observation scheduler at `03:00` and `15:00` UTC. It selects one canonical
12-hour slot, holds a global nonblocking lock, and does not start a second
scheduler. An installed frozen release keeps its existing behavior until an
operator replaces it. A self-contained release
stores the pinned runner and verifier binaries and an exact Git source bundle.
`aiq` restores the clean detached source at a stable per-slot path below the
private `state_root/scratch` directory. This path stays outside the macOS
platform-minimal roots that model processes can read. The command does not use a
repository worktree at run time. On a host fixed to the `America/New_York` time
zone, the macOS `launchd` template wakes at 11:05, 11:35, 23:05, and 23:35 local
time. The four wakes cover EST and EDT with one bounded retry for each UTC slot.
Official task dispatch must begin during the first two hours of a slot, and the
v2 configuration requires all 32 supported workers for the fixed 1,224-cell
matrix. A late wake does not start a new matrix. Subscription quota, usage, or
rate limits are persisted as non-terminal backpressure: completed cells stay in
the same checkpoint, rejected cells remain pending, and later scheduled wakes
resume the oldest blocked slot before they can start newer paid work. The
scheduler starts Official and Speed as sibling publication paths for the same
slot. Official keeps its two-hour model-dispatch grace. Speed has an independent
12-hour slot window. After the scheduler grants dispatch, neither path waits for
the other path. A slow or failed path cannot block the other path's dispatch or
publication. Each path writes retained status below its own slot directory, and
`aiq status` composes both outcomes. A completed run
with a non-semantic infrastructure result is retained as unpublished evidence.
It is not retried or presented as an AIQ score. Subscription backpressure is not
a completed result and is therefore the sole exception to that terminal rule.
The subscription runner uses a protected copy of `~/.codex/auth.json` in an
isolated per-release `CODEX_HOME`; it does not reuse the interactive Codex home
as its writable runtime directory. It also uses a private two-file copy of the
ChatGPT app's `codex` and `codex-code-mode-host` executables. Capability
preflight succeeds only after Codex completes one command and writes the exact
content-bound marker in a fresh disposable workspace.
See [Operations and Validation](openwiki/operations.md) for the native command
contract. Repository support does not prove that private inputs, credentials,
or live model capabilities are configured.

## Continuous observations

Normal/Fast transport measurements are auxiliary evidence. `observe-speed`
reads the live Codex model catalog before any paid turn, records an exact
available, unsupported, or unavailable state for each selected configuration,
and runs paired Normal/Fast fixed-response trials only for advertised modes.
It records completion, total elapsed time, aggregate output throughput, token
usage, tool use, and estimated ChatGPT credits. It does not calculate or modify
AIQ. The current Codex JSONL stream does not expose a trustworthy first-token
timestamp, so TTFT and post-first-token throughput remain explicit unavailable
values instead of estimates.

```sh
cargo run -p aiq-runner -- observe-speed --help
cargo run -p aiq-runner -- submit-speed --help
cargo install --locked --path apps/aiq
aiq status --config /absolute/private/path/to/continuous-observation.json
aiq doctor --config /absolute/private/path/to/continuous-observation.json
aiq run --config /absolute/private/path/to/continuous-observation.json
aiq run --config /absolute/private/path/to/continuous-observation.json \
  --slot 2026-08-12T03-00Z
```

Use `--slot` only for one known canonical UTC slot. Official task dispatch can
start only during the first two hours of its current slot. The frozen runner
can resume an unchanged checkpoint during the same slot only when it contains
no indeterminate in-flight cell. A checkpoint with explicit subscription
backpressure can also resume after the dispatch grace or 12-hour slot window;
it reuses the exact admitted preflight and never replaces completed cells. Other
checkpoints with sealed pending evaluator work can also resume that work after
the window without another task-model invocation. This rule includes a retryable
evaluator process failure. An indeterminate model cell
still fails closed after all sealed pending evaluator work is recovered. Other
late slots can continue only when the complete Official run output already
exists and only scoring or publication remains. `aiq` recognizes that output
only as an `aiq.run.v4` document with all 1,224 results; the runner's
create-once reservation is not a completed run. Otherwise, `aiq`
records a terminal missed or unpublished state without new model work. Speed
model dispatch can start during its own 12-hour slot. An existing Speed batch
can resume submission after that window without new model work. A
terminal slot remains a no-op. If another
observation owns the global lock, a scheduled `run` coalesces successfully
without starting another model process; `doctor` reports the contention instead.

Each runner, verifier, and evaluator step runs below an internal supervisor that
owns a separate process session. Runner-created model and evaluator process
groups remain in that session. A private pipe binds the supervisor to the
user-facing `aiq` parent. If that parent exits or is killed, the pipe closes and
the supervisor repeatedly sends `SIGTERM`, then `SIGKILL`, to every remaining
session process before it exits. This no-orphan boundary does not depend on
`launchd` process-group cleanup.

Start from `config/continuous-observation.example.json` and
`config/com.acgbox.aiq.continuous-observations.plist.example`. Keep the concrete
configuration and `launchd` plist outside Git. Use `aiq install-release` once to
copy the minimal frozen release, create its source bundle, and print the release
manifest digest. Install the release in a versioned directory outside the
repository. The private v2 configuration contains stable runtime paths, limits,
the endpoint, the manifest digest, and optional non-secret unattended provider
metadata. It does not contain a source worktree path, worker executable path,
provider credential, or consumer secret.

`cargo install` is sufficient for local operator use. An unattended service
must pin `apps/aiq/package.nix` in the host configuration so an unrelated Cargo
install cannot replace the scheduled executable.

Set `official_jobs` to `32`; lower values are rejected before model work. The
`aiq run` accepts either all four explicitly supplied consumer variables or no
consumer variables. Partial ambient delivery fails closed. When all four are
absent, `aiq` requires the complete `unattended_secrets` metadata, reads the
exact Keychain bootstrap, performs one Universal Auth login, and retrieves only
the four fixed `prod:/aiq` keys. It removes the provider session before it starts
a downstream step. Provider credentials and tokens do not reach workers. The
orchestrator gives the signing key only to `package`, the submission token only
to submission steps, and verifier credentials only to the verifier. Each owner
uses a fresh isolated `CODEX_HOME` directory for the slot. A retryable slot
retains checkpoints and raw artifacts. Checkpoint v10 distinguishes
indeterminate model work from sealed pending evaluator work. The latter resumes
from the same model response and workspace without another model invocation. A
retryable evaluator process failure stays in this pending state and cannot
create a terminal run. Provider-declared subscription limits leave
the affected cells pending under `aiq.subscription-backpressure.v1`; the runner
also migrates v9 checkpoints to the v10 evaluator-resume shape and legacy v8
checkpoints that incorrectly committed those limits as terminal results. On resume, `aiq` revalidates the permission
admission, complete Official run, submission receipts, and verifier receipt
before it reuses them. It stores non-success verifier records in a private
append-only attempt log. A create-once success receipt is valid only when its
package SHA-256 and idempotency identity match the exact local package. Copied
credentials are removed after each invocation. A terminal slot keeps both
owner-status records, the compact batch,
package, score, attestation, and receipts. It removes the detached source, raw
local artifacts, replay scratch, checkpoints, and disposable workspaces.

`launchd` invokes the pinned `aiq run --config ...` command directly. Use
absolute AIQ and configuration paths, supply `HOME`, `USER`, `LOGNAME`, and the
pinned execution `PATH`, and do not set a repository working directory. The
provider identity must grant only the four fixed source keys. The runtime keeps
the Keychain bootstrap and short-lived provider token inside AIQ.

The already-provisioned provider target is external frozen state. Do not run
setup to reconcile, rotate, or replace it. For a new exact target only, the
hidden `aiq operator provision-unattended --config ...` command uses
`config/unattended-provider-provision.example.json`. It refuses an existing
Keychain account or provider identity, creates only the fixed identity,
four-key privilege, Universal Auth method, and Keychain bootstrap, and rolls
back only known intermediate writes.

## Security boundaries

- Keep runner, verifier, and publisher credentials separate.
- Keep privileged Supabase values in server-only environment variables.
- Keep `aiq-submission-packages` and `aiq-runner-artifacts` private.
- Use RLS and the narrow database RPCs; do not write private tables from the
  browser.
- Put authentication, request limits, and a WAF in front of write routes.
- Run the Storage reconciliation worker before the deletion worker.
- Treat readiness responses as bounded dependency evidence, not deployment
  proof.

See [OpenWiki quickstart](openwiki/quickstart.md),
[operations](openwiki/operations.md), and
[deployment handoff](openwiki/deployment-handoff.md) for the maintained details.

`aiq.wiki` is canonical, and `www.aiq.wiki` returns a permanent `308` redirect
that preserves the request path. Automatic Vercel project and branch aliases can
be removed only transiently because a later deployment can recreate or reassign
them. A deployment-specific URL is intrinsic to its retained deployment. The
current generated Vercel surfaces emit `noindex`.
