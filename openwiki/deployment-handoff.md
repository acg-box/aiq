---
type: 'Handoff'
title: 'Deployment Handoff'
description: 'Greenfield Supabase, Vercel, runner, verifier, and publication handoff.'
tags: ['deployment', 'handoff', 'supabase', 'vercel']
---

# Deployment Handoff

This repository has not deployed production infrastructure. The deployment
owner must create and operate every external resource.

## Release topology

AIQ Wiki uses one production environment for its first greenfield release. No
staging environment, database upgrade path, or compatibility state is required.
This repository does not define an automatic production trigger. The deployment
owner must approve one exact source commit and bind every deployed surface to
that commit before production traffic starts.

Record these release identities in the deployment evidence:

| Surface | Required immutable identity |
| ------- | --------------------------- |
| Web and gateway | Vercel deployment ID and source commit |
| Runner | Source commit and built executable SHA-256 |
| Verifier | Source commit and built executable SHA-256 |
| Database | Source commit, `databases/schema.sql` SHA-256, and initializer receipt |
| Storage lifecycle | Source commit, script SHA-256, execution host, and schedule |

The publisher is a distinct identity used through the gateway. It is not a
separate deployable. Distributed remote nodes are not part of the first launch.

## Personal free-tier preview

The approved first review uses only the personal Vercel Hobby scope/account
`acgbox` and the personal Supabase Free organization `ACG Box`. Do not select,
import into, or bill a company team. Use the project name `aiq` in both Vercel
and Supabase.

This preview is disposable and read-only. It needs no Storage bucket, runner,
verifier, publisher, schedule, custom domain, DNS change, WAF, or server secret.
Create a new empty Supabase project and run:

```sh
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' \
cargo make init-preview-database
```

The command applies the one declarative schema and synthetic validation data in
one transaction. It rejects reuse and leaves the Official publication views
empty. Configure the Vercel project from the repository root with only:

```text
AIQ_DEPLOYMENT_PROFILE=preview
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

The explicit preview Web profile reads one bounded Supabase status view through
anon RLS. The view returns one row only when the canonical preview matrix,
cardinalities, scoring definition, synthetic boundary, and empty publication
surface are valid; any production or unexpected evidence returns no row. The
Web application then serves the checked-in synthetic fixtures. The global
banner, synthetic labels, and `noindex` metadata prevent a production claim.
Confirm every public page, all 17 configurations, one 72-task run, all
trend ranges, method, radar, mobile layout, and accessibility. A `503` from
`/api/readiness` is expected because the production write and verifier gateways
are intentionally absent.

Free-tier review is a product and read-path test, not a production benchmark
run. Record Vercel and Supabase usage after the review window. Upgrade only if
measured limits require it. Delete or retain the disposable projects by an
explicit owner decision, but never convert this database into production.

## Required external inputs

- one new Supabase project with PostgreSQL 17;
- one Vercel project and the selected public origin;
- two private Storage buckets, one for packages and one for runner artifacts;
- the current 72-task private corpus and controlled evaluator registry;
- the current public-safe corpus commitment;
- the exact Node.js runtime and controlled Node.js/ripgrep toolchain;
- an operator-selected Codex subscription profile and private proxy;
- one approved benchmark schedule with its timezone and two exact daily times;
- one approved Storage lifecycle schedule with reconciliation before deletion;
- separate runner, verifier, and publisher identities;
- supervised runner and verifier environments with separate identities and
  secret boundaries; one suitable host can operate both environments;
- the production region, Vercel team, Supabase organization, and public origin;
- the `aiq.wiki` DNS and TLS owner;
- a production go/no-go owner and a failed-launch owner;
- route protection, monitoring, retention, and incident owners;
- one acceptance window and the owner who records runtime evidence.

The public catalog digest is
`sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3`.

## Identity setup

Create three independent signing or publication identities:

| Identity  | Use                                                   |
| --------- | ----------------------------------------------------- |
| Runner    | Signs v3 result packages                              |
| Verifier  | Signs v3 verifier attestations after evaluator replay |
| Publisher | Completes publication through the database gateway    |

Register the corresponding public identities in the production reference. Keep
all secret material outside Git. Do not put the verifier or publisher identity
in the runner environment.

## Supabase setup

1. Create a new project.
2. Confirm the standard `anon`, `authenticated`, `authenticator`, and
   `service_role` roles exist.
3. Create both Storage buckets as private.
4. Prepare one public-safe production reference with the current corpus
   commitment and the three identities.
5. Run the initializer through a direct PostgreSQL connection:

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The initializer must be the first AIQ database action. It uses one transaction
and rejects existing AIQ objects. Confirm that its receipt reports 72 tasks, 17
model configurations, and three nodes.

6. Run the database smoke check:

```sh
cargo make smoke-database
```

Do not load the synthetic demonstration SQL into production.

## Vercel setup

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

Use an ES256 private JWK that matches the Supabase project signing key. Keep it
only in the protected gateway. Configure WAF rules and route-specific limits for
all write, claim, artifact, and verification routes.

Build and test before deployment. On a fresh host, install the pinned Playwright
browsers first, as the checked-in CI job does:

```sh
npm exec --workspace @aiq/wiki-web -- \
  playwright install --with-deps chromium firefox webkit
