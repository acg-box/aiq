-- Included by integration.sql while its complete 17 x 72 staged fixture exists.
-- Seed the state before the completeness predicate. This tests that predicate
-- and the browser projections, not external signature verification or admission.
savepoint publication_regressions;
set local session_replication_role = replica;

create temp table aiq_publication_precision on commit drop as
select fixture.inbox_id,batch.matrix_batch_id,batch.package_sha256,
  to_timestamp(1785672000) as observed_at,
  jsonb_build_object(
    'schema_version','aiq.verifier-attestation.v4',
    'signature_algorithm','ed25519','signature_version','aiq.ed25519-jcs.v1',
    'matrix_batch_id',batch.matrix_batch_id,'package_sha256',batch.package_sha256,
    'content_hash',batch.content_hash,'normalization_digest',batch.normalization_digest,
    'task_set_hash',batch.task_set_hash,
    'terminal_attempt_lineage_digest',fixture.stage->'terminal_attempt_lineage_digest',
    'capability_validation_digest',null,'provenance',null,
    'benchmark_version',batch.benchmark_version,'prompt_set_digest',batch.prompt_set_digest,
    'scoring_version',batch.scoring_version,
    'verifier',jsonb_build_object('node_id',verifier.node_id,'public_key',verifier.public_key),
    'observed_unix_ms',1785672000000,'replay_status','commitments_verified',
    'policy','synthetic_test','synthetic',true,'signature',repeat('cd',64)
  ) as attestation
from aiq_stage_resume_input fixture
join aiq_private.aiq_matrix_batches batch using(package_sha256)
cross join lateral (
  select node_id,public_key from aiq_private.aiq_nodes
  where operator_class='verifier' and synthetic order by node_id limit 1
) verifier;

update aiq_private.aiq_matrix_batches batch
set verified_at=fixture.observed_at,published_at=fixture.observed_at
from aiq_publication_precision fixture
where batch.matrix_batch_id=fixture.matrix_batch_id;
update aiq_private.aiq_result_packages package
set signature_verified=true,trust_tier='trusted_verified',
  verified_at=fixture.observed_at,verifier_attestation=fixture.attestation
from aiq_publication_precision fixture
where package.package_sha256=fixture.package_sha256;
update aiq_private.aiq_submission_inbox inbox
set state='processed',verification_status='verified'
from aiq_publication_precision fixture where inbox.inbox_id=fixture.inbox_id;
insert into aiq_private.aiq_verification_audit(
  inbox_id,run_id,package_sha256,event_type,actor_node_id,event_record
)
select fixture.inbox_id,fixture.matrix_batch_id,fixture.package_sha256,event_type,
  fixture.attestation#>>'{verifier,node_id}',fixture.attestation
from aiq_publication_precision fixture
cross join (values('verifier_attested'),('verified_published')) events(event_type);

update aiq_private.aiq_runs run
set published=true,trust_tier='trusted_verified'
from aiq_publication_precision fixture where run.matrix_batch_id=fixture.matrix_batch_id;
update aiq_private.aiq_score_snapshots score
set score_status='official',score=100,published=true,
  latent_ability='{
    "calibration_digest":"sha256:abababababababababababababababababababababababababababababababab",
    "calibration_model_count":17,"calibration_task_count":72,"items_used":72,
    "method":"rasch_fractional_fixed_bank_map_v2","observed_information":12,
    "reliability_status":"single_matrix_information_only","score":100,
    "score_ci_high":100,"score_ci_low":98,"standard_error":0.5,"theta":2.75,
    "theta_ci_high":3.73,"theta_ci_low":1.77
  }'::jsonb,
  interval_parameters=jsonb_set(jsonb_set(score.interval_parameters,
    '{lower}','97.12345'::jsonb),'{upper}','99.98765'::jsonb),
  task_resampling_low=97.12345,task_resampling_high=99.98765
from aiq_private.aiq_runs run cross join aiq_publication_precision fixture
where score.run_id=run.run_id and run.matrix_batch_id=fixture.matrix_batch_id;
set local session_replication_role = origin;

select pg_temp.aiq_assert(
  (select count(*)=17 and bool_and(task_resampling_low=97.123)
      and bool_and(task_resampling_high=99.988)
   from aiq_private.aiq_score_snapshots score
   join aiq_private.aiq_runs run using(run_id)
   join aiq_publication_precision fixture using(matrix_batch_id))
  and (select aiq_private.publication_is_complete_without_publisher(
    matrix_batch_id,package_sha256
  ) from aiq_publication_precision),
  'publication completeness must accept stored three-decimal bounds from higher-precision evidence'
);

