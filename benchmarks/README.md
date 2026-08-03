# AIQ Core benchmark contract

Repository source targets AIQ Core `1.0.2` and scoring `1.0.2`. It is a fixed
72-task benchmark across ten domains. The public catalog defines task identity,
domain, difficulty, tool policy, budget, evaluator identity, and public-safe
descriptions. Private task prompts, fixtures, expected outputs, and evaluator
content stay outside Git.

AIQ Core `1.0.2` is not promoted. Production `aiq.wiki` and the personal
Supabase project continue to run the older `1.0.1` foundation until candidate
validation, promotion, the one greenfield database reset, and deployment
complete. No real candidate or Official model run has started.

## Public authority

- `candidates/aiq-core-1.0.2/catalog.json` is the active generated public
  catalog for repository source.
- `catalog/aiq-core-v1.json` is the immutable `1.0.1` predecessor catalog.
- `candidates/aiq-core-1.0.2/catalog.schema.json` validates the active source
  catalog. `schema/catalog.schema.json` validates the historical predecessor.
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
sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b
```

## AIQ Core 1.0.2 release gate

AIQ Core `1.0.2` is an immutable, preregistered release candidate. Repository
source now uses it as its only active task-set and scorer target, but production
remains on AIQ Core `1.0.1`. The candidate is not promoted. These files own the
candidate and source-head catalog authority:

- `candidates/aiq-core-1.0.2/catalog.json`;
- `candidates/aiq-core-1.0.2/catalog.schema.json`;
- `candidates/aiq-core-1.0.2/task.schema.json`; and
- the `schema/release-gate-*.schema.json`,
  `schema/promotion-receipt.schema.json`, and
  `schema/released-manifest.schema.json` contracts.

The task-metadata identity is:

```text
sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937
```

The release identity is:

```text
sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b
```

The first digest binds the ordered task metadata. The second digest also binds
the pre-registered gate policy and predecessor lineage. Candidate evidence must
use the non-Official release-gate calibration path. A passing gate result does
not release the candidate. A distinct promotion key must sign a valid
`aiq.promotion-receipt.v1` before one atomic production cutover can start.

The fixed candidate calibration has three repeats. It contains 3,672 core
observations (`72 × 17 × 3`) and 306 contrast observations
(`3 × 2 × 17 × 3`), for 3,978 observations. This is separate from a fresh
Official `72 × 17` run. No candidate real run has started.

The release gate tests whether `1.0.2` independently meets the preregistered
absolute thresholds. It does not compare `1.0.2` with `1.0.1` and does not
establish that `1.0.2` is superior to `1.0.1`.

Every candidate release lifecycle command validates the public trust policy
against the SHA-256 digest in the separately authenticated runtime variable
`AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256`. The commands do not accept a
caller-selected trust root. The repository does not contain a production trust
policy or production release public keys. Before release-gate operation, the
operator must provision distinct Ed25519 authority and promotion public keys in
one closed-schema trust policy and set the protected runtime variable to the
canonical digest of that exact policy.

The isolated source assembler embeds exact copies of
`release-gate-source-observations.schema.json` and
`release-gate-evidence.schema.json`; tests require those copies to match the
public schema files. Promotion receipt validation also requires
`issued_at >= evidence.collected_at`. Signed candidate execution-unit artifacts
retain the embedded calibration task records, including measured latency and any
available usage fields. The public aggregate release-gate source, evidence, and
result artifacts omit these fields and do not publish efficiency or cost
evidence.

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

Run the repository checks:

```sh
cargo make check
cargo make test
```

Catalog generation is source-driven. When the owning metadata changes, use the
checked-in generator and review the resulting catalog and digest together.

Synthetic examples test contracts only. They do not disclose or replace the
private benchmark corpus.
