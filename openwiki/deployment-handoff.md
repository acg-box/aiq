---
type: 'Handoff'
title: 'Deployment Handoff'
description: 'Personal Supabase, Vercel, and Cloudflare handoff, native publication topology, and pending release work.'
tags: ['deployment', 'handoff', 'supabase', 'vercel']
---

# Deployment Handoff

AIQ production has current live evidence for the first Official publication.
Use this handoff to preserve that accepted topology and to track the remaining
operational work. Do not infer future schedules, workers, or later publications
from the first launch evidence.

Live production remains the historical AIQ Core `1.0.2` matrix described below.
Repository source now has the active public AIQ Core `1.0.5` candidate. Its
public metadata digest is
`sha256:c575726d933ee4c0b47f7855f9d1aa820188109910e2a3b0288f10a4026b8edb`,
and its public release digest is
`sha256:27106267689a62a351fd83266b8dcdfaa68f876202075dcde1387ae543804add`.
Controlled identities, final calibration, final native build verification, a
real Official run, publication, and final deployment are pending. Do not treat
the source-head change as a deployment claim.

The `1.0.3` Official attempt was interrupted after an already-conclusive
ceiling failure. It is rejected, unpublished calibration evidence. No hidden
responses or hidden task details were published. The first `1.0.4` calibration
completed all 1,224 cells but failed the statistical release gate. It remains
non-Official evidence and must not be described as 1,224 failed executions. The
`1.0.5` path first runs a 17-by-4 pilot over the four revised tasks, then the full
falsification-first non-Official 17-by-72 calibration. A failed release gate has
no operator override. Real calibration remains permanently non-Official even
after signed verifier admission and distinct publication to its public register.

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

This is one greenfield AIQ Core `1.0.2` state. The first publication is one
complete `17 × 72 = 1,224` task-level result Official matrix, not 1,224 separate
benchmark runs. The native macOS runner completed it, the native verifier
replayed it, and the distinct publisher published it as `trusted_verified`.
Of the results, 1,218 completed and 6 failed: 329 `correct`, 259 `partial`, 630
`incorrect`, 5 `timeout`, and 1 `budget_exhausted`. Signed wall time is
5,844,411 ms (`1:37:24.411`).

Cost coverage is 1,208 `estimated`, 10 `unavailable_context_band`, and 6
`unavailable_missing_usage`. The $125.403257240 priced subtotal is a Standard
API-equivalent estimate for the 1,208 priced results, not actual ChatGPT
subscription spend or a complete matrix total. Missing cost values are not zero.
Public views expose 17 runs, 1,224 results, and 17 rows each for the leaderboard,
model-efficiency, and model-matrix projections. Publication created 4,395
artifact bindings, including 19 capability artifacts. The interpretation of
these public-safe measures belongs to [Benchmark Method](benchmark-method.md).

The first Official launch publication was deployed from merge commit
`725b88954359ab8f0950f896674b3e8684d3ae85`. This commit is historical launch
evidence, not the identity of every later production deployment. To read the
current source commit, open Vercel project `acgbox/aiq`, select the deployment
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
| Final build | Private receipt: commit, tree, runner, verifier, Node.js, and ripgrep hashes  |
| Database    | Source commit, `databases/schema.sql` SHA-256, and initialization receipt     |
| Vercel      | Deployment ID, source commit, project, scope, and production origin           |
| Domain      | Vercel domain state, Cloudflare DNS records, TLS, and redirect behavior       |
| Publication | Run ID, 1,224 result count, verifier attestation, and publication receipt     |

Private task content, credentials, signing seeds, access tokens, and service
keys must stay outside Git and public evidence.

The operator generates the private, unsigned final-build audit receipt from the
final clean build. Retain it with the private release records under the existing
access and retention controls. Keep it outside Git and public evidence. Do not
use it as a product protocol or database input. The repository does not validate
the receipt.

## Supabase setup

The personal organization `ACG Box` hosts project `aiq` on PostgreSQL 17.6.
Initialize AIQ Core `1.0.5` in this existing target project after its AIQ
namespace is empty. If residue exists, remove only `aiq_private`, the AIQ-owned
roles, and the exact AIQ-owned public views and RPC overloads. Preserve all
Supabase-managed and non-AIQ objects. This cleanup is a deployment prerequisite,
not a migration or compatibility path. There is no migration chain. Do not load
synthetic fixtures into this project.

