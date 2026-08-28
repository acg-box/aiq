# AIQ runner

`aiq-runner` validates the controlled benchmark inputs, probes the local Codex
subscription, executes tasks, scores runs, and creates signed v4 packages.

The runner does not contain private tasks or production credentials. Operators
provide those inputs at invocation time.

## Commands

Print the fixed 17-configuration matrix:

```sh
cargo run -p aiq-runner -- matrix
```

Validate the checked-in public examples without invoking Codex:

```sh
cargo run -p aiq-runner -- validate \
  --public-tasks benchmarks/examples/tasks
```

Validate the complete controlled AIQ Core corpus and the separate six-unit
contrast corpus without invoking Codex:

```sh
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
cargo run -p aiq-runner -- seal-corpus --help
```

The first command requires the 72 controlled tasks and their commitment. The
second also requires the exact expected contrast-corpus commitment digest. Both
commands validate fixtures, evaluators, the committed runtime, and toolchain.

`seal-corpus` is the repository-owned create-new authoring boundary. The Core
path targets only the side-by-side AIQ Core 1.1.0 candidate. It requires
`--leakage-reviews-root`, an exact `aiq.leakage-review.v2` record for every
task, and a `qualification_ready` catalog with no pending fixture
applicability. The observed acceptance class set for each task must equal its
catalog declaration exactly. The current checked-in 1.1.0 catalog is a draft,
so Core sealing stops before it reads private task inputs. The Contrast path
retains bounded 1.0.7 compatibility and copies supplied v1 review records; no
path synthesizes review completion from task notes.

The command does not modify or rebind a predecessor commitment. It writes one
new private directory only after its selected validator and every baseline
check pass. The output includes normalized inputs, canonical preimages,
commitment, harness, copied leakage reviews, and the private receipt needed for
independent regeneration. The sealed evaluator runtime is the one Node
executable under `toolchain`; the output does not contain a duplicate runtime
copy. The command does not invoke Codex or generate task content. Recorded
review-process separation is evidence, not cryptographic proof of human
independence.

Create a deterministic qualification or rejection artifact from three
predeclared complete matrices without invoking a model:

```sh
cargo run -p aiq-runner -- qualify-candidate --help
```

Qualification keeps every 1,224-cell child separate. It never pools, splices,
publishes, or relabels a child run. A rejected candidate requires a new
candidate identity before any revised task or evaluator is run.

Create deterministic synthetic output without invoking Codex:

```sh
cargo run -p aiq-runner -- demo
```

Show the exact arguments for live commands:

```sh
cargo run -p aiq-runner -- preflight --help
cargo run -p aiq-runner -- admit-permissions --help
cargo run -p aiq-runner -- run --help
cargo run -p aiq-runner -- score --help
cargo run -p aiq-runner -- historical-diagnostic-rescore --help
cargo run -p aiq-runner -- package --help
cargo run -p aiq-runner -- submit --help
cargo run -p aiq-runner -- observe-speed --help
cargo run -p aiq-runner -- submit-speed --help
cargo run -p aiq-runner -- normalize --help
```

## Controlled inputs

A live preflight requires:

- the capability manifest;
- the current `aiq.corpus-commitment.v2` document;
- an absolute committed Node.js runtime;
- the controlled Node.js and ripgrep toolchain root;
- the exact Codex runtime directory and Codex home;
- a durable output path.

The only first-release Official runtime runs directly on the operator's Apple
Silicon Mac with the Mac's direct network connection.

A live run also requires controlled task, workspace, evaluator, schedule,
execution, artifact, preflight-cache, and checkpoint paths. The CLI checks path
separation and commitments before it starts task processes.

Run `admit-permissions` before any paid Official preflight. It validates the
exact 72-by-17 controlled inputs, selected schedule occurrence, conservative
all-17-model capacity, worker count, and the create-new run, score, and package
output plan. It then verifies the explicit `aiq_benchmark` profile selected by
strict CLI configuration and all Codex sandbox canaries. External managed
requirements are not required and must be absent. The command writes one
private create-once `aiq.official-permission-admission.v2` receipt without
invoking a model or creating a checkpoint. Pass that receipt as
`--official-admission` to
`preflight`, `run`, `score`, and `package`. Only the exact configuration probes
in `preflight` and runnable task cells in `run` invoke models. `score` and
`package` are model-free. A refreshed preflight is bound to the same receipt and
cannot be reused for another Official plan.

