# AIQ verifier

`aiq-verifier` is a supervised worker for queued v4 result packages. It claims one
or more packages through the Web gateway, downloads exact private artifacts,
reconstructs candidate workspaces, replays deterministic evaluators, and submits
a signed verifier attestation.

## Required inputs

Production use requires:

- the Web deployment origin;
- the 72 private controlled tasks;
- verifier-owned environment metadata;
- the committed evaluator registry and Node.js runtime;
- the current corpus commitment, its retained `core-a/source-snapshot`, and the controlled
  toolchain root;
- the clean detached current release source bound by the verifier environment and final-build
  receipt;
- a fresh replay root;
- `AIQ_VERIFIER_INGRESS_TOKEN`;
- `AIQ_VERIFIER_SIGNING_KEY`.

Start from `config/verifier-environment.example.json`. The verifier validates
that the completed file is structurally and semantically self-consistent before
it claims work.

The verifier identity must differ from the runner/package signer. Publication
uses a third identity.

Official `verify-local` also requires `--calibration-admission` plus the current
admission authority inputs shown by `verify-local --help`. Before evaluator
replay, the verifier validates the approved verifier signature, issuance and
build bindings, bundle digest, complete frozen bank, and the exact bank embedded
in the Official run. Official replay never re-fits the item bank.

The isolated `--calibration-source-1-0-7` mode accepts only the retained signed
1.0.7 calibration package. It replays every result without model calls and
issues calibration admission v3 under aggregate scoring 1.0.8 and policy v2.
Production ingestion does not accept this source-only path.

Use `renew-calibration-admission` only after a source or native-binary repair
when the active private release still has a valid complete signed
`aiq.calibration-admission-bundle.v3`. The command does not read the original
package or replay artifacts. It does not run Codex, a model, or a task
evaluator. It verifies the retained stage, attestation, admission signatures,
digests, frozen bank, diagnostic, and internal links against the controlled
tasks. It independently validates the production reference before it trusts
the retained runner and verifier keys.

The target production reference, approved identities, corpus and corpus source
manifest, tasks and evaluators, model toolchain, evaluator runtime, Codex, and
Codex code-mode host must have the same identities as the retained admission.
The corpus source manifest is validated against the retained corpus source
snapshot. The target repository commit and tree are validated independently
against the clean detached target source and the final-build receipt. Only the
final-build receipt, repository commit and tree, runner executable, and verifier
executable can change. The command signs a new admission binding.
It preserves the original run and package identities, stage, attestation,
replay provenance, bank, diagnostic, and observation time. The output path must
not exist.

Run the final target verifier binary itself. Its digest must match the target
final-build receipt. Export `AIQ_VERIFIER_SIGNING_KEY` for the verifier identity
that the protected production reference approves, then run:

```sh
/controlled/target/bin/aiq-verifier renew-calibration-admission \
  --source-bundle /private/current/calibration-admission-bundle.v3.json \
  --tasks /controlled/tasks \
  --environment /controlled/target/verifier-environment.json \
  --evaluator-root /controlled/evaluators \
  --corpus-commitment /controlled/corpus-commitment.json \
  --evaluator-runtime /controlled/toolchain/node \
  --codex-toolchain-root /controlled/toolchain \
  --corpus-source-root /controlled/core-a/source-snapshot \
  --target-source-root /controlled/target/source-detached \
  --runner-binary /controlled/target/bin/aiq-runner \
  --codex-binary /controlled/codex-runtime/codex \
  --production-reference /controlled/production-reference.json \
  --expected-production-reference-sha256 'sha256:<exact-reference-digest>' \
  --build-receipt /private/target/final-build-receipt.v2.json \
  --expected-build-receipt-sha256 'sha256:<exact-receipt-digest>' \
  --output /private/target/calibration-admission-bundle.v3.json
```

Show the production worker contract and the model-free operator modes:

```sh
cargo run -p aiq-verifier -- --help
cargo run -p aiq-verifier -- validate-environment --help
cargo run -p aiq-verifier -- verify-local --help
cargo run -p aiq-verifier -- renew-calibration-admission --help
cargo run -p aiq-verifier -- verify-qualification --help
```

`verify-qualification` is an offline, model-free AIQ Core 1.1.0 candidate
check. It uses the qualification implementation from the `aiq-runner` library,
which is the same owner used by the runner command. It recomputes the exact
artifact from the predeclared manifest, its independently retained expected
digest, the qualification-ready catalog, and one replay-verified stage and
attestation pair. The trusted verifier derives all 216 cells during replay and
binds them through the signed stage digest. The command rejects unsupported
versions, changed policy, catalog or candidate identity drift, missing or
duplicate cells, runtime-invalid or synthetic cells, untrusted signers, rejected
evidence, and any artifact mismatch. It does not create a new
qualification artifact, invoke a model, publish evidence, or change an already
rejected child.

Use `verify-local --candidate-qualification --candidate-source-root ...` only
for one complete signed candidate Calibration package. This mode selects the
same candidate commitment boundary as runner preparation and writes create-new
candidate stage and attestation files. It rejects Official, partial, synthetic,
runtime-invalid, or active-1.0.7 evidence. The production worker has no candidate
mode and continues to accept only its active 1.0.7 environment.
After the ordinary controlled task loader returns, candidate mode alone reuses
the checked candidate-catalog owner to establish exact catalog order before
corpus, evaluator, package, or replay validation. Candidate.14 is rejected
evidence because its verifier retained lexical filename order at that boundary;
normal and production-worker task loading remains unchanged.

