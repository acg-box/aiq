\set ON_ERROR_STOP on

-- This rollback-only integration check runs against the exact production initializer database.

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
  aiq_private.task_catalog_is_exact('aiq-core','1.0.5'),
  'calibration integration requires the exact production initializer catalog'
);

-- Exercise one complete, structurally valid calibration transition through the
-- real queue, verifier, publisher, Storage, and browser-read boundaries. The
-- identities and signatures are deterministic test material. The transaction
-- rolls back all evidence and never invokes a model or external service.
create temp table aiq_calibration_official_baseline on commit drop as
select
  (select count(*) from aiq_private.aiq_matrix_batches) as matrix_batches,
  (select count(*) from aiq_private.aiq_result_packages) as result_packages,
  (select count(*) from aiq_private.aiq_runs) as runs,
  (select count(*) from aiq_private.aiq_score_snapshots) as score_snapshots,
  (select count(*) from public.public_leaderboard) as leaderboard_rows,
  (select count(*) from public.public_trend_points('all')) as trend_rows;

create temp table aiq_calibration_identities on commit drop as
with identities(role_name,public_key,operator_class,trust_tier,capabilities) as (
  values
    ('runner',repeat('21',32),'official','trusted_verified',array['runner']::text[]),
    ('verifier',repeat('22',32),'verifier','independently_reproduced',array['verifier']::text[]),
    ('publisher',repeat('23',32),'official','trusted_verified',array['publisher']::text[])
)
select role_name,public_key,
  'node_'||encode(extensions.digest(decode(public_key,'hex'),'sha256'),'hex') as node_id,
  operator_class,trust_tier,capabilities
from identities;
grant select on aiq_calibration_identities to aiq_publisher;

insert into aiq_private.aiq_nodes(
  node_id,display_name,key_fingerprint,signature_algorithm,public_key,status,
  trust_tier,operator_class,capabilities,source,signature_status,provenance,
  synthetic,public_visible,publisher_authorized,metadata
)
select node_id,'Calibration integration '||role_name,
  'sha256:'||substring(node_id from 6),'ed25519',public_key,'active',
  trust_tier::aiq_private.trust_tier,operator_class,capabilities,
  'rollback-only integration fixture','verified',
  'Structurally valid synthetic identity evidence.',false,true,
  role_name='publisher',jsonb_build_object('approved_role',role_name)
from aiq_calibration_identities;

create or replace function pg_temp.aiq_calibration_envelope()
returns jsonb language plpgsql set search_path='' as $$
declare
  models jsonb;
  task_ids jsonb;
  task_hashes jsonb;
  task_set_hash text;
  schedule_slot jsonb:=jsonb_build_object(
    'local_date','2026-08-02','occurrence','day','local_time','12:00','timezone','UTC'
  );
  runner jsonb;
  preflight_models jsonb;
  preflight jsonb;
  provenance jsonb;
  run_id text;
  results jsonb;
  payload jsonb;
  evaluator_digest text:=repeat('e',64);
