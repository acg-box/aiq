---
type: 'Handoff'
title: 'Deployment Handoff'
description: 'Accepted Supabase, Vercel, native Official publication topology, production checks, and remaining schedule work.'
tags: ['deployment', 'handoff', 'supabase', 'vercel']
---

# Deployment Handoff

AIQ production has current live evidence for the first Official publication.
Use this handoff to preserve that accepted topology and to track the remaining
operational work. Do not infer future schedules, workers, or later publications
from the first launch evidence.

## First-release topology

The accepted first release uses these exact surfaces:

| Surface | Accepted target |
| ------- | --------------- |
| Database and Storage | Personal Supabase organization `ACG Box`, project `aiq`, reference `xxnszykaeapolqdnhalx`, PostgreSQL 17.6 |
| Web and gateway | Personal Vercel scope `acgbox`, project `aiq` |
| Public origin | `https://aiq.wiki` |
| Runner | Native Apple Silicon macOS `aiq-runner` release binary |
| Verifier | Native Apple Silicon macOS `aiq-verifier` release binary |
| Storage | Private `aiq-submission-packages` and `aiq-runner-artifacts` buckets |

The same macOS host operates the runner and verifier natively in separate
command environments with direct network access. The verifier must not receive
the Codex home or runner signing key. The first release does not depend on or run
Linux or Docker. They remain a future deployment target outside this handoff.

This is one greenfield AIQ Core `1.0.2` state. The first publication is one
complete `17 × 72 = 1,224` task-level result Official matrix, not 1,224 separate
benchmark runs. The native macOS runner completed it, the native verifier
replayed it, and the distinct publisher published it as `trusted_verified`.
Of the results, 1,218 completed and 6 failed: 329 `correct`, 259 `partial`, 630
`incorrect`, 5 `timeout`, and 1 `budget_exhausted`. Signed wall time is
5,844,411 ms (`1:37:24.411`).

Cost coverage is 1,208 `estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage`. The $125.403257240 priced subtotal is a Standard
API-equivalent estimate for the 1,208 priced results, not actual ChatGPT
subscription spend or a complete matrix total. Missing cost values are not zero.
Public views expose 17 runs, 1,224 results, and 17 rows each for the leaderboard,
model-efficiency, and model-matrix projections. Publication created 4,395
artifact bindings, including 19 capability artifacts. The interpretation of
these public-safe measures belongs to [Benchmark Method](benchmark-method.md).

The first Official launch publication was deployed from merge commit
`725b88954359ab8f0950f896674b3e8684d3ae85`. This commit is historical launch
evidence, not the identity of every later production deployment. To read the
current source commit, open Vercel project `acgbox/aiq`, select the deployment
currently assigned to `aiq.wiki`, and read **Git Source > Commit**. This command
returns the current deployment ID and deployment-specific URL for the same
readback:

```sh
vercel inspect aiq.wiki --scope acgbox --format=json
```

## Immutable release evidence

Record these values after each action succeeds:

| Surface | Required evidence |
| ------- | ----------------- |
| Source | Approved commit and clean worktree status |
| Runner | Source commit, Mach-O arm64 identity, and executable SHA-256 |
| Verifier | Source commit, Mach-O arm64 identity, and executable SHA-256 |
| Corpus | Release ID, commitment SHA-256, 72 task count, and evaluator runtime identity |
| Database | Source commit, `databases/schema.sql` SHA-256, and initialization receipt |
| Vercel | Deployment ID, source commit, project, scope, and production origin |
| Domain | Vercel domain state, Cloudflare DNS records, TLS, and redirect behavior |
| Publication | Run ID, 1,224 result count, verifier attestation, and publication receipt |

Private task content, credentials, signing seeds, access tokens, and service
keys must stay outside Git and public evidence.

## Supabase setup

The personal organization `ACG Box` hosts project `aiq` on PostgreSQL 17.6. Its
one-shot production initialization is complete. Do not rerun the initializer or
load synthetic fixtures into this project. The procedure below applies only to a
replacement empty project.

1. Confirm the standard `anon`, `authenticated`, `authenticator`, and
   `service_role` roles exist.
2. Create private Storage buckets for submission packages and runner artifacts.
3. Prepare one private production-reference document. Bind the 72-task corpus,
   current catalog identities, and distinct runner, verifier, and publisher
   public identities.
4. Apply the desired state once through a direct PostgreSQL connection:

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE='/controlled/production-reference.json' \
cargo make init-database
```

The initializer must be the first AIQ database action. It uses one transaction
and rejects existing AIQ objects. Confirm that the receipt reports scoring
`1.0.2`, 72 tasks, 17 model configurations, three distinct identities, and the
expected public-view inventory.

Run the database checks:

```sh
cargo make check-database
cargo make smoke-database
```

Do not load `databases/synthetic-demo.sql` into production.

## Vercel setup

The personal Vercel scope `acgbox` hosts project `aiq` and its accepted
production deployment at `https://aiq.wiki`. Preserve the browser-safe and
server-only configuration boundary when rotating values or replacing the
deployment.

Configure browser-safe values:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

Configure server-only values:

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

The ES256 private JWK must match the Supabase project signing key. Keep it only
in the server environment. Never expose a Supabase secret or service-role value
to the browser.

Before deployment, run:

```sh
npm run check
npm run lint
npm test
npm run build
npm run test:browser --workspace @aiq/web
```

