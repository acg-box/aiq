begin;

do $aiq_schema_smoke$
declare
  browser_write_count integer;
  forced_rls_count integer;
  hardened_role_count integer;
  private_table_count integer;
  public_view_count integer;
  security_invoker_view_count integer;
begin
  select count(*) into private_table_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'aiq_private'
    and relation.relkind in ('r', 'p');

  if private_table_count <> 40 then
    raise exception 'expected 40 private AIQ, pricing, and calibration tables, found %', private_table_count;
  end if;

  select count(*) into forced_rls_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'aiq_private'
    and relation.relkind in ('r', 'p')
    and relation.relrowsecurity
    and relation.relforcerowsecurity;

  if forced_rls_count <> private_table_count then
    raise exception 'row-level security is not enabled and forced on every private table';
  end if;

  select
    count(*),
    count(*) filter (
      where coalesce(relation.reloptions, array[]::text[])
        @> array['security_invoker=true']
    )
  into public_view_count, security_invoker_view_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind = 'v'
    and (
      relation.relname like 'public\_%' escape '\'
      or relation.relname = 'aiq_preview_status_v1'
    );

  if public_view_count <> 13 or security_invoker_view_count <> 13 then
    raise exception
      'expected 13 security-invoker public views, found % views and % invoker views',
      public_view_count, security_invoker_view_count;
  end if;

  if pg_catalog.to_regprocedure('public.public_trend_points(text)') is null
    or not pg_catalog.has_function_privilege(
      'anon', 'public.public_trend_points(text)', 'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'authenticated', 'public.public_trend_points(text)', 'EXECUTE'
    )
  then
    raise exception 'the bounded public trend RPC is missing or not browser-readable';
  end if;

  if pg_catalog.to_regprocedure('aiq_private.preview_status_v1()') is null
    or exists (
      select 1
      from pg_catalog.pg_proc function
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          function.proacl,
          pg_catalog.acldefault('f', function.proowner)
        )
      ) privilege
      where function.oid = pg_catalog.to_regprocedure(
          'aiq_private.preview_status_v1()'
        )
        and privilege.grantee = 0
        and privilege.privilege_type = 'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'anon', 'aiq_private.preview_status_v1()', 'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'authenticated', 'aiq_private.preview_status_v1()', 'EXECUTE'
    )
    or not pg_catalog.has_table_privilege(
      'anon', 'public.aiq_preview_status_v1', 'SELECT'
    )
    or not pg_catalog.has_table_privilege(
      'authenticated', 'public.aiq_preview_status_v1', 'SELECT'
    )
  then
    raise exception 'the bounded preview status view is missing or not browser-readable';
  end if;

  select count(*) into browser_write_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join (values ('anon'), ('authenticated')) as browser(role_name)
  where (
      namespace.nspname = 'aiq_private'
      or (
        namespace.nspname = 'public'
        and (
          relation.relname like 'public\_%' escape '\'
          or relation.relname = 'aiq_preview_status_v1'
        )
      )
    )
    and relation.relkind in ('r', 'p', 'v')
    and (
      pg_catalog.has_table_privilege(browser.role_name, relation.oid, 'INSERT')
      or pg_catalog.has_table_privilege(browser.role_name, relation.oid, 'UPDATE')
      or pg_catalog.has_table_privilege(browser.role_name, relation.oid, 'DELETE')
      or pg_catalog.has_table_privilege(browser.role_name, relation.oid, 'TRUNCATE')
      or pg_catalog.has_table_privilege(browser.role_name, relation.oid, 'REFERENCES')
      or pg_catalog.has_table_privilege(browser.role_name, relation.oid, 'TRIGGER')
      or pg_catalog.has_any_column_privilege(browser.role_name, relation.oid, 'INSERT')
      or pg_catalog.has_any_column_privilege(browser.role_name, relation.oid, 'UPDATE')
      or pg_catalog.has_any_column_privilege(browser.role_name, relation.oid, 'REFERENCES')
    );

  if browser_write_count <> 0 then
    raise exception 'browser roles have write access to % AIQ relations', browser_write_count;
  end if;

  select count(*) into hardened_role_count
  from pg_catalog.pg_roles
  where rolname in ('aiq_verifier', 'aiq_publisher')
    and not rolsuper
    and not rolcreatedb
    and not rolcreaterole
    and not rolreplication
    and not rolbypassrls
    and not rolcanlogin
    and not rolinherit
    and pg_catalog.pg_has_role('authenticator',rolname,'MEMBER');

  if hardened_role_count <> 2 then
    raise exception 'the verifier and publisher roles are not hardened';
  end if;

  if not pg_catalog.has_function_privilege(
      'aiq_verifier', 'public.aiq_claim_submission(integer)', 'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'aiq_verifier', 'public.aiq_stage_verifier_result(jsonb,uuid,uuid,integer)', 'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'aiq_verifier',
      'public.aiq_verify_and_publish(text,text,uuid,uuid,integer)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'aiq_publisher',
      'public.aiq_verify_and_publish(text,text,uuid,uuid,integer)',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'aiq_publisher',
      'public.aiq_stage_verifier_result(jsonb,uuid,uuid,integer)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'aiq_verifier',
      'public.aiq_stage_calibration_verification(jsonb,uuid,uuid,integer)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'aiq_verifier',
      'public.aiq_record_calibration_attestation(jsonb,uuid,uuid,integer)',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'aiq_publisher',
      'public.aiq_stage_calibration_verification(jsonb,uuid,uuid,integer)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'aiq_publisher',
      'public.aiq_publish_calibration_evidence(text,text,uuid,uuid,integer)',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'aiq_verifier',
      'public.aiq_publish_calibration_evidence(text,text,uuid,uuid,integer)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.aiq_enqueue_submission(jsonb,jsonb,jsonb)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.aiq_register_storage_object(text,text,text,text,text,bigint,text,timestamp with time zone)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.aiq_record_storage_inventory_epoch(bigint,text)',
      'EXECUTE'
    )
  then
    raise exception 'a key gateway role grant is missing or too broad';
  end if;