1. Confirm the standard `anon`, `authenticated`, `authenticator`, and
   `service_role` roles exist.
2. Prepare one private production-reference
   document. Bind the 72-task AIQ Core `1.0.5` corpus, current catalog identities,
   and distinct runner, verifier, and publisher
   public identities.
3. Apply the desired state once through a direct PostgreSQL connection. The
   schema creates both AIQ Storage buckets and sets them to private:

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE='/controlled/production-reference.json' \
cargo make init-database
```

The initializer must be the first AIQ database action. It uses one transaction
and rejects existing AIQ objects. Confirm that the receipt reports scoring
`1.0.5`, 72 tasks, 17 model configurations, three distinct identities, and the
expected public-view inventory.

Run the database checks:

```sh
cargo make check-database
AIQ_DATABASE_URL='<direct-connection-url>' cargo make smoke-database
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
npm run check
npm run lint
npm test
npm run build
npm run test:browser --workspace @aiq/web
```

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
After the final clean build, generate the private, unsigned audit receipt. Record
the exact source commit and tree identity and SHA-256 values for the native
runner, verifier, Node.js, and ripgrep executables. This receipt is private
reproducibility evidence only. The executable product contracts are the
source-only corpus rule and the signed per-run provenance for the actual runner
and Codex executables.

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

- [x] Historical launch commit `725b88954359ab8f0950f896674b3e8684d3ae85`,
      its controlled corpus, native binaries, and capability evidence bind the
      published AIQ Core `1.0.2` contract.
- [x] Historical production Supabase state was initialized from
      `databases/schema.sql` at that immutable launch commit, with SHA-256
      `a57ad5490f92391541c985cc0cc1551e5c960aa6c013cd68f4aea291a7f6c00c`;
      both production Storage buckets are private.
- [x] Vercel project `acgbox/aiq` serves the accepted deployment without exposing
      server-only values to the browser.
- [x] Runner, verifier, and publisher identities are distinct.
- [x] One complete non-synthetic 17-by-72 matrix contains 1,224 terminal results,
      including 1,218 completed and 6 failed results.
- [x] The native verifier reconstructed and replayed the matrix, and the distinct
      publisher published it as `trusted_verified`.
- [x] `aiq.wiki` resolves with valid TLS; `www.aiq.wiki` redirects permanently
      while preserving paths.
- [x] The read-only production acceptance gate passed for the historical
      acceptance deployment recorded below. Rerun it after each future
      publication or deployment change.
- [ ] Regenerate and audit the final AIQ Core `1.0.5` corpus from the final clean
      source commit, then build and hash the native runner and verifier.
- [ ] Empty only the AIQ-owned namespace and initialize the new desired state
      once from the final AIQ Core `1.0.5` `databases/schema.sql`; do not apply a
      migration chain.
- [ ] Complete the 17-by-4 targeted pilot and the required full non-Official
      calibration. Then run, replay, verify, and publish one real 17-by-72 AIQ
      Core `1.0.5` matrix;
      then deploy that exact source and pass the identity-bound production gate.
- [ ] Provision the separately owned twice-daily benchmark schedule and record its
      next run without changing the accepted execution contract.

## Production acceptance evidence

On 2026-08-04, the bounded, secret-free production acceptance gate passed all
7 tests against Vercel deployment `dpl_CeNkm4rGR8UaRkqQBdPZAyBmWgg2`. That
deployment used source commit
`29f5fc8d8576d95b6fa00fc8f7c943cfc2e4290d`. That earlier release used the
release-bound values that were current at that time. Every new acceptance run
must supply the exact identity from the accepted result package and verifier
attestation. The command shape is:

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

The result was 7 of 7 tests passed. This is historical acceptance evidence. It
does not identify every later deployment and does not create a benchmark,
Storage, or OpenWiki schedule. Rerun the command after each future publication
or production deployment change. The gate rejects missing, malformed, zero, or
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
revised. For a local contract check without a production read, run
`npm run test:browser:production-contract --workspace @aiq/web`. These checks
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
