-- Deterministic local demonstration data. Every published observation is
-- explicitly synthetic. This file creates no Storage bucket or external resource.

begin;

insert into aiq_private.aiq_scoring_versions (
  scoring_version, schema_version, benchmark_version, name,
  fixed_fixture_estimand, principles, missing_policy, failure_policy_text,
  confidence_policy, formula, interval_method, failure_policy, synthetic,
  is_published, published_at
)
values (
  '1.0.5',
  'aiq.score-snapshot.v1',
  'aiq-core@1.0.5',
  'AIQ fixed-fixture score 1.0.5',
  'The unscaled mean of ten equally weighted domain means over the frozen 72-task fixture.',
  array[
    'Give each of the ten domains weight 0.1.',
    'Keep the frozen domain and difficulty quotas.',
    'Keep missing and invalid tasks in completion accounting and block Official publication.',
    'Classify complete synthetic fixtures as descriptive Synthetic Complete, never Official or ranking eligible.',
    'Treat attributable agent, model, tool, timeout, budget, and wrong-artifact failures as valid zero scores.',
    'Treat benchmark infrastructure failures as invalid and audit a rerun.'
  ],
  'Missing and invalid tasks block Official. Synthetic Complete and Provisional output use descriptive observed domain means and fixed-fixture completion bounds without ranking eligibility.',
  'Attributable failures are valid zero scores. Infrastructure failures are invalid and require an audited rerun.',
  'The task-resampling interval uses finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction calibrated for this fixed benchmark fixture. It is a fixed-fixture calibrated sensitivity interval, not a universal confidence interval for model capability.',
  '{
    "aggregate":"mean_of_domain_means",
    "coverage_multiplier":false,
    "domain_weight":0.1,
    "official_valid_task_count":72,
    "official_covered_domain_count":10,
    "synthetic_complete":{
      "valid_task_count":72,
      "covered_domain_count":10,
      "official_aiq":null,
      "ranking_eligible":false
    }
  }'::jsonb,
  '{"central_mass":0.95,"deviation_scale":1.3,"method":"finite_cluster_calibrated_percentile_sensitivity_v1","samples":10000,"scope":"fixed_fixture_calibrated_sensitivity","synthetic":false,"universal_confidence_interval":false}'::jsonb,
  '{
    "attributable_failure_score":0,
    "infrastructure_failure_score":null,
    "missing_blocks_official":true,
    "provisional_ranked":false,
    "synthetic_complete_ranked":false
  }'::jsonb,
  true,
  true,
  '2026-07-22T16:00:00Z'
);

insert into aiq_private.aiq_task_sets (
  task_set_id, task_set_version, title, task_count, domain_count,
  catalog_sha256, hidden_payload_commitment, content_status, is_published,
  published_at, metadata
)
values (
  'aiq-core',
  '1.0.5',
  'AIQ Core 72',
  72,
  10,
  encode(extensions.digest('aiq-core-catalog-1.0.5', 'sha256'), 'hex'),
  encode(extensions.digest('aiq-core-hidden-payload-1.0.5', 'sha256'), 'hex'),
  'committed',
  true,
  '2026-07-22T16:00:00Z',
  '{
    "synthetic":true,
    "quota_policy":"frozen_domain_by_difficulty",
    "private_bucket_env":"AIQ_RUNNER_ARTIFACT_BUCKET",
    "storage_lifecycle_required_at_deployment":true
  }'::jsonb
);

with quotas(domain, easy_count, medium_count, hard_count, ordinal) as (
  values
    ('coding', 1, 5, 2, 1),
    ('debugging', 1, 5, 2, 2),
    ('repository_understanding', 1, 5, 1, 3),
    ('data_processing', 2, 5, 1, 4),
    ('retrieval_verification', 1, 5, 1, 5),
    ('documentation_communication', 2, 4, 1, 6),
    ('planning_execution', 1, 5, 1, 7),
    ('tool_use', 1, 5, 1, 8),
    ('instruction_following', 1, 4, 1, 9),
    ('reliability_recovery', 1, 5, 1, 10)
),
expanded as (
  select
    quota.domain,
    quota.ordinal,
    difficulty.name as difficulty,
    generate_series(1, difficulty.task_count) as difficulty_number
  from quotas quota
  cross join lateral (
    values
      ('easy', quota.easy_count),
      ('medium', quota.medium_count),
      ('hard', quota.hard_count)
  ) difficulty(name, task_count)
),
numbered as (
  select
    expanded.*,
    row_number() over (
      partition by domain
      order by
        case difficulty when 'easy' then 1 when 'medium' then 2 else 3 end,
        difficulty_number
    ) as domain_number
  from expanded
)
insert into aiq_private.aiq_task_catalog (
  task_set_id, task_set_version, task_id, task_version, title, domain,
  difficulty, summary, evaluator_kind, scorer_version, allowed_tools, budget,
  tags, fixture_commitment, hidden_content_ref, leakage_notes, public_metadata
)
select
  'aiq-core',
  '1.0.5',
  replace(domain, '_', '-') || '-' || lpad(domain_number::text, 2, '0'),
  '1.0.5',
  initcap(replace(domain, '_', ' ')) || ' task ' || domain_number,
  domain,
  difficulty,
  'Synthetic public metadata for deterministic local contract validation.',
  'deterministic_fixture',
  '1.0.5',
  '["filesystem_read","filesystem_write","web_search"]'::jsonb,
  '{"wall_time_seconds":300,"tool_calls":40}'::jsonb,
  array['synthetic', domain, difficulty],
  encode(extensions.digest(domain || ':' || domain_number || ':fixture', 'sha256'), 'hex'),
  'supabase-private://benchmark-tasks/aiq-core/1.0.5/'
    || replace(domain, '_', '-') || '-' || lpad(domain_number::text, 2, '0') || '.json',
  'The hidden fixture is commitment-addressed and is not in a public view.',
  true
