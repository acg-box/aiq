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

function checkWorkspaceIntegrityFailureClassification(schema: string): void {
  const adapterValidator =
    schema.match(
      /create function aiq_private\.dto_adapter_failure_is_valid[\s\S]*?\n\$_\$;/i,
    )?.[0] ?? '';
  assert.match(
    adapterValidator,
    /'non_zero_exit','budget_exceeded','output_truncated','workspace_integrity'/,
    'The adapter-failure validator must accept workspace_integrity after paid execution.',
  );

  const resultValidator =
    schema.match(/create function aiq_private\.dto_result_is_valid[\s\S]*?\n\$_\$;/i)?.[0] ?? '';
  assert.match(
    resultValidator,
    /'missing_response','evaluator_failure','budget_exceeded','output_truncated',\s*'workspace_unavailable','workspace_integrity'\s*\)/,
    'The task-result validator must accept workspace_integrity as a failure kind.',
  );
  assert.match(
    resultValidator,
    /'evaluator_failure','workspace_unavailable','workspace_integrity'\s*\) and candidate -> 'task_score' <> 'null'::jsonb/,
    'A workspace_integrity failure must use the infrastructure null-score shape.',
  );
  assert.match(
    resultValidator,
    /if failure ->> 'kind' = 'workspace_integrity' then[\s\S]{0,1200}workspace_manifest[\s\S]{0,1200}workspace-snapshot\.json/,
    'An attempted workspace_integrity result must retain both workspace commitments or neither.',
  );

  const unattemptedSets = [
    ...schema.matchAll(
      /(?:in|not in)\s*\(\s*'capability_unavailable'\s*,\s*'capability_validation_failed'\s*,\s*'workspace_unavailable'(?<tail>[\s\S]*?)\)/g,
    ),
  ];
  assert.equal(
    unattemptedSets.length,
    9,
    'The database must retain all nine explicit pre-invocation or unattempted filters.',
  );
  for (const filter of unattemptedSets) {
    assert.equal(
      filter.groups?.tail?.trim() ?? '',
      '',
      'workspace_integrity is attempted and must not enter an unattempted filter.',
    );
  }

  const outcomeNormalizer =
    schema.match(
      /create function aiq_private\.normalized_outcome_from_source[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  assert.match(
    outcomeNormalizer,
    /'evaluator_failure', 'workspace_unavailable', 'workspace_integrity', 'missing_evaluator'/,
    'workspace_integrity must normalize to the invalid infrastructure outcome.',
  );
  const responsibilityNormalizer =
    schema.match(
      /create function aiq_private\.normalized_responsibility_from_source[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  assert.match(
    responsibilityNormalizer,
    /'evaluator_failure', 'workspace_unavailable', 'workspace_integrity', 'missing_evaluator'[\s\S]{0,80}'benchmark_infrastructure'/,
    'workspace_integrity must retain benchmark-infrastructure responsibility.',
  );
  assert.match(
    schema,
    /outcome='invalid'[\s\S]{0,100}failure_code in \(\s*'evaluator_failure','workspace_unavailable','workspace_integrity','missing_evaluator','spawn'/,
    'The calibration result constraint must accept the normalized workspace_integrity code.',
  );
}

function checkCurrentReleaseAndPricing(schema: string, syntheticDemo: string): void {
  const catalogDigest = 'b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc';
  const staleCatalogDigest = 'b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3';
  const databaseSources = `${schema}\n${syntheticDemo}`;

  assert.doesNotMatch(databaseSources, new RegExp(staleCatalogDigest));
  assert.doesNotMatch(databaseSources, /aiq-core@1\.0\.0/);
  assert.match(schema, new RegExp(`sha256:${catalogDigest}`));
  assert.match(schema, new RegExp(`catalog_sha256 =\\s*'${catalogDigest}'`));
  assert.match(schema, /task_set\.task_set_version = '1\.0\.1'/);
  assert.match(schema, /scoring\.scoring_version = '1\.0\.0'/);
  assert.match(schema, /scoring\.benchmark_version = 'aiq-core@1\.0\.1'/);
  assert.match(syntheticDemo, /'aiq-core@1\.0\.1'/);
  assert.match(
    syntheticDemo,
    /package\.normalization_digest, package\.node_id, 'aiq-core', '1\.0\.1', '1\.0\.0'/,
  );

  const pricingValidator =
    schema.match(
      /create function aiq_private\.efficiency_pricing_v1_is_valid[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  for (const contract of [
    /https:\/\/developers\.openai\.com\/api\/docs\/pricing/,
    /'gpt-5\.6-sol'[\s\S]{0,240}5000[\s\S]{0,120}500[\s\S]{0,160}6250[\s\S]{0,120}30000/,
    /'gpt-5\.6-terra'[\s\S]{0,240}2000[\s\S]{0,120}200[\s\S]{0,160}2500[\s\S]{0,120}12000/,
    /'gpt-5\.6-luna'[\s\S]{0,240}200[\s\S]{0,120}20[\s\S]{0,160}250[\s\S]{0,120}1200/,
    /Standard short-context API-equivalent comparison only\.[\s\S]{0,240}272000 aggregate input tokens[\s\S]{0,240}This is not actual subscription spend\./,
  ]) {
    assert.match(
      pricingValidator,
      contract,
      'The fixed Standard short-context pricing record drifted.',
    );
  }

  const resultEfficiencyValidator =
    schema.match(
      /create function aiq_private\.result_efficiency_v1_is_valid[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  assert.match(
    resultEfficiencyValidator,
    /if input_tokens>272000\s*then return candidate->>'cost_status'='unavailable_context_band'/,
    'Aggregate input above the short-context boundary must be unpriced.',
  );
  assert.match(
    resultEfficiencyValidator,
    /\(candidate->>'cost_status'='estimated'\)[\s\S]{0,160}\(candidate->'standard_api_equivalent_usd_nanos'<>'null'::jsonb\)/,
    'Only estimated results can retain a cost.',
  );
  assert.match(
    resultEfficiencyValidator,
    /\(candidate->'standard_api_equivalent_usd_nanos'='null'::jsonb\)[\s\S]{0,160}\(candidate->'cost_evidence_level'='null'::jsonb\)/,
    'Unavailable costs must not retain cost authority.',
  );
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
    (schema.match(/^create table aiq_private\./gim) ?? []).length,
    40,
    'All 40 private base tables must remain in aiq_private.',
  );
  assert.equal(
    (schema.match(/^alter table aiq_private\.[a-z0-9_]+ force row level security;/gim) ?? [])
      .length,
    40,
    'All 40 private base tables must force row-level security.',
  );
  assert.equal(
    (schema.match(/^create view public\.(?:public_|aiq_preview_status_v1)/gim) ?? []).length,
    13,
    'Only the 13 read views can be public.',
  );
  assert.equal(
    (schema.match(/with \(security_invoker\s*=\s*true\)/gi) ?? []).length,
    13,
    'Each public view must use invoker security.',
  );
  assert.match(schema, /create function aiq_private\.preview_status_v1\(\) returns table\(/);
  assert.match(
    schema,
    /create function aiq_private\.preview_status_v1\(\)[\s\S]*?language plpgsql stable security definer[\s\S]*?scoring\.scoring_version = '1\.0\.0'[\s\S]*?and scoring\.synthetic[\s\S]*?then\s+return;/,
  );
  assert.match(
    schema,
    /create view public\.aiq_preview_status_v1 with \(security_invoker = true\)/,
  );
  assert.match(schema, /revoke all on function aiq_private\.preview_status_v1\(\) from PUBLIC/);
  assert.match(schema, /grant all on function aiq_private\.preview_status_v1\(\) to anon/);
  assert.match(schema, /grant all on function aiq_private\.preview_status_v1\(\) to authenticated/);
  assert.match(schema, /grant select on table public\.aiq_preview_status_v1 to anon/);
  assert.match(schema, /grant select on table public\.aiq_preview_status_v1 to authenticated/);
  const browserReadSurfaceRevocation = [
    ...schema.matchAll(/revoke all on table\s+([\s\S]*?)\s+from public, anon, authenticated;/gi),
  ]
    .map((match) => match[1])
    .join('\n');
  assert.ok(
    browserReadSurfaceRevocation,
    'The public read surface must remove provider default grants before granting SELECT.',
  );
  for (const viewName of [
    'public_distributed_radar',
    'public_leaderboard',
    'public_model_matrix',
    'public_nodes',
    'public_run_results',
    'public_runs',
    'public_scoring_versions',
    'public_task_coverage',
    'public_calibration_runs',
    'public_calibration_results',
    'public_calibration_scores',
    'public_model_efficiency',
    'aiq_preview_status_v1',
  ]) {
    assert.match(
      browserReadSurfaceRevocation,
      new RegExp(`public\\.${viewName}(?:,|\\s|$)`),
      `The public read surface must revoke provider defaults from ${viewName}.`,
    );
  }
  assert.match(schema, /'synthetic_complete'/);
  assert.match(schema, /score ->> 'tier' = 'synthetic_complete' and not is_synthetic/);
  assert.match(schema, /score ->> 'tier' = 'official' and is_synthetic/);
  assert.match(schema, /batch\.synthetic[\s\S]{0,120}return false;/);
  for (const source of [
    'aiq_matrix_batches',
    'aiq_result_packages',
    'aiq_submission_inbox',
    'aiq_submission_conflicts',
  ]) {
    assert.match(
      schema,
      new RegExp(`from aiq_private\\.${source} [\\s\\S]{0,180}where `),
      `Preview status must reject non-synthetic evidence from ${source}.`,
    );
  }
  assert.match(syntheticDemo, /'synthetic_complete'/);
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
  checkWorkspaceIntegrityFailureClassification(schema);
  checkCurrentReleaseAndPricing(schema, syntheticDemo);

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
