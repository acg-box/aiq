---
type: 'Handoff'
title: 'Deployment Handoff'
description: 'Personal Supabase, Vercel, and Cloudflare handoff, native publication topology, and pending release work.'
tags: ['deployment', 'handoff', 'supabase', 'vercel']
---

# Deployment Handoff

Use this handoff to create the first accepted AIQ 2.0 production publication
and to track the remaining operational work. Do not infer future schedules,
workers, or later publications from this release plan.

Repository source has the active public AIQ Core `1.0.7` candidate. Its
public metadata digest is
`sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1`,
and its public release digest is
`sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae`.
The public catalog is deterministic and identity-frozen. The prior controlled
tree and database commitment bind the retired bounded policy. Fresh independent
Core and Contrast sealing, policy-v2 replay of the retained complete calibration,
fixed-bank admission v3, final native build verification, a separate real
Official run, publication, and final deployment are pending. The only production
tuple is AIQ Core `1.0.7`, task scorer `1.0.6`, aggregate scorer `1.0.8`, and
measurement `2.0.0`. Do not treat the source-head change as a deployment claim.

All 72 formal model tasks have null wall-time, step, and tool-call limits. Time,
steps, tool calls, tokens, and cost remain auxiliary evidence only. Earlier
bounded runs remain immutable failed release evidence. A failed release gate has
no operator override. Real calibration remains permanently non-Official even
after signed verifier admission and distinct publication to its public register.

## AIQ 2.0 cutover

The new real `1.0.7` 17-by-72 matrix is the only source for the Official
publication. Do not preserve online, migrate, recompute, relabel, or display a
legacy matrix as production evidence. It is not a fallback.

The order below is intentional:

1. Replay the retained complete 1.0.7 calibration package without model calls.
   Derive and sign the policy-v2 fixed bank and admission v3. Only after this
   gate passes, execute the controlled 17-by-72 Official run, score it with AIQ
   measurement `2.0.0`, and create one signed result package. Keep the package
   and all private inputs outside Git.
2. Before changing production, run the real native verifier against that exact
   package. The verifier must exit successfully and create a new normalized
   stage and verifier attestation while consuming the approved calibration
   admission v3. A submission queue receipt, a synthetic fixture, or a
   hand-written JSON summary is not evidence of this gate.
3. An ordinary provider backup is optional. It is not a reset manifest,
   migration input, compatibility source, publication gate, or reason to delay
   the reset.
4. During one short window, run the read-only reset inventory and then the
   one-shot greenfield reset/init. The reset code intentionally has no
   `AIQ_PRE_RESET_EVIDENCE_ARCHIVE` variable or self-reported archive manifest.
   It only validates the current schema and production reference before it
   removes the AIQ-owned namespace and Storage buckets.
5. Submit the already verified new package to the fresh database, run the
   controlled verifier through the gateway, and publish through the distinct
   publisher identity. Do not load `databases/synthetic-demo.sql`.
6. Run `cargo make check-aiq-2-cutover`. Deploy the new Web only if it passes.
   Otherwise keep the new state unpublished. Do not fall back to a legacy
   publication.

### Calibration admission gate

This command replays the retained signed calibration package and all 1,224
deterministic evaluators. It does not call a model. The replay inputs keep their
original package, corpus, environment, and artifact identities. The admission
inputs bind the final current source, corpus, binaries, and production authority.

