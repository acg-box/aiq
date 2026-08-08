# AIQ Core benchmark contract

Repository source targets the public AIQ Core `1.0.6` candidate and scoring
`1.0.6`. It is a fixed
72-task benchmark across ten domains. The public catalog defines task identity,
domain, difficulty, tool policy, budget, evaluator identity, and public-safe
descriptions. Private task prompts, fixtures, expected outputs, and evaluator
content stay outside Git.

The active public candidate, task, and scorer contract is `1.0.6`. All 72 model
tasks use `wall_seconds: null`; five interaction tasks retain revised step and
tool-call limits and the other 67 retain their accepted limits. Prompt,
evaluator, semantic scoring, and tool permissions remain unchanged. The public
catalog is deterministic and identity-frozen. The new identity requires fresh
independent Core and Contrast seals and a regenerated 72-task database
commitment. A focused no-deadline canary, full calibration,
final native build verification, a real Official run, publication, and final
deployment are pending. The only production tuple is AIQ Core `1.0.6`, scoring
`1.0.6`, and measurement `2.0.0`. Do not reset, initialize, or publish until a
real non-synthetic signed 17-by-72 package passes native verifier replay. No
earlier publication is a compatibility source or fallback.

The `1.0.3` Official attempt was interrupted after its calibration evidence had
already proved a ceiling-policy failure. It was rejected and remains
unpublished calibration evidence. No hidden responses or hidden task details
were published. The `1.0.6` release path requires a focused no-deadline canary
for the two previously timed-out Sol ultra cells and one complete, non-Official
17-by-72 falsification-first calibration before any real Official publication path. The
calibration must pass the release policy without an operator override.

## Public authority

- `candidates/aiq-core-1.0.6/catalog.json` is the active generated public
  catalog for repository source.
- `candidates/aiq-core-1.0.6/catalog.schema.json` validates the active source
  catalog.
- `schema/corpus-commitment-v2.schema.json` validates the controlled AIQ Core
  corpus commitment document.
- `schema/result-package-v3.schema.json` validates signed runner packages.
- `schema/normalized-batch-v3.schema.json` validates the database stage.
- `schema/verifier-attestation-v3.schema.json` validates verifier evidence.
- `schema/test-generated-public-fixture-v1.schema.json` validates the
  browser-only public projection fixture. It is not a submission schema.
- `examples/tasks/` contains synthetic public task examples.

The catalog contains 17 model configurations and 72 ordered tasks. Its identity
digest is:

```text
sha256:add2a0514b6cdab99b3329d7065565f5606d13af93338e4bc37a0fbd30019b91
```

Its release identity is:

```text
sha256:5b33cd2daa5efe15e49de34b7137d35bc2ff980a7f619063e7e8b819a857508f
```

The release-policy identity is `aiq-core/1.0.6`. The reviewed evaluator identity
is `sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`.
The checked-in current no-deadline database task-set identity is
`sha256:768a9322f22c5be4d0fcd67dbe4360bd78392c7d0ef47ee9c0b8cedea2374dda`,
and its task-commitment manifest identity is
`sha256:5515d602865ac1c30207957b0b6f36a9420ea7256809ce2c048ee881a74b78d6`.
Independent Core and Contrast A/B sealing and both model-free validators
produced them. They are not release authority. One final clean-source seal and
the calibration gate still must pass.

Each task score uses the executable weighted-check contract. A private,
content-addressed evaluator configuration binds each binary check, its
nonnegative integer weight, and its hard-gate status. A failed hard gate or a
structural failure sets the task score to zero. Otherwise, the score is the sum
of passed check weights divided by the sum of all positive check weights. Only
a hard gate can have zero weight. A positive-weight hard gate also contributes
to the fraction when all hard gates pass. The verifier replays the exact checks
without evaluator rounding. Public pass conditions summarize coverage; they are
not mathematical weight partitions.

Formal model tasks have no wall-clock deadline. Step and tool-call limits remain
part of the execution contract. Elapsed time, tokens, tool use, and estimated
cost are independent efficiency evidence and never enter task score, Rasch
ability, quality, strict pass, ranking, or intervals.

## AIQ Core 1.0.6 public authority

These files own the active catalog authority:

- `candidates/aiq-core-1.0.6/catalog.json`;
- `candidates/aiq-core-1.0.6/catalog.schema.json`;
- `candidates/aiq-core-1.0.6/task.schema.json`; and
- `schema/corpus-commitment-v2.schema.json`.

The task-metadata identity is:

```text
sha256:add2a0514b6cdab99b3329d7065565f5606d13af93338e4bc37a0fbd30019b91
```

The release identity is:

```text
sha256:5b33cd2daa5efe15e49de34b7137d35bc2ff980a7f619063e7e8b819a857508f
```

The first digest binds the ordered public task metadata. The second binds the
public catalog release. They do not define controlled identities. The current
no-deadline public-safe database task-set identity is
`sha256:768a9322f22c5be4d0fcd67dbe4360bd78392c7d0ef47ee9c0b8cedea2374dda`,
and its task-commitment manifest identity is
`sha256:5515d602865ac1c30207957b0b6f36a9420ea7256809ce2c048ee881a74b78d6`.
They were derived from validated Core and Contrast A/B seals. Re-seal once from
the final clean identity commit before the focused canary.
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
node scripts/candidates/aiq-core-1.0.6/generate-benchmark-catalog.ts
node --test --experimental-strip-types \
  scripts/candidates/aiq-core-1.0.6/generate-benchmark-catalog.test.ts
```

## Private corpus boundary

The final `aiq.corpus-commitment.v2` document will bind the `1.0.6` private
corpus to the ordered public catalog. It also binds the runner source, harness,
evaluator, runtime, tool policy, network policy, environment, baseline
workspaces, fixture bundles, and task definitions.

The commitment is public-safe. It must not include private paths, secret values,
task content, expected outputs, or signing material.

The repository tracks the active AIQ Core `1.0.6` public catalog and generator.

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
the frozen 1.0.6 public task shape and derives every latent field, Wilson
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
