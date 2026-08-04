---
type: 'Method'
title: 'Benchmark Method'
description: 'AIQ Core fixture, scoring, execution, and verification method.'
tags: ['benchmark', 'method', 'scoring']
---

# Benchmark Method

## Fixture

Repository source targets AIQ Core `1.0.2`, benchmark release
`aiq-core@1.0.2`, and scoring implementation `1.0.2`. It contains 72 fixed
private tasks in ten domains. This is the one greenfield scoring contract.

| Domain                          | Tasks |
| ------------------------------- | ----: |
| Coding                          |     8 |
| Debugging                       |     8 |
| Repository understanding        |     7 |
| Data processing                 |     8 |
| Retrieval and verification      |     7 |
| Documentation and communication |     7 |
| Planning and execution          |     7 |
| Tool use                        |     7 |
| Instruction following           |     6 |
| Reliability and recovery        |     7 |

The public catalog exposes metadata and commitments only. Private prompts,
fixtures, expected outputs, and evaluators stay in controlled storage.

The ordered public catalog digest is:

```text
sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937
```

The release-policy identity is `aiq-core/1.0.2`. Its catalog
release-identity digest is
`sha256:54e8010f9c9ebc187574015dd6f8a62fd8025884d86c5cdd0d581551ab6095a6`.

One current `aiq.corpus-commitment.v2` document binds every private task to that
catalog. It also binds the baseline workspace, fixture bundle, evaluator,
runtime, runner source, harness, tool policy, network policy, and environment.

## Published Official evidence

Production publishes one complete, non-synthetic Official `72 × 17` matrix, or
1,224 results. Before the paid run, model-free validation checks all 72 core task
definitions, six contrast variants, 648 fixed evaluator bindings, toolchain
identities, source bindings, and deterministic evaluator outputs on the native
macOS host. Contrast tests are validation evidence; they do not add rows to the
Official matrix. Use the top-level model-free validators for these two
controlled corpora:

```sh
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
```

The native macOS runner completed the first real Official benchmark batch. Its
17 configurations each attempted all 72 tasks, for 1,224 terminal task-level
results: 1,218 completed and 6 failed. The native verifier replayed the
committed evaluators, and the distinct publisher published the matrix as
`trusted_verified` through the [Architecture and Runtime](architecture-and-runtime.md)
verification flow. Outcomes are 329 `correct`, 259 `partial`, 630 `incorrect`,
5 `timeout`, and 1 `budget_exhausted`.

Signed batch wall time is 5,844,411 ms (`1:37:24.411`). Public views contain 17
runs, 1,224 results, 17 leaderboard rows, 17 model-efficiency rows, and 17
model-matrix rows.

Cost coverage is 1,208 `estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage` results. The $125.403257240 priced subtotal is a
Standard API-equivalent estimate for only the 1,208 priced results; it is neither
actual ChatGPT subscription spend nor a complete matrix total. Publication
created 4,395 artifact bindings, including 19 capability artifacts. The method
preserves unsupported or unavailable capability and cost states instead of
replacing them with fabricated output or zero.

## Model matrix

The matrix has 17 configurations:

- Sol: low, medium, high, xhigh, max, ultra;
- Terra: low, medium, high, xhigh, max, ultra;
- Luna: low, medium, high, xhigh, max.

Capability preflight probes each exact configuration. Official and calibration
execution both require a usable full 17-entry report. Saved calibration records
retain a full 17-entry report, which must cover every selected model. A run
preserves explicit unavailable or unsupported entries instead of inventing
output for those configurations. This capability evidence is part of the runner
trust boundary in
[Architecture and Runtime](architecture-and-runtime.md).

## Execution

Each task starts from a controlled baseline in a fresh workspace. The runner
uses the committed Node.js and ripgrep tools and the exact Codex executable.
Task budgets, allowed tools, evaluator identity, and artifact requirements come
from the committed task contract.

The runner records exact timings, outcomes, tool use, result commitments,
workspace snapshots, evaluator output, and provenance. A durable checkpoint
supports interruption recovery without replacing completed evidence.

## Time, tokens, and API-equivalent cost

Each result distinguishes selected, attempted, adapter-invoked, and
elapsed-observed work. An attempt starts after capability admission. An adapter
invocation starts after workspace preparation. Runner-observed wall time
measures the Codex adapter invocation only; it excludes workspace setup,
artifact sealing, and evaluator replay. The verifier cannot reproduce the
clock value, so public data labels its authority as `runner_observed`.