```sh
set -eu
: "${AIQ_VERIFIER_SIGNING_KEY:?load the protected production verifier key}"
: "${AIQ_PRODUCTION_REFERENCE:?set the final production-reference.json path}"

AIQ_CALIBRATION_PACKAGE='/controlled/aiq-2/calibration/result-package.json'
AIQ_CALIBRATION_ARTIFACT_ROOT='/controlled/aiq-2/calibration/artifacts'
AIQ_CALIBRATION_TASKS='/controlled/aiq-2/calibration/corpus/tasks'
AIQ_CALIBRATION_ENVIRONMENT='/controlled/aiq-2/calibration/verifier-environment.json'
AIQ_CALIBRATION_EVALUATOR_ROOT='/controlled/aiq-2/calibration/corpus/evaluator'
AIQ_CALIBRATION_CORPUS='/controlled/aiq-2/calibration/corpus/commitment.json'
AIQ_CALIBRATION_RUNTIME='/controlled/aiq-2/calibration/corpus/toolchain/node'
AIQ_CALIBRATION_TOOLCHAIN='/controlled/aiq-2/calibration/corpus/toolchain'
AIQ_CALIBRATION_REPLAY_ROOT='/controlled/aiq-2/calibration/policy-v2-replay'

AIQ_FINAL_TASKS='/controlled/aiq-2/final-corpus/tasks'
AIQ_FINAL_ENVIRONMENT='/controlled/aiq-2/final-admission-environment.json'
AIQ_FINAL_EVALUATOR_ROOT='/controlled/aiq-2/final-corpus/evaluator'
AIQ_FINAL_CORPUS='/controlled/aiq-2/final-corpus/commitment.json'
AIQ_FINAL_RUNTIME='/controlled/aiq-2/final-corpus/toolchain/node'
AIQ_FINAL_TOOLCHAIN='/controlled/aiq-2/final-corpus/toolchain'
AIQ_FINAL_SOURCE_ROOT='/controlled/aiq-2/final-detached-source'
AIQ_FINAL_SOURCE_COMMIT='<40-character-final-source-commit>'
AIQ_FINAL_SOURCE_TREE='<40-character-final-source-tree>'
AIQ_FINAL_RUNNER='/controlled/aiq-2/bin/aiq-runner'
AIQ_FINAL_VERIFIER='/controlled/aiq-2/bin/aiq-verifier'
AIQ_FINAL_CODEX='/controlled/aiq-2/codex-runtime/codex'
AIQ_FINAL_BUILD_RECEIPT='/controlled/aiq-2/final-build-receipt.json'
AIQ_FINAL_REFERENCE_SHA256='<sha256-of-production-reference-file>'
AIQ_FINAL_BUILD_RECEIPT_SHA256='<sha256-of-final-build-receipt-file>'
AIQ_CALIBRATION_STAGE='/controlled/aiq-2/calibration/policy-v2-stage.json'
AIQ_CALIBRATION_ATTESTATION='/controlled/aiq-2/calibration/policy-v2-attestation.json'
AIQ_CALIBRATION_ADMISSION='/controlled/aiq-2/calibration-admission-v3.json'

test "$(git -C "$AIQ_FINAL_SOURCE_ROOT" rev-parse HEAD)" = "$AIQ_FINAL_SOURCE_COMMIT"
test "$(git -C "$AIQ_FINAL_SOURCE_ROOT" rev-parse HEAD^{tree})" = "$AIQ_FINAL_SOURCE_TREE"
test -z "$(git -C "$AIQ_FINAL_SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)"
! git -C "$AIQ_FINAL_SOURCE_ROOT" symbolic-ref -q HEAD

"$AIQ_FINAL_VERIFIER" verify-local \
  --package "$AIQ_CALIBRATION_PACKAGE" \
  --artifact-root "$AIQ_CALIBRATION_ARTIFACT_ROOT" \
  --tasks "$AIQ_CALIBRATION_TASKS" \
  --environment "$AIQ_CALIBRATION_ENVIRONMENT" \
  --evaluator-root "$AIQ_CALIBRATION_EVALUATOR_ROOT" \
  --corpus-commitment "$AIQ_CALIBRATION_CORPUS" \
  --evaluator-runtime "$AIQ_CALIBRATION_RUNTIME" \
  --codex-toolchain-root "$AIQ_CALIBRATION_TOOLCHAIN" \
  --replay-root "$AIQ_CALIBRATION_REPLAY_ROOT" \
  --replay-jobs 32 \
  --signing-key-env AIQ_VERIFIER_SIGNING_KEY \
  --observed-unix-ms "$(date +%s000)" \
  --stage-output "$AIQ_CALIBRATION_STAGE" \
  --attestation-output "$AIQ_CALIBRATION_ATTESTATION" \
  --calibration-source-1-0-7 \
  --admission-output "$AIQ_CALIBRATION_ADMISSION" \
  --admission-tasks "$AIQ_FINAL_TASKS" \
  --admission-environment "$AIQ_FINAL_ENVIRONMENT" \
  --admission-evaluator-root "$AIQ_FINAL_EVALUATOR_ROOT" \
  --admission-corpus-commitment "$AIQ_FINAL_CORPUS" \
  --admission-evaluator-runtime "$AIQ_FINAL_RUNTIME" \
  --admission-codex-toolchain-root "$AIQ_FINAL_TOOLCHAIN" \
  --admission-source-root "$AIQ_FINAL_SOURCE_ROOT" \
  --admission-runner-binary "$AIQ_FINAL_RUNNER" \
  --admission-codex-binary "$AIQ_FINAL_CODEX" \
  --production-reference "$AIQ_PRODUCTION_REFERENCE" \
  --expected-production-reference-sha256 "$AIQ_FINAL_REFERENCE_SHA256" \
  --build-receipt "$AIQ_FINAL_BUILD_RECEIPT" \
  --expected-build-receipt-sha256 "$AIQ_FINAL_BUILD_RECEIPT_SHA256"

test -s "$AIQ_CALIBRATION_STAGE"
test -s "$AIQ_CALIBRATION_ATTESTATION"
test -s "$AIQ_CALIBRATION_ADMISSION"
```

