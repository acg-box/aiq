---
type: 'Method'
title: 'Benchmark Method'
description: 'AIQ Core fixture, scoring, execution, and verification method.'
tags: ['benchmark', 'method', 'scoring']
---

# Benchmark Method

## Fixture

Repository source targets the public AIQ Core `1.0.6` candidate, benchmark
release `aiq-core@1.0.6`, and scoring implementation `1.0.6`. It contains 72 fixed
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
sha256:add2a0514b6cdab99b3329d7065565f5606d13af93338e4bc37a0fbd30019b91
```

The release-policy identity is `aiq-core/1.0.6`. Its public catalog
release-identity digest is
`sha256:5b33cd2daa5efe15e49de34b7137d35bc2ff980a7f619063e7e8b819a857508f`.
The public catalog is deterministic and identity-frozen. The reviewed evaluator identity is
`sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`,
the current no-deadline public-safe database task-set identity is
`sha256:768a9322f22c5be4d0fcd67dbe4360bd78392c7d0ef47ee9c0b8cedea2374dda`,
and its task-commitment manifest identity is
`sha256:5515d602865ac1c30207957b0b6f36a9420ea7256809ce2c048ee881a74b78d6`.
Independent no-deadline Core and Contrast A/B seals and both model-free
validators produced these bindings. Re-seal from the final clean identity
commit before the focused canary. Final controlled corpus identities are
calibration candidates, not accepted release identities. Each final
corpus keeps
`runner.identity_kind` as `source_only` and `runner.built_binary_sha256` as
null. The shared Rust validator now fails closed on this runner subtree. The
checked Core schema enforces the same rule. Contrast has equivalent shared typed
enforcement even though it has no separate checked-in JSON schema. Each corpus
binds every private task to its catalog and also binds the baseline workspace,
fixture bundle, evaluator, runtime, runner source, harness, tool policy, network
policy, environment, Node.js identity, and ripgrep identity.
The source-only corpus rule and signed per-run runner and complete Codex runtime
provenance are the executable product contracts. The Codex runtime contains
exactly `codex` and its `codex-code-mode-host` sibling, with separate digests.
After the final clean build, the operator retains a private, unsigned audit
receipt with the exact source commit and tree identity and SHA-256 values for
the native runner, verifier, Codex executable, and Codex code-mode host. The
offline native verifier validates the receipt against an independently supplied
digest. It does not publish the receipt. Node.js and ripgrep identities remain
bound by the corpus commitment.

## Published Official evidence

Production can publish only one AIQ Core `1.0.6`, scoring `1.0.6`, measurement
`2.0.0`, non-synthetic Official `72 × 17` matrix, or 1,224 results. The release gate checks all
72 Core task definitions and their policy-valid acceptance suites. Every Core
task requires `gold`, `alternate_correct`, `partial`, and `adversarial_format`;
`empty` and `timeout` are permitted only as reviewed optional classes, and no
other class is allowed. The separate six-task Contrast calibration requires
exactly `challenge`, `empty`, `format`, `near_miss`, `reference`, and `tamper`
for each task, with no optional classes. The authoring input and harness
manifests record the required classes, optional classes, and observed classes
per task. Both validators also bind toolchain identities, source inputs, and
deterministic evaluator outputs on the native macOS host. Contrast evidence does
not add rows to the Official matrix. Use the top-level model-free validators for
these two controlled corpora:

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
timeouts are observed runtime failures, never semantic zeros. In score
coverage, `invalid_tasks` counts an observed result record that failed at
runtime or infrastructure validation; `missing_tasks` is reserved for an
expected cell with no result record. Neither state contributes to a semantic
aggregate.

The accepted `1.0.5` task redesign replaced the saturated single-dimension
repairs with interacting daily-work contracts. `coding-06` combines a bounded keyed
executor with priority, dynamic concurrency, AbortSignal, close, cancellation,
and idle epochs. `debugging-01` combines quoted records, constrained escapes,
independent UTF-16 limits, and indexed syntax errors. `debugging-02` resolves a
six-field layered service configuration with normalization, typed bounds,
built-ins, an atomic disable sentinel, and exact provenance. `debugging-04`
combines line-ending normalization, head and tail windows, grapheme-safe line
budgets, complete ellipses, and omission metadata. A later `1.0.5` pilot exposed
seven timeouts and three tool-budget failures at the common 900-second,
40-step, and 28-tool-call envelope. The offline historical diagnostic excludes
those runtime-null cells from semantic scoring without changing the preserved
package or producing Official evidence. The r11 five-task pilot then stopped on
debugging-02 at 47/48 steps and 41/40 tool calls after 1,060.042 seconds. A
later 17-by-5 pilot completed 83 semantic cells and recorded two Sol ultra
wall-time failures. AIQ Core `1.0.6` preserves task, fixture, evaluator, tool,
and scoring semantics and removes the model wall deadline from all 72 tasks.
Coding-07 retains 32 steps and 21 tool calls; debugging-02 retains 64 steps and
56 tool calls; coding-06, debugging-01, and debugging-04 retain 48 steps and 40
tool calls. The other 67 tasks retain their accepted step and tool-call limits.
Old deadline evidence cannot be relabeled or mixed with the new corpus. Run the
two previously timed-out Sol ultra cells as a focused no-deadline canary before
the full 17-by-72 non-Official calibration. The full calibration must meet the release
limits for universal semantic zeros and universal full scores, and it must show
sufficient informative tasks, non-uniform tasks, domain spread, and model
spread. The policy permits at most seven universal semantic-zero tasks and at
most seven universal-full tasks. An operator cannot override a failed gate.
Replay alone does not make real calibration Official: signed verifier admission
and the distinct publisher transition must accept it, and calibration remains
permanently non-Official.

The accepted batch must contain 17 configurations with 72 terminal task-level
results each. The native verifier must replay the committed evaluators before
the distinct publisher can publish the matrix as `trusted_verified` through the
[Architecture and Runtime](architecture-and-runtime.md) verification flow.
Public views then expose exactly 17 runs, 1,224 results, and 17 rows each for the
leaderboard, model-efficiency, and model-matrix projections. The method preserves
unsupported or unavailable capability and cost states instead of replacing them
with fabricated output or zero.

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
workspace snapshots, evaluator output, and provenance. Capability evidence is
also part of the signed preflight: an available configuration must execute one
command in a fresh workspace and retain the exact 36-byte
`capability-marker.txt` marker. Failed or unsupported probes cannot carry that
success-only artifact, and the native verifier resolves and checks it before
publication. A durable checkpoint supports interruption recovery without
replacing completed evidence.

Live accounting excludes completed `error` items from the agent step budget;
they remain in raw evidence. Known presentation and reasoning items are not
tools, while unknown completed item types remain conservatively counted as
steps and tool calls. The `codex.exec-json-items.v3` policy recognizes only the
observed inert collaboration status item: `collab_tool_call` with `tool=wait`,
empty `receiver_thread_ids`, empty `agents_states`, a null `prompt`, and a valid
sender. Its `item.started` and `item.completed` records must share both `id` and
sender; the r13 structural audit observed this binding in all 10 paired records.
The completed record adds one step and zero tool calls. Any other
collaboration shape or lifecycle is a policy failure. Live accounting, durable
recomputation, checkpoint resume, and native verifier replay use this same
policy. Raw stdout remains retained for a rejected cell, but a policy-invalid
cell cannot become semantic evidence or an accepted result through its fallback
counters.

## Time, tokens, and API-equivalent cost

Formal model invocations have no wall-clock deadline. The runner waits for
normal completion unless a live step or tool-call budget, an integrity boundary,
or an operator cancellation ends the cell. Deterministic evaluator subprocesses
remain bounded. These execution controls classify evidence; elapsed time,
tokens, tool use, and cost never enter task scores, Rasch ability, quality,
strict pass, ranking, or interval calculations.

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

Scientific reporting keeps each metric on the scale of its matching interval.
Official rows show calibrated ability with the conditional 95% score interval.
Synthetic rows show descriptive quality with task-mix sensitivity and never appear
as Official. Strict pass and its Wilson interval remain separate diagnostics.
Reports also expose observation count, coverage, missing cells, runtime state,
scoring method, and provenance. Score and efficiency charts, tooltips, and
accessible data tables retain this context; when an aggregate missing-state value
is unavailable, the UI says so rather than inventing it. These fields must remain
explicit when evidence is partial. Efficiency plots include only
coverage-qualified measures. Their descriptive Pareto rings compare nondominated
points only within matching matrix batch, scoring version, concurrency, and
evidence-method bindings, plus matching pricing bindings for cost; they never
create a combined rank. Estimated Standard API-equivalent cost is a comparison
method, not an actual ChatGPT or Codex subscription bill.

## Outcomes and scoring

AIQ Core `1.0.6` uses the public task-score description before any `1.0.6`
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

Correct, partial, and semantic incorrect outcomes contribute their evaluator
score, including a semantic incorrect score of zero. Timeout, budget, tool,
policy, and wrong-artifact outcomes have no semantic score and are disclosed as
runtime issues. Observed infrastructure failures are invalid evidence and
missing cells have no result record; both block an Official score but remain
separately countable. Unsupported configurations use `not_applicable` and
remain visible.

The overview's outcome card derives its presentation from immutable task scores
in `apps/web/src/data/format.ts`. A score of `1` is correct, a score strictly
between `0` and `1` is partial, and a semantic scored zero is evaluator-
incorrect. Runtime outcomes carry a null score and are grouped as execution
failures. Null scores and `invalid`, `missing`, or `not_applicable` statuses are
unscored. “Completed tasks earning any credit” counts correct plus partial
cells; it is a descriptive task-cell rate, neither a score-weighted percentage
nor calibrated ability. The outcome and domain views in the [public
application](architecture-and-runtime.md#public-application) keep runtime,
invalid, missing, and not-applicable states separate.

AIQ measurement `2.0.0` separates the ranking estimand from the raw fixture
diagnostics. The raw equal-domain fixed-fixture mean remains a criterion-
referenced `qualityScore`; it is not the ranking score. A complete 17-by-72
calibration matrix jointly estimates model locations (`theta`) and task
difficulties (`beta`) with weak `N(0, 3²)` priors and a centered item scale. The
released Official score is bounded to 0–100 as
`100 × logistic(theta)` for the average calibrated task. It is a calibrated
ability index, not an IQ norm, percentile, or claim of general intelligence.

The model estimate uses the MAP score equation, including the normal-prior
derivative, and the observed information includes prior precision. A failed or
non-converged joint calibration is a structured error: it cannot create a
calibration bank or an Official score. The displayed theta standard error and
the transformed theta/score Wald intervals are conditional on the released
item bank. They do not include item-bank calibration uncertainty. The
`reliabilityStatus` is therefore explicitly
`single_matrix_information_only`, not test-retest reliability.

The raw strict-pass diagnostic is strict successes divided by every attributable
task with a valid semantic task score. Partial scores are non-passes but remain
in the denominator. Runtime-failed, infrastructure-invalid, and unscored tasks
are excluded and reported through coverage and status. The Wilson interval and
`strictPassSampleSize` use this same denominator. The fixed-fixture
task-resampling interval remains a calibrated sensitivity interval for task-mix
sensitivity, not a universal confidence interval for model capability.

An Official result requires non-synthetic evidence for all 72 tasks in one model
configuration, valid evidence for the complete 17-configuration batch, and a
passed calibration release gate. A complete synthetic score uses
`synthetic_complete`: it has no latent Official score, is descriptive only, and
is never ranking eligible. Partial data can be shown as Provisional or
coverage-only but is not ranked as Official.

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
no publication path. For an older runner JSON that encoded failed runtime or
infrastructure cells as `task_score: 0`, the runner's
`historical-diagnostic-rescore` command instead reads the source without
rewriting it, normalizes only those runtime-zero cells in memory, retains raw
and canonical source hashes, and emits a diagnostic with publication, Official,
and ranking eligibility fixed to false.

The runner and verifier identities must differ. A third publisher identity
completes either publication transition. The separate calibration register
surfaces this evidence without mixing it into the Official leaderboard, compare,
or trends data described by [Architecture and Runtime](architecture-and-runtime.md).

## Scorer-owned browser fixture

The runner's `generate-test-public-fixture` command writes
`benchmarks/fixtures/aiq-2.0-test-generated-public.json` through the normal Rust
scoring path. It is a browser-contract projection, not a result package or a
database publication format. The fixture is explicitly `test_generated` and
synthetic, and its outer contract fixes `production_publishable`,
`official_eligible`, and `ranking_eligible` to false. It contains a complete
72-task by 17-configuration public shape so browser tests can exercise
leaderboard, trend, and task-cell contracts without treating test observations
as evidence. The checked-in
`benchmarks/schema/test-generated-public-fixture-v1.schema.json` validates this
boundary; regenerate it only with the runner command, not by hand.

This fixture is separate from [Architecture and Runtime](architecture-and-runtime.md)'s
real submission, verification, and publication flow. It is also distinct from
the historical runtime-zero diagnostic above: that diagnostic preserves source
hashes while normalizing legacy runtime encoding, whereas this fixture creates
fresh deterministic test observations. Neither path can produce Official or
ranking evidence.

## Synthetic data

Synthetic tasks, runs, scores, nodes, and browser fixtures exercise the same
public paths. They remain explicitly synthetic and unverified. Even complete
synthetic fixtures are not Official. They do not measure a real model or
disclose the private corpus.