begin
  select jsonb_agg(jsonb_build_object(
    'family',model_family,'reasoning_effort',reasoning_effort
  ) order by matrix_order) into models
  from aiq_private.aiq_model_configs where expected_in_matrix;
  select jsonb_agg(task_id order by catalog_ordinal),
    jsonb_agg('sha256:'||fixture_commitment order by fixture_commitment collate "C")
  into task_ids,task_hashes
  from aiq_private.aiq_task_catalog
  where task_set_id='aiq-core' and task_set_version='1.0.5';
  task_set_hash:=aiq_private.jcs_sha256(task_hashes);
  select jsonb_build_object('node_id',node_id,'public_key',public_key)
    into runner from pg_temp.aiq_calibration_identities where role_name='runner';
  select jsonb_agg(jsonb_build_object(
    'model',model,
    'status','unavailable',
    'reason','Synthetic unavailable calibration capability',
    'probe',probe
  ) order by ordinality) into preflight_models
  from jsonb_array_elements(models) with ordinality selected(model,ordinality)
  cross join lateral (
    select jsonb_build_object(
      'status','failed','codex_version','integration','observed_at','unix-ms:1785672000000',
      'result_digest',null,'result_preview',null,'artifacts','[]'::jsonb,
      'failure',failure,
      'evidence_digest',aiq_private.jcs_sha256(jsonb_build_array(
        model,'integration','unix-ms:1785672000000','failed',null,null,'[]'::jsonb,failure
      ))
    ) as probe
    from (select jsonb_build_object(
      'artifacts','[]'::jsonb,'exit_code',null,'kind','spawn',
      'message','Synthetic calibration capability is unavailable','stderr','',
      'stderr_truncated',false,'stdout_truncated',false
    ) as failure) failure_record
  ) built;
  preflight:=jsonb_build_object(
    'schema_version','aiq.capability-validation.v2','node_id',runner->>'node_id',
    'manifest_issues','[]'::jsonb,
    'cli_probe',jsonb_build_object('status','available','version','integration','failure',null),
    'authentication_probe',jsonb_build_object(
      'status','available','mode','chatgpt_subscription','failure',null
    ),
    'models',preflight_models
  );
  provenance:=jsonb_build_object(
    'schema_version','aiq.run-provenance.v2','run_class','calibration',
    'corpus_release_id','corpus_integration_calibration',
    'corpus_commitment_sha256',(select metadata->>'corpus_commitment_sha256'
      from aiq_private.aiq_task_sets where task_set_id='aiq-core' and task_set_version='1.0.5'),
    'catalog_digest','sha256:e5ec5c2fa9d3423b228eb3fc4e717be8e48e34e1a1352608394aa4643850c1a1',
    'task_set_digest',task_set_hash,
    'evaluator_digest','sha256:'||repeat('3',64),
    'runtime_digest','sha256:'||repeat('4',64),
    'preflight_digest',aiq_private.jcs_sha256(preflight),
    'harness_digest','sha256:'||repeat('5',64),
    'prompt_digest','sha256:'||repeat('6',64),
    'tool_policy_digest','sha256:'||repeat('7',64),
    'network_policy_digest','sha256:'||repeat('8',64),
    'environment_digest','sha256:'||repeat('9',64),
    'source_manifest_digest','sha256:'||repeat('a',64),
    'runner_executable_digest','sha256:'||repeat('b',64),
    'codex_executable_digest','sha256:'||repeat('c',64),
    'permission_evidence_digest','sha256:'||repeat('d',64)
  );
  run_id:='run_'||substr(aiq_private.jcs_sha256(jsonb_build_object(
    'schema_version','aiq.run-identity.v3','run_class','calibration',
    'slot',schedule_slot,'task_set_hash',task_set_hash,
    'corpus_commitment_sha256',provenance->'corpus_commitment_sha256',
    'models',models,'scoring_version','1.0.5'
  )),8);
  select jsonb_agg(result order by model_ordinal,task_ordinal) into results
  from (
    select model.ordinality as model_ordinal,task.catalog_ordinal as task_ordinal,
      result_base||jsonb_build_object(
        'result_id','result_'||substr(aiq_private.jcs_sha256(
          result_base||jsonb_build_object('result_id','')
        ),8)
      ) as result
    from jsonb_array_elements(models) with ordinality model(value,ordinality)
    cross join aiq_private.aiq_task_catalog task
    cross join lateral (select jsonb_build_object(
      'schema_version','aiq.result.v2','result_id','', 'run_id',run_id,
      'task_id',task.task_id,'task_version',task.task_version,
      'task_hash','sha256:'||task.fixture_commitment,'model',model.value,
      'status','failed','evaluation','not_evaluated','task_score',null,
      'response',null,'response_sha256',null,'evaluator_result_sha256',null,
      'evaluator_stdout_sha256',null,'artifacts','[]'::jsonb,
      'failure',jsonb_build_object(
        'kind','capability_validation_failed','message','Synthetic calibration preflight failure',
        'exit_code',null,'retryable',false
      ),
      'latency',jsonb_build_object('wall_ms',0),
      'tool_usage',jsonb_build_object('steps',0,'total_calls',0,'by_tool','{}'::jsonb),
      'workspace_manifest',null,
      'provenance',jsonb_build_object(
        'node_id',runner->>'node_id','runner_version','integration',
        'codex_version','integration','observed_at','unix-ms:1785672000000',
        'synthetic',false,'local_trust','untrusted'
      )
    ) as result_base) built
    where task.task_set_id='aiq-core' and task.task_set_version='1.0.5'
  ) generated;
  payload:=jsonb_build_object(
    'schema_version','aiq.calibration-run.v3','official_eligible',false,
    'classification','local_calibration_non_official','run_id',run_id,
    'schedule_slot',schedule_slot,'task_set_hash',task_set_hash,
    'scoring_version','1.0.5','execution_concurrency',1,
    'models',models,'task_ids',task_ids,'started_unix_ms',1785672000000,
    'finished_unix_ms',1785672001000,'capability_validation',preflight,
    'provenance',provenance,
    'evaluator_results_artifact',jsonb_build_object(
      'kind','evaluator-results.json','content_hash','sha256:'||evaluator_digest,
      'uri','aiq-artifact://sha256/'||evaluator_digest||'/evaluator-results.json','bytes',128
    ),'results',results
  );
  return jsonb_build_object(
    'schema_version','aiq.result-package.v3','idempotency_key',run_id,
    'payload_type','aiq.calibration-run.v3','content_hash',aiq_private.jcs_sha256(payload),
    'signer',runner,'claimed_trust','untrusted','payload',payload,
    'signature',repeat('31',64)
  );
