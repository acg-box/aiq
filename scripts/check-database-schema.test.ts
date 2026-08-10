import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  checkDatabaseInitializerSource,
  checkDatabaseSchema,
  checkDatabaseSchemaSources,
  checkDatabaseTaskCommitmentFixture,
} from './check-database-schema.ts';

const repositoryRoot =
  process.env.AIQ_DATABASE_SCHEMA_ROOT === undefined
    ? resolve(import.meta.dirname, '..')
    : resolve(process.env.AIQ_DATABASE_SCHEMA_ROOT);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) {
    throw new Error('Expected a JSON object.');
  }
  return value;
}

function unknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a JSON array.');
  return Array.from(value, (item: unknown) => item);
}

async function sources(): Promise<[string, string]> {
  return Promise.all([
    readFile(join(repositoryRoot, 'databases/schema.sql'), 'utf8'),
    readFile(join(repositoryRoot, 'databases/synthetic-demo.sql'), 'utf8'),
  ]);
}

await test('the canonical fresh-database schema satisfies the static contract', async () => {
  await checkDatabaseSchema(repositoryRoot);
});

await test('checker rejects readiness that counts unrelated public views', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace(
    "    where namespace.nspname='public' and relation.relkind='v'\n      and relation.relname in (",
    "    where namespace.nspname='public' and relation.relkind='v'\n      and true in (",
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /count only the canonical AIQ public views/,
  );
});

await test('schema and synthetic demo data have separate final-state owners', async () => {
  const [schema, syntheticDemo] = await sources();
  assert.match(schema, /^begin;\n/);
  assert.match(schema, /\ncommit;\s*$/);
  assert.match(schema, /^insert\s+into\s+storage\.buckets/im);
  assert.doesNotMatch(schema, /^insert\s+into\s+aiq_private\./im);
  assert.match(syntheticDemo, /^-- Deterministic local demonstration data\./);
  assert.match(syntheticDemo, /^\s*insert\s+into\s+aiq_private\./m);
});

await test('synthetic score snapshots consume the classified score rows', async () => {
  const [, syntheticDemo] = await sources();
  assert.match(syntheticDemo, /when valid_task_count = 72[\s\S]{0,120}then 'synthetic_complete'/);
  assert.match(syntheticDemo, /join scored score on score\.run_id = run\.run_id/);
  assert.doesNotMatch(syntheticDemo, /join run_scores score on score\.run_id = run\.run_id/);
});

await test('checker requires both AIQ Storage buckets to be private and create-new', async () => {
  const [schema, syntheticDemo] = await sources();
  for (const changed of [
    schema.replace("('aiq-runner-artifacts', 'aiq-runner-artifacts', false)", ''),
    schema.replace(
      "('aiq-runner-artifacts', 'aiq-runner-artifacts', false)",
      "('aiq-runner-artifacts', 'aiq-runner-artifacts', true)",
    ),
    schema.replace(
      "('aiq-runner-artifacts', 'aiq-runner-artifacts', false);",
      "('aiq-runner-artifacts', 'aiq-runner-artifacts', false) on conflict (id) do nothing;",
    ),
  ]) {
    assert.notEqual(changed, schema);
    assert.throws(
      () => checkDatabaseSchemaSources(changed, syntheticDemo),
      /Storage bucket initialization|Storage buckets as private|greenfield Storage/,
    );
  }
});

