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

The native Apple Silicon macOS runner completed one real, non-synthetic Official
`aiq-core@1.0.2` batch. It contains 17 configuration runs and 72 tasks per run,
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

## Product contract

- Repository source targets AIQ Core `1.0.2` and scoring `1.0.2`, with 72
  private controlled tasks in ten domains.
- AIQ Core `1.0.2` is the only accepted launch contract.
- The public catalog contains metadata and commitments, not private task content.
- The model matrix contains 17 configurations: six Sol, six Terra, and five Luna.
- The runner performs capability preflight, executes tasks, scores results, and
  creates signed `aiq.result-package.v3` envelopes.
- Every result keeps runner-observed elapsed time and, when Codex reports it,
  token usage and a versioned Standard API-equivalent cost estimate.
- The verifier reconstructs submitted workspaces and replays deterministic
  evaluators before it signs `aiq.verifier-attestation.v3` evidence.
- Production uses three distinct identities: runner, verifier, and publisher.
- The Web application reads public database views and sends controlled writes
  through server routes.

The source-head ordered task-metadata catalog digest is:

```text
sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937
```

Its catalog release identity is
`sha256:54e8010f9c9ebc187574015dd6f8a62fd8025884d86c5cdd0d581551ab6095a6`.
Production accepts only `1.0.2`. The published Official `72 × 17` matrix is
one batch of 17 configuration runs and 1,224 task-level executions.
Elapsed time, provider-token usage, and Standard API-equivalent cost are
reported separately from AIQ.

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
data in one transaction. It rejects a database that already contains AIQ schema
or roles. This is the one greenfield desired state. Create another empty project
after a failed initialization.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The production reference must contain the real controlled, non-synthetic AIQ
Core `1.0.2` corpus commitment, its real canonical `published_at` timestamp, and
exactly three public identities: runner, verifier, and publisher. Prepare it
only after the controlled corpus and final native binaries pass model-free
validation; the repository contains no substitute production reference.
A successful receipt reports scoring `1.0.2`, both source-head catalog
identities, 72 tasks, 17 model configurations, and three nodes.

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