end;
$$;

create temp table aiq_calibration_input on commit drop as
select envelope,envelope->>'idempotency_key' as run_id,
  encode(extensions.digest(convert_to(envelope::text,'utf8'),'sha256'),'hex') as package_sha256,
  octet_length(convert_to(envelope::text,'utf8'))::bigint as body_bytes
from (select pg_temp.aiq_calibration_envelope() as envelope) fixture;
grant select on aiq_calibration_input to service_role,aiq_verifier,aiq_publisher;

select pg_temp.aiq_assert(
  aiq_private.calibration_package_v3_is_valid(envelope),
  'the calibration ingress package must satisfy the complete database contract'
) from aiq_calibration_input;
select pg_temp.aiq_assert(
  aiq_private.run_provenance_v2_is_valid(envelope#>'{payload,provenance}')
  and aiq_private.run_provenance_v2_is_valid(jsonb_set(
    envelope#>'{payload,provenance}','{run_class}','"official"'::jsonb
  )),
  'generic run provenance must accept only the two explicit run classes'
) from aiq_calibration_input;
select pg_temp.aiq_assert(
  not aiq_private.dto_run_provenance_is_valid(
    envelope#>'{payload,provenance}',envelope#>>'{payload,task_set_hash}',
    envelope#>>'{payload,provenance,preflight_digest}'
  )
  and aiq_private.dto_run_provenance_is_valid(
    jsonb_set(
      jsonb_set(
        envelope#>'{payload,provenance}',
        '{run_class}',
        '"official"'::jsonb
      ),
      '{evaluator_digest}',
      '"sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c"'::jsonb
    ),
    envelope#>>'{payload,task_set_hash}',
    envelope#>>'{payload,provenance,preflight_digest}'
  )
  and not aiq_private.calibration_package_v3_is_valid(jsonb_set(
    envelope,'{payload,provenance,run_class}','"official"'::jsonb
  )),
  'Official and calibration callers must reject cross-class provenance substitution'
) from aiq_calibration_input;

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create temp table aiq_calibration_enqueue on commit drop as
select queued.* from aiq_calibration_input input
cross join lateral public.aiq_enqueue_submission(
  input.envelope,
  jsonb_build_object(
    'body_bytes',input.body_bytes,'idempotency_key',input.run_id,
    'package_sha256',input.package_sha256,'received_at','2026-08-02T12:00:02Z',
    'source','calibration-integration'
  ),
  jsonb_build_object(
    'bucket','aiq-submission-packages','bytes',input.body_bytes,
    'content_sha256',input.package_sha256,'key','sha256/'||input.package_sha256
  )
) queued;
grant select on aiq_calibration_enqueue to aiq_verifier;
select pg_temp.aiq_assert(
  (select disposition='accepted' and object_recorded from aiq_calibration_enqueue),
  'calibration enqueue must retain the package before queue acceptance'
);
select pg_temp.aiq_assert(
  (select disposition='duplicate' and object_recorded
   from aiq_calibration_input input
   cross join lateral public.aiq_enqueue_submission(
     input.envelope,
     jsonb_build_object(
       'body_bytes',input.body_bytes,'idempotency_key',input.run_id,
       'package_sha256',input.package_sha256,'received_at','2026-08-02T12:00:02Z',
       'source','calibration-integration'
     ),
     jsonb_build_object(
       'bucket','aiq-submission-packages','bytes',input.body_bytes,
       'content_sha256',input.package_sha256,'key','sha256/'||input.package_sha256
     )
   ) replay),
  'calibration enqueue retry must be idempotent'
);
select pg_temp.aiq_assert(
  public.aiq_record_artifact_ingress(
    run_id,'evaluator-results.json',repeat('e',64),128,
    jsonb_build_object(
      'bucket','aiq-runner-artifacts',
      'key','sha256/'||repeat('e',64)||'/evaluator-results.json'
    )
  )='accepted','calibration evaluator evidence must enter retained Storage'
) from aiq_calibration_input;
reset role;

set local role aiq_verifier;
select set_config('request.jwt.claims','{"role":"aiq_verifier"}',true);
create temp table aiq_calibration_claim on commit drop as
select claim.* from public.aiq_claim_submission(300) claim
join aiq_calibration_enqueue queued using(inbox_id);
select pg_temp.aiq_assert(
  (select count(*)=1 and min(attempt)=1 from aiq_calibration_claim),
  'the verifier must claim the exact queued calibration package'
);
reset role;

create temp table aiq_calibration_verification on commit drop as
with source as (
  select input.*,claim.inbox_id,claim.lease_token,claim.attempt,
    input.envelope->'payload' as payload,
    input.envelope->'signer' as runner,
    (select jsonb_build_object('node_id',node_id,'public_key',public_key)
      from aiq_calibration_identities where role_name='verifier') as verifier
  from aiq_calibration_input input cross join aiq_calibration_claim claim
), result_efficiency as (
  select source.run_id,jsonb_agg(jsonb_build_object(
    'cost_evidence_level',null,'cost_status','unavailable_missing_usage',
    'model',result->'model','observed_wall_ms',null,'provider_tokens','{}'::jsonb,
    'provider_tokens_evidence_level',null,'provider_tokens_source',null,
    'source_result_id',result->>'result_id','standard_api_equivalent_usd_nanos',null,
    'task_id',result->>'task_id','wall_time_evidence_level',null
  ) order by result->'model',result->>'task_id') as value
  from source cross join lateral jsonb_array_elements(source.payload->'results') result
  group by source.run_id
), scores as (
  select source.run_id,jsonb_agg(jsonb_build_object(
    'model',model,
    'score',jsonb_build_object(
      'schema_version','aiq.calibration-score-report.v1','run_class','calibration',
      'scoring_version','1.0.5','model',model,'descriptive_status','coverage_only',
      'official_eligible',false,'ranking_eligible',false,
      'fixed_fixture_aiq',null,'conditional_observed_aiq',null,'completion_bounds',null,
      'task_resampling_sensitivity_interval',null,
      'binary_micro_diagnostic',jsonb_build_object(
        'sample_size',0,'successes',0,'proportion',null,'wilson_lower',null,'wilson_upper',null
      ),
      'coverage',jsonb_build_object(
        'expected_tasks',72,'valid_tasks',0,'invalid_tasks',72,'missing_tasks',0,
        'not_applicable_tasks',0,'expected_domains',10,'covered_domains',0
      ),
      'difficulty_coverage',jsonb_build_object(
        'easy',jsonb_build_object('expected_tasks',12,'valid_tasks',0),
        'medium',jsonb_build_object('expected_tasks',48,'valid_tasks',0),
        'hard',jsonb_build_object('expected_tasks',12,'valid_tasks',0)
      ),
      'duplicate_results',0,
      'domains',(select jsonb_agg(jsonb_build_object(
        'domain',domain,'expected_tasks',task_count,'valid_tasks',0,'invalid_tasks',task_count,
        'missing_tasks',0,'not_applicable_tasks',0,'zero_failure_tasks',0,'score',null
      ) order by domain) from (
        select domain,count(*)::integer as task_count
        from aiq_private.aiq_task_catalog
        where task_set_id='aiq-core' and task_set_version='1.0.5' group by domain
      ) domain_counts),
      'rule','Synthetic untrusted calibration evidence is descriptive only.'
    ),
    'efficiency',jsonb_build_object(
      'schema_version','aiq.calibration-efficiency.v1','model',model,'selected_tasks',72,
      'observed_wall_tasks',0,'total_observed_wall_ms',null,'median_observed_wall_ms',null,
      'p95_observed_wall_ms',null,'provider_token_totals','{}'::jsonb,
      'provider_token_coverage',jsonb_build_object(
        'selected_tasks',72,'input_tasks',0,'cached_input_tasks',0,
        'cache_write_input_tasks',0,'output_tasks',0,'reasoning_tasks',0,'total_tasks',0
      ),'estimated_cost_tasks',0,'standard_api_equivalent_usd_nanos',null
    )
  ) order by ordinality) as value
  from source cross join lateral jsonb_array_elements(source.payload->'models')
    with ordinality selected(model,ordinality)
  group by source.run_id
), unsigned_stage as (
  select source.*,
    jsonb_build_object(
      'schema_version','aiq.calibration-verified-stage.v1','run_id',source.run_id,
      'package_sha256',source.package_sha256,'content_hash',source.envelope->>'content_hash',
      'runner',source.runner,'classification','local_calibration_non_official',
      'run_class','calibration','official_eligible',false,'ranking_eligible',false,
      'trust','untrusted','task_set_hash',source.payload->>'task_set_hash',
      'task_selection_digest',aiq_private.jcs_sha256(source.payload->'task_ids'),
      'model_selection_digest',aiq_private.jcs_sha256(source.payload->'models'),
      'score_reports_digest',aiq_private.jcs_sha256(scores.value),
      'telemetry_digest',aiq_private.jcs_sha256(result_efficiency.value),
      'capability_validation_digest',aiq_private.jcs_sha256(source.payload->'capability_validation'),
      'provenance',source.payload->'provenance',
      'evaluator_results_artifact',source.payload->'evaluator_results_artifact',
      'scoring_version','1.0.5','execution_concurrency',source.payload->'execution_concurrency',
      'task_ids',source.payload->'task_ids','models',source.payload->'models',
      'scores',scores.value,'result_efficiency',result_efficiency.value,
      'pricing',pg_temp.aiq_efficiency_pricing(),'task_set_id','aiq-core',
      'task_set_version','1.0.5','benchmark_version','aiq-core@1.0.5',
      'prompt_set_digest',source.payload#>>'{provenance,prompt_digest}',
      'runner_commit','integration','region','integration','scheduled_unix_ms',1785672000000,
      'started_unix_ms',source.payload->'started_unix_ms',
      'finished_unix_ms',source.payload->'finished_unix_ms'
    ) as value
  from source join scores using(run_id) join result_efficiency using(run_id)
), stage as (
  select unsigned_stage.*,
    unsigned_stage.value||jsonb_build_object(
      'stage_digest',aiq_private.jcs_sha256(unsigned_stage.value)
    ) as stage
  from unsigned_stage
)
select stage.*,
  jsonb_build_object(
    'schema_version','aiq.calibration-verifier-attestation.v1',
    'signature_algorithm','ed25519','signature_version','aiq.ed25519-jcs.v1',
    'run_id',stage.run_id,'package_sha256',stage.package_sha256,
    'content_hash',stage.envelope->>'content_hash','stage_digest',stage.stage->>'stage_digest',
    'runner',stage.runner,'verifier',stage.verifier,
    'classification','local_calibration_non_official','run_class','calibration',
    'official_eligible',false,'ranking_eligible',false,'trust','untrusted',
    'task_set_hash',stage.stage->>'task_set_hash',
    'task_selection_digest',stage.stage->>'task_selection_digest',
    'model_selection_digest',stage.stage->>'model_selection_digest',
    'score_reports_digest',stage.stage->>'score_reports_digest',
    'telemetry_digest',stage.stage->>'telemetry_digest',
    'capability_validation_digest',stage.stage->>'capability_validation_digest',
    'scoring_version','1.0.5','execution_concurrency',stage.stage->'execution_concurrency',
    'observed_unix_ms',1785672002000,'replay_status','evaluator_replayed',
    'signature',repeat('32',64)
  ) as attestation
from stage;
grant select on aiq_calibration_verification to aiq_verifier,aiq_publisher;

set local role aiq_verifier;
select set_config('request.jwt.claims','{"role":"aiq_verifier"}',true);
select pg_temp.aiq_assert(
  (select public.aiq_stage_calibration_verification(
    stage,inbox_id,lease_token,attempt
  )='recorded' from aiq_calibration_verification),
  'the calibration verifier stage must be recorded'
);
select pg_temp.aiq_assert(
  (select public.aiq_stage_calibration_verification(
    stage,inbox_id,lease_token,attempt
  )='duplicate' from aiq_calibration_verification),
  'exact calibration stage retry must be idempotent'
);
do $$
begin
  begin
    perform public.aiq_record_calibration_attestation(
      attestation,inbox_id,lease_token,attempt
    ) from aiq_calibration_verification;
    raise exception 'calibration attestation bypassed retained artifact binding';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
select pg_temp.aiq_assert(
  (select count(*)=1 from public.aiq_resolve_claim_artifact(
    (select inbox_id from aiq_calibration_verification),
    (select lease_token from aiq_calibration_verification),
    'evaluator-results.json',repeat('e',64)
  )),
  'the verifier must bind the declared evaluator artifact to its exact claim'
);
select pg_temp.aiq_assert(
  (select public.aiq_record_calibration_attestation(
    attestation,inbox_id,lease_token,attempt
  )='recorded' from aiq_calibration_verification),
  'the replayed calibration attestation must be recorded after Storage binding'
);
select pg_temp.aiq_assert(
  (select public.aiq_record_calibration_attestation(
    attestation,inbox_id,lease_token,attempt
  )='duplicate' from aiq_calibration_verification),
  'exact calibration attestation retry must be idempotent'
);
reset role;

set local role aiq_publisher;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role','aiq_publisher','aiq_publisher_node_id',(
      select node_id from aiq_calibration_identities where role_name='publisher'
    )
  )::text,true
);
select pg_temp.aiq_assert(
  (select public.aiq_publish_calibration_evidence(
    run_id,package_sha256,inbox_id,lease_token,attempt
  )='published' from aiq_calibration_verification),
  'the distinct publisher must publish only the calibration marker'
);
select pg_temp.aiq_assert(
  (select public.aiq_publish_calibration_evidence(
    run_id,package_sha256,inbox_id,lease_token,attempt
  )='duplicate' from aiq_calibration_verification),
  'exact calibration publication retry must be idempotent'
);
reset role;