All three outputs and the replay root must be fresh. Do not reuse a failed output
path. `AIQ_FINAL_SOURCE_ROOT` must be a clean detached Git worktree, not the
corpus `source-snapshot` directory. The signing key value is never written to an
artifact. The verifier signs and then self-verifies admission v3 before it
installs any output.

### Offline Official package gate

Use the canonical verifier, not a second TypeScript implementation of package
cryptography. Set the following paths to the exact artifacts from the new run:

```sh
set -eu
: "${AIQ_PRODUCTION_REFERENCE:?set the current controlled production-reference.json path}"
AIQ_2_PACKAGE='/controlled/aiq-2/official-result-package.json'
AIQ_2_ARTIFACT_ROOT='/controlled/aiq-2/artifacts'
AIQ_2_TASKS='/controlled/aiq-2/tasks'
AIQ_2_VERIFIER_ENVIRONMENT='/controlled/aiq-2/verifier-environment.json'
AIQ_2_EVALUATOR_ROOT='/controlled/aiq-2/evaluators'
AIQ_2_CORPUS_COMMITMENT='/controlled/aiq-2/aiq-core-1.0.7-commitment.json'
AIQ_2_EVALUATOR_RUNTIME='/controlled/toolchain/node'
AIQ_2_CODEX_TOOLCHAIN_ROOT='/controlled/toolchain'
AIQ_2_REPLAY_ROOT='/controlled/aiq-2/replay'
AIQ_2_SOURCE_ROOT='/controlled/aiq-2/source'
AIQ_2_RUNNER_BINARY='/controlled/aiq-2/bin/aiq-runner'
AIQ_2_CODEX_BINARY='/controlled/aiq-2/codex-runtime/codex'
AIQ_2_BUILD_RECEIPT='/controlled/aiq-2/final-build-receipt.json'
AIQ_2_STAGE_OUTPUT='/controlled/aiq-2/verified-stage.json'
AIQ_2_ATTESTATION_OUTPUT='/controlled/aiq-2/verifier-attestation.json'
AIQ_2_CALIBRATION_ADMISSION='/controlled/aiq-2/calibration-admission-v3.json'
AIQ_2_PRODUCTION_REFERENCE_SHA256='<sha256-of-production-reference-file>'
AIQ_2_BUILD_RECEIPT_SHA256='<sha256-of-final-build-receipt-file>'

target/release/aiq-verifier verify-local \
  --package "$AIQ_2_PACKAGE" \
  --artifact-root "$AIQ_2_ARTIFACT_ROOT" \
  --tasks "$AIQ_2_TASKS" \
  --environment "$AIQ_2_VERIFIER_ENVIRONMENT" \
  --evaluator-root "$AIQ_2_EVALUATOR_ROOT" \
  --corpus-commitment "$AIQ_2_CORPUS_COMMITMENT" \
  --evaluator-runtime "$AIQ_2_EVALUATOR_RUNTIME" \
  --codex-toolchain-root "$AIQ_2_CODEX_TOOLCHAIN_ROOT" \
  --replay-root "$AIQ_2_REPLAY_ROOT" \
  --replay-jobs 4 \
  --observed-unix-ms "$(date +%s000)" \
  --stage-output "$AIQ_2_STAGE_OUTPUT" \
  --attestation-output "$AIQ_2_ATTESTATION_OUTPUT" \
  --calibration-admission "$AIQ_2_CALIBRATION_ADMISSION" \
  --admission-tasks "$AIQ_2_TASKS" \
  --admission-environment "$AIQ_2_VERIFIER_ENVIRONMENT" \
  --admission-evaluator-root "$AIQ_2_EVALUATOR_ROOT" \
  --admission-corpus-commitment "$AIQ_2_CORPUS_COMMITMENT" \
  --admission-evaluator-runtime "$AIQ_2_EVALUATOR_RUNTIME" \
  --admission-codex-toolchain-root "$AIQ_2_CODEX_TOOLCHAIN_ROOT" \
  --admission-source-root "$AIQ_2_SOURCE_ROOT" \
  --admission-runner-binary "$AIQ_2_RUNNER_BINARY" \
  --admission-codex-binary "$AIQ_2_CODEX_BINARY" \
  --production-reference "$AIQ_PRODUCTION_REFERENCE" \
  --expected-production-reference-sha256 "$AIQ_2_PRODUCTION_REFERENCE_SHA256" \
  --build-receipt "$AIQ_2_BUILD_RECEIPT" \
  --expected-build-receipt-sha256 "$AIQ_2_BUILD_RECEIPT_SHA256"

test -s "$AIQ_2_STAGE_OUTPUT"
test -s "$AIQ_2_ATTESTATION_OUTPUT"
test -s "$AIQ_2_CALIBRATION_ADMISSION"
```