from numbered
order by ordinal, domain_number;

insert into aiq_private.aiq_model_configs (
  model_config_id, provider, model_family, provider_model_id, reasoning_effort,
  display_name, matrix_order, expected_in_matrix, capability_status,
  provider_fingerprint, is_enabled
)
values
  ('sol-low', 'openai', 'sol', 'gpt-5.6-sol', 'low', 'Sol · low', 1, true, 'available', 'synthetic-provider-v1', true),
  ('sol-medium', 'openai', 'sol', 'gpt-5.6-sol', 'medium', 'Sol · medium', 2, true, 'available', 'synthetic-provider-v1', true),
  ('sol-high', 'openai', 'sol', 'gpt-5.6-sol', 'high', 'Sol · high', 3, true, 'available', 'synthetic-provider-v1', true),
  ('sol-xhigh', 'openai', 'sol', 'gpt-5.6-sol', 'xhigh', 'Sol · xhigh', 4, true, 'available', 'synthetic-provider-v1', true),
  ('sol-max', 'openai', 'sol', 'gpt-5.6-sol', 'max', 'Sol · max', 5, true, 'available', 'synthetic-provider-v1', true),
  ('sol-ultra', 'openai', 'sol', 'gpt-5.6-sol', 'ultra', 'Sol · ultra', 6, true, 'available', 'synthetic-provider-v1', true),
  ('terra-low', 'openai', 'terra', 'gpt-5.6-terra', 'low', 'Terra · low', 7, true, 'available', 'synthetic-provider-v1', true),
  ('terra-medium', 'openai', 'terra', 'gpt-5.6-terra', 'medium', 'Terra · medium', 8, true, 'available', 'synthetic-provider-v1', true),
  ('terra-high', 'openai', 'terra', 'gpt-5.6-terra', 'high', 'Terra · high', 9, true, 'available', 'synthetic-provider-v1', true),
  ('terra-xhigh', 'openai', 'terra', 'gpt-5.6-terra', 'xhigh', 'Terra · xhigh', 10, true, 'available', 'synthetic-provider-v1', true),
  ('terra-max', 'openai', 'terra', 'gpt-5.6-terra', 'max', 'Terra · max', 11, true, 'available', 'synthetic-provider-v1', true),
  ('terra-ultra', 'openai', 'terra', 'gpt-5.6-terra', 'ultra', 'Terra · ultra', 12, true, 'available', 'synthetic-provider-v1', true),
  ('luna-low', 'openai', 'luna', 'gpt-5.6-luna', 'low', 'Luna · low', 13, true, 'available', 'synthetic-provider-v1', true),
  ('luna-medium', 'openai', 'luna', 'gpt-5.6-luna', 'medium', 'Luna · medium', 14, true, 'available', 'synthetic-provider-v1', true),
  ('luna-high', 'openai', 'luna', 'gpt-5.6-luna', 'high', 'Luna · high', 15, true, 'available', 'synthetic-provider-v1', true),
  ('luna-xhigh', 'openai', 'luna', 'gpt-5.6-luna', 'xhigh', 'Luna · xhigh', 16, true, 'available', 'synthetic-provider-v1', true),
  ('luna-max', 'openai', 'luna', 'gpt-5.6-luna', 'max', 'Luna · max', 17, true, 'available', 'synthetic-provider-v1', true);

with nodes(label, display_name, operator_class, status, trust_tier, source,
  signature_status, provenance, capabilities, last_seen_at) as (
  values
    ('atlas', 'Atlas / IAD', 'official', 'active'::aiq_private.node_status,
      'unverified'::aiq_private.trust_tier, 'synthetic operator registry',
      'unverified', 'Synthetic unverified registry identity and heartbeat.',
      array['sealed-runner', 'browser', 'shell'], '2026-07-24T14:58:00Z'::timestamptz),
    ('kepler', 'Kepler / FRA', 'verifier', 'degraded'::aiq_private.node_status,
      'unverified'::aiq_private.trust_tier, 'synthetic verifier registry',
      'unverified', 'Synthetic unverified verifier identity.',
      array['sealed-runner', 'gpu-a100'], '2026-07-24T14:46:00Z'::timestamptz),
    ('nomad', 'Nomad / unknown', 'community', 'offline'::aiq_private.node_status,
      'unverified'::aiq_private.trust_tier, 'synthetic peer announcement',
      'unverified', 'Synthetic untrusted self-signed announcement.',
      array['runner'], '2026-07-23T08:12:00Z'::timestamptz)
)
insert into aiq_private.aiq_nodes (
  node_id, display_name, key_fingerprint, signature_algorithm, public_key,
  status, trust_tier, operator_class, capabilities, source, signature_status,
  provenance, synthetic, public_visible, registered_at, last_seen_at, metadata
)
select
  'node_' || encode(
    extensions.digest(extensions.digest(label || ':public-key', 'sha256'), 'sha256'),
    'hex'
  ),
  display_name,
  'sha256:' || encode(
    extensions.digest(extensions.digest(label || ':public-key', 'sha256'), 'sha256'),
    'hex'
  ),
  'ed25519',
  encode(extensions.digest(label || ':public-key', 'sha256'), 'hex'),
  status,
  trust_tier,
  operator_class,
  capabilities,
  source,
  signature_status,
  provenance,
  true,
  true,
  '2026-06-01T12:00:00Z',
  last_seen_at,
  jsonb_build_object('synthetic', true)
from nodes;

-- Synthetic identities can never carry production publisher authorization.
update aiq_private.aiq_nodes
set publisher_authorized = false
where synthetic and publisher_authorized;