select pg_temp.aiq_assert(
  (select count(*)=2 from aiq_private.aiq_publication_storage_evidence evidence
   where evidence.publication_class='calibration'
     and evidence.publication_id=(select run_id from aiq_calibration_input))
  and (select count(*)=2 from aiq_private.aiq_storage_object_references reference
       where reference.reference_type='calibration_run' and reference.active)
  and (select count(*)=0 from aiq_private.aiq_storage_object_references reference
       join aiq_private.aiq_artifact_claim_bindings binding
         on reference.reference_key=aiq_private.claim_artifact_reference_key(
           binding.inbox_id,binding.artifact_kind,binding.content_sha256
         )
       where binding.inbox_id=(select inbox_id from aiq_calibration_verification)
         and reference.reference_type='artifact_claim_binding' and reference.active),
  'publication must retain package and evaluator evidence before claim references retire'
);
select pg_temp.aiq_assert(
  (select verification_status='verified' and state='processed'
      and claim_ack='completed' and claim_expires_at is null
   from aiq_private.aiq_submission_inbox
   where inbox_id=(select inbox_id from aiq_calibration_verification)),
  'calibration publication must complete the exact claimed inbox lifecycle'
);

set local role anon;
select pg_temp.aiq_assert(
  (select count(*)=1 and bool_and(not official and not ranking_eligible)
     and min(classification)='local_calibration_non_official'
     and min(result_count)=1224 and min(attempted_result_count)=0
     and min(invoked_result_count)=0 and min(cost_estimator_status)='unavailable_missing_usage'
   from public.public_calibration_runs)
  and (select count(*)=1224 and bool_and(outcome='invalid')
     and bool_and(execution_status='invalid')
     and bool_and(failure_code='capability_validation_failed')
     and bool_and(explanation_code='capability_validation_failed')
     and bool_and(explanation_summary is not null)
     and bool_and(latency_ms is null) and bool_and(input_tokens is null)
     and bool_and(standard_api_equivalent_usd_nanos is null)
   from public.public_calibration_results)
  and (select count(*)=17 and bool_and(descriptive_status='coverage_only')
     and bool_and(aiq is null) and bool_and(sample_size=0)
     and bool_and(adapter_elapsed_observed_result_count=0)
     and bool_and(token_observed_result_count=0) and bool_and(priced_result_count=0)
     and bool_and(cost_estimator_status='unavailable_missing_usage')
   from public.public_calibration_scores),
  'anon must read the exact non-Official calibration run, result, score, and efficiency shape'
);
reset role;

select pg_temp.aiq_assert(
  (select baseline.matrix_batches=(select count(*) from aiq_private.aiq_matrix_batches)
      and baseline.result_packages=(select count(*) from aiq_private.aiq_result_packages)
      and baseline.runs=(select count(*) from aiq_private.aiq_runs)
      and baseline.score_snapshots=(select count(*) from aiq_private.aiq_score_snapshots)
      and baseline.leaderboard_rows=(select count(*) from public.public_leaderboard)
      and baseline.trend_rows=(select count(*) from public.public_trend_points('all'))
   from aiq_calibration_official_baseline baseline),
  'calibration lifecycle must not change any Official publication table or projection'
);

-- Calibration uses a separate forced-RLS, published-only surface. The
-- Official evidence must not leak into calibration, and browser roles must
-- remain read-only across the separate publication surface.
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

select
  (select count(*) from public.public_calibration_runs) as calibration_runs,
  (select count(*) from public.public_calibration_results) as calibration_results,
  (select count(*) from public.public_calibration_scores) as calibration_scores,
  (select count(*) from aiq_private.aiq_publication_storage_evidence
    where publication_class='calibration') as retained_storage_objects,
  (select count(*) from aiq_private.aiq_runs) as official_runs;

rollback;
