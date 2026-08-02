# AIQ Wiki

AIQ Wiki records fixed-fixture AI and agent benchmark results. The repository
contains a Rust runner, a Rust verifier, a Next.js application, the public AIQ
Core catalog, and one declarative PostgreSQL schema.

The source is ready for a new greenfield deployment, but this repository has not
created a Supabase project, Vercel project, DNS record, production secret,
schedule, or remote worker. All checked-in result data is synthetic. Deployment
readiness still requires the external gates in the deployment handoff.

## Product contract

- AIQ Core `1.0.0` has 72 private controlled tasks in ten domains.
- The public catalog contains metadata and commitments, not private task content.
- The model matrix contains 17 configurations: six Sol, six Terra, and five Luna.
- The runner performs capability preflight, executes tasks, scores results, and
  creates signed `aiq.result-package.v3` envelopes.
- The verifier reconstructs candidate workspaces and replays deterministic
  evaluators before it signs `aiq.verifier-attestation.v3` evidence.
- Production uses three distinct identities: runner, verifier, and publisher.
- The Web application reads public database views and sends controlled writes
  through server routes.

The frozen public catalog digest is:

```text
sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3
```

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

Use Node.js `24.18.0` or newer, npm `11.17.0` or newer, Rust `1.97.1`, and the
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
or roles. Create another empty project after a failed initialization.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The production reference contains one current controlled corpus commitment and
exactly three public identities: runner, verifier, and publisher. A successful
receipt reports 72 tasks, 17 model configurations, and three nodes.

The SQL files in `databases/` support disposable validation:

```sh
cargo make smoke-database
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/synthetic-demo.sql
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/integration.sql
```

Do not load `synthetic-demo.sql` into production.

## Disposable AIQ Wiki free preview

The first hosted review can use one new Supabase Free project in the personal
`ACG Box` organization and one Vercel Hobby project in the personal `acgbox`
scope/account. It does not need a runner, verifier, Storage bucket, write-route
secret, schedule, domain, or DNS change.

Initialize the new disposable database once:

```sh
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' \
cargo make init-preview-database
```

Configure only these Vercel values:

```text
AIQ_DEPLOYMENT_PROFILE=preview
NEXT_PUBLIC_SUPABASE_URL=<project API origin>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
```

The preview requires the live Supabase schema and RLS read path to work. One
bounded status view returns a row only when the required preview matrix,
cardinalities, scoring definition, synthetic boundary, and empty publication
surface are valid. The Web application then shows the full checked-in synthetic
demonstration. Every page has a persistent AIQ Wiki preview banner, synthetic
complete runs say `not Official`, and search indexing is disabled.
`/api/readiness` returns `503` until the later production write and verifier
gateways are configured; this is expected for this read-only preview. Discard
this database before production initialization.

## Production data flow

1. The runner validates the controlled corpus, toolchain, and capability
   manifest.
2. It executes the selected tasks and writes content-addressed artifacts.
3. It scores the run and signs one v3 result package.
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
