# AIQ Core benchmark contract

AIQ Core `1.0.0` is a fixed 72-task benchmark across ten domains. The public
catalog defines task identity, domain, difficulty, tool policy, budget, evaluator
identity, and public-safe descriptions. Private task prompts, fixtures, expected
outputs, and evaluator content stay outside Git.

## Public authority

- `catalog/aiq-core-v1.json` is the generated public catalog.
- `schema/catalog.schema.json` validates the catalog.
- `schema/corpus-commitment-v2.schema.json` validates the current controlled
  corpus commitment.
- `schema/result-package-v3.schema.json` validates signed runner packages.
- `schema/normalized-batch-v3.schema.json` validates the database stage.
- `schema/verifier-attestation-v3.schema.json` validates verifier evidence.
- `examples/tasks/` contains synthetic public task examples.

The catalog contains 17 model configurations and 72 ordered tasks. Its identity
digest is:

```text
sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3
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

Run the repository checks:

```sh
cargo make check
cargo make test
```

Catalog generation is source-driven. When the owning metadata changes, use the
checked-in generator and review the resulting catalog and digest together.

Synthetic examples test contracts only. They do not disclose or replace the
private benchmark corpus.
