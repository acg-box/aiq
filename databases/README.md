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
`authenticator`, and `service_role`. The production reference contains one
controlled, non-synthetic `aiq.corpus-commitment.v2` document and exactly three
public identities: runner, verifier, and publisher.

A successful receipt reports:

- 72 catalog tasks;
- 17 model configurations;
- three distinct production nodes;
- catalog digest
  `sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3`.

The reference and receipt are public-safe. They must not contain private tasks,
expected outputs, signing keys, tokens, or database credentials.

## Security model

The schema stores AIQ tables in `aiq_private`, enables and forces RLS, and
exposes eight security-invoker public views plus narrow RPCs. Browser roles have
read-only access. Server gateways control submission, verification, publication,
and private Storage operations.

Runner packages enter an unverified inbox. A verifier identity records the
normalized v3 stage and attestation. A separate publisher identity completes
publication.

## Disposable validation

The other SQL files are validation inputs, not production installers.

```sh
cargo make smoke-database
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

The opt-in PostgreSQL 17 initializer test also runs the initializer twice. The
first call must produce the complete production reference receipt. The second
call must report the distinct safe reuse rejection, leave readiness unchanged,
and not disclose its connection string. The same test requires both browser
roles to see the complete 17-model, three-node, one-scoring-version, and
ten-domain public reference shape.

Run the last two files only in a disposable database. Do not load synthetic data
into production.

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
