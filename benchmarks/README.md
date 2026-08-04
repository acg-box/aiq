# AIQ Core benchmark contract

Repository source targets AIQ Core `1.0.2` and scoring `1.0.2`. It is a fixed
72-task benchmark across ten domains. The public catalog defines task identity,
domain, difficulty, tool policy, budget, evaluator identity, and public-safe
descriptions. Private task prompts, fixtures, expected outputs, and evaluator
content stay outside Git.

AIQ Core `1.0.2` is the current production contract. The native macOS runner
completed the first real, non-synthetic Official benchmark matrix: 17
configurations by 72 tasks, or 1,224 task-level results. The verifier accepted
and published it as `trusted_verified`. Of the 1,224 results, 1,218 completed
and 6 failed. Outcomes are 329 `correct`, 259 `partial`, 630 `incorrect`, 5
`timeout`, and 1 `budget_exhausted`. Signed batch wall time is 5,844,411 ms
(`1:37:24.411`).

Cost coverage is 1,208 `estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage` results. The $125.403257240 priced subtotal is a
Standard API-equivalent estimate for the 1,208 priced results. It is not actual
ChatGPT subscription spend and is not a complete batch total. The publication
has 4,395 artifact bindings, including 19 capability artifacts.

## Public authority

- `candidates/aiq-core-1.0.2/catalog.json` is the active generated public
  catalog for repository source.
- `candidates/aiq-core-1.0.2/catalog.schema.json` validates the active source
  catalog.
- `schema/corpus-commitment-v2.schema.json` validates the current controlled
  corpus commitment.
- `schema/result-package-v3.schema.json` validates signed runner packages.
- `schema/normalized-batch-v3.schema.json` validates the database stage.
- `schema/verifier-attestation-v3.schema.json` validates verifier evidence.
- `examples/tasks/` contains synthetic public task examples.

The catalog contains 17 model configurations and 72 ordered tasks. Its identity
digest is:

```text
sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937
```

Its release identity is:

```text
sha256:54e8010f9c9ebc187574015dd6f8a62fd8025884d86c5cdd0d581551ab6095a6
```

## AIQ Core 1.0.2 authority

These files own the active catalog authority:

- `candidates/aiq-core-1.0.2/catalog.json`;
- `candidates/aiq-core-1.0.2/catalog.schema.json`;
- `candidates/aiq-core-1.0.2/task.schema.json`; and
- `schema/corpus-commitment-v2.schema.json`.

The task-metadata identity is:

```text
sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937
```

The release identity is:

```text
sha256:54e8010f9c9ebc187574015dd6f8a62fd8025884d86c5cdd0d581551ab6095a6
```

The first digest binds the ordered task metadata. The second binds the catalog
release identity. Model-free validation replays every controlled fixture twice,
checks the six contrast units, and requires byte-identical expected results.
The first paid publication is one complete Official `72 × 17` matrix with
1,224 results. Public views contain 17 runs, 1,224 results, 17 leaderboard rows,
17 model-efficiency rows, and 17 model-matrix rows.

Regenerate and test the active source catalog with:

```sh
node scripts/candidates/aiq-core-1.0.2/generate-benchmark-catalog.ts
node --test --experimental-strip-types \
  scripts/candidates/aiq-core-1.0.2/generate-benchmark-catalog.test.ts
```

## Private corpus boundary

One `aiq.corpus-commitment.v2` document binds the current private corpus to the
ordered public catalog. It also binds the runner source, harness, evaluator,
runtime, tool policy, network policy, environment, baseline workspaces, fixture
bundles, and task definitions.

The commitment is public-safe. It must not include private paths, secret values,
task content, expected outputs, or signing material.

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