insert into aiq_private.aiq_node_capability_snapshots (
  capability_sha256, node_id, schema_version, runner_version, runner_sha256,
  harness_sha256, environment, model_capabilities, validation_status, validated_at
)
select
  encode(extensions.digest(node_id || ':capability:v1', 'sha256'), 'hex'),
  node_id,
  'aiq.capability.v1',
  '0.1.0',
  encode(extensions.digest(node_id || ':runner', 'sha256'), 'hex'),
  encode(extensions.digest(node_id || ':harness', 'sha256'), 'hex'),
  '{"synthetic":true,"environment":"local-fixture"}'::jsonb,
  '{"families":["sol","terra","luna"]}'::jsonb,
  case when trust_tier = 'unverified' then 'partial' else 'valid' end,
  last_seen_at
from aiq_private.aiq_nodes;

with selected_node as (
  select node_id
  from aiq_private.aiq_nodes
  where operator_class = 'official'
),
runs as (
  select
    model.model_config_id,
    model.matrix_order,
    'run_' || encode(
      extensions.digest(
        convert_to(
          'aiq.model-run-identity.v1' || chr(10)
          || 'run_' || encode(
            extensions.digest('synthetic-complete-batch', 'sha256'),
            'hex'
          ) || chr(10)
          || model.model_config_id,
          'utf8'
        ),
        'sha256'
      ),
      'hex'
    ) as run_id,
    '2026-07-24T12:00:00Z'::timestamptz
      + model.matrix_order * interval '1 minute' as scheduled_for
  from aiq_private.aiq_model_configs model
)
insert into aiq_private.aiq_runs (
  run_id, matrix_batch_id, idempotency_key, schedule_slot, scheduled_for,
  schedule_timezone, task_set_id, task_set_version, benchmark_version,
  scoring_version, model_config_id, source_node_id, capability_sha256, status,
  trust_tier, synthetic, published, started_at, completed_at, prompt_set_digest,
  runner_commit, region, provenance
)
select
  run.run_id,
  'run_' || encode(extensions.digest('synthetic-complete-batch', 'sha256'), 'hex'),
  run.run_id,
  'manual',
  run.scheduled_for,
  'UTC',
  'aiq-core',
  '1.0.5',
  'aiq-core@1.0.5',
  '1.0.5',
  run.model_config_id,
  node.node_id,
  encode(extensions.digest(node.node_id || ':capability:v1', 'sha256'), 'hex'),
  'completed',
  'unverified',
  true,
  false,
  run.scheduled_for,
  run.scheduled_for + interval '18 minutes',
  encode(extensions.digest('aiq-core:prompt-set:1.0.5', 'sha256'), 'hex'),
  'a7d91f4',
  'us-east-1',
  '{"synthetic":true,"trust_layer":"unverified","source":"deterministic_seed"}'::jsonb
from runs run
cross join selected_node node;

with ordered_tasks as (
  select
    catalog.*,
    row_number() over (order by catalog.domain, catalog.task_id) as task_number
  from aiq_private.aiq_task_catalog catalog
  where catalog.task_set_id = 'aiq-core' and catalog.task_set_version = '1.0.5'
)
insert into aiq_private.aiq_task_results (
  result_id, source_result_id, run_id, task_id, task_version, domain,
  attempt_number, outcome,
  task_score, scorer_version, failure_code, failure_responsibility,
  failure_detail, failure_retryable, latency_ms, latency_evidence_level, tool_usage, usage,
  result_package_sha256, provenance
)
select
  (
    substr(md5(run.run_id || ':' || task.task_id), 1, 8) || '-'
    || substr(md5(run.run_id || ':' || task.task_id), 9, 4) || '-'
    || substr(md5(run.run_id || ':' || task.task_id), 13, 4) || '-'
    || substr(md5(run.run_id || ':' || task.task_id), 17, 4) || '-'
    || substr(md5(run.run_id || ':' || task.task_id), 21, 12)
  )::uuid,
  'result_' || encode(
    extensions.digest(run.run_id || ':' || task.task_id, 'sha256'), 'hex'
  ),
  run.run_id,
  task.task_id,
  task.task_version,
  task.domain,
  1,
  case
    when (task.task_number + model.matrix_order) % 19 = 0
      then 'timeout'::aiq_private.result_outcome
    when (task.task_number + model.matrix_order) % 7 = 0
      then 'partial'::aiq_private.result_outcome
    else 'correct'::aiq_private.result_outcome
  end,
  case
    when (task.task_number + model.matrix_order) % 19 = 0 then 0
    when (task.task_number + model.matrix_order) % 7 = 0 then 0.6
    else 1
  end,
  '1.0.5',
  case when (task.task_number + model.matrix_order) % 19 = 0
    then 'SYNTHETIC_TIMEOUT' end,
  case when (task.task_number + model.matrix_order) % 19 = 0
    then 'timeout' end,
  case when (task.task_number + model.matrix_order) % 19 = 0
    then 'Synthetic timeout used to demonstrate a valid zero score.' end,
  case when (task.task_number + model.matrix_order) % 19 = 0
    then true end,
  9000 + task.task_number * 137,
  'runner_observed',
  '{
    "steps":4,
    "total_calls":3,
    "by_tool":{
      "filesystem_read":1,
      "filesystem_write":1,
      "web_search":1
    }
  }'::jsonb,
  jsonb_build_object('synthetic_tokens', 1000 + task.task_number),
  encode(extensions.digest('synthetic-full-matrix-package', 'sha256'), 'hex'),
  '{"synthetic":true,"trust_layer":"unverified","signature_status":"unverified"}'::jsonb
from aiq_private.aiq_runs run
join aiq_private.aiq_model_configs model on model.model_config_id = run.model_config_id
cross join ordered_tasks task;

