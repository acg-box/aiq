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

Create deterministic synthetic output without invoking Codex:

```sh
cargo run -p aiq-runner -- demo
```

Show the exact arguments for live commands:

```sh
cargo run -p aiq-runner -- preflight --help
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
- the operator-selected private HTTP proxy;
- a durable output path.

A live run also requires controlled task, workspace, evaluator, schedule,
execution, artifact, preflight-cache, and checkpoint paths. The CLI checks path
separation and commitments before it starts task processes.

The credential source must stay unchanged during controlled work. On Linux,
put `auth.json` on a read-only file-system mount. For local macOS validation,
use a separate private Codex home and make its copied `auth.json` owner
immutable with `uchg`. Do not change the active Codex profile to meet this
requirement. Other operating systems fail closed.

The corpus binds all 72 private tasks to the public catalog. The public catalog
digest is:

```text
sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3
```

## Execution and evidence

The runner fixes the run class before execution. An Official run requires the
complete 17-by-72 shape. A calibration can select a deterministic subset and is
never Official.

Capability preflight records the exact local model support state. The run binds
the corpus, catalog, task set, evaluator, runtime, harness, prompt, tool policy,
network policy, environment, source manifest, executables, and permission
evidence in `aiq.run-provenance.v2`.

Task workspaces are fresh copies. The runner stores content-addressed workspace
and evaluator artifacts under the controlled artifact root. It writes a durable
checkpoint so an interrupted run can continue without replacing completed
evidence.

## Scoring, packaging, and submission

`score` applies the checked-in AIQ v1 scoring rules to a saved run. `package`
binds the run and its artifacts into one signed `aiq.result-package.v3` envelope.
The runner key must match the run's preflight node identity.

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
root, and model toolchain.

## Safety

- Keep `AIQ_RUNNER_SIGNING_KEY` and Codex authentication outside Git.
- Do not share the runner key with the verifier or publisher.
- Use absolute controlled paths for production inputs.
- Do not treat synthetic output, dry checks, or a queue receipt as a published
  benchmark result.
