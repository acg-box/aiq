---
type: 'Architecture'
title: 'Architecture and Runtime'
description: 'AIQ components, trust boundaries, data flow, and runtime contracts.'
tags: ['architecture', 'runtime', 'security']
---

# Architecture and Runtime

## Components

| Component           | Responsibility                                                         |
| ------------------- | ---------------------------------------------------------------------- |
| `apps/aiq-runner`   | Preflight, task execution, scoring, packaging, and submission          |
| `apps/aiq-verifier` | Queue claims, reconstruction, evaluator replay, and attestations       |
| `apps/web`          | Public reads and controlled submission, claim, and verification routes |
| `databases`         | Desired PostgreSQL state, RLS, RPCs, views, and Storage metadata       |
| `benchmarks`        | Public catalog, schemas, and synthetic examples                        |

The operator supplies the private corpus, evaluator files, workspaces, runtime,
Codex profile, and keys. These inputs are not repository data.

## Identity boundary

Production uses three Ed25519 identities:

1. The runner signs `aiq.result-package.v3`.
2. The verifier signs `aiq.verifier-attestation.v3` and must differ from the
   runner.
3. The publisher completes the database publication transition and must differ
   from both.

The gateway mints short-lived custom-role JWTs for verifier and publisher RPCs.
The browser never receives those credentials.

## Runner flow

The runner validates the public catalog, current corpus commitment, controlled
toolchain, evaluator runtime, source manifest, capability manifest, schedule,
and path layout. Preflight probes the exact local Codex CLI and writes an
authenticated expiring report.

A live run uses fresh task workspaces and content-addressed artifacts. It writes
a durable checkpoint and creates one `aiq.run.v3` record. An Official run is
non-synthetic, complete, and exactly 17 by 72. Calibration runs are not Official.

`aiq.run-provenance.v2` contains 18 top-level fields. It binds the run class,
corpus, catalog, task set, evaluator, runtime, preflight, harness, prompt, tool
policy, network policy, environment, source manifest, runner executable, Codex
executable, and permission evidence.

## Verification flow

The submission route stores exact package bytes and required artifacts in
private Storage before it queues an unverified inbox record. Queue receipt does
not publish the run.

The verifier claims a bounded lease, downloads only claim-bound artifacts,
reconstructs candidate workspaces, and replays committed evaluators with the
committed runtime. Production requires the `evaluator_replayed` disposition.

The verification route performs three ordered database actions:

1. stage `aiq.normalized-batch.v3`;
2. record the immutable verifier attestation;
3. publish through the distinct publisher role.

Database functions enforce exact structure, identity separation, bindings,
append-only evidence, and complete run state.

## Database boundary

`databases/schema.sql` owns the complete desired state. Private tables are in
`aiq_private`. RLS is enabled and forced. Eight security-invoker views and one
bounded trend RPC provide browser reads. Browser roles do not have private-table
write access.

`databases/init.ts` is a one-connection, one-transaction initializer for a new
AIQ database. It inserts the current public catalog, scoring definition, model
matrix, corpus commitment, and runner/verifier/publisher identities.

## Storage boundary

Submitted packages and runner artifacts use separate private buckets. Database
rows bind object type, digest, byte count, retention state, and active
references. Reconciliation records database-only and Storage-only mismatches.
Deletion is a separate bounded worker action and cannot remove referenced or
held objects.

## Public application

The Next.js server reads the public views through the configured Supabase API.
In explicit development mode, missing public Supabase values select synthetic
seed data. Production and unknown modes fail closed.

`GET /api/readiness` checks configuration shape and bounded dependencies. It
does not claim that a deployment or benchmark run is complete.

## Distributed radar

The radar protocol keeps registry identity, signed observations, receipts, and
aggregation evidence distinct. Checked-in radar rows are synthetic. The
repository defines the contracts and public aggregate read but does not operate
a coordinator or remote nodes.
