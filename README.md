# AIQ

AIQ records fixed-fixture AI and agent benchmark results. The repository
contains a Rust runner, a Rust verifier, a Next.js application, the public AIQ
Core catalog, and one declarative PostgreSQL schema.

The production Web and database foundations are provisioned, but release
acceptance is not complete. The personal Vercel scope `acgbox` hosts project
`aiq` at `https://aiq.wiki`, with the production environment-name contract
configured. `https://www.aiq.wiki` preserves the request path and redirects to
the apex domain. The personal Supabase organization `ACG Box` hosts project
`aiq` (`xxnszykaeapolqdnhalx`), initialized once with the earlier AIQ Core
`1.0.1` schema and reference. The live database has 17 model configurations,
three production nodes, no published runs, and private `private-packages` and
`private-artifacts` buckets. Bounded runtime readiness and the empty real-data
read path pass for that deployed `1.0.1` foundation. Repository head now
targets AIQ Core `1.0.2`, scoring `1.0.2`, and an exact 12-view public inventory.
It is not deployed, and its one greenfield database reset remains pending. No
benchmark or Storage schedule and no cloud runner or verifier worker exist. A
real candidate or Official model run has not started, and no subscription limit
has been observed. AIQ Core `1.0.2` is not promoted. Production continues to use
the older `1.0.1` foundation and contains no genuine run data until candidate
validation, promotion, database reset, and deployment complete. Deployment
readiness still requires the remaining gates in the deployment handoff.

## Product contract

- Repository source targets AIQ Core `1.0.2` and scoring `1.0.2`, with 72
  private controlled tasks in ten domains.
- AIQ Core `1.0.2` remains an unpromoted preregistered candidate. AIQ Core
  `1.0.1` is the deployed predecessor until the controlled cutover completes.
- The public catalog contains metadata and commitments, not private task content.
- The model matrix contains 17 configurations: six Sol, six Terra, and five Luna.
- The runner performs capability preflight, executes tasks, scores results, and
  creates signed `aiq.result-package.v3` envelopes.
- Every result keeps runner-observed elapsed time and, when Codex reports it,
  token usage and a versioned Standard API-equivalent cost estimate.
- The verifier reconstructs candidate workspaces and replays deterministic
  evaluators before it signs `aiq.verifier-attestation.v3` evidence.
- Production uses three distinct identities: runner, verifier, and publisher.
- The Web application reads public database views and sends controlled writes
  through server routes.

The source-head ordered task-metadata catalog digest is:

```text
sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937
```

Its catalog release identity is
`sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b`.
The predecessor `1.0.1` identity remains in historical source and comparisons;
it is not accepted by the source-head runtime or greenfield database state.

The Official `72 × 17` run has 1,224 observations and is separate from the
candidate calibration. The candidate calibration uses three fixed repeats:
3,672 core observations plus 306 contrast observations, for 3,978 observations.
The gate proves only that the candidate meets its preregistered absolute
adequacy thresholds. It does not compare `1.0.2` with `1.0.1` or prove that the
candidate is superior. Elapsed time, provider-token usage, and Standard
API-equivalent cost are reported separately from AIQ. Signed candidate unit
artifacts retain measured latency and available provider-token counters. The
public aggregate gate source, evidence, and result artifacts omit efficiency
fields; verified publication evidence owns the coverage-qualified aggregates
and Standard API-equivalent estimate.

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
or roles. This is one greenfield desired state; the repository has no migration
or compatibility path. Create another empty project after a failed
initialization.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The production reference must contain the real controlled, non-synthetic AIQ
Core `1.0.2` corpus commitment, its real canonical `published_at` timestamp, and
exactly three public identities: runner, verifier, and publisher. Prepare it
only after promotion; the repository contains no substitute promoted reference.
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

Official means a complete, non-synthetic 17-by-72 run with valid current
bindings. A complete synthetic fixture uses the `synthetic_complete`
classification, has no Official AIQ value, and is never ranking eligible. There
is no additional provider ceremony.

## Official paid-work boundary

The repository-owned Official runtime manager is the only documented runner
command path for the bounded container. Run its commands in this order:
`admit-permissions`, `preflight`, `run`, `score`, `package`, and `submit`.
`admit-permissions` is model-free; `preflight` is the first paid step. The same
private admission receipt binds preflight through package. The manager reads the
runner signing key only for `package` and the submission token only for
`submit`; it does not put either secret in Docker arguments, Compose
configuration, or logs. See `deploy/official-runtime/README.md` for the exact
`deploy/official-runtime/runtime.py` commands. This command support does not
prove secret provisioning, runtime deployment, admission, or model execution.

## Security boundaries

- Keep runner, verifier, and publisher credentials separate.
- Keep privileged Supabase values in server-only environment variables.
- Keep both Storage buckets private.
- Use RLS and the narrow database RPCs; do not write private tables from the
  browser.
- Put authentication, request limits, and a WAF in front of write routes.
- Run the Storage reconciliation worker before the deletion worker.
- Treat readiness responses as bounded dependency evidence, not deployment
  proof.

See [OpenWiki quickstart](openwiki/quickstart.md),
[operations](openwiki/operations.md), and
[deployment handoff](openwiki/deployment-handoff.md) for the maintained details.
