---
type: 'Handoff'
title: 'Deployment Handoff'
description: 'Greenfield Supabase, Vercel, native runner, domain, and production acceptance work.'
tags: ['deployment', 'handoff', 'supabase', 'vercel']
---

# Deployment Handoff

AIQ is not accepted as deployed until every item in this handoff has current
live evidence. Repository text must not infer external state from a previous
attempt.

## First-release topology

The first release uses these exact surfaces:

| Surface | Required target |
| ------- | --------------- |
| Database and Storage | Personal Supabase organization `ACG Box`, project `aiq` |
| Web and gateway | Personal Vercel scope `acgbox`, project `aiq` |
| Public origin | `https://aiq.wiki` |
| Runner | Native Apple Silicon macOS `aiq-runner` release binary |
| Verifier | Native Apple Silicon macOS `aiq-verifier` release binary |

The same macOS host operates the runner and verifier natively in separate
command environments with direct network access. The verifier must not receive
the Codex home or runner signing key. The first release does not depend on or run
Linux or Docker. They remain a future deployment target outside this handoff.

This is one greenfield AIQ Core `1.0.2` state. The required first publication is
one complete `17 × 72 = 1,224` task-level observation Official batch. This is
one benchmark batch, not 1,224 separate runs. The native macOS runner completed
that batch. Of its 1,224 terminal observations,
1,218 completed and 6 had genuine failures. The wall-clock time was
`1:37:24.411`. Verified public token and API-equivalent cost aggregates remain
unavailable until verifier replay. The retained provider evidence contains
supported counters for 1,218 observations, but it contains no provider-reported
total-token counter. Actual subscription spend is unknown. Do not report missing
values as zero. Verifier replay and publication remain pending.

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

Use the personal Free organization `ACG Box`. The project name must be exactly
`aiq`. Start with an empty PostgreSQL database. Do not load synthetic fixtures
or any older AIQ schema.

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

Use the personal Hobby scope `acgbox`. The project name must be exactly `aiq`.
Configure the Web root and build settings from the repository. Do not attach the
public domain until the real Official run is ready for publication.

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

After the verified 1,224-observation run is ready, attach `aiq.wiki` to the
personal Vercel project `aiq`. Confirm the `aiq.wiki` Cloudflare zone through a
current read-only live check. Use only the DNS records that Vercel currently
requires. Keep Cloudflare proxying disabled until Vercel domain verification
and TLS pass.

The apex domain is canonical. If `www.aiq.wiki` is configured, it must preserve
the request path and redirect to the apex. Remove obsolete Vercel projects,
aliases, and domains only after exact read-only inspection confirms their
targets.

## Storage operations

Run Storage reconciliation before deletion:

```sh
AIQ_STORAGE_LIFECYCLE_MODE=reconcile npm run storage:lifecycle
AIQ_STORAGE_LIFECYCLE_MODE=delete npm run storage:lifecycle
```

Do not run deletion if reconciliation fails or reports unresolved mismatches.

## Launch checklist

- [ ] Repository checks pass at the approved commit.
- [ ] Native 72-task and contrast validation passes with zero model calls.
- [ ] The controlled Codex capability preflight records all 17 real statuses.
- [ ] Supabase project `ACG Box/aiq` is initialized once from
      `databases/schema.sql`.
- [ ] Both Storage buckets are private and browser roles cannot write private
      tables.
- [ ] Vercel project `acgbox/aiq` is bound to the approved commit and server
      secrets are absent from browser bundles.
- [ ] Runner, verifier, and publisher identities are distinct.
- [x] One complete non-synthetic 17-by-72 run contains 1,224 terminal
      observations: 1,218 completed and 6 had genuine failures. Its wall-clock
      time is `1:37:24.411`. Retained provider evidence contains supported token
      counters for 1,218 observations, but no provider-reported total-token
      counter. Verified public aggregates remain pending, and actual
      subscription spend is unknown.
- [ ] The native verifier reconstructs, replays, attests, and submits the run.
- [ ] The publisher completes only the fully verified batch.
- [ ] `aiq.wiki` resolves to the approved Vercel deployment with valid TLS.
- [ ] Home, comparison, trends, run detail, method, and radar pages work against
      real published data on desktop and mobile viewports.
- [ ] `/api/readiness`, public reads, write-route protection, and retention
      checks pass from the public origin.
- [ ] Obsolete Vercel aliases or projects are removed after exact target review.

If the greenfield database initializer fails after it starts, discard that new
project and create another empty `aiq` project. Do not open public traffic until
the complete checklist passes.

No command in this handoff performs deployment automatically.