The credential source must stay unchanged during controlled work. Use a
separate private Codex home on the Mac and make its copied `auth.json` owner
immutable with `uchg`. Do not change the active Codex profile to meet this
requirement. First-release Official execution uses this native Mac runtime.

The corpus binds all 72 private tasks to the public catalog. The public catalog
digest is:

```text
sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1
```

This is the active public `1.0.7` metadata identity. Its public release digest
is `sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae`.
The public catalog is deterministic and identity-frozen. The unbounded formal-task
identity requires fresh independent Core and Contrast seals. The database task
commitment must then be regenerated before database cutover. Final clean-commit
regeneration, policy-v2 replay and admission, and release acceptance
remain pending.

## Execution and evidence

The runner fixes the run class before execution. An Official run requires the
complete 17-by-72 shape. A calibration can select a deterministic subset and is
never Official.

The retained complete `1.0.7` calibration is replayed without model calls before
the real Official publication path. Every formal model task has
`wall_seconds: null`, `max_steps: null`, and `max_tool_calls: null`. The adapter
waits for normal completion and records model and evaluator elapsed time, steps, tool calls, tokens,
and estimated cost as auxiliary evidence. These measurements never affect
semantic scoring. Formal external evaluators use `aiq.evaluator-config.v2` with
`completion_policy: natural_completion`; aggregate and per-check deadlines are
not part of the task binding. The replayed non-Official calibration must pass the release
policy without an operator override. Earlier bounded runs remain unpublished
failed release evidence.

The runtime directory must contain exactly the native `codex` executable and
its `codex-code-mode-host` sibling. Capability preflight records the exact local
model support state only after each available configuration completes one
command and writes the expected content-bound marker in a fresh workspace. The run binds
the corpus, catalog, task set, evaluator, runtime, harness, prompt, tool policy,
network policy, environment, source manifest, executables, and permission
evidence in `aiq.run-provenance.v3`, including separate digests for the Codex
executable and code-mode host.

Each adapter-invoked result records separate runner-observed model and evaluator
elapsed time as `latency.wall_ms` and `latency.evaluator_ms`. The runner commits
only one semantic evaluator result for the sealed response and workspace. A
retryable evaluator process failure keeps the evidence pending and reruns only
the evaluator on resume. The runner records the parsed result and exact
raw-output digest, and leaves the independent replay to the verifier. When Codex
reports token counters, the verifier parses the retained evidence again and
records the provider-reported input, cache, output, and reasoning counters. The
versioned cost field is a Standard short-context API-equivalent estimate. It is
not the actual cost of a ChatGPT or Codex subscription. Time, tokens, tool use,
and estimated cost never enter AIQ, Rasch ability, quality, strict-pass,
ranking, or interval calculations.

`observe-speed` is a separate non-scoring path for paired Normal/Fast
subscription measurements. It probes the live model catalog first and invokes
only modes that the current catalog advertises for the exact model and reasoning
configuration. Trials alternate Normal-first and Fast-first ordering, use no
benchmark time, step, or tool-call limit, and write create-once resumable
checkpoints. The fixed response checks completion fidelity and provides enough
output for aggregate throughput measurement. TTFT and post-first-token
throughput stay null until the Codex event stream provides a trustworthy
first-token timestamp. `submit-speed` sends the validated batch to the narrow
`/api/observations/speed` gateway; the batch is auxiliary evidence and cannot
enter any scoring, eligibility, or ranking path.