with constants as (
  select
    'run_' || encode(extensions.digest('synthetic-complete-batch', 'sha256'), 'hex')
      as batch_id,
    encode(extensions.digest('synthetic-full-matrix-package', 'sha256'), 'hex')
      as package_sha256,
    'sha256:' || encode(
      extensions.digest('synthetic-full-matrix-content', 'sha256'),
      'hex'
    ) as content_hash,
    'sha256:' || encode(
      extensions.digest('synthetic-full-matrix-normalization', 'sha256'),
      'hex'
    ) as normalization_digest
),
official_node as (
  select node_id, public_key
  from aiq_private.aiq_nodes
  where operator_class = 'official'
),
verifier_node as (
  select node_id, key_fingerprint, public_key
  from aiq_private.aiq_nodes
  where operator_class = 'verifier'
),
signed_models as (
  select jsonb_agg(
    jsonb_build_object(
      'family', model_family,
      'reasoning_effort', reasoning_effort
    )
    order by matrix_order
  ) as value
  from aiq_private.aiq_model_configs
  where expected_in_matrix
),
signed_result_rows as (
  select
    result,
    run,
    model,
    task,
    constants,
    case when result.outcome = 'timeout' then null else jsonb_build_object(
      'schema_version', 'aiq.evaluator-result.v3',
      'outcome', result.outcome::text,
      'score', result.task_score,
      'checks', jsonb_build_array(
        jsonb_build_object(
          'check_id', 'synthetic_seed_score',
          'weight', 10,
          'passed', result.outcome = 'correct',
          'failure_class', case when result.outcome = 'correct' then 'none' else 'value' end,
          'evidence_digest', 'sha256:' || encode(
            extensions.digest(result.source_result_id || ':synthetic-check', 'sha256'), 'hex'
          )
        )
      )
    ) end as evaluator_result
  from aiq_private.aiq_task_results result
  join aiq_private.aiq_runs run on run.run_id = result.run_id
  join aiq_private.aiq_model_configs model
    on model.model_config_id = run.model_config_id
  join aiq_private.aiq_task_catalog task
    on task.task_set_id = run.task_set_id
   and task.task_set_version = run.task_set_version
   and task.task_id = result.task_id
   and task.task_version = result.task_version
  cross join constants
),
signed_results as (
  select jsonb_agg(
    jsonb_build_object(
      'schema_version', 'aiq.result.v2',
      'result_id', (row.result).source_result_id,
      'run_id', (row.constants).batch_id,
      'task_id', (row.result).task_id,
      'task_version', (row.result).task_version,
      'task_hash', 'sha256:' || (row.task).fixture_commitment,
      'model', jsonb_build_object(
        'family', (row.model).model_family,
        'reasoning_effort', (row.model).reasoning_effort
      ),
      'status', case when (row.result).outcome = 'timeout' then 'failed' else 'completed' end,
      'evaluation', case (row.result).outcome
        when 'correct' then 'correct'
        when 'partial' then 'partial'
        else 'incorrect'
      end,
      'task_score', (row.result).task_score,
      'response', null,
      'response_sha256', null,
      'evaluator_result_sha256', case when row.evaluator_result is null then null else
        'sha256:' || encode(
          extensions.digest(convert_to(row.evaluator_result::text, 'utf8'), 'sha256'), 'hex'
        )
      end,
      'artifacts', '[]'::jsonb,
      'failure', case when (row.result).outcome = 'timeout' then jsonb_build_object(
        'kind', 'timeout',
        'message', (row.result).failure_detail,
        'exit_code', null,
        'retryable', (row.result).failure_retryable
      ) else 'null'::jsonb end,
      'latency', jsonb_build_object('wall_ms', (row.result).latency_ms),
      'tool_usage', (row.result).tool_usage,
      'workspace_manifest', null,
      'provenance', jsonb_build_object(
        'node_id', (row.run).source_node_id,
        'runner_version', '1.0.0',
        'codex_version', 'synthetic',
        'observed_at', to_jsonb((row.run).completed_at),
        'synthetic', true,
        'local_trust', 'trusted'
      )
    )
    order by (row.model).matrix_order, (row.task).task_id
  ) as value
  from signed_result_rows row
),
evaluator_bundle as (
  select jsonb_build_object(
    'schema_version', 'aiq.evaluator-results.v1',
    'results', jsonb_agg(
      row.evaluator_result order by (row.model).matrix_order, (row.task).task_id
    )
  ) as value
  from signed_result_rows row
),
evaluator_bundle_identity as (
  select
    encode(
      extensions.digest(convert_to(evaluator_bundle.value::text, 'utf8'), 'sha256'),
      'hex'
    ) as content_sha256,
    octet_length(convert_to(evaluator_bundle.value::text, 'utf8')) as byte_size
  from evaluator_bundle
)
insert into aiq_private.aiq_result_packages (
  package_sha256, schema_version, idempotency_key, run_id, node_id,
  content_hash, envelope, signature, signature_verified, verifier_attestation,
  trust_tier, received_at, verified_at, artifact_expires_at, provenance,
  matrix_batch_id, normalization_digest
)
select
  constants.package_sha256,
  'aiq.result-package.v3',
  constants.batch_id,
  constants.batch_id,
  node.node_id,
  constants.content_hash,
  jsonb_build_object(
    'schema_version', 'aiq.result-package.v3',
    'idempotency_key', constants.batch_id,
    'payload_type', 'aiq.run.v3',
    'content_hash', constants.content_hash,
    'signer', jsonb_build_object('node_id', node.node_id, 'public_key', node.public_key),
    'claimed_trust', 'trusted',
    'payload', jsonb_build_object(
      'schema_version', 'aiq.run.v3',
      'run_id', constants.batch_id,
      'schedule_slot', jsonb_build_object(
        'local_date', '2026-07-24',
        'occurrence', 'day',
        'local_time', '12:00',
        'timezone', 'UTC'
      ),
      'task_set_hash', 'sha256:' || task_set.catalog_sha256,
      'scoring_version', '1.0.5',
      'models', signed_models.value,
      'execution_concurrency', 1,
      'started_unix_ms', 1784894400000,
      'finished_unix_ms', 1784895480000,
      'synthetic', true,
      'provenance', null,
      'capability_validation', null,
      'evaluator_results_artifact', jsonb_build_object(
        'kind', 'evaluator-results.json',
        'content_hash', 'sha256:' || evaluator_bundle_identity.content_sha256,
        'uri', 'aiq-artifact://sha256/' || evaluator_bundle_identity.content_sha256
          || '/evaluator-results.json',
        'bytes', evaluator_bundle_identity.byte_size
      ),
      'results', signed_results.value
    ),
    'signature', repeat('ab', 64)
  ),
  repeat('ab', 64),
  false,
  null,
  'unverified',
  '2026-07-24T12:19:00Z',
  null,
  null,
  '{"schema_version":"aiq.package-binding.v3"}'::jsonb,
  constants.batch_id,
  constants.normalization_digest
