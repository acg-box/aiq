# Database authority

This directory remains the sole SQL authority. The initial retained research
studies use reviewed, checked-in public snapshots and content-addressed files;
they do not read Core views or change this database. Do not run the destructive
initializer to publish study pages. A later query or upload workflow can add
study metadata and Storage objects here through a reviewed additive transition.
The fixed Core matrix and publication constraints below apply to Core data.

## Production connection

Use Session Pooler for all production PostgreSQL commands. Personal Infisical
`prod:/aiq/SUPABASE_DATABASE_URL` owns the complete connection URL. Inject it as
`AIQ_DATABASE_URL` into the database command. Do not copy it into the repository,
shell history, or web application settings.

| Setting         | Value                                    |
| --------------- | ---------------------------------------- |
| Host            | `aws-0-ca-central-1.pooler.supabase.com` |
| Port            | `5432`                                   |
| Database        | `postgres`                               |
| Connection user | `postgres.xxnszykaeapolqdnhalx`          |
| TLS             | `sslmode=require`                        |

The initializer, reset command, SQL command wrapper, and cutover check accept
only this production target. They reject direct-host URLs and transaction mode
on port `6543`. The SQL wrapper passes credentials through the child process
environment, not command-line arguments.

Run this read-only connection check without initialization or a reset:

```sh
/usr/local/bin/acg secret --env prod --path /aiq \
  --inject AIQ_DATABASE_URL=SUPABASE_DATABASE_URL -- \
  cargo make check-database-connection
```

