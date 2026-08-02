import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const schema = await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8');

void test('keeps calibration evidence separate from Official publication tables', () => {
  for (const table of [
    'calibration_verification_stages',
    'calibration_runs',
    'aiq_publication_storage_evidence',
    'calibration_model_scores',
    'calibration_task_results',
    'calibration_verification_audit',
    'calibration_publications',
    'efficiency_pricing_methods',
    'efficiency_official_models',
  ]) {
    assert.match(schema, new RegExp(`create table aiq_private\\.${table}`));
    assert.match(schema, new RegExp(`ALTER TABLE aiq_private\\.${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(schema, /aiq\.calibration-run\.v3/);
  assert.match(schema, /local_calibration_non_official/);
  assert.match(schema, /evaluator_replayed/);
  assert.match(schema, /calibration evidence is append-only/);
  assert.doesNotMatch(
    schema.match(/create function public\.aiq_publish_calibration_evidence[\s\S]*?\n\$\$;/)?.[0] ??
      '',
    /insert into aiq_private\.aiq_(?:matrix_batches|result_packages|runs|score_snapshots)/,
  );
});

void test('exposes only published sanitized calibration columns', () => {
  for (const view of [
    'public_calibration_runs',
    'public_calibration_results',
    'public_calibration_scores',
  ]) {
    assert.match(
      schema,
      new RegExp(`CREATE VIEW public\\.${view} with \\(security_invoker=true\\)`),
    );
  }
  const publicViews = schema.slice(schema.indexOf('CREATE VIEW public.public_calibration_runs'));
  for (const privateField of [
    'package_sha256',
    'content_hash',
    'stage_digest',
    'runner_node_id',
    'verifier_node_id',
    'publisher_node_id',
    'verification_record',
    'verifier_attestation',
    'failure_detail',
  ]) {
    assert.doesNotMatch(
      publicViews.slice(0, publicViews.indexOf('alter table aiq_private.calibration_runs')),
      new RegExp(`result\\.${privateField}|run\\.${privateField}|score\\.${privateField}`),
    );
  }
  assert.match(
    publicViews,
    /join aiq_private\.calibration_publications publication using \(run_id\)/,
  );
  const publicResults =
    schema.match(/CREATE VIEW public\.public_calibration_results[\s\S]*?;\n/)?.[0] ?? '';
  for (const field of ['status', 'failure_code', 'explanation_code', 'explanation_summary']) {
    assert.match(publicResults, new RegExp(field));
  }
  assert.match(publicResults, /when result\.outcome in \('correct','partial'\) then 'passed'/);
  assert.match(publicResults, /when result\.outcome='not_applicable' then 'not_applicable'/);
});

void test('separates verifier and publisher RPC authority', () => {
  for (const rpc of [
    'aiq_stage_calibration_verification(jsonb,uuid,uuid,integer)',
    'aiq_record_calibration_attestation(jsonb,uuid,uuid,integer)',
  ]) {
    assert.match(
      schema,
      new RegExp(
        `grant execute on function public\\.${rpc.replace(/[()]/g, '\\$&')}[\\s\\S]{0,80}to aiq_verifier`,
      ),
    );
  }
  assert.match(
    schema,
    /grant execute on function public\.aiq_publish_calibration_evidence\(text,text,uuid,uuid,integer\)[\s\S]{0,80}to aiq_publisher/,
  );
  assert.match(
    schema,
    /production_execution_identities_are_authorized\(saved\.runner_node_id,verifier_node_id\)/,
  );
  assert.match(schema, /production_publisher_identity_is_authorized\(/);
});

void test('keeps efficiency evidence nullable, bounded, and non-Official', () => {
  assert.match(schema, /cached_input_tokens <= input_tokens/);
  assert.match(schema, /reasoning_output_tokens <= output_tokens/);
  assert.doesNotMatch(schema, /total_tokens = input_tokens \+ output_tokens/);
  assert.match(
    schema,
    /cost_estimator_status in \('estimated','unavailable_missing_usage','unavailable_invalid_usage'\)/,
  );
  assert.match(schema, /standard_api_equivalent_usd_nanos bigint/);
  assert.match(schema, /per_request_long_context_unknown/);
  assert.match(schema, /duration_evidence_level = 'runner_observed'/);
  assert.match(
    schema,
    /token_usage_source_level is null or token_usage_source_level = 'provider_reported'/,
  );
  assert.match(
    schema,
    /token_usage_evidence_level is null or token_usage_evidence_level = 'verifier_recomputed'/,
  );
  assert.match(schema, /cost_evidence_level = 'verifier_recomputed'/);
  assert.match(schema, /scored_result_count between 0 and result_count/);
  assert.match(
    schema,
    /\(\(descriptive_status in \('coverage_only','not_applicable'\)\) = \(score is null\)\)/,
  );
  assert.match(
    schema,
    /\(standard_api_equivalent_usd_nanos is null\) = \(cost_evidence_level is null\)/,
  );
  assert.match(schema, /candidate->>'provider_tokens_evidence_level'='verifier_recomputed'/);
  assert.match(schema, /task_resampling_sensitivity_method/);
  assert.match(schema, /score is null or score between 0 and 100/);
  assert.match(schema, /processing_tier text not null/);
  assert.match(schema, /processing_tier = 'standard'/);
  assert.match(schema, /pricing\.currency as pricing_currency/);
  assert.match(schema, /pricing\.processing_tier as pricing_processing_tier/);
  for (const count of [
    'attempted_result_count',
    'invoked_result_count',
    'adapter_elapsed_observed_result_count',
    'token_observed_result_count',
    'priced_result_count',
  ]) {
    assert.match(schema, new RegExp(count));
  }
  for (const total of [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ]) {
    assert.match(schema, new RegExp(`score\\.${total}`));
  }
});

void test('accepts only the fixed Standard-tier pricing record', () => {
  const validator =
    schema.match(
      /create function aiq_private\.efficiency_pricing_v1_is_valid[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  for (const literal of [
    'standard_api_equivalent_text_token_estimate',
    'aiq.standard-api-equivalent-usd.v1',
    '2026-08-02',
    'https://developers.openai.com/api/docs/models/compare',
    "candidate->>'currency'='USD'",
    "candidate->>'processing_tier'='standard'",
    'This is not actual subscription spend.',
  ]) {
    assert.ok(validator.includes(literal), `missing fixed pricing literal: ${literal}`);
  }
  for (const rate of [
    ["'gpt-5.6-sol'", '5000', '500', '6250', '30000'],
    ["'gpt-5.6-terra'", '2500', '250', '3125', '15000'],
    ["'gpt-5.6-luna'", '1000', '100', '1250', '6000'],
  ]) {
    let cursor = -1;
    for (const value of rate) {
      cursor = validator.indexOf(value, cursor + 1);
      assert.notEqual(cursor, -1, `missing or unordered pricing value: ${value}`);
    }
  }
  assert.match(schema, /pricing_digest=aiq_private\.jcs_sha256\(pricing_record\)/);
  assert.match(schema, /pricing\.processing_tier as pricing_processing_tier/);
  assert.match(schema, /pricing\.rates as pricing_rates/);
  assert.match(schema, /pricing\.formula as cost_formula/);
});

void test('binds Official efficiency evidence to the exact payload matrix', () => {
  const unbound =
    schema.match(
      /create function aiq_private\.aiq_stage_verifier_result_unbound_core[\s\S]*?\n\$_\$;/,
    )?.[0] ?? '';
  const bound =
    schema.match(/create function aiq_private\.stage_verifier_result_core[\s\S]*?\n\$_\$;/)?.[0] ??
    '';
  for (const validator of [unbound, bound]) {
    for (const key of ['execution_concurrency', 'result_efficiency', 'efficiency', 'pricing']) {
      assert.match(validator, new RegExp(`'${key}'`));
    }
    assert.match(validator, /execution_concurrency',32/);
    assert.match(
      validator,
      /jsonb_array_length\(stage->'result_efficiency'\) is distinct from 1224/,
    );
    assert.match(validator, /jsonb_array_length\(stage->'efficiency'\) is distinct from 17/);
    assert.match(validator, /efficiency_pricing_v1_is_valid\(stage->'pricing'\)/);
    assert.match(validator, /efficiency_aggregate_matches_results/);
  }
  assert.match(
    bound,
    /payload -> 'execution_concurrency' is distinct from stage -> 'execution_concurrency'/,
  );
  assert.match(bound, /source->>'result_id'=evidence->>'source_result_id'/);
  assert.match(bound, /evidence->'provider_tokens'<>'\{\}'::jsonb/);
  assert.match(bound, /insert into aiq_private\.efficiency_official_models/);
  assert.match(bound, /verified\.evidence->>'provider_tokens_evidence_level'/);
  assert.match(
    schema,
    /observed_median_wall_ms::text is not distinct from[\s\S]{0,80}efficiency_record->>'median_observed_wall_ms'/,
  );

  const view = schema.match(/CREATE VIEW public\.public_model_efficiency[\s\S]*?;\n/)?.[0] ?? '';
  assert.match(view, /from aiq_private\.efficiency_official_models efficiency/);
  assert.doesNotMatch(view, /percentile_disc|percentile_cont/);
});

void test('retains all publication audit objects before claim references retire', () => {
  const attestation =
    schema.match(
      /create function public\.aiq_record_calibration_attestation[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  const calibrationPublisher =
    schema.match(/create function public\.aiq_publish_calibration_evidence[\s\S]*?\n\$\$;/)?.[0] ??
    '';
  const officialPublisher =
    schema.match(/create function public\.aiq_verify_and_publish\([\s\S]*?\n\$\$;/)?.[0] ?? '';
  const reconciler =
    schema.match(
      /create function aiq_private\.reconcile_publication_storage_evidence[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  assert.match(schema, /create table aiq_private\.aiq_publication_storage_evidence/);
  assert.match(
    schema,
    /foreign key \(official_batch_id,package_sha256\)[\s\S]{0,120}aiq_matrix_batches/,
  );
  assert.match(
    schema,
    /foreign key \(calibration_run_id,package_sha256\)[\s\S]{0,120}calibration_runs/,
  );
  assert.match(reconciler, /from aiq_private\.aiq_artifact_claim_bindings binding/);
  assert.match(reconciler, /'submitted_package','result-package\.json'/);
  assert.match(reconciler, /'verified_artifact'/);
  assert.match(reconciler, /'official_publication'/);
  assert.match(reconciler, /'calibration_run'/);
  assert.match(reconciler, /capability_validation,models/);
  assert.match(attestation, /reconcile_publication_storage_evidence/);
  assert.match(calibrationPublisher, /return 'duplicate'/);
  assert.ok(
    calibrationPublisher.indexOf('reconcile_publication_storage_evidence') <
      calibrationPublisher.indexOf('retire_claim_artifact_references'),
    'durable calibration ownership must precede claim-reference retirement',
  );
  assert.ok(
    officialPublisher.indexOf('reconcile_publication_storage_evidence') <
      officialPublisher.indexOf('retire_claim_artifact_references'),
    'durable Official ownership must precede claim-reference retirement',
  );
  assert.match(schema, /supplied_reference_type in \('calibration_run','official_publication'\)/);
});

void test('binds calibration results to one exact committed catalog task', () => {
  const packageValidator =
    schema.match(
      /create function aiq_private\.calibration_package_v3_is_valid[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  const stage =
    schema.match(
      /create function public\.aiq_stage_calibration_verification[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  const attestation =
    schema.match(
      /create function public\.aiq_record_calibration_attestation[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  assert.match(
    packageValidator,
    /result ->> 'task_hash' = 'sha256:' \|\| catalog\.fixture_commitment/,
  );
  assert.match(stage, /task_catalog_is_exact/);
  assert.match(stage, /selected_hashes/);
  assert.match(stage, /source->>'task_hash'='sha256:'\|\|catalog\.fixture_commitment/);
  assert.match(stage, /evidence->'observed_wall_ms'<>'null'::jsonb/);
  assert.match(attestation, /catalog\.task_set_id=stage->>'task_set_id'/);
  assert.match(attestation, /get diagnostics inserted_rows=row_count/);
  assert.match(attestation, /stored_result_count<>jsonb_array_length\(payload->'results'\)/);
  assert.match(schema, /outcome aiq_private\.result_outcome not null/);
  assert.match(schema, /constraint calibration_task_results_outcome_score check/);
  assert.match(
    schema,
    /outcome in \('invalid','missing','not_applicable'\) and task_score is null/,
  );
  assert.match(schema, /outcome='correct' and task_score is not null and task_score=1/);
  assert.match(schema, /outcome='partial'[\s\S]{0,100}task_score>0 and task_score<1/);
  assert.match(schema, /constraint calibration_task_results_failure_binding check/);
  assert.match(
    schema,
    /outcome='not_applicable'[\s\S]{0,100}failure_code='capability_unavailable'/,
  );
  assert.match(attestation, /score_entry\.value#>>'\{score,descriptive_status\}'/);
  assert.match(
    attestation,
    /normalized_outcome_from_source\([\s\S]{0,80}source_result,result_score_tier/,
  );
  assert.match(attestation, /normalized_outcome::aiq_private\.result_outcome/);
  assert.doesNotMatch(
    attestation,
    /result#>>'\{model,reasoning_effort\}',source_result->>'evaluation'/,
  );
  assert.match(
    schema,
    /foreign key \(task_set_id,task_set_version,task_id,task_version,task_hash\)[\s\S]{0,120}references aiq_private\.aiq_task_catalog/,
  );
  assert.match(
    schema,
    /task_hash text generated always as \('sha256:'::text \|\| fixture_commitment\) stored/,
  );
  assert.doesNotMatch(attestation, /percentile_disc|percentile_cont/);
  assert.match(attestation, /ordered_ms\[\(sample_count\*95\+99\)\/100\]/);
});

void test('serializes calibration decisions and gates deletion leasing on inventory', () => {
  for (const rpc of [
    'aiq_stage_calibration_verification',
    'aiq_record_calibration_attestation',
    'aiq_publish_calibration_evidence',
  ]) {
    const body =
      schema.match(new RegExp(`create function public\\.${rpc}[\\s\\S]*?\\n\\$\\$;`))?.[0] ?? '';
    assert.match(body, /pg_advisory_xact_lock/);
    assert.match(body, /aiq_submission_inbox[\s\S]*?for update/);
  }
  const deletionCore =
    schema.match(
      /create function aiq_private\.aiq_claim_storage_deletions_reference_core[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  assert.match(deletionCore, /inventory_success/);
  assert.match(deletionCore, /interval '24 hours'/);
  assert.match(deletionCore, /resolved_at is null/);
  assert.match(schema, /create function public\.aiq_record_storage_inventory_epoch/);
  assert.match(schema, /storage_registry_inventory_digest\(\)/);
  assert.match(schema, /supplied_inventory_digest is distinct from/);
  assert.match(schema, /aiq_storage_reconciliation_history_guard/);
  const deletionAck =
    schema.match(/create function public\.aiq_ack_storage_deletion[\s\S]*?\n\$\$;/)?.[0] ?? '';
  assert.match(deletionAck, /inventory-deletion-gate/);
});

void test('keeps public grants and pricing lookup indexes narrow', () => {
  assert.match(
    schema,
    /grant select\(run_id,official_eligible,ranking_eligible,published_at\)[\s\S]{0,90}calibration_publications/,
  );
  const publicationGrant =
    schema.match(/grant select\([^;]+calibration_publications to anon, authenticated;/)?.[0] ?? '';
  assert.doesNotMatch(publicationGrant, /package_sha256|publisher_node_id|classification/);
  const resultGrant =
    schema.match(
      /grant select\(result_id,[^;]+calibration_task_results to anon, authenticated;/,
    )?.[0] ?? '';
  assert.match(resultGrant, /failure_code/);
  assert.match(schema, /create index calibration_runs_pricing_idx[\s\S]{0,80}\(pricing_digest\)/);
  assert.match(schema, /create index aiq_task_results_pricing_idx[\s\S]{0,100}\(pricing_digest\)/);
  assert.match(
    schema,
    /create index calibration_runs_register_cursor_idx[\s\S]{0,100}\(started_at desc,run_id\)/,
  );
  assert.match(
    schema,
    /create index calibration_task_results_model_detail_idx[\s\S]{0,130}run_id,model_family,reasoning_effort,result_id/,
  );
  assert.match(schema, /primary key \(run_id, model_family, reasoning_effort\)/);
  assert.doesNotMatch(schema, /create index calibration_(?:model_scores|task_results)_run_idx/);
});

void test('production readiness attests the exact schema and gateway role shape', () => {
  for (const field of [
    'private_table_count',
    'forced_rls_table_count',
    'public_view_count',
    'security_invoker_view_count',
    'hardened_gateway_role_count',
  ]) {
    assert.match(schema, new RegExp(`'${field}'`));
  }
  assert.match(schema, /private_table_count=40 and forced_rls_table_count=40/);
  assert.match(schema, /public_view_count=13 and security_invoker_view_count=13/);
  assert.match(schema, /pg_catalog\.pg_has_role\('authenticator',gateway_role\.rolname,'MEMBER'\)/);
});

void test('preview readiness requires an empty calibration surface', () => {
  for (const field of [
    'calibration_run_count',
    'calibration_result_count',
    'calibration_score_count',
  ]) {
    assert.match(schema, new RegExp(`status\\.${field} = 0`));
  }
});
