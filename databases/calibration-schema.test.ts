import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const schema = await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8');
const calibrationIntegration = await readFile(
  resolve(import.meta.dirname, 'calibration-integration.sql'),
  'utf8',
);
const stateIntegration = await readFile(resolve(import.meta.dirname, 'integration.sql'), 'utf8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

void test('escapes every regular-expression metacharacter', () => {
  assert.equal(escapeRegExp('a.b(c)[d]\\e'), 'a\\.b\\(c\\)\\[d\\]\\\\e');
});

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

void test('runs calibration against the production initializer catalog authority', () => {
  const catalogAuthority =
    schema.match(/create function aiq_private\.task_catalog_is_exact[\s\S]*?\n\$\$;/i)?.[0] ?? '';

  assert.match(calibrationIntegration, /task_catalog_is_exact\('aiq-core','1\.0\.6'\)/);
  assert.match(calibrationIntegration, /'calibration_admission_digest',null/);
  assert.match(calibrationIntegration, /'calibration_bank',null/);
  assert.match(calibrationIntegration, /'terminal_attempt_lineage',terminal_attempt_lineage/);
  assert.match(calibrationIntegration, /'terminal_attempt_lineage_digest',aiq_private\.jcs_sha256/);
  assert.match(
    schema,
    /stage ->> 'terminal_attempt_lineage_digest' is distinct from[\s\S]*payload -> 'terminal_attempt_lineage'/,
  );
  assert.match(
    schema,
    /attestation ->> 'terminal_attempt_lineage_digest' is distinct from[\s\S]*stage ->> 'terminal_attempt_lineage_digest'/,
  );
  assert.match(
    catalogAuthority,
    /frozen_catalog_identity_is_valid\([\s\S]*target_task_set_version, '1\.0\.7'/,
  );
  assert.doesNotMatch(calibrationIntegration, /update aiq_private\.aiq_task_catalog/);
  assert.doesNotMatch(calibrationIntegration, /insert into aiq_private\.aiq_task_catalog/);
});

void test('uses the canonical private Storage identities in every SQL integration fixture', () => {
  for (const fixture of [calibrationIntegration, stateIntegration]) {
    assert.doesNotMatch(fixture, /integration-private-(?:submissions|artifacts)/);
    assert.match(fixture, /aiq-submission-packages/);
    assert.match(fixture, /aiq-runner-artifacts/);
  }
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
  for (const field of [
    'outcome',
    'execution_status',
    'failure_code',
    'explanation_code',
    'explanation_summary',
  ]) {
    assert.match(publicResults, new RegExp(field));
  }
  assert.match(
    publicResults,
    /when result\.outcome in \('correct','partial','incorrect'\) then 'completed'/,
  );
  assert.match(
    publicResults,
    /'timeout','budget_exhausted','tool_failure','policy_failure','wrong_artifact'[\s\S]{0,40}then 'runtime_issue'/,
  );
  assert.match(
    publicResults,
    /when result\.outcome in \('correct','partial','incorrect'\) then result\.task_score[\s\S]{0,50}else null::numeric[\s\S]{0,20}as task_score/,
    'Runtime outcomes must be null in the public calibration result score field.',
  );
  assert.match(publicResults, /when result\.outcome='not_applicable' then 'not_applicable'/);
  assert.doesNotMatch(publicResults, /as status|then 'passed'|then 'failed'/);
});

void test('publishes leaderboard runtime issues without merging semantic incorrect outcomes', () => {
  const leaderboard = schema.match(/create view public\.public_leaderboard[\s\S]*?;\n/)?.[0] ?? '';

  assert.match(leaderboard, /as runtime_issue_count/);
  assert.match(leaderboard, /then runtime_issue_count[\s\S]{0,80}as runtime_issues/);
  assert.match(
    leaderboard,
    /'timeout'::aiq_private\.result_outcome[\s\S]*?'wrong_artifact'::aiq_private\.result_outcome/,
  );
  assert.doesNotMatch(leaderboard, /'incorrect'::aiq_private\.result_outcome/);
  assert.doesNotMatch(leaderboard, /failure_count|as failures/);
  assert.match(leaderboard, /then score[\s\S]{0,80}as score/);
  assert.match(leaderboard, /as quality_score/);
  assert.match(leaderboard, /as strict_pass_rate/);
  assert.match(leaderboard, /task_score is not null\) as strict_pass_sample_size/);
  assert.match(leaderboard, /task_score = 1\) as strict_pass_successes/);
  assert.match(leaderboard, /as calibration_status/);
  assert.match(leaderboard, /as public_score_status/);
  assert.match(leaderboard, /then valid_task_count[\s\S]{0,80}as sample_size/);
  assert.match(
    leaderboard,
    /valid_task_count[\s\S]{0,80}expected_task_count[\s\S]{0,80}as coverage_percent/,
  );
});

