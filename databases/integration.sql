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
    'source', 'https://developers.openai.com/api/docs/models/compare',
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
        'input_usd_nanos_per_token', 2500,
        'cached_input_usd_nanos_per_token', 250,
        'cache_write_input_usd_nanos_per_token', 3125,
        'output_usd_nanos_per_token', 15000
      ),
      jsonb_build_object(
        'model', 'gpt-5.6-luna',
        'input_usd_nanos_per_token', 1000,
        'cached_input_usd_nanos_per_token', 100,
        'cache_write_input_usd_nanos_per_token', 1250,
        'output_usd_nanos_per_token', 6000
      )
    ),
    'formula', '(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again',
    'hosted_tool_fees_included', false,
    'limitation', 'Standard API-equivalent comparison only. Aggregated turn usage does not expose per-request long-context multipliers. This is not actual subscription spend.'
  );
$$;

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
  task_hashes jsonb;
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
  task_number integer;
  model jsonb;
  task_hash text;
begin
  select jsonb_agg(hash order by hash) into task_hashes
  from (
    select 'sha256:' || encode(
      extensions.digest(
        convert_to('task-' || lpad(number::text, 2, '0'), 'utf8'),
        'sha256'
      ),
      'hex'
    ) as hash
    from generate_series(1, 72) number
  ) hashes;
  task_set_hash := aiq_private.jcs_sha256(task_hashes);
  run_id := 'run_' || substr(aiq_private.jcs_sha256(jsonb_build_object(
    'schema_version', 'aiq.run-identity.v1',
    'slot', slot,
    'task_set_hash', task_set_hash,
    'models', models,
    'scoring_version', '1.0.0'
  )), 8);

  for task_number in 1..72 loop
    task_hash := 'sha256:' || encode(
      extensions.digest(
        convert_to('task-' || lpad(task_number::text, 2, '0'), 'utf8'),
        'sha256'
      ),
      'hex'
    );
    for model in select value from jsonb_array_elements(models) loop
      result_base := jsonb_build_object(
        'schema_version', 'aiq.result.v2',
        'run_id', run_id,
        'task_id', 'task-' || lpad(task_number::text, 2, '0'),
        'task_version', '1.0.0',
        'task_hash', task_hash,
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
    'scoring_version', '1.0.0',
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

-- An incomplete pre-staged transaction must not masquerade as an idempotent
-- recovery. A complete retry is accepted only when all canonical child and
-- audit evidence is present.
savepoint stage_resume;
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
  jsonb_build_object(
    'schema_version', 'aiq.normalized-batch.v3',
    'matrix_batch_id', input.run_id,
    'package_sha256', input.package_sha256,
    'content_hash', input.envelope ->> 'content_hash',
    'signer', input.envelope -> 'signer',
    'task_set_id', 'aiq-core',
    'task_set_version', '1.0.0',
    'task_set_hash', input.envelope #>> '{payload,task_set_hash}',
    'capability_validation_digest', null,
    'provenance', null,
    'run_class', null,
    'benchmark_version', 'aiq-core@1.0.0',
    'prompt_set_digest', 'sha256:' || repeat('f', 64),
    'scoring_version', '1.0.0',
    'runner_commit', 'a7d91f4',
    'region', 'integration',
    'scheduled_unix_ms', 1785164400000,
    'started_unix_ms', 1785164400000,
    'finished_unix_ms', 1785164400001,
    'execution_concurrency', 1,
    'synthetic', true,
    'result_efficiency', (
      select jsonb_agg(
        jsonb_build_object(
          'cost_evidence_level', null,
          'cost_status', 'unavailable_missing_usage',
          'model', result -> 'model',
          'observed_wall_ms', result #> '{latency,wall_ms}',
          'provider_tokens', '{}'::jsonb,
          'provider_tokens_evidence_level', null,
          'provider_tokens_source', null,
          'source_result_id', result ->> 'result_id',
          'standard_api_equivalent_usd_nanos', null,
          'task_id', result ->> 'task_id',
          'wall_time_evidence_level', 'runner_observed'
        )
        order by result -> 'model', result ->> 'task_id'
      )
      from jsonb_array_elements(input.envelope #> '{payload,results}') result
    ),
    'efficiency', (
      select jsonb_agg(
        jsonb_build_object(
          'schema_version', 'aiq.calibration-efficiency.v1',
          'model', model.value,
          'selected_tasks', 72,
          'observed_wall_tasks', 72,
          'total_observed_wall_ms', 72,
          'median_observed_wall_ms', 1,
          'p95_observed_wall_ms', 1,
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
        )
        order by model.ordinality
      )
      from jsonb_array_elements(input.envelope #> '{payload,models}')
        with ordinality model(value, ordinality)
    ),
    'pricing', pg_temp.aiq_efficiency_pricing(),
    'runs', (
      select jsonb_agg('{}'::jsonb order by number)
      from generate_series(1, 17) number
    ),
    'normalization_digest', 'sha256:' || repeat('e', 64)
  ) as stage
from aiq_integration_input input
cross join aiq_enqueue_accepted accepted
cross join aiq_claim_two claim;
grant select on aiq_stage_resume_input to aiq_verifier;

set local session_replication_role = replica;
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
insert into aiq_private.aiq_matrix_batches (
  matrix_batch_id, package_sha256, content_hash, normalization_digest,
  source_node_id, task_set_id, task_set_version, scoring_version, synthetic,
  task_set_hash, capability_validation_digest, benchmark_version,
  prompt_set_digest, source_scoring_version, runner_commit, region,
  scheduled_unix_ms, started_unix_ms, finished_unix_ms,
  execution_concurrency, normalized_stage
)
select
  run_id, package_sha256, envelope ->> 'content_hash',
  stage ->> 'normalization_digest', node_id, 'aiq-core', '1.0.0', '1.0.0',
  true, stage ->> 'task_set_hash', null, 'aiq-core@1.0.0',
  stage ->> 'prompt_set_digest', '1.0.0', 'a7d91f4', 'integration',
  1785164400000, 1785164400000, 1785164400001, 1, stage
from aiq_stage_resume_input;
insert into aiq_private.aiq_result_packages (
  package_sha256, schema_version, idempotency_key, run_id, node_id,
  content_hash, envelope, signature, signature_verified, trust_tier,
  received_at, provenance, matrix_batch_id, normalization_digest
)
select
  package_sha256, 'aiq.result-package.v3', run_id, run_id, node_id,
  envelope ->> 'content_hash', envelope, envelope ->> 'signature', false,
  'unverified', '2026-07-30T12:00:00Z',
  '{"schema_version":"aiq.package-binding.v3"}'::jsonb,
  run_id, stage ->> 'normalization_digest'
from aiq_stage_resume_input;
update aiq_private.aiq_submission_inbox inbox
set state = 'processed'
from aiq_stage_resume_input fixture
where inbox.inbox_id = fixture.inbox_id;
set local session_replication_role = origin;

set local role aiq_verifier;
select set_config('request.jwt.claims', '{"role":"aiq_verifier"}', true);
do $$
begin
  begin
    perform public.aiq_stage_verifier_result(
      stage, inbox_id, lease_token, attempt
    )
    from aiq_stage_resume_input;
    raise exception 'incomplete staged evidence resumed as complete';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
reset role;
rollback to savepoint stage_resume;
release savepoint stage_resume;

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
  (select count(*) = 4
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'public_calibration_results'
     and column_name in (
       'status','failure_code','explanation_code','explanation_summary'
     )),
  'public calibration results must expose bounded failure classification'
);

rollback;
