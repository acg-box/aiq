\set ON_ERROR_STOP on

-- This integration check is for a disposable fresh database only.
-- Apply schema.sql and synthetic-demo.sql before this file.

begin;

do $$
begin
  execute format('grant aiq_verifier, aiq_publisher to %I', current_user);
end;
$$;

create or replace function pg_temp.aiq_assert(condition boolean, message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if condition is distinct from true then
    raise exception 'integration assertion failed: %', message;
  end if;
end;
$$;

select pg_temp.aiq_assert(
  (
    select routine.proconfig @> array['search_path=""', 'statement_timeout=110s']::text[]
      and cardinality(routine.proconfig) = 2
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and routine.proname = 'aiq_stage_verifier_result'
      and pg_catalog.pg_get_function_identity_arguments(routine.oid) =
        'stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer'
  ),
  'Official staging must have exactly the bounded 110-second function timeout'
);
select pg_temp.aiq_assert(
  (
    select routine.proconfig @> array['search_path=""', 'statement_timeout=110s']::text[]
      and cardinality(routine.proconfig) = 2
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and routine.proname = 'aiq_verify_and_publish'
      and pg_catalog.pg_get_function_identity_arguments(routine.oid) =
        'target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer'
  ),
  'Official publication must have exactly the bounded 110-second function timeout'
);
select pg_temp.aiq_assert(
  not exists (
    select 1
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    where routine.proconfig @> array['statement_timeout=110s']::text[]
      and not (
        namespace.nspname = 'public' and (
          (
            routine.proname = 'aiq_stage_verifier_result'
            and pg_catalog.pg_get_function_identity_arguments(routine.oid) =
              'stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer'
          ) or (
            routine.proname = 'aiq_verify_and_publish'
            and pg_catalog.pg_get_function_identity_arguments(routine.oid) =
              'target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer'
          )
        )
      )
  ),
  'Official timeout overrides must not widen to another database function'
);

select pg_temp.aiq_assert(
  aiq_private.has_exact_jsonb_keys('{"a":1,"b":2}'::jsonb,array['b','a']::text[]),
  'exact JSON object keys must not depend on caller order or database collation'
);
select pg_temp.aiq_assert(
  not aiq_private.has_exact_jsonb_keys('{"a":1,"b":2}'::jsonb,array['a','a','b']::text[]),
  'exact JSON object keys must reject duplicate expected keys'
);

create or replace function pg_temp.aiq_efficiency_pricing()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'method', 'standard_api_equivalent_text_token_estimate',
    'version', 'aiq.standard-api-equivalent-usd.v1',
    'as_of', '2026-08-02',
    'source', 'https://developers.openai.com/api/docs/pricing',
    'currency', 'USD',
    'processing_tier', 'standard',
    'rates', jsonb_build_array(
      jsonb_build_object(
        'model', 'gpt-5.6-sol',
        'input_usd_nanos_per_token', 5000,
        'cached_input_usd_nanos_per_token', 500,
        'cache_write_input_usd_nanos_per_token', 6250,
        'output_usd_nanos_per_token', 30000
      ),
      jsonb_build_object(
        'model', 'gpt-5.6-terra',
        'input_usd_nanos_per_token', 2000,
        'cached_input_usd_nanos_per_token', 200,
        'cache_write_input_usd_nanos_per_token', 2500,
        'output_usd_nanos_per_token', 12000
      ),
      jsonb_build_object(
        'model', 'gpt-5.6-luna',
        'input_usd_nanos_per_token', 200,
        'cached_input_usd_nanos_per_token', 20,
        'cache_write_input_usd_nanos_per_token', 250,
        'output_usd_nanos_per_token', 1200
      )
    ),
    'formula', '(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again',
    'hosted_tool_fees_included', false,
    'limitation', 'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing'
  );
$$;

select pg_temp.aiq_assert(
  aiq_private.dto_adapter_failure_is_valid(jsonb_build_object(
    'artifacts', '[]'::jsonb,
    'exit_code', 0,
    'kind', 'workspace_integrity',
    'message', 'post-invocation output evidence retention failed',
    'stderr', '',
    'stderr_truncated', false,
    'stdout_truncated', false
  )),
  'adapter failure must accept the paid workspace-integrity classification'
);

select pg_temp.aiq_assert(
  aiq_private.result_efficiency_v1_is_valid(jsonb_build_object(
    'cost_evidence_level', null,
    'cost_status', 'unavailable_context_band',
    'model', jsonb_build_object('family', 'luna', 'reasoning_effort', 'low'),
    'observed_wall_ms', 1,
    'provider_tokens', jsonb_build_object(
      'input', 272001,
      'cached_input', 0,
      'cache_write_input', 0,
      'output', 0
    ),
    'provider_tokens_evidence_level', 'verifier_recomputed',
    'provider_tokens_source', 'provider_reported',
    'source_result_id', 'result_' || repeat('a', 64),
    'standard_api_equivalent_usd_nanos', null,
    'task_id', 'coding-01',
    'wall_time_evidence_level', 'runner_observed'
  )),
  'aggregate input above 272000 must use the unavailable context-band shape'
);

select pg_temp.aiq_assert(
  aiq_private.result_efficiency_v1_is_valid(jsonb_build_object(
    'cost_evidence_level', 'verifier_recomputed',
    'cost_status', 'estimated',
    'model', jsonb_build_object('family', 'luna', 'reasoning_effort', 'low'),
    'observed_wall_ms', 1,
    'provider_tokens', jsonb_build_object(
      'input', 272000,
      'cached_input', 0,
      'cache_write_input', 0,
      'output', 0
    ),
    'provider_tokens_evidence_level', 'verifier_recomputed',
    'provider_tokens_source', 'provider_reported',
    'source_result_id', 'result_' || repeat('b', 64),
    'standard_api_equivalent_usd_nanos', 54400000,
    'task_id', 'coding-01',
    'wall_time_evidence_level', 'runner_observed'
  )),
  'the exact 272000 short-context boundary must remain priced'
);

select pg_temp.aiq_assert(
  not aiq_private.result_efficiency_v1_is_valid(jsonb_build_object(
    'cost_evidence_level', 'verifier_recomputed',
    'cost_status', 'unavailable_context_band',
    'model', jsonb_build_object('family', 'luna', 'reasoning_effort', 'low'),
    'observed_wall_ms', 1,
    'provider_tokens', jsonb_build_object(
      'input', 272001,
      'cached_input', 0,
      'cache_write_input', 0,
      'output', 0
    ),
    'provider_tokens_evidence_level', 'verifier_recomputed',
    'provider_tokens_source', 'provider_reported',
    'source_result_id', 'result_' || repeat('c', 64),
    'standard_api_equivalent_usd_nanos', 1,
    'task_id', 'coding-01',
    'wall_time_evidence_level', 'runner_observed'
  )),
  'unavailable context-band evidence must not retain a cost or cost authority'
);

