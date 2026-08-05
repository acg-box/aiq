# AIQ

AIQ records fixed-fixture AI and agent benchmark results. The repository
contains a Rust runner, a Rust verifier, a Next.js application, the public AIQ
Core catalog, and one declarative PostgreSQL schema.

AIQ production is live at [aiq.wiki](https://aiq.wiki). The personal Vercel
scope `acgbox` hosts project `aiq`. The personal Supabase organization `ACG Box`
hosts project `aiq` on PostgreSQL 17.6 with reference
`xxnszykaeapolqdnhalx`. Production uses the private Storage buckets
`aiq-submission-packages` and `aiq-runner-artifacts`. The first Official launch
publication was deployed from merge commit
`725b88954359ab8f0950f896674b3e8684d3ae85`. This commit is historical launch
evidence, not the identity of every later production deployment.

The live production data is the historical AIQ Core `1.0.2` matrix. The native
Apple Silicon macOS runner completed this one real, non-synthetic Official
batch. It contains 17 configuration runs and 72 tasks per run,
or 1,224 task-level results. This is one Official matrix, not 1,224 benchmark
runs. The verifier replayed and accepted the evidence. A distinct publisher
published the matrix as `trusted_verified`. Of the 1,224 results, 1,218
completed and 6 failed. The outcomes are 329
`correct`, 259 `partial`, 630 `incorrect`, 5 `timeout`, and 1
`budget_exhausted`. Signed batch wall time is 5,844,411 ms (`1:37:24.411`).

Cost coverage is 1,208 `estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage` results. The priced subtotal is $125.403257240. It
is a Standard API-equivalent estimate for the 1,208 priced results. It is not
actual ChatGPT subscription spend and is not a complete total for the batch.
Missing cost values are not zero.

The public database exposes 17 runs, 1,224 results, 17 leaderboard rows, 17
model-efficiency rows, and 17 model-matrix rows. Publication created 4,395
artifact bindings, including 19 capability artifacts.

The `1.0.3` Official attempt was interrupted after the calibration evidence had
already proved a ceiling-policy failure. It was rejected as unpublished
calibration evidence. No hidden responses or hidden task details were
published. Before any `1.0.4` Official publication path starts, one complete
non-Official 17-by-72 calibration must try to falsify fixture discrimination and
must pass the release policy without an operator override.

## Product contract

- Repository source targets the public AIQ Core `1.0.4` candidate and scoring
  `1.0.4`, with 72
  private controlled tasks in ten domains.
- The active public candidate, task, and scorer contract is `1.0.4`. It retargets
  nine ceiling tasks, repairs one data-processing contract, and carries forward
  62 task designs with new version, provenance, and commitment bindings.
- The controlled `1.0.4` Core and Contrast identities, runtime identity,
  evaluator identity, generated-task tree identity, and database commitments are
  pending. Full calibration, a real Official run, publication, and final
  deployment are also pending. Production remains on the historical `1.0.2`
  matrix.
- The public catalog contains metadata and commitments, not private task content.
- Task scores use committed weighted binary checks. A failed hard gate or
  structural check sets the score to zero; otherwise the evaluator divides
  passed positive weight by total positive weight. The verifier replays the
  exact committed check identities and weights without rounding.
- The model matrix contains 17 configurations: six Sol, six Terra, and five Luna.
- The runner performs capability preflight, executes tasks, scores results, and
  creates signed `aiq.result-package.v3` envelopes.
- Every result keeps runner-observed elapsed time and, when Codex reports it,
  token usage and a versioned Standard API-equivalent cost estimate.
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
sha256:2b009bfe1c590898b143c13b264b738f950cbda5c42dae104aaf9dd63426a59e
```

Its public release digest is
`sha256:f529aa9c7431f17e7b51ad8cc3524eea063edb154853b8ee49702cb0e9462279`.
The release-policy identity is `aiq-core/1.0.4`. Do not infer any controlled
identity from these public digests. Create-new generation and review will
establish the `1.0.4` scorer manifest, evaluator, runtime task set, generated
task tree, Core corpus, and Contrast corpus identities. The checked Core schema
requires `runner.identity_kind` to remain `source_only` and
`runner.built_binary_sha256` to remain null. The shared Rust validator now fails
closed on this runner subtree for both Core and Contrast. Contrast does not have
a separate checked-in JSON schema. Each corpus also binds the Node.js and ripgrep
identities. The source-only corpus rule and signed per-run runner and Codex
executable provenance are the executable product contracts. After the final
clean build, the operator retains a private, unsigned audit receipt with the
exact source commit and tree identity and SHA-256 values for the native runner,
verifier, Node.js, and ripgrep executables. This receipt is reproducibility
evidence, not a product protocol, database input, or published artifact. The
repository does not validate it. Do not infer a runtime hash from a generated-task
tree digest. The published historical `1.0.2` Official `72 × 17` matrix is one
batch of 17 configuration runs and 1,224 task-level executions.
Elapsed time, provider-token usage, and Standard API-equivalent cost are
reported separately from AIQ.

The Web application is a professional analysis workbench. Scientific score
context reports the sample count, fixed-fixture task-sensitivity interval, coverage,
missing cells, runtime state, scoring method, and provenance. It keeps semantic
task outcomes separate from runtime, invalid, and missing cells. Cost remains an
estimated Standard API-equivalent comparison, not an actual ChatGPT or Codex
subscription bill. Charts use ECharts with SVG rendering and ARIA descriptions.
Users can select system, light, or dark color themes. The production views use
the real historical matrix, not synthetic data.

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
`databases/init.ts` is the only production initialization entry point. It opens
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
controlled, non-synthetic AIQ Core `1.0.4` corpus commitment, its real canonical
`published_at` timestamp, and
exactly three public identities: runner, verifier, and publisher. Prepare it
only after the controlled corpus passes model-free validation and the operator
verifies the final native build; the repository contains no substitute
production reference. Retain the private final-build audit receipt separately.
Database initialization does not accept or validate that receipt.
A successful initialization receipt must report scoring `1.0.4`, both public
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

The current production matrix completed this flow and is published as
`trusted_verified`. Official means a complete, non-synthetic 17-by-72 run with
valid current bindings. A complete synthetic fixture uses the
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