Also run the real public-read smoke against a disposable PostgreSQL 17 and
PostgREST stack:

```sh
AIQ_LIVE_POSTGREST_URL='http://127.0.0.1:4178' \
cargo make smoke-live-web
```

## Native runner setup

Build the native release binaries from the approved clean commit:

```sh
cargo build --locked --release --package aiq-runner --package aiq-verifier
file target/release/aiq-runner target/release/aiq-verifier
shasum -a 256 target/release/aiq-runner target/release/aiq-verifier
```

Both binaries must be distinct Mach-O arm64 executables. Prepare separate,
canonical roots for source, private tasks, baselines, execution workspaces,
evaluators, artifacts, checkpoints, preflight output, verifier replay, and
private records.

Make a separate copy of the current Codex authentication home. Set the copied
`auth.json` to mode `0600` and owner immutable with `chflags uchg`. Do not change
the active Codex profile. Bind the exact Codex executable, Node.js runtime,
ripgrep executable, and their hashes in the corpus commitment and run
provenance.

Use CLI help as the exact argument authority:

```sh
target/release/aiq-runner validate-core-corpus --help
target/release/aiq-runner validate-contrast-corpus --help
target/release/aiq-runner admit-permissions --help
target/release/aiq-runner preflight --help
target/release/aiq-runner run --help
target/release/aiq-runner score --help
target/release/aiq-runner package --help
target/release/aiq-runner submit --help
```

Run both model-free corpus validators before `admit-permissions`. Pass the same
private admission receipt to preflight, run, score, and package. Use the host's
direct Codex connection. Keep the checkpoint, artifacts, run reservation, and
preflight cache after interruption. Resume only the unchanged run.

Expose the runner signing key only to `package`. Expose the submission token
only to `submit`. Do not place either value in command output or persistent
logs.

## Native verifier and publication

After submission, run `aiq-verifier` natively with its own token, signing key,
environment metadata, private tasks, evaluator registry, corpus commitment,
toolchain, and fresh replay root:

```sh
target/release/aiq-verifier --help
```

Use bounded replay parallelism for new claims. The default is four workers. Set
it explicitly when release evidence must record the selected value:

```sh
target/release/aiq-verifier --replay-jobs 4 ...
```

The verifier claims one bounded lease, reconstructs submitted workspaces,
replays deterministic evaluators, and sends the normalized stage and signed
attestation to the gateway. Production requires `evaluator_replayed`. A distinct
publisher identity completes publication. A queue receipt alone is not a
published result.

## Domain and DNS

`aiq.wiki` is attached to the personal Vercel project `aiq` with valid TLS and
is the canonical production origin. `www.aiq.wiki` preserves the request path
and returns a permanent `308` redirect to the apex. Automatic Vercel project and
branch aliases can be removed only transiently because a later deployment can
recreate or reassign them. A deployment-specific URL is intrinsic to its
retained deployment. The current generated Vercel surfaces emit `noindex`.

## Storage operations

Run Storage reconciliation before deletion:

```sh
AIQ_STORAGE_LIFECYCLE_MODE=reconcile npm run storage:lifecycle
AIQ_STORAGE_LIFECYCLE_MODE=delete npm run storage:lifecycle
```

Do not run deletion if reconciliation fails or reports unresolved mismatches.

## Launch checklist

- [x] Repository, controlled corpus, native binary, and capability evidence bind
      the approved production source and AIQ Core `1.0.2` contract.
- [x] Supabase project `ACG Box/aiq` is initialized from `databases/schema.sql`;
      both production Storage buckets are private.
- [x] Vercel project `acgbox/aiq` serves the accepted deployment without exposing
      server-only values to the browser.
- [x] Runner, verifier, and publisher identities are distinct.
- [x] One complete non-synthetic 17-by-72 matrix contains 1,224 terminal results,
      including 1,218 completed and 6 failed results.
- [x] The native verifier reconstructed and replayed the matrix, and the distinct
      publisher published it as `trusted_verified`.
- [x] `aiq.wiki` resolves with valid TLS; `www.aiq.wiki` redirects permanently
      while preserving paths.
- [ ] Run the read-only production acceptance gate after each production
      publication or deployment change. It covers public pages, exact matrix
      counts, evidence semantics, readiness, write rejection, mobile layout,
      and selected accessibility rules.
- [ ] Provision the separately owned twice-daily benchmark schedule and record its
      next run without changing the accepted execution contract.

Run the bounded, secret-free production acceptance gate after publication or a
production deployment change:

```sh
AIQ_PRODUCTION_ORIGIN=https://aiq.wiki npm run test:browser:production
```

The browser blocks non-read requests. The gate expects exactly one 17-by-72
Official matrix and fails if later runs exist until the release contract is
deliberately revised. For a local contract check without a production read, run
`npm run test:browser:production-contract --workspace @aiq/web`. These checks
validate the accepted public surface described in
[Operations and Validation](operations.md); they do not schedule future work.

If a replacement greenfield database initializer fails after it starts, discard
that new project and create another empty `aiq` project.

No command in this handoff performs deployment or recurring scheduling
automatically. No cloud runner or verifier worker and no benchmark or Storage
schedule currently exist. The twice-daily benchmark schedule and its next run
remain pending operator work; this documentation does not authorize recurring
automation.
