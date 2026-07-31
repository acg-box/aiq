import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { checkDatabaseSchema, checkDatabaseSchemaSources } from './check-database-schema.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');

async function sources(): Promise<[string, string]> {
  return Promise.all([
    readFile(join(repositoryRoot, 'databases/schema.sql'), 'utf8'),
    readFile(join(repositoryRoot, 'databases/synthetic-demo.sql'), 'utf8'),
  ]);
}

await test('the canonical fresh-database schema satisfies the static contract', async () => {
  await checkDatabaseSchema(repositoryRoot);
});

await test('schema and synthetic demo data have separate final-state owners', async () => {
  const [schema, syntheticDemo] = await sources();
  assert.match(schema, /^begin;\n/);
  assert.match(schema, /\ncommit;\s*$/);
  assert.doesNotMatch(schema, /^insert\s+into\s/im);
  assert.match(syntheticDemo, /^-- Deterministic local demonstration data\./);
  assert.match(syntheticDemo, /^\s*insert\s+into\s+aiq_private\./m);
});

await test('checker rejects an exposed base table or missing forced RLS', async () => {
  const [schema, syntheticDemo] = await sources();
  assert.throws(
    () =>
      checkDatabaseSchemaSources(
        schema.replace('create table aiq_private.aiq_runs', 'create table public.aiq_runs'),
        syntheticDemo,
      ),
    /31 AIQ base tables|public\.aiq_/,
  );
  assert.throws(
    () =>
      checkDatabaseSchemaSources(
        schema.replace('alter table aiq_private.aiq_runs force row level security;', ''),
        syntheticDemo,
      ),
    /force row-level security/,
  );
});

await test('checker rejects an unpinned security-definer function', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace("    SET search_path to ''\n    as $$", '    as $$');
  assert.notEqual(changed, schema);
  assert.throws(() => checkDatabaseSchemaSources(changed, syntheticDemo), /empty search path/);
});

await test('checker rejects a noncurrent publication contract', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace("'aiq.result-package.v3'::text", "'aiq.result-package.v4'::text");
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /only aiq\.result-package\.v3/,
  );
});

await test('checker rejects an extra public submission overload', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace(
    'create function aiq_private.enqueue_submission_core(envelope jsonb, request_context jsonb)',
    'create function public.aiq_enqueue_submission(envelope jsonb, request_context jsonb)',
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /enqueue_submission_core|current object-bound signature/,
  );
});

await test('checker rejects conditional reuse of an existing AIQ role', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace(
    'create role aiq_verifier',
    "if not exists (select 1 from pg_roles where rolname = 'aiq_verifier') then\n  create role aiq_verifier",
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /create both AIQ roles directly|must not preserve pre-existing AIQ roles/,
  );
});

await test('checker rejects an extra public view or transaction-start claim lease', async () => {
  const [schema, syntheticDemo] = await sources();
  assert.throws(
    () =>
      checkDatabaseSchemaSources(
        schema.replace(
          '\ncommit;',
          '\ncreate view public.public_raw_history as select 1 as id;\n\ncommit;',
        ),
        syntheticDemo,
      ),
    /eight read views/,
  );
  const changed = schema.replace(
    'claim_expires_at = database_now + make_interval(secs => requested_lease_seconds)',
    'claim_expires_at = now() + make_interval(secs => requested_lease_seconds)',
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /wall clock|claim_expires_at/,
  );
});

await test('checker rejects nonterminal or unlabeled demonstration data', async () => {
  const [schema, syntheticDemo] = await sources();
  const queued = syntheticDemo.replace(/('unverified',\s*)'processed'/, "$1'queued'");
  assert.notEqual(queued, syntheticDemo);
  assert.throws(() => checkDatabaseSchemaSources(schema, queued), /queued/);
  assert.throws(
    () => checkDatabaseSchemaSources(schema, syntheticDemo.replace('explicitly synthetic', '')),
    /explicitly synthetic/,
  );
});
