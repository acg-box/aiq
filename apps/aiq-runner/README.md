# AIQ runner

`aiq-runner` validates the controlled benchmark inputs, probes the local Codex
subscription, executes tasks, scores runs, and creates signed v3 packages.

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
```

The first command requires the 72 controlled tasks and their commitment. The
second also requires the exact expected contrast-corpus commitment digest. Both
commands validate fixtures, evaluators, the committed runtime, and toolchain.

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
cargo run -p aiq-runner -- package --help
cargo run -p aiq-runner -- submit --help
cargo run -p aiq-runner -- normalize --help
```

## Controlled inputs

A live preflight requires:

- the capability manifest;
- the current `aiq.corpus-commitment.v2` document;
- an absolute committed Node.js runtime;
- the controlled Node.js and ripgrep toolchain root;
- the exact Codex executable and Codex home;
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
sha256:e5ec5c2fa9d3423b228eb3fc4e717be8e48e34e1a1352608394aa4643850c1a1
```

This is the active public `1.0.5` metadata identity. Its public release digest
is `sha256:4431b4027ce35f5bee9dda55cbcb8e28dcd985708da2918ec94ff7cee76ed529`.
The controlled Core, Contrast, runtime, evaluator, generated-task tree, and
database commitment identities are pending.

## Execution and evidence

The runner fixes the run class before execution. An Official run requires the
complete 17-by-72 shape. A calibration can select a deterministic subset and is
never Official.

For the `1.0.5` release, run one complete 17-by-72 calibration before any real
Official publication path. This non-Official calibration must try to falsify
fixture discrimination and must pass the release policy without an operator
override. The interrupted `1.0.3` Official attempt was rejected as unpublished
calibration evidence after an already-conclusive ceiling failure. No hidden
responses or hidden task details were published.

Capability preflight records the exact local model support state. The run binds
the corpus, catalog, task set, evaluator, runtime, harness, prompt, tool policy,
network policy, environment, source manifest, executables, and permission
evidence in `aiq.run-provenance.v2`.

Each adapter-invoked result can record runner-observed wall time. When Codex
reports token counters, the verifier parses the retained evidence again and
records the provider-reported input, cache, output, and reasoning counters. The
versioned cost field is a Standard short-context API-equivalent estimate. It is
not the actual cost of a ChatGPT or Codex subscription.

Task workspaces are fresh copies. The runner stores content-addressed workspace
and evaluator artifacts under the controlled artifact root. It writes a durable
checkpoint so an interrupted run can continue without replacing completed
evidence. An Official run holds its create-new output with an exact run-bound
reservation. The same run can reopen that unchanged reservation after an
interruption. Another run, modified reservation, symbolic link, or hard-link
alias fails closed. Every parent of a future protected file must be owned by
the current user and must not be writable by group or other. The runner holds
a nonblocking kernel advisory lock on each parent before it reads or writes
preflight state or invokes a paid capability probe. It holds the locks through
execution and finalization. All writers in this trusted boundary must use the
runner lock. Do not give an untrusted process the same user identity or write
access to these directories. Protected writes use macOS atomic rename
primitives and fail closed when those primitives are unavailable.

## Scoring, packaging, and submission

`score` applies the checked-in AIQ v1 scoring rules to a saved run. `package`
binds the run and its artifacts into one signed `aiq.result-package.v3` envelope.
The runner key must match the run's preflight node identity.

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
