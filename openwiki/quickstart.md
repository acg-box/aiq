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
Official contract. This is one greenfield launch. No Official benchmark history
has been published.

## Deployment status

Production release acceptance is not complete. The target external resources
are the personal Supabase organization `ACG Box`, Supabase project `aiq`,
personal Vercel scope `acgbox`, Vercel project `aiq`, and apex domain
`https://aiq.wiki`. Repository documentation does not claim that these external
resources exist or are configured until live acceptance records that evidence.

The only Official path uses native Rust runner and verifier release binaries on
this Apple Silicon macOS host with direct network access. A real Official run
has not started. The required first publication is one complete `72 × 17`
matrix, or 1,224 observations. Official pages report coverage-qualified elapsed
time, provider-token use, and Standard API-equivalent cost separately from AIQ.

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
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
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
existing AIQ database. The repository has one greenfield desired state. Use this
command once for the new empty production project.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

After the controlled corpus and final native binaries pass model-free
validation, the separately controlled reference must contain a
non-synthetic AIQ Core `1.0.2` corpus commitment, a canonical millisecond UTC
`published_at`, and the three production identities. Initialization validates
those fields and bindings. The expected receipt
contains scoring `1.0.2`, 72 tasks, 17 model configurations, and three nodes. The ordered task-metadata catalog
digest is
`sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937`;
the release-policy identity is `aiq-core/1.0.2`, and its catalog
release-identity digest is
`sha256:54e8010f9c9ebc187574015dd6f8a62fd8025884d86c5cdd0d581551ab6095a6`.

## Next reading

- [Architecture and runtime](architecture-and-runtime.md)
- [Benchmark method](benchmark-method.md)
- [Operations](operations.md)
- [Deployment handoff](deployment-handoff.md)
- [Template adoption](template-adoption.md)
- [Knowledge maintenance](knowledge-maintenance.md)

Source and tests take priority if these pages drift.
