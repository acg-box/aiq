# AIQ Core benchmark contract

AIQ Core `1.0.2` is a candidate 72-task benchmark across ten practical-work
domains. The public catalog defines task identity, domain, provisional coverage
label, tool policy, budget, evaluator identity, scoring components, redesign
intent, and public-safe descriptions. Private task prompts, fixtures, expected
outputs, and evaluator content stay outside Git.

Version `1.0.2` supersedes the `1.0.1` public design. It does not rewrite the
`1.0.1` provenance or calibration record. All 72 task designs now require four
independently scored components, staged partial outcomes, near-miss cases, and
paired-contrast cases. The controlled corpus must implement these requirements
before a model run can qualify this version for release.

## Public authority

- `catalog/aiq-core-v1.json` is the generated public catalog.
- `schema/catalog.schema.json` validates the catalog.
- `schema/release-gate-evidence.schema.json` validates controlled release-gate
  evidence.
- `schema/corpus-commitment-v2.schema.json` validates the current controlled
  corpus commitment.
- `schema/result-package-v3.schema.json` validates signed runner packages.
- `schema/normalized-batch-v3.schema.json` validates the database stage.
- `schema/verifier-attestation-v3.schema.json` validates verifier evidence.
- `examples/tasks/` contains synthetic public task examples.

The catalog contains 17 model configurations and 72 ordered tasks. Its identity
digest is:

```text
sha256:efe6cec623c140cbb6a4c96583a5d0aed24ec856d7792301d1543bd1f9b90db5
```

The digest binds the ordered task metadata and the pre-registered release
policy plus the predecessor lineage. A task, policy, or predecessor change
creates a different candidate catalog identity. The catalog retains the exact
`1.0.1` task identity digest and owning Git commit as public-safe provenance.

## Candidate release gate

The catalog status is `candidate_requires_controlled_release_gate`. The
`release_gate_policy` is pre-registered policy, not passing evidence. AIQ Core
`1.0.2` must not become a released benchmark identity until new controlled
hidden-corpus evidence passes all these checks:

- no infrastructure failures and no evaluator failures;
- not more than 7 floor tasks with mean score at or below `0.10`;
- not more than 7 ceiling tasks with mean score at or above `0.90`;
- at least 43 mid-band tasks with mean score from `0.20` through `0.80`;
- not more than 14 invariant tasks with score range at or below `0.05`;
- in each domain, at least 50% mid-band tasks, not more than 30% floor tasks,
  and not more than 30% ceiling tasks;
- at least 3 predeclared paired contrasts, each with an absolute difference of
  at least 3 AIQ points and an adjusted lower bound above zero; and
- at least 3 complete repeats, aggregate standard deviation not more than 2 AIQ
  points, median cell range not more than `0.10`, and ICC at least `0.75`.

The generator exports an executable evaluator for this policy. It accepts only
schema-versioned raw cells and raw paired observations that bind the catalog
identity, corpus commitment, model matrix, repeat IDs, and a recomputed source
observation digest. It derives failure counts, task bands, domain shares, paired
differences, adjusted lower bounds, repeat standard deviation, median cell
range, and absolute-agreement ICC. A caller cannot submit those aggregates as
gate inputs. The evaluator also requires a separate trusted release authority
with the expected catalog, corpus, model-matrix, and six distinct contrast-arm
digests. Evidence values must match that authority. Each contrast row binds its
reference and challenge controlled-object digests. Catalog tests exercise exact
limits and rejection paths. No
checked-in field claims that current evidence passes.

The `easy`, `medium`, and `hard` values remain only provisional, non-ordinal
coverage labels. They are not empirical difficulty ranks and do not change score
weight or determine task budgets. Input and tool scope determine budgets.

## Private corpus boundary

One `aiq.corpus-commitment.v2` document must bind the new private corpus to the
ordered `1.0.2` public catalog. It must also bind the runner source, harness,
evaluator, runtime, tool policy, network policy, environment, baseline
workspaces, fixture bundles, and task definitions.

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

```sh
node scripts/generate-benchmark-catalog.ts
node --test scripts/generate-benchmark-catalog.test.ts
```

Synthetic examples test contracts only. They do not disclose or replace the
private benchmark corpus.
