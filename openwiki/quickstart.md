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
- an active public AIQ Core `aiq-core@1.0.6` candidate, with 72 private-task
  identities, a public catalog, and scoring `1.0.6`;
- one PostgreSQL desired state with RLS, public reads, controlled writes, and
  private Storage lifecycle records.

The fixed model matrix has 17 configurations. Production has exactly three
distinct identities: runner, verifier, and publisher.

The active public candidate, task, and scorer contract is `1.0.6`. It changes
only task-level runtime envelopes for five interaction tasks and carries forward
the other 67 task, evaluator, tool, and budget contracts with new bindings. The
public catalog is deterministic and identity-frozen. Two controlled generations
produced one matching tree, and the reviewed 72-task database commitment is
bound in source. Final clean-commit regeneration, the fresh targeted pilot,
full calibration, Contrast generation, native build verification, a real
Official run, publication, and final deployment are pending. The only production
tuple is AIQ Core `1.0.6`, scoring `1.0.6`, and measurement `2.0.0`. Production
must not publish an Official matrix until the new real package passes verification.

The `1.0.3` Official attempt was interrupted after an already-conclusive
ceiling failure. It was rejected as unpublished calibration evidence. No hidden
responses or hidden task details were published. The first `1.0.4` calibration
completed all 1,224 cells but failed the statistical release gate. Preserve it
as non-Official evidence; do not describe it as 1,224 failed executions. For
`1.0.6`, run coding-07 across all 17 configurations, then run the five
runtime-revised tasks across all 17 configurations as an 85-cell
pilot before the complete 17-by-72 non-Official calibration. An operator cannot
override a failed release gate. Real calibration stays non-Official until the
signed verifier and distinct-publisher admission flow accepts it into the
calibration register, and it remains non-Official after acceptance.

The first `1.0.5` pilot completed 63 of 68 selected cells and recorded five
timeouts. Completed means ranged from 0.933 to 0.992, so the pilot rejected the
task set as saturated. A later interaction pilot exposed seven timeouts and
three tool-budget failures at the shared 900-second, 40-step, and 28-tool-call
envelope. AIQ Core `1.0.6` keeps the bounded keyed executor, quoted-record
parser, six-field layered service configuration, and bounded Unicode log
preview semantics. It gives coding-07 a common 600-second, 32-step, and
21-tool-call budget; debugging-02 a common 1,800-second, 64-step, and
56-tool-call budget; and coding-06, debugging-01, and debugging-04 a common
1,500-second, 48-step, and 40-tool-call budget for every model configuration.
This candidate still needs a fresh debugging-02-by-17 falsification pilot and
17-by-5 pilot. The reviewed public-safe database task-set and task-commitment
identities are now regenerated and bound to the current controlled 72-task
commitment; final clean-source Core and Contrast regeneration remains pending.

## Deployment status

AIQ production is live at `https://aiq.wiki`. The personal Vercel scope
`acgbox` hosts project `aiq`, and the personal Supabase organization `ACG Box`
hosts project `aiq` on PostgreSQL 17.6 with reference
`xxnszykaeapolqdnhalx`. The personal Cloudflare account that owns the
`aiq.wiki` zone owns DNS handoff. The two production Storage buckets,
`aiq-submission-packages` and `aiq-runner-artifacts`, are private. The apex is
canonical; `www.aiq.wiki` preserves paths through a permanent `308` redirect.
Automatic Vercel project and branch aliases can be removed only transiently
because a later deployment can recreate or reassign them. A deployment-specific
URL is intrinsic to its retained deployment. The current generated Vercel
surfaces emit `noindex`.

The accepted Official publication must be one real non-synthetic `72 × 17`
batch, or 1,224 task-level results, under the sole production tuple. The native
verifier must replay the deterministic evaluators before the distinct publisher
can publish it as `trusted_verified`. A legacy publication is not a fallback.

