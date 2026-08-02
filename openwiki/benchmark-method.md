---
type: 'Method'
title: 'Benchmark Method'
description: 'AIQ Core fixture, scoring, execution, and verification method.'
tags: ['benchmark', 'method', 'scoring']
---

# Benchmark Method

## Fixture

AIQ Core `1.0.1` contains 72 fixed private tasks in ten domains. Its benchmark
release is `aiq-core@1.0.1`; the independently versioned scoring implementation
remains `1.0.0`.

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
sha256:b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc
```

One current `aiq.corpus-commitment.v2` document binds every private task to that
catalog. It also binds the baseline workspace, fixture bundle, evaluator,
runtime, runner source, harness, tool policy, network policy, and environment.

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

When Codex reports token counters, the runner retains the exact provider event.
The verifier parses those bytes again before publishing input, cached-input,
cache-write-input, output, reasoning-output, and total-token values. Aggregates
publish coverage counts separately and provide total cost only when every
selected result is estimable. Missing, adapter-uninvoked, or inconsistent
counters stay unavailable rather than becoming zero.

The cost field uses the versioned
`aiq.standard-api-equivalent-usd.v1` method and the Standard processing-tier
rates observed on 2026-08-02 at the
[official OpenAI pricing page](https://developers.openai.com/api/docs/pricing).
It separates normal input, cached input, cache-write input, and output.
Reasoning tokens are a subset of output and are not added twice. If aggregate
input is more than 272,000 tokens, the estimate is null because aggregate usage
cannot identify the context band of each request. The value is an API-equivalent
comparison. It is not actual subscription spend.

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
verifier checks the signature and content hashes, reconstructs candidate
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