-- Build one valid signed-package shape for the ingress and lease checks. The
-- signature is structural test data; this check does not claim cryptographic
-- verification.
create or replace function pg_temp.aiq_ingress_envelope()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  models jsonb := '[
    {"family":"sol","reasoning_effort":"low"},
    {"family":"sol","reasoning_effort":"medium"},
    {"family":"sol","reasoning_effort":"high"},
    {"family":"sol","reasoning_effort":"xhigh"},
    {"family":"sol","reasoning_effort":"max"},
    {"family":"sol","reasoning_effort":"ultra"},
    {"family":"terra","reasoning_effort":"low"},
    {"family":"terra","reasoning_effort":"medium"},
    {"family":"terra","reasoning_effort":"high"},
    {"family":"terra","reasoning_effort":"xhigh"},
    {"family":"terra","reasoning_effort":"max"},
    {"family":"terra","reasoning_effort":"ultra"},
    {"family":"luna","reasoning_effort":"low"},
    {"family":"luna","reasoning_effort":"medium"},
    {"family":"luna","reasoning_effort":"high"},
    {"family":"luna","reasoning_effort":"xhigh"},
    {"family":"luna","reasoning_effort":"max"}
  ]'::jsonb;
  slot jsonb := '{
    "local_date":"2026-07-27",
    "occurrence":"day",
    "local_time":"15:00",
    "timezone":"Etc/UTC"
  }'::jsonb;
  task_set_hash text;
  run_id text;
  results jsonb := '[]'::jsonb;
  payload jsonb;
  result_base jsonb;
  response_digest text := 'sha256:' || encode(
    extensions.digest(convert_to('ok', 'utf8'), 'sha256'), 'hex'
  );
  evaluator_digest text := 'sha256:' || encode(
    extensions.digest(convert_to('integration-evaluator', 'utf8'), 'sha256'),
    'hex'
  );
  public_key text := repeat('11', 32);
  node_id text := 'node_' || encode(
    extensions.digest(decode(public_key, 'hex'), 'sha256'), 'hex'
  );
  model jsonb;
  task aiq_private.aiq_task_catalog%rowtype;
begin
  select aiq_private.jcs_sha256(jsonb_agg(task_hash order by task_hash collate "C"))
  into strict task_set_hash
  from (
    select 'sha256:' || catalog_task.fixture_commitment as task_hash
    from aiq_private.aiq_task_catalog catalog_task
    where catalog_task.task_set_id = 'aiq-core'
      and catalog_task.task_set_version = '1.0.3'
  ) hashes;
  run_id := 'run_' || substr(aiq_private.jcs_sha256(jsonb_build_object(
    'schema_version', 'aiq.run-identity.v1',
    'slot', slot,
    'task_set_hash', task_set_hash,
    'models', models,
    'scoring_version', '1.0.3'
  )), 8);

  for task in
    select * from aiq_private.aiq_task_catalog
    where task_set_id = 'aiq-core' and task_set_version = '1.0.3'
    order by task_id
  loop
    for model in select value from jsonb_array_elements(models) loop
      result_base := jsonb_build_object(
        'schema_version', 'aiq.result.v2',
        'run_id', run_id,
        'task_id', task.task_id,
        'task_version', task.task_version,
        'task_hash', 'sha256:' || task.fixture_commitment,
        'model', model,
        'status', 'completed',
        'evaluation', 'correct',
        'task_score', 1.0,
        'response', 'ok',
        'response_sha256', response_digest,
        'evaluator_result_sha256', evaluator_digest,
        'evaluator_stdout_sha256', 'null'::jsonb,
        'artifacts', '[]'::jsonb,
        'failure', 'null'::jsonb,
        'latency', jsonb_build_object('wall_ms', 1),
        'tool_usage', jsonb_build_object(
          'steps', 0, 'total_calls', 0, 'by_tool', '{}'::jsonb
        ),
        'workspace_manifest', 'null'::jsonb,
        'provenance', jsonb_build_object(
          'node_id', node_id,
          'runner_version', '1.0.0',
          'codex_version', 'synthetic',
          'observed_at', 'synthetic',
          'synthetic', true,
          'local_trust', 'untrusted'
        )
      );
      results := results || jsonb_build_array(
        result_base || jsonb_build_object(
          'result_id',
          'result_' || substr(aiq_private.jcs_sha256(
            result_base || jsonb_build_object('result_id', '')
          ), 8)
        )
      );
    end loop;
  end loop;

  payload := jsonb_build_object(
    'schema_version', 'aiq.run.v3',
    'run_id', run_id,
    'schedule_slot', slot,
    'task_set_hash', task_set_hash,
    'scoring_version', '1.0.3',
    'models', models,
    'execution_concurrency', 1,
    'started_unix_ms', 1785164400000,
    'finished_unix_ms', 1785164400001,
    'synthetic', true,
    'capability_validation', 'null'::jsonb,
    'provenance', 'null'::jsonb,
    'evaluator_results_artifact', jsonb_build_object(
      'kind', 'evaluator-results.json',
      'content_hash', evaluator_digest,
      'uri', 'aiq-artifact://sha256/' || substr(evaluator_digest, 8)
        || '/evaluator-results.json',
      'bytes', 1
    ),
    'results', results
  );
  return jsonb_build_object(
    'schema_version', 'aiq.result-package.v3',
    'idempotency_key', run_id,
    'payload_type', 'aiq.run.v3',
    'content_hash', aiq_private.jcs_sha256(payload),
    'signer', jsonb_build_object(
      'node_id', node_id, 'public_key', public_key
    ),
    'claimed_trust', 'untrusted',
    'payload', payload,
    'signature', repeat('ab', 64)
  );
end;
$$;

