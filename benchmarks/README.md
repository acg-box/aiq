# AIQ Core benchmark contract

Repository source targets the public AIQ Core `1.0.5` candidate and scoring
`1.0.5`. It is a fixed
72-task benchmark across ten domains. The public catalog defines task identity,
domain, difficulty, tool policy, budget, evaluator identity, and public-safe
descriptions. Private task prompts, fixtures, expected outputs, and evaluator
content stay outside Git.

The active public candidate, task, and scorer contract is `1.0.5`. It revises
four calibration-sensitive tasks and carries forward 68 task designs with new
version, provenance, and commitment bindings. The create-new interaction
candidate passed two-candidate reproducibility,
independent authoring validation, and the Rust 72-task corpus validator. Its
controlled Core, runtime, evaluator, generated-task tree, and database
commitment identities remain calibration candidates. Contrast generation, full
calibration, final native build verification, a real Official run, publication,
and final deployment are pending. Live production remains the historical
`1.0.2` contract: the native macOS runner
completed its real, non-synthetic Official benchmark matrix with 17
configurations by 72 tasks, or 1,224 task-level results. The verifier replayed
and accepted its evidence. The distinct publisher published the matrix as
`trusted_verified`. Of the 1,224 results, 1,218 completed and 6 runtime issues. Outcomes
are 329 `correct`, 259 `partial`, 630 `incorrect`, 5 `timeout`, and 1
`budget_exhausted`. Signed batch wall time is 5,844,411 ms (`1:37:24.411`).

Cost coverage is 1,208 `estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage` results. The $125.403257240 priced subtotal is a
Standard API-equivalent estimate for the 1,208 priced results. It is not actual
ChatGPT subscription spend and is not a complete batch total. The publication
has 4,395 artifact bindings, including 19 capability artifacts.

The `1.0.3` Official attempt was interrupted after its calibration evidence had
already proved a ceiling-policy failure. It was rejected and remains
unpublished calibration evidence. No hidden responses or hidden task details
were published. The `1.0.5` release path requires one complete, non-Official
17-by-72 falsification-first calibration before any real Official publication
path. The calibration must pass the release policy without an operator override.

## Public authority

- `candidates/aiq-core-1.0.5/catalog.json` is the active generated public
  catalog for repository source.
- `candidates/aiq-core-1.0.5/catalog.schema.json` validates the active source
  catalog.
- `schema/corpus-commitment-v2.schema.json` validates the controlled AIQ Core
  corpus commitment document.
- `schema/result-package-v3.schema.json` validates signed runner packages.
- `schema/normalized-batch-v3.schema.json` validates the database stage.
- `schema/verifier-attestation-v3.schema.json` validates verifier evidence.
- `examples/tasks/` contains synthetic public task examples.

The catalog contains 17 model configurations and 72 ordered tasks. Its identity
digest is:

```text
sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7
```

Its release identity is:

```text
sha256:496b40f54dc7c3dc92d8880201373344c723001a0570a4debd28e539cfe4030d
```

The release-policy identity is `aiq-core/1.0.5`. The current controlled
candidate evaluator identity is
`sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`,
and its scorer-manifest identity is
`sha256:bf6a623e7d76967fa214e9540124c227b4cc53c0288b0661ef89a0edc741ffa0`.
They are not accepted release identities until calibration passes.

Each task score uses the executable weighted-check contract. A private,
content-addressed evaluator configuration binds each binary check, its
nonnegative integer weight, and its hard-gate status. A failed hard gate or a
structural failure sets the task score to zero. Otherwise, the score is the sum
of passed check weights divided by the sum of all positive check weights. Only
a hard gate can have zero weight. A positive-weight hard gate also contributes
to the fraction when all hard gates pass. The verifier replays the exact checks
without evaluator rounding. Public pass conditions summarize coverage; they are
not mathematical weight partitions.

## AIQ Core 1.0.5 public authority

These files own the active catalog authority:

- `candidates/aiq-core-1.0.5/catalog.json`;
- `candidates/aiq-core-1.0.5/catalog.schema.json`;
- `candidates/aiq-core-1.0.5/task.schema.json`; and
- `schema/corpus-commitment-v2.schema.json`.

The task-metadata identity is:

```text
sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7
```

The release identity is:

```text
sha256:496b40f54dc7c3dc92d8880201373344c723001a0570a4debd28e539cfe4030d
```

The first digest binds the ordered public task metadata. The second binds the
public catalog release. They do not define controlled identities. The current
create-new candidate passed model-free generation and validation. Its
generated-task tree is
`sha256:0fb855414e626692346e74cb7326a4cf85b2be219776a419c9a723bdbdc18505`,
its Core commitment is
`sha256:f196b67599a7305473dba1054d8511c9bf60011c67fb2f58bb0f8706d04db612`,
and its public-safe database task-set identity is
`sha256:f6fc21fa2deb3788c186437c45f8e1c8d5d1e366d32bc81e3b5f847e9844cf05`.
These are calibration-candidate identities; Contrast remains pending. The
shared Rust validator fails closed
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
Core fixture commitment. The historical `1.0.2` production publication is one complete
Official `72 × 17` matrix with 1,224 results. Public views contain 17 runs, 1,224
results, 17 leaderboard rows, 17 model-efficiency rows, and 17 model-matrix rows.

Regenerate and test the active source catalog with:

```sh
node scripts/candidates/aiq-core-1.0.5/generate-benchmark-catalog.ts
node --test --experimental-strip-types \
  scripts/candidates/aiq-core-1.0.5/generate-benchmark-catalog.test.ts
```

## Private corpus boundary

The final `aiq.corpus-commitment.v2` document will bind the `1.0.5` private
corpus to the ordered public catalog. It also binds the runner source, harness,
evaluator, runtime, tool policy, network policy, environment, baseline
workspaces, fixture bundles, and task definitions.

The commitment is public-safe. It must not include private paths, secret values,
task content, expected outputs, or signing material.

The repository tracks the active AIQ Core `1.0.5` public catalog and generator.

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