await test('checker rejects an exposed base table or missing forced RLS', async () => {
  const [schema, syntheticDemo] = await sources();
  assert.throws(
    () =>
      checkDatabaseSchemaSources(
        schema.replace('create table aiq_private.aiq_runs', 'create table public.aiq_runs'),
        syntheticDemo,
      ),
    /private table inventory|public\.aiq_/,
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
  const changed = schema.replace("'aiq.result-package.v4'::text", "'aiq.result-package.v3'::text");
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /only aiq\.result-package\.v4/,
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

await test('checker rejects a sub-millisecond public trend sentinel', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace(
    "latest_recorded_at + interval '1 millisecond'",
    "latest_recorded_at + interval '1 microsecond'",
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /JavaScript millisecond precision/,
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

await test('checker rejects initializer readiness without private Storage buckets', async () => {
  const initializer = await readFile(join(repositoryRoot, 'databases/init.ts'), 'utf8');
  const changed = initializer.replace('and public is false', 'and public is true');
  assert.notEqual(changed, initializer);
  assert.throws(
    () => checkDatabaseInitializerSource(changed),
    /readiness must require both private AIQ Storage buckets/,
  );
});

await test('checker rejects an initializer that reuses existing AIQ Storage buckets', async () => {
  const initializer = await readFile(join(repositoryRoot, 'databases/init.ts'), 'utf8');
  const changed = initializer.replace(
    'select 1 from storage.buckets',
    'select 1 from storage.other',
  );
  assert.notEqual(changed, initializer);
  assert.throws(
    () => checkDatabaseInitializerSource(changed),
    /greenfield preflight must reject either existing AIQ Storage bucket identity/,
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
    /inventoried read views/,
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

await test('checker rejects an obsolete public security-invoker view and browser grant', async () => {
  const [schema, syntheticDemo] = await sources();
  const extraView = `
create view public.aiq_obsolete_preview_status with (security_invoker = true) as select true as ready;
grant select on table public.aiq_obsolete_preview_status to anon, authenticated;
`;
  const changed = schema.replace('\ncommit;', `${extraView}\ncommit;`);
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /Only the inventoried read views can be public/,
  );
});

await test('checker rejects a stale or uncommitted Storage inventory identity', async () => {
  const [schema, syntheticDemo] = await sources();
  const staleSignature = schema.replace(
    'supplied_inventory_object_count bigint,supplied_inventory_digest text',
    'supplied_inventory_object_count bigint',
  );
  assert.notEqual(staleSignature, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(staleSignature, syntheticDemo),
    /count-and-digest signature|inventory RPC/,
  );

  const noncanonicalDigest = schema.replace("'bytes',object.byte_size", "'size',object.byte_size");
  assert.notEqual(noncanonicalDigest, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(noncanonicalDigest, syntheticDemo),
    /bounded JCS object inventory/,
  );
});

await test('checker rejects weakened catalog and outcome bindings', async () => {
  const [schema, syntheticDemo] = await sources();
  const unboundHash = schema.replace(
    "task_hash text generated always as ('sha256:'::text || fixture_commitment) stored",
    'task_hash text',
  );
  assert.notEqual(unboundHash, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(unboundHash, syntheticDemo),
    /Catalog task hashes/,
  );

  const weakenedFailure = schema.replace(
    "(outcome='timeout' and failure_code is not null and failure_code='timeout')",
    "(outcome='timeout' and failure_code is not null)",
  );
  assert.notEqual(weakenedFailure, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(weakenedFailure, syntheticDemo),
    /failure-code bindings/,
  );
});

await test('checker rejects unsafe result exposure and stale evidence indexes', async () => {
  const [schema, syntheticDemo] = await sources();
  const exposedHash = schema.replace(
    '  result.task_version,\n  result.domain,',
    '  result.task_version,\n  result.task_hash,\n  result.domain,',
  );
  assert.notEqual(exposedHash, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(exposedHash, syntheticDemo),
    /must not expose committed hashes/,
  );

  const staleIndex = schema.replace(
    '  on aiq_private.calibration_task_results(\n    task_set_id,task_set_version,task_id,task_version,task_hash\n  );',
    '  on aiq_private.calibration_task_results(task_id);',
  );
  assert.notEqual(staleIndex, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(staleIndex, syntheticDemo),
    /exact catalog lookup index/,
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

await test('checker rejects a missing workspace-integrity acceptance path', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace(
    "'workspace_unavailable','workspace_integrity'\n    )",
    "'workspace_unavailable'\n    )",
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /accept workspace_integrity as a failure kind/,
  );
});

await test('checker rejects workspace integrity in an unattempted filter', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace(
    "'capability_unavailable','capability_validation_failed','workspace_unavailable'\n  );",
    "'capability_unavailable','capability_validation_failed','workspace_unavailable',\n" +
      "    'workspace_integrity'\n  );",
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /workspace_integrity is attempted/,
  );
});

await test('checker rejects stale release, pricing, and adapter-failure contracts', async () => {
  const [schema, syntheticDemo] = await sources();
  for (const [changed, expected] of [
    [
      schema.replaceAll(
        'sha256:777dc72d782a274e654bc8fa61479908c244675b148755fb36bb2c28a89acd72',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
      /Official provenance must compare the task-set digest/,
    ],
    [
      schema.replaceAll(
        "'non_zero_exit','budget_exceeded','output_truncated','workspace_integrity'",
        "'non_zero_exit','budget_exceeded','output_truncated'",
      ),
      /adapter-failure validator must accept workspace_integrity/,
    ],
    [schema.replace('aiq-core@1.0.7', 'aiq-core@1.0.1'), /expected to not match/],
    [
      schema.replaceAll(
        'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c',
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ),
      /d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c/,
    ],
    [
      schema.replaceAll(
        'sha256:ed1e38d4ffb3a39e64a83d65b6d115b691857b37b41ad9413acedcba33c949f8',
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ),
      /ordered selected-evaluator commitment/,
    ],
    [
      schema.replace(
        'sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae',
        'sha256:b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc',
      ),
      /expected to not match/,
    ],
    [
      schema.replace(
        'https://developers.openai.com/api/docs/pricing',
        'https://developers.openai.com/api/docs/models/compare',
      ),
      /pricing (record drifted|inventory must retain)/,
    ],
  ] as const) {
    assert.notEqual(changed, schema);
    assert.throws(() => checkDatabaseSchemaSources(changed, syntheticDemo), expected);
  }
});

await test('checker rejects initializer evaluator constants that are not enforced', async () => {
  const initializer = await readFile(join(repositoryRoot, 'databases/init.ts'), 'utf8');
  for (const [changed, expected] of [
    [
      initializer.replace(
        'documentDigest(taskDefinitionIdentities.toSorted())',
        'documentDigest(taskDefinitionIdentities)',
      ),
      /Rust sorted-address canonical task-set hash algorithm/,
    ],
    [
      initializer.replace(
        'binding.fixture_bundle_sha256 !== reviewed.fixture_bundle_sha256',
        'false',
      ),
      /Every fixture bundle must match/,
    ],
    [
      initializer.replace('evaluatorDigest !== EVALUATOR_IDENTITY', 'false'),
      /compare runtime evaluator provenance/,
    ],
    [
      initializer.replace(
        'binding.evaluator_executable_sha256 !== EVALUATOR_IDENTITY',
        'binding.evaluator_executable_sha256 !== evaluatorDigest',
      ),
      /Every task binding must compare/,
    ],
    [
      initializer.replace(
        'evaluator_identity_sha256: reference.evaluatorIdentitySha256',
        'evaluator_identity_sha256: EVALUATOR_IDENTITY',
      ),
      /persist the validated evaluator identity/,
    ],
    [
      initializer.replace(
        'value.evaluator_identity_sha256 === expected.evaluator_identity_sha256',
        "typeof value.evaluator_identity_sha256 === 'string'",
      ),
      /compare readiness output/,
    ],
  ] as const) {
    assert.notEqual(changed, initializer);
    assert.throws(() => checkDatabaseInitializerSource(changed), expected);
  }
});

await test('checker derives the native identity from all reviewed task commitments', async () => {
  const fixture: unknown = JSON.parse(
    await readFile(join(repositoryRoot, 'databases/aiq-core-1.0.7-task-commitments.json'), 'utf8'),
  );
  checkDatabaseTaskCommitmentFixture(fixture);
  const changed = jsonObject(structuredClone(fixture));
  const first = jsonObject(unknownArray(changed.tasks)[0]);
  first.task_definition_sha256 =
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.throws(() => checkDatabaseTaskCommitmentFixture(changed));
  const changedFixture = jsonObject(structuredClone(fixture));
  const firstFixture = jsonObject(unknownArray(changedFixture.tasks)[0]);
  firstFixture.fixture_bundle_sha256 =
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.throws(() => checkDatabaseTaskCommitmentFixture(changedFixture));
});

await test('checker rejects readiness that reports but does not enforce evaluator identity', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace(
    "      and evaluator_identity_sha256 =\n        'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c'\n",
    '',
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /Production readiness must compare/,
  );
});

await test('checker rejects readiness that reports but does not enforce task-set identity', async () => {
  const [schema, syntheticDemo] = await sources();
  const changed = schema.replace(
    "      and task_set_identity_sha256 =\n        'sha256:777dc72d782a274e654bc8fa61479908c244675b148755fb36bb2c28a89acd72'\n",
    '',
  );
  assert.notEqual(changed, schema);
  assert.throws(
    () => checkDatabaseSchemaSources(changed, syntheticDemo),
    /Production readiness must compare the derived task-set identity/,
  );
});
