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

The only production tuple is AIQ Core `1.0.6`, scoring `1.0.6`, and measurement
`2.0.0`. Do not publish, preserve online, migrate, or display a legacy tuple as
production evidence. Production must remain without an Official AIQ 2.0
publication until one real, non-synthetic, signed 17-by-72 package passes the
native verifier and the release gates described below.

The `1.0.3` Official attempt was interrupted after the calibration evidence had
already proved a ceiling-policy failure. It was rejected as unpublished
calibration evidence. No hidden responses or hidden task details were
published. The first AIQ Core `1.0.4` calibration then completed all 1,224
cells. It is preserved as non-Official statistical evidence because it failed
the release policy. This does not mean that all task executions failed. AIQ
Core `1.0.5` retargeted four calibration-sensitive tasks. Its pilot evidence
showed that a wall-clock deadline can turn slow work into runtime-null evidence
without measuring task quality. AIQ Core `1.0.6` therefore gives all 72 model
tasks no wall-clock deadline. It keeps explicit step and tool-call budgets.
Coding-07 uses 32 steps and 21 tool calls; debugging-02 uses 64 steps and 56
tool calls; coding-06, debugging-01, and debugging-04 use 48 steps and 40 tool
calls. The other 67 tasks retain their accepted step and tool-call limits. Run
the two previously timed-out Sol ultra cells as a fresh no-deadline canary,
then run the complete 17-by-72 non-Official calibration. No operator can
override a failed release gate. Real calibration evidence can enter the public
calibration register only after signed verifier admission and distinct
publication, and it remains non-Official.

The first `1.0.5` 68-cell pilot completed 63 cells and timed out on 5. It was
rejected because the completed task means were 0.933–0.992 and therefore did
not distinguish the model configurations. The r11 five-task pilot then stopped
on debugging-02 at 47/48 steps and 41/40 tool calls. A later 17-by-5 pilot
completed 83 semantic cells and recorded two Sol ultra wall-time failures. The
offline diagnostic treats those failures as runtime-null coverage evidence
instead of semantic zero scores. Old deadline evidence is permanently
non-Official, cannot be relabeled, and cannot be mixed with the new corpus. The
rejected pilots remain immutable evidence.

## Product contract

- Repository source targets the public AIQ Core `1.0.6` candidate and scoring
  `1.0.6`, with 72 private controlled tasks in ten domains.
- The active public candidate, task, and scorer contract is `1.0.6`. All 72
  model tasks encode `wall_seconds: null`. Five interaction tasks retain their
  revised step and tool-call limits; the other 67 retain their accepted limits.
  Prompt, evaluator, semantic scoring, and tool permissions remain unchanged.
- The public `1.0.6` catalog is deterministic and identity-frozen. The changed
  no-deadline identity requires fresh, independent controlled Core and Contrast
  seals. The database task commitment must then be regenerated from the new
  controlled 72-task commitment. Final regeneration from the clean commit, the
  focused no-deadline canary, full calibration, final clean-source Contrast
  regeneration, final native build, real Official run, publication, and
  deployment are pending. No earlier publication is a fallback.
- The public catalog contains metadata and commitments, not private task content.
- Task scores use committed weighted binary checks. A failed hard gate or
  structural check sets the score to zero; otherwise the evaluator divides
  passed positive weight by total positive weight. The verifier replays the
  exact committed check identities and weights without rounding.
- The source-head AIQ measurement contract is `2.0.0`: the Official ranking
  score is `100 × logistic(theta)` from a jointly calibrated Rasch item bank;
  theta and its conditional Wald interval are reported separately from the raw
  equal-domain `qualityScore` diagnostic. This contract is not an IQ norm or a
  150-point scale.
- Strict pass is strict successes divided by all attributable tasks with a
  valid semantic task score. Partial scores remain in that denominator; only
  missing, infrastructure-invalid, runtime-failed, and unscored tasks are
  excluded. `invalid_tasks` records observed runtime or infrastructure
  failures, while `missing_tasks` is reserved for an expected cell with no
  result record. Runtime failures are not semantic zeros. The Wilson interval
  uses the same sample.
- The model matrix contains 17 configurations: six Sol, six Terra, and five Luna.
- The runner performs capability preflight, executes tasks, scores results, and
  creates signed `aiq.result-package.v3` envelopes.
- Every result keeps runner-observed elapsed time and, when Codex reports it,
  token usage and a versioned Standard API-equivalent cost estimate.
- AIQ, Rasch ability, quality, strict pass, ranking, and intervals use only
  evaluator-backed semantic task scores. Elapsed time, tokens, tool use, and
  estimated cost are independent efficiency evidence and never change a score.