`--admission-codex-binary` identifies the main file in the exact two-file runtime
directory. The verifier derives and hashes the sibling `codex-code-mode-host`;
the signed provenance, verifier environment, final-build receipt, and actual
files must all agree. The same native replay also resolves the signed
`capability-marker.txt` artifact for every available capability probe and
rejects missing, altered, or failure-associated marker evidence.
Before replay starts, the verifier independently validates the calibration
admission signature, current issuance bindings, complete frozen bank, bundle
digest, and the bank embedded in the Official package. It does not re-fit the
bank from the Official replicate.

The live verifier and publisher must still process this package after the fresh
database is initialized. The offline output proves the package and replay
inputs; it does not itself publish rows.

### Optional provider backup

An ordinary provider backup is fully optional. `reset.ts` does not consume it,
and it does not affect reset authorization or timing. Do not use a backup as a
reset manifest, migration input, compatibility source, or publication gate.

### Post-publication gate

After publication, run this read-only query gate against the new database:

```sh
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' cargo make check-aiq-2-cutover
```

It fails unless the database contains exactly one published, non-synthetic
`1.0.7` matrix, 17 published runs, 17 Official scores, 1,224 task results, one
calibration digest, zero synthetic Official scores, and exactly 17 public
Official leaderboard rows with zero synthetic rows. It also checks measurement
`2.0.0` and method `rasch_fractional_fixed_bank_map_v2`. This is the release gate
with database evidence; it is not a migration framework.

## First-release topology

The accepted first release uses these exact surfaces:

| Surface              | Accepted target                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Database and Storage | Personal Supabase organization `ACG Box`, project `aiq`, reference `xxnszykaeapolqdnhalx`, PostgreSQL 17.6 |
| Web and gateway      | Personal Vercel scope `acgbox`, project `aiq`                                                              |
| DNS                  | Personal Cloudflare account that owns the `aiq.wiki` zone; never a company team account                    |
| Public origin        | `https://aiq.wiki`                                                                                         |
| Runner               | Native Apple Silicon macOS `aiq-runner` release binary                                                     |
| Verifier             | Native Apple Silicon macOS `aiq-verifier` release binary                                                   |
| Storage              | Private `aiq-submission-packages` and `aiq-runner-artifacts` buckets                                       |

The same macOS host operates the runner and verifier natively in separate
command environments with direct network access. The verifier must not receive
the Codex home or runner signing key. The first release does not depend on or run
Linux or Docker. They remain a future deployment target outside this handoff.

