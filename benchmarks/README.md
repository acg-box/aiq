# AIQ Core benchmark contract

Repository source targets the public AIQ Core `1.0.7` candidate, task scorer
`1.0.6`, aggregate scorer `1.0.8`, and measurement `2.0.0`. It is a fixed
72-task benchmark across ten domains. The public catalog defines task identity,
domain, difficulty, tool policy, budget, evaluator identity, and public-safe
descriptions. Private task prompts, fixtures, expected outputs, and evaluator
content stay outside Git.

All 72 formal tasks use `wall_seconds: null`, `max_steps: null`, and
`max_tool_calls: null`. Prompt, evaluator, semantic scoring, and tool
permissions remain unchanged. The public
catalog is deterministic and identity-frozen. The new identity requires fresh
independent Core and Contrast seals and a regenerated 72-task database
commitment. One complete real 1.0.7 calibration package is retained unchanged.
Policy-v2 replay and admission v3, final native build verification, a real
Official run, publication, and final deployment are pending. The only
production tuple is AIQ Core `1.0.7`, task scorer `1.0.6`, aggregate scorer
`1.0.8`, and measurement `2.0.0`. Do not reset,
initialize, or publish until a
real non-synthetic signed 17-by-72 package passes native verifier replay. No
earlier publication is a compatibility source or fallback.

Earlier bounded runs remain immutable unpublished release evidence. The
retained complete non-Official 17-by-72 package is the sole calibration source;
the verifier replays all 1,224 cells without model calls and issues a new signed
fixed-bank admission. A separate complete 17-by-72 Official run remains
required. No operator can override the release policy.

Calibration policy v2 keeps the 0.50 informative-task rate as a signed
descriptive target. It does not turn the binary count into a publication cliff.
The hard gates still require complete semantic coverage, no runtime or missing
cells, at least 0.50 non-uniform tasks, bounded universal floor and ceiling
rates, nondegenerate domains, and sufficient model and latent-score spread.

## Public authority

- `candidates/aiq-core-1.0.7/catalog.json` is the active generated public
  catalog for repository source.
- `candidates/aiq-core-1.0.7/catalog.schema.json` validates the active source
  catalog.
- `schema/corpus-commitment-v2.schema.json` validates the controlled AIQ Core
  corpus commitment document.
- `schema/result-package-v4.schema.json` validates signed runner packages.
- `schema/normalized-batch-v4.schema.json` validates the database stage.
- `schema/verifier-attestation-v4.schema.json` validates verifier evidence.
- `schema/test-generated-public-fixture-v1.schema.json` validates the
  browser-only public projection fixture. It is not a submission schema.
- `examples/tasks/` contains synthetic public task examples.

The catalog contains 17 model configurations and 72 ordered tasks. Its identity
digest is:

```text
sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1
```

Its release identity is:

```text
sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae
```

The release-policy identity is `aiq-core/1.0.7`. The reviewed evaluator identity
is `sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`.
The checked-in current no-deadline database task-set identity is
`sha256:777dc72d782a274e654bc8fa61479908c244675b148755fb36bb2c28a89acd72`,
and its task-commitment manifest identity is
`sha256:e3ab152dedd0182750ab59bce83efdf85a2e7b71288f11f57d7530ea96f3e30d`.
They are public pre-seal bindings, not release authority. Fresh independent
Core and Contrast A/B seals and the calibration gate still must pass.

Each task score uses the executable weighted-check contract. A private,
content-addressed evaluator configuration binds each binary check, its
nonnegative integer weight, and its hard-gate status. A failed hard gate or a
structural failure sets the task score to zero. Otherwise, the score is the sum
of passed check weights divided by the sum of all positive check weights. Only
a hard gate can have zero weight. A positive-weight hard gate also contributes
to the fraction when all hard gates pass. The verifier replays the exact checks
without evaluator rounding. Public pass conditions summarize coverage; they are
not mathematical weight partitions.

Formal model and evaluator work has no benchmark-enforced wall-time, step,
tool-call, aggregate-evaluator, or per-check limit. Evaluator configuration uses
`aiq.evaluator-config.v2` and `completion_policy: natural_completion`. The runner
records one parsed evaluator result, its exact raw-output digest, and evaluator
elapsed time. The independent verifier executes one replay and requires an
exact match before publication. Elapsed time, steps, tool calls by type, tokens, and estimated cost are
independent efficiency evidence and never enter task score, Rasch
ability, quality, strict pass, ranking, or intervals.

## AIQ Core 1.0.7 public authority

These files own the active catalog authority:

- `candidates/aiq-core-1.0.7/catalog.json`;
- `candidates/aiq-core-1.0.7/catalog.schema.json`;
- `candidates/aiq-core-1.0.7/task.schema.json`; and
- `schema/corpus-commitment-v2.schema.json`.

The task-metadata identity is:

