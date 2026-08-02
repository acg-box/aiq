---
type: 'Quickstart'
title: 'AIQ Wiki Quickstart'
description: 'Product scope, local demonstration, validation, and deployment status.'
tags: ['quickstart', 'navigation', 'aiq']
---

# AIQ Wiki Quickstart

AIQ Wiki publishes transparent records for a fixed AI and agent benchmark. It
contains:

- a Next.js site for results, trends, run details, method, and distributed radar;
- a Rust runner for capability checks, task execution, scoring, signing, and
  submission;
- a Rust verifier for artifact reconstruction and deterministic evaluator replay;
- AIQ Core `1.0.0`, with 72 private tasks and a public catalog;
- one PostgreSQL desired state with RLS, public reads, controlled writes, and
  private Storage lifecycle records.

The fixed model matrix has 17 configurations. Production has exactly three
distinct identities: runner, verifier, and publisher.

## Deployment status

The production Web and database foundations are provisioned, but release
acceptance is not complete. The personal Vercel scope `acgbox` hosts project
`aiq` at `https://aiq.wiki`, and `https://www.aiq.wiki` preserves the request
path and redirects to the apex domain. HTTPS and Vercel domain verification
pass. The production environment-name contract is configured. The personal
Supabase organization `ACG Box` hosts project `aiq`
(`xxnszykaeapolqdnhalx`). Its one-shot production schema and reference
initialization completed, and the real database has 17 model configurations,
three production nodes, no published runs, and private `private-packages` and
`private-artifacts` buckets. Bounded runtime readiness and the empty real-data
read path pass.

No benchmark or Storage schedule and no cloud runner or verifier worker exist.
A full real run has not been published. Official dispatch is blocked by the
managed-policy gate: `Official runs require an exclusive managed aiq_benchmark
allowlist and managed default; no model was invoked`. Current run work is
calibration-only; calibration evidence is non-Official.

Private tasks, fixtures, expected outputs, evaluators, signing keys, and Codex
authentication stay outside Git.

## Local demonstration

Use Node.js `24.18.0` or newer, npm `11.17.0` or newer, and the locked
dependencies.

```sh
npm ci --ignore-scripts
cargo run -p aiq-runner -- demo
npm run dev
```

Open `http://localhost:3000`. Development uses synthetic seed data when both
public Supabase variables are absent. Production fails closed when configuration
is incomplete.

## Basic validation

```sh
cargo run -p aiq-runner -- matrix
cargo run -p aiq-runner -- validate \
  --public-tasks benchmarks/examples/tasks
cargo make fmt-check
cargo make check
cargo make lint
cargo make test
cargo make build
```

The opt-in subscription smokes each consume one Codex subscription attempt:

```sh
cargo make smoke-subscription
cargo make smoke-controlled-subscription
```

They are diagnostics, not benchmark results.

## Database authority

`databases/schema.sql` is the sole desired database state.
`databases/init.ts` connects directly to one new Supabase PostgreSQL database and
applies the schema plus public reference data in one transaction. It rejects an
existing AIQ database. The production project is already initialized; use this
command only for a replacement empty project, not for the current project.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The expected receipt contains 72 tasks, 17 model configurations, and three
nodes. The catalog digest is
`sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3`.

## AIQ Wiki free-tier preview

Before production, one disposable Supabase Free project in the personal
`ACG Box` organization and one Vercel Hobby project in the personal `acgbox`
scope/account can host the read-only review build. Initialize the empty preview
database once:

```sh
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' \
cargo make init-preview-database
```

Set `AIQ_DEPLOYMENT_PROFILE=preview` and the two browser-safe Supabase values in
Vercel. Do not set server write, runner, verifier, publisher, or Storage secrets.
One bounded live status view returns a row only when the required preview
matrix, cardinalities, scoring definition, synthetic boundary, and empty
publication surface are valid. The application then displays explicit
checked-in synthetic fixtures. It adds a persistent preview banner, marks
complete synthetic runs as not Official, and emits `noindex`. A `503` from
`/api/readiness` is expected because that endpoint measures the absent
production write and verification path. Discard the preview database before
production initialization.

## Next reading

- [Architecture and runtime](architecture-and-runtime.md)
- [Benchmark method](benchmark-method.md)
- [Operations](operations.md)
- [Deployment handoff](deployment-handoff.md)

Source and tests take priority if these pages drift.
