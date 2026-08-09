# AIQ verifier

`aiq-verifier` is a bounded worker for queued v4 result packages. It claims one
or more packages through the Web gateway, downloads exact private artifacts,
reconstructs candidate workspaces, replays deterministic evaluators, and submits
a signed verifier attestation.

## Required inputs

Production use requires:

- the Web deployment origin;
- the 72 private controlled tasks;
- verifier-owned environment metadata;
- the committed evaluator registry and Node.js runtime;
- the current corpus commitment and controlled toolchain root;
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

Show the production worker contract and the two model-free local modes:

```sh
cargo run -p aiq-verifier -- --help
cargo run -p aiq-verifier -- validate-environment --help
cargo run -p aiq-verifier -- verify-local --help
```

The production worker emits one compact `aiq.verifier-record.v2` JSON object to
standard output after each claimed package. If the operator retains those
objects in a create-once private JSONL file, the operator shell owns that
redirection. The offline `verify-local` mode instead writes its explicit,
create-new stage and attestation output files and does not publish them.

The worker has bounded claim, lease, retry, polling, and HTTP timeout settings.
It renews an active lease while it processes a package and records a controlled
rejection when validation cannot continue.

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
5. Replay the committed evaluator with the committed runtime.
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