-- A one-unit change at the stored precision must fail the same predicate.
savepoint changed_publication_bound;
set local session_replication_role = replica;
update aiq_private.aiq_score_snapshots
set task_resampling_low=97.124 where score_snapshot_id=(
  select score.score_snapshot_id from aiq_private.aiq_score_snapshots score
  join aiq_private.aiq_runs run using(run_id)
  join aiq_publication_precision fixture using(matrix_batch_id)
  order by score.score_snapshot_id limit 1
);
set local session_replication_role = origin;
select pg_temp.aiq_assert(
  (select not aiq_private.publication_is_complete_without_publisher(
    matrix_batch_id,package_sha256
  ) from aiq_publication_precision),
  'publication completeness must reject a stored bound that differs by 0.001'
);
rollback to savepoint changed_publication_bound;
release savepoint changed_publication_bound;

savepoint changed_publication_upper_bound;
set local session_replication_role = replica;
update aiq_private.aiq_score_snapshots
set task_resampling_high=99.987 where score_snapshot_id=(
  select score.score_snapshot_id from aiq_private.aiq_score_snapshots score
  join aiq_private.aiq_runs run using(run_id)
  join aiq_publication_precision fixture using(matrix_batch_id)
  order by score.score_snapshot_id limit 1
);
set local session_replication_role = origin;
select pg_temp.aiq_assert(
  (select not aiq_private.publication_is_complete_without_publisher(
    matrix_batch_id,package_sha256
  ) from aiq_publication_precision),
  'publication completeness must reject an upper bound that differs by 0.001'
);
rollback to savepoint changed_publication_upper_bound;
release savepoint changed_publication_upper_bound;

create temp table aiq_publication_children on commit drop as
select run.run_id from aiq_private.aiq_runs run
join aiq_publication_precision fixture using(matrix_batch_id);
-- The efficiency view admits non-synthetic published rows only. Seed that
-- projection state separately from the synthetic completeness fixture above.
set local session_replication_role = replica;
update aiq_private.aiq_runs run set synthetic=false
from aiq_publication_children fixture where run.run_id=fixture.run_id;
update aiq_private.aiq_task_results result
set latency_ms=1,latency_evidence_level='runner_observed'
from aiq_publication_children fixture where result.run_id=fixture.run_id;
update aiq_private.efficiency_official_models efficiency
set attempted_result_count=72,invoked_result_count=72,
  adapter_elapsed_observed_result_count=72,
  observed_total_wall_ms=72,observed_median_wall_ms=1,observed_p95_wall_ms=1,
  efficiency_record=efficiency.efficiency_record||jsonb_build_object(
    'observed_wall_tasks',72,'total_observed_wall_ms',72,
    'median_observed_wall_ms',1,'p95_observed_wall_ms',1
  )
from aiq_publication_children fixture where efficiency.run_id=fixture.run_id;
set local session_replication_role = origin;
grant select on aiq_publication_children to anon,authenticated;
set local role anon;
select pg_temp.aiq_assert(
  (select count(*)=17 and bool_and((run.prompt_set_digest='sha256:'||repeat('f',64)) is true)
      and bool_and((run.result_count=72 and run.correct_count=72 and run.completed_count=72) is true)
   from public.public_runs run join aiq_publication_children fixture on run.id=fixture.run_id),
  'browser runs must expose a canonical prompt digest and exact outcome counts'
);
select pg_temp.aiq_assert(
  (select count(*)=1224 and bool_and((result.score=1 and result.outcome='correct') is true)
      and bool_and((result.execution_status='completed') is true)
      and bool_and((result.latency_ms=1 and result.latency_evidence_level='runner_observed') is true)
      and bool_and(result.input_tokens is null and result.standard_api_equivalent_usd_nanos is null)
      and bool_and(not to_jsonb(result) ?| array['usage','provenance','failure_detail','response_sha256','result_package_sha256'])
   from public.public_run_results result join aiq_publication_children fixture using(run_id)),
  'browser result rows must retain null auxiliary usage and omit private payload fields'
);
select pg_temp.aiq_assert(
  (select count(*)=17 and bool_and((efficiency.matrix_batch_elapsed_ms=1000) is true)
      and bool_and((efficiency.summed_cell_adapter_elapsed_ms=72) is true)
      and bool_and((efficiency.observed_time_sample_count=72) is true)
      and bool_and((efficiency.observed_time_coverage_percent=100) is true)
      and bool_and((efficiency.observed_median_wall_ms=1 and efficiency.observed_p95_wall_ms=1) is true)
      and bool_and((efficiency.pricing_currency='USD' and efficiency.pricing_processing_tier='standard') is true)
      and bool_and(efficiency.input_tokens is null and efficiency.input_token_coverage_count is null)
   from public.public_model_efficiency efficiency join aiq_publication_children fixture using(run_id)),
  'browser efficiency must separate the 1000-ms batch from 72 summed cell-ms and retain unobserved tokens as null'
);
reset role;
rollback to savepoint publication_regressions;
release savepoint publication_regressions;