from constants
cross join official_node node
cross join verifier_node verifier
cross join signed_models
cross join signed_results
cross join evaluator_bundle_identity
cross join aiq_private.aiq_task_sets task_set
where task_set.task_set_id = 'aiq-core' and task_set.task_set_version = '1.0.5';

with artifact as (
  select
    package.idempotency_key as run_id,
    package.envelope #> '{payload,evaluator_results_artifact}' as reference
  from aiq_private.aiq_result_packages package
  where package.schema_version = 'aiq.result-package.v3'
)
insert into aiq_private.aiq_artifact_ingress_objects (
  artifact_kind, content_sha256, bucket_name, object_path, byte_size
)
select
  'evaluator-results.json',
  replace(artifact.reference ->> 'content_hash', 'sha256:', ''),
  'aiq-runner-artifacts',
  'sha256/' || replace(artifact.reference ->> 'content_hash', 'sha256:', '')
    || '/evaluator-results.json',
  (artifact.reference ->> 'bytes')::bigint
from artifact;

insert into aiq_private.aiq_artifact_ingress_claims (
  claimed_run_id, artifact_kind, content_sha256
)
select
  package.idempotency_key,
  'evaluator-results.json',
  replace(
    package.envelope #>> '{payload,evaluator_results_artifact,content_hash}',
    'sha256:',
    ''
  )
from aiq_private.aiq_result_packages package
where package.schema_version = 'aiq.result-package.v3';

insert into aiq_private.aiq_matrix_batches (
  matrix_batch_id, package_sha256, content_hash, normalization_digest,
  source_node_id, task_set_id, task_set_version, scoring_version, synthetic,
  verified_at, published_at, task_set_hash, capability_validation_digest,
  benchmark_version, prompt_set_digest, source_scoring_version, runner_commit,
  region, scheduled_unix_ms, started_unix_ms, finished_unix_ms,
  execution_concurrency
)
select
  package.matrix_batch_id, package.package_sha256, package.content_hash,
  package.normalization_digest, package.node_id, 'aiq-core', '1.0.5', '1.0.5',
  true, null, null,
  'sha256:' || task_set.catalog_sha256, null, 'aiq-core@1.0.5',
  'sha256:' || encode(
    extensions.digest('aiq-core:prompt-set:1.0.5', 'sha256'), 'hex'
  ),
  '1.0.5', 'a7d91f4', 'us-east-1',
  1784894400000, 1784894400000, 1784895480000, 1
from aiq_private.aiq_result_packages package
cross join aiq_private.aiq_task_sets task_set
where task_set.task_set_id = 'aiq-core' and task_set.task_set_version = '1.0.5';

insert into aiq_private.aiq_package_runs (
  package_sha256, run_id, model_config_id, matrix_order
)
select package.package_sha256, run.run_id, run.model_config_id, model.matrix_order
from aiq_private.aiq_result_packages package
cross join aiq_private.aiq_runs run
join aiq_private.aiq_model_configs model
  on model.model_config_id = run.model_config_id;

with domain_means as (
  select
    result.run_id,
    result.domain,
    avg(result.task_score)::numeric as domain_score
  from aiq_private.aiq_task_results result
  group by result.run_id, result.domain
),
run_scores as (
  select
    run_id,
    avg(domain_score) * 100 as fixed_score,
    jsonb_object_agg(domain, round(domain_score, 5) order by domain) as domain_scores
  from domain_means
  group by run_id
),
binary_inputs as (
  select
    result.run_id,
    count(*) filter (where result.task_score in (0, 1))::numeric as sample_size,
    count(*) filter (where result.task_score = 1)::numeric as successes,
    count(*) filter (where result.task_score = 1)::numeric
      / nullif(
        count(*) filter (where result.task_score in (0, 1))::numeric,
        0
      ) as proportion,
    1.959963984540054::numeric as z
  from aiq_private.aiq_task_results result
  group by result.run_id
),
binary_diagnostics as (
  select
    run_id,
    proportion,
    (
      proportion + (z * z) / (2 * nullif(sample_size, 0))
      - z * sqrt(
        proportion * (1 - proportion) / nullif(sample_size, 0)
          + (z * z) / (4 * nullif(sample_size, 0) * nullif(sample_size, 0))
      )
    ) / (1 + (z * z) / nullif(sample_size, 0)) as wilson_low,
    (
      proportion + (z * z) / (2 * nullif(sample_size, 0))
      + z * sqrt(
        proportion * (1 - proportion) / nullif(sample_size, 0)
          + (z * z) / (4 * nullif(sample_size, 0) * nullif(sample_size, 0))
      )
    ) / (1 + (z * z) / nullif(sample_size, 0)) as wilson_high
  from binary_inputs
)
insert into aiq_private.aiq_score_snapshots (
  score_snapshot_id, run_id, scoring_version, score_status, fixed_fixture_aiq,
  task_resampling_low, task_resampling_high, completion_bound_low,
  completion_bound_high, micro_accuracy, micro_wilson_low, micro_wilson_high,
  valid_task_count, expected_task_count, covered_domain_count,
  expected_domain_count, invalid_count, missing_count, not_applicable_count,
  domain_scores, interval_parameters, published, calculated_at,
  normalization_digest
)
select
  (
    substr(md5(run.run_id || ':score'), 1, 8) || '-'
    || substr(md5(run.run_id || ':score'), 9, 4) || '-'
    || substr(md5(run.run_id || ':score'), 13, 4) || '-'
    || substr(md5(run.run_id || ':score'), 17, 4) || '-'
    || substr(md5(run.run_id || ':score'), 21, 12)
  )::uuid,
  run.run_id,
  '1.0.5',
  'synthetic_complete',
  round(score.fixed_score, 3),
  greatest(0, round(score.fixed_score - 2, 3)),
  least(100, round(score.fixed_score + 2, 3)),
  round(score.fixed_score, 3),
  round(score.fixed_score, 3),
  round(diagnostic.proportion, 6),
  round(diagnostic.wilson_low, 6),
  round(diagnostic.wilson_high, 6),
  72,
  72,
  10,
  10,
  0,
  0,
  0,
  score.domain_scores || '{"synthetic":true}'::jsonb,
  jsonb_build_object(
    'method', 'finite_cluster_calibrated_percentile_sensitivity_v1',
    'lower', greatest(0, round(score.fixed_score - 2, 3)),
    'upper', least(100, round(score.fixed_score + 2, 3)),
    'central_mass', 0.95,
    'samples', 10000,
    'seed', 71783153620529
  ),
  false,
  run.completed_at + interval '3 minutes',
  'sha256:' || encode(
    extensions.digest('synthetic-full-matrix-normalization', 'sha256'),
    'hex'
  )