Task workspaces are fresh copies. The runner stores content-addressed workspace
and evaluator artifacts under the controlled artifact root. It writes a durable
checkpoint so an interrupted run can continue without replacing completed
evidence. Checkpoint v10 moves completed model evidence from an in-flight marker
to a sealed pending-evaluator record before evaluator execution starts. If the
runner is terminated or the evaluator process fails, it can restart that
incomplete evaluator phase from the same response and workspace without another
model invocation. An Official run holds its create-new output with an exact
run-bound reservation. The same run can reopen that unchanged reservation after an
interruption. Another run, modified reservation, symbolic link, or hard-link
alias fails closed. Every parent of a future protected file must be owned by
the current user and must not be writable by group or other. The runner holds
a nonblocking kernel advisory lock on each parent before it reads or writes
preflight state or invokes a paid capability probe. It holds the locks through
execution and finalization. All writers in this trusted boundary must use the
runner lock. Do not give an untrusted process the same user identity or write
access to these directories. Protected writes use macOS atomic rename
primitives and fail closed when those primitives are unavailable.

Before it commits a terminal cell, the live runner retries a retryable Codex
non-zero exit or missing final response in a fresh copy of the task workspace.
The content-addressed stdout keeps a versioned record of every invocation. Wall
time, steps, tool calls, and provider token counters accumulate across the
invocations. They remain auxiliary measurements. A semantic outcome, including
an incorrect answer, is final and is never retried. Checkpoint resume does not
retry a committed or indeterminate model cell. A retryable evaluator process
failure stays pending and does not produce terminal evidence. Resume reruns only
the evaluator against the unchanged response and workspace. A semantic result
is final; the runner never retries it to obtain a match. A provider-declared subscription
limit is not a terminal task result: the checkpoint preserves completed cells,
marks the rejected cell as pending capacity backpressure, and resumes it after
capacity returns. Legacy v8 terminal subscription-limit entries migrate into
that pending state without replacing already completed work. Checkpoint v9
migrates to v10 with an empty pending-evaluator list.

## Scoring, packaging, and submission

`score` applies the checked-in AIQ 2.0 Rasch scoring rules to a saved run. The
score and calibration bundle wrappers use their v2 schema identifiers.
`package`
binds the run and its artifacts into one signed `aiq.result-package.v4` envelope.
The runner key must match the run's preflight node identity.

For an immutable historical pilot whose legacy runner JSON encoded a runtime
failure as `task_score: 0`, use the explicitly non-publication diagnostic path:

```sh
cargo run -p aiq-runner -- historical-diagnostic-rescore \
  --hidden-tasks /absolute/controlled/tasks \
  --results /absolute/controlled/pilot-run.json \
  --output /absolute/new/pilot-diagnostic.json
```

This command reads the source once, retains its raw and canonical hashes, and
normalizes only failed runtime or infrastructure results with
`evaluation: not_evaluated` and `task_score: 0` to an unscored result in memory.
It then applies the formal scorer and writes
`aiq.historical-diagnostic-rescore.v1`. The output has publication, Official,
and ranking flags fixed to false, contains no raw result content, and is not
accepted by `score`, `package`, `normalize`, or production publication paths.
The source file is never rewritten.

File outputs are create-new protected outputs. Existing regular files,
hard-link aliases, and symbolic links are rejected without changing their
bytes when the required single-writer directory boundary is intact. The runner
`normalize` audit path can record commitments-only or failed
verification, but it cannot claim `evaluator_replayed`; only `aiq-verifier` can
produce that production disposition after actual replay.

`submit` uploads the required private artifacts, stores the exact package bytes,
and calls `/api/submissions`. A successful queue response means unverified
receipt only. Verification and publication happen through separate identities.

## Subscription smokes

These tasks are ignored and opt in:

```sh
cargo make smoke-subscription
cargo make smoke-controlled-subscription
```

Each task consumes one subscription attempt. The first uses a fixed public
example. The second uses operator-supplied controlled inputs. Their summaries
are diagnostic evidence only. For the controlled smoke,
`AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EXECUTION_ROOT` must name a new private
absolute path outside the repository, Codex home, controlled inputs, artifact
root, and model toolchain. `AIQ_REAL_PERMISSION_PROBE_BINARY` must name the
exact `aiq-runner` executable. Direct network access is the only supported
first-release path.

## Safety

- Keep `AIQ_RUNNER_SIGNING_KEY` and Codex authentication outside Git.
- Do not share the runner key with the verifier or publisher.
- Use absolute controlled paths for production inputs.
- Do not treat synthetic output, dry checks, or a queue receipt as a published
  benchmark result.