void test('names public task-mix ranges as sensitivity, not confidence intervals', () => {
  const leaderboard = schema.match(/create view public\.public_leaderboard[\s\S]*?;\n/)?.[0] ?? '';
  const trend =
    schema.match(/create function public\.public_trend_points[\s\S]*?\n\$\$;/)?.[0] ?? '';
  const scoringVersions =
    schema.match(/create view public\.public_scoring_versions[\s\S]*?;\n/)?.[0] ?? '';

  for (const publicContract of [leaderboard, trend]) {
    assert.match(publicContract, /sensitivity_low/);
    assert.match(publicContract, /sensitivity_high/);
    assert.match(publicContract, /theta_ci_low/);
    assert.match(publicContract, /theta_ci_high/);
    assert.match(publicContract, /score_ci_low/);
    assert.match(publicContract, /score_ci_high/);
    assert.match(
      publicContract,
      /outcome in \('correct','partial','incorrect'\)[\s\S]{0,100}task_score is not null/,
      'Strict-pass public samples must use semantic task outcomes only.',
    );
  }
  assert.match(schema, /Sensitivity ranges are not inferential confidence intervals/);
  assert.match(scoringVersions, /confidence_policy as sensitivity_policy/);
  assert.doesNotMatch(scoringVersions, /\n    confidence_policy,/);
  assert.match(
    schema,
    /comment on function public\.public_trend_points\(text\) IS '[^']*do not provide inferential confidence coverage[^']*';/,
  );
  assert.match(
    schema,
    /comment on view public\.public_leaderboard IS '[^']*not inferential confidence intervals[^']*';/,
  );
  assert.match(
    schema,
    /comment on view public\.public_scoring_versions IS '[^']*does not claim inferential confidence coverage[^']*';/,
  );
});

