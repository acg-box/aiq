# Harness Rank: proposed V1 protocol

Status: **design only**, protocol 0.3.0. V1 contains **Codex, Hermes, and Pi**.
The 24 task specifications and their 72 acceptance gates are authored. Workspace
fixtures, reference solutions, and graders are **not built or validated**.
Difficulty labels are estimates. No compatibility probe, harness evaluation,
model request, or paid job has run for this study.

[`protocol.json`](protocol.json) owns all task prompts, deliverables, gate IDs,
difficulty rationales, comparison rules, and budget parameters. The Web board at
`/benchmarks/harness?view=method` shows a filterable task table and specification
details. The JSON download contains the same specifications. Core's matrix,
Rasch, Calibration, and Official gates do not apply to this study.

## Scope and research basis

The first question is: **with the same model and resource ceilings, which
harness completes these coding and local-workflow tasks?** Keep native prompts,
tools, and context management as the treatment. Equal ceilings do not imply
equal compute or identical prompts. The result applies to the declared model,
profiles, task set, and execution window. It does not establish a universal
harness winner.

The task design borrows three principles from primary sources:

- [Harness-Bench, version 2](https://arxiv.org/html/2605.27922v2): reconstruct
  realistic work requirements in fixed local environments, compare native
  harnesses on matched inputs, and check delivered artifacts.
- [Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/):
  check that prompts and tests agree; reject hidden requirements, arbitrary
  implementation restrictions, and incomplete acceptance coverage.
- [Terminal-Bench task design](https://arxiv.org/html/2601.11868v1): isolate task
  environments, supply reference solutions, and verify behavior independently.
  Author difficulty labels do not establish measured agent difficulty.

This study imports no task or result from those sources. **24 tasks and the
6/12/6 difficulty mix are local design choices**, not empirically optimal counts.
Discriminating power is not measured. A later development phase may inform the
next frozen design; formal results must not be used to select tasks that favor
one target harness or exaggerate a difference.

## Task set: 24 specifications

Four families have six tasks each, with two tasks per family and language stack.
Go, Python, and TypeScript each have eight tasks. Twelve project workspaces have
two different tasks each; every attempt gets its own clean starting snapshot.
The workspace names are fixture specifications, not existing public repositories.
Reuse three runtime images instead of designing 24 different environments.

| Family                 | Tasks | Acceptance                                                                        |
| ---------------------- | ----: | --------------------------------------------------------------------------------- |
| Bug repair             |     6 | Fix the stated defect, cover boundary behavior, preserve regressions.             |
| Feature work           |     6 | Implement the stated interface, errors, and compatibility.                        |
| Local workflow         |     6 | Deliver correct files or database state, with safe repeat or recovery behavior.   |
| Refactor and migration |     6 | Change the specified boundary, update consumers, preserve required compatibility. |

| Estimated level | Tasks | Intended demand                                                            |
| --------------- | ----: | -------------------------------------------------------------------------- |
| Basic           |     6 | One local behavior or interface; usually one or two relevant modules.      |
| Medium          |    12 | Two to four modules or interacting rules; boundary and consistency checks. |
| Hard            |     6 | Three to six modules with state, recovery, or migration invariants.        |

All levels get the same 20-minute and USD 2 reference-cost attempt ceilings.
These labels describe intended coordination demand. They are not measured pass
rates, promised run times, or human-completion estimates. Scope stays bounded;
no obscure puzzle knowledge, live web facts, GPU, browser, or external account is
required.

| Specification ID     | Task                             | Family                 | Stack      | Estimated level |
| -------------------- | -------------------------------- | ---------------------- | ---------- | --------------- |
| archive-exclusion    | Archive exclusion rules          | Feature work           | Go         | Basic           |
| archive-containment  | Archive extraction containment   | Bug repair             | Go         | Medium          |
| cache-adapter        | Cache adapter separation         | Refactor and migration | TypeScript | Basic           |
| cache-expiry         | Cache expiration boundary        | Bug repair             | TypeScript | Basic           |
| catalog-cursor       | Catalog cursor stability         | Bug repair             | TypeScript | Medium          |
| catalog-filter       | Catalog filter parity            | Feature work           | TypeScript | Medium          |
| config-precedence    | Configuration precedence         | Bug repair             | Go         | Basic           |
| config-schema        | Configuration schema upgrade     | Refactor and migration | Go         | Medium          |
| import-transaction   | Dataset import transaction       | Local workflow         | Python     | Medium          |
| import-validation    | Dataset import validation        | Feature work           | Python     | Basic           |
| export-fields        | Export field selection           | Feature work           | TypeScript | Medium          |
| export-resume        | Export resume and deduplication  | Local workflow         | TypeScript | Hard            |
| jobs-incremental     | Incremental job execution        | Feature work           | Go         | Hard            |
| jobs-recovery        | Job recovery ledger              | Local workflow         | Go         | Medium          |
| ledger-reconcile     | Ledger reconciliation            | Local workflow         | Python     | Basic           |
| ledger-refunds       | Ledger refund accounting         | Bug repair             | Python     | Medium          |
| logs-normalize       | Log event normalization          | Refactor and migration | Go         | Hard            |
| logs-rotation        | Log rotation aggregation         | Local workflow         | Go         | Medium          |
| manifest-containment | Manifest path containment        | Bug repair             | Python     | Hard            |
| manifest-format      | Manifest serialization migration | Refactor and migration | Python     | Medium          |
| report-dates         | Report date filtering            | Feature work           | Python     | Medium          |
| report-pipeline      | Report pipeline extraction       | Refactor and migration | Python     | Hard            |
| settings-merge       | Settings merge provenance        | Local workflow         | TypeScript | Hard            |
| settings-schema      | Settings schema migration        | Refactor and migration | TypeScript | Medium          |

The JSON has each complete task prompt, output contract, exactly three named
binary acceptance gates, and a difficulty rationale. The Web details show these
fields with the gate IDs and the common completion rule. Data lists the required
evidence files; these are requirements, not collected results or downloads.
Examples of the intended separation are:

- **Cache expiration boundary:** explicit clock and TTL rules in a local module.
- **Catalog cursor stability:** tuple ordering must agree across pages and two
  consumers; equal timestamps must not lose or duplicate records.
- **Export resume and deduplication:** durable output and checkpoint state must
  survive a controlled interruption while preserving conflict evidence.

## Acceptance and package construction

Each task has three binary requirement gates. A gate passes only if all its
frozen assertions pass. Primary success requires all three gates, normal harness
completion, and all common limits. A passing patch after an abnormal stop remains
a separate diagnostic. A completion claim is not acceptance.

Publish passed gates / 3 as a separate requirement-coverage diagnostic. Average
gates equally per task and tasks equally; a task with more assertions has no
extra weight. Do not blend partial credit, cost, time, and success into a score.
No LLM judge or subjective answer rubric enters this cohort.

Each future task package must contain:

1. Task prompt and input contract, clean workspace snapshot, and visible examples.
2. Three independent requirement gates plus the shared preservation/regression
   contract. Hidden cases vary inputs within public requirements only.
3. Reference patch or reproducible procedure, kept outside agent access.
4. Manifest with task/workspace identity, stack, estimated difficulty, license
   and provenance, snapshot/image/dependency digests, and all input/grader hashes.

Before a package can enter a run, an independent reviewer must align every
scored behavior with the prompt, accept the reference, reject the unmodified
baseline and a plausible incomplete implementation, and repeat the deterministic
grader five times. These checks have not run. Grade behavior rather than a
preferred implementation, except where a stated boundary is the task itself.

Use fixed clocks, deterministic ordering, integer minor currency units, and local
services where specified. Preinstall dependencies. Keep hidden checks and
reference material outside agent access, and remove future repository history.
If public code is used, record its license, immutable commit, and overlap with
public tasks. New authorship does not prove absence of training exposure.

Six separate development tasks remain outside the 24-task score and must use
other workspace families. They can check integration and the difficulty design
after a later execution decision. Freeze formal prompts, fixtures, graders,
profiles, order, and analysis before any main result. Do not remove a formal
task because a harness fails it or all harnesses tie.

## Same-model configuration and environment

The proposed candidate remains `gpt-6-sol`, `reasoning.effort=medium`, through
one direct OpenAI Responses HTTP/SSE route, one API project, and Standard tier.
This is not verified access or compatibility. The reviewed
[model page](https://developers.openai.com/api/docs/models/gpt-6-sol) lists no
dated snapshot. Do not invent one or silently substitute another model.

| Harness | Proposed binding                                                                                     | Qualification concern                                                   |
| ------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Codex   | Isolated profile; exact model; named provider; `wire_api=responses`; `model_reasoning_effort=medium` | Effective limits, instruction loading, model catalog, optional services |
| Hermes  | Explicit main model/base URL; `api_mode=codex_responses`; `agent.reasoning_effort`                   | Auxiliary/compression slots, fallback chains, effort remapping          |
| Pi      | Exact model and base URL; `api=openai-responses`; declared model metadata                            | Effective limits, reasoning mapping, packages, compaction route         |

These are proposed bindings based on official configuration documentation, not
ready-to-run profiles. Pin release/source/binary digests and verify the resolved
configuration. The controlled common-capability profile can differ from product
defaults; conclusions apply to that profile.

The recording route must preserve streaming, tool-call IDs, continuation,
opaque items, errors, usage, and completion. See the
[Codex gateway reference](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility).
A model listing or text response does not qualify a complete tool loop. The
recording route and pre-dispatch budget meter are not implemented here.

Every main and required compression request must use the same model, route,
effort, and budget. Omit temperature and top_p. Record requested and returned
model/tier metadata. Disable optional title generation, background review,
delegation, persistent learning, skill search, browser/MCP, hosted tools, and
fallbacks. Required in-session context management stays native.

Each attempt gets a clean workspace, HOME/profile, session, and temporary
directory. Use one reserved Linux x86_64 worker with 4 vCPU, 8 GiB RAM, and
10 GiB writable disk. Freeze runtime/dependency/image digests, locale, and
clock policy. Run one evaluated attempt at a time. Capabilities are local
read/search/edit/shell; the only agent egress is the inference route. Grade the
frozen final state outside the agent timer after all child processes stop.

Prefer a provider-pinned model revision. If none exists, label results as a
time-bounded matched-route cohort and record that limitation. Keep one cohort
within seven days. Stop on known model/routing/configuration drift instead of
pooling different identities. Model × harness remains deferred with no budget.

## Repeats, failures, and analysis

All execution steps are future work:

1. Pin releases/profiles and qualify each harness on four disposable fixtures:
   cancellation/failure, continuation/compression, identity/parameters, and a
   complete tool loop. Each check has a five-minute and USD 1 ceiling. All
   three harnesses must pass the same contract.
2. Use six separate development tasks once per harness, then freeze the formal
   packages, profiles, graders, schedule, and analysis.
3. Collect **24 tasks × 3 harnesses × 3 repeats = 216 planned attempts**.
   This is 72 attempts per harness and 72 matched triplets. In each stack-by-
   family cell, use all six harness-order permutations once: 12 occurrences
   per permutation overall. Spread repeats through the seeded schedule.
4. Grade, reconcile accounting and evidence, and publish actual coverage.

Use every repeat, never best-of-three. Repeats are not independent new tasks.
For each harness, average three repeats per task, two tasks per workspace, then
12 workspaces equally. Complete balanced coverage equals accepted / 72 attempts.
Report four family scores and the diagnostic requirement coverage separately.

Wrong work, malformed tool calls, unsupported requests caused by the harness,
crashes, and exhausted limits are unsuccessful valid attempts. Only independently
evidenced provider/worker outages or reference-grader failures are infrastructure-
invalid. An identity violation stops the cohort; it is not a semantic zero.

If an attempt is infrastructure-invalid, retain and exclude the whole matched
triplet, then rerun all three from fresh state. At most one replacement per
original block and five replacement blocks total are proposed. A second failure
of a block or a sixth required replacement stops the cohort. Incomplete coverage
has no primary rank. Retain original/replacement links and all spend. No silent
grader changes or selective reruns are allowed.

Use 10,000 paired bootstrap draws over workspace-family IDs, stratified by stack
(four workspaces per stack). Keep both tasks, repeats, and harnesses together in
each sampled workspace. Use seed 20261020 for scheduling and bootstrap. Publish
marginal 95% score intervals and all three paired differences at exact confidence
1 - 0.05/3 (display 98.333%). If a statistic has no bootstrap variation, mark its
interval unavailable rather than certain.

Point-estimate rank is descriptive; equal scores share rank and display names
alphabetically. A practical advantage requires the adjusted paired lower bound
to exceed the predeclared five-percentage-point margin. Twelve authored project
families support screening evidence. They do not establish population coverage
or a winner across all real repositories, models, or harness defaults.

## Resource and cash proposal

These are ceilings, not forecasts or spending authority. Every attempt shares:

- 20 minutes launch to termination; independent grading has 5 minutes.
- 128,000 input and 16,000 output tokens per request.
- USD 2 reference inference cost across all main, compression, and retry calls.
- At most two transport retries per logical call within the same clock/budget.

The rate reference remains dated 2026-10-20. Conservatively price all input at
USD 2.50/M and output at USD 10/M for the common budget, including cached input.
Count reasoning output once. Record actual cache use and billed cost separately.
Revalidate rates, taxes, tier, and billing before any paid work.

| Allocation                  |                           Units × cap | Inference ceiling |
| --------------------------- | ------------------------------------: | ----------------: |
| Compatibility qualification |                     12 checks × USD 1 |            USD 12 |
| Development tasks           |                   18 attempts × USD 2 |            USD 36 |
| Infrastructure replacement  |   15 attempts / five triplets × USD 2 |            USD 30 |
| Main cohort                 |                  216 attempts × USD 2 |           USD 432 |
| Reconciliation reserve      | Accounting only; no additional trials |            USD 24 |
| Total API envelope          |                                       |       **USD 534** |

Add at most USD 50 compute: **USD 584 cash before tax**. Local reserved compute
adds no cloud charge. Record authoring, fixture/grader review, and engineering
labor separately. The 16-hour labor cap covers result/evidence review only.
The old 36-task / 324-attempt / USD 800 draft is superseded.

249 capped main/development/replacement attempts imply at most 83 agent-worker
hours plus 20.75 grader hours; qualification adds at most one hour. These are
planning maxima, not measured durations.

Before dispatch, reserve a validated upper bound on input and maximum output,
including continuation, compression, and retries. Reconcile recorded usage
before releasing a reservation. Missing usage is not zero. If a safe bound or
final accounting cannot be established, retain the reservation and pause. The
USD 24 reserve covers accounting uncertainty only. Budget/profile controls must
be implemented and qualified before any provider call.

## Evidence and publication

The JSON lists the required alphabetical artifact layout: accounting.json,
answer.md, attempt.json, config.json, grade.json, manifest.json, originals/,
repository.diff, task.json, and transport.jsonl. A grade must retain all three
gate outcomes and the grader/environment identity. Preserve failure states too.

Retain native originals, append later corrections, and label derived public
redacted copies. Never overwrite originals. Do not publish authentication data,
private provider receipts/profiles, hidden reasoning, or the ELF private archive.
A hash identifies bytes; it does not prove semantic correctness.

No experiment originals exist. Publish a ranked cohort only after qualification,
complete matched coverage, verified artifact/usage links, and resolved grades.
Failure or incomplete evidence can be published with no winner claim.

## Remaining implementation

The task **specifications** are complete for this draft. Workspace code and input
fixtures, reference solutions, executable graders, immutable package hashes,
release pins, profiles, accounting, images, reviewers, schedule, and empirical
difficulty remain unvalidated. This change adds no runner, execution endpoint,
provider credentials, scheduled job, or automatic benchmark trigger.
