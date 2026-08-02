import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const schema = await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8');

test('keeps calibration evidence separate from Official publication tables', () => {
  for (const table of [
    'calibration_verification_stages',
    'calibration_runs',
    'calibration_model_scores',
    'calibration_task_results',
    'calibration_verification_audit',
    'calibration_publications',
    'efficiency_pricing_methods',
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

test('exposes only published sanitized calibration columns', () => {
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
    'failure_code',
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
});

test('separates verifier and publisher RPC authority', () => {
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

test('keeps efficiency evidence nullable, bounded, and non-Official', () => {
  assert.match(schema, /cached_input_tokens <= input_tokens/);
  assert.match(schema, /reasoning_output_tokens <= output_tokens/);
  assert.doesNotMatch(schema, /total_tokens = input_tokens \+ output_tokens/);
  assert.match(
    schema,
    /cost_estimator_status in \('estimated','unavailable_missing_usage','unavailable_invalid_usage'\)/,
  );
  assert.match(schema, /standard_api_equivalent_usd_nanos bigint/);
  assert.match(schema, /per_request_long_context_unknown/);
  assert.doesNotMatch(schema, /actual_subscription_spend_usd numeric/);
  assert.match(schema, /duration_evidence_level = 'runner_observed'/);
  assert.match(schema, /token_usage_evidence_level = 'provider_reported'/);
  assert.match(schema, /cost_evidence_level = 'verifier_recomputed'/);
  assert.match(schema, /scored_result_count between 0 and result_count/);
  assert.match(
    schema,
    /\(\(descriptive_status in \('coverage_only','not_applicable'\)\) = \(score is null\)\)/,
  );
  assert.match(
    schema,
    /estimated_cost_sample_count=efficiency\.result_count[\s\S]{0,100}then efficiency\.standard_api_equivalent_usd_nanos/,
  );
  assert.match(schema, /result\.latency_evidence_level='runner_observed'/);
  assert.match(schema, /task_resampling_sensitivity_method/);
  assert.match(schema, /score is null or score between 0 and 100/);
});

test('preview readiness requires an empty calibration surface', () => {
  for (const field of [
    'calibration_run_count',
    'calibration_result_count',
    'calibration_score_count',
  ]) {
    assert.match(schema, new RegExp(`status\\.${field} = 0`));
  }
});
