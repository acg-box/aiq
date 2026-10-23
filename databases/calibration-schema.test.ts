import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const schema = await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8');

void test('accepts both provenance classes but keeps caller class gates exact', () => {
  const provenanceValidator =
    schema.match(/create function aiq_private\.run_provenance_v3_is_valid[\s\S]*?\n\$_\$;/)?.[0] ??
    '';
  const officialPackageValidator =
    schema.match(/create function aiq_private\.dto_run_provenance_is_valid[\s\S]*?\n\$_\$;/)?.[0] ??
    '';
  const officialStageValidator =
    schema.match(
      /create function aiq_private\.run_provenance_v3_matches_stage[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  const calibrationPackageValidator =
    schema.match(
      /create function aiq_private\.calibration_package_v3_is_valid[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';

  assert.match(provenanceValidator, /run_class' not in \('official', 'calibration'\)/);
  assert.match(officialPackageValidator, /run_class' <> 'official'/);
  assert.match(officialStageValidator, /stage ->> 'run_class' is distinct from 'official'/);
  assert.match(
    officialStageValidator,
    /candidate ->> 'run_class' is distinct from stage ->> 'run_class'/,
  );
  assert.match(calibrationPackageValidator, /provenance ->> 'run_class' <> 'calibration'/);
  assert.doesNotMatch(calibrationPackageValidator, /provenance ->> 'runner_node_id'/);
});

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
  assert.match(schema, /aiq\.calibration-run\.v4/);
  assert.match(schema, /local_calibration_non_official/);
  assert.match(schema, /evaluator_replayed/);
  assert.match(schema, /calibration evidence is append-only/);
  assert.doesNotMatch(
    schema.match(/create function public\.aiq_publish_calibration_evidence[\s\S]*?\n\$\$;/)?.[0] ??
      '',
    /insert into aiq_private\.aiq_(?:matrix_batches|result_packages|runs|score_snapshots)/,
  );
});

void test('compares stored task-resampling bounds at their declared precision', () => {
  assert.match(
    schema,
    /score\.task_resampling_low =\s*round\(\(score\.interval_parameters ->> 'lower'\)::numeric, 3\)/,
  );
  assert.match(
    schema,
    /score\.task_resampling_high =\s*round\(\(score\.interval_parameters ->> 'upper'\)::numeric, 3\)/,
  );
});

void test('binds the Official stage task-set hash to all catalog fixture commitments', () => {
  const stageVerifier =
    schema.match(/create function aiq_private\.stage_verifier_result_core[\s\S]*?\n\$_\$;/)?.[0] ??
    '';

  assert.match(stageVerifier, /task_set\.task_count = 72/);
  assert.match(
    stageVerifier,
    /stage ->> 'task_set_hash' = \(\s*select aiq_private\.jcs_sha256\(\s*jsonb_agg\(task_hash order by task_hash collate "C"\)\s*\)\s*from \(\s*select 'sha256:' \|\| catalog\.fixture_commitment as task_hash\s*from aiq_private\.aiq_task_catalog catalog\s*where catalog\.task_set_id = task_set\.task_set_id\s*and catalog\.task_set_version = task_set\.task_set_version\s*and catalog\.fixture_commitment is not null\s*\) catalog_hashes\s*\)/,
  );
  assert.doesNotMatch(stageVerifier, /select distinct 'sha256:' \|\| catalog\.fixture_commitment/);
  assert.doesNotMatch(
    stageVerifier,
    /\('sha256:' \|\| task_set\.catalog_sha256\) = stage ->> 'task_set_hash'/,
  );
});

void test('keeps efficiency evidence nullable, bounded, and non-Official', () => {
  const exactKeys =
    schema.match(/create function aiq_private\.has_exact_jsonb_keys[\s\S]*?\n\$\$;/i)?.[0] ?? '';
  assert.match(exactKeys, /from unnest\(expected_keys\) key/);
  assert.match(exactKeys, /observed_keys is not distinct from normalized_expected_keys/);
  assert.match(schema, /cached_input_tokens <= input_tokens/);
  assert.match(schema, /reasoning_output_tokens <= output_tokens/);
  assert.doesNotMatch(schema, /total_tokens = input_tokens \+ output_tokens/);
  assert.match(
    schema,
    /cost_estimator_status in \(\s*'estimated','unavailable_missing_usage','unavailable_invalid_usage',\s*'unavailable_context_band'\s*\)/,
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
    /\(\(descriptive_status in \('coverage_only','not_applicable'\)\) = \(quality_score is null\)\)/,
  );
  assert.match(
    schema,
    /\(standard_api_equivalent_usd_nanos is null\) = \(cost_evidence_level is null\)/,
  );
  assert.match(schema, /candidate->>'provider_tokens_evidence_level'='verifier_recomputed'/);
  assert.match(schema, /task_resampling_sensitivity_method/);
  assert.match(schema, /quality_score is null or quality_score between 0 and 100/);
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
  assert.match(
    schema,
    /attempted_result_count between 0 and result_count[\s\S]*?invoked_result_count between 0 and attempted_result_count/,
  );
  assert.match(schema, /run\.attempted_result_count,[\s\S]*?run\.invoked_result_count,/);
  assert.match(schema, /score\.attempted_result_count,[\s\S]*?score\.invoked_result_count,/);
  assert.doesNotMatch(schema, /result_count as attempted_result_count/);
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

void test('requires exact functional marker evidence only for successful capability probes', () => {
  const validator =
    schema.match(/create function aiq_private\.dto_preflight_is_valid[\s\S]*?\n\$_\$;/)?.[0] ?? '';

  assert.match(validator, /array\['stdout\.jsonl','stderr\.txt','capability-marker\.txt'\], 3/);
  assert.match(
    validator,
    /sha256:83741534dc3125175944ec8e34d515ff35682d83fba0a4cf40d32ccaaaacacf3/,
  );
  assert.match(
    validator,
    /aiq-artifact:\/\/sha256\/83741534dc3125175944ec8e34d515ff35682d83fba0a4cf40d32ccaaaacacf3\/capability-marker\.txt/,
  );
  assert.match(validator, /artifact ->> 'bytes' = '36'/);
  assert.match(validator, /probe ->> 'status' = 'available'[\s\S]*?select count\(\*\)/);
  assert.match(
    validator,
    /probe ->> 'status' = 'capability-marker\.txt'|artifact ->> 'kind' = 'capability-marker\.txt'/,
  );
});

void test('binds functional marker ingress, resolution, and retention to one exact object', () => {
  const markerDigest = '83741534dc3125175944ec8e34d515ff35682d83fba0a4cf40d32ccaaaacacf3';
  const resolver =
    schema.match(
      /create function aiq_private\.aiq_resolve_claim_artifact_reference_core[\s\S]*?\n\$_\$;/,
    )?.[0] ?? '';
  const ingress =
    schema.match(/create function public\.aiq_record_artifact_ingress[\s\S]*?\n\$_\$;/)?.[0] ?? '';
  const registration =
    schema.match(/create function aiq_private\.ensure_storage_object[\s\S]*?\n\$_\$;/)?.[0] ?? '';
  const ingressTable =
    schema.match(/create table aiq_private\.aiq_artifact_ingress_objects[\s\S]*?\n\);/)?.[0] ?? '';
  const storageTable =
    schema.match(/create table aiq_private\.aiq_storage_objects[\s\S]*?\n\);/)?.[0] ?? '';

  for (const contract of [resolver, ingress, registration, ingressTable, storageTable]) {
    assert.match(contract, /capability-marker\.txt/);
    assert.match(contract, new RegExp(markerDigest));
  }
  for (const contract of [ingress, registration, ingressTable, storageTable]) {
    assert.match(contract, /(?:byte_size|supplied_byte_size|supplied_bytes)[^\n]*36|then 36/);
  }
});

void test('binds Official efficiency evidence to the exact payload matrix', () => {
  const unbound =
    schema.match(
      /create function aiq_private\.aiq_stage_verifier_result_unbound_core[\s\S]*?\n\$_\$;/,
    )?.[0] ?? '';
  const bound =
    schema.match(/create function aiq_private\.stage_verifier_result_core[\s\S]*?\n\$_\$;/)?.[0] ??
    '';
  for (const key of ['execution_concurrency', 'result_efficiency', 'efficiency', 'pricing']) {
    assert.match(unbound, new RegExp(`'${key}'`));
  }
  assert.match(unbound, /execution_concurrency',32/);
  assert.match(unbound, /jsonb_array_length\(stage->'result_efficiency'\) is distinct from 1224/);
  assert.match(unbound, /jsonb_array_length\(stage->'efficiency'\) is distinct from 17/);
  assert.match(unbound, /efficiency_pricing_v1_is_valid\(stage->'pricing'\)/);
  assert.match(unbound, /efficiency_aggregate_matches_results/);
  assert.match(unbound, /stage ->> 'scoring_version' is distinct from '1\.0\.8'/);
  assert.match(unbound, /stage ->> 'runner_commit' ~ '\^\[0-9a-f\]\{7,40\}\$'/);
  assert.match(unbound, /safe_unsigned_integer_jsonb_is_valid\(\s*stage -> 'scheduled_unix_ms'/);
  assert.match(
    unbound,
    /\(stage ->> 'finished_unix_ms'\)::numeric\s*< \(stage ->> 'started_unix_ms'\)::numeric/,
  );
  assert.doesNotMatch(bound, /efficiency_aggregate_matches_results/);
  assert.doesNotMatch(bound, /result_efficiency_v1_is_valid/);
  assert.doesNotMatch(bound, /jsonb_array_length\(stage->'result_efficiency'\)/);
  assert.equal(
    schema.match(/return aiq_private\.stage_verifier_result_core\(stage\);/g)?.length,
    1,
  );
  assert.match(
    schema,
    /revoke all on function aiq_private\.stage_verifier_result_core\(stage jsonb\) from PUBLIC/,
  );
  assert.match(
    bound,
    /payload -> 'execution_concurrency' is distinct from stage -> 'execution_concurrency'/,
  );
  assert.match(bound, /jsonb_object_agg\(result ->> 'result_id', result\)/);
  assert.match(bound, /jsonb_object_agg\(evidence ->> 'source_result_id', evidence\)/);
  assert.match(bound, /signed_results_by_id #>> array\[/);
  assert.match(bound, /result_efficiency_by_id -> \(value->>'source_result_id'\)/);
  assert.doesNotMatch(bound, /join jsonb_array_elements\(payload->'results'\) source/);
  assert.match(bound, /evidence->'provider_tokens'<>'\{\}'::jsonb/);
  assert.match(bound, /insert into aiq_private\.efficiency_official_models/);
  for (const category of [
    'input',
    'cached_input',
    'cache_write_input',
    'output',
    'reasoning',
    'total',
  ]) {
    assert.match(bound, new RegExp(`provider_token_coverage,${category}_tasks`));
    assert.match(schema, new RegExp(`${category}_token_observed_result_count integer not null`));
  }
  assert.match(bound, /verified\.evidence->>'provider_tokens_evidence_level'/);
  assert.match(
    schema,
    /observed_median_wall_ms::text is not distinct from[\s\S]{0,80}efficiency_record->>'median_observed_wall_ms'/,
  );

  const view = schema.match(/CREATE VIEW public\.public_model_efficiency[\s\S]*?;\n/)?.[0] ?? '';
  assert.match(view, /from aiq_private\.efficiency_official_models efficiency/);
  assert.match(view, /run\.matrix_batch_id/);
  assert.match(
    view,
    /extract\(epoch from \(run\.completed_at-run\.started_at\)\)\*1000[\s\S]{0,80}as matrix_batch_elapsed_ms/,
  );
  assert.match(view, /efficiency\.observed_total_wall_ms as summed_cell_adapter_elapsed_ms/);
  assert.match(schema, /grant select\(matrix_batch_id\) on table aiq_private\.aiq_runs to anon;/);
  assert.match(
    schema,
    /grant select\(matrix_batch_id\) on table aiq_private\.aiq_runs to authenticated;/,
  );
  assert.doesNotMatch(view, /efficiency\.observed_total_wall_ms(?:,|\s+from)/);
  for (const category of [
    'input',
    'cached_input',
    'cache_write_input',
    'output',
    'reasoning',
    'total',
  ]) {
    assert.match(view, new RegExp(`${category}_token_coverage_count`));
    assert.match(view, new RegExp(`${category}_token_coverage_percent`));
  }
  assert.match(view, /pricing\.rates as pricing_rates/);
  assert.match(view, /pricing\.formula as cost_formula/);
  assert.doesNotMatch(view, /percentile_disc|percentile_cont/);
});

void test('publishes narrow Official per-result efficiency without private payload fields', () => {
  const view = schema.match(/create view public\.public_run_results[\s\S]*?;\n/)?.[0] ?? '';
  for (const field of [
    'task_id',
    'latency_evidence_level',
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
    'token_usage_evidence_level',
    'standard_api_equivalent_usd_nanos',
    'cost_estimator_status',
    'cost_evidence_level',
    'pricing_digest',
  ]) {
    assert.match(view, new RegExp(`result\\.${field}`));
  }
  assert.match(view, /join aiq_private\.aiq_runs run on \(\(run\.run_id = result\.run_id\)\)/);
  assert.match(view, /where run\.published/);
  assert.match(view, /\(result\.outcome\)::text as outcome/);
  assert.match(view, /'incorrect'::aiq_private\.result_outcome[\s\S]{0,40}then 'completed'::text/);
  assert.match(
    view,
    /'wrong_artifact'::aiq_private\.result_outcome[\s\S]{0,40}then 'runtime_issue'::text/,
  );
  assert.match(
    view,
    /when result\.outcome in \('correct','partial','incorrect'\) then result\.task_score[\s\S]{0,50}else null::numeric[\s\S]{0,20}as score/,
    'Runtime outcomes must be null in the public run result score field.',
  );
  assert.match(view, /end as execution_status/);
  assert.doesNotMatch(view, /as status|then 'passed'::text|then 'failed'::text/);
  assert.doesNotMatch(
    view,
    /failure_detail|result\.usage|provenance|response_sha256|result_package_sha256/,
  );
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
  assert.match(
    schema,
    /outcome in \([\s\S]{0,100}'timeout','budget_exhausted','tool_failure','policy_failure','wrong_artifact'[\s\S]{0,100}task_score is null/,
  );
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

void test('exposes the Official prompt-set digest in canonical sha256 form', () => {
  const publicRuns = schema.match(/create view public\.public_runs[\s\S]*?;\n/)?.[0] ?? '';

  assert.match(publicRuns, /\('sha256:'::text \|\| run\.prompt_set_digest\) as prompt_set_digest/);
  assert.doesNotMatch(publicRuns, /^\s+run\.prompt_set_digest,/m);
  for (const count of [
    'correct_count',
    'partial_count',
    'incorrect_count',
    'runtime_issue_count',
    'invalid_count',
    'missing_count',
    'not_applicable_count',
    'completed_count',
  ]) {
    assert.match(publicRuns, new RegExp(`result_summary\\.${count}`));
  }
  assert.doesNotMatch(publicRuns, /passed_count|failed_count/);
});
