# AIQ Core benchmark contract

Repository source targets the public AIQ Core `1.0.6` candidate and scoring
`1.0.6`. It is a fixed
72-task benchmark across ten domains. The public catalog defines task identity,
domain, difficulty, tool policy, budget, evaluator identity, and public-safe
descriptions. Private task prompts, fixtures, expected outputs, and evaluator
content stay outside Git.

The active public candidate, task, and scorer contract is `1.0.6`. It changes
only task-level runtime envelopes for five interaction tasks and carries forward
the other 67 task, evaluator, tool, and budget contracts with new version,
provenance, and commitment bindings. The public catalog is deterministic and
identity-frozen. Two controlled generations produced one matching tree, and the
reviewed 72-task database commitment is bound in source. Final clean-commit
regeneration, a fresh debugging-02-by-17 pilot followed by a 17-by-5 targeted pilot,
Contrast generation, full calibration,
final native build verification, a real Official run, publication, and final
deployment are pending. The only production tuple is AIQ Core `1.0.6`, scoring
`1.0.6`, and measurement `2.0.0`. Do not reset, initialize, or publish until a
real non-synthetic signed 17-by-72 package passes native verifier replay. No
earlier publication is a compatibility source or fallback.

The `1.0.3` Official attempt was interrupted after its calibration evidence had
already proved a ceiling-policy failure. It was rejected and remains
unpublished calibration evidence. No hidden responses or hidden task details
were published. The `1.0.6` release path requires a fresh coding-07-by-17
falsification pilot, then a fresh 17-by-5 pilot over all five runtime-revised
tasks and one complete, non-Official 17-by-72
falsification-first calibration before any real Official publication path. The
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
sha256:6dc43022b04333de889abc08de118d63652aeab6ee2c3b8610905a2faa91e460
```

Its release identity is:

```text
sha256:fb2a1e088def5e88434ef383e92e0201b406d556c261e294c9ae86ea9bf3ae78
```

The release-policy identity is `aiq-core/1.0.6`. The reviewed evaluator identity
is `sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`.
The public-safe database task-set identity is
`sha256:b3a11e8801310b6c07318ba0a39a9d31ca9f41e88e53295876a940873e333b82`,
and the reviewed task-commitment manifest identity is
`sha256:94d41753482dbb45cc67cf2563fa369f125eb0d8dd19fa186f279c1b0f741211`.
Final controlled corpus identities are not accepted release identities until
the clean-commit regeneration and calibration pass. This scoring-only change
does not update the database task-commitment file; that file must be regenerated
before a database cutover.

Each task score uses the executable weighted-check contract. A private,
content-addressed evaluator configuration binds each binary check, its
nonnegative integer weight, and its hard-gate status. A failed hard gate or a
structural failure sets the task score to zero. Otherwise, the score is the sum
of passed check weights divided by the sum of all positive check weights. Only
a hard gate can have zero weight. A positive-weight hard gate also contributes
to the fraction when all hard gates pass. The verifier replays the exact checks
without evaluator rounding. Public pass conditions summarize coverage; they are
not mathematical weight partitions.

## AIQ Core 1.0.6 public authority

These files own the active catalog authority:

- `candidates/aiq-core-1.0.6/catalog.json`;
- `candidates/aiq-core-1.0.6/catalog.schema.json`;
- `candidates/aiq-core-1.0.6/task.schema.json`; and
- `schema/corpus-commitment-v2.schema.json`.

The task-metadata identity is:

```text
sha256:6dc43022b04333de889abc08de118d63652aeab6ee2c3b8610905a2faa91e460
```

The release identity is:

```text
sha256:fb2a1e088def5e88434ef383e92e0201b406d556c261e294c9ae86ea9bf3ae78
```

The first digest binds the ordered public task metadata. The second binds the
public catalog release. They do not define controlled identities. The reviewed
public-safe database task-set identity is
`sha256:b3a11e8801310b6c07318ba0a39a9d31ca9f41e88e53295876a940873e333b82`,
and the reviewed task-commitment manifest identity is
`sha256:94d41753482dbb45cc67cf2563fa369f125eb0d8dd19fa186f279c1b0f741211`.
Final controlled corpus identities remain calibration candidates; Contrast
remains pending. The shared Rust validator fails closed
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