npm run check
npm run lint
npm run test --workspace @aiq/wiki-web
npm run build --workspace @aiq/wiki-web
npm run test:browser --workspace @aiq/wiki-web
```

Before launch, also run the real public-read smoke from [Operations and
Validation](operations.md) against a freshly initialized disposable PostgreSQL
17 database exposed through loopback PostgREST. It verifies the RLS/PostgREST to
Next.js chain that mocked browser scenarios do not cover:

```sh
AIQ_LIVE_POSTGREST_URL='http://127.0.0.1:4178' \
  cargo make smoke-live-web
```

After deployment, check `/api/readiness`. A successful bounded probe confirms
only the configured dependencies and contracts.

## Runner setup

Prepare separate controlled roots for source, private tasks, baselines,
execution, evaluators, artifacts, checkpoint, and preflight output. Provide the
exact Codex executable, Codex home, private proxy, capability manifest, current
corpus commitment, evaluator runtime, toolchain, and approved schedule.

Protect `auth.json` for the complete run. Linux requires a read-only file-system
mount. Local macOS validation requires a separate private Codex home and an
owner-immutable `auth.json`. Do not change the active Codex profile.

Use the CLI help from the built binary as the exact argument contract:

```sh
cargo run -p aiq-runner -- preflight --help
cargo run -p aiq-runner -- run --help
```

Complete and retain preflight before the live run. Provision an external timer;
the runner validates a supplied schedule but does not create or select one. The
timer owner must invoke both approved daily occurrences with the schedule's local
`--slot-date`, `--occurrence day` or `--occurrence night`, and timezone-bound
schedule file. Dispatch outside that occurrence's exact window fails closed.
Preserve the checkpoint and artifact root after interruption so an operator can
resume the same attempt rather than discard completed evidence.

Use non-synthetic evidence and the complete 17-by-72 shape for an Official run.
Score, package, and submit only after all required artifacts and bindings
validate. The controlled command and recovery details remain canonical in
[Operations and Validation](operations.md).

## Verifier setup

Run `aiq-verifier` in a separate environment with its own key, token, environment
metadata, private tasks, evaluator registry, corpus commitment, runtime,
toolchain, and replay root.

```sh
cargo run -p aiq-verifier -- --help
```

Production verification must reconstruct candidate workspaces and replay the
deterministic evaluators. The gateway stages evidence under the verifier role and
publishes under the distinct publisher role.

## Storage operations

Schedule the one-shot Storage lifecycle command outside this repository. Its
protected environment requires `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`AIQ_SUBMISSION_PACKAGE_BUCKET`, and `AIQ_RUNNER_ARTIFACT_BUCKET` in addition to
an explicit lifecycle mode. Optional bounded settings control batch size, lease
duration, reconciliation grace, inventory limit, and request timeout; review the
accepted ranges in `scripts/storage-object-lifecycle.ts` before overriding the
defaults.

```sh
AIQ_STORAGE_LIFECYCLE_MODE=reconcile npm run storage:lifecycle
AIQ_STORAGE_LIFECYCLE_MODE=delete npm run storage:lifecycle
```

The script accepts either mode directly, so the external scheduler must enforce
the [Architecture and Runtime](architecture-and-runtime.md) Storage boundary:
run reconciliation first, require it to succeed, and review or alert on mismatch
metrics before enabling deletion. Monitor unresolved object mismatches, expired
claims, queue depth, verifier errors, publication errors, readiness failures, and
public-read failures.

## Launch checklist

- [ ] Repository checks pass at the deployed commit.
- [ ] The deployment evidence binds all five surfaces to the approved commit.
- [ ] Vercel, the runner, and the verifier report their expected immutable
      identities. The operator records the database and lifecycle identities.
- [ ] The Supabase receipt reports 72 tasks, 17 models, and three identities.
- [ ] Both Storage buckets are private.
- [ ] Browser roles cannot write private tables.
- [ ] Runner, verifier, and publisher identities are distinct.
- [ ] Server secrets are absent from browser bundles and logs.
- [ ] The runner preflight is current and bound to the controlled inputs.
- [ ] The verifier can claim, reconstruct, replay, attest, and submit.
- [ ] The publisher can complete only a fully verified batch.
- [ ] Public pages and bounded readiness probes work from the public origin.
- [ ] The disposable live-stack smoke passes through real PostgREST and RLS.
- [ ] The external benchmark timer owns both daily occurrences and preserves
      checkpoints and artifacts for operator-directed resume.
- [ ] Storage deletion is gated on successful reconciliation and reviewed metrics.
- [ ] One complete non-synthetic 17-by-72 run is verified, published, and visible
      in the overview, trends, run history, and run detail pages.
- [ ] Monitoring and Storage lifecycle owners are active.
- [ ] DNS and TLS resolve to the approved Vercel deployment.
- [ ] The acceptance window records health, user-visible checks, worker progress,
      and restart deltas.

If local reference validation fails or `psql` cannot start, no database work has
started. Correct the input and retry the same empty project. If the initializer
reports that database work did not complete, discard the new Supabase project
and start again. A reuse rejection makes no changes, but the greenfield launch
still needs a new project. Do not repair or reuse a partial project. Before
production traffic, reject any failed Web, runner, verifier, or lifecycle
artifact. Build or select a corrected artifact, rebind all five release
identities, and repeat validation. After production starts, any future database
change needs a separate schema-evolution decision; this greenfield handoff does
not add a migration framework.

The benchmark schedule and the Storage lifecycle schedule are separate. Confirm
the benchmark timezone and its two exact daily times. Run Storage reconciliation
before Storage deletion, with independent ownership and alerting.

No command in this handoff performs deployment automatically.
