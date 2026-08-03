# Database authority

`databases/schema.sql` is the sole desired database state.
`databases/init.ts` is the only production initialization command.

The initializer opens one direct PostgreSQL connection, starts one transaction,
applies the schema, inserts public reference data, checks readiness, and commits.
It rejects a database that already contains the AIQ schema or AIQ roles. Only a
new empty AIQ database is supported.

```sh
AIQ_DATABASE_URL='<direct-connection-url>' \
AIQ_PRODUCTION_REFERENCE=/controlled/production-reference.json \
cargo make init-database
```

The Supabase database must already provide `anon`, `authenticated`,
`authenticator`, and `service_role`. The production reference contains one real,
controlled, non-synthetic `aiq.corpus-commitment.v2` document for the promoted
AIQ Core `1.0.2` release, its real `published_at` timestamp, and exactly three
public identities: runner, verifier, and publisher. The repository does not
contain a substitute promoted commitment or benchmark results. Supply the
controlled production reference separately.

A successful receipt reports:

- AIQ Core task release `1.0.2` with benchmark identifier `aiq-core@1.0.2`;
- scoring version `1.0.2`;
- 72 catalog tasks;
- 17 model configurations;
- three distinct production nodes;
- 40 private tables with enabled and forced RLS;
- 12 security-invoker public views;
- two hardened, non-login gateway roles;
- ordered task-metadata catalog digest
  `sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937`;
- catalog release identity
  `sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b`.

AIQ Core `1.0.2` is the only supported task-set and benchmark version in this
desired state. There is no migration, compatibility, dual-version, or data
preservation path.

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
messages. Calibration results keep the normalized outcome and expose a bounded
failure code, the five-state public status, and a fixed explanation summary.
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