```text
sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1
```

The release identity is:

```text
sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae
```

The first digest binds the ordered public task metadata. The second binds the
public catalog release. They do not define controlled identities. The current
no-deadline public-safe database task-set identity is
`sha256:777dc72d782a274e654bc8fa61479908c244675b148755fb36bb2c28a89acd72`,
and its task-commitment manifest identity is
`sha256:e3ab152dedd0182750ab59bce83efdf85a2e7b71288f11f57d7530ea96f3e30d`.
They are checked-in pre-seal bindings. Seal and validate Core and Contrast twice
from the final clean identity commit before model execution.
The shared Rust
validator fails closed
unless `runner.identity_kind` is `source_only` and
`runner.built_binary_sha256` is null. The Core JSON schema enforces the same
rule. Contrast has equivalent shared typed enforcement even though it does not
have a separate checked-in JSON schema.
These fields remain source-only in the final corpus documents. Each corpus also
binds the Node.js and ripgrep identities. The source-only corpus rule and signed
per-run runner and Codex executable provenance are the executable product
contracts. After the final clean build, the operator retains a private, unsigned
audit receipt with the exact source commit and tree identity and SHA-256 values
for the native runner, verifier, Node.js, and ripgrep executables. This receipt
is reproducibility evidence, not a product protocol, database input, or
published artifact. The repository does not validate it.
Model-free validation replays each task's gold, alternate-correct, partial,
adversarial-format, empty, and timeout fixtures twice and requires byte-identical
expected results. Near-miss and paired-contrast evidence is validated in the
independent six-task AIQ Core Contrast calibration suite; it is not a per-task
Core fixture commitment. The accepted production publication must be one complete
Official `72 × 17` matrix with 1,224 results under the sole production tuple.

Regenerate and test the active source catalog with:

```sh
node scripts/candidates/aiq-core-1.0.7/generate-benchmark-catalog.ts
node --test --experimental-strip-types \
  scripts/candidates/aiq-core-1.0.7/generate-benchmark-catalog.test.ts
```

## AIQ Core 1.1.0 candidate source

`candidates/aiq-core-1.1.0/` contains the public source for
`aiq-core/1.1.0-candidate.5`. It does not replace the active 1.0.7 public
authority. Its `aiq.catalog.v2` document binds 72 explicit decisions, 72 unique
within-domain clusters, and the unchanged task scorer and weighted binary
formula at `1.0.6`.

The candidate.5 public identities are:

- canonical catalog:
  `sha256:f19dd1c9a84c8274db8a240994b208bba8f6fd0f3fb6919237bcc4314d53c2cf`;
- ordered task metadata:
  `sha256:cfac96630c9efe3153d80ed43effd6e541bef751e1e7f766a52cfb2910fa3fc4`;
- public release:
  `sha256:a7df194c94f13fcf586e157d40537fd6bc74ffc8cacc64ab20d181f6d8ce2016`.

Candidates.1 through .4 are immutable rejected and permanently non-sealable.
The candidate.4 isolated review has aggregate digest
`sha256:83d561c43323c1b6e4f9236571e8cf8b940980c950f0047543a3ef52a1bca777`
and raw receipt digest
`sha256:a8bbeea77d72cd782ec48aed6a759ecad61740c17d72c1af81f6bf612ef9bca2`.
It approved 65 task semantics and rejected the seven tool-use tasks under
`BEHAVIORAL_COVERAGE_GAP`, `CROSS_TASK_CONSTRUCT_DUPLICATION`, and
`PUBLIC_PRIVATE_CONSTRUCT_MISMATCH`. Candidate.5 retains the 65 approved
semantics and rebuilds only those seven tasks.

Each revised task discloses a distinct `input.json` scenario contract, one
deterministic domain operation, and one task-specific semantic result contract.
The seven operation signatures have different consumed fields, produced fields,
state models, transitions, invariants, and error paths. Each task also declares
a metamorphic basis for all task-specific scenario fields. The authoring proof
must run all 42 cross-task supplied-tool substitutions. A failure caused only
by a changed receipt is not behavior evidence.

Candidate.5 preserves all 35 candidate.4 closure entries. It revalidates the 14
entries that candidate.4 review reopened with task-specific behavior evidence.
It adds seven new `CROSS_TASK_CONSTRUCT_DUPLICATION` entries. Thus, the exact
cumulative closure count is 42; no reopened entry is counted twice.