void test('separates verifier and publisher RPC authority', () => {
  for (const rpc of [
    'aiq_stage_calibration_verification(jsonb,uuid,uuid,integer)',
    'aiq_record_calibration_attestation(jsonb,uuid,uuid,integer)',
  ]) {
    assert.match(
      schema,
      new RegExp(
        `grant execute on function public\\.${escapeRegExp(rpc)}[\\s\\S]{0,80}to aiq_verifier`,
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

void test('bounds the full Official staging and publication RPCs', () => {
  const stageFunction =
    schema.match(
      /create function public\.aiq_stage_verifier_result\(stage jsonb,[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  const publishFunction =
    schema.match(/create function public\.aiq_verify_and_publish\([\s\S]*?\n\$\$;/)?.[0] ?? '';

  assert.match(stageFunction, /SET search_path to ''\n    SET statement_timeout to '110s'/);
  assert.match(publishFunction, /SET search_path to ''\n    SET statement_timeout to '110s'/);
  assert.equal(schema.match(/SET statement_timeout to '110s'/g)?.length, 2);
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

void test('accepts only the fixed Standard-tier pricing record', () => {
  const validator =
    schema.match(
      /create function aiq_private\.efficiency_pricing_v1_is_valid[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
  for (const literal of [
    'standard_api_equivalent_text_token_estimate',
    'aiq.standard-api-equivalent-usd.v1',
    '2026-08-02',
    'https://developers.openai.com/api/docs/pricing',
    'Regional processing uplift and hosted tool fees are excluded.',
    "candidate->>'currency'='USD'",
    "candidate->>'processing_tier'='standard'",
    'This is not actual subscription spend.',
  ]) {
    assert.ok(validator.includes(literal), `missing fixed pricing literal: ${literal}`);
  }
  for (const rate of [
    ["'gpt-5.6-sol'", '5000', '500', '6250', '30000'],
    ["'gpt-5.6-terra'", '2000', '200', '2500', '12000'],
    ["'gpt-5.6-luna'", '200', '20', '250', '1200'],
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
  assert.match(
    schema,
    /if input_tokens>272000\s*then return candidate->>'cost_status'='unavailable_context_band'/,
  );
  assert.match(validator, /Prompts above 272000 input tokens use 2x input and 1\.5x output rates/);
});

void test('accepts the paid workspace-integrity adapter failure kind', () => {
  const validator =
    schema.match(
      /create function aiq_private\.dto_adapter_failure_is_valid[\s\S]*?\n\$_\$;/,
    )?.[0] ?? '';

  assert.match(
    validator,
    /'non_zero_exit','budget_exceeded','output_truncated','workspace_integrity'/,
  );
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

void test('keeps public grants and pricing lookup indexes narrow', () => {
  const runGrant =
    schema.match(
      /grant select\(run_id,classification,[^;]+calibration_runs to anon, authenticated;/,
    )?.[0] ?? '';
  assert.match(runGrant, /task_set_id,task_set_version,scoring_version/);
  assert.match(
    schema,
    /grant select\(micro_accuracy,micro_wilson_low,micro_wilson_high\)[\s\S]{0,80}aiq_score_snapshots to anon, authenticated/,
  );
  assert.match(
    schema,
    /grant select\(failure_responsibility\)[\s\S]{0,80}aiq_task_results to anon, authenticated/,
  );
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

void test('binds calibration public pricing joins to one explicit evidence digest', () => {
  const resultView =
    schema.match(/CREATE VIEW public\.public_calibration_results[\s\S]*?;\n/)?.[0] ?? '';
  const scoreView =
    schema.match(/CREATE VIEW public\.public_calibration_scores[\s\S]*?;\n/)?.[0] ?? '';

  assert.match(
    resultView,
    /run\.run_id=result\.run_id and run\.pricing_digest=result\.pricing_digest/,
  );
  assert.match(resultView, /pricing\.pricing_digest=result\.pricing_digest/);
  assert.match(resultView, /publication\.run_id=result\.run_id/);
  assert.doesNotMatch(resultView, /using \((?:pricing_digest|run_id)\)/);
  assert.match(
    scoreView,
    /run\.run_id=score\.run_id and run\.pricing_digest=score\.pricing_digest/,
  );
  assert.match(scoreView, /pricing\.pricing_digest=score\.pricing_digest/);
  assert.match(scoreView, /publication\.run_id=score\.run_id/);
  assert.doesNotMatch(scoreView, /using \((?:pricing_digest|run_id)\)/);
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

void test('production readiness attests the exact schema and gateway role shape', () => {
  for (const field of [
    'task_set_identity_sha256',
    'task_set_identity_valid',
    'evaluator_identity_sha256',
    'evaluator_identity_valid',
    'private_table_count',
    'forced_rls_table_count',
    'public_view_count',
    'security_invoker_view_count',
    'hardened_gateway_role_count',
  ]) {
    assert.match(schema, new RegExp(`'${field}'`));
  }
  assert.match(schema, /private_table_count=40 and forced_rls_table_count=40/);
  assert.match(schema, /public_view_count=12 and security_invoker_view_count=12/);
  assert.match(schema, /canonical_public_view_count=12/);
  assert.match(
    schema,
    /scoring\.formula = '\{[\s\S]*?"aggregate":"rasch_fractional_fixed_bank_map_v2"[\s\S]*?"measurement_method":"rasch_fractional_fixed_bank_map_v2"[\s\S]*?"measurement_version":"2\.0\.0"[\s\S]*?\}'::jsonb/,
  );
  assert.doesNotMatch(
    schema,
    /scoring\.formula = '\{[\s\S]*?"aggregate":"mean_of_domain_means"[\s\S]*?\}'::jsonb/,
  );
  assert.match(
    schema,
    /where namespace\.nspname='public' and relation\.relkind='v'\s+and relation\.relname in \([\s\S]*?'public_model_efficiency'[\s\S]*?\)/,
  );
  assert.match(
    schema,
    /task_set_identity_sha256 =\s*'sha256:768a9322f22c5be4d0fcd67dbe4360bd78392c7d0ef47ee9c0b8cedea2374dda'/,
  );
  assert.match(
    schema,
    /evaluator_identity_sha256 =\s*'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c'/,
  );
  assert.match(schema, /pg_catalog\.pg_has_role\('authenticator',gateway_role\.rolname,'MEMBER'\)/);
});