This is one greenfield AIQ Core `1.0.7`, task scorer `1.0.6`, aggregate scorer
`1.0.8`, measurement `2.0.0`
state. The accepted publication is one complete `17 × 72 = 1,224` task-level
result Official matrix, not 1,224 separate benchmark runs. The native macOS
runner creates it, the native verifier replays it, and the distinct publisher
publishes it as `trusted_verified`. The interpretation of its public-safe
measures belongs to [Benchmark Method](benchmark-method.md).

To read the current source commit, open Vercel project `acgbox/aiq`, select the deployment
currently assigned to `aiq.wiki`, and read **Git Source > Commit**. This command
returns the current deployment ID and deployment-specific URL for the same
readback:

```sh
vercel inspect aiq.wiki --scope acgbox --format=json
```

Deploy only from the final clean source worktree. Use the personal scope and
project flags on every command; do not rely on an ambient project link or a
company-team selection. Create the production-target deployment without moving
the domain, inspect it, and run the publication-bound browser gate against its
deployment URL before promotion:

```sh
set -eu
AIQ_SOURCE_ROOT='<absolute-final-clean-worktree>'
test -z "$(git -C "$AIQ_SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)"
AIQ_SOURCE_COMMIT="$(git -C "$AIQ_SOURCE_ROOT" rev-parse HEAD)"
test "$(printf '%s' "$AIQ_SOURCE_COMMIT" | wc -c | tr -d ' ')" -eq 40

vercel link --cwd "$AIQ_SOURCE_ROOT" --scope acgbox --project aiq --yes
vercel deploy "$AIQ_SOURCE_ROOT" \
  --prod \
  --skip-domain \
  --scope acgbox \
  --project aiq \
  --yes \
  --meta "aiqSourceCommit=$AIQ_SOURCE_COMMIT" \
  --format=json

vercel inspect '<deployment-id-or-url>' --scope acgbox --format=json
```

Confirm that the readback identifies scope `acgbox`, project `aiq`, the expected
deployment ID, a ready production target, and deployment metadata
`aiqSourceCommit` equal to the clean source commit. Run the full production
browser command from this page with `AIQ_PRODUCTION_ORIGIN` set to the inspected
deployment URL. Promote only that accepted deployment, then inspect and test the
canonical origin again:

```sh
vercel promote '<accepted-deployment-id-or-url>' --scope acgbox --yes
vercel inspect aiq.wiki --scope acgbox --format=json
```

## Immutable release evidence

Record these values after each action succeeds:

| Surface     | Required evidence                                                             |
| ----------- | ----------------------------------------------------------------------------- |
| Source      | Approved commit and clean worktree status                                     |
| Runner      | Source commit, Mach-O arm64 identity, and executable SHA-256                  |
| Verifier    | Source commit, Mach-O arm64 identity, and executable SHA-256                  |
| Corpus      | Release ID, commitment SHA-256, 72 task count, and evaluator runtime identity |
| Final build | Private receipt: commit, tree, runner, verifier, Codex, and host hashes       |
| Database    | Source commit, `databases/schema.sql` SHA-256, and initialization receipt     |
| Vercel      | Deployment ID, source commit, project, scope, and production origin           |
| Domain      | Vercel domain state, Cloudflare DNS records, TLS, and redirect behavior       |
| Publication | Run ID, 1,224 result count, verifier attestation, and publication receipt     |

Private task content, credentials, signing seeds, access tokens, and service
keys must stay outside Git and public evidence.

The operator generates the private, unsigned `aiq.final-build-receipt.v2` from
the final clean build. It contains the exact source commit and tree plus the
SHA-256 values for the runner, verifier, Codex executable, and Codex code-mode
host. Retain it with the private release records under the existing access and
retention controls. Keep it outside Git and public evidence. The offline native
verifier validates it against the independently supplied receipt digest. Do not
use it as a database input.

## Supabase setup

The personal organization `ACG Box` hosts project `aiq` on PostgreSQL 17.6.
Initialize AIQ Core `1.0.7` in this existing target project after its AIQ
namespace is empty. If residue exists, remove only `aiq_private`, the AIQ-owned
roles, and the exact AIQ-owned public views and RPC overloads. Preserve all
Supabase-managed and non-AIQ objects. This cleanup is a deployment prerequisite,
not a migration or compatibility path. There is no migration chain. Do not load
synthetic fixtures into this project.

