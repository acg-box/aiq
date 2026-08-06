# Database authority

`databases/schema.sql` is the sole desired database state.
`databases/init.ts` is the only production initialization command.
`databases/reset.ts` is the production greenfield replacement command. It
removes only the existing AIQ prelaunch namespace and then calls the production
initializer. It is not a migration or an upgrade path.

The initializer opens one direct PostgreSQL connection, starts one transaction,
applies the schema, inserts public reference data, checks readiness, and commits.
The production connection must use PostgreSQL, host
`db.xxnszykaeapolqdnhalx.supabase.co`, database and user `postgres`, and the
direct port `5432` or its omitted default. This binds initialization to the
personal Supabase project documented by repository authority. Tests and local
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

The model-free preflight checks every one of the 12 canonical AIQ public view
names and every public RPC name created by `databases/schema.sql`. Any overload
with one of those exact names rejects initialization. It does not use a broad
`public`-schema or prefix match, so unrelated views and functions remain
outside the cleanup boundary.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The Supabase database must already provide `anon`, `authenticated`,
`authenticator`, and `service_role`. The production reference contains one real,
controlled, non-synthetic `aiq.corpus-commitment.v2` document for AIQ Core
`1.0.5`, its real `published_at` timestamp, and exactly three public identities:
runner, verifier, and publisher. Prepare it only after the controlled corpus and
final native binaries pass validation. The controlled production reference is
still pending. The reviewed 72-task database commitment is frozen in
`aiq-core-1.0.5-task-commitments.json`. The repository does not contain a
substitute production commitment or benchmark results. Supply the controlled
production reference separately.

A successful receipt reports:

- AIQ Core task release `1.0.5` with benchmark identifier `aiq-core@1.0.5`;
- scoring version `1.0.5`;
- 72 catalog tasks;
- 17 model configurations;
- three distinct production nodes;
- 40 private tables with enabled and forced RLS;
- 12 canonical AIQ-owned security-invoker public views. Unrelated `public`
  views are preserved and stay outside the AIQ readiness inventory;
- two hardened, non-login gateway roles;
- ordered task-metadata catalog digest
  `sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7`;
- catalog release identity
  `sha256:496b40f54dc7c3dc92d8880201373344c723001a0570a4debd28e539cfe4030d`;
- reviewed runtime task-set identity
  `sha256:f6fc21fa2deb3788c186437c45f8e1c8d5d1e366d32bc81e3b5f847e9844cf05`;
- reviewed task-commitment manifest identity
  `sha256:503b19156c545535faf4c24f463b96ad5ba10c12b3fc235f832c27077efb4b94`;
- reviewed evaluator identity
  `sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`;
- reviewed controlled generated-task tree, scorer-manifest, Core corpus, and
  Contrast corpus identities from the final controlled production reference.

The controlled tree identity is not a runtime task-set hash. The database does
not write it to `task_set_hash` or `task_set_digest`. Those fields use the
canonical runtime hash of the 72 task definitions. The initializer derives
that hash with the same sorted-address RFC 8785 algorithm as the Rust
protocol. The database binds the exact
evaluator identity in signed `evaluator_digest` provenance and in the frozen
task-set metadata that production readiness checks. It does not copy the
scorer-manifest identity into an unrelated field.
The native corpus commitment owns the scorer-manifest identity. The
database binds its output through scoring version `1.0.5` and recomputes
the score from normalized result evidence.

The reviewed public-safe `1.0.5` 72-task database binding manifest is
`aiq-core-1.0.5-task-commitments.json`. Its canonical JCS identity is
`sha256:503b19156c545535faf4c24f463b96ad5ba10c12b3fc235f832c27077efb4b94`.

The pre-release desired state targets AIQ Core `1.0.5`. Production is still on
the historical published `1.0.2` state. Do not initialize production until the
controlled `1.0.5` commitments are complete and reviewed.

## Greenfield replacement