- Public evidence labels time as `runner_observed`, provider token source as
  `provider_reported`, and verifier-checked token and cost evidence as
  `verifier_recomputed`. Unavailable evidence remains null, not zero.
- The verifier reconstructs submitted workspaces and replays deterministic
  evaluators before it signs `aiq.verifier-attestation.v3` evidence.
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
sha256:add2a0514b6cdab99b3329d7065565f5606d13af93338e4bc37a0fbd30019b91
```

Its public release digest is
`sha256:5b33cd2daa5efe15e49de34b7137d35bc2ff980a7f619063e7e8b819a857508f`.
The release-policy identity is `aiq-core/1.0.6`. Do not infer any controlled
identity from these public digests. The reviewed evaluator identity is
`sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`.
The predecessor public-safe database task-set identity is
`sha256:54c7026ac723a2e932b01fe8bf6557c226d1a658c7f87ab9fc4645c88bdd7766`,
and its task-commitment manifest identity is
`sha256:9e09c963fe9d59b8a0b37958d4bda852a4eb8e7aa5ea6bfba86b39b41503884e`.
Replace both after clean-commit Core and Contrast sealing. Final controlled
corpus identities remain provisional until calibration accepts the candidate.
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
| `apps/aiq-runner/`   | Capability checks, task execution, scoring, packaging, and submission     |
| `apps/aiq-verifier/` | Queue claims, artifact reconstruction, evaluator replay, and attestations |
| `apps/web/`          | Public Next.js site and controlled server gateways                        |
| `benchmarks/`        | Public catalog, schemas, and synthetic examples                           |
| `databases/`         | Desired database state, fresh initializer, and disposable SQL checks      |
| `openwiki/`          | Architecture, method, operations, and deployment handoff                  |

Private tasks, expected outputs, controlled evaluators, signing keys, Codex
authentication, and production data must stay outside Git.

## Local synthetic demonstration

Use Node.js `24.15.0` or newer, npm `11.17.0` or newer, Rust `1.97.1`, and the
locked dependencies.

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

Run the repository tasks:

```sh
cargo make fmt-check
cargo make check
cargo make lint
cargo make test
cargo make build
```

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
one direct PostgreSQL connection and applies the schema plus public reference
data in one transaction. It accepts the direct host for personal Supabase
project `xxnszykaeapolqdnhalx`. An explicit test/development override accepts
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
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

For an empty AIQ namespace, the production reference must contain the real
controlled, non-synthetic AIQ Core `1.0.6` corpus commitment, its real canonical
`published_at` timestamp, and
exactly three public identities: runner, verifier, and publisher. Prepare it
only after the controlled corpus passes model-free validation, the operator
verifies the final native build, and one real signed non-synthetic 17-by-72
package passes native verifier replay; the repository contains no substitute
production reference. Retain the private final-build audit receipt separately.
Database initialization does not accept or validate that receipt.
A successful initialization receipt must report scoring `1.0.6`, both public
catalog identities, 72 tasks, 17 model configurations, and three nodes.

Use one initialized disposable database for production-shape smoke and
calibration publication checks:

```sh
cargo make smoke-database
AIQ_DATABASE_URL='<direct-connection-url>' cargo make smoke-calibration-database
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
2. It executes the selected tasks and writes content-addressed artifacts.
3. It scores the run, records efficiency evidence, and signs one v3 result
   package.
4. `POST /api/submissions` stores the exact package bytes and queues the package
   as unverified.
5. The verifier claims the package, reconstructs the workspaces, and replays the
   deterministic evaluators.
6. `POST /api/verifications` stages the normalized batch and records the signed
   verifier attestation.
7. A distinct publisher identity completes publication through the gateway.
8. Public security-invoker views supply the Web application.

Official means a complete, non-synthetic 17-by-72 run with valid `1.0.6` and
measurement `2.0.0` bindings that completed this flow and was published as
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
The current production runner is native macOS. Linux and Docker remain future
deployment targets. No cloud runner or verifier worker and no benchmark or
Storage schedule currently exist. The twice-daily schedule and its next run are
pending operations work, not part of the current production state.
The subscription runner uses a protected copy of `~/.codex/auth.json` in an
isolated per-release `CODEX_HOME`; it does not reuse the interactive Codex home
as its writable runtime directory. It also uses a private two-file copy of the
ChatGPT app's `codex` and `codex-code-mode-host` executables. Capability
preflight succeeds only after Codex completes one command and writes the exact
content-bound marker in a fresh disposable workspace.
See [Operations and Validation](openwiki/operations.md) for the native command
contract. Repository support does not prove that private inputs, credentials,
or live model capabilities are configured.

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
