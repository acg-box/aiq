# AIQ Core benchmark contract

Repository source targets AIQ Core `1.1.0`, task scorer
`1.0.6`, aggregate scorer `1.0.8`, and measurement `2.0.0`. It is a fixed
72-task benchmark across ten domains. The public catalog defines task identity,
domain, difficulty, tool policy, budget, evaluator identity, and public-safe
descriptions. Private task prompts, fixtures, expected outputs, and evaluator
content stay outside Git.

All 72 formal tasks use `wall_seconds: null`, `max_steps: null`, and
`max_tool_calls: null`. The public catalog is deterministic. Candidate.16
retains 29 private tasks, reauthors 36 structured scenarios, and repairs seven
ToolUse command-evidence bindings after candidate.15 failed full calibration.
A fresh review, seal, complete 17-by-72 calibration, policy-v2 replay and
admission v3, final native build
verification, a separate real Official run, publication, and final deployment
are required. The only supported production tuple is AIQ Core `1.1.0`, task scorer `1.0.6`, aggregate scorer
`1.0.8`, and measurement `2.0.0`. Do not reset,
initialize, or publish until a
real non-synthetic signed 17-by-72 package passes native verifier replay. No
earlier publication is a compatibility source or fallback.

Earlier bounded runs remain immutable unpublished release evidence. The new
complete non-Official 17-by-72 package is the sole 1.1.0 calibration source.
The verifier replays all 1,224 cells without model calls and issues a new signed
fixed-bank admission. A separate complete 17-by-72 Official run remains
required. No operator can override the release policy.

Calibration policy v2 keeps the 0.50 informative-task rate as a signed
descriptive target. It does not turn the binary count into a publication cliff.
The hard gates still require complete semantic coverage, no runtime or missing
cells, at least 0.50 non-uniform tasks, bounded universal floor and ceiling
rates, nondegenerate domains, and sufficient model and latent-score spread.

## Public authority

- `candidates/aiq-core-1.1.0/catalog.json` is the active generated public
  catalog for repository source.
- `candidates/aiq-core-1.1.0/catalog.schema.json` validates the active source
  catalog.