First, run a read-only inventory. The command lists the canonical database
objects. For each private AIQ bucket, it reports only the object count and a
deterministic SHA-256 commitment to the ordered object paths. It never writes
private object paths to the dry-run result, reset receipt, or standard output.
It rejects an unexpected AIQ schema, role, function, bucket, or bucket identity.
It also rejects a non-canonical policy or role membership that depends on an
AIQ role, a non-view relation that uses a canonical public view name, and any
object outside the canonical AIQ surface that depends on `aiq_private`. Thus,
the internal schema cascade cannot remove an external dependent.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_SUPABASE_SERVICE_ROLE_KEY='<controlled-service-role-key>' \
cargo make reset-database -- --dry-run
```

Review the inventory. Then run the one-step replacement with the exact project
and namespace confirmation:

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_SUPABASE_SERVICE_ROLE_KEY='<controlled-service-role-key>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make reset-database -- \
  --confirm xxnszykaeapolqdnhalx:aiq_private
```

Before it makes a Storage request or starts PostgreSQL cleanup, the destructive
command reads, parses, and validates the production reference plus the
checked-in schema, catalog, corpus schema, and reviewed task commitments. A
missing, malformed, or inconsistent authority stops the reset without mutation.

The command uses the supported Supabase Storage API to list and delete objects
before it removes a bucket. Listing uses pages of 100 objects. Object deletion
uses batches of 100 and at most four concurrent requests. The command reads the
buckets again before it removes them. It does not delete rows directly from
`storage.objects`.

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
canonical public RPC overloads, the 12 canonical public views, `aiq_private`,
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
exposes 12 security-invoker public views plus narrow RPCs. Browser roles have
read-only access. Server gateways control submission, verification, publication,
and private Storage operations.

Runner packages enter an unverified inbox. A verifier identity records the
normalized v3 stage and attestation. A separate publisher identity completes
publication.

Calibration packages use the same content-addressed package ingress and claim
lifecycle. The envelope has `payload_type: aiq.calibration-run.v3`, and the
payload has `schema_version: aiq.calibration-run.v3`. The database accepts only
`claimed_trust: untrusted`, `classification: local_calibration_non_official`,
`provenance.run_class: calibration`, and `official_eligible: false`.

The verifier uses these calibration-only RPCs in order:

1. `aiq_stage_calibration_verification(stage, target_inbox_id,
supplied_lease_token, supplied_attempt)` records one
   `aiq.calibration-verified-stage.v1` document.
2. `aiq_record_calibration_attestation(attestation, target_inbox_id,
supplied_lease_token, supplied_attempt)` records one
   `aiq.calibration-verifier-attestation.v1` document. The replay status must be
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
the following sequence to a separate fresh disposable PostgreSQL 17 database,
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
  Storage state flows.

Storage deletion leasing is DB-gated. The service must record a successful full
inventory epoch with `aiq_record_storage_inventory_epoch(count, digest)` after
it resolves every mismatch. The supplied count and canonical object-identity
digest must match the live registry. The digest is the JCS SHA-256 of an array
ordered bytewise by bucket and key. Each item has `bucket`, `key`,
`content_sha256`, and `bytes`. Deleted registry objects are not in the array. An
epoch is valid for 24 hours. Any later mismatch requires another successful
epoch before the database leases more deletions.

The opt-in PostgreSQL 17 initializer test also runs the initializer twice. The
first call must produce the complete production reference receipt. The second
call must report the distinct safe reuse rejection, leave readiness unchanged,
and not disclose its connection string. The same test requires both browser
roles to see the complete 17-model, three-node, one-scoring-version, and
ten-domain public reference shape.

The PostgreSQL 17 artifact resolver concurrency check holds the Storage deletion
gate, starts all six artifact resolutions for one verifier claim, and then
releases the gate. It requires every resolver to complete without SQLSTATE
`40P01`. Three parallel replay waves must leave exactly six immutable claim
bindings, six activation events, and six active claim Storage references.

Run the rollback-only calibration publication proof against the same freshly
initialized disposable database. It uses the initializer-owned exact catalog
and does not add or replace catalog rows.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' cargo make smoke-calibration-database
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
