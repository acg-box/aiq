---
type: 'Method'
title: 'Benchmark Method'
description: 'AIQ Core fixture, scoring, execution, and verification method.'
tags: ['benchmark', 'method', 'scoring']
---

# Benchmark Method

## Fixture

Repository source targets the public AIQ Core `1.0.5` candidate, benchmark
release `aiq-core@1.0.5`, and scoring implementation `1.0.5`. It contains 72 fixed
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
sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7
```

The release-policy identity is `aiq-core/1.0.5`. Its public catalog
release-identity digest is
`sha256:496b40f54dc7c3dc92d8880201373344c723001a0570a4debd28e539cfe4030d`.
The controlled scorer-manifest, evaluator, runtime task-set, generated-task
tree, Core corpus, Contrast corpus, and database commitment identities are
pending. Create-new generation and review must establish them. Each final
corpus keeps
`runner.identity_kind` as `source_only` and `runner.built_binary_sha256` as
null. The shared Rust validator now fails closed on this runner subtree. The
checked Core schema enforces the same rule. Contrast has equivalent shared typed
enforcement even though it has no separate checked-in JSON schema. Each corpus
binds every private task to its catalog and also binds the baseline workspace,
fixture bundle, evaluator, runtime, runner source, harness, tool policy, network
policy, environment, Node.js identity, and ripgrep identity.
The source-only corpus rule and signed per-run runner and Codex executable
provenance are the executable product contracts. After the final clean build,
the operator retains a private, unsigned audit receipt with the exact source
commit and tree identity and SHA-256 values for the native runner, verifier,
Node.js, and ripgrep executables. The repository does not validate or publish
this reproducibility evidence.

## Published Official evidence

Production publishes one historical AIQ Core `1.0.2`, non-synthetic Official
`72 × 17` matrix, or 1,224 results. The `1.0.5` release gate checks all
72 Core task definitions and 432 fixed evaluator bindings: gold,
alternate-correct, partial, adversarial-format, empty, and timeout for every
task. The separate six-task Contrast calibration checks 36 bindings. Both
validators also bind toolchain identities, source inputs, and deterministic
evaluator outputs on the native macOS host. Contrast evidence does not add rows
to the Official matrix. Use the top-level model-free validators for these two
controlled corpora:

```sh
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
```

Contrast is an operator-enforced release gate before Official permission
admission. Its commitment is not an input to the 17-by-72 admission plan, and
its six tasks do not add cells to the 1,224-cell Official matrix.

The `1.0.3` Official attempt was interrupted after its observed calibration
cells already proved a ceiling-policy failure. It was rejected as unpublished
calibration evidence. No hidden responses or hidden task details were
published. The first `1.0.4` calibration then completed the full 17-by-72
matrix. Preserve those 1,224 cells as failed statistical release-gate evidence,
not as 1,224 failed task executions. The run remains non-Official and does not
authorize ranking or publication as Official evidence.

The public `1.0.5` redesign retargets four calibration-sensitive tasks:
`coding-06`, `debugging-01`, `debugging-02`, and `debugging-04`. The first
68-cell `1.0.5` pilot completed 63 cells and timed out on 5. It was rejected:
completed task means ranged from 0.933 to 0.992, all four task means exceeded
their release ceilings, and projected debugging facility was 0.9369. The five
timeouts remain missing evaluations, never semantic zeros.

The active create-new revision replaces the saturated single-dimension repairs
with interacting daily-work contracts. `coding-06` combines a bounded keyed
executor with priority, dynamic concurrency, AbortSignal, close, cancellation,
and idle epochs. `debugging-01` combines quoted records, constrained escapes,
independent UTF-16 limits, and indexed syntax errors. `debugging-02` resolves a
six-field layered service configuration with normalization, typed bounds,
built-ins, an atomic disable sentinel, and exact provenance. `debugging-04`
combines line-ending normalization, head and tail windows, grapheme-safe line
budgets, complete ellipses, and omission metadata. The revised tasks use a
900-second wall budget with the existing 40-step and 28-tool-call limits. This
budget responds to observed wall-time exhaustion; it does not alter scoring.
The other 68 task designs carry forward with new release bindings. Run a new
17-by-4, 68-cell non-Official pilot before paying for the full
17-by-72 non-Official calibration. The full calibration must meet the release
limits for universal semantic zeros and universal full scores, and it must show
sufficient informative tasks, non-uniform tasks, domain spread, and model
spread. The policy permits at most seven universal semantic-zero tasks and at
most seven universal-full tasks. An operator cannot override a failed gate.
Replay alone does not make real calibration Official: signed verifier admission
and the distinct publisher transition must accept it, and calibration remains
permanently non-Official.

The native macOS runner completed the first real Official benchmark batch. Its
17 configurations each attempted all 72 tasks, for 1,224 terminal task-level
results: 1,218 completed and 6 runtime issues. The native verifier replayed the
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
uses the Node.js and ripgrep identities from the corpus. Per-run provenance
binds the exact Codex and runner executables. Task budgets, allowed tools,
evaluator identity, and artifact requirements come from the committed task
contract.

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
Provider token counters use source label `provider_reported` and evidence label
`verifier_recomputed` after the verifier parses the retained provider event.
Estimated Standard API-equivalent cost uses evidence label
`verifier_recomputed`. An unavailable measurement keeps a null evidence label;
the UI must not replace it with zero.

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

Signed result packages retain measured latency and any available
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

Scientific reporting exposes the observation count, fixed-fixture
task-sensitivity interval, coverage, missing cells, runtime state, scoring
method, and provenance needed to interpret a score. Score and efficiency charts,
tooltips, and accessible data tables retain this context; when an aggregate
missing-state value is unavailable, the UI says so rather than inventing it.
These fields must remain explicit when evidence is partial. Efficiency plots
include only coverage-qualified measures. Their descriptive Pareto rings compare
nondominated points only within matching matrix batch, scoring version,
concurrency, and evidence-method bindings, plus matching pricing bindings for
cost; they never create a combined rank. Estimated Standard API-equivalent cost
is a comparison method, not an actual ChatGPT or Codex subscription bill.

## Outcomes and scoring

AIQ Core `1.0.5` uses the public task-score description before any `1.0.5`
model evidence is accepted. Each controlled evaluator contains at most 16
binary checks. Its content-addressed configuration binds every check identifier,
nonnegative integer weight, type, and hard-gate status. The task score is:

```text
hard gate or structural failure ? 0 : sum(weight × passed) / sum(weight)
```

The denominator must contain a positive check weight. Only a hard gate can have
zero weight. A positive-weight hard gate also contributes to the fraction when
all gates pass. A score of `1` is `correct`, a score strictly between `0` and `1`
is `partial`, and `0` is `incorrect`. The evaluator does not round before exact
runner and verifier replay. The public pass conditions summarize what the
private checks cover. They are not separately weighted score components.

Correct and partial outcomes contribute their evaluator score. Attributable
incorrect, timeout, budget, tool, policy, and wrong-artifact outcomes contribute
zero. Infrastructure-invalid and missing outcomes block an Official score.
Unsupported configurations use `not_applicable` and remain visible.

The overview's outcome card derives its presentation from immutable task scores
in `apps/web/src/data/format.ts`. A score of at least `1` is correct, a score
strictly between `0` and `1` is partial, and a scored zero is evaluator-incorrect
unless its public explanation code is `timeout`, `budget_exceeded`,
`unsupported_model`, `output_truncated`, or `missing_response`; those five codes
are grouped as execution failures. Null scores and `invalid`, `missing`, or
`not_applicable` statuses are unscored. “Completed tasks earning any credit”
counts correct plus partial cells; it is a descriptive task-cell rate, neither a
score-weighted percentage nor the domain-weighted AIQ index. The outcome and
domain views in the [public application](architecture-and-runtime.md#public-application)
keep runtime, invalid, missing, and not-applicable states separate.

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

`aiq-verifier diagnose-rescore` is a separate offline audit path. It first
validates the signed source package and completes the source evaluator replay.
It then replays the same retained cells against a candidate source, controlled
tasks, evaluators, runtime, and toolchain. Its create-new report is permanently
non-Official and non-ranking. It does not create a stage or attestation and has
no publication path.

The runner and verifier identities must differ. A third publisher identity
completes either publication transition. The separate calibration register
surfaces this evidence without mixing it into the Official leaderboard, compare,
or trends data described by [Architecture and Runtime](architecture-and-runtime.md).

## Synthetic data

Synthetic tasks, runs, scores, nodes, and browser fixtures exercise the same
public paths. They remain explicitly synthetic and unverified. Even complete
synthetic fixtures are not Official. They do not measure a real model or
disclose the private corpus.