from aiq_private.aiq_runs run
join run_scores score on score.run_id = run.run_id
join binary_diagnostics diagnostic on diagnostic.run_id = run.run_id;

insert into aiq_private.aiq_submission_inbox (
  idempotency_key, package_sha256, envelope, request_context,
  verification_status, state, received_at, expires_at
)
select
  package.matrix_batch_id,
  package.package_sha256,
  package.envelope,
  jsonb_build_object(
    'idempotency_key', package.matrix_batch_id,
    'package_sha256', package.package_sha256,
    'received_at', to_jsonb(package.received_at),
    'source', 'deterministic-seed',
    'body_bytes', octet_length(package.envelope::text)
  ),
  'unverified',
  'processed',
  package.received_at,
  package.received_at + interval '30 days'
from aiq_private.aiq_result_packages package;

insert into aiq_private.aiq_verification_audit (
  inbox_id, run_id, package_sha256, event_type, actor_node_id, event_record,
  recorded_at
)
select
  inbox.inbox_id,
  null,
  package.package_sha256,
  'staged',
  package.node_id,
  jsonb_build_object(
    'schema_version', 'aiq.stage-audit.v3',
    'matrix_batch_id', package.matrix_batch_id,
    'normalization_digest', package.normalization_digest,
    'run_class', null,
    'provenance', null,
    'child_count', 17,
    'task_result_count', 1224
  ),
  package.received_at
from aiq_private.aiq_result_packages package
join aiq_private.aiq_submission_inbox inbox
  on inbox.idempotency_key = package.matrix_batch_id
  and inbox.package_sha256 = package.package_sha256;

insert into aiq_private.aiq_verification_audit (
  inbox_id, run_id, package_sha256, event_type, actor_node_id, event_record,
  recorded_at
)
select
  inbox.inbox_id,
  null,
  package.package_sha256,
  event.event_type,
  package.verifier_attestation -> 'verifier' ->> 'node_id',
  package.verifier_attestation,
  package.verified_at
from aiq_private.aiq_result_packages package
join aiq_private.aiq_submission_inbox inbox
  on inbox.idempotency_key = package.matrix_batch_id
  and inbox.package_sha256 = package.package_sha256
cross join (
  values ('staged')
) event(event_type)
where false;

-- The complete synthetic demonstration remains populated as terminal,
-- unverified seed history. It is not claimable work, and no fake signature,
-- verifier attestation, package, run, or score is marked verified or published.

-- The distributed-radar rows are deterministic demonstration data. Every row
-- is synthetic, and every stored signature is explicitly unverified or
-- rejected. Hash-shaped values and signatures are contract fixtures, not
-- cryptographic evidence.
do $$
declare
  package_id constant text := 'taskpkg_' || repeat('1', 64);
  package_hash constant text := 'sha256:' || repeat('2', 64);
  distributed_run_id constant text := 'run_' || repeat('c', 64);
  atlas_node text;
  kepler_node text;
  nomad_node text;