1. Confirm the standard `anon`, `authenticated`, `authenticator`, and
   `service_role` roles exist.
2. Prepare one private production-reference
   document. Bind the 72-task AIQ Core `1.0.7` corpus, current catalog identities,
   and distinct runner, verifier, and publisher
   public identities.
3. Apply the desired state once through the exact direct or port-5432 session
   pooler PostgreSQL identity. The schema creates both AIQ Storage buckets and
   sets them to private:

```sh
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' \
AIQ_PRODUCTION_REFERENCE='/controlled/production-reference.json' \
cargo make init-database
```

The initializer must be the first AIQ database action. It uses one transaction
and rejects existing AIQ objects. Confirm that the receipt reports scoring
`1.0.7`, 72 tasks, 17 model configurations, three distinct identities, and the
expected public-view inventory.

Run the database checks:

```sh
cargo make check-database
AIQ_DATABASE_URL='<direct-or-session-pooler-url>' cargo make smoke-database
```

Do not load `databases/synthetic-demo.sql` into production.

## Vercel setup

The personal Vercel scope `acgbox` hosts project `aiq` and its accepted
production deployment at `https://aiq.wiki`. Preserve the browser-safe and
server-only configuration boundary when rotating values or replacing the
deployment.

Configure browser-safe values:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

Configure server-only values:

```text
SUPABASE_URL
SUPABASE_SECRET_KEY
AIQ_RUNNER_SUBMISSION_TOKEN
AIQ_SUBMISSION_PACKAGE_BUCKET
AIQ_RUNNER_ARTIFACT_BUCKET
AIQ_VERIFIER_INGRESS_TOKEN
AIQ_SUPABASE_PUBLISHABLE_KEY
AIQ_SUPABASE_JWT_PRIVATE_JWK
AIQ_PUBLISHER_NODE_ID
```

The ES256 private JWK must match the Supabase project signing key. Keep it only
in the server environment. Never expose a Supabase secret or service-role value
to the browser.

Before deployment, run:

```sh
cargo make verify
```

This is the complete local gate. It builds Web once and includes the local
production browser contract. Do not repeat its component commands in the same
pass.

Also run the real public-read smoke against a disposable PostgreSQL 17 and
PostgREST stack:

```sh
AIQ_LIVE_POSTGREST_URL='http://127.0.0.1:4178' \
cargo make smoke-live-web
```

## Native runner setup

Build the native release binaries from the approved clean commit:

```sh
cargo build --locked --release --package aiq-runner --package aiq-verifier
file target/release/aiq-runner target/release/aiq-verifier
shasum -a 256 target/release/aiq-runner target/release/aiq-verifier
```

Both binaries must be distinct Mach-O arm64 executables. Prepare separate,
canonical roots for source, private tasks, baselines, execution workspaces,
evaluators, artifacts, checkpoints, preflight output, verifier replay, and
private records.

Make a separate copy of the current Codex authentication home. Set the copied
`auth.json` to mode `0600` and owner immutable with `chflags uchg`. Do not change
the active Codex profile:

```sh
AIQ_RELEASE_CODEX_HOME='/absolute/private/aiq-codex-home'
mkdir -m 0700 "$AIQ_RELEASE_CODEX_HOME"
cp ~/.codex/auth.json "$AIQ_RELEASE_CODEX_HOME/auth.json"
chmod 0600 "$AIQ_RELEASE_CODEX_HOME/auth.json"
chflags uchg "$AIQ_RELEASE_CODEX_HOME/auth.json"
```

Pass `--codex-home "$AIQ_RELEASE_CODEX_HOME"` to `admit-permissions`, `preflight`,
and `run`. The runner clears the inherited environment and injects that exact
directory as the Codex subprocess `CODEX_HOME`. Keep each corpus runner subtree
source-only with a null built-binary digest, and keep the Node.js and ripgrep
identities in the corpus.
Create a private Codex runtime directory with exactly two files copied from the
current ChatGPT app runtime:

```sh
AIQ_CHATGPT_RESOURCES='/Applications/ChatGPT.app/Contents/Resources'
AIQ_2_CODEX_RUNTIME='/controlled/aiq-2/codex-runtime'
mkdir -m 0700 "$AIQ_2_CODEX_RUNTIME"
install -m 0700 "$AIQ_CHATGPT_RESOURCES/codex" "$AIQ_2_CODEX_RUNTIME/codex"
install -m 0700 "$AIQ_CHATGPT_RESOURCES/codex-code-mode-host" \
  "$AIQ_2_CODEX_RUNTIME/codex-code-mode-host"
test "$(find "$AIQ_2_CODEX_RUNTIME" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 2
```

After the final clean build, generate the private, unsigned
`aiq.final-build-receipt.v2`. Record the exact source commit and tree identity
and SHA-256 values for the native runner, verifier, Codex executable, and Codex
code-mode host. The offline native verifier validates the receipt against its
independently supplied digest. This receipt is private reproducibility evidence,
not a database input or public artifact. Node.js and ripgrep identities remain
bound by the corpus. The executable product contracts are the source-only corpus
rule and the signed per-run provenance for the actual runner and both Codex
runtime executables.

Use CLI help as the exact argument authority:

```sh
target/release/aiq-runner validate-core-corpus --help
target/release/aiq-runner validate-contrast-corpus --help
target/release/aiq-runner admit-permissions --help
target/release/aiq-runner preflight --help
target/release/aiq-runner run --help
target/release/aiq-runner score --help
target/release/aiq-runner package --help
target/release/aiq-runner submit --help
```

Run both model-free corpus validators before `admit-permissions`. The shared
Rust validator now fails closed unless the Core and Contrast runner subtrees use
`identity_kind: source_only` with a null `built_binary_sha256`. The checked Core
JSON schema enforces the same rule. Contrast has equivalent shared typed
enforcement even though it has no separate checked-in JSON schema. Pass the same
private admission receipt to preflight, run, score, and package. Use the host's
direct Codex connection. Keep the checkpoint, artifacts, run reservation, and
preflight cache after interruption. Resume only the unchanged run.

Expose the runner signing key only to `package`. Expose the submission token
only to `submit`. Do not place either value in command output or persistent
logs.

## Native verifier and publication

After submission, run `aiq-verifier` natively with its own token, signing key,
environment metadata, private tasks, evaluator registry, corpus commitment,
toolchain, and fresh replay root:

```sh
target/release/aiq-verifier --help
```

Use bounded replay parallelism for new claims. The default is four workers. Set
it explicitly when release evidence must record the selected value:

```sh
target/release/aiq-verifier --replay-jobs 4 ...
```

The verifier claims one bounded lease, reconstructs submitted workspaces,
replays deterministic evaluators, and sends the normalized stage and signed
attestation to the gateway. Production requires `evaluator_replayed`. A distinct
publisher identity completes publication. A queue receipt alone is not a
published result.

## Domain and DNS

`aiq.wiki` is attached to the personal Vercel project `aiq` with valid TLS and
is the canonical production origin. `www.aiq.wiki` preserves the request path
and returns a permanent `308` redirect to the apex. Automatic Vercel project and
branch aliases can be removed only transiently because a later deployment can
recreate or reassign them. A deployment-specific URL is intrinsic to its
retained deployment. The current generated Vercel surfaces emit `noindex`.

Operate DNS only from the personal Cloudflare account that owns the `aiq.wiki`
zone. Before a change, confirm the selected account is personal and record the
public-safe account display name plus the private account and zone identifiers in
the release receipt. Do not select a company team. For the apex and `www` records,
copy the exact type and target that Vercel shows for project `acgbox/aiq` at
deployment time. Keep both records **DNS only** in Cloudflare so Vercel owns TLS
and redirect behavior. Remove or replace only an exact conflicting `aiq.wiki` or
`www.aiq.wiki` record. Record the final type, target, TTL, proxy state, Vercel
domain state, and DNS readback. Do not hard-code a Vercel DNS target in this
runbook because Vercel can assign a project-specific target.

## Storage operations

Run Storage reconciliation before deletion:

```sh
AIQ_STORAGE_LIFECYCLE_MODE=reconcile npm run storage:lifecycle
AIQ_STORAGE_LIFECYCLE_MODE=delete npm run storage:lifecycle
```

Do not run deletion if reconciliation fails or reports unresolved mismatches.

## Launch checklist

- [x] Vercel project `acgbox/aiq`, Supabase project `xxnszykaeapolqdnhalx`, and
      the `aiq.wiki` DNS zone remain the authorized production targets.