The check reports the client connection, TLS, database identity, and read-only
transaction state. It does not insert data or change the schema. The same
Session Pooler provides PostgreSQL session state for the repository's SQL
commands. See the [Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres#shared-pooler-session-mode).

## ELF retirement check, 2026-10-22

The read-only inventory of project `xxnszykaeapolqdnhalx` found no ELF-owned
database, schema, relation, function, role, bucket, or Storage object. All 42
AIQ private tables were scanned for ELF references. The scan found none and
used a read-only role that bypasses RLS. No remote rows needed deletion.
The retained Core inventory remains 34 runs, 2,448 task results, 17 model
configurations, and 34 score snapshots. These are observed counts, not a
current Core publication or an initialization receipt.

All 13 unused local ELF database and baseline data volumes were removed from
the `orbstack` Docker context. The 85 unrelated volumes and 10
containers were preserved.

Management access uses Personal Infisical `prod:/aiq/SUPABASE_ACCESS_TOKEN`.
The replacement token is `aiq-managed-2026-10-22`, expires on October 29,
2026, and is scoped to this project with Project Settings read access and
Database read/write access. It was saved with the official Infisical CLI and
verified through a fresh `acg secret` injection. The expired `aiq` token was
deleted. No initializer or reset command was run. The Management API supplied
the verified read access for this check. The failed database connection
credential was then replaced by the rotation below.

## Database credential rotation, 2026-10-22

The official Supabase Management API changed the `postgres` password for
project `xxnszykaeapolqdnhalx`. The official Infisical CLI saved the new
PostgreSQL URL at Personal Infisical `prod:/aiq/SUPABASE_DATABASE_URL`.
No manual credential copy was required. The saved URL uses the supported
session pooler `aws-0-ca-central-1.pooler.supabase.com:5432`, database
`postgres`, and user `postgres.xxnszykaeapolqdnhalx`.

A fresh `acg secret` injection supplied that URL to a native `psql` check.
The client authenticated, negotiated TLS 1.3, and completed a read-only
transaction as database user `postgres`. The before/after SHA-256 content
summaries match for all 17 model configurations, 34 runs, 34 score snapshots,
and 2,448 task results. No result or schema was changed.

The temporary token `aiq-db-rotation-2026-10-22` had only Database Config
read/write access for this project, with a 24-hour expiry. It was revoked
after verification. The token disappeared from the account list, and a
configuration API request with it returned HTTP 401. The existing managed
AIQ token keeps its original permissions and expiry.

## Connection decision, 2026-10-22

Session Pooler is the selected production connection. The current network has
no IPv6 egress. Direct-host troubleshooting is closed; no IPv6 allocation,
proxy change, or direct-host repair is pending. All temporary network rules
and profile changes from the investigation were removed.

A fresh Infisical-injected `psql` connection through Session Pooler passes
with TLS 1.3. The counts and SHA-256 content summaries match the original
inventory for all 17 model configurations, 34 runs, 34 score snapshots, and
2,448 task results. The connection change preserves existing AI Intelligence
results. No initializer, reset, or benchmark run was used for this verification.

## Desired state and initialization

`databases/schema.sql` is the sole desired database state.
`databases/init.ts` is the only production initialization command.
`databases/reset.ts` is the production greenfield replacement command. It
removes only the existing AIQ prelaunch namespace and then calls the production
initializer. It is not a migration or an upgrade path.

The initializer opens one PostgreSQL connection, starts one transaction, applies
the schema, inserts public reference data, checks readiness, and commits. The
production connection must use the exact Session Pooler target in
[Production connection](#production-connection). This binds initialization to
the personal Supabase project documented by repository authority. Tests and local
development can target only a loopback host when
`NODE_ENV` is `test` or `development` and
`AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET=true` is set explicitly. Production
cannot use this override.
It rejects a database that already contains the AIQ schema, AIQ roles, or either
exact AIQ Storage bucket identity. Only a new empty AIQ namespace in the existing
target Supabase project is supported.
If AIQ residue exists, the operator must remove only `aiq_private`,
`aiq_verifier`, `aiq_publisher`, and the exact AIQ-owned public views and RPC
overloads. Preserve all Supabase-managed and non-AIQ objects. This cleanup is a
deployment prerequisite, not a migration or compatibility path. The schema
creates `aiq-submission-packages` and `aiq-runner-artifacts` in
`storage.buckets` and sets both buckets to private. The greenfield preflight
rejects either exact bucket ID or name if it already exists. Do not create either
bucket before initialization.

The model-free preflight checks every one of the 13 canonical AIQ public view
names and every public RPC name created by `databases/schema.sql`. Any overload
with one of those exact names rejects initialization. It does not use a broad
`public`-schema or prefix match, so unrelated views and functions remain
outside the cleanup boundary.

```sh
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
/usr/local/bin/acg secret --env prod --path /aiq \
  --inject AIQ_DATABASE_URL=SUPABASE_DATABASE_URL -- \
  cargo make init-database
```

The Supabase database must already provide `anon`, `authenticated`,
`authenticator`, and `service_role`. The production reference contains one real,
controlled, non-synthetic `aiq.corpus-commitment.v3` document for AIQ Core
`1.1.0`, its real `published_at` timestamp, and exactly three public identities:
runner, verifier, and publisher. Prepare it only after the controlled corpus and
final native binaries pass validation. The controlled production reference is
still pending. The checked-in runtime task-set and task-commitment identities
describe the unbounded task and fixture bindings. Seal and validate fresh Core
and Contrast corpora from the final clean identity commit. The repository does
not contain a substitute production commitment or benchmark results. Supply
the controlled production reference separately.

A successful receipt reports:

- AIQ Core task release `1.1.0` with benchmark identifier `aiq-core@1.1.0`;
- aggregate scoring version `1.0.8`;
- 72 catalog tasks;
- 17 model configurations;
- three distinct production nodes;
- 42 private tables with enabled and forced RLS;
- 13 canonical AIQ-owned security-invoker public views. Unrelated `public`
  views are preserved and stay outside the AIQ readiness inventory;
- two hardened, non-login gateway roles;
- ordered task-metadata catalog digest
  `sha256:3580555315d49a62b28b6947491819276dca5b261ade802f10b33808569d1708`;
- catalog release identity
  `sha256:5b651845280ea0b27a8cfc2aec4efe4c149bbbfdeeb0e5a9c883174938b58d69`;
- current no-deadline runtime task-set identity,
  `sha256:c7481e46c64dbf5ff9f50a85c83608d48390a03cbf9e94a1d89ab36aeb6df89a`;
- current no-deadline task-commitment manifest identity,
  `sha256:d8dddd1bc496a1609c3268068fdfdfa4562c589ddfdfec365a6a49caadefe96b`;
- reviewed evaluator identity
  `sha256:748e0a6c07eb7e3407cc22d50b65eb6d055305cb6e1d719ca3cfd3a109bec809`;
- ordered selected-evaluator provenance commitment
  `sha256:4ea7463e7762aa498f1b314919cd0dc2eb07144e374f8ea743a59c3973c31ce0`;
- reviewed controlled generated-task tree, scorer-manifest, Core corpus, and
  Contrast corpus identities from the final controlled production reference.

The controlled tree identity is not a runtime task-set hash. The database does
not write it to `task_set_hash` or `task_set_digest`. Those fields use the
canonical runtime hash of the 72 task definitions. The initializer derives
that hash with the same sorted-address RFC 8785 algorithm as the Rust
protocol. The frozen task-set metadata and production readiness bind the
reviewed evaluator executable identity. Signed `evaluator_digest` provenance
instead binds the ordered selected-evaluator commitment computed across all 72
task definitions. These identities have different semantics and values. The
database does not copy either identity into an unrelated field.
The native corpus commitment owns the scorer-manifest identity. The
database binds its output through aggregate scoring version `1.0.8` and recomputes
the score from normalized result evidence.

The current public-safe `1.1.0` 72-task database binding manifest is
`aiq-core-1.1.0-task-commitments.json`. Its canonical JCS identity is
`sha256:d8dddd1bc496a1609c3268068fdfdfa4562c589ddfdfec365a6a49caadefe96b`.
It is a checked-in pre-seal binding, not authorization for database action.
Fresh Core and Contrast A/B seals, calibration admission, and a real signed
17-by-72 Official package
must still pass native verifier replay first.

The desired state targets the sole production tuple: AIQ Core `1.1.0`, task
scorer `1.0.6`, aggregate scorer `1.0.8`, and measurement `2.0.0`. Do not reset
or initialize production until
the controlled commitments are complete and one real non-synthetic signed
17-by-72 package passes native verifier replay.

## AIQ 2.0 cutover order

Create the new `1.1.0` package from the current controlled 72-task set, then
replay-verify it with the native verifier before any destructive database
action. Do not preserve, migrate, recompute, or relabel a legacy publication.
It is not a fallback.

The hard pre-reset gate is the real verifier result, not a reset manifest. Run
`aiq-verifier verify-local` (or the equivalent controlled production verifier)
against the new signed package, private artifacts, current tasks, evaluator
registry, corpus commitment, and production verifier environment. Require exit
status zero and retain the newly written normalized stage, verifier attestation,
and, for the full Official matrix, the verifier admission output. A queue
receipt, a synthetic fixture, or a self-authored JSON summary does not satisfy
this gate. The complete command template is in
[Deployment Handoff](../openwiki/deployment-handoff.md#aiq-20-cutover).

An ordinary provider backup is optional. It is not a release gate, reset input,
migration input, compatibility source, or reason to delay the reset.

After the new package passes verification, perform one read-only reset
inventory, then one greenfield reset/init window. The reset command has no
`AIQ_PRE_RESET_EVIDENCE_ARCHIVE` manifest dependency and does not pretend to
archive or validate old private evidence. Submit the already verified new
package to the fresh database, run the controlled verifier and distinct
publisher, and publish only after all 17 Official scores are accepted.
Finally run `cargo make check-aiq-2-cutover`. It must report exactly one
non-synthetic `1.1.0` matrix, 17 runs, 17 Official scores, 1,224 task results,
one calibration digest, and zero synthetic Official/public rows. If either
hard gate fails, do not publish or deploy the new Web build. Do not fall back to
a legacy publication.

## Greenfield replacement

First, run a read-only inventory. The command lists the canonical database
objects. For each private AIQ bucket, it reports only the object count and a
deterministic SHA-256 commitment to the ordered object paths. It never writes
private object paths to the dry-run result, reset receipt, or standard output.
It rejects an unexpected AIQ schema, role, function, bucket, or bucket identity.
It also rejects a non-canonical policy or role membership that depends on an
AIQ role, a non-view relation that uses a canonical public view name, and any
object outside the canonical AIQ surface that depends on `aiq_private`. The
only platform-managed membership exception is the exact `supabase_admin` grant
of each AIQ gateway role to `postgres`; Supabase creates these grants with a new
role. Thus, the internal schema cascade cannot remove an external dependent.

```sh
/usr/local/bin/acg secret --env prod --path /aiq \
  --inject AIQ_DATABASE_URL=SUPABASE_DATABASE_URL -- \
  cargo make reset-database --dry-run
```

Review the inventory. Then run the one-step replacement with the exact project
and namespace confirmation:

```sh
AIQ_SUPABASE_SERVICE_ROLE_KEY='<controlled-service-role-key>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
/usr/local/bin/acg secret --env prod --path /aiq \
  --inject AIQ_DATABASE_URL=SUPABASE_DATABASE_URL -- \
  cargo make reset-database --confirm xxnszykaeapolqdnhalx:aiq_private
```

Before it makes a Storage request or starts PostgreSQL cleanup, the destructive
command reads, parses, and validates the production reference plus the
checked-in schema, catalog, corpus schema, and current task commitments. A
missing, malformed, or inconsistent authority stops the reset without mutation.

The command reads the exact AIQ bucket object names through its protected
PostgreSQL inventory and keeps them only in memory. The dry-run output and reset
receipt contain only counts and ordered-path SHA-256 commitments. Object
deletion uses the supported Supabase Storage API in batches of 100 with at most
four concurrent requests. The command reads each bucket through the Storage API
before it removes it. It never deletes rows directly from `storage.objects`.

Storage deletion and database replacement cannot share one transaction. The
command processes `aiq-runner-artifacts` and then `aiq-submission-packages`.
All requests in a bounded object-deletion group settle before readback. If a
request fails and objects remain, the command reports the remaining count and
stops before it removes that bucket or changes PostgreSQL. Earlier object
batches or the first bucket can already be deleted. If a failed response follows
a successful object deletion, an empty readback permits the bucket removal.
A bucket-removal failure can also mean that the bucket is present or already
removed. In each Storage failure case, rerun the same command. The new inventory
skips an absent bucket and resumes with an existing bucket.

The command verifies that both buckets are absent before it changes PostgreSQL.
It then removes the
canonical public RPC overloads, the 13 canonical public views, `aiq_private`,
`aiq_publisher`, and `aiq_verifier` in one PostgreSQL transaction. It reads the
database boundary again inside that transaction after it acquires the reset
advisory lock, dependency-catalog locks, role-membership locks, and exclusive
locks on the AIQ relations. Concurrent DDL cannot add a dependent between the
final boundary check and schema removal. It reads the database namespace again
before it starts initialization. If Storage succeeds
and the database transaction or initialization fails, the AIQ Storage objects
are already deleted. Correct the reported database problem and run the same
command again. The command preserves Supabase-managed and unrelated schemas,
roles, functions, views, tables, users, and buckets.

The reference and receipt are public-safe. They must not contain private tasks,
expected outputs, signing keys, tokens, or database credentials.

## Security model

The schema stores AIQ tables in `aiq_private`, enables and forces RLS, and
exposes 13 security-invoker public views plus narrow RPCs. Browser roles have
read-only access. Server gateways control submission, verification, publication,
and private Storage operations.

Runner packages enter an unverified inbox. A verifier identity records the
normalized v3 stage and attestation. A separate publisher identity completes
publication.

Calibration packages use the same content-addressed package ingress and claim
lifecycle. The envelope has `payload_type: aiq.calibration-run.v4`, and the
payload has `schema_version: aiq.calibration-run.v4`. The database accepts only
`claimed_trust: untrusted`, `classification: local_calibration_non_official`,
`provenance.run_class: calibration`, and `official_eligible: false`.

The verifier uses these calibration-only RPCs in order:

1. `aiq_stage_calibration_verification(stage, target_inbox_id,
   supplied_lease_token, supplied_attempt)` records one
   `aiq.calibration-verified-stage.v2` document.
2. `aiq_record_calibration_attestation(attestation, target_inbox_id,
   supplied_lease_token, supplied_attempt)` records one
   `aiq.calibration-verifier-attestation.v2` document. The replay status must be
   `evaluator_replayed`.
3. The distinct publisher uses `aiq_publish_calibration_evidence(target_run_id,
   target_package_sha256, target_inbox_id, supplied_lease_token,
   supplied_attempt)`.

The RPCs return `recorded`, `published`, or `duplicate`. A different retry for
the same identity is a conflict. Calibration evidence is append-only and uses
durable Storage ownership references. Official publication uses the same
append-only ownership map. Each path attaches a durable reference to the
submitted package and every claim-bound audit artifact before it retires claim
references. Generic reference deactivation cannot release publication-owned
objects. Calibration cannot write Official batch, package, run, score,
leaderboard, or trend data.

Browser roles can read published rows from `public_calibration_runs`,
`public_calibration_results`, and `public_calibration_scores`. These
security-invoker views do not expose package identities, digests, node
identities, envelopes, raw responses, private artifacts, or raw failure
messages. Calibration results keep the exact normalized outcome and expose a
bounded failure code, a separate five-state execution status, and a fixed
explanation summary.
Efficiency values distinguish observed Codex adapter invocation elapsed time,
provider-reported token usage, and verifier-recomputed API-equivalent
estimates. Unknown values are `NULL`. Standard short-context rates come from
`https://developers.openai.com/api/docs/pricing`. A result with more than
272000 aggregate input tokens has status `unavailable_context_band` and no cost
or cost-evidence authority because aggregate turn usage cannot identify
per-request context bands. Prompts above that boundary use the published
long-context multiplier. Regional processing uplift and hosted tool fees are
excluded. The method says that actual subscription spend is not measured. The
database does not store or infer that value.

`public_model_efficiency` is the separate published Official efficiency
aggregate. It does not change AIQ scores or ranking. Elapsed columns aggregate
observed Codex adapter invocation elapsed time. The
`summed_cell_adapter_elapsed_ms` value is not batch makespan because concurrent
calls can overlap. The signed matrix-stage timestamps supply
`matrix_batch_elapsed_ms`; all 17 child runs share it, so consumers count it
once per matrix batch. The persisted Rust aggregate supplies the median and
p95. An even sample median is the integer average of the two middle values. The
p95 uses the nearest-rank value. Token counters keep the raw provider values.
Reasoning output is a subset of output and is not added twice. Cost uses exact integer
`standard_api_equivalent_usd_nanos` values and an immutable pricing-method
digest. The pricing record keeps its method, version, observation date, source,
currency, Standard processing tier, rates, formula, and limitation. Missing or
inconsistent usage keeps the cost `NULL` and records an unavailable status.

The aggregate views expose selected-result, attempted-result, adapter-invoked,
elapsed-observed, token-observed, and priced counts. A cost total is available
only when all results have an estimate. The retained verified stage keeps the
raw provider counters and the immutable pricing record. This evidence supports
later contemporaneous and rebased price views without changing the recorded
estimate.

Normal/Fast transport observations use separate append-only private batch and
trial tables. `public_speed_observations` exposes the latest published
capability state plus bounded aggregate completion, elapsed time, throughput,
token, tool-use, and estimated-credit fields. `public_speed_trend_points(range)`
returns at most 20 time buckets per exact model, reasoning, and mode series for
`day`, `week`, `month`, or `all`. Both public contracts have no scoring effect;
no database formula or publication gate can use these values to change AIQ,
uncertainty, status, or rank. TTFT and post-first-token throughput remain
explicitly unavailable while the current Codex transport lacks a trustworthy
first-token timestamp.

An attempted result passed capability admission and entered task preparation.
The adapter-invoked count also excludes cells stopped by workspace preflight.
The elapsed-observed count can be lower than the adapter-invoked count when the
verifier has no bounded elapsed value. These counts do not infer a successful
model response.

Calibration publication creates durable `calibration_run` ownership for the
submitted package and every claim-bound audit artifact. This includes declared
evaluator results, result and capability-probe output, final response, workspace
manifest, and workspace snapshot artifacts. The publisher reconciles these
references before it retires the temporary claim references. An exact publisher
retry reconciles them again.

## Disposable validation

The other SQL files are validation inputs, not production installers. Apply
the following sequence to a separate fresh disposable PostgreSQL 17 or 18 database,
not to the database created by `init-database`:

```sh
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/schema.sql
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/synthetic-demo.sql
psql "$AIQ_DATABASE_URL" -X --set ON_ERROR_STOP=1 \
  --file databases/integration.sql
```

- `smoke.sql` checks RLS, view inventory, role hardening, grants, and real reads
  through the `anon` and `authenticated` roles.
- `synthetic-demo.sql` loads deterministic non-production data.
- `integration.sql` checks queue, lease, stage, attestation, publication, and
  Storage state flows. Its `publication-regressions.sql` include checks stored
  interval precision and nonempty browser result and efficiency projections.
  It seeds predicate and projection states inside a savepoint. It does not
  prove external signature verification or successful Official admission.

Storage deletion leasing is DB-gated. The service must record a successful full
inventory epoch with `aiq_record_storage_inventory_epoch(count, digest)` after
it resolves every mismatch. The supplied count and canonical object-identity
digest must match the live registry. The digest is the JCS SHA-256 of an array
ordered bytewise by bucket and key. Each item has `bucket`, `key`,
`content_sha256`, and `bytes`. Deleted registry objects are not in the array. An
epoch is valid for 24 hours. Any later mismatch requires another successful
epoch before the database leases more deletions.

The opt-in PostgreSQL 17 or 18 initializer test runs the initializer twice. The
first call must produce the complete production reference receipt. The second
call must report the distinct safe reuse rejection, leave readiness unchanged,
and not disclose its connection string. The same test requires both browser
roles to see the complete 17-model, three-node, one-scoring-version, and
ten-domain public reference shape. It then runs `calibration-integration.sql`
and checks that its rollback leaves the public reference shape unchanged.
This flow checks wrong-class provenance, exact task identity, functional marker
evidence, append-only storage, and retained capability logs with SQL execution.

The PostgreSQL 17 or 18 artifact resolver concurrency check holds the Storage deletion
gate, starts nine artifact resolutions for one verifier claim, and then
releases the gate. It requires every resolver to complete without SQLSTATE
`40P01`. The set includes the exact functional marker, evaluator evidence,
output logs, final response, workspace manifest, and workspace snapshot.
Three parallel replay waves must leave exactly nine immutable claim bindings,
nine activation events, and nine active claim Storage references.

Supply `AIQ_DATABASE_INIT_TEST_URL` and `AIQ_DATABASE_INIT_TEST_PSQL` to run the
initializer test against an empty disposable database. For the resolver test,
supply `AIQ_DATABASE_CONCURRENCY_TEST_URL` and
`AIQ_DATABASE_CONCURRENCY_TEST_PSQL` for an initialized disposable database.
Run these tests in sequence. Roles are cluster-wide, so the synthetic flow
and the initializer flow need separate fresh clusters. No test installs a
PostgreSQL runtime or uses production connection secrets.

The opt-in `reset-postgres.integration.test.ts` uses an exact loopback
`aiq_reset_*` database. It proves that reset rejects changed dependencies,
serializes concurrent objects at the cleanup boundary, removes only AIQ-owned
state, preserves unrelated database and Storage objects, and permits one fresh
desired-state application.

Run the rollback-only calibration publication proof against the same freshly
initialized disposable database. It uses the initializer-owned exact catalog
and does not add or replace catalog rows.

```sh
NODE_ENV=test AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET=true \
AIQ_DATABASE_URL='<disposable-loopback-postgres-url>' \
cargo make smoke-calibration-database
```

Run `synthetic-demo.sql`, `integration.sql`, and `calibration-integration.sql`
only in disposable databases. Do not load synthetic data into production.

## Real public-read chain

The opt-in live-stack browser check connects the built Next.js application to a
real local PostgREST process. Run it against a freshly initialized, empty
disposable database. Expose only the `public` schema and set the PostgREST
anonymous role to `anon`.

```sh
AIQ_LIVE_POSTGREST_URL='http://127.0.0.1:4178' \
cargo make smoke-live-web
```

The test-only loopback proxy supplies the `/rest/v1` prefix that the Supabase API
gateway provides in production. The check renders every public page through the
real PostgREST and RLS path. It requires the 17-model empty-live state and fails
on unavailable data, runtime browser errors, accessibility violations,
overflow, or an unexpected run.
