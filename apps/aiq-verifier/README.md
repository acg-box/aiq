# AIQ verifier

`aiq-verifier` is a bounded worker for queued v3 result packages. It claims one
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

Show the complete CLI contract:

```sh
cargo run -p aiq-verifier -- --help
```

The worker has bounded claim, lease, retry, polling, and HTTP timeout settings.
It renews an active lease while it processes a package and records a controlled
rejection when validation cannot continue.

## Verification flow

1. Claim one unverified package from `/api/claims`.
2. Resolve only artifacts bound to that claim.
3. Verify exact package bytes, Ed25519 signatures, JCS hashes, and run bindings.
4. Reconstruct each candidate workspace under the controlled replay root.
5. Replay the committed evaluator with the committed runtime.
6. Create `aiq.normalized-batch.v3` and
   `aiq.verifier-attestation.v3` evidence.
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