- [x] Runner, verifier, and publisher identities are distinct.
- [x] `aiq.wiki` resolves with valid TLS; `www.aiq.wiki` redirects permanently
      while preserving paths.
- [ ] Regenerate and audit the final AIQ Core `1.0.7` corpus from the final clean
      source commit, then build and hash the native runner and verifier.
- [ ] Complete the required full non-Official calibration and fixed-bank
      admission. Stop if any release
      gate fails.
- [ ] Create and successfully offline-verify one new signed AIQ 2.0
      `1.0.7` 17-by-72 package before touching the live database.
- [ ] After the offline verifier gate passes, empty only the AIQ-owned namespace
      and initialize the desired state once from the final AIQ Core `1.0.7`
      `databases/schema.sql`; do not apply a migration chain or provide a
      synthetic archive manifest to reset. An ordinary provider backup is optional
      and does not affect reset authorization.
- [ ] Submit, replay, verify, and publish the already verified real 17-by-72 AIQ
      Core `1.0.7` matrix. Then run `cargo make check-aiq-2-cutover` and deploy
      the exact source only after the count gate passes. Do not use a legacy
      publication as fallback.
- [ ] Provision the separately owned twice-daily benchmark schedule and record its
      next run without changing the accepted execution contract.

## Production acceptance evidence

After the greenfield publication, run the bounded, secret-free production
acceptance gate with the exact identity from the accepted result package and
verifier attestation. The command shape is:

```sh
AIQ_PRODUCTION_ORIGIN='https://aiq.wiki' \
AIQ_PRODUCTION_EXPECTED_BENCHMARK_VERSION='<benchmark-version>' \
AIQ_PRODUCTION_EXPECTED_SCORING_VERSION='<scoring-version>' \
AIQ_PRODUCTION_EXPECTED_MATRIX_BATCH_ID='<run_sha256-id>' \
AIQ_PRODUCTION_EXPECTED_RUNNER_COMMIT='<git-commit>' \
AIQ_PRODUCTION_EXPECTED_CORPUS_RELEASE_ID='<corpus-release-id>' \
AIQ_PRODUCTION_EXPECTED_CORPUS_COMMITMENT='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_CATALOG_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_TASK_SET_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_PROMPT_SET_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_ESTIMATED_COST_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_CONTEXT_BAND_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_MISSING_USAGE_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_PRICED_COST_SUBTOTAL_USD_NANOS='<integer-nanodollars>' \
npm run test:browser:production --workspace @aiq/web
```

Require all tests to pass. The gate does not create a benchmark, Storage, or
OpenWiki schedule. Rerun the command after each future publication or production
deployment change. The gate rejects missing, malformed, zero, or
version-incoherent expected identities before it contacts production. It binds
the accepted publication to the exact signed matrix batch and runner commit.
It also binds the cost-status distribution and priced nanodollar subtotal.
This prevents an old release expectation from silently accepting a new
publication. Verify the Vercel deployment ID and deployed web source commit
separately through the project-bound deployment readback; they are
web-deployment evidence, not result-package fields.

Page-initiated non-read requests are blocked. The gate also sends intentional
unauthenticated POST probes to five write routes and requires uncached `401`
responses with no public side effects. It covers public pages, exact matrix
counts, evidence semantics, readiness, write rejection, mobile layout, and
selected accessibility rules. It expects exactly one 17-by-72 Official matrix
and fails if later runs exist until the release contract is deliberately
revised. The local contract check is included in `cargo make verify`. Run
`npm run test:browser:production-contract --workspace @aiq/web` only to diagnose
that suite. These checks
validate the accepted public surface described in
[Operations and Validation](operations.md); they do not schedule future work.

If greenfield initialization fails, confirm that its transaction rolled back and
that the AIQ namespace is empty before retrying. If AIQ objects remain, remove
only the exact AIQ-owned objects and preserve all Supabase-managed and non-AIQ
objects before retrying the existing target project.

The project-bound Vercel commands above perform deployment only when an operator
runs them. They do not create recurring automation. No cloud runner or verifier
worker and no benchmark or Storage schedule currently exist. The twice-daily
benchmark schedule and its next run remain pending operator work; this
documentation does not authorize recurring automation.
