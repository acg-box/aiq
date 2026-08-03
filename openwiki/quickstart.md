---
type: 'Quickstart'
title: 'AIQ Quickstart'
description: 'Product scope, local demonstration, validation, and deployment status.'
tags: ['quickstart', 'navigation', 'aiq']
---

# AIQ Quickstart

AIQ publishes transparent records for a fixed AI and agent benchmark. It
contains:

- a Next.js site for results, trends, run details, method, and distributed radar;
- a Rust runner for capability checks, task execution, scoring, signing, and
  submission;
- a Rust verifier for artifact reconstruction and deterministic evaluator replay;
- a source-head AIQ Core `aiq-core@1.0.2` target, with 72 private tasks, a
  public catalog, and scoring `1.0.2`;
- one PostgreSQL desired state with RLS, public reads, controlled writes, and
  private Storage lifecycle records.

The fixed model matrix has 17 configurations. Production has exactly three
distinct identities: runner, verifier, and publisher.

Repository source makes AIQ Core `1.0.2` and scorer `1.0.2` the current
Official contract. The hosted production foundation still uses the `1.0.1`
predecessor, so the source-head desired state is not yet deployed.

## Deployment status

The production Web and database foundations are provisioned, but release
acceptance is not complete. The personal Vercel scope `acgbox` hosts project
`aiq` at `https://aiq.wiki`, and `https://www.aiq.wiki` preserves the request
path and redirects to the apex domain. HTTPS and Vercel domain verification
pass. The production environment-name contract is configured. The personal
Supabase organization `ACG Box` hosts project `aiq`
(`xxnszykaeapolqdnhalx`). Its earlier AIQ Core `1.0.1` schema and reference
initialization completed, and the real database has 17 model configurations,
three production nodes, no published runs or other genuine run data, and private
`private-packages` and `private-artifacts` buckets. Bounded runtime readiness and
the empty real-data read path pass for the deployed `1.0.1` foundation.
Repository head requires AIQ Core `1.0.2`, scoring `1.0.2`, an exact 12-view
public inventory, and one greenfield database state. It is not deployed; the
candidate validation, promotion, greenfield database reset, and deployment
remain pending.

No benchmark or Storage schedule and no cloud runner or verifier worker exist.
The repository now contains a bounded local Linux arm64 runner-and-verifier
bundle, but its presence does not establish a production deployment. A real
Official or candidate calibration run has not started. No subscription limit has
been observed. Official dispatch remains subject to the managed
permission-admission gate. The repository supports signed, replay-verified
calibration evidence and bounded `/calibrations` views, but calibration remains
untrusted, non-Official, and ineligible for ranking. The preregistered candidate
uses a separate three-repeat calibration with 3,672 core plus 306 contrast
observations, or 3,978 total. The separate Official `72 × 17` run has 1,224
observations. The gate proves only preregistered absolute adequacy; it does not
compare `1.0.2` with `1.0.1` or prove superiority. Official pages can disclose
coverage-qualified time, provider-token, and API-equivalent cost evidence
separately from AIQ when a verified Official run is eventually published.
Candidate signed unit artifacts retain measured latency and available
provider-token counters, but the public aggregate gate artifacts omit efficiency
fields; see [Benchmark Method](benchmark-method.md).

Private tasks, fixtures, expected outputs, evaluators, signing keys, and Codex
authentication stay outside Git.

## Local demonstration

Use Node.js `24.15.0` or newer, npm `11.17.0` or newer, and the locked
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
existing AIQ database. The repository has one greenfield desired state and no
migration or compatibility path. The production project is already initialized;
use this command only for a replacement empty project, not for the current
project.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

After the promotion gate, the separately controlled reference must contain a
non-synthetic AIQ Core `1.0.2` corpus commitment, a canonical millisecond UTC
`published_at`, and the three production identities. Initialization validates
those fields and bindings but does not prove promotion. The expected receipt
contains scoring `1.0.2`, 72 tasks, 17 model configurations, and three nodes. The ordered task-metadata catalog
digest is
`sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937`;
the release-policy identity is `aiq-core/1.0.2`, and its catalog
release-identity digest is
`sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b`.

## Next reading

- [Architecture and runtime](architecture-and-runtime.md)
- [Benchmark method](benchmark-method.md)
- [Operations](operations.md)
- [Deployment handoff](deployment-handoff.md)
- [Template adoption](template-adoption.md)
- [Knowledge maintenance](knowledge-maintenance.md)

Source and tests take priority if these pages drift.