- `schema/corpus-commitment-v3.schema.json` validates the controlled AIQ Core
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
sha256:459e1608a51d2a35286d6480df83e69cb4395d6e1a1062aa4410c2e0fdb92105
```

Its release identity is:

```text
sha256:fb69438f9317e79515e99886d072c7540371ffd4a0732c4ab1286b36752597a6
```

The production task-set identity is `aiq-core/1.1.0`, derived from retained source
identity `aiq-core/1.1.0-candidate.19`. The reviewed evaluator identity
is `sha256:748e0a6c07eb7e3407cc22d50b65eb6d055305cb6e1d719ca3cfd3a109bec809`.
The checked-in current no-deadline database task-set identity is
`sha256:c7481e46c64dbf5ff9f50a85c83608d48390a03cbf9e94a1d89ab36aeb6df89a`,
and its task-commitment manifest identity is
`sha256:d8dddd1bc496a1609c3268068fdfdfa4562c589ddfdfec365a6a49caadefe96b`.
They are public bindings derived from the reviewed seal, not model-run or
production authority. The calibration, Official, and cutover gates still apply.

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

## AIQ Core 1.0.7 frozen predecessor authority

These files retain the frozen predecessor catalog and legacy Contrast authority:

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

## AIQ Core 1.1.0 source candidate

`candidates/aiq-core-1.1.0/` carries public source identity
`aiq-core/1.1.0-candidate.19`. It is not active until its fresh review, seal,
calibration, admission, Official run, and cutover complete. Its
`aiq.catalog.v2` document binds 72 explicit decisions, 72 unique
within-domain clusters, and the unchanged task scorer and weighted binary
formula at `1.0.6`.

The candidate.19 public identities are:

- canonical catalog:
  `sha256:7bbb59699bfde0171098a4e711c48311fae6989348057e5acce3fa87061e675e`;
- ordered task metadata:
  `sha256:459e1608a51d2a35286d6480df83e69cb4395d6e1a1062aa4410c2e0fdb92105`;
- public release:
  `sha256:fb69438f9317e79515e99886d072c7540371ffd4a0732c4ab1286b36752597a6`.

Candidates.1 through .18 are immutable predecessor evidence.
Candidate.5 retains its model-free authoring evidence and all task semantics,
but its source integration is rejected. Its catalog declared task-metadata
identity
`sha256:cfac96630c9efe3153d80ed43effd6e541bef751e1e7f766a52cfb2910fa3fc4`,
while the Rust candidate commitment consumer and public v3 schema required the
stale identity
`sha256:393cb2563b2161ccb42dd5a50ea63a7827f4d5c485ca0a98103e80eef3d0fbe6`.
The sealer writes the catalog identity and immediately validates through that
consumer, so candidate.5 cannot complete a positive seal round trip.

Candidate.6 preserved all 72 candidate.5 task-facing semantics. Its public
semantic projection commitment is
`sha256:36633afa4103ddb893a6aef5df07653604c7410d4ac215baca4687db93fb5e54`.
The Rust validator derives candidate identity from the validated embedded
catalog. The public commitment schema binds the same identity. Source tests
exercise the positive catalog-to-commitment round trip and reject stale
identities. Candidate.7 kept those task semantics and repaired the separate
candidate execution and replay-verified qualification-evidence boundary.
Candidate.6 retains 72 approved reviews and two byte-identical model-free
seals with canonical commitment
`sha256:37291d7da5f2b5d5b112b54b8ce1b296c20f718ebead87c14118056769e47011`.
Those private bytes remain unchanged, but they cannot be relabeled or reused for
candidate.7 because every review and seal binds candidate.6 source identity.

Candidate.7 is rejected source evidence. Candidate preparation accepted its
corpus, but completed-run validation, recovery packaging, and package serialization
returned to the active 1.0.7 validator. Candidate.8 carries the candidate context
through those paths, but its package command derives the context from the saved
record. It also records Node.js 24.19.0 instead of the checked-in 24.18.0 runtime.
Candidate.9 accepts candidate package inputs only as one complete group: exact
tasks, corpus commitment, and source root. It validates those inputs independently,
binds every external corpus field and the exact task evaluator digest, and carries
that same authority through signed-payload serialization. The active 1.0.7,
Contrast, historical, Official, and production-submission boundaries remain
unchanged.

Candidate.9 is rejected source evidence because two public response contracts
drifted from their owners. `debugging-04` named `src/task.mjs`, but its prompt,
workspace allowlist and progress binding, and weighted evaluator import all name
`src/task.ts`. `instruction-following-05` used `undefined` for the required
`calculation_note` field even though that token is outside the catalog schema's
response-type enum. Candidate.10 changes those values only to `src/task.ts` and
`string`, but it is rejected because its generic location check uses
candidate.3's response contract as the supposed task-owned source. A synchronized
mutation can change candidate.3 through candidate.5 to the same wrong path and
pass. Candidate.11 preserves the corrected leaves. Its separately owned
`candidates/aiq-core-1.1.0/task-response-authority.json` projection supplies the
public-safe response mode and locations without consulting a versioned response
contract. Candidate.11 is rejected because its tracked private validator treated
the protected keys of `expected_file_sha256` as response locations and inferred
final response from the absence of a workspace policy. The immutable task bytes
contain one hard-gate `complete_workspace_policy` for every task, including the
single `response_json` final-response task. Candidate.12 corrects that existing
owner only. For workspace tasks, it excludes protected inputs from the mutable
allowlist, then uses the ordered union of progress files and evaluator `path`
targets. It uses evaluator-source references only when that union is empty. The
result is 71 workspace responses and one final response. Progress is exact for
66 workspace tasks, empty for four, and a strict subset for one. Bounded child
diagnostics remain unchanged.

Candidate.12 is rejected before model invocation. The 72 task files loaded in
lexical order, but candidate validation and qualification require checked-catalog
order. Candidate.13 applies the existing catalog-order owner during candidate-only
preparation. Its candidate preflight route selects the existing v3 commitment
schema; active and standalone preflight continue to require v2.

Candidate.13 is rejected operational evidence. Its isolated Jordan run completed
all 17 capability probes and started 88 task cells, but only 56 of 1,224 cells
completed before five-hour usage reached 100%; seven-day usage was 17%. It has no
package, replay-verified stage, attestation, or qualification artifact.
Candidate.14 preserves all task-facing semantics and replaces only that
quota-infeasible release-qualification shape. Its one 216-cell run and signed
package completed, but `verify-local --candidate-qualification` loaded ordinary
task filenames lexically. The first catalog mismatch was index 8, and the ordered
evaluator identity failed before replay, so no stage, attestation, or qualification
artifact exists. Candidate.15 calls the existing checked-catalog ordering owner
immediately after candidate task loading and before verifier identity checks.
Its complete 1,224-cell calibration had no runtime failures, but policy v2
rejected 38 universal full-credit tasks, ten universal semantic-zero tasks, only
22 non-uniform tasks, and six degenerate domains. Candidate.16 preserves policy
v2 and the public response contracts while repairing the measured bank defects.
Independent review rejects all 43 revised candidate.16 tasks because their
private evaluators reject a publicly optional field; six Documentation tasks
also score optional `next_steps` as required. Candidate.17 corrects only that
evaluator parity and the active delivery runbook drift.
Independent source review rejects candidate.17 because one active Security
model sentence still says 12 public views and the focused regression missed
that wording. Candidate.18 corrects that final documentation owner only. Its
isolated Morgan calibration reached 288 checkpoint results before a structured
`Selected model is at capacity` event was misclassified as terminal authentication
because ordinary task output contained that word. Candidate.19 preserves all task
semantics and routes exact temporary model-capacity events through the existing
resumable backpressure owner.

Each revised task discloses a distinct `input.json` scenario contract, one
deterministic domain operation, and one task-specific semantic result contract.
The seven operation signatures have different consumed fields, produced fields,
state models, transitions, invariants, and error paths. Each task also declares
a metamorphic basis for all task-specific scenario fields. The authoring proof
must run all 42 cross-task supplied-tool substitutions. A failure caused only
by a changed receipt is not behavior evidence.

Candidate.15 preserves the exact 42 candidate.5 task-issue closures. The
`QUALIFICATION_EVIDENCE_BRIDGE_UNAUTHENTICATED` repair is one separate
source-integrity closure. The candidate.7 validation-context failure is a second
source-only closure. The package-input correction and Node.js runtime correction
are two more source-only closures. The response-contract correction is a fifth,
and the private response-source-owner repair is a sixth source-only
closure. None of these closures counts toward those 42 entries.

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
complete three-configuration qualification matrix can contain at
most 21 declared digest entries, which remains within the signed-package bound.

Each task requires `gold`, `alternate_correct`, `partial`,
`adversarial_format`, and `empty`. `timeout` is `not_applicable` because the
candidate uses natural completion. The catalog is the sole expected-class
authority. Candidate.15 is frozen for a fresh independent review, but it is
inactive and not production-publishable. Fresh review, double sealing, one
complete qualification matrix, qualification, adoption, and cutover are
pending.

The candidate contracts are:

- `schema/leakage-review-v2.schema.json` for independently supplied review
  records;
- `schema/corpus-authoring-input-v2.schema.json` and
  `schema/corpus-authoring-harness-v4.schema.json` for exact catalog fixture
  authority;
- `schema/corpus-commitment-v3.schema.json` for an isolated 1.1.0 candidate
  seal;
- `schema/benchmark-qualification-manifest-v3.schema.json` for the exact
  candidate, fixed identity-and-completeness policy, and one child/run/verifier identity;
- `schema/calibration-verified-stage-v2.schema.json` for the optional candidate-only
  verifier-derived 3-by-72 cell projection; and
- `schema/benchmark-qualification-v3.schema.json` for the deterministic
  qualification result.

The v2 leakage review binds reviewer identity, reviewer task or thread, review
time, source commit, source tree, source manifest, task and catalog digests,
verdict, method, scope, and notes. Candidate.17 review records are not transferable
evidence. The sealer requires one fresh matching record for each exact
candidate.19 task and catalog entry. It does not infer review completion from
task-authored notes.

Qualification consumes one complete replay-verified stage and attestation pair.
The independently retained manifest digest fixes the candidate, exact Sol-medium,
Terra-medium, and Luna-medium selection, run, and verifier before execution.
All 216 catalog-ordered cells must be complete. The artifact binds exact corpus,
source, package, runner, verifier, stage, attestation, provenance, and matrix
identities. It is execution qualification only and explicitly makes no
prediction-interval, Spearman-correlation, run-variance, or precise-rank claim.
The v3 policy and artifact contain no stability thresholds or synthetic zero
values for removed claims.

Regenerate and test the candidate.19 public source without private inputs:

```sh
node scripts/candidates/aiq-core-1.1.0/generate-benchmark-catalog.ts
node --test scripts/candidates/aiq-core-1.1.0/generate-benchmark-catalog.test.ts
```

## Private corpus boundary

The final `aiq.corpus-commitment.v3` document will bind the `1.1.0` private
corpus to the ordered public catalog. It also binds the runner source, harness,
evaluator, runtime, tool policy, network policy, environment, baseline
workspaces, fixture bundles, and task definitions.

The commitment is public-safe. It must not include private paths, secret values,
task content, expected outputs, or signing material.

The repository tracks the AIQ Core `1.1.0` source candidate catalog and generator.

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
the frozen 1.1.0 public task shape and derives every latent field, Wilson
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
