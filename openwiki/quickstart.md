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
- an active public AIQ Core `aiq-core@1.0.5` candidate, with 72 private-task
  identities, a public catalog, and scoring `1.0.5`;
- one PostgreSQL desired state with RLS, public reads, controlled writes, and
  private Storage lifecycle records.

The fixed model matrix has 17 configurations. Production has exactly three
distinct identities: runner, verifier, and publisher.

The active public candidate, task, and scorer contract is `1.0.5`. It retargets
four calibration-sensitive tasks and carries forward 68 task designs with new
bindings. Controlled identities, final calibration, native build verification,
a real Official run, publication, and final deployment are pending. Production
still publishes the one historical AIQ Core `1.0.2` Official matrix; no `1.0.5`
Official run or deployment has been accepted.

The `1.0.3` Official attempt was interrupted after an already-conclusive
ceiling failure. It was rejected as unpublished calibration evidence. No hidden
responses or hidden task details were published. The first `1.0.4` calibration
completed all 1,224 cells but failed the statistical release gate. Preserve it
as non-Official evidence; do not describe it as 1,224 failed executions. For
`1.0.5`, run the four revised tasks across all 17 configurations as a 68-cell
pilot before the complete 17-by-72 non-Official calibration. An operator cannot
override a failed release gate. Real calibration stays non-Official until the
signed verifier and distinct-publisher admission flow accepts it into the
calibration register, and it remains non-Official after acceptance.

## Deployment status

AIQ production is live at `https://aiq.wiki`. The personal Vercel scope
`acgbox` hosts project `aiq`, and the personal Supabase organization `ACG Box`
hosts project `aiq` on PostgreSQL 17.6 with reference
`xxnszykaeapolqdnhalx`. The personal Cloudflare account that owns the
`aiq.wiki` zone owns DNS handoff. The two production Storage buckets,
`aiq-submission-packages` and `aiq-runner-artifacts`, are private. The first
Official launch publication was deployed from merge commit
`725b88954359ab8f0950f896674b3e8684d3ae85`. This commit is historical launch
evidence, not the identity of every later production deployment. The apex is
canonical; `www.aiq.wiki` preserves paths through a permanent `308` redirect.
Automatic Vercel project and branch aliases can be removed only transiently
because a later deployment can recreate or reassign them. A deployment-specific
URL is intrinsic to its retained deployment. The current generated Vercel
surfaces emit `noindex`.

The native Apple Silicon macOS runner completed one real `72 × 17` Official
AIQ Core `1.0.2` benchmark batch, or 1,224 task-level results. This is one
matrix, not 1,224 separate benchmark runs. The native verifier replayed the deterministic
evaluators, and the distinct publisher published the matrix as
`trusted_verified` through the flow described in
[Architecture and Runtime](architecture-and-runtime.md). Of the results, 1,218
completed and 6 runtime issues: 329 `correct`, 259 `partial`, 630 `incorrect`, 5
`timeout`, and 1 `budget_exhausted`. Signed batch wall time is 5,844,411 ms
(`1:37:24.411`).

Cost coverage is 1,208 `estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage` results. The $125.403257240 priced subtotal is a
Standard API-equivalent estimate for the 1,208 priced results, not actual ChatGPT
subscription spend or a complete batch total. Missing values are not zero; the
measurement rules live in [Benchmark Method](benchmark-method.md). Public views
contain 17 runs, 1,224 results, and 17 rows each for the leaderboard, model
efficiency, and model matrix. Publication created 4,395 artifact bindings,
including 19 capability artifacts.

The public site is a professional analysis workbench over this real historical
evidence. It separates semantic task outcomes from runtime states, shows the
fixed-fixture task-sensitivity interval, renders ECharts as SVG with ARIA
descriptions, and supports system, light, and dark themes. Synthetic data is
limited to explicit development and test paths.

Production still has no cloud runner or verifier worker and no recurring
benchmark or Storage schedule. The twice-daily benchmark schedule and its next
run remain pending operations work; documentation must not authorize recurring
automation. See [Deployment Handoff](deployment-handoff.md) for the remaining
operational boundary.

The native subscription runner copies `~/.codex/auth.json` into an isolated,
mode-private `CODEX_HOME` and passes that directory to the Codex subprocess.
The verifier never receives it.

Private tasks, fixtures, expected outputs, evaluators, signing keys, and Codex
authentication stay outside Git.

## Local demonstration

Use Node.js `24.15.0` or newer, npm `11.17.0` or newer, Rust `1.97.1`, and the
locked dependencies.

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
`databases/init.ts` connects directly to the Supabase PostgreSQL database and
applies the schema plus public reference data in one transaction. There is no
migration chain. It rejects an
existing AIQ namespace. Apply the repository's one greenfield desired state to
the existing target project only after its AIQ namespace is empty. If residue
exists, remove only the exact AIQ-owned schema, roles, public views, and RPC
overloads. Preserve all Supabase-managed and non-AIQ objects. This cleanup is a
deployment prerequisite, not a migration or compatibility path. The schema
creates both AIQ Storage buckets as private and rejects either existing bucket
identity. Do not create the buckets in a separate operator step.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

For an empty AIQ namespace, after the controlled corpus passes model-free
validation and the operator verifies the final native build, the separately
controlled reference must contain a non-synthetic AIQ Core `1.0.5` corpus
commitment, a canonical
millisecond UTC `published_at`, and the three production identities.
Initialization validates those fields and bindings. The expected initialization
receipt must contain scoring `1.0.5`, 72 tasks, 17 model configurations, three nodes,
40 private forced-RLS tables, 12 canonical AIQ-owned security-invoker public
views, and two hardened gateway roles. Unrelated `public` views stay outside the
AIQ readiness inventory. The ordered task-metadata catalog digest is
`sha256:e5ec5c2fa9d3423b228eb3fc4e717be8e48e34e1a1352608394aa4643850c1a1`;
the release-policy identity is `aiq-core/1.0.5`, and its public catalog
release-identity digest is
`sha256:4431b4027ce35f5bee9dda55cbcb8e28dcd985708da2918ec94ff7cee76ed529`.
The controlled scorer-manifest, evaluator, runtime task-set, generated-task
tree, Core corpus, Contrast corpus, and database commitment identities are
pending. Create-new generation and review must establish them. The shared Rust
validator fails closed unless
`runner.identity_kind` is `source_only` and `runner.built_binary_sha256` is
null. The checked Core schema enforces the same rule. Contrast has equivalent
shared typed enforcement even though it has no separate checked-in JSON schema.
Each corpus also binds the Node.js and ripgrep identities. The source-only corpus
rule and signed per-run runner and Codex executable provenance are the executable
product contracts. After the final clean build, the operator retains a private,
unsigned audit receipt with the exact source commit and tree identity and SHA-256
values for the native runner, verifier, Node.js, and ripgrep executables. The
repository does not validate or publish this reproducibility evidence, and
database initialization does not consume it.

## Next reading

- [Architecture and runtime](architecture-and-runtime.md)
- [Benchmark method](benchmark-method.md)
- [Operations](operations.md)
- [Deployment handoff](deployment-handoff.md)
- [Template adoption](template-adoption.md)
- [Knowledge maintenance](knowledge-maintenance.md)

Source and tests take priority if these pages drift.
