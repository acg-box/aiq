# AIQ Core benchmark contract

Repository source targets AIQ Core `1.0.3` and scoring `1.0.3`. It is a fixed
72-task benchmark across ten domains. The public catalog defines task identity,
domain, difficulty, tool policy, budget, evaluator identity, and public-safe
descriptions. Private task prompts, fixtures, expected outputs, and evaluator
content stay outside Git.

AIQ Core `1.0.3` is the current accepted code contract. Its native acceptance
and publication are pending. Live production remains the historical `1.0.2`
contract: the native macOS runner completed its real, non-synthetic Official
benchmark matrix with 17
configurations by 72 tasks, or 1,224 task-level results. The verifier replayed
and accepted its evidence. The distinct publisher published the matrix as
`trusted_verified`. Of the 1,224 results, 1,218 completed and 6 failed. Outcomes
are 329 `correct`, 259 `partial`, 630 `incorrect`, 5 `timeout`, and 1
`budget_exhausted`. Signed batch wall time is 5,844,411 ms (`1:37:24.411`).

Cost coverage is 1,208 `estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage` results. The $125.403257240 priced subtotal is a
Standard API-equivalent estimate for the 1,208 priced results. It is not actual
ChatGPT subscription spend and is not a complete batch total. The publication
has 4,395 artifact bindings, including 19 capability artifacts.

## Public authority

- `candidates/aiq-core-1.0.3/catalog.json` is the active generated public
  catalog for repository source.
- `candidates/aiq-core-1.0.3/catalog.schema.json` validates the active source
  catalog.
- `schema/corpus-commitment-v2.schema.json` validates a controlled corpus
  commitment document.
- `schema/result-package-v3.schema.json` validates signed runner packages.
- `schema/normalized-batch-v3.schema.json` validates the database stage.
- `schema/verifier-attestation-v3.schema.json` validates verifier evidence.
- `examples/tasks/` contains synthetic public task examples.

The catalog contains 17 model configurations and 72 ordered tasks. Its identity
digest is:

```text
sha256:0e315fe2bbcf0efe59ddcd69173addf89ef0fb281ec3ef523234bdc01b3d66a1
```

Its release identity is:

```text
sha256:0dd4f11c49a1e295a75e6ca1e3b7b4f9c38e0160b9eda75ca75a47703e47f80d
```

The release identity is `aiq-core/1.0.3`. The scorer-manifest identity is
`sha256:c898902ef5a604ce2db735819c98d7ebb127733b069bb69bd9a32e26cca8ba4d`.
The evaluator identity is
`sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`.

## AIQ Core 1.0.3 authority

These files own the active catalog authority:

- `candidates/aiq-core-1.0.3/catalog.json`;
- `candidates/aiq-core-1.0.3/catalog.schema.json`;
- `candidates/aiq-core-1.0.3/task.schema.json`; and
- `schema/corpus-commitment-v2.schema.json`.

The task-metadata identity is:

```text
sha256:0e315fe2bbcf0efe59ddcd69173addf89ef0fb281ec3ef523234bdc01b3d66a1
```

The release identity is:

```text
sha256:0dd4f11c49a1e295a75e6ca1e3b7b4f9c38e0160b9eda75ca75a47703e47f80d
```

The first digest binds the ordered task metadata. The second binds the catalog
release identity. Model-free native validation passes all 72 tasks. The
source-only candidate commitment is
`sha256:353ca496bc57c4a7aa43e30e40d8bb9e39c8390cfeb63156e2fad04d832dc9a9`;
the runtime `task_set_hash` is
`sha256:1a7a8e5f37efeb03cf3a2a92a94370ef67ec3b7a6eb385bd5ec3c844713afb0e`.
The distinct controlled generated-task tree identity is
`sha256:cb5c72fc4ce31c40afd078ddc644177148000ee4792303312b58df7054881145`.
The separate six-task AIQ Core Contrast calibration has commitment
`sha256:df3028d576c91f9b57e6aa23a94f0b1ffb61fd04b53a141fe9f0160c08a7c5d9`
and ordered metadata catalog identity
`sha256:5dd1dc515cbcbe46815828d45da3e97cd2e0f106dc743e8c37da33459419c578`.
The production commitment remains pending clean-commit native release binding.
Model-free validation replays each task's gold, alternate-correct, partial,
adversarial-format, empty, and timeout fixtures twice and requires byte-identical
expected results. Near-miss and paired-contrast evidence is validated in the
independent six-task AIQ Core Contrast calibration suite; it is not a per-task
Core fixture commitment. The historical `1.0.2` production publication is one complete
Official `72 × 17` matrix with 1,224 results. Public views contain 17 runs, 1,224
results, 17 leaderboard rows, 17 model-efficiency rows, and 17 model-matrix rows.

Regenerate and test the active source catalog with:

```sh
node scripts/candidates/aiq-core-1.0.3/generate-benchmark-catalog.ts
node --test --experimental-strip-types \
  scripts/candidates/aiq-core-1.0.3/generate-benchmark-catalog.test.ts
```

## Private corpus boundary

The final `aiq.corpus-commitment.v2` document will bind the `1.0.3` private
corpus to the ordered public catalog. It also binds the runner source, harness,
evaluator, runtime, tool policy, network policy, environment, baseline
workspaces, fixture bundles, and task definitions.

The commitment is public-safe. It must not include private paths, secret values,
task content, expected outputs, or signing material.

The checked-in AIQ Core `1.0.2` catalog and generator remain only as archival
and negative compatibility evidence. Do not use them for active generation,
controlled validation, or a new production reference.

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