create or replace function pg_temp.aiq_normalized_stage(
  envelope jsonb,
  package_sha256 text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  payload jsonb := envelope -> 'payload';
  batch_id text := payload ->> 'run_id';
  child_id text;
  model aiq_private.aiq_model_configs%rowtype;
  model_identity jsonb;
  normalized_results jsonb;
  domain_scores jsonb;
  runs jsonb := '[]'::jsonb;
  result_efficiency jsonb;
  efficiency jsonb;
  binary_wilson_lower numeric;
  binary_wilson_upper numeric;
  z numeric := 1.959963984540054;
  sample_count numeric := 72;
begin
  binary_wilson_lower := (
    1 + (z * z) / (2 * sample_count)
      - z * sqrt((z * z) / (4 * sample_count * sample_count))
  ) / (1 + (z * z) / sample_count);
  binary_wilson_upper := 1;

  select jsonb_agg(
    jsonb_build_object(
      'cost_evidence_level', null,
      'cost_status', 'unavailable_missing_usage',
      'model', source.value -> 'model',
      'observed_wall_ms', null,
      'provider_tokens', '{}'::jsonb,
      'provider_tokens_evidence_level', null,
      'provider_tokens_source', null,
      'source_result_id', source.value ->> 'result_id',
      'standard_api_equivalent_usd_nanos', null,
      'task_id', source.value ->> 'task_id',
      'wall_time_evidence_level', null
    )
    order by source.value -> 'model', source.value ->> 'task_id'
  ) into result_efficiency
  from jsonb_array_elements(payload -> 'results') source(value);

  select jsonb_agg(
    jsonb_build_object(
      'schema_version', 'aiq.calibration-efficiency.v1',
      'model', jsonb_build_object(
        'family', expected.model_family,
        'reasoning_effort', expected.reasoning_effort
      ),
      'selected_tasks', 72,
      'observed_wall_tasks', 0,
      'total_observed_wall_ms', null,
      'median_observed_wall_ms', null,
      'p95_observed_wall_ms', null,
      'provider_token_totals', '{}'::jsonb,
      'provider_token_coverage', jsonb_build_object(
        'selected_tasks', 72,
        'input_tasks', 0,
        'cached_input_tasks', 0,
        'cache_write_input_tasks', 0,
        'output_tasks', 0,
        'reasoning_tasks', 0,
        'total_tasks', 0
      ),
      'estimated_cost_tasks', 0,
      'standard_api_equivalent_usd_nanos', null
    ) order by expected.matrix_order
  ) into efficiency
  from aiq_private.aiq_model_configs expected
  where expected.expected_in_matrix;

  select jsonb_agg(
    jsonb_build_object('domain', catalog.domain, 'score', 1)
    order by catalog.domain
  ) into domain_scores
  from (
    select distinct task.domain
    from aiq_private.aiq_task_catalog task
    where task.task_set_id = 'aiq-core' and task.task_set_version = '1.0.3'
  ) catalog;

  for model in
    select * from aiq_private.aiq_model_configs
    where expected_in_matrix order by matrix_order
  loop
    model_identity := jsonb_build_object(
      'family', model.model_family,
      'reasoning_effort', model.reasoning_effort
    );
    child_id := 'run_' || encode(
      extensions.digest(
        convert_to(
          'aiq.model-run-identity.v1' || chr(10)
          || batch_id || chr(10) || model.model_config_id,
          'utf8'
        ),
        'sha256'
      ),
      'hex'
    );
    select jsonb_agg(
      jsonb_build_object(
        'schema_version', 'aiq.normalized-result.v1',
        'matrix_batch_id', batch_id,
        'run_id', child_id,
        'source_result_id', source.value ->> 'result_id',
        'task_id', source.value ->> 'task_id',
        'task_version', source.value ->> 'task_version',
        'task_hash', source.value ->> 'task_hash',
        'model', source.value -> 'model',
        'domain', task.domain,
        'scorer_version', task.scorer_version,
        'source_status', source.value ->> 'status',
        'source_evaluation', source.value ->> 'evaluation',
        'outcome', 'correct',
        'task_score', source.value -> 'task_score',
        'failure', source.value -> 'failure',
        'failure_responsibility', null,
        'response', source.value -> 'response',
        'response_sha256', source.value -> 'response_sha256',
        'evaluator_stdout_sha256', source.value -> 'evaluator_stdout_sha256',
        'artifacts', source.value -> 'artifacts',
        'latency', source.value -> 'latency',
        'tool_usage', source.value -> 'tool_usage',
        'provenance', source.value -> 'provenance'
      ) order by source.value ->> 'task_id'
    ) into normalized_results
    from jsonb_array_elements(payload -> 'results') source(value)
    join aiq_private.aiq_task_catalog task
      on task.task_set_id = 'aiq-core'
      and task.task_set_version = '1.0.3'
      and task.task_id = source.value ->> 'task_id'
      and task.task_version = source.value ->> 'task_version'
    where source.value -> 'model' = model_identity;

    runs := runs || jsonb_build_array(jsonb_build_object(
      'schema_version', 'aiq.normalized-model-run.v1',
      'matrix_batch_id', batch_id,
      'run_id', child_id,
      'model_config_id', model.model_config_id,
      'model', model_identity,
      'results', normalized_results,
      'score', jsonb_build_object(
        'schema_version', 'aiq.score-report.v1',
        'scoring_version', '1.0.3',
        'model', model_identity,
        'tier', 'synthetic_complete',
        'rule', 'AIQ v1: 100 × the equal-weight mean of 10 domain scores; each domain is the equal-weight mean of valid task scores. Coverage and difficulty do not alter weights. Official requires non-synthetic 72/72 coverage and 10/10 domains. A complete synthetic fixture is descriptive, has no Official AIQ, and is not ranking eligible. Provisional requires at least 60/72 and at least four valid tasks per domain, is conditional, and is not ranking eligible. Lower coverage publishes no estimate. The task-resampling interval uses finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction calibrated for this fixed benchmark fixture. It is a fixed-fixture calibrated sensitivity interval, not a universal confidence interval for model capability.',
        'official_aiq', null,
        'conditional_observed_aiq', 100,
        'ranking_eligible', false,
        'duplicate_results', 0,
        'coverage', jsonb_build_object(
          'expected_tasks', 72,
          'valid_tasks', 72,
          'invalid_tasks', 0,
          'missing_tasks', 0,
          'not_applicable_tasks', 0,
          'expected_domains', 10,
          'covered_domains', 10
        ),
        'difficulty_coverage', jsonb_build_object(
          'easy', jsonb_build_object('valid_tasks', 0),
          'medium', jsonb_build_object('valid_tasks', 0),
          'hard', jsonb_build_object('valid_tasks', 0)
        ),
        'domains', domain_scores,
        'completion_bounds', jsonb_build_object('lower', 100, 'upper', 100),
        'task_resampling_sensitivity_interval', jsonb_build_object(
          'method', 'finite_cluster_calibrated_percentile_sensitivity_v1',
          'lower', 100,
          'upper', 100,
          'central_mass', 0.95,
          'samples', 10000,
          'seed', 71783153620529
        ),
        'binary_micro_diagnostic', jsonb_build_object(
          'sample_size', 72,
          'successes', 72,
          'proportion', 1,
          'wilson_lower', binary_wilson_lower,
          'wilson_upper', binary_wilson_upper
        )
      )
    ));
  end loop;

  return jsonb_build_object(
    'schema_version', 'aiq.normalized-batch.v3',
    'matrix_batch_id', batch_id,
    'package_sha256', package_sha256,
    'content_hash', envelope ->> 'content_hash',
    'signer', envelope -> 'signer',
    'task_set_id', 'aiq-core',
    'task_set_version', '1.0.3',
    'task_set_hash', payload ->> 'task_set_hash',
    'capability_validation_digest', null,
    'provenance', null,
    'run_class', null,
    'benchmark_version', 'aiq-core@1.0.3',
    'prompt_set_digest', 'sha256:' || repeat('f', 64),
    'scoring_version', '1.0.3',
    'runner_commit', 'a7d91f4',
    'region', 'integration',
    'scheduled_unix_ms', payload -> 'started_unix_ms',
    'started_unix_ms', payload -> 'started_unix_ms',
    'finished_unix_ms', payload -> 'finished_unix_ms',
    'execution_concurrency', payload -> 'execution_concurrency',
    'synthetic', true,
    'result_efficiency', result_efficiency,
    'efficiency', efficiency,
    'pricing', pg_temp.aiq_efficiency_pricing(),
    'runs', runs,
    'normalization_digest', 'sha256:' || repeat('e', 64)
  );
end;
$$;

create temp table aiq_integration_input on commit drop as
select
  envelope,
  envelope ->> 'idempotency_key' as run_id,
  repeat('a', 64) as package_sha256,
  octet_length(envelope::text)::bigint as body_bytes
from (select pg_temp.aiq_ingress_envelope() as envelope) fixture;
grant select on aiq_integration_input to service_role;

select pg_temp.aiq_assert(
  aiq_private.result_package_v3_is_valid(envelope),
  'the ingress fixture must be a valid result package v3'
)
from aiq_integration_input;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temp table aiq_enqueue_accepted on commit drop as
select *
from aiq_integration_input input
cross join lateral public.aiq_enqueue_submission(
  input.envelope,
  jsonb_build_object(
    'body_bytes', input.body_bytes,
    'idempotency_key', input.run_id,
    'package_sha256', input.package_sha256,
    'received_at', '2026-07-30T12:00:00Z',
    'source', 'integration'
  ),
  jsonb_build_object(
    'bucket', 'integration-private-submissions',
    'bytes', input.body_bytes,
    'content_sha256', input.package_sha256,
    'key', 'sha256/' || input.package_sha256
  )
) queued;
select pg_temp.aiq_assert(
  (select disposition = 'accepted' and object_recorded
   from aiq_enqueue_accepted),
  'first enqueue must be accepted and storage-bound'
);

create temp table aiq_enqueue_duplicate on commit drop as
select queued.*
from aiq_integration_input input
cross join lateral public.aiq_enqueue_submission(
  input.envelope,
  jsonb_build_object(
    'body_bytes', input.body_bytes,
    'idempotency_key', input.run_id,
    'package_sha256', input.package_sha256,
    'received_at', '2026-07-30T12:00:00Z',
    'source', 'integration'
  ),
  jsonb_build_object(
    'bucket', 'integration-private-submissions',
    'bytes', input.body_bytes,
    'content_sha256', input.package_sha256,
    'key', 'sha256/' || input.package_sha256
  )
) queued;
select pg_temp.aiq_assert(
  (select disposition = 'duplicate' and object_recorded
     and inbox_id = (select inbox_id from aiq_enqueue_accepted)
   from aiq_enqueue_duplicate),
  'exact enqueue replay must be idempotent'
);

create temp table aiq_enqueue_conflict on commit drop as
select queued.*
from aiq_integration_input input
cross join lateral (
  select
    jsonb_set(input.envelope, '{signature}', to_jsonb(repeat('cd', 64))) as envelope,
    repeat('b', 64) as package_sha256
) changed
cross join lateral public.aiq_enqueue_submission(
  changed.envelope,
  jsonb_build_object(
    'body_bytes', octet_length(changed.envelope::text),
    'idempotency_key', input.run_id,
    'package_sha256', changed.package_sha256,
    'received_at', '2026-07-30T12:00:01Z',
    'source', 'integration'
  ),
  jsonb_build_object(
    'bucket', 'integration-private-submissions',
    'bytes', octet_length(changed.envelope::text),
    'content_sha256', changed.package_sha256,
    'key', 'sha256/' || changed.package_sha256
  )
) queued;
select pg_temp.aiq_assert(
  (select disposition = 'conflict' and object_recorded
     and inbox_id = (select inbox_id from aiq_enqueue_accepted)
   from aiq_enqueue_conflict),
  'changed package under one idempotency key must be retained as a conflict'
);
reset role;

set local role aiq_verifier;
select set_config('request.jwt.claims', '{"role":"aiq_verifier"}', true);
select pg_temp.aiq_assert(
  (select count(*) = 0 from public.aiq_claim_submission(60)),
  'an active submission conflict must block verifier claim'
);
reset role;

delete from aiq_private.aiq_submission_conflicts
where inbox_id = (select inbox_id from aiq_enqueue_accepted);

set local role aiq_verifier;
select set_config('request.jwt.claims', '{"role":"aiq_verifier"}', true);
create temp table aiq_claim_one on commit drop as
select * from public.aiq_claim_submission(60);
select pg_temp.aiq_assert(
  (select count(*) = 1 and min(attempt) = 1 from aiq_claim_one),
  'the verifier must claim one eligible submission'
);
create temp table aiq_claim_renewed on commit drop as
select renewed.*
from aiq_claim_one claim
cross join lateral public.aiq_renew_submission_claim(
  claim.inbox_id, claim.lease_token, 120
) renewed;
select pg_temp.aiq_assert(
  (select renewed.inbox_id = claimed.inbox_id
      and renewed.lease_token = claimed.lease_token
      and renewed.attempt = claimed.attempt
      and renewed.lease_expires_at > claimed.lease_expires_at
   from aiq_claim_renewed renewed
   cross join aiq_claim_one claimed),
  'claim renewal must preserve identity and extend the active lease'
);
select pg_temp.aiq_assert(
  (select public.aiq_ack_submission_claim(
    inbox_id, lease_token, 'retry'
  ) = 'acknowledged' from aiq_claim_renewed),
  'retry acknowledgement must release the lease'
);
select pg_temp.aiq_assert(
  (select public.aiq_ack_submission_claim(
    inbox_id, lease_token, 'retry'
  ) = 'idempotent' from aiq_claim_renewed),
  'retry acknowledgement must be idempotent'
);
create temp table aiq_claim_two on commit drop as
select * from public.aiq_claim_submission(60);
select pg_temp.aiq_assert(
  (select second.attempt = first.attempt + 1
      and second.lease_token <> first.lease_token
   from aiq_claim_two second cross join aiq_claim_one first),
  'released work must be reclaimed with a new token and attempt'
);
do $$
begin
  begin
    perform public.aiq_ack_submission_claim(
      inbox_id, lease_token, 'completed'
    ) from aiq_claim_two;
    raise exception 'queued claim was acknowledged as completed';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
reset role;

-- Exercise the complete 17 x 72 first-stage path and its exact retry with a
-- deterministic non-production package. The timing bound protects the HTTP
-- gateway's 50-second database budget without using private benchmark data.
create temp table aiq_stage_resume_input on commit drop as
select
  input.run_id,
  input.package_sha256,
  accepted.inbox_id,
  claim.lease_token,
  claim.attempt,
  input.envelope,
  input.envelope #>> '{signer,node_id}' as node_id,
  input.envelope #>> '{signer,public_key}' as public_key,
  pg_temp.aiq_normalized_stage(input.envelope, input.package_sha256) as stage
from aiq_integration_input input
cross join aiq_enqueue_accepted accepted
cross join aiq_claim_two claim;
grant select on aiq_stage_resume_input to aiq_verifier;

select pg_temp.aiq_assert(
  (select octet_length(stage::text) <= 4 * 1024 * 1024 from aiq_stage_resume_input),
  'the synthetic normalized stage must fit the database envelope bound'
);
select pg_temp.aiq_assert(
  (select aiq_private.efficiency_pricing_v1_is_valid(stage->'pricing')
   from aiq_stage_resume_input),
  'the synthetic normalized stage must retain the exact pricing contract'
);
select pg_temp.aiq_assert(
  not exists (
    select 1 from aiq_stage_resume_input input
    cross join lateral jsonb_array_elements(input.stage->'result_efficiency') evidence
    where aiq_private.result_efficiency_v1_is_valid(evidence) is not true
  ),
  'every synthetic per-result efficiency record must validate'
);
select pg_temp.aiq_assert(
  not exists (
    select 1 from aiq_stage_resume_input input
    cross join lateral jsonb_array_elements(input.stage->'efficiency') aggregate
    where aiq_private.efficiency_aggregate_v1_is_valid(aggregate) is not true
  ),
  'every synthetic model efficiency aggregate must validate'
);
select pg_temp.aiq_assert(
  not exists (
    select 1 from aiq_stage_resume_input input
    cross join lateral jsonb_array_elements(input.stage->'efficiency') aggregate
    where aiq_private.efficiency_aggregate_matches_results(
      aggregate,input.stage->'result_efficiency'
    ) is not true
  ),
  'every synthetic model efficiency aggregate must match its result cells'
);
select pg_temp.aiq_assert(
  (select count(distinct evidence->>'source_result_id')=1224
   from aiq_stage_resume_input input
   cross join lateral jsonb_array_elements(input.stage->'result_efficiency') evidence),
  'synthetic efficiency evidence must bind 1224 unique result identities'
);
select pg_temp.aiq_assert(
  (select aiq_private.official_model_matrix_is_exact(
     (select jsonb_agg(aggregate.value->'model' order by aggregate.ordinality)
      from jsonb_array_elements(input.stage->'efficiency')
        with ordinality aggregate(value,ordinality))
   )
   from aiq_stage_resume_input input),
  'synthetic efficiency aggregates must retain the exact 17-model order'
);

savepoint stage_performance;
insert into aiq_private.aiq_nodes (
  node_id, display_name, key_fingerprint, signature_algorithm, public_key,
  status, trust_tier, operator_class, capabilities, source, signature_status,
  provenance, synthetic, public_visible, metadata
)
select
  node_id, 'Integration stage signer', 'sha256:' || substring(node_id from 6),
  'ed25519', public_key, 'active', 'unverified', 'official',
  array['runner'], 'integration', 'unverified', 'integration', true, false,
  '{"synthetic":true}'::jsonb
from aiq_stage_resume_input;

set local role aiq_verifier;
select set_config('request.jwt.claims', '{"role":"aiq_verifier"}', true);
create temp table aiq_stage_timings(
  first_stage_ms numeric not null,
  exact_retry_ms numeric not null
) on commit drop;
do $$
declare
  fixture aiq_stage_resume_input%rowtype;
  started_at timestamptz;
  first_elapsed numeric;
  retry_elapsed numeric;
  staged_batch_id text;
begin
  select * into strict fixture from aiq_stage_resume_input;
  started_at := clock_timestamp();
  staged_batch_id := public.aiq_stage_verifier_result(
    fixture.stage, fixture.inbox_id, fixture.lease_token, fixture.attempt
  );
  first_elapsed := 1000 * extract(epoch from clock_timestamp() - started_at);
  if staged_batch_id is distinct from fixture.run_id then
    raise exception 'first stage returned an unexpected batch identity';
  end if;
  started_at := clock_timestamp();
  staged_batch_id := public.aiq_stage_verifier_result(
    fixture.stage, fixture.inbox_id, fixture.lease_token, fixture.attempt
  );
  retry_elapsed := 1000 * extract(epoch from clock_timestamp() - started_at);
  if staged_batch_id is distinct from fixture.run_id then
    raise exception 'exact stage retry returned an unexpected batch identity';
  end if;
  begin
    perform public.aiq_stage_verifier_result(
      jsonb_set(fixture.stage, '{region}', '"changed"'::jsonb),
      fixture.inbox_id,
      fixture.lease_token,
      fixture.attempt
    );
    raise exception 'a changed completed stage was accepted as an exact retry';
  exception when object_not_in_prerequisite_state then null;
  end;
  insert into aiq_stage_timings values(first_elapsed, retry_elapsed);
end;
$$;
reset role;
select pg_temp.aiq_assert(
  (select first_stage_ms < 50000 from aiq_stage_timings),
  'the complete 17 x 72 first stage must finish within 50 seconds'
);
select pg_temp.aiq_assert(
  (select exact_retry_ms < 10000 from aiq_stage_timings),
  'an exact completed retry must finish within 10 seconds'
);
select
  octet_length(fixture.stage::text) as normalized_stage_bytes,
  timing.first_stage_ms,
  timing.exact_retry_ms
from aiq_stage_timings timing
cross join aiq_stage_resume_input fixture;
select pg_temp.aiq_assert(
  (select count(*) = 17 from aiq_private.aiq_package_runs link
   join aiq_stage_resume_input fixture on fixture.package_sha256 = link.package_sha256),
  'first staging must persist exactly 17 package runs'
);
select pg_temp.aiq_assert(
  (select count(*) = 1224 from aiq_private.aiq_task_results result
   join aiq_private.aiq_package_runs link using(run_id)
   join aiq_stage_resume_input fixture on fixture.package_sha256 = link.package_sha256),
  'first staging must persist exactly 1,224 task results'
);
select pg_temp.aiq_assert(
  (select count(*) = 1 from aiq_private.aiq_verification_audit audit
   join aiq_stage_resume_input fixture on fixture.inbox_id = audit.inbox_id
   where audit.event_type = 'staged'),
  'first staging and its exact retry must retain one staged audit record'
);
savepoint incomplete_stage_retry;
set local session_replication_role = replica;
delete from aiq_private.aiq_task_results result
where result.result_id = (
  select candidate.result_id
  from aiq_private.aiq_task_results candidate
  join aiq_private.aiq_package_runs link using(run_id)
  join aiq_stage_resume_input fixture on fixture.package_sha256 = link.package_sha256
  order by candidate.result_id
  limit 1
);
set local session_replication_role = origin;
set local role aiq_verifier;
select set_config('request.jwt.claims', '{"role":"aiq_verifier"}', true);
do $$
begin
  begin
    perform public.aiq_stage_verifier_result(
      stage, inbox_id, lease_token, attempt
    ) from aiq_stage_resume_input;
    raise exception 'an incomplete stored stage was accepted as an exact retry';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
reset role;
rollback to savepoint incomplete_stage_retry;
release savepoint incomplete_stage_retry;
rollback to savepoint stage_performance;
release savepoint stage_performance;

-- The deterministic demo is a pre-staged complete synthetic fixture. Exercise
-- the stage role boundary and prove that attestation cannot make it publishable.
set local role aiq_publisher;
select set_config('request.jwt.claims', '{"role":"aiq_publisher"}', true);
do $$
begin
  begin
    perform public.aiq_stage_verifier_result(
      '{}'::jsonb,
      '11111111-1111-4111-8111-111111111111'::uuid,
      '22222222-2222-4222-8222-222222222222'::uuid,
      1
    );
    raise exception 'publisher reached verifier staging';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local session_replication_role = replica;
update aiq_private.aiq_submission_inbox
set
  claim_token = '33333333-3333-4333-8333-333333333333'::uuid,
  claim_expires_at = clock_timestamp() + interval '10 minutes',
  claim_attempts = 1,
  claim_ack = null,
  verification_status = 'unverified',
  state = 'processed';
update aiq_private.aiq_runs
set published = false, trust_tier = 'unverified';
update aiq_private.aiq_result_packages
set
  signature_verified = false,
  verifier_attestation = null,
  trust_tier = 'unverified',
  verified_at = null;
update aiq_private.aiq_matrix_batches
set verified_at = null, published_at = null;
set local session_replication_role = origin;

do $$
begin
  begin
    update aiq_private.aiq_score_snapshots
    set score_status = 'official'
    where score_snapshot_id = (
      select score_snapshot_id
      from aiq_private.aiq_score_snapshots
      order by score_snapshot_id
      limit 1
    );
    raise exception 'synthetic score accepted Official classification';
  exception when check_violation then null;
  end;
end;
$$;

savepoint non_synthetic_score_classification;
set local session_replication_role = replica;
update aiq_private.aiq_runs
set synthetic = false
where run_id = (select min(run_id) from aiq_private.aiq_runs);
set local session_replication_role = origin;
do $$
begin
  begin
    update aiq_private.aiq_score_snapshots
    set published = published
    where run_id = (select min(run_id) from aiq_private.aiq_runs);
    raise exception 'non-synthetic score accepted Synthetic Complete classification';
  exception when check_violation then null;
  end;
end;
$$;
rollback to savepoint non_synthetic_score_classification;
release savepoint non_synthetic_score_classification;

create temp table aiq_publication_fixture on commit drop as
select
  inbox.inbox_id,
  inbox.claim_token as lease_token,
  inbox.claim_attempts as attempt,
  package.matrix_batch_id,
  package.package_sha256,
  jsonb_build_object(
    'schema_version', 'aiq.verifier-attestation.v3',
    'signature_algorithm', 'ed25519',
    'signature_version', 'aiq.ed25519-jcs.v1',
    'matrix_batch_id', package.matrix_batch_id,
    'package_sha256', package.package_sha256,
    'content_hash', package.content_hash,
    'normalization_digest', package.normalization_digest,
    'task_set_hash', package.envelope #>> '{payload,task_set_hash}',
    'capability_validation_digest', null,
    'provenance', null,
    'benchmark_version', batch.benchmark_version,
    'prompt_set_digest', batch.prompt_set_digest,
    'scoring_version', batch.scoring_version,
    'verifier', jsonb_build_object(
      'node_id', verifier.node_id, 'public_key', verifier.public_key
    ),
    'observed_unix_ms', 1784895600000,
    'replay_status', 'commitments_verified',
    'policy', 'synthetic_test',
    'synthetic', true,
    'signature', repeat('cd', 64)
  ) as attestation
from aiq_private.aiq_submission_inbox inbox
join aiq_private.aiq_result_packages package
  on package.package_sha256 = inbox.package_sha256
join aiq_private.aiq_matrix_batches batch
  on batch.matrix_batch_id = package.matrix_batch_id
 and batch.package_sha256 = package.package_sha256
cross join lateral (
  select node_id, public_key
  from aiq_private.aiq_nodes
  where operator_class = 'verifier' and synthetic
  order by node_id
  limit 1
) verifier;
grant select on aiq_publication_fixture to aiq_verifier, aiq_publisher;

set local role aiq_verifier;
select set_config('request.jwt.claims', '{"role":"aiq_verifier"}', true);
select public.aiq_record_verifier_attestation(
  matrix_batch_id, package_sha256, attestation,
  inbox_id, lease_token, attempt
)
from aiq_publication_fixture;
reset role;
select pg_temp.aiq_assert(
  (select count(*) = 1
   from aiq_private.aiq_verification_audit
   where event_type = 'verifier_attested'),
  'verifier attestation must be recorded once'
);
set local role aiq_verifier;
select set_config('request.jwt.claims', '{"role":"aiq_verifier"}', true);
do $$
begin
  begin
    perform public.aiq_verify_and_publish(
      matrix_batch_id, package_sha256, inbox_id, lease_token, attempt
    ) from aiq_publication_fixture;
    raise exception 'verifier reached publisher transition';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role aiq_publisher;
select set_config('request.jwt.claims', '{"role":"aiq_publisher"}', true);
do $$
begin
  begin
    perform public.aiq_verify_and_publish(
      matrix_batch_id, package_sha256, inbox_id, lease_token, attempt
    )
    from aiq_publication_fixture;
    raise exception 'synthetic batch reached publication';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
reset role;
set constraints all immediate;
set constraints all deferred;

select pg_temp.aiq_assert(
  (select count(*) = 0
   from aiq_private.aiq_runs
   where published and trust_tier = 'trusted_verified'),
  'synthetic runs must remain unpublished and unverified'
);
select pg_temp.aiq_assert(
  (select count(*) = 17
   from aiq_private.aiq_score_snapshots
   where not published and score_status = 'synthetic_complete'),
  'complete synthetic scores must remain descriptive and unpublished'
);
select pg_temp.aiq_assert(
  (select claim_ack is null and verification_status = 'unverified'
   from aiq_private.aiq_submission_inbox
   where inbox_id = (select inbox_id from aiq_publication_fixture)),
  'rejected synthetic publication must not advance the inbox'
);

-- A single Official batch has one shared recorded time. The half-open trend
-- range must remain nonempty after PostgREST timestamps enter JavaScript Dates,
-- which retain only millisecond precision.
savepoint single_batch_trend_precision;
set local session_replication_role = replica;
update aiq_private.aiq_runs
set
  scheduled_for = '2026-08-03T16:00:00Z'::timestamptz,
  synthetic = false,
  trust_tier = 'trusted_verified',
  published = true;
update aiq_private.aiq_score_snapshots
set score_status = 'official', published = true;
set local session_replication_role = origin;

create temp table aiq_single_batch_trend on commit drop as
select * from public.public_trend_points('all') with no data;
grant insert, select on aiq_single_batch_trend to anon;
set local role anon;
insert into aiq_single_batch_trend
select * from public.public_trend_points('all');
reset role;

select pg_temp.aiq_assert(
  (select count(*) = 17 from aiq_single_batch_trend),
  'the single-batch trend RPC must return every matrix series'
);
select pg_temp.aiq_assert(
  (
    select bool_and(
      pg_catalog.date_trunc('milliseconds', bucket_ended_at)
        > pg_catalog.date_trunc('milliseconds', recorded_at)
      and bucket_ended_at = recorded_at + interval '1 millisecond'
      and resolution_seconds = 1
      and scoring_version = '1.0.3'
    )
    from aiq_single_batch_trend
  ),
  'the single-batch trend bucket must end strictly after its point at millisecond precision'
);
rollback to savepoint single_batch_trend_precision;
release savepoint single_batch_trend_precision;

-- Storage registry identity is idempotent, active references block deletion,
-- and the production reference gate remains closed for synthetic fixtures.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temp table aiq_storage_fixture on commit drop as
select public.aiq_register_storage_object(
  'runner_artifact',
  'stdout.jsonl',
  'integration-private-artifacts',
  'sha256/' || repeat('d', 64) || '/stdout.jsonl',
  repeat('d', 64),
  128,
  'ephemeral_30d',
  clock_timestamp() - interval '1 minute'
) as object_id;
select pg_temp.aiq_assert(
  (select public.aiq_register_storage_object(
    'runner_artifact',
    'stdout.jsonl',
    'integration-private-artifacts',
    'sha256/' || repeat('d', 64) || '/stdout.jsonl',
    repeat('d', 64),
    128,
    'ephemeral_30d',
    clock_timestamp() - interval '1 minute'
  ) = object_id from aiq_storage_fixture),
  'storage registration must be idempotent by object identity'
);
select public.aiq_attach_storage_reference(
  object_id, 'artifact_ingress_claim', 'integration/run/artifact'
)
from aiq_storage_fixture;
do $$
begin
  begin
    perform public.aiq_claim_storage_deletions(10,60);
    raise exception 'deletion leasing bypassed the inventory epoch gate';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
do $$
declare
  status jsonb:=public.aiq_storage_lifecycle_status();
begin
  begin
    perform public.aiq_record_storage_inventory_epoch(
      (status ->> 'active_objects')::bigint+(status ->> 'pending_objects')::bigint,
      'sha256:'||repeat('0',64)
    );
    raise exception 'inventory epoch accepted a conflicting object digest';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
with inventory as (
  select public.aiq_storage_lifecycle_status() as status
)
select public.aiq_record_storage_inventory_epoch(
  (status ->> 'active_objects')::bigint+(status ->> 'pending_objects')::bigint,
  status ->> 'registry_inventory_digest'
)
from inventory;
select pg_temp.aiq_assert(
  (select count(*) = 0
   from public.aiq_claim_storage_deletions(10, 60)),
  'an active storage reference must block deletion'
);
select public.aiq_deactivate_storage_reference(
  'artifact_ingress_claim', 'integration/run/artifact'
);
create temp table aiq_storage_deletion on commit drop as
select * from public.aiq_claim_storage_deletions(1, 60);
select pg_temp.aiq_assert(
  (select count(*) = 1
      and bool_and(object_id = (select object_id from aiq_storage_fixture))
      and min(attempt) = 1
   from aiq_storage_deletion),
  'an expired unreferenced object must enter bounded deletion'
);
select pg_temp.aiq_assert(
  (select public.aiq_ack_storage_deletion(
    object_id, lease_token, 'deleted'
  ) = 'acknowledged' from aiq_storage_deletion),
  'storage deletion acknowledgement must complete the lifecycle'
);
select pg_temp.aiq_assert(
  not (
    public.aiq_production_reference_status(
      'node_' || repeat('f', 64)
    ) ->> 'initialized'
  )::boolean,
  'synthetic fixtures must not initialize production reference state'
);
reset role;

-- Calibration uses a separate forced-RLS, published-only surface. The
-- existing Official integration flow must not create calibration evidence.
select pg_temp.aiq_assert(
  (select count(*) = 6
   from pg_catalog.pg_class relation
   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname = 'aiq_private'
     and relation.relname like 'calibration\_%' escape '\'
     and relation.relkind = 'r'
     and relation.relrowsecurity
     and relation.relforcerowsecurity),
  'every calibration evidence table must enable and force RLS'
);
select pg_temp.aiq_assert(
  (select count(*) = 0 from public.public_calibration_runs)
  and (select count(*) = 0 from public.public_calibration_results)
  and (select count(*) = 0 from public.public_calibration_scores),
  'Official verification must never enter public calibration views'
);
select pg_temp.aiq_assert(
  not pg_catalog.has_function_privilege(
    'anon','public.aiq_stage_calibration_verification(jsonb,uuid,uuid,integer)','EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated','public.aiq_record_calibration_attestation(jsonb,uuid,uuid,integer)','EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role','public.aiq_publish_calibration_evidence(text,text,uuid,uuid,integer)','EXECUTE'
  ),
  'browser and service roles must not cross calibration verifier or publisher boundaries'
);
select pg_temp.aiq_assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in (
        'public_calibration_runs','public_calibration_results','public_calibration_scores'
      )
      and column_name in (
        'package_sha256','content_hash','stage_digest','runner_node_id','verifier_node_id',
        'publisher_node_id','verification_record','verifier_attestation','failure_detail'
      )
  ),
  'public calibration views must not expose private evidence fields'
);
select pg_temp.aiq_assert(
  (select count(*) = 5
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'public_calibration_results'
     and column_name in (
       'outcome','execution_status','failure_code','explanation_code','explanation_summary'
     )),
  'public calibration results must expose bounded failure classification'
);
select pg_temp.aiq_assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in ('public_run_results','public_calibration_results')
      and column_name = 'status'
  )
  and not exists (
    select 1 from public.public_calibration_results
    where execution_status is distinct from case
      when outcome in ('correct','partial','incorrect') then 'completed'
      when outcome in (
        'timeout','budget_exhausted','tool_failure','policy_failure','wrong_artifact'
      ) then 'runtime_issue'
      when outcome='invalid' then 'invalid'
      when outcome='missing' then 'missing'
      when outcome='not_applicable' then 'not_applicable'
    end
  ),
  'public calibration results must separate exact outcomes from execution status'
);
select pg_temp.aiq_assert(
  (select count(*) = 2
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'public_run_results'
     and column_name in ('outcome','execution_status'))
  and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_run_results'
      and column_name = 'status'
  )
  and not exists (
    select 1 from public.public_run_results
    where execution_status is distinct from case
      when outcome in ('correct','partial','incorrect') then 'completed'
      when outcome in (
        'timeout','budget_exhausted','tool_failure','policy_failure','wrong_artifact'
      ) then 'runtime_issue'
      when outcome='invalid' then 'invalid'
      when outcome='missing' then 'missing'
      when outcome='not_applicable' then 'not_applicable'
    end
  ),
  'public Official results must separate exact outcomes from execution status'
);
select pg_temp.aiq_assert(
  (select count(*) = 8
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'public_runs'
     and column_name in (
       'correct_count','partial_count','incorrect_count','runtime_issue_count',
       'invalid_count','missing_count','not_applicable_count','completed_count'
     ))
  and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_runs'
      and column_name in ('passed_count','failed_count')
  )
  and not exists (
    select 1
    from public.public_runs run
    where run.result_count is distinct from (
      run.correct_count + run.partial_count + run.incorrect_count
      + run.runtime_issue_count + run.invalid_count + run.missing_count
      + run.not_applicable_count
    )
      or run.completed_count is distinct from (
        run.correct_count + run.partial_count + run.incorrect_count
      )
  ),
  'public Official run summaries must preserve each outcome class'
);
select pg_temp.aiq_assert(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_leaderboard'
      and column_name = 'runtime_issues'
  )
  and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_leaderboard'
      and column_name = 'failures'
  )
  and not exists (
    select 1
    from public.public_leaderboard leaderboard
    join public.public_runs run on run.id=leaderboard.run_id
    where leaderboard.runtime_issues is distinct from case
      when leaderboard.score_status='official' then run.runtime_issue_count
      else null
    end
  ),
  'public leaderboard must report runtime issues without semantic incorrect outcomes'
);
select pg_temp.aiq_assert(
  (select count(*) = 2
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'public_leaderboard'
     and column_name in ('sensitivity_low','sensitivity_high'))
  and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_leaderboard'
      and column_name in ('ci_low','ci_high')
  )
  and (
    select proc.proargnames @> array['sensitivity_low','sensitivity_high']::text[]
      and not proc.proargnames && array['ci_low','ci_high']::text[]
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace namespace
      on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'public_trend_points'
  ),
  'public score ranges must use explicit sensitivity field names'
);
select pg_temp.aiq_assert(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_scoring_versions'
      and column_name = 'sensitivity_policy'
  )
  and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_scoring_versions'
      and column_name = 'confidence_policy'
  ),
  'public scoring metadata must name the fixed-fixture sensitivity policy explicitly'
);
select pg_temp.aiq_assert(
  (select count(*) = 6
   from information_schema.columns
   where table_schema = 'aiq_private'
     and table_name = 'efficiency_official_models'
     and column_name in (
       'input_token_observed_result_count','cached_input_token_observed_result_count',
       'cache_write_input_token_observed_result_count','output_token_observed_result_count',
       'reasoning_token_observed_result_count','total_token_observed_result_count'
     )),
  'Official storage must preserve all six provider token category coverage counts'
);
select pg_temp.aiq_assert(
  (select count(*) = 12
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'public_model_efficiency'
     and column_name in (
       'input_token_coverage_count','input_token_coverage_percent',
       'cached_input_token_coverage_count','cached_input_token_coverage_percent',
       'cache_write_input_token_coverage_count','cache_write_input_token_coverage_percent',
       'output_token_coverage_count','output_token_coverage_percent',
       'reasoning_token_coverage_count','reasoning_token_coverage_percent',
       'total_token_coverage_count','total_token_coverage_percent'
     )),
  'public Official efficiency must expose category-specific coverage'
);
select pg_temp.aiq_assert(
  (select count(*) = 3
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'public_model_efficiency'
     and column_name in (
       'matrix_batch_id','matrix_batch_elapsed_ms','summed_cell_adapter_elapsed_ms'
     )),
  'public Official efficiency must distinguish shared batch wall-clock from summed cell time'
);
select pg_temp.aiq_assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'public_run_results'
      and column_name in (
        'usage','provenance','failure_detail','result_package_sha256'
      )
  ),
  'public Official result efficiency must omit private provider payloads and result-package digests'
);
select pg_temp.aiq_assert(
  (select count(*) = 2
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'public_run_results'
     and column_name in ('task_id','pricing_digest')),
  'public Official result efficiency must expose task identity and its exact pricing-record digest'
);

rollback;