The artifact proves exact end-to-end identities and complete execution of Sol
medium, Terra medium, and Luna medium over all 72 catalog-ordered tasks. It
explicitly makes no prediction-interval, Spearman-correlation, run-variance, or
precise-rank claim. Those stability fields do not exist in the v3 artifact.

The production worker emits one compact `aiq.verifier-record.v2` JSON object to
standard output after each claimed package. The record includes the exact claim
idempotency key and package SHA-256. The recurring orchestrator appends each
non-success record to a private attempt JSONL file. It writes a separate
create-once success receipt only after both identities match the local package.
The offline `verify-local` mode instead writes its explicit, create-new stage
and attestation output files and does not publish them.

The worker has bounded claim, lease, retry, polling, and HTTP timeout settings.
It renews an active lease while it processes a package. Package, signature,
provenance, and artifact evidence failures remain controlled terminal
rejections. An evaluator invocation failure acknowledges the claim for retry.

The default gateway request timeout is 120 seconds. It leaves room for the
bounded Official staging transaction and the following attestation and
publication calls to finish in one gateway request.

After replay completes, HTTP 408, 409, 429, and 5xx responses from the
verification gateway retry the same prepared request under the maintained
claim lease. Other HTTP 4xx responses remain terminal. If the bounded retry
budget is exhausted, the worker acknowledges the claim for queue retry.

Candidate replay uses `--replay-jobs 4` by default. Set it from `1` through
`32` to match controlled host capacity. Replay output stays in signed result
order, independent of this setting.

For each completed cell, the verifier executes the committed formal evaluator
exactly once per claim attempt. It compares the parsed result and exact
raw-output digest with the runner observation. Formal evaluator work has no
elapsed deadline. An invocation failure releases the claim for a later attempt.
A first successful replay with different output also releases the claim for one
confirmation attempt. A repeated difference can produce a terminal mismatch.
Every failure blocks verification and publication, preserves the submitted
model evidence, and does not invoke the model.

Before the worker replays an Official claim, it independently verifies the
private calibration admission against the current production reference, build
receipt, source, corpus, evaluator, and runtime identities. It then requires the
Official run to embed that exact frozen bank and bundle digest. Replicate
ceiling, informative-item, and non-uniform-item measurements are non-blocking
drift diagnostics. They never re-fit or gate the released bank. The 17
configurations are correlated, and the reported interval remains conditional on
the frozen item bank.

For each task, facility is the mean task credit across the 17 configurations.
The inclusive facility band is `0.10` through `0.90`. A task is informative
only when it is in this band and its maximum credit minus minimum credit across
the configurations is at least `0.10`. At least 36 of 72 tasks (`0.50`) must be
informative, and at least 36 must meet the non-uniformity limit. Each domain
must contain an informative and a non-uniform task. Its mean facility must also
be from `0.10` through `0.90`.

The range between the lowest and highest 0–100 macro-domain model scores must
be at least 3 points. This is an auxiliary flat-output check, not a target
effect size. It detects near-identical aggregate output without requiring a
wide ranking among correlated configurations. The task-level non-uniformity
and facility checks provide the primary evidence that the fixture can
distinguish ordinary work models.

No more than 10% of tasks can have universal semantic zero credit, and no more
than 10% can have universal full credit. For 72 tasks, this permits at most
seven tasks in each class. This conservative allowance keeps a small number of
very hard or very easy tasks without permitting floor or ceiling saturation.
Universal zeros caused by runtime failure, or by a mix of runtime failure and
semantic rejection, always stop publication. There is no operator override.

The compact `aiq.verifier-record.v2` record includes the exact policy. For a
successful non-synthetic Official verification, or a rejection by this gate,
it also includes the observed task, domain, and model-spread summary. This is
audit evidence only. The check does not change or supersede an existing
published score.

## Verification flow

1. Claim one unverified package from `/api/claims`.
2. Resolve only artifacts bound to that claim.
3. Verify exact package bytes, Ed25519 signatures, JCS hashes, and run bindings.
4. Reconstruct each candidate workspace under the controlled replay root.
5. Execute the committed evaluator once with the committed runtime and compare
   it with the runner observation.
6. Create `aiq.normalized-batch.v4` and
   `aiq.verifier-attestation.v4` evidence.
7. Submit the evidence to `/api/verifications`.

Production attestations require `evaluator_replayed`. The database accepts the
stage and attestation through the verifier role. A separate publisher role
completes publication.

For local contract checks, `--synthetic-demo-tasks` uses the built-in synthetic
72-task set. It is not production evidence.

## Safety

- Keep the verifier token and signing key outside Git.
- Do not give the verifier key to the runner, publisher, browser, or client
  bundle.
- Use a new controlled replay root for each verifier environment.
- Treat package content and replay artifacts as private.
- Treat a local verifier run as evidence for the package only. It does not prove
  deployment readiness.