end;
$aiq_schema_smoke$;

-- Exercise the same role switch that PostgREST performs for public reads. A
-- catalog grant alone is not enough: every security-invoker view and the
-- bounded trend RPC must execute successfully through both browser roles.
set local role anon;
select
  (select count(*) from public.public_distributed_radar) as distributed_radar_count,
  (select count(*) from public.public_leaderboard) as leaderboard_count,
  (select count(*) from public.public_model_matrix) as model_matrix_count,
  (select count(*) from public.public_nodes) as node_count,
  (select count(*) from public.public_run_results) as run_result_count,
  (select count(*) from public.public_runs) as run_count,
  (select count(*) from public.public_scoring_versions) as scoring_version_count,
  (select count(*) from public.public_task_coverage) as task_coverage_count,
  (select count(*) from public.public_calibration_runs) as calibration_run_count,
  (select count(*) from public.public_calibration_results) as calibration_result_count,
  (select concat_ws(':',status,failure_code,explanation_code,explanation_summary)
   from public.public_calibration_results limit 1) as calibration_result_failure_shape,
  (select count(*) from public.public_calibration_scores) as calibration_score_count,
  (select count(*) from public.public_model_efficiency) as model_efficiency_count,
  (select count(*) from public.aiq_preview_status_v1) as preview_status_count,
  (select count(*) from public.public_trend_points('all')) as trend_point_count;
reset role;

set local role authenticated;
select
  (select count(*) from public.public_distributed_radar) as distributed_radar_count,
  (select count(*) from public.public_leaderboard) as leaderboard_count,
  (select count(*) from public.public_model_matrix) as model_matrix_count,
  (select count(*) from public.public_nodes) as node_count,
  (select count(*) from public.public_run_results) as run_result_count,
  (select count(*) from public.public_runs) as run_count,
  (select count(*) from public.public_scoring_versions) as scoring_version_count,
  (select count(*) from public.public_task_coverage) as task_coverage_count,
  (select count(*) from public.public_calibration_runs) as calibration_run_count,
  (select count(*) from public.public_calibration_results) as calibration_result_count,
  (select concat_ws(':',status,failure_code,explanation_code,explanation_summary)
   from public.public_calibration_results limit 1) as calibration_result_failure_shape,
  (select count(*) from public.public_calibration_scores) as calibration_score_count,
  (select count(*) from public.public_model_efficiency) as model_efficiency_count,
  (select count(*) from public.aiq_preview_status_v1) as preview_status_count,
  (select count(*) from public.public_trend_points('all')) as trend_point_count;
reset role;

commit;
