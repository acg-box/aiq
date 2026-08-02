---
type: 'Method'
title: 'Benchmark Method'
description: 'AIQ Core fixture, scoring, execution, and verification method.'
tags: ['benchmark', 'method', 'scoring']
---

# Benchmark Method

## Fixture

AIQ Core `1.0.0` contains 72 fixed private tasks in ten domains:

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
sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3
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

The runner signs one `aiq.result-package.v3` envelope. The verifier checks the
signature and content hashes, reconstructs candidate workspaces, and replays the
deterministic evaluators. It signs `aiq.verifier-attestation.v3` only after the
stage and replay bindings agree.

The runner and verifier identities must differ. A third publisher identity
completes publication. Database constraints require the exact current v3
contracts and complete state.

## Synthetic data

Synthetic tasks, runs, scores, nodes, and browser fixtures exercise the same
public paths. They remain explicitly synthetic and unverified. Even complete
synthetic fixtures are not Official. They do not measure a real model or
disclose the private corpus.
