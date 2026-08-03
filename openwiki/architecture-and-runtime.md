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

Repository source has one active full-catalog Official contract: AIQ Core
`1.0.2` with scoring `1.0.2`, task-metadata digest
`sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937`,
release-policy identity `aiq-core/1.0.2`, and catalog release-identity digest
`sha256:54e8010f9c9ebc187574015dd6f8a62fd8025884d86c5cdd0d581551ab6095a6`.
This is the only launch contract. No real Official run exists.

## Identity boundary

Production uses three Ed25519 identities:

1. The runner signs `aiq.result-package.v3`.
2. The verifier signs `aiq.verifier-attestation.v3` and must differ from the
   runner.
3. The publisher completes the database publication transition and must differ
   from both.

The gateway mints short-lived custom-role JWTs for verifier and publisher RPCs.
The browser never receives those credentials.

## Native macOS runtime

The first release runs the release builds of `aiq-runner` and `aiq-verifier`
directly on one controlled Apple Silicon macOS host. The runner receives the
private corpus, fresh workspaces, a separate immutable Codex authentication
copy, and only the runner credential needed by the active command. The verifier
receives the committed corpus, evaluator assets, submitted artifacts, and only
its verifier credential. It never receives the Codex authentication copy.

The native runtime uses canonical non-overlapping paths, a clean source worktree
at the declared commit, exact executable digests, mode-private writable roots,
create-new outputs, and macOS atomic file operations. Before each paid command,
the operator reruns the model-free binding checks. Codex uses the host's direct
network connection. The first release does not depend on or run Linux or Docker;
they remain a future deployment target outside first-release acceptance.

After model-free validation, the only Official path runs one complete
`72 × 17` matrix of 1,224 observations, replays it with the native verifier,
and publishes the verified batch. [Operations and Validation](operations.md)
owns the native commands, and [Deployment Handoff](deployment-handoff.md) owns
external service configuration and production acceptance.

## Runner flow

Before any paid Official preflight, `admit-permissions` validates the exact
72-by-17 plan, controlled-input identities, schedule occurrence, conservative
capacity, worker count, and permission boundary. The runner starts Codex with
strict CLI configuration that selects the explicit `aiq_benchmark` profile and
requires external managed requirements to be absent, then runs the sandbox
canaries and validates the planned preflight, checkpoint, run, score, and package
paths. It writes one private create-once
`aiq.official-permission-admission.v2` receipt without invoking a model. Paid
preflight validates the public catalog, current corpus commitment, controlled
toolchain, evaluator runtime, source manifest, capability manifest,
schedule, and path layout, probes the exact local Codex CLI, and binds its
expiring report to that receipt. The same admission is required by Official
`run`, `score`, and `package`; calibration rejects it.

```mermaid
sequenceDiagram
    participant O as Operator
    participant R as Runner
    participant C as Codex CLI
    O->>R: Admit exact Official plan
    R->>R: Check policy canaries paths capacity and schedule
    R-->>O: Private admission v2 receipt
    O->>R: Paid preflight with receipt
    R->>C: Probe exact 17-model capability matrix
    R-->>O: Receipt-bound preflight report
    O->>R: Run score and package with same receipt
    R->>C: Execute admitted 72-by-17 plan
    R-->>O: Reserved run and create-new score and package
```

The flow prevents a model invocation before the exact Official plan passes
permission admission and prevents later stages from silently changing that plan.

A live run uses fresh task workspaces and content-addressed artifacts. It writes
a durable checkpoint and creates one `aiq.run.v3` record. Official run output is
held by an exact run-bound reservation so only the unchanged run may recover it
after interruption; score and package outputs remain create-new. Parent ownership,
nonblocking advisory locks, link checks, and macOS atomic writes form the
trusted single-writer boundary. An Official run is non-synthetic, complete, and
exactly 17 by 72. Calibration accepts a deterministic subset but remains
untrusted, non-Official, and ineligible for ranking.

After each paid invocation, the runner retains the available invocation and
workspace evidence before cleanup. Authentication, subscription-limit, or
workspace-integrity boundaries cancel remaining paid cells; checkpoints do not
automatically retry indeterminate or boundary-failed cells. This avoids paying
again while replacing evidence whose outcome is uncertain.

`aiq.run-provenance.v2` contains 18 top-level fields. It binds the run class,
corpus, catalog, task set, evaluator, runtime, preflight, harness, prompt, tool
policy, network policy, environment, source manifest, runner executable, Codex
executable, and permission evidence.

## Verification flow

The submission route stores exact package bytes and required artifacts in
private Storage before it queues an unverified inbox record. Queue receipt does
not publish the run.

The verifier claims a bounded lease, downloads only claim-bound artifacts,
reconstructs submitted workspaces, and replays committed evaluators with the
committed runtime. Production requires the `evaluator_replayed` disposition.

