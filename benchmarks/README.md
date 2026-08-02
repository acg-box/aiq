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
- `schema/release-gate-authority.schema.json` validates the signed authority
  that binds the evidence source, complete model matrix, and contrast arms.
- `schema/release-gate-trust-policy.schema.json` validates the out-of-band
  trusted signer registry. Evidence cannot add a trusted key.
- `schema/release-gate-trust-root.schema.json` validates the trust-policy digest
  that the release runtime pins outside submitted release material.
- `schema/release-receipt.schema.json` validates the signed promotion receipt.
- `schema/corpus-commitment-v2.schema.json` validates the current controlled
  corpus commitment.
- `schema/result-package-v3.schema.json` validates signed runner packages.
- `schema/normalized-batch-v3.schema.json` validates the database stage.
- `schema/verifier-attestation-v3.schema.json` validates verifier evidence.
- `examples/tasks/` contains synthetic public task examples.

The catalog has 72 ordered tasks. Its task-metadata identity is:

```text
sha256:83440762f969c521d16144a54a1490fadba0fce22cce902fb1d30af66a1403ba
```

Its candidate catalog-release identity is:

```text
sha256:1a29c58d23a5675c0704ed9ab5bf6a74cd267d3a82f39807f783fb05cfa7b40c
```

The first digest binds only ordered task metadata. The second digest binds that
task identity, the pre-registered release policy, and predecessor lineage. This
split gives runtime consumers one unambiguous task identity without weakening
the candidate release contract. Both use SHA-256 over
`aiq.sorted-key-json.v1` canonical UTF-8 bytes. The catalog retains the exact `1.0.1` task
identity digest and owning Git commit as public-safe provenance.

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
- at least 3 predeclared paired contrasts, each with a challenge-minus-reference
  difference of at least 3 AIQ points and an adjusted lower bound above zero; and
- at least 3 complete repeats, aggregate standard deviation not more than 2 AIQ
  points, median cell range not more than `0.10`, and ICC at least `0.75`.

The generator exports an executable evaluator for this policy. Each completed
raw cell contains four component records, at least three deterministic binary
assertions per component, and evaluator, result, package, and verification
digests. A cell-binding digest covers the cell identity, four raw components,
reported score, and all four provenance digests. Completed result digests must
also be unique across cells. The evaluator recomputes the
`3000/2500/2500/2000` component formula and rejects a reported score that
differs from the six-decimal result.

The separately signed authority binds the exact source-observation digest,
corpus commitment, six contrast-arm digests, and 17 complete model
configurations. Each model configuration includes family, reasoning effort,
runtime, tool-policy, and network-policy identity. The trusted public key comes
from a separate trust policy. The release runtime must pin that policy's
canonical digest out of band and must not accept the pin from evidence, an
authority, a receipt, or a release request. Authority and promotion roles must
also use different Ed25519 public-key fingerprints, not only different key IDs.
Authority and receipt signatures use Ed25519 over the declared
`aiq.sorted-key-json.v1` signature domain bytes.

Paired-contrast inference uses the 17 model configurations as independent
clusters. It averages the three or more repeats inside each configuration,
then applies the pre-registered one-sided Bonferroni normal approximation to
the 17 cluster means. Repeats do not inflate the independent sample count.

A passing gate result does not mutate or release the candidate catalog. Only a
valid `aiq.release-receipt.v1` signed by a separately trusted promotion key can
express `promotion_state: released`. The receipt binds the candidate catalog,
task identity, signed authority, evidence, and exact gate result. No checked-in
receipt or catalog field claims that current evidence passes.

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