Official publication keeps two different clocks. `matrix_batch_elapsed_ms` is
the signed wall-clock for the complete matrix stage, shared across all 17 model
configurations and counted once. `summed_cell_adapter_elapsed_ms` adds retained
cell invocation durations for one configuration; those cells may overlap at the
recorded execution concurrency, so this sum is not isolated model latency and
must not be added to the shared batch clock. TTFT and TPS are unavailable and
are not inferred.

When Codex reports token counters, the runner retains the exact provider event.
The verifier parses those bytes again before publishing input, cached-input,
cache-write-input, output, reasoning-output, and total-token values. Aggregates
publish a separate observed count and percentage for each of those six categories
and provide total cost only when every selected result is estimable. Zero
observations remain unavailable rather than being presented as `0%`; missing,
adapter-uninvoked, or inconsistent counters never become zero.

The cost field uses the versioned
`aiq.standard-api-equivalent-usd.v1` method and the Standard processing-tier
rates observed on 2026-08-02 at the
[official OpenAI pricing page](https://developers.openai.com/api/docs/pricing).
It separates normal input, cached input, cache-write input, and output.
Reasoning tokens are a subset of output and are not added twice. Published
pricing applies a 2x input and 1.5x output rate above 272,000 input tokens, but an
aggregate result cannot identify each request's context band; an aggregate over
that boundary is therefore unpriced rather than guessed. Regional uplift,
hosted-tool fees, and subscription pricing are excluded. The value is an
API-equivalent comparison, not actual subscription spend.

Signed AIQ Core `1.0.2` result packages retain measured latency and any available
usage fields. Public aggregates include only verified, coverage-qualified timing,
token, and Standard API-equivalent cost evidence.

### External reference decisions

Product research on 2026-08-03 reviewed the
[Codex Radar overview](https://codexradar.com/en/) and its
[distributed benchmark method](https://deng.codexradar.com/intro). Codex Radar
usefully presents model quality beside estimated cost and elapsed time. Its
distributed method also keeps subscription credentials on the runner, supports
resume, and uses a separate clean verification environment. These are useful
problem statements, not protocol authority for AIQ.

AIQ keeps the three measures independent. It does not combine correctness,
time, and cost into one ranking score. It retains task-level provenance and all
history instead of a short rolling window. It also distinguishes observed
Codex adapter time, provider-reported token counters, verifier-recomputed API
equivalent cost, and actual subscription billing. Only the first three can be
published by the current evidence protocol; actual subscription billing stays
unknown. Distributed contributions remain non-Official until an independent
verifier reproduces the deterministic evaluator result and a separate publisher
accepts the signed package.

## Outcomes and scoring

Correct and partial outcomes contribute their evaluator score. Attributable
incorrect, timeout, budget, tool, policy, and wrong-artifact outcomes contribute
zero. Infrastructure-invalid and missing outcomes block an Official score.
Unsupported configurations use `not_applicable` and remain visible.

AIQ v1 computes each domain mean and then gives each of the ten domains weight
`0.1`. It does not multiply the score by coverage. The reported interval is a
fixed-fixture task-resampling sensitivity interval with 10,000 deterministic
bootstrap samples and the checked-in correction factor.

An Official result requires non-synthetic evidence for all 72 tasks in one model
configuration and valid evidence for the complete 17-configuration batch. A
complete synthetic score uses `synthetic_complete`: it retains the descriptive
conditional AIQ, completion bounds, and sensitivity interval, but its Official
AIQ is null and it is never ranking eligible. Partial data can be shown as
Provisional or coverage-only but is not ranked as Official.

## Verification

The runner signs one `aiq.result-package.v3` envelope. For an Official run, the
verifier checks the signature and content hashes, reconstructs submitted
workspaces, replays the deterministic evaluators, and signs
`aiq.verifier-attestation.v3` only after the normalized stage and replay bindings
agree.

Calibration uses a parallel but permanently non-Official contract. The verifier
replays the selected controlled tasks, recomputes scores and efficiency
aggregates, creates `aiq.calibration-verified-stage.v1`, and signs
`aiq.calibration-verifier-attestation.v1`. The stage binds the exact package,
selection digests, capability and provenance evidence, evaluator-results
artifact, execution concurrency, scoring version, benchmark release, telemetry,
and pricing method. Replay-verified provenance does not change its `untrusted`
trust tier or make it Official or ranking eligible.

The runner and verifier identities must differ. A third publisher identity
completes either publication transition. The separate calibration register
surfaces this evidence without mixing it into the Official leaderboard, compare,
or trends data described by [Architecture and Runtime](architecture-and-runtime.md).

## Synthetic data

Synthetic tasks, runs, scores, nodes, and browser fixtures exercise the same
public paths. They remain explicitly synthetic and unverified. Even complete
synthetic fixtures are not Official. They do not measure a real model or
disclose the private corpus.