begin
  select node_id into strict atlas_node
  from aiq_private.aiq_nodes where display_name = 'Atlas / IAD';
  select node_id into strict kepler_node
  from aiq_private.aiq_nodes where display_name = 'Kepler / FRA';
  select node_id into strict nomad_node
  from aiq_private.aiq_nodes where display_name = 'Nomad / unknown';

  insert into aiq_private.aiq_distributed_task_packages (
    task_package_id, package_version, schema_version, idempotency_key,
    package_hash, coordinator_node_id, task_set_id, task_set_version, task_count,
    manifest_bytes, signature_algorithm, signature, signature_status, synthetic,
    created_at, expires_at
  ) values (
    package_id, 1, 'aiq.distributed-task-package.v1', package_id || ':1',
    package_hash, atlas_node, 'aiq-core', '1.0.5', 4, 2048,
    'ed25519', repeat('9', 128), 'unverified', true,
    '2026-07-24T14:00:00Z', '2026-07-25T14:00:00Z'
  );

  insert into aiq_private.aiq_distributed_capability_declarations (
    declaration_id, schema_version, node_id, declaration_sequence,
    declaration_hash, capability_hash, status, signature_algorithm, signature,
    signature_status, issued_at, expires_at, synthetic
  ) values
    ('10000000-0000-4000-8000-000000000001',
      'aiq.distributed-capability.v1', atlas_node, 1,
      'sha256:' || repeat('3', 64), 'sha256:' || repeat('4', 64),
      'declared', 'ed25519', repeat('0', 128), 'unverified',
      '2026-07-24T14:01:00Z', '2026-07-24T15:01:00Z', true),
    ('10000000-0000-4000-8000-000000000002',
      'aiq.distributed-capability.v1', kepler_node, 1,
      'sha256:' || repeat('5', 64), 'sha256:' || repeat('6', 64),
      'rejected', 'ed25519', repeat('1', 128), 'rejected',
      '2026-07-24T14:02:00Z', '2026-07-24T15:02:00Z', true),
    ('10000000-0000-4000-8000-000000000003',
      'aiq.distributed-capability.v1', nomad_node, 1,
      'sha256:' || repeat('7', 64), 'sha256:' || repeat('8', 64),
      'declared', 'ed25519', repeat('2', 128), 'unverified',
      '2026-07-24T14:03:00Z', '2026-07-24T15:03:00Z', true);

  insert into aiq_private.aiq_distributed_node_observations (
    observation_id, schema_version, node_id, declaration_id,
    observation_sequence, observation_hash, node_state, receiver_status,
    provenance_hash, signature_algorithm, signature, signature_status,
    observed_at, received_at, synthetic
  ) values
    ('observation_' || repeat('1', 64),
      'aiq.distributed-observation.v1', atlas_node,
      '10000000-0000-4000-8000-000000000001', 1,
      'sha256:' || repeat('9', 64), 'ready', 'observed',
      'sha256:' || repeat('a', 64), 'ed25519', repeat('3', 128), 'unverified',
      '2026-07-24T14:04:00Z', '2026-07-24T14:04:01Z', true),
    ('observation_' || repeat('2', 64),
      'aiq.distributed-observation.v1', kepler_node,
      '10000000-0000-4000-8000-000000000002', 1,
      'sha256:' || repeat('b', 64), 'busy', 'rejected',
      'sha256:' || repeat('c', 64), 'ed25519', repeat('4', 128), 'rejected',
      '2026-07-24T14:05:00Z', '2026-07-24T14:05:01Z', true),
    ('observation_' || repeat('3', 64),
      'aiq.distributed-observation.v1', nomad_node,
      '10000000-0000-4000-8000-000000000003', 1,
      'sha256:' || repeat('d', 64), 'offline', 'stale',
      'sha256:' || repeat('e', 64), 'ed25519', repeat('5', 128), 'unverified',
      '2026-07-24T14:06:00Z', '2026-07-24T14:06:01Z', true);

  insert into aiq_private.aiq_distributed_assignments (
    assignment_id, lease_attempt, schema_version, task_package_id, package_version,
    package_hash, assignment_hash, run_id, coordinator_node_id, node_id,
    assignment_sequence, status, lease_id, signature_algorithm, signature,
    signature_status, synthetic,
    offered_at, accepted_at, running_at, completed_at, revoked_at, expired_at,
    expires_at, updated_at
  ) values
    ('assignment_' || repeat('1', 64), 1,
      'aiq.distributed-assignment.v1', package_id, 1, package_hash,
      'sha256:' || repeat('c', 64), distributed_run_id, atlas_node,
      atlas_node, 1, 'offered', 'lease_' || repeat('1', 64),
      'ed25519', repeat('a', 128), 'unverified', true, '2026-07-24T14:10:00Z',
      null, null, null, null, null,
      '2026-07-24T15:10:00Z', '2026-07-24T14:10:00Z'),
    ('assignment_' || repeat('2', 64), 1,
      'aiq.distributed-assignment.v1', package_id, 1, package_hash,
      'sha256:' || repeat('d', 64), distributed_run_id, atlas_node,
      atlas_node, 2, 'accepted', 'lease_' || repeat('2', 64),
      'ed25519', repeat('b', 128), 'unverified', true,
      '2026-07-24T14:11:00Z', '2026-07-24T14:11:01Z',
      null, null, null, null,
      '2026-07-24T15:11:00Z', '2026-07-24T14:11:01Z'),
    ('assignment_' || repeat('3', 64), 1,
      'aiq.distributed-assignment.v1', package_id, 1, package_hash,
      'sha256:' || repeat('e', 64), distributed_run_id, atlas_node,
      atlas_node, 3, 'running', 'lease_' || repeat('3', 64),
      'ed25519', repeat('c', 128), 'unverified', true,
      '2026-07-24T14:12:00Z', '2026-07-24T14:12:01Z',
      '2026-07-24T14:12:02Z', null, null, null,
      '2026-07-24T15:12:00Z', '2026-07-24T14:12:02Z'),
    ('assignment_' || repeat('4', 64), 1,
      'aiq.distributed-assignment.v1', package_id, 1, package_hash,
      'sha256:' || repeat('f', 64), distributed_run_id, atlas_node,
      kepler_node, 1, 'completed', 'lease_' || repeat('4', 64),
      'ed25519', repeat('d', 128), 'unverified', true, '2026-07-24T14:13:00Z',
      '2026-07-24T14:13:01Z', '2026-07-24T14:13:02Z',
      '2026-07-24T14:13:03Z', null, null,
      '2026-07-24T15:13:00Z', '2026-07-24T14:13:03Z'),
    ('assignment_' || repeat('5', 64), 1,
      'aiq.distributed-assignment.v1', package_id, 1, package_hash,
      'sha256:' || repeat('0', 64), distributed_run_id, atlas_node,
      kepler_node, 2, 'revoked', 'lease_' || repeat('5', 64),
      'ed25519', repeat('e', 128), 'unverified', true, '2026-07-24T14:14:00Z',
      null, null, null, '2026-07-24T14:14:01Z', null,
      '2026-07-24T15:14:00Z', '2026-07-24T14:14:01Z'),
    ('assignment_' || repeat('6', 64), 1,
      'aiq.distributed-assignment.v1', package_id, 1, package_hash,
      'sha256:' || repeat('1', 64), distributed_run_id, atlas_node,
      nomad_node, 1, 'expired', 'lease_' || repeat('6', 64),
      'ed25519', repeat('f', 128), 'unverified', true, '2026-07-24T14:15:00Z',
      null, null, null, null, '2026-07-24T15:15:00Z',
      '2026-07-24T15:15:00Z', '2026-07-24T15:15:00Z');

  insert into aiq_private.aiq_distributed_assignment_models (
    run_id, assignment_id, lease_attempt, node_id, model_config_id, synthetic
  ) values
    (distributed_run_id, 'assignment_' || repeat('1', 64), 1,
      atlas_node, 'sol-low', true),
    (distributed_run_id, 'assignment_' || repeat('2', 64), 1,
      atlas_node, 'sol-medium', true),
    (distributed_run_id, 'assignment_' || repeat('3', 64), 1,
      atlas_node, 'sol-high', true),
    (distributed_run_id, 'assignment_' || repeat('4', 64), 1,
      kepler_node, 'terra-low', true),
    (distributed_run_id, 'assignment_' || repeat('5', 64), 1,
      kepler_node, 'terra-medium', true),
    (distributed_run_id, 'assignment_' || repeat('6', 64), 1,
      nomad_node, 'luna-low', true);

  insert into aiq_private.aiq_distributed_result_receipts (
    receipt_id, schema_version, assignment_id, lease_attempt, receiver_node_id,
    node_id, result_package_hash,
    receipt_hash, provenance_hash, status, signature_algorithm, signature,
    signature_status, received_at, decided_at, synthetic
  ) values
    ('receipt_' || repeat('1', 64),
      'aiq.distributed-result-receipt.v1',
      'assignment_' || repeat('3', 64), 1, kepler_node, atlas_node,
      'sha256:' || repeat('f', 64), 'sha256:' || repeat('0', 64),
      'sha256:' || repeat('1', 64), 'received', 'ed25519',
      repeat('6', 128), 'unverified', '2026-07-24T14:20:00Z', null, true),
    ('receipt_' || repeat('2', 64),
      'aiq.distributed-result-receipt.v1',
      'assignment_' || repeat('4', 64), 1, atlas_node, kepler_node,
      'sha256:' || repeat('2', 64), 'sha256:' || repeat('3', 64),
      'sha256:' || repeat('4', 64), 'accepted', 'ed25519',
      repeat('7', 128), 'unverified', '2026-07-24T14:21:00Z',
      '2026-07-24T14:21:01Z', true),
    ('receipt_' || repeat('3', 64),
      'aiq.distributed-result-receipt.v1',
      'assignment_' || repeat('5', 64), 1, atlas_node, kepler_node,
      'sha256:' || repeat('5', 64), 'sha256:' || repeat('6', 64),
      'sha256:' || repeat('7', 64), 'rejected', 'ed25519',
      repeat('8', 128), 'rejected', '2026-07-24T14:22:00Z',
      '2026-07-24T14:22:01Z', true);

  insert into aiq_private.aiq_distributed_aggregation_inputs (
    aggregation_input_id, schema_version, task_package_id, package_version,
    run_id, assignment_id, lease_attempt, node_id, model_config_id,
    observation_id, receipt_id, receipt_hash, result_package_hash,
    input_sequence, input_hash, trust_classification, classification_reason,
    classified_at, synthetic
  ) values
    ('50000000-0000-4000-8000-000000000001',
      'aiq.distributed-aggregation-input.v1', package_id, 1,
      distributed_run_id, 'assignment_' || repeat('3', 64), 1,
      atlas_node, 'sol-high',
      'observation_' || repeat('1', 64),
      'receipt_' || repeat('1', 64), 'sha256:' || repeat('0', 64),
      'sha256:' || repeat('f', 64), 1,
      'sha256:' || repeat('8', 64), 'signed_untrusted',
      'synthetic_unverified_fixture', '2026-07-24T14:30:00Z', true),
    ('50000000-0000-4000-8000-000000000002',
      'aiq.distributed-aggregation-input.v1', package_id, 1,
      distributed_run_id, 'assignment_' || repeat('4', 64), 1,
      kepler_node, 'terra-low',
      'observation_' || repeat('2', 64),
      'receipt_' || repeat('2', 64), 'sha256:' || repeat('3', 64),
      'sha256:' || repeat('2', 64), 1,
      'sha256:' || repeat('9', 64), 'signed_untrusted',
      'synthetic_unverified_fixture', '2026-07-24T14:31:00Z', true),
    ('50000000-0000-4000-8000-000000000003',
      'aiq.distributed-aggregation-input.v1', package_id, 1,
      distributed_run_id, 'assignment_' || repeat('5', 64), 1,
      kepler_node, 'terra-medium',
      'observation_' || repeat('2', 64),
      'receipt_' || repeat('3', 64), 'sha256:' || repeat('6', 64),
      'sha256:' || repeat('5', 64), 2,
      'sha256:' || repeat('a', 64), 'rejected',
      'synthetic_unverified_fixture', '2026-07-24T14:32:00Z', true),
    ('50000000-0000-4000-8000-000000000004',
      'aiq.distributed-aggregation-input.v1', package_id, 1,
      distributed_run_id, 'assignment_' || repeat('6', 64), 1,
      nomad_node, 'luna-low', null, null, null, null, 1,
      'sha256:' || repeat('b', 64), 'missing',
      'synthetic_missing_fixture', '2026-07-24T14:33:00Z', true);
end;
$$;

commit;
