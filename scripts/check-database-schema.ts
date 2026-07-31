import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function checkSecurityDefinerSearchPaths(schema: string): void {
  const starts = [...schema.matchAll(/^create function /gm)].map(({ index }) => index);
  assert.ok(starts.length >= 115, 'The schema function inventory is incomplete.');
  for (const [position, start] of starts.entries()) {
    const end = starts[position + 1] ?? schema.length;
    const definition = schema.slice(start, end);
    if (/security\s+definer/i.test(definition)) {
      assert.match(
        definition,
        /set search_path to ''/i,
        'Each security-definer function must set an empty search path.',
      );
    }
  }
}

export function checkDatabaseSchemaSources(schema: string, syntheticDemo: string): void {
  assert.match(schema, /^begin;\n/);
  assert.match(schema, /\ncommit;\s*$/);
  assert.doesNotMatch(schema, /^\s*drop\s/im, 'The fresh schema must not drop database objects.');
  assert.doesNotMatch(schema, /^insert\s+into\s/im, 'The schema must not contain demo data.');
  assert.equal(
    (schema.match(/^create role aiq_(?:verifier|publisher)$/gm) ?? []).length,
    2,
    'Fresh initialization must create both AIQ roles directly.',
  );
  assert.doesNotMatch(
    schema,
    /if not exists\s*\(\s*select 1\s+from pg_roles\s+where rolname = 'aiq_(?:verifier|publisher)'/i,
    'Fresh initialization must not preserve pre-existing AIQ roles.',
  );
  assert.match(
    schema,
    /create function aiq_private\.enqueue_submission_core\(envelope jsonb, request_context jsonb\)/,
  );
  assert.doesNotMatch(
    schema,
    /create function public\.aiq_enqueue_submission\(envelope jsonb, request_context jsonb\)/,
    'The public submission API must expose only its current object-bound signature.',
  );
  assert.equal(
    (schema.match(/create table aiq_private\.aiq_/g) ?? []).length,
    31,
    'All 31 AIQ base tables must be private.',
  );
  assert.equal(
    (schema.match(/force row level security/g) ?? []).length,
    31,
    'All AIQ base tables must force row-level security.',
  );
  assert.equal(
    (schema.match(/create view public\.public_/g) ?? []).length,
    8,
    'Only the eight read views can be public.',
  );
  assert.equal(
    (schema.match(/with \(security_invoker = true\)/g) ?? []).length,
    8,
    'Each public view must use invoker security.',
  );
  assert.doesNotMatch(schema, /create table public\.aiq_/);
  const databaseSources = `${schema}\n${syntheticDemo}`;
  for (const contractName of [
    'result-package',
    'verifier-attestation',
    'normalized-batch',
    'package-binding',
  ]) {
    const versions = [
      ...databaseSources.matchAll(new RegExp(`aiq\\.${contractName}\\.v([0-9]+)`, 'g')),
    ].map((match) => match[1]);
    assert.ok(versions.length > 0, `The canonical database sources omit aiq.${contractName}.v3.`);
    assert.deepEqual(
      new Set(versions),
      new Set(['3']),
      `The canonical database sources must use only aiq.${contractName}.v3.`,
    );
  }
  assert.doesNotMatch(databaseSources, /(?:stage_verifier_result|verify_and_publish)_v[0-9]+/);
  assert.doesNotMatch(databaseSources, /provenance_storage_adapter/);
  assert.match(schema, /create function aiq_private\.stage_verifier_result_core\(/);
  assert.match(schema, /create function aiq_private\.verify_and_publish_core\(/);
  assert.match(
    schema,
    /aiq_result_packages_schema_version_check check \(\(schema_version = 'aiq\.result-package\.v3'::text\)\)/,
  );
  assert.match(
    schema,
    /aiq_result_packages_provenance_check check \(\(provenance = '\{"schema_version": "aiq\.package-binding\.v3"\}'::jsonb\)\)/,
  );
  assert.match(
    schema,
    /revoke all on schema aiq_private[\s\S]{0,160}from public, anon, authenticated, service_role, aiq_verifier, aiq_publisher/,
  );
  assert.match(
    schema,
    /revoke create on schema public[\s\S]{0,160}from public, anon, authenticated, service_role, aiq_verifier, aiq_publisher/,
  );
  checkSecurityDefinerSearchPaths(schema);

  for (const requiredName of [
    'aiq_enqueue_submission',
    'aiq_record_artifact_ingress',
    'aiq_claim_submission',
    'aiq_renew_submission_claim',
    'aiq_ack_submission_claim',
    'aiq_resolve_claim_artifact',
    'aiq_stage_verifier_result',
    'aiq_record_verifier_attestation',
    'aiq_record_verification_rejection',
    'aiq_verify_and_publish',
    'aiq_register_storage_object',
    'aiq_claim_storage_deletions',
    'aiq_ack_storage_deletion',
    'aiq_retry_storage_deletion',
    'aiq_set_storage_legal_hold',
    'aiq_production_reference_status',
    'aiq_describe_web_rpc_contract',
    'aiq_gateway_role_probe',
    'public_trend_points',
  ]) {
    assert.match(schema, new RegExp(`function public\\.${requiredName}\\(`));
  }

  for (const indexName of [
    'aiq_runs_public_trend_series_idx',
    'aiq_runs_public_trend_extent_idx',
    'aiq_submission_claimable_idx',
    'aiq_storage_objects_claim_idx',
    'aiq_matrix_batches_task_set_fk_idx',
    'aiq_distributed_aggregation_receipt_fk_idx',
    'aiq_task_catalog_public_rls_idx',
  ]) {
    assert.match(schema, new RegExp(`create (?:unique )?index ${indexName}`));
  }

  assert.match(
    schema,
    /claim_expires_at = database_now \+ make_interval\(secs => requested_lease_seconds\)/,
    'Submission claims must calculate leases from the wall clock.',
  );
  assert.match(
    schema,
    /deletion_lease_expires_at =\s*database_now \+ make_interval\(secs => requested_lease_seconds\)/,
    'Storage deletion claims must calculate leases from the wall clock.',
  );
  assert.doesNotMatch(schema, /claim_expires_at\s*(?:=|<=)\s*now\(\)/);
  assert.doesNotMatch(schema, /deletion_lease_expires_at\s*(?:=|<=)\s*now\(\)/);

  assert.match(
    syntheticDemo,
    /^-- Deterministic local demonstration data\. Every published observation is\n-- explicitly synthetic\./,
  );
  assert.match(syntheticDemo, /\nbegin;\n/);
  assert.match(syntheticDemo, /\ncommit;\s*$/);
  assert.match(syntheticDemo, /insert into aiq_private\.aiq_model_configs/);
  assert.match(syntheticDemo, /insert into aiq_private\.aiq_task_catalog/);
  assert.match(syntheticDemo, /insert into aiq_private\.aiq_package_runs/);
  assert.match(syntheticDemo, /'schema_version', 'aiq\.result-package\.v3'/);
  assert.doesNotMatch(syntheticDemo, /'unverified',\s*'queued'/);
  assert.match(syntheticDemo, /'unverified',\s*'processed'/);
  assert.doesNotMatch(`${schema}\n${syntheticDemo}`, /create\s+(?:storage\s+)?bucket/i);
  assert.doesNotMatch(`${schema}\n${syntheticDemo}`, /cron\.schedule|pg_cron/i);
}

export async function checkDatabaseSchema(
  repositoryRoot = resolve(import.meta.dirname, '..'),
): Promise<void> {
  const [schema, syntheticDemo] = await Promise.all([
    readFile(join(repositoryRoot, 'databases/schema.sql'), 'utf8'),
    readFile(join(repositoryRoot, 'databases/synthetic-demo.sql'), 'utf8'),
  ]);
  checkDatabaseSchemaSources(schema, syntheticDemo);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await checkDatabaseSchema();
  console.log('Database schema check passed.');
}