Each tool-use contract keeps the complete eight-field `receipt.json` contract.
The supplied local tool writes that receipt. Receipt `command_sha256` identifies
the unchanged supplied tool file bytes. It does not identify the command line.
The runner supplies separate digest-only evidence in
`evaluator_input.tool_evidence.completed_command_sha256`. The hard gate requires
exactly one total tool call, exactly one `command_execution` call, and exactly
one completed digest for the public invocation `node bin/task-tool.mjs`. That
command-line digest is
`sha256:6763cc80f8294b52c6494f1c9891e41a8e3cd1c466ca622377c59643a0466319`.
A substituted command, an extra tool call, a missing or wrong digest, or an
uncompleted command lifecycle fails the hard gate. The runner removes command
text from retained provider stdout and stderr evidence. It preserves the exact
semantic final response in the existing result contract before log redaction.
The signed digest map keeps only task-declared required identities; total and
per-tool counts remain unfiltered, so other or extra commands still fail. A
complete matrix can contain at most 119 declared digest entries, which preserves
the fixed signed-package ingress bound without limiting incorrect model tool
behavior.

Each task requires `gold`, `alternate_correct`, `partial`,
`adversarial_format`, and `empty`. `timeout` is `not_applicable` because the
candidate uses natural completion. The catalog is the sole expected-class
authority. It is frozen for a fresh independent review, but it is inactive and
not production-publishable. Fresh review, double sealing, three complete
qualification matrices, qualification, adoption, and cutover are pending.

The candidate contracts are:

- `schema/leakage-review-v2.schema.json` for independently supplied review
  records;
- `schema/corpus-authoring-input-v2.schema.json` and
  `schema/corpus-authoring-harness-v4.schema.json` for exact catalog fixture
  authority;
- `schema/corpus-commitment-v3.schema.json` for an isolated 1.1.0 candidate
  seal;
- `schema/benchmark-qualification-manifest-v1.schema.json` for the exact
  candidate, fixed policy, and three predeclared children;
- `schema/benchmark-qualification-matrix-v1.schema.json` for each separate
  complete 17-by-72 child; and
- `schema/benchmark-qualification-v1.schema.json` for the deterministic
  qualification or rejection result.

The v2 leakage review binds reviewer identity, reviewer task or thread, review
time, source commit, source tree, source manifest, task and catalog digests,
verdict, method, scope, and notes. Candidate.4 review records do not satisfy
candidate.5. The sealer requires one fresh matching record for each exact
candidate.5 task and catalog entry. It does not infer review completion from
task-authored notes.

Qualification uses three complete matrices only. It reports all three pairwise
rank correlations, exact-cell agreement, mean absolute cell delta, a separate
run-to-run prediction interval for every configuration, and uncertainty-aware
comparison groups. One complete 1,224-cell matrix remains the publication unit.
The protocol never pools or splices children. A rejected candidate must receive
a new identity before a task, evaluator, or policy revision is run again.

Regenerate and test the candidate.5 public source without private inputs:

```sh
node scripts/candidates/aiq-core-1.1.0/generate-benchmark-catalog.ts
node --test scripts/candidates/aiq-core-1.1.0/generate-benchmark-catalog.test.ts
```

## Private corpus boundary

The final `aiq.corpus-commitment.v2` document will bind the `1.0.7` private
corpus to the ordered public catalog. It also binds the runner source, harness,
evaluator, runtime, tool policy, network policy, environment, baseline
workspaces, fixture bundles, and task definitions.

The commitment is public-safe. It must not include private paths, secret values,
task content, expected outputs, or signing material.

The repository tracks the active AIQ Core `1.0.7` public catalog and generator.

## Validation

Validate the public examples:

```sh
cargo run -p aiq-runner -- validate \
  --public-tasks benchmarks/examples/tasks
```

Validate the controlled AIQ Core and six-unit contrast corpora without invoking
Codex. Use CLI help for the exact controlled input contract:

```sh
cargo run -p aiq-runner -- validate-core-corpus --help
cargo run -p aiq-runner -- validate-contrast-corpus --help
```

Run the repository checks:

```sh
cargo make check
cargo make test
```

Catalog generation is source-driven. When the owning metadata changes, use the
checked-in generator and review the resulting catalog and digest together.

Synthetic examples test contracts only. They do not disclose or replace the
private benchmark corpus.

## Browser public-projection fixture

`fixtures/aiq-2.0-test-generated-public.json` is a deterministic browser
fixture, not benchmark evidence. The runner builds its 17-by-72 matrix from
the frozen 1.0.7 public task shape and derives every latent field, Wilson
bound, quality score, and task-mix sensitivity value through the normal Rust
scorer. Its outer object has `test_generated: true`, `synthetic: true`, and
`production_publishable: false`; production and Official cutover must reject
this schema. Its nested leaderboard and trend rows are deliberately
Official-shaped (`score_status: official`, `synthetic: false`) so live UI
contract tests exercise the published response shape without weakening the
fail-closed parser.

Regenerate it with:

```sh
cargo run -p aiq-runner -- generate-test-public-fixture \
  --output benchmarks/fixtures/aiq-2.0-test-generated-public.json
```

The command refuses to overwrite an existing protected output. Use a new
temporary output path when checking determinism; do not submit or publish the
result.