The verification route performs three ordered database actions for Official
evidence: stage `aiq.normalized-batch.v3`, record the immutable verifier
attestation, then publish through the distinct publisher role. Calibration uses
the same verifier and publisher identity boundary with separate stage,
attestation, and publication RPCs. Its verifier replays the selected task
artifacts, recomputes descriptive scores and efficiency evidence, and binds them
in `aiq.calibration-verified-stage.v1` plus a signed
`aiq.calibration-verifier-attestation.v1`.

```mermaid
sequenceDiagram
    participant R as Runner
    participant G as Web Gateway
    participant V as Verifier
    participant D as Database
    participant P as Publisher
    R->>G: Submit signed calibration package and artifacts
    G->>D: Queue unverified package
    V->>G: Claim package lease
    V->>V: Reconstruct workspaces and replay evaluators
    V->>G: Send calibration stage and attestation
    G->>D: Stage replayed calibration evidence
    G->>D: Record signed verifier attestation
    G->>P: Request distinct publisher transition
    P->>D: Reconcile retained evidence and publish calibration marker
```

The flow keeps replay-verified calibration evidence public but outside Official
and ranking publication.

Database functions enforce exact structure, identity separation, lease and
attempt bindings, append-only evidence, retained Storage completeness, and the
permanent non-Official classification. Retry-safe recorded dispositions allow a
partially completed multi-RPC request to continue without replacing evidence.

## Database boundary

`databases/schema.sql` owns the complete desired state. Private tables are in
`aiq_private`, with RLS enabled and forced. Security-invoker views and one bounded
trend RPC provide browser reads; calibration adds bounded run, score, result,
and model-efficiency views that require an explicit calibration publication
marker. They expose fixed public-safe failure explanations and omit packages,
signatures, raw provider events, artifacts, and private failure details.
Browser roles do not have private-table write access.

`databases/init.ts` is a one-connection, one-transaction initializer for a new
AIQ database. It accepts only the AIQ Core `1.0.2` catalog and scoring `1.0.2`.
The controlled production reference must supply a non-synthetic corpus
commitment, a canonical millisecond UTC `published_at`, and the runner,
verifier, and publisher identities. Operationally,
[Deployment Handoff](deployment-handoff.md) requires model-free validation of
the controlled corpus and final native binaries before preparing that
reference. The initializer validates its shape and bindings. It inserts the
reference with the model matrix as the one greenfield desired state.

## Storage boundary

Submitted packages and runner artifacts use separate private buckets. Database
rows bind object type, digest, byte count, retention state, and active
references. Reconciliation records database-only and Storage-only mismatches.
Deletion is a separate bounded worker action and cannot remove referenced or
held objects.

## Public application

The Next.js server reads public views through the configured Supabase API. The
production path requires both browser-safe Supabase values and serves only live
public evidence. Development uses checked-in synthetic fixtures only when both
values are absent. Partial or malformed configuration fails closed.

The standard public application also exposes `/calibrations` and
`/calibrations/[id]`. The register uses bounded 20-run keyset pages; detail reads
one selected model's task slice and publishes descriptive score, elapsed-time,
token-coverage, and API-equivalent cost evidence. These pages require explicit
calibration publication and do not feed the Official leaderboard, compare, or
trends surfaces.

Verified Official evidence has a separate public efficiency projection used by
the overview, compare, trends, and Official run-detail pages. Each model row binds
to one published non-synthetic score and its matrix batch. The signed matrix batch
wall-clock is shared by all 17 configurations and counted once; per-cell adapter
durations are summed separately and may overlap at the recorded concurrency. A
narrow per-result view exposes only derived timing, six token categories, cost
status, and verifier-recomputed evidence labels, not raw provider events,
signatures, digests, packages, or private failures. Repository reads reject
duplicate identities, inconsistent shared batch durations, impossible counts,
partial timing groups, invalid coverage percentages, and partial pricing metadata.
The readiness probe includes these public-read contracts under
`public_read_views`. Their measurement meaning belongs to
[Benchmark Method](benchmark-method.md).

```mermaid
flowchart TD
    Start["Create public data repository"] --> Config{"Public Supabase configuration"}
    Config -->|valid| Production["Serve live public evidence"]
    Config -->|both absent in development| Seed["Serve local synthetic fixtures"]
    Config -->|partial, malformed, or absent in production| Invalid["Fail closed"]
```

The flow shows how production, local synthetic, and invalid configurations
select a public-data repository.

`GET /api/readiness` checks configuration shape and bounded production
dependencies. It does not claim that a deployment or benchmark run is complete,
and it fails closed when a required production dependency is absent.

## Distributed radar

The radar protocol keeps registry identity, signed observations, receipts, and
aggregation evidence distinct. Checked-in radar rows are synthetic. The
repository defines the contracts and public aggregate read but does not operate
a coordinator or remote nodes.