The public site is a professional analysis workbench over verified production
evidence. It separates semantic task outcomes from runtime states. Official
evidence shows calibrated ability with its conditional 95% interval. Explicit
synthetic fixtures show descriptive quality with task-mix sensitivity and never
appear as Official. The site also reports strict pass with a Wilson interval,
renders ECharts as SVG with ARIA descriptions, and supports system, light, and
dark themes. Synthetic data is limited to explicit development and test paths.
The scorer-owned browser fixture in
`benchmarks/fixtures/aiq-2.0-test-generated-public.json` is generated by the
Rust `generate-test-public-fixture` command. Its outer contract rejects
production publication, Official eligibility, and ranking eligibility.

Production still has no cloud runner or verifier worker and no recurring
benchmark or Storage schedule. The twice-daily benchmark schedule and its next
run remain pending operations work; documentation must not authorize recurring
automation. See [Deployment Handoff](deployment-handoff.md) for the remaining
operational boundary.

The native subscription runner copies `~/.codex/auth.json` into an isolated,
mode-private `CODEX_HOME` and passes that directory to the Codex subprocess.
Capability preflight requires one completed command plus the exact
`AIQ_CAPABILITY_COMMAND_AND_WRITE_V1` workspace marker for each available model;
the marker is retained as `capability-marker.txt` and checked by replay. The
verifier never receives the Codex home or credentials.

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
cargo run -p aiq-runner -- seal-corpus --help
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
controlled reference must contain a non-synthetic AIQ Core `1.0.6` corpus
commitment, a canonical
millisecond UTC `published_at`, and the three production identities.
Initialization can start only after one real signed non-synthetic 17-by-72
package passes native verifier replay. It validates those fields and bindings. The expected initialization
receipt must contain scoring `1.0.6`, 72 tasks, 17 model configurations, three nodes,
40 private forced-RLS tables, 12 canonical AIQ-owned security-invoker public
views, and two hardened gateway roles. Unrelated `public` views stay outside the
AIQ readiness inventory. The ordered task-metadata catalog digest is
`sha256:6dc43022b04333de889abc08de118d63652aeab6ee2c3b8610905a2faa91e460`;
the release-policy identity is `aiq-core/1.0.6`, and its public catalog
release-identity digest is
`sha256:fb2a1e088def5e88434ef383e92e0201b406d556c261e294c9ae86ea9bf3ae78`.
The reviewed evaluator identity is
`sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`,
the public-safe database task-set identity is
`sha256:54c7026ac723a2e932b01fe8bf6557c226d1a658c7f87ab9fc4645c88bdd7766`,
and the reviewed task-commitment manifest identity is
`sha256:9e09c963fe9d59b8a0b37958d4bda852a4eb8e7aa5ea6bfba86b39b41503884e`.
Final controlled corpus identities remain calibration candidates; final
clean-source Core and Contrast regeneration is not yet accepted. The shared
Rust validator fails closed unless
`runner.identity_kind` is `source_only` and `runner.built_binary_sha256` is
null. The checked Core schema enforces the same rule. Contrast has equivalent
shared typed enforcement even though it has no separate checked-in JSON schema.
Each corpus also binds the Node.js and ripgrep identities. The source-only corpus
rule and signed per-run runner and complete Codex runtime provenance are the
executable product contracts. The Codex runtime is an exact two-file directory:
`codex` plus `codex-code-mode-host`. After the final clean build, the operator
retains a private, unsigned audit receipt with the exact source commit and tree
identity and SHA-256 values for the native runner, verifier, Codex executable,
and Codex code-mode host. The offline native verifier validates the receipt
against an independently supplied digest. The receipt is not published, and
database initialization does not consume it. Node.js and ripgrep identities
remain in the corpus commitment.

## Next reading

- [Architecture and runtime](architecture-and-runtime.md)
- [Benchmark method](benchmark-method.md)
- [Operations](operations.md)
- [Deployment handoff](deployment-handoff.md)
- [Template adoption](template-adoption.md)
- [Knowledge maintenance](knowledge-maintenance.md)

Source and tests take priority if these pages drift.
