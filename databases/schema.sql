begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

set local check_function_bodies = false;

insert into storage.buckets (id, name, public)
values
  ('aiq-submission-packages', 'aiq-submission-packages', false),
  ('aiq-runner-artifacts', 'aiq-runner-artifacts', false);

create role aiq_verifier
  nocreatedb nocreaterole noreplication nobypassrls nologin noinherit
  role authenticator;
create role aiq_publisher
  nocreatedb nocreaterole noreplication nobypassrls nologin noinherit
  role authenticator;

do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname in ('aiq_verifier', 'aiq_publisher')
      and (
        rolsuper or rolcreatedb or rolcreaterole or rolreplication
        or rolbypassrls or rolcanlogin or rolinherit
      )
  ) then
    raise exception 'AIQ application role hardening did not take effect'
      using errcode = '42501';
  end if;
end;
$$;

create schema aiq_private;
revoke all on schema aiq_private
  from public, anon, authenticated, service_role, aiq_verifier, aiq_publisher;
revoke create on schema public
  from public, anon, authenticated, service_role, aiq_verifier, aiq_publisher;


--
-- Name: schema aiq_private; Type: COMMENT; Schema: -; Owner: -
--

comment on schema aiq_private IS 'Unexposed AIQ storage. PostgREST exposes only public; browser roles receive narrow read columns for security-invoker views.';


--
-- Name: node_status; Type: type; Schema: aiq_private; Owner: -
--

create type aiq_private.node_status as ENUM (
    'pending',
    'active',
    'degraded',
    'offline',
    'revoked'
);


--
-- Name: result_outcome; Type: type; Schema: aiq_private; Owner: -
--

create type aiq_private.result_outcome as ENUM (
    'correct',
    'partial',
    'incorrect',
    'timeout',
    'budget_exhausted',
    'tool_failure',
    'policy_failure',
    'wrong_artifact',
    'invalid',
    'missing',
    'not_applicable'
);


--
-- Name: run_status; Type: type; Schema: aiq_private; Owner: -
--

create type aiq_private.run_status as ENUM (
    'scheduled',
    'probing',
    'running',
    'scoring',
    'completed',
    'partial',
    'failed',
    'cancelled'
);


--
-- Name: score_status; Type: type; Schema: aiq_private; Owner: -
--

create type aiq_private.score_status as ENUM (
    'official',
    'synthetic_complete',
    'provisional',
    'coverage_only',
    'not_applicable'
);


--
-- Name: trust_tier; Type: type; Schema: aiq_private; Owner: -
--

create type aiq_private.trust_tier as ENUM (
    'unverified',
    'signed_community',
    'trusted_verified',
    'independently_reproduced'
);


--
-- Name: activate_claim_artifact_reference(uuid, uuid, integer, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.activate_claim_artifact_reference(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, requested_kind text, requested_sha256 text) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  storage_object_id uuid;
begin
  select object.object_id into strict storage_object_id
  from aiq_private.aiq_storage_objects object
  where object.object_type = 'runner_artifact'
    and object.artifact_kind = requested_kind
    and object.content_sha256 = requested_sha256;
  perform aiq_private.attach_storage_reference(
    storage_object_id,
    'artifact_claim_binding',
    aiq_private.claim_artifact_reference_key(
      target_inbox_id, requested_kind, requested_sha256
    )
  );
  insert into aiq_private.aiq_claim_artifact_reference_events (
    inbox_id, lease_token, attempt, artifact_kind, content_sha256, transition
  ) values (
    target_inbox_id, supplied_lease_token, supplied_attempt,
    requested_kind, requested_sha256, 'activated'
  ) on conflict do nothing;
end;
$$;


--
-- Name: aiq_ack_submission_claim_reference_core(uuid, uuid, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.aiq_ack_submission_claim_reference_core(target_inbox_id uuid, supplied_lease_token uuid, supplied_disposition text) returns text
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  if supplied_disposition not in ('retry', 'completed') then
    raise exception 'invalid claim acknowledgement' using errcode = '22023';
  end if;
  select * into claimed
  from aiq_private.aiq_submission_inbox candidate
  where candidate.inbox_id = target_inbox_id
  for update;
  if claimed.inbox_id is null
    or claimed.claim_token is distinct from supplied_lease_token
  then
    raise exception 'claim lease is absent or stale' using errcode = '55000';
  end if;
  if claimed.claim_ack = supplied_disposition then
    return 'idempotent';
  end if;
  if claimed.claim_ack is not null then
    raise exception 'claim acknowledgement conflicts with prior disposition'
      using errcode = '55000';
  end if;
  if claimed.claim_expires_at is null
    or claimed.claim_expires_at <= clock_timestamp()
  then
    raise exception 'claim lease is expired or released' using errcode = '55000';
  end if;
  if supplied_disposition = 'completed'
    and claimed.state not in ('processed', 'rejected')
  then
    raise exception 'a queued claim cannot be acknowledged as completed'
      using errcode = '55000';
  end if;
  if supplied_disposition = 'retry'
    and not (
      claimed.state = 'queued'
      or aiq_private.staged_submission_is_recoverable(claimed.inbox_id)
    )
  then
    raise exception 'a terminal claim cannot be retried' using errcode = '55000';
  end if;

  update aiq_private.aiq_submission_inbox candidate
  set claim_expires_at = null,
      claim_ack = supplied_disposition
  where candidate.inbox_id = target_inbox_id;
  return 'acknowledged';
end;
$$;


--
-- Name: aiq_claim_storage_deletions_reference_core(integer, integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.aiq_claim_storage_deletions_reference_core(max_rows integer, requested_lease_seconds integer) returns table(object_id uuid, object_type text, artifact_kind text, bucket_name text, object_path text, content_sha256 text, byte_size bigint, lease_token uuid, lease_expires_at timestamp with time zone, attempt integer)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  database_now timestamptz;
begin
  perform aiq_private.require_request_role('service_role');
  if max_rows not between 1 and 100 or requested_lease_seconds not between 30 and 900 then
    raise exception 'invalid Storage deletion claim bounds' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.storage.inventory-deletion-gate',71783153620529
  ));
  database_now:=clock_timestamp();
  if exists(select 1 from aiq_private.aiq_storage_reconciliation_events event
      where event.mismatch_type in ('storage_only','registry_only','identity_mismatch')
        and event.resolved_at is null)
    or not exists(
      select 1
      from aiq_private.aiq_storage_reconciliation_events epoch
      where epoch.mismatch_type='inventory_success'
        and epoch.resolved_at is not null
        and epoch.last_observed_at>=database_now-interval '24 hours'
        and epoch.last_observed_at>=coalesce((
          select max(event.last_observed_at)
          from aiq_private.aiq_storage_reconciliation_events event
          where event.mismatch_type in (
            'storage_only','registry_only','identity_mismatch'
          )
        ),'-infinity'::timestamptz)
    )
  then raise exception 'Storage deletion requires a recent clean inventory epoch'
    using errcode='55000'; end if;
  return query
  with candidates as (
    select object.object_id
    from aiq_private.aiq_storage_objects object
    where ((object.object_type = 'submission_package'
          and object.bucket_name = 'aiq-submission-packages')
        or (object.object_type = 'runner_artifact'
          and object.bucket_name = 'aiq-runner-artifacts'))
      and object.retention_class <> 'preserve'
      and object.expires_at <= database_now
      and object.registered_at <= (
        select max(epoch.last_observed_at)
        from aiq_private.aiq_storage_reconciliation_events epoch
        where epoch.mismatch_type='inventory_success'
          and epoch.resolved_at is not null
      )
      and not object.legal_hold
      and object.next_attempt_at <= database_now
      and object.lifecycle_state <> 'deleted'
      and (
        object.lifecycle_state = 'active'
        or object.deletion_lease_expires_at <= database_now
      )
      and not exists (
        select 1 from aiq_private.aiq_storage_object_references reference
        where reference.object_id = object.object_id and reference.active
      )
    order by object.next_attempt_at, object.expires_at, object.registered_at, object.object_id
    for update skip locked
    limit max_rows
  ), claimed as (
    update aiq_private.aiq_storage_objects object
    set lifecycle_state = 'delete_pending',
        deletion_lease_token = extensions.gen_random_uuid(),
        deletion_lease_expires_at =
          database_now + make_interval(secs => requested_lease_seconds),
        deletion_attempts = object.deletion_attempts + 1,
        last_outcome = null,
        last_error_code = null,
        updated_at = database_now
    from candidates
    where object.object_id = candidates.object_id
    returning object.*
  )
  select claimed.object_id, claimed.object_type, claimed.artifact_kind,
    claimed.bucket_name, claimed.object_path, claimed.content_sha256,
    claimed.byte_size, claimed.deletion_lease_token,
    claimed.deletion_lease_expires_at, claimed.deletion_attempts
  from claimed;
end;
$$;


--
-- Name: aiq_claim_submission_reference_core(integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.aiq_claim_submission_reference_core(requested_lease_seconds integer default 300) returns table(inbox_id uuid, idempotency_key text, package_sha256 text, body_bytes bigint, object_bucket text, object_key text, object_content_sha256 text, lease_token uuid, lease_expires_at timestamp with time zone, attempt integer)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
  new_token uuid := extensions.gen_random_uuid();
  database_now timestamptz := clock_timestamp();
begin
  perform aiq_private.require_request_role('aiq_verifier');
  if requested_lease_seconds is null
    or requested_lease_seconds not between 30 and 900
  then
    raise exception 'claim lease must be between 30 and 900 seconds'
      using errcode = '22023';
  end if;

  select * into claimed
  from aiq_private.aiq_submission_inbox candidate
  where candidate.verification_status = 'unverified'
    and candidate.object_bucket is not null
    and candidate.object_key is not null
    and candidate.object_content_sha256 = candidate.package_sha256
    and (
      candidate.claim_expires_at is null
      or candidate.claim_expires_at <= database_now
    )
    and (
      (
        candidate.state = 'queued'
        and not exists (
          select 1 from aiq_private.aiq_submission_conflicts conflict
          where conflict.inbox_id = candidate.inbox_id
            and conflict.retention_state = 'active'
        )
      )
      or aiq_private.staged_submission_is_recoverable(candidate.inbox_id)
    )
  order by candidate.received_at, candidate.inbox_id
  for update skip locked
  limit 1;
  if claimed.inbox_id is null then
    return;
  end if;

  update aiq_private.aiq_submission_inbox candidate
  set claim_token = new_token,
      claim_expires_at = database_now + make_interval(secs => requested_lease_seconds),
      claim_attempts = candidate.claim_attempts + 1,
      claim_ack = null
  where candidate.inbox_id = claimed.inbox_id
  returning candidate.* into claimed;

  return query select
    claimed.inbox_id,
    claimed.idempotency_key,
    claimed.package_sha256,
    claimed.object_bytes,
    claimed.object_bucket,
    claimed.object_key,
    claimed.object_content_sha256,
    claimed.claim_token,
    claimed.claim_expires_at,
    claimed.claim_attempts;
end;
$$;


--
-- Name: aiq_record_verification_rejection_unbound_core(text, text, jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.aiq_record_verification_rejection_unbound_core(target_run_id text, target_package_sha256 text, rejection jsonb) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  inbox aiq_private.aiq_submission_inbox%rowtype;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  if not aiq_private.verifier_rejection_v2_is_valid(rejection)
    or rejection ->> 'matrix_batch_id' <> target_run_id
    or rejection ->> 'package_sha256' <> target_package_sha256
  then
    raise exception 'verifier rejection v2 is invalid' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'aiq.v3.batch-lock:' || target_run_id || ':' || target_package_sha256,
      71783153620529
    )
  );
  -- Keep the same existing-row lock order as attestation and publication.
  perform 1 from aiq_private.aiq_matrix_batches batch
  where batch.matrix_batch_id = target_run_id
    and batch.package_sha256 = target_package_sha256
  for update;
  perform 1 from aiq_private.aiq_result_packages package
  where package.package_sha256 = target_package_sha256
    and package.matrix_batch_id = target_run_id
  for update;
  select * into inbox from aiq_private.aiq_submission_inbox record
  where record.idempotency_key = target_run_id
    and record.package_sha256 = target_package_sha256
  for update;
  if not found then
    raise exception 'submission is not eligible for rejection' using errcode = '55000';
  end if;
  if (rejection ->> 'synthetic')::boolean <>
      (inbox.envelope -> 'payload' ->> 'synthetic')::boolean
    or (rejection ->> 'production')::boolean =
      (inbox.envelope -> 'payload' ->> 'synthetic')::boolean
  then
    raise exception 'rejection violates the submission environment policy'
      using errcode = '22023';
  end if;
  -- An identical rejection replay is a no-op. A changed rejection for the same
  -- package remains ineligible and cannot replace the append-only record.
  if inbox.verification_status = 'rejected'
    and inbox.state = 'rejected'
    and exists (
      select 1
      from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'rejected'
        and audit.actor_node_id = rejection ->> 'verifier_node_id'
        and audit.event_record = rejection
    )
  then
    return;
  end if;
  if inbox.verification_status <> 'unverified'
    or exists (
      select 1
      from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type in ('verifier_attested', 'verified_published')
    )
  then
    raise exception 'submission has terminal verifier or publication evidence'
      using errcode = '55000';
  end if;
  -- First append requires a currently eligible verifier. The shared row lock
  -- serializes this decision with status or registry-trust changes.
  perform 1
  from aiq_private.aiq_nodes verifier
  where verifier.node_id = rejection ->> 'verifier_node_id'
    and verifier.operator_class = 'verifier'
    and verifier.status in ('active', 'degraded')
    and aiq_private.verifier_registry_trust_is_eligible(
      verifier.signature_status,
      verifier.trust_tier,
      verifier.synthetic,
      (rejection ->> 'synthetic')::boolean
    )
  for share;
  if not found then
    raise exception 'rejection violates verifier identity or environment policy'
      using errcode = '22023';
  end if;
  update aiq_private.aiq_submission_inbox
  set verification_status = 'rejected', state = 'rejected'
  where inbox_id = inbox.inbox_id;
  update aiq_private.aiq_result_packages
  set rejection_code = rejection ->> 'reason_code'
  where package_sha256 = target_package_sha256 and not signature_verified;
  insert into aiq_private.aiq_verification_audit (
    inbox_id, package_sha256, event_type, actor_node_id, event_record
  ) values (
    inbox.inbox_id, target_package_sha256, 'rejected',
    rejection ->> 'verifier_node_id', rejection
  );
end;
$$;


--
-- Name: aiq_record_verifier_attestation_unbound_core(text, text, jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.aiq_record_verifier_attestation_unbound_core(target_run_id text, target_package_sha256 text, attestation jsonb) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  batch aiq_private.aiq_matrix_batches%rowtype;
  package aiq_private.aiq_result_packages%rowtype;
  inbox aiq_private.aiq_submission_inbox%rowtype;
  existing_attestation jsonb;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'aiq.v3.batch-lock:' || target_run_id || ':' || target_package_sha256,
      71783153620529
    )
  );
  select * into batch from aiq_private.aiq_matrix_batches record
  where record.matrix_batch_id = target_run_id
    and record.package_sha256 = target_package_sha256 for update;
  select * into package from aiq_private.aiq_result_packages record
  where record.package_sha256 = target_package_sha256
    and record.matrix_batch_id = target_run_id for update;
  select * into inbox from aiq_private.aiq_submission_inbox record
  where record.idempotency_key = target_run_id
    and record.package_sha256 = target_package_sha256 for update;
  if batch.matrix_batch_id is null or package.package_sha256 is null
    or inbox.inbox_id is null
  then
    raise exception 'immutable staged batch evidence was not found'
      using errcode = 'P0002';
  end if;
  if aiq_private.verifier_attestation_v3_binding_is_valid(
    attestation, batch, package
  ) is distinct from true then
    raise exception 'verifier attestation v3 is not bound to staged provenance'
      using errcode = '22023';
  end if;

  select audit.event_record into existing_attestation
  from aiq_private.aiq_verification_audit audit
  where audit.inbox_id = inbox.inbox_id
    and audit.package_sha256 = target_package_sha256
    and audit.event_type = 'verifier_attested';
  if found then
    if existing_attestation = attestation
      or existing_attestation - array['observed_unix_ms', 'signature']::text[]
        = attestation - array['observed_unix_ms', 'signature']::text[]
    then
      return;
    end if;
    raise exception 'verifier attestation conflicts with immutable first evidence'
      using errcode = '55000';
  end if;

  perform 1
  from aiq_private.aiq_nodes identity
  where identity.node_id in (
    batch.source_node_id,
    attestation -> 'verifier' ->> 'node_id'
  )
  for share;
  if aiq_private.verifier_attestation_v3_is_valid(
      attestation, batch, package
    ) is distinct from true
    or (
      not batch.synthetic
      and aiq_private.production_execution_identities_are_authorized(
        batch.source_node_id,
        attestation -> 'verifier' ->> 'node_id'
      ) is distinct from true
    )
    or batch.verified_at is not null
    or package.signature_verified
    or inbox.state <> 'processed'
    or inbox.verification_status <> 'unverified'
    or exists (
      select 1 from aiq_private.aiq_submission_conflicts conflict
      where conflict.inbox_id = inbox.inbox_id
        and conflict.retention_state = 'active'
    )
    or exists (
      select 1 from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type in ('verified_published', 'rejected')
    )
  then
    raise exception 'batch is not eligible for verifier attestation v3'
      using errcode = '55000';
  end if;

  insert into aiq_private.aiq_verification_audit (
    inbox_id, package_sha256, event_type, actor_node_id, event_record
  ) values (
    inbox.inbox_id, target_package_sha256, 'verifier_attested',
    attestation -> 'verifier' ->> 'node_id', attestation
  );
end;
$$;


--
-- Name: aiq_resolve_claim_artifact_reference_core(uuid, uuid, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.aiq_resolve_claim_artifact_reference_core(target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text) returns table(object_bucket text, object_key text, artifact_kind text, content_sha256 text, byte_size bigint, lease_expires_at timestamp with time zone)
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
  ingress aiq_private.aiq_artifact_ingress_objects%rowtype;
  database_now timestamptz := clock_timestamp();
begin
  perform aiq_private.require_request_role('aiq_verifier');
  if requested_kind not in (
    'evaluator-results.json', 'final-response.txt', 'stderr.txt', 'stdout.jsonl',
    'workspace-manifest.json', 'workspace-snapshot.json'
  )
    or not coalesce(requested_sha256 ~ '^[0-9a-f]{64}$', false)
  then
    raise exception 'invalid artifact reference' using errcode = '22023';
  end if;

  select * into claimed
  from aiq_private.aiq_submission_inbox inbox
  where inbox.inbox_id = target_inbox_id
  for update;
  if claimed.inbox_id is null
    or claimed.claim_token is distinct from supplied_lease_token
    or claimed.claim_expires_at is null
    or claimed.claim_expires_at <= database_now
    or claimed.verification_status <> 'unverified'
    or not (
      claimed.state = 'queued'
      or aiq_private.staged_submission_is_recoverable(claimed.inbox_id)
    )
  then
    raise exception 'artifact resolution requires an active recoverable claim lease'
      using errcode = '42501';
  end if;

  select artifact.* into ingress
  from aiq_private.aiq_artifact_ingress_objects artifact
  join aiq_private.aiq_artifact_ingress_claims ingress_claim
    on ingress_claim.artifact_kind = artifact.artifact_kind
    and ingress_claim.content_sha256 = artifact.content_sha256
    and ingress_claim.claimed_run_id = claimed.idempotency_key
  where artifact.artifact_kind = requested_kind
    and artifact.content_sha256 = requested_sha256
    and artifact.expires_at > database_now
    and ingress_claim.expires_at > database_now
    and (
      (
        requested_kind = 'evaluator-results.json'
        and aiq_private.has_exact_jsonb_keys(
          claimed.envelope #> '{payload,evaluator_results_artifact}',
          array['bytes', 'content_hash', 'kind', 'uri']::text[]
        )
        and claimed.envelope #>> '{payload,evaluator_results_artifact,kind}'
          = requested_kind
        and claimed.envelope #>> '{payload,evaluator_results_artifact,content_hash}'
          = 'sha256:' || requested_sha256
        and claimed.envelope #>> '{payload,evaluator_results_artifact,uri}'
          = 'aiq-artifact://sha256/' || requested_sha256 || '/' || requested_kind
        and jsonb_typeof(
          claimed.envelope #> '{payload,evaluator_results_artifact,bytes}'
        ) = 'number'
        and (
          claimed.envelope #>> '{payload,evaluator_results_artifact,bytes}'
        )::bigint = artifact.byte_size
      )
      or (
        requested_kind <> 'evaluator-results.json'
        and exists (
      select 1
      from (
        select result_reference.reference
        from jsonb_array_elements(
          case
            when jsonb_typeof(claimed.envelope #> '{payload,results}') = 'array'
            then claimed.envelope #> '{payload,results}'
            else '[]'::jsonb
          end
        ) result
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(result -> 'artifacts') = 'array'
            then result -> 'artifacts'
            else '[]'::jsonb
          end
          ||
          case
            when jsonb_typeof(result -> 'workspace_manifest') = 'object'
            then jsonb_build_array(result -> 'workspace_manifest')
            else '[]'::jsonb
          end
        ) result_reference(reference)
        union all
        select capability_reference.reference
        from jsonb_array_elements(
          case
            when jsonb_typeof(
              claimed.envelope #> '{payload,capability_validation,models}'
            ) = 'array'
            then claimed.envelope #> '{payload,capability_validation,models}'
            else '[]'::jsonb
          end
        ) capability_model
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(capability_model #> '{probe,artifacts}') = 'array'
            then capability_model #> '{probe,artifacts}'
            else '[]'::jsonb
          end
        ) capability_reference(reference)
      ) claimed_reference(reference)
      where reference ->> 'kind' = requested_kind
        and reference ->> 'content_hash' = 'sha256:' || requested_sha256
        and reference ->> 'uri' = 'aiq-artifact://sha256/' || requested_sha256 || '/' || requested_kind
        and jsonb_typeof(reference -> 'bytes') = 'number'
        and (reference ->> 'bytes') ~ '^[0-9]+$'
        and (reference ->> 'bytes')::bigint = artifact.byte_size
        )
      )
    );
  if ingress.content_sha256 is null then
    raise exception 'artifact is not bound to the claimed package'
      using errcode = '42501';
  end if;

  insert into aiq_private.aiq_artifact_claim_bindings (
    inbox_id, artifact_kind, content_sha256
  ) values (claimed.inbox_id, ingress.artifact_kind, ingress.content_sha256)
  on conflict do nothing;

  return query select
    ingress.bucket_name,
    ingress.object_path,
    ingress.artifact_kind,
    ingress.content_sha256,
    ingress.byte_size,
    claimed.claim_expires_at;
end;
$_$;


--
-- Name: aiq_stage_verifier_result_unbound_core(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.aiq_stage_verifier_result_unbound_core(stage jsonb) returns text
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  inbox aiq_private.aiq_submission_inbox%rowtype;
  batch_id text;
  package_id text;
  stage_provenance jsonb;
  synthetic boolean;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  -- A completed exact retry must not repeat the full 1,224-result validation.
  -- Validate the bounded identity first, serialize the batch, bind it to the
  -- immutable signed package, and then prove every stored staging invariant.
  if jsonb_typeof(stage) is distinct from 'object'
    or octet_length(stage::text) > 4194304
    or aiq_private.jsonb_wire_value_is_bounded(stage) is distinct from true
    or not aiq_private.has_exact_jsonb_keys(
      stage,
      array[
        'benchmark_version', 'capability_validation_digest', 'content_hash',
        'efficiency', 'execution_concurrency', 'finished_unix_ms',
        'matrix_batch_id', 'normalization_digest',
        'package_sha256', 'pricing', 'prompt_set_digest', 'provenance', 'region',
        'result_efficiency', 'run_class', 'runner_commit', 'runs', 'scheduled_unix_ms',
        'schema_version', 'scoring_version', 'signer', 'started_unix_ms',
        'synthetic', 'task_set_hash', 'task_set_id', 'task_set_version'
      ]::text[]
    )
    or stage ->> 'schema_version' is distinct from 'aiq.normalized-batch.v3'
    or not coalesce(stage ->> 'matrix_batch_id' ~ '^run_[0-9a-f]{64}$', false)
    or not aiq_private.jsonb_sha256_field_is_valid(stage, 'package_sha256', false)
    or not aiq_private.jsonb_sha256_field_is_valid(stage, 'content_hash', true)
    or jsonb_typeof(stage -> 'synthetic') is distinct from 'boolean'
    or jsonb_typeof(stage -> 'signer') is distinct from 'object'
    or not aiq_private.has_exact_jsonb_keys(
      stage -> 'signer', array['node_id', 'public_key']::text[]
    )
    or aiq_private.node_public_key_matches_id(
      stage -> 'signer' ->> 'node_id', stage -> 'signer' ->> 'public_key'
    ) is distinct from true
  then
    raise exception 'invalid aiq.normalized-batch.v3 envelope'
      using errcode = '22023';
  end if;

  batch_id := stage ->> 'matrix_batch_id';
  package_id := stage ->> 'package_sha256';
  synthetic := (stage ->> 'synthetic')::boolean;
  stage_provenance := stage -> 'provenance';
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'aiq.v3.batch-lock:' || batch_id || ':' || package_id,
      71783153620529
    )
  );
  select * into inbox
  from aiq_private.aiq_submission_inbox queued
  where queued.idempotency_key = batch_id
    and queued.package_sha256 = package_id
  for update;
  if not found then
    raise exception 'immutable submission inbox record not found'
      using errcode = 'P0002';
  end if;
  if aiq_private.result_package_v3_is_valid(inbox.envelope) is distinct from true
    or inbox.envelope ->> 'payload_type' is distinct from 'aiq.run.v3'
    or inbox.envelope -> 'payload' -> 'provenance' is distinct from stage_provenance
    or inbox.envelope -> 'payload' -> 'synthetic' is distinct from stage -> 'synthetic'
    or inbox.envelope -> 'payload' -> 'execution_concurrency'
      is distinct from stage -> 'execution_concurrency'
    or inbox.envelope -> 'signer' is distinct from stage -> 'signer'
    or inbox.envelope ->> 'content_hash' is distinct from stage ->> 'content_hash'
  then
    raise exception 'official result package is not bound to normalized batch v3'
      using errcode = '22023';
  end if;
  if inbox.state is not distinct from 'processed' and exists (
    select 1
    from aiq_private.aiq_matrix_batches batch
    join aiq_private.aiq_result_packages package
      on package.package_sha256 = batch.package_sha256
    where batch.matrix_batch_id = batch_id
      and batch.package_sha256 = package_id
      and batch.normalized_stage is not distinct from stage
      and batch.run_provenance is not distinct from
        nullif(stage_provenance, 'null'::jsonb)
      and package.schema_version = 'aiq.result-package.v3'
      and package.provenance =
        '{"schema_version":"aiq.package-binding.v3"}'::jsonb
      and package.envelope is not distinct from inbox.envelope
      and package.run_provenance is not distinct from batch.run_provenance
      and (
        select count(*)
        from aiq_private.aiq_package_runs link
        where link.package_sha256 = package_id
      ) = 17
      and (
        select count(*)
        from aiq_private.aiq_task_results result
        join aiq_private.aiq_package_runs link on link.run_id = result.run_id
        where link.package_sha256 = package_id
      ) = 1224
      and (
        select count(*) from aiq_private.efficiency_official_models efficiency
        join aiq_private.aiq_package_runs link using(run_id)
        where link.package_sha256=package_id
      ) = 17
      and (
        select count(*)
        from aiq_private.aiq_verification_audit audit
        where audit.inbox_id = inbox.inbox_id
          and audit.package_sha256 = package_id
          and audit.event_type = 'staged'
      ) = 1
      and not exists (
        select 1 from aiq_private.aiq_package_runs link
        join aiq_private.aiq_runs run on run.run_id = link.run_id
        where link.package_sha256 = package_id
          and run.run_provenance is distinct from batch.run_provenance
      )
  ) then
    return batch_id;
  end if;
  if inbox.state is distinct from 'queued' then
    raise exception 'submission is not eligible for staging' using errcode = '55000';
  end if;

  if jsonb_typeof(stage) is distinct from 'object'
    or octet_length(stage::text) > 4194304
    or aiq_private.jsonb_wire_value_is_bounded(stage) is distinct from true
    or not aiq_private.has_exact_jsonb_keys(
      stage,
      array[
        'benchmark_version', 'capability_validation_digest', 'content_hash',
        'efficiency', 'execution_concurrency', 'finished_unix_ms',
        'matrix_batch_id', 'normalization_digest',
        'package_sha256', 'pricing', 'prompt_set_digest', 'provenance', 'region',
        'result_efficiency', 'run_class', 'runner_commit', 'runs', 'scheduled_unix_ms',
        'schema_version', 'scoring_version', 'signer', 'started_unix_ms',
        'synthetic', 'task_set_hash', 'task_set_id', 'task_set_version'
      ]::text[]
    )
    or jsonb_typeof(stage -> 'schema_version') is distinct from 'string'
    or stage ->> 'schema_version' is distinct from 'aiq.normalized-batch.v3'
    or jsonb_typeof(stage -> 'benchmark_version') is distinct from 'string'
    or jsonb_typeof(stage -> 'content_hash') is distinct from 'string'
    or jsonb_typeof(stage -> 'matrix_batch_id') is distinct from 'string'
    or jsonb_typeof(stage -> 'normalization_digest') is distinct from 'string'
    or jsonb_typeof(stage -> 'package_sha256') is distinct from 'string'
    or jsonb_typeof(stage -> 'prompt_set_digest') is distinct from 'string'
    or jsonb_typeof(stage -> 'region') is distinct from 'string'
    or jsonb_typeof(stage -> 'runner_commit') is distinct from 'string'
    or jsonb_typeof(stage -> 'scoring_version') is distinct from 'string'
    or jsonb_typeof(stage -> 'synthetic') is distinct from 'boolean'
    or jsonb_typeof(stage -> 'task_set_hash') is distinct from 'string'
    or jsonb_typeof(stage -> 'task_set_id') is distinct from 'string'
    or jsonb_typeof(stage -> 'task_set_version') is distinct from 'string'
    or jsonb_typeof(stage -> 'signer') is distinct from 'object'
    or not aiq_private.has_exact_jsonb_keys(
      stage -> 'signer', array['node_id', 'public_key']::text[]
    )
    or jsonb_typeof(stage -> 'signer' -> 'node_id') is distinct from 'string'
    or jsonb_typeof(stage -> 'signer' -> 'public_key') is distinct from 'string'
    or aiq_private.node_public_key_matches_id(
      stage -> 'signer' ->> 'node_id', stage -> 'signer' ->> 'public_key'
    ) is distinct from true
    or jsonb_typeof(stage -> 'runs') is distinct from 'array'
    or jsonb_array_length(stage -> 'runs') is distinct from 17
    or not aiq_private.dto_uint_is_valid(stage -> 'execution_concurrency',32)
    or (stage->>'execution_concurrency')::integer not between 1 and 32
    or jsonb_typeof(stage->'result_efficiency') is distinct from 'array'
    or jsonb_array_length(stage->'result_efficiency') is distinct from 1224
    or jsonb_typeof(stage->'efficiency') is distinct from 'array'
    or jsonb_array_length(stage->'efficiency') is distinct from 17
    or aiq_private.efficiency_pricing_v1_is_valid(stage->'pricing') is not true
    or exists(select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
      where aiq_private.result_efficiency_v1_is_valid(evidence) is not true)
    or exists(select 1 from jsonb_array_elements(stage->'efficiency') aggregate
      where aiq_private.efficiency_aggregate_v1_is_valid(aggregate) is not true)
    or exists(select 1 from jsonb_array_elements(stage->'efficiency') aggregate
      where aiq_private.efficiency_aggregate_matches_results(
        aggregate,stage->'result_efficiency'
      ) is not true)
    or (select count(distinct evidence->>'source_result_id')
      from jsonb_array_elements(stage->'result_efficiency') evidence)<>1224
    or (select count(distinct (evidence->'model',evidence->>'task_id'))
      from jsonb_array_elements(stage->'result_efficiency') evidence)<>1224
    or (select count(distinct aggregate->'model')
      from jsonb_array_elements(stage->'efficiency') aggregate)<>17
    or aiq_private.official_model_matrix_is_exact((
      select jsonb_agg(aggregate.value->'model' order by aggregate.ordinality)
      from jsonb_array_elements(stage->'efficiency') with ordinality aggregate(value,ordinality)
    )) is not true
    or not coalesce(stage ->> 'matrix_batch_id' ~ '^run_[0-9a-f]{64}$', false)
    or not aiq_private.jsonb_sha256_field_is_valid(stage, 'package_sha256', false)
    or not aiq_private.jsonb_sha256_field_is_valid(stage, 'content_hash', true)
    or not aiq_private.jsonb_sha256_field_is_valid(
      stage, 'normalization_digest', true
    )
    or not aiq_private.jsonb_sha256_field_is_valid(stage, 'task_set_hash', true)
    or not aiq_private.jsonb_sha256_field_is_valid(
      stage, 'prompt_set_digest', true
    )
  then
    raise exception 'invalid aiq.normalized-batch.v3 envelope'
      using errcode = '22023';
  end if;

  if (
      synthetic
      and (
        stage_provenance is distinct from 'null'::jsonb
        or stage -> 'run_class' is distinct from 'null'::jsonb
        or stage -> 'capability_validation_digest' is distinct from 'null'::jsonb
      )
    ) or (
      not synthetic
      and (
        jsonb_typeof(stage -> 'run_class') is distinct from 'string'
        or stage ->> 'run_class' is distinct from 'official'
        or not aiq_private.jsonb_sha256_field_is_valid(
          stage, 'capability_validation_digest', true
        )
        or aiq_private.run_provenance_v2_matches_stage(stage_provenance, stage)
          is distinct from true
      )
    )
  then
    raise exception 'normalized run-class and provenance policy is invalid'
      using errcode = '22023';
  end if;

  -- Serialize the first staging transition with runner lifecycle changes.
  -- An exact retry uses the immutable staged evidence.
  if not synthetic then
    perform 1
    from aiq_private.aiq_nodes identity
    where identity.node_id = stage -> 'signer' ->> 'node_id'
    for share;
    if aiq_private.production_execution_identities_are_authorized(
      stage -> 'signer' ->> 'node_id',
      null
    ) is distinct from true then
      raise exception 'production identities are not eligible for first staging'
        using errcode = '55000';
    end if;
  end if;

  return aiq_private.stage_verifier_result_core(stage);
end;
$_$;


--
-- Name: aiq_verify_and_publish_unbound_core(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.aiq_verify_and_publish_unbound_core(target_run_id text, target_package_sha256 text) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  batch aiq_private.aiq_matrix_batches%rowtype;
  package aiq_private.aiq_result_packages%rowtype;
  publisher_node_id text;
  publisher_public_key text;
begin
  perform aiq_private.require_request_role('aiq_publisher');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'aiq.v3.batch-lock:' || target_run_id || ':' || target_package_sha256,
      71783153620529
    )
  );
  if aiq_private.publication_is_complete(
    target_run_id, target_package_sha256
  ) then
    return;
  end if;
  select * into batch
  from aiq_private.aiq_matrix_batches record
  where record.matrix_batch_id = target_run_id
    and record.package_sha256 = target_package_sha256;
  select * into package
  from aiq_private.aiq_result_packages record
  where record.matrix_batch_id = target_run_id
    and record.package_sha256 = target_package_sha256;
  if batch.matrix_batch_id is null or package.package_sha256 is null then
    raise exception 'immutable staged batch evidence was not found'
      using errcode = 'P0002';
  end if;
  if package.schema_version <> 'aiq.result-package.v3' then
    raise exception 'publication requires result package v3 and attestation v3'
      using errcode = '22023';
  end if;
  if not batch.synthetic then
    publisher_node_id := aiq_private.request_publisher_node_id();
    if publisher_node_id is null then
      raise exception 'production publication requires a valid publisher actor claim'
        using errcode = '42501';
    end if;
  end if;
  if aiq_private.publication_transition_is_eligible(
    target_run_id, target_package_sha256
  ) is distinct from true then
    raise exception 'batch is not eligible for first publication'
      using errcode = '55000';
  end if;
  if not batch.synthetic then
    select node.public_key into strict publisher_public_key
    from aiq_private.aiq_nodes node
    where node.node_id = publisher_node_id;
    insert into aiq_private.aiq_publication_actors (
      matrix_batch_id, package_sha256, publisher_node_id, publisher_public_key
    ) values (
      target_run_id, target_package_sha256,
      publisher_node_id, publisher_public_key
    );
  end if;
  perform aiq_private.verify_and_publish_core(
    target_run_id, target_package_sha256
  );
end;
$$;



--
-- Name: assert_publication_transition_eligible(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.assert_publication_transition_eligible() returns trigger
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  target_batch_id text;
  target_package_sha256 text;
  bound_package_sha256 text;
  advanced boolean := false;
  advancing boolean := false;
begin
  case tg_table_name
    when 'aiq_matrix_batches' then
      target_batch_id := new.matrix_batch_id;
      target_package_sha256 := new.package_sha256;
      advanced := new.verified_at is not null or new.published_at is not null;
      if tg_op = 'INSERT' then
        advancing := advanced;
      else
        advancing := advanced
          and old.verified_at is null
          and old.published_at is null;
      end if;
    when 'aiq_result_packages' then
      target_batch_id := new.matrix_batch_id;
      target_package_sha256 := new.package_sha256;
      advanced := new.signature_verified
        or new.verifier_attestation is not null
        or new.verified_at is not null
        or new.trust_tier >= 'trusted_verified';
      if tg_op = 'INSERT' then
        advancing := advanced;
      else
        advancing := advanced and not (
          old.signature_verified
          or old.verifier_attestation is not null
          or old.verified_at is not null
          or old.trust_tier >= 'trusted_verified'
        );
      end if;
    when 'aiq_runs' then
      target_batch_id := new.matrix_batch_id;
      select link.package_sha256 into target_package_sha256
      from aiq_private.aiq_package_runs link
      where link.run_id = new.run_id;
      advanced := new.published or new.trust_tier >= 'trusted_verified';
      if tg_op = 'INSERT' then
        advancing := advanced;
      else
        advancing := advanced
          and not (old.published or old.trust_tier >= 'trusted_verified');
      end if;
    when 'aiq_score_snapshots' then
      select run.matrix_batch_id, link.package_sha256
      into target_batch_id, target_package_sha256
      from aiq_private.aiq_runs run
      left join aiq_private.aiq_package_runs link on link.run_id = run.run_id
      where run.run_id = new.run_id;
      advanced := new.published;
      if tg_op = 'INSERT' then
        advancing := advanced;
      else
        advancing := advanced and not old.published;
      end if;
    when 'aiq_submission_inbox' then
      target_batch_id := new.idempotency_key;
      target_package_sha256 := new.package_sha256;
      advanced := new.verification_status = 'verified';
      if tg_op = 'INSERT' then
        advancing := advanced;
      else
        advancing := advanced and old.verification_status <> 'verified';
      end if;
    when 'aiq_verification_audit' then
      select inbox.idempotency_key, inbox.package_sha256
      into target_batch_id, bound_package_sha256
      from aiq_private.aiq_submission_inbox inbox
      where inbox.inbox_id = new.inbox_id;
      if new.package_sha256 is distinct from bound_package_sha256 then
        raise exception 'audit package identity does not match its submission inbox'
          using errcode = '23514';
      end if;
      target_package_sha256 := new.package_sha256;
      advanced := new.event_type = 'verified_published';
      advancing := advanced;
    else
      return null;
  end case;

  if target_batch_id is null or target_package_sha256 is null then
    if advanced then
      raise exception 'advanced publication state has no bound batch identity'
        using errcode = '23514';
    end if;
    return null;
  end if;

  advanced := advanced
    or exists (
      select 1
      from aiq_private.aiq_matrix_batches batch
      where batch.matrix_batch_id = target_batch_id
        and batch.package_sha256 = target_package_sha256
        and (batch.verified_at is not null or batch.published_at is not null)
    )
    or exists (
      select 1
      from aiq_private.aiq_result_packages package
      where package.matrix_batch_id = target_batch_id
        and package.package_sha256 = target_package_sha256
        and (
          package.signature_verified
          or package.verifier_attestation is not null
          or package.verified_at is not null
          or package.trust_tier >= 'trusted_verified'
        )
    )
    or exists (
      select 1
      from aiq_private.aiq_submission_inbox inbox
      where inbox.idempotency_key = target_batch_id
        and inbox.package_sha256 = target_package_sha256
        and inbox.verification_status = 'verified'
    )
    or exists (
      select 1
      from aiq_private.aiq_package_runs link
      join aiq_private.aiq_runs run on run.run_id = link.run_id
      where link.package_sha256 = target_package_sha256
        and run.matrix_batch_id = target_batch_id
        and (run.published or run.trust_tier >= 'trusted_verified')
    )
    or exists (
      select 1
      from aiq_private.aiq_package_runs link
      join aiq_private.aiq_score_snapshots score on score.run_id = link.run_id
      where link.package_sha256 = target_package_sha256
        and score.published
    )
    or exists (
      select 1
      from aiq_private.aiq_verification_audit audit
      join aiq_private.aiq_submission_inbox inbox
        on inbox.inbox_id = audit.inbox_id
      where inbox.idempotency_key = target_batch_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'verified_published'
    );

  if advanced and not aiq_private.publication_is_complete(
    target_batch_id, target_package_sha256
  ) then
    raise exception 'advanced publication state requires complete v3 verifier evidence'
      using errcode = '23514';
  end if;
  if advancing and not aiq_private.publication_transition_is_eligible(
    target_batch_id, target_package_sha256
  ) then
    raise exception 'first publication requires current verifier and conflict eligibility'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: attach_storage_reference(uuid, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.attach_storage_reference(supplied_object_id uuid, supplied_reference_type text, supplied_reference_key text) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  existing aiq_private.aiq_storage_object_references%rowtype;
  object_state text;
begin
  if supplied_reference_type not in (
    'submission_inbox', 'submission_conflict',
    'artifact_ingress_claim', 'artifact_claim_binding',
    'calibration_run', 'official_publication'
  ) or not coalesce(supplied_reference_key ~ '^[a-z0-9][a-z0-9._:/-]{0,254}$', false)
  then
    raise exception 'invalid private Storage reference identity' using errcode = '22023';
  end if;
  select object.lifecycle_state into object_state
  from aiq_private.aiq_storage_objects object
  where object.object_id = supplied_object_id
  for update;
  if object_state is null or object_state <> 'active' then
    raise exception 'private Storage object does not accept new references'
      using errcode = '55000';
  end if;
  insert into aiq_private.aiq_storage_object_references (
    object_id, reference_type, reference_key
  ) values (supplied_object_id, supplied_reference_type, supplied_reference_key)
  on conflict (reference_type, reference_key) do update
    set active = true, deactivated_at = null
    where aiq_storage_object_references.object_id = excluded.object_id
  returning * into existing;
  if existing.reference_id is null or existing.object_id is distinct from supplied_object_id then
    raise exception 'private Storage reference conflicts with registry'
      using errcode = '23505';
  end if;
end;
$_$;



--
-- Name: binary_micro_diagnostic_jsonb_is_valid(jsonb, integer, integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.binary_micro_diagnostic_jsonb_is_valid(candidate jsonb, expected_sample_size integer, expected_successes integer) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $$
declare
  expected_proportion numeric;
  expected_wilson_lower numeric;
  expected_wilson_upper numeric;
  sample_count numeric;
  success_count numeric;
  z numeric := 1.959963984540054;
  z_squared numeric;
  denominator numeric;
  center numeric;
  margin numeric;
begin
  if not aiq_private.has_exact_jsonb_keys(
    candidate,
    array[
      'proportion', 'sample_size', 'successes', 'wilson_lower', 'wilson_upper'
    ]::text[]
  )
    or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
      candidate -> 'sample_size'
    )
    or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
      candidate -> 'successes'
    )
    or (candidate ->> 'sample_size')::integer is distinct from expected_sample_size
    or (candidate ->> 'successes')::integer is distinct from expected_successes
    or expected_successes > expected_sample_size
  then
    return false;
  end if;
  if expected_sample_size = 0 then
    return candidate -> 'proportion' = 'null'::jsonb
      and candidate -> 'wilson_lower' = 'null'::jsonb
      and candidate -> 'wilson_upper' = 'null'::jsonb;
  end if;
  if jsonb_typeof(candidate -> 'proportion') is distinct from 'number'
    or jsonb_typeof(candidate -> 'wilson_lower') is distinct from 'number'
    or jsonb_typeof(candidate -> 'wilson_upper') is distinct from 'number'
  then
    return false;
  end if;
  sample_count := expected_sample_size;
  success_count := expected_successes;
  expected_proportion := success_count / sample_count;
  z_squared := z * z;
  denominator := 1 + z_squared / sample_count;
  center := expected_proportion + z_squared / (2 * sample_count);
  margin := z * sqrt(
    expected_proportion * (1 - expected_proportion) / sample_count
      + z_squared / (4 * sample_count * sample_count)
  );
  expected_wilson_lower := (center - margin) / denominator;
  expected_wilson_upper := (center + margin) / denominator;
  return (candidate ->> 'proportion')::numeric between 0 and 1
    and (candidate ->> 'wilson_lower')::numeric between 0 and 1
    and (candidate ->> 'wilson_upper')::numeric between 0 and 1
    and round((candidate ->> 'proportion')::numeric, 6)
      = round(expected_proportion, 6)
    and round((candidate ->> 'wilson_lower')::numeric, 6)
      = round(expected_wilson_lower, 6)
    and round((candidate ->> 'wilson_upper')::numeric, 6)
      = round(expected_wilson_upper, 6);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;


--
-- Name: claim_artifact_reference_key(uuid, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.claim_artifact_reference_key(target_inbox_id uuid, requested_kind text, requested_sha256 text) returns text
    language sql immutable
    SET search_path to ''
    as $$
  select target_inbox_id::text || '/' || requested_sha256 || '/' || requested_kind;
$$;


--
-- Name: completion_bounds_jsonb_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.completion_bounds_jsonb_is_valid(candidate jsonb) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $$
declare
  lower_bound numeric;
  upper_bound numeric;
begin
  if not aiq_private.has_exact_jsonb_keys(
    candidate, array['lower', 'upper']::text[]
  )
    or jsonb_typeof(candidate -> 'lower') is distinct from 'number'
    or jsonb_typeof(candidate -> 'upper') is distinct from 'number'
  then
    return false;
  end if;
  lower_bound := (candidate ->> 'lower')::numeric;
  upper_bound := (candidate ->> 'upper')::numeric;
  return lower_bound between 0 and 100
    and upper_bound between 0 and 100
    and lower_bound <= upper_bound;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;


--
-- Name: deactivate_storage_reference(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.deactivate_storage_reference(supplied_reference_type text, supplied_reference_key text) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  if supplied_reference_type in ('calibration_run','official_publication') then
    raise exception 'publication-owned Storage references cannot be deactivated generically'
      using errcode='42501';
  end if;
  update aiq_private.aiq_storage_object_references reference
  set active = false, deactivated_at = now()
  where reference.reference_type = supplied_reference_type
    and reference.reference_key = supplied_reference_key
    and reference.active;
end;
$$;


--
-- Name: dto_adapter_failure_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_adapter_failure_is_valid(candidate jsonb) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $_$
begin
  return jsonb_typeof(candidate) = 'object'
    and aiq_private.has_exact_jsonb_keys(candidate, array[
      'artifacts','exit_code','kind','message','stderr',
      'stderr_truncated','stdout_truncated'
    ]::text[])
    and jsonb_typeof(candidate -> 'kind') = 'string'
    and candidate ->> 'kind' in (
      'spawn','timeout','unsupported','authentication','usage_limit',
      'non_zero_exit','budget_exceeded','output_truncated','workspace_integrity'
    )
    and (
      candidate -> 'exit_code' = 'null'::jsonb
      or (
        jsonb_typeof(candidate -> 'exit_code') = 'number'
        and candidate ->> 'exit_code' ~ '^-?[0-9]+$'
        and (candidate ->> 'exit_code')::numeric between -2147483648 and 2147483647
      )
    )
    and aiq_private.dto_ascii_is_valid(candidate -> 'message', 128)
    and jsonb_typeof(candidate -> 'stderr') = 'string'
    and octet_length(candidate ->> 'stderr') <= 64
    and jsonb_typeof(candidate -> 'stdout_truncated') = 'boolean'
    and jsonb_typeof(candidate -> 'stderr_truncated') = 'boolean'
    and aiq_private.dto_artifact_array_is_valid(
      candidate -> 'artifacts', array['stdout.jsonl','stderr.txt'], 2
    );
exception when others then return false;
end;
$_$;


--
-- Name: dto_artifact_array_is_valid(jsonb, text[], integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_artifact_array_is_valid(candidates jsonb, allowed_kinds text[], maximum_count integer) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $$
begin
  return jsonb_typeof(candidates) = 'array'
    and jsonb_array_length(candidates) <= maximum_count
    and not exists (
      select 1 from jsonb_array_elements(candidates) item
      where not aiq_private.dto_artifact_is_valid(
        item, allowed_kinds, 4194304
      )
    )
    and (
      select count(*) = count(distinct item ->> 'kind')
        and count(*) = count(distinct item ->> 'uri')
      from jsonb_array_elements(candidates) item
    )
    and not exists (
      select 1
      from jsonb_array_elements(candidates) left_item
      join jsonb_array_elements(candidates) right_item
        on left_item ->> 'content_hash' = right_item ->> 'content_hash'
       and left_item ->> 'bytes' <> right_item ->> 'bytes'
    );
exception when others then return false;
end;
$$;


--
-- Name: dto_artifact_is_valid(jsonb, text[], bigint); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_artifact_is_valid(candidate jsonb, allowed_kinds text[], maximum_bytes bigint default 4194304) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $$
declare
  digest text;
  kind text;
begin
  if jsonb_typeof(candidate) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(
      candidate, array['bytes','content_hash','kind','uri']::text[]
    )
    or not aiq_private.dto_identifier_is_valid(candidate -> 'kind', 32)
    or not aiq_private.dto_sha256_is_valid(candidate -> 'content_hash')
    or not aiq_private.dto_uint_is_valid(candidate -> 'bytes', maximum_bytes)
    or (candidate ->> 'bytes')::bigint not between 1 and maximum_bytes
    or jsonb_typeof(candidate -> 'uri') <> 'string'
  then return false;
  end if;
  kind := candidate ->> 'kind';
  digest := substr(candidate ->> 'content_hash', 8);
  return kind = any(allowed_kinds)
    and candidate ->> 'uri' =
      'aiq-artifact://sha256/' || digest || '/' || kind;
exception when others then return false;
end;
$$;


--
-- Name: dto_ascii_is_valid(jsonb, integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_ascii_is_valid(candidate jsonb, maximum_bytes integer) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $_$
begin
  return jsonb_typeof(candidate) = 'string'
    and octet_length(candidate #>> '{}') between 1 and maximum_bytes
    and candidate #>> '{}' ~ '^[ -~]+$'
    and strpos(candidate #>> '{}', '"') = 0
    and strpos(candidate #>> '{}', E'\\') = 0;
exception when others then return false;
end;
$_$;


--
-- Name: dto_identifier_is_valid(jsonb, integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_identifier_is_valid(candidate jsonb, maximum_bytes integer) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $_$
begin
  return jsonb_typeof(candidate) = 'string'
    and octet_length(candidate #>> '{}') between 1 and maximum_bytes
    and candidate #>> '{}' ~ '^[A-Za-z0-9._-]+$';
exception when others then return false;
end;
$_$;


--
-- Name: dto_preflight_is_valid(jsonb, jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_preflight_is_valid(candidate jsonb, expected_models jsonb) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $_$
declare
  entry jsonb;
  probe jsonb;
  observed_version text;
  evidence jsonb;
begin
  if jsonb_typeof(candidate) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(candidate, array[
      'authentication_probe','cli_probe','manifest_issues','models',
      'node_id','schema_version'
    ]::text[])
    or candidate ->> 'schema_version' <> 'aiq.capability-validation.v2'
    or jsonb_typeof(candidate -> 'node_id') <> 'string'
    or candidate ->> 'node_id' !~ '^node_[0-9a-f]{64}$'
    or jsonb_typeof(candidate -> 'manifest_issues') <> 'array'
    or jsonb_array_length(candidate -> 'manifest_issues') <> 0
    or jsonb_typeof(candidate -> 'cli_probe') <> 'object'
    or not aiq_private.has_exact_jsonb_keys(
      candidate -> 'cli_probe', array['failure','status','version']::text[]
    )
    or candidate #>> '{cli_probe,status}' <> 'available'
    or not aiq_private.dto_ascii_is_valid(candidate #> '{cli_probe,version}', 32)
    or candidate #> '{cli_probe,failure}' <> 'null'::jsonb
    or jsonb_typeof(candidate -> 'authentication_probe') <> 'object'
    or not aiq_private.has_exact_jsonb_keys(
      candidate -> 'authentication_probe', array['failure','mode','status']::text[]
    )
    or candidate #>> '{authentication_probe,status}' <> 'available'
    or candidate #>> '{authentication_probe,mode}' <> 'chatgpt_subscription'
    or candidate #> '{authentication_probe,failure}' <> 'null'::jsonb
    or jsonb_typeof(candidate -> 'models') <> 'array'
    or jsonb_array_length(candidate -> 'models') <> 17
    or (
      select jsonb_agg(value -> 'model' order by ordinality)
      from jsonb_array_elements(candidate -> 'models')
        with ordinality model(value, ordinality)
    ) is distinct from expected_models
  then return false;
  end if;
  observed_version := candidate #>> '{cli_probe,version}';
  for entry in select value from jsonb_array_elements(candidate -> 'models') loop
    if jsonb_typeof(entry) <> 'object'
      or not aiq_private.has_exact_jsonb_keys(
        entry, array['model','probe','reason','status']::text[]
      )
      or not aiq_private.dto_ascii_is_valid(entry -> 'reason', 128)
      or entry ->> 'status' not in ('available','unsupported','unavailable')
      or jsonb_typeof(entry -> 'probe') <> 'object'
    then return false;
    end if;
    probe := entry -> 'probe';
    if not aiq_private.has_exact_jsonb_keys(probe, array[
        'artifacts','codex_version','evidence_digest','failure','observed_at',
        'result_digest','result_preview','status'
      ]::text[])
      or probe ->> 'codex_version' is distinct from observed_version
      or probe ->> 'observed_at' !~ '^unix-ms:[0-9]{1,39}$'
      or not aiq_private.dto_sha256_is_valid(probe -> 'evidence_digest')
      or not aiq_private.dto_artifact_array_is_valid(
        probe -> 'artifacts', array['stdout.jsonl','stderr.txt'], 2
      )
      or probe ->> 'status' not in ('available','observed_unsupported','failed')
      or not (
        (entry ->> 'status' = 'available' and probe ->> 'status' = 'available')
        or (entry ->> 'status' = 'unsupported'
          and probe ->> 'status' = 'observed_unsupported')
        or entry ->> 'status' = 'unavailable'
      )
    then return false;
    end if;
    if probe ->> 'status' = 'available' then
      if not aiq_private.dto_sha256_is_valid(probe -> 'result_digest')
        or jsonb_typeof(probe -> 'result_preview') <> 'string'
        or octet_length(probe ->> 'result_preview') > 64
        or probe -> 'failure' <> 'null'::jsonb
      then return false;
      end if;
    elsif probe -> 'result_digest' <> 'null'::jsonb
      or probe -> 'result_preview' <> 'null'::jsonb
      or not aiq_private.dto_adapter_failure_is_valid(probe -> 'failure')
    then return false;
    end if;
    evidence := jsonb_build_array(
      entry -> 'model', probe -> 'codex_version', probe -> 'observed_at',
      probe -> 'status', probe -> 'result_digest', probe -> 'result_preview',
      probe -> 'artifacts', probe -> 'failure'
    );
    if aiq_private.jcs_sha256(evidence) is distinct from probe ->> 'evidence_digest'
    then return false;
    end if;
    if probe ->> 'status' = 'available' and not exists (
      select 1 from jsonb_array_elements(probe -> 'artifacts') artifact
      where artifact ->> 'kind' = 'stdout.jsonl'
        and artifact ->> 'content_hash' = probe ->> 'result_digest'
    ) and 'sha256:' || encode(
      extensions.digest(convert_to(probe ->> 'result_preview','utf8'),'sha256'),'hex'
    ) <> probe ->> 'result_digest'
    then return false;
    end if;
  end loop;
  return true;
exception when others then return false;
end;
$_$;


--
-- Name: dto_result_is_valid(jsonb, text, boolean, jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_result_is_valid(candidate jsonb, expected_run_id text, synthetic boolean, preflight jsonb) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $_$
declare
  failure jsonb;
  usage jsonb;
  provenance jsonb;
  attempted boolean;
  total bigint;
  status text;
  evaluation text;
  expected_result_hash text;
  preflight_status text;
begin
  if jsonb_typeof(candidate) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(candidate, array[
      'artifacts','evaluation','evaluator_result_sha256','evaluator_stdout_sha256',
      'failure','latency',
      'model','provenance','response','response_sha256','result_id','run_id',
      'schema_version','status','task_hash','task_id','task_score',
      'task_version','tool_usage','workspace_manifest'
    ]::text[])
    or candidate ->> 'schema_version' <> 'aiq.result.v2'
    or candidate ->> 'run_id' is distinct from expected_run_id
    or candidate ->> 'result_id' !~ '^result_[0-9a-f]{64}$'
    or not aiq_private.dto_identifier_is_valid(candidate -> 'task_id', 64)
    or not aiq_private.dto_identifier_is_valid(candidate -> 'task_version', 32)
    or not aiq_private.dto_sha256_is_valid(candidate -> 'task_hash')
    or jsonb_typeof(candidate -> 'model') <> 'object'
    or not aiq_private.has_exact_jsonb_keys(
      candidate -> 'model', array['family','reasoning_effort']::text[]
    )
    or jsonb_typeof(candidate -> 'status') <> 'string'
    or candidate ->> 'status' not in ('completed','failed','unsupported','unevaluated')
    or jsonb_typeof(candidate -> 'evaluation') <> 'string'
    or candidate ->> 'evaluation' not in ('correct','partial','incorrect','not_evaluated')
    or jsonb_typeof(candidate -> 'latency') <> 'object'
    or not aiq_private.has_exact_jsonb_keys(
      candidate -> 'latency', array['wall_ms']::text[]
    )
    or not aiq_private.dto_uint_is_valid(
      candidate #> '{latency,wall_ms}', 9007199254740991
    )
    or not aiq_private.dto_artifact_array_is_valid(
      candidate -> 'artifacts',
      array['stdout.jsonl','stderr.txt','final-response.txt','workspace-snapshot.json'],
      4
    )
    or not (
      candidate -> 'evaluator_stdout_sha256' = 'null'::jsonb
      or aiq_private.dto_sha256_is_valid(candidate -> 'evaluator_stdout_sha256')
    )
  then return false;
  end if;

  expected_result_hash := aiq_private.jcs_sha256(
    jsonb_set(candidate,'{result_id}','""'::jsonb)
  );
  if candidate ->> 'result_id' is distinct from
    'result_' || substr(expected_result_hash, 8)
  then return false;
  end if;

  usage := candidate -> 'tool_usage';
  if jsonb_typeof(usage) <> 'object'
    or not (
      aiq_private.has_exact_jsonb_keys(usage,array['by_tool','steps','total_calls']::text[])
      or aiq_private.has_exact_jsonb_keys(
        usage,array['by_tool','provider_tokens','steps','total_calls']::text[]
      )
    )
    or not aiq_private.dto_uint_is_valid(usage -> 'steps', 4294967295)
    or not aiq_private.dto_uint_is_valid(usage -> 'total_calls', 4294967295)
    or jsonb_typeof(usage -> 'by_tool') <> 'object'
    or (select count(*) from jsonb_object_keys(usage -> 'by_tool')) > 4
    or exists (
      select 1 from jsonb_each(usage -> 'by_tool') member
      where member.key !~ '^[A-Za-z0-9._-]{1,32}$'
        or not aiq_private.dto_uint_is_valid(member.value, 4294967295)
    )
  then return false;
  end if;
  select coalesce(sum((member.value #>> '{}')::bigint),0)
    into total from jsonb_each(usage -> 'by_tool') member;
  if total <> (usage ->> 'total_calls')::bigint then return false; end if;
  if usage ? 'provider_tokens' and (
    jsonb_typeof(usage -> 'provider_tokens') <> 'object'
    or (select count(*) from jsonb_object_keys(usage -> 'provider_tokens')) not between 1 and 6
    or exists (
      select 1 from jsonb_each(usage -> 'provider_tokens') token
      where token.key not in ('input','cached_input','cache_write_input','output','reasoning','total')
        or not aiq_private.dto_uint_is_valid(token.value,9007199254740991)
    )
    or (
      usage#>>'{provider_tokens,cached_input}' is not null
      and usage#>>'{provider_tokens,input}' is not null
      and (usage#>>'{provider_tokens,cached_input}')::numeric >
        (usage#>>'{provider_tokens,input}')::numeric
    )
    or (
      usage#>>'{provider_tokens,reasoning}' is not null
      and usage#>>'{provider_tokens,output}' is not null
      and (usage#>>'{provider_tokens,reasoning}')::numeric >
        (usage#>>'{provider_tokens,output}')::numeric
    )
  ) then return false; end if;

  failure := candidate -> 'failure';
  if failure <> 'null'::jsonb and (
    jsonb_typeof(failure) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(
      failure, array['exit_code','kind','message','retryable']::text[]
    )
    or failure ->> 'kind' not in (
      'spawn','timeout','unsupported_model','authentication','subscription_limit','non_zero_exit',
      'capability_unavailable','capability_validation_failed','missing_evaluator',
      'missing_response','evaluator_failure','budget_exceeded','output_truncated',
      'workspace_unavailable','workspace_integrity'
    )
    or not aiq_private.dto_ascii_is_valid(failure -> 'message', 128)
    or jsonb_typeof(failure -> 'retryable') <> 'boolean'
    or not (
      failure -> 'exit_code' = 'null'::jsonb
      or (jsonb_typeof(failure -> 'exit_code') = 'number'
        and failure ->> 'exit_code' ~ '^-?[0-9]+$'
        and (failure ->> 'exit_code')::numeric between -2147483648 and 2147483647)
    )
  ) then return false;
  end if;

  provenance := candidate -> 'provenance';
  if jsonb_typeof(provenance) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(provenance, array[
      'codex_version','local_trust','node_id','observed_at',
      'runner_version','synthetic'
    ]::text[])
    or jsonb_typeof(provenance -> 'synthetic') <> 'boolean'
    or (provenance ->> 'synthetic')::boolean is distinct from synthetic
    or provenance ->> 'node_id' !~ '^node_[0-9a-f]{64}$'
    or not aiq_private.dto_ascii_is_valid(provenance -> 'runner_version', 32)
    or not aiq_private.dto_ascii_is_valid(provenance -> 'codex_version', 32)
    or provenance ->> 'local_trust' not in ('trusted','untrusted')
    or (
      synthetic and provenance ->> 'observed_at' <> 'synthetic'
    )
    or (
      not synthetic and provenance ->> 'observed_at' !~ '^unix-ms:[0-9]{1,39}$'
    )
  then return false;
  end if;

  status := candidate ->> 'status';
  evaluation := candidate ->> 'evaluation';
  if status = 'completed' then
    if failure <> 'null'::jsonb
      or jsonb_typeof(candidate -> 'response') <> 'string'
      or octet_length(candidate ->> 'response') > 64
      or not aiq_private.dto_sha256_is_valid(candidate -> 'response_sha256')
      or not aiq_private.dto_sha256_is_valid(candidate -> 'evaluator_result_sha256')
      or (not synthetic
        and not aiq_private.dto_sha256_is_valid(candidate -> 'evaluator_stdout_sha256'))
      or not (
        (evaluation = 'correct' and candidate -> 'task_score' = '1.0'::jsonb)
        or (evaluation = 'incorrect' and candidate -> 'task_score' = '0.0'::jsonb)
        or (evaluation = 'partial' and jsonb_typeof(candidate -> 'task_score') = 'number'
          and (candidate ->> 'task_score')::numeric > 0
          and (candidate ->> 'task_score')::numeric < 1)
      )
    then return false;
    end if;
  elsif status = 'unevaluated' then
    if evaluation <> 'not_evaluated' or candidate -> 'task_score' <> 'null'::jsonb
      or jsonb_typeof(candidate -> 'response') <> 'string'
      or failure ->> 'kind' <> 'missing_evaluator'
      or candidate -> 'evaluator_result_sha256' <> 'null'::jsonb
      or candidate -> 'evaluator_stdout_sha256' <> 'null'::jsonb
    then return false; end if;
  elsif status = 'unsupported' then
    if evaluation <> 'not_evaluated' or candidate -> 'task_score' <> 'null'::jsonb
      or candidate -> 'response' <> 'null'::jsonb
      or candidate -> 'response_sha256' <> 'null'::jsonb
      or failure ->> 'kind' <> 'capability_unavailable'
      or candidate -> 'evaluator_result_sha256' <> 'null'::jsonb
      or candidate -> 'evaluator_stdout_sha256' <> 'null'::jsonb
    then return false; end if;
  else
    if evaluation <> 'not_evaluated' or failure = 'null'::jsonb
      or candidate -> 'evaluator_result_sha256' <> 'null'::jsonb
      or candidate -> 'evaluator_stdout_sha256' <> 'null'::jsonb
      or (
        failure ->> 'kind' in (
          'timeout','unsupported_model','non_zero_exit','missing_response',
          'budget_exceeded','output_truncated'
        ) and candidate -> 'task_score' <> '0.0'::jsonb
      )
      or (
        failure ->> 'kind' in (
          'spawn','authentication','subscription_limit','capability_validation_failed',
          'evaluator_failure','workspace_unavailable','workspace_integrity'
        ) and candidate -> 'task_score' <> 'null'::jsonb
      )
      or failure ->> 'kind' in ('capability_unavailable','missing_evaluator')
      or (
        (candidate -> 'response' <> 'null'::jsonb) is distinct from
        (failure ->> 'kind' = 'evaluator_failure')
      )
    then return false; end if;
  end if;

  if candidate -> 'response' = 'null'::jsonb then
    if candidate -> 'response_sha256' <> 'null'::jsonb then return false; end if;
  else
    if not exists (
      select 1 from jsonb_array_elements(candidate -> 'artifacts') item
      where item ->> 'kind' = 'final-response.txt'
        and item ->> 'content_hash' = candidate ->> 'response_sha256'
    ) and 'sha256:' || encode(
      extensions.digest(convert_to(candidate ->> 'response','utf8'),'sha256'),'hex'
    ) <> candidate ->> 'response_sha256'
    then return false; end if;
  end if;

  attempted := not synthetic and coalesce(failure ->> 'kind','') not in (
    'capability_unavailable','capability_validation_failed','workspace_unavailable'
  );
  if attempted then
    if failure ->> 'kind' = 'workspace_integrity' then
      if not (
        (candidate -> 'workspace_manifest' = 'null'::jsonb
          and (select count(*) from jsonb_array_elements(candidate -> 'artifacts') item
            where item ->> 'kind' = 'workspace-snapshot.json') = 0)
        or (
          candidate -> 'workspace_manifest' <> 'null'::jsonb
          and aiq_private.dto_artifact_is_valid(
            candidate -> 'workspace_manifest', array['workspace-manifest.json'], 4194304
          )
          and (select count(*) from jsonb_array_elements(candidate -> 'artifacts') item
            where item ->> 'kind' = 'workspace-snapshot.json') = 1
        )
      ) then return false; end if;
    elsif candidate -> 'workspace_manifest' = 'null'::jsonb
      or not aiq_private.dto_artifact_is_valid(
        candidate -> 'workspace_manifest', array['workspace-manifest.json'], 4194304
      )
      or (select count(*) from jsonb_array_elements(candidate -> 'artifacts') item
        where item ->> 'kind' = 'workspace-snapshot.json') <> 1
    then return false; end if;
  elsif candidate -> 'workspace_manifest' <> 'null'::jsonb
    or exists (
      select 1 from jsonb_array_elements(candidate -> 'artifacts') item
      where item ->> 'kind' = 'workspace-snapshot.json'
    )
  then return false;
  end if;
  if candidate -> 'workspace_manifest' <> 'null'::jsonb and exists (
    select 1 from jsonb_array_elements(candidate -> 'artifacts') item
    where item ->> 'kind' = candidate #>> '{workspace_manifest,kind}'
       or item ->> 'uri' = candidate #>> '{workspace_manifest,uri}'
       or (item ->> 'content_hash' = candidate #>> '{workspace_manifest,content_hash}'
         and item ->> 'bytes' <> candidate #>> '{workspace_manifest,bytes}')
  ) then return false; end if;

  if not synthetic then
    if provenance ->> 'node_id' is distinct from preflight ->> 'node_id'
      or provenance ->> 'codex_version' is distinct from preflight #>> '{cli_probe,version}'
    then return false; end if;
    select model ->> 'status' into preflight_status
    from jsonb_array_elements(preflight -> 'models') model
    where model -> 'model' = candidate -> 'model';
    if preflight_status is null
      or (preflight_status = 'available' and status = 'unsupported')
      or (preflight_status = 'unsupported' and status <> 'unsupported')
      or (preflight_status = 'unavailable' and (
        status <> 'failed' or failure ->> 'kind' <> 'capability_validation_failed'
      ))
    then return false; end if;
  end if;
  return true;
exception when others then return false;
end;
$_$;


--
-- Name: dto_run_provenance_is_valid(jsonb, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_run_provenance_is_valid(candidate jsonb, task_set_hash text, preflight_digest text) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $_$
declare
  field text;
begin
  if jsonb_typeof(candidate) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(candidate, array[
      'catalog_digest','codex_executable_digest','corpus_commitment_sha256',
      'corpus_release_id','environment_digest','evaluator_digest',
      'harness_digest','network_policy_digest','permission_evidence_digest','preflight_digest',
      'prompt_digest','run_class','runner_executable_digest','runtime_digest',
      'schema_version','source_manifest_digest','task_set_digest',
      'tool_policy_digest'
    ]::text[])
    or candidate ->> 'schema_version' <> 'aiq.run-provenance.v2'
    or candidate ->> 'run_class' <> 'official'
    or not aiq_private.dto_identifier_is_valid(candidate -> 'corpus_release_id', 128)
    or candidate ->> 'catalog_digest' <>
      'sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7'
    or candidate ->> 'task_set_digest' <>
      'sha256:f6fc21fa2deb3788c186437c45f8e1c8d5d1e366d32bc81e3b5f847e9844cf05'
    or candidate ->> 'evaluator_digest' <>
      'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c'
    or candidate ->> 'task_set_digest' is distinct from task_set_hash
    or candidate ->> 'preflight_digest' is distinct from preflight_digest
  then return false;
  end if;
  foreach field in array array[
    'catalog_digest','codex_executable_digest','corpus_commitment_sha256',
    'environment_digest','evaluator_digest','harness_digest',
      'network_policy_digest','permission_evidence_digest','preflight_digest','prompt_digest',
    'runner_executable_digest','runtime_digest','source_manifest_digest',
    'task_set_digest','tool_policy_digest'
  ] loop
    if not aiq_private.dto_sha256_is_valid(candidate -> field) then return false; end if;
  end loop;
  return true;
exception when others then return false;
end;
$_$;


--
-- Name: dto_schedule_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_schedule_is_valid(candidate jsonb) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $_$
declare
  parsed_date date;
begin
  if jsonb_typeof(candidate) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(
      candidate, array['local_date','local_time','occurrence','timezone']::text[]
    )
    or jsonb_typeof(candidate -> 'local_date') <> 'string'
    or candidate ->> 'local_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(candidate -> 'local_time') <> 'string'
    or candidate ->> 'local_time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or jsonb_typeof(candidate -> 'occurrence') <> 'string'
    or candidate ->> 'occurrence' not in ('day','night')
    or jsonb_typeof(candidate -> 'timezone') <> 'string'
    or octet_length(candidate ->> 'timezone') not between 1 and 64
    or not exists (
      select 1 from pg_catalog.pg_timezone_names zone
      where zone.name = candidate ->> 'timezone'
    )
  then return false;
  end if;
  parsed_date := (candidate ->> 'local_date')::date;
  return to_char(parsed_date, 'YYYY-MM-DD') = candidate ->> 'local_date';
exception when others then return false;
end;
$_$;


--
-- Name: dto_sha256_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_sha256_is_valid(candidate jsonb) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $_$
begin
  return jsonb_typeof(candidate) = 'string'
    and candidate #>> '{}' ~ '^sha256:[0-9a-f]{64}$'
    and candidate #>> '{}' <> 'sha256:' || repeat('0', 64);
exception when others then return false;
end;
$_$;


--
-- Name: dto_uint_is_valid(jsonb, numeric); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.dto_uint_is_valid(candidate jsonb, maximum numeric) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $_$
begin
  return jsonb_typeof(candidate) = 'number'
    and candidate::text ~ '^(0|[1-9][0-9]*)$'
    and candidate::numeric between 0 and maximum;
exception when others then return false;
end;
$_$;


--
-- Name: enforce_distributed_assignment_transition(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.enforce_distributed_assignment_transition() returns trigger
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  transition_at timestamptz;
begin
  if old.assignment_id is distinct from new.assignment_id
    or old.lease_attempt is distinct from new.lease_attempt
    or old.schema_version is distinct from new.schema_version
    or old.task_package_id is distinct from new.task_package_id
    or old.package_version is distinct from new.package_version
    or old.package_hash is distinct from new.package_hash
    or old.assignment_hash is distinct from new.assignment_hash
    or old.run_id is distinct from new.run_id
    or old.coordinator_node_id is distinct from new.coordinator_node_id
    or old.node_id is distinct from new.node_id
    or old.assignment_sequence is distinct from new.assignment_sequence
    or old.lease_id is distinct from new.lease_id
    or old.signature_algorithm is distinct from new.signature_algorithm
    or old.signature is distinct from new.signature
    or old.signature_status is distinct from new.signature_status
    or old.synthetic is distinct from new.synthetic
    or old.offered_at is distinct from new.offered_at
    or old.expires_at is distinct from new.expires_at
  then
    raise exception 'distributed assignment identity is immutable' using errcode = '55000';
  end if;
  if (old.status, new.status) not in (
    ('offered', 'accepted'), ('offered', 'revoked'), ('offered', 'expired'),
    ('accepted', 'running'), ('accepted', 'revoked'), ('accepted', 'expired'),
    ('running', 'completed'), ('running', 'revoked'), ('running', 'expired')
  ) then
    raise exception 'invalid distributed assignment lifecycle transition'
      using errcode = '23514';
  end if;

  if new.status = 'accepted' then
    transition_at := new.accepted_at;
    if old.accepted_at is not null
      or new.running_at is distinct from old.running_at
      or new.completed_at is distinct from old.completed_at
      or new.revoked_at is distinct from old.revoked_at
      or new.expired_at is distinct from old.expired_at
    then
      raise exception 'accepted transition may set only accepted_at'
        using errcode = '23514';
    end if;
  elsif new.status = 'running' then
    transition_at := new.running_at;
    if new.accepted_at is distinct from old.accepted_at
      or old.running_at is not null
      or new.completed_at is distinct from old.completed_at
      or new.revoked_at is distinct from old.revoked_at
      or new.expired_at is distinct from old.expired_at
    then
      raise exception 'running transition may set only running_at'
        using errcode = '23514';
    end if;
  elsif new.status = 'completed' then
    transition_at := new.completed_at;
    if new.accepted_at is distinct from old.accepted_at
      or new.running_at is distinct from old.running_at
      or old.completed_at is not null
      or new.revoked_at is distinct from old.revoked_at
      or new.expired_at is distinct from old.expired_at
    then
      raise exception 'completed transition may set only completed_at'
        using errcode = '23514';
    end if;
  elsif new.status = 'revoked' then
    transition_at := new.revoked_at;
    if new.accepted_at is distinct from old.accepted_at
      or new.running_at is distinct from old.running_at
      or new.completed_at is distinct from old.completed_at
      or old.revoked_at is not null
      or new.expired_at is distinct from old.expired_at
    then
      raise exception 'revoked transition may set only revoked_at'
        using errcode = '23514';
    end if;
  elsif new.status = 'expired' then
    transition_at := new.expired_at;
    if new.accepted_at is distinct from old.accepted_at
      or new.running_at is distinct from old.running_at
      or new.completed_at is distinct from old.completed_at
      or new.revoked_at is distinct from old.revoked_at
      or old.expired_at is not null
    then
      raise exception 'expired transition may set only expired_at'
        using errcode = '23514';
    end if;
  end if;

  if transition_at is null
    or new.updated_at is distinct from transition_at
    or new.updated_at <= old.updated_at
  then
    raise exception 'distributed assignment transition time must advance exactly'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: ensure_storage_object(text, text, text, text, text, bigint, text, timestamp with time zone); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.ensure_storage_object(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone) returns uuid
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  existing aiq_private.aiq_storage_objects%rowtype;
  inserted_id uuid;
  database_now timestamptz;
begin
  if supplied_object_type not in ('submission_package', 'runner_artifact')
    or not coalesce(
      (supplied_object_type = 'submission_package'
        and supplied_bucket = 'aiq-submission-packages')
      or (supplied_object_type = 'runner_artifact'
        and supplied_bucket = 'aiq-runner-artifacts'),
      false
    )
    or not coalesce(supplied_sha256 ~ '^[0-9a-f]{64}$', false)
    or supplied_bytes not between 1 and (
      case when supplied_artifact_kind = 'evaluator-results.json'
        then 3948544 else 4194304 end
    )
    or supplied_retention_class not in ('ephemeral_30d', 'audit_1y', 'preserve')
    or ((supplied_retention_class = 'preserve') is distinct from (supplied_expires_at is null))
    or (
      supplied_object_type = 'submission_package'
      and (supplied_artifact_kind is not null
        or supplied_path is distinct from 'sha256/' || supplied_sha256)
    )
    or (
      supplied_object_type = 'runner_artifact'
      and (
        supplied_artifact_kind not in (
          'evaluator-results.json', 'final-response.txt', 'stderr.txt', 'stdout.jsonl',
          'workspace-manifest.json', 'workspace-snapshot.json'
        )
        or supplied_path is distinct from
          'sha256/' || supplied_sha256 || '/' || supplied_artifact_kind
      )
    )
  then
    raise exception 'invalid private Storage object identity' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.storage.inventory-deletion-gate',71783153620529
  ));
  database_now:=clock_timestamp();

  insert into aiq_private.aiq_storage_objects (
    object_type, artifact_kind, bucket_name, object_path, content_sha256,
    byte_size, retention_class, expires_at,next_attempt_at,registered_at,updated_at
  ) values (
    supplied_object_type, supplied_artifact_kind, supplied_bucket, supplied_path,
    supplied_sha256, supplied_bytes, supplied_retention_class, supplied_expires_at,
    database_now,database_now,database_now
  ) on conflict (bucket_name, object_path) do nothing
  returning object_id into inserted_id;
  if inserted_id is not null then
    return inserted_id;
  end if;

  select * into strict existing
  from aiq_private.aiq_storage_objects object
  where object.bucket_name = supplied_bucket and object.object_path = supplied_path
  for update;
  if row(
    existing.object_type, existing.artifact_kind, existing.content_sha256,
    existing.byte_size, existing.retention_class
  ) is distinct from row(
    supplied_object_type, supplied_artifact_kind, supplied_sha256,
    supplied_bytes, supplied_retention_class
  ) then
    raise exception 'private Storage object identity conflicts with registry'
      using errcode = '23505';
  end if;
  if existing.lifecycle_state <> 'active' then
    raise exception 'non-active private Storage identity cannot be reused'
      using errcode = '55000';
  end if;
  update aiq_private.aiq_storage_objects object
  set expires_at = case
        when existing.retention_class = 'preserve' then null
        else greatest(existing.expires_at, supplied_expires_at)
      end,
      updated_at = now()
  where object.object_id = existing.object_id;
  return existing.object_id;
end;
$_$;


--
-- Name: storage_registry_inventory_digest(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.storage_registry_inventory_digest() returns text
    language sql stable
    SET search_path to ''
    as $$
  select aiq_private.jcs_sha256(coalesce(
    jsonb_agg(jsonb_build_object(
      'bucket',object.bucket_name,
      'key',object.object_path,
      'content_sha256',object.content_sha256,
      'bytes',object.byte_size
    ) order by object.bucket_name collate "C",object.object_path collate "C"),
    '[]'::jsonb
  ))
  from aiq_private.aiq_storage_objects object
  where object.lifecycle_state<>'deleted';
$$;


--
-- Name: evaluator_result_bindings_v3_are_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.evaluator_result_bindings_v3_are_valid(payload jsonb) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $_$
declare
  artifact jsonb := payload -> 'evaluator_results_artifact';
  result jsonb;
begin
  if jsonb_typeof(payload -> 'results') is distinct from 'array'
    or not (payload ? 'evaluator_results_artifact')
  then
    return false;
  end if;
  if jsonb_array_length(payload -> 'results') = 0 then
    return artifact is not distinct from 'null'::jsonb;
  end if;
  if jsonb_typeof(artifact) is distinct from 'object'
    or not aiq_private.has_exact_jsonb_keys(
      artifact, array['bytes', 'content_hash', 'kind', 'uri']::text[]
    )
    or artifact ->> 'kind' is distinct from 'evaluator-results.json'
    or jsonb_typeof(artifact -> 'bytes') is distinct from 'number'
    or not coalesce((artifact ->> 'bytes') ~ '^[1-9][0-9]*$', false)
    or (artifact ->> 'bytes')::bigint not between 1 and 3948544
    or jsonb_typeof(artifact -> 'content_hash') is distinct from 'string'
    or not coalesce(
      artifact ->> 'content_hash' ~ '^sha256:[0-9a-f]{64}$'
        and artifact ->> 'content_hash' <> 'sha256:' || repeat('0', 64),
      false
    )
    or jsonb_typeof(artifact -> 'uri') is distinct from 'string'
    or artifact ->> 'uri' is distinct from
      'aiq-artifact://sha256/'
      || replace(artifact ->> 'content_hash', 'sha256:', '')
      || '/evaluator-results.json'
  then
    return false;
  end if;
  for result in select value from jsonb_array_elements(payload -> 'results')
  loop
    if jsonb_typeof(result) is distinct from 'object'
      or not aiq_private.has_exact_jsonb_keys(
        result,
        array[
          'artifacts', 'evaluation', 'evaluator_result_sha256',
          'evaluator_stdout_sha256', 'failure',
          'latency', 'model', 'provenance', 'response', 'response_sha256',
          'result_id', 'run_id', 'schema_version', 'status', 'task_hash',
          'task_id', 'task_score', 'task_version', 'tool_usage',
          'workspace_manifest'
        ]::text[]
      )
      or result ->> 'schema_version' is distinct from 'aiq.result.v2'
      or not (result ? 'evaluator_result_sha256')
      or not (result ? 'evaluator_stdout_sha256')
      or not (
        result -> 'evaluator_stdout_sha256' = 'null'::jsonb
        or (
          jsonb_typeof(result -> 'evaluator_stdout_sha256') = 'string'
          and result ->> 'evaluator_stdout_sha256' ~ '^sha256:[0-9a-f]{64}$'
          and result ->> 'evaluator_stdout_sha256'
            <> 'sha256:' || repeat('0', 64)
        )
      )
      or (
        result ->> 'status' = 'completed'
        and (
          jsonb_typeof(result -> 'evaluator_result_sha256') is distinct from 'string'
          or not coalesce(
            result ->> 'evaluator_result_sha256' ~ '^sha256:[0-9a-f]{64}$'
              and result ->> 'evaluator_result_sha256'
                <> 'sha256:' || repeat('0', 64),
            false
          )
        )
      )
      or (
        result ->> 'status' is distinct from 'completed'
        and (
          result -> 'evaluator_result_sha256' is distinct from 'null'::jsonb
          or result -> 'evaluator_stdout_sha256' is distinct from 'null'::jsonb
        )
      )
    then
      return false;
    end if;
  end loop;
  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$_$;


--
-- Name: frozen_catalog_identity_is_valid(text, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.frozen_catalog_identity_is_valid(target_task_set_id text, target_task_set_version text, target_scoring_version text) returns boolean
    language sql stable
    SET search_path to ''
    as $_$
  select exists (
    select 1
    from aiq_private.aiq_task_sets task_set
    join aiq_private.aiq_scoring_versions scoring
      on scoring.scoring_version = target_scoring_version
    where task_set.task_set_id = target_task_set_id
      and task_set.task_set_version = target_task_set_version
      and task_set.task_set_id = 'aiq-core'
      and task_set.task_set_version = '1.0.5'
      and scoring.scoring_version = '1.0.5'
      and scoring.benchmark_version = 'aiq-core@1.0.5'
      and scoring.is_published
      and not scoring.synthetic
      and task_set.task_count = 72
      and task_set.domain_count = 10
      and task_set.content_status = 'committed'
      and task_set.is_published
      and not coalesce((task_set.metadata ->> 'synthetic')::boolean, true)
      and task_set.catalog_identity_scope = 'ordered_full_task_metadata'
      and task_set.catalog_sha256 =
        '46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7'
      and task_set.hidden_payload_commitment is not null
      and task_set.metadata ->> 'corpus_commitment_schema' =
        'aiq.corpus-commitment.v2'
      and task_set.metadata ->> 'corpus_commitment_sha256' =
        'sha256:' || task_set.hidden_payload_commitment
      and task_set.metadata ->> 'catalog_release_identity_sha256' =
        'sha256:496b40f54dc7c3dc92d8880201373344c723001a0570a4debd28e539cfe4030d'
      and task_set.metadata ->> 'evaluator_identity_sha256' =
        'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c'
      and (
        select aiq_private.jcs_sha256(
          jsonb_agg(
            'sha256:' || catalog.fixture_commitment
            order by ('sha256:' || catalog.fixture_commitment) collate "C"
          )
        )
        from aiq_private.aiq_task_catalog catalog
        where catalog.task_set_id = task_set.task_set_id
          and catalog.task_set_version = task_set.task_set_version
          and catalog.fixture_commitment is not null
      ) = 'sha256:f6fc21fa2deb3788c186437c45f8e1c8d5d1e366d32bc81e3b5f847e9844cf05'
      and task_set.metadata ->> 'quota_policy' =
        'frozen_domain_by_difficulty'
      and aiq_private.ordered_catalog_identity_sha256(
        target_task_set_id, target_task_set_version
      ) = task_set.catalog_sha256
  );
$_$;


--
-- Name: guard_evidence_insert_for_unpublished_run(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_evidence_insert_for_unpublished_run() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
declare
  closed boolean;
begin
  closed := exists (
    select 1 from aiq_private.aiq_runs run
    where run.run_id = new.run_id and run.published
  );
  if tg_table_name = 'aiq_package_runs' then
    closed := closed
      or aiq_private.package_evidence_is_staged(new.package_sha256);
  else
    closed := closed or aiq_private.run_evidence_is_staged(new.run_id);
  end if;
  if closed then
    raise exception 'staged or published run evidence cannot receive new % rows', tg_table_name
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_matrix_batch_lifecycle(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_matrix_batch_lifecycle() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'matrix batch evidence is append-only' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array['verified_at', 'published_at']::text[])
      is distinct from
     (to_jsonb(old) - array['verified_at', 'published_at']::text[])
    or (old.verified_at is not null and new.verified_at is distinct from old.verified_at)
    or (old.published_at is not null and new.published_at is distinct from old.published_at)
  then
    raise exception 'matrix batch evidence is immutable outside forward lifecycle changes'
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_node_identity_lifecycle(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_node_identity_lifecycle() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  if new.node_id is distinct from old.node_id
    or new.key_fingerprint is distinct from old.key_fingerprint
    or new.signature_algorithm is distinct from old.signature_algorithm
    or new.public_key is distinct from old.public_key
    or new.operator_class is distinct from old.operator_class
    or new.synthetic is distinct from old.synthetic
  then
    raise exception 'registered node identity fields are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_result_package_lifecycle(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_result_package_lifecycle() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'result package evidence is append-only' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array[
      'signature_verified', 'verifier_attestation', 'trust_tier', 'verified_at',
      'rejection_code', 'artifact_expires_at'
    ]::text[]) is distinct from (to_jsonb(old) - array[
      'signature_verified', 'verifier_attestation', 'trust_tier', 'verified_at',
      'rejection_code', 'artifact_expires_at'
    ]::text[])
    or (old.signature_verified and not new.signature_verified)
    or new.trust_tier < old.trust_tier
    or (old.verifier_attestation is not null
      and new.verifier_attestation is distinct from old.verifier_attestation)
    or (old.verified_at is not null and new.verified_at is distinct from old.verified_at)
    or (old.rejection_code is not null and new.rejection_code is distinct from old.rejection_code)
    or (old.artifact_expires_at is not null
      and new.artifact_expires_at is distinct from old.artifact_expires_at)
  then
    raise exception 'result package evidence is immutable outside forward lifecycle changes'
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_run_lifecycle(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_run_lifecycle() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'run evidence is append-only' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array[
      'status', 'trust_tier', 'published', 'started_at', 'completed_at',
      'failure_code', 'failure_detail'
    ]::text[]) is distinct from (to_jsonb(old) - array[
      'status', 'trust_tier', 'published', 'started_at', 'completed_at',
      'failure_code', 'failure_detail'
    ]::text[])
    or (old.published and not new.published)
    or new.trust_tier < old.trust_tier
    or (old.started_at is not null and new.started_at is distinct from old.started_at)
    or (old.completed_at is not null and new.completed_at is distinct from old.completed_at)
    or (
      (new.failure_code is distinct from old.failure_code
        or new.failure_detail is distinct from old.failure_detail)
      and not (
        not old.published
        and old.status in ('scheduled', 'probing', 'running', 'scoring')
        and new.status in ('failed', 'cancelled')
        and new.status is distinct from old.status
      )
    )
    or (
      new.status is distinct from old.status
      and not case old.status
        when 'scheduled' then new.status in ('probing', 'running', 'failed', 'cancelled')
        when 'probing' then new.status in ('running', 'failed', 'cancelled')
        when 'running' then new.status in ('scoring', 'failed', 'cancelled')
        when 'scoring' then new.status in ('completed', 'partial', 'failed', 'cancelled')
        else false
      end
    )
  then
    raise exception 'run evidence is immutable outside forward lifecycle changes'
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_score_snapshot_lifecycle(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_score_snapshot_lifecycle() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
declare
  run_is_synthetic boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'score snapshot evidence is append-only' using errcode = '55000';
  end if;
  select run.synthetic into strict run_is_synthetic
  from aiq_private.aiq_runs run
  where run.run_id = new.run_id;
  if new.published and run_is_synthetic then
    raise exception 'synthetic score snapshots cannot be published'
      using errcode = '55000';
  end if;
  if new.score_status = 'synthetic_complete' and not run_is_synthetic
    or new.score_status = 'official' and run_is_synthetic
    or (
      run_is_synthetic
      and new.valid_task_count = 72
      and new.covered_domain_count = 10
      and new.invalid_count = 0
      and new.missing_count = 0
      and new.not_applicable_count = 0
      and new.score_status <> 'synthetic_complete'
    )
  then
    raise exception 'score classification does not match synthetic completeness'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if exists (
      select 1 from aiq_private.aiq_runs run
      where run.run_id = new.run_id and run.published
    )
      or aiq_private.run_evidence_is_staged(new.run_id)
    then
      raise exception 'a staged or published run cannot receive another score snapshot'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - 'published') is distinct from (to_jsonb(old) - 'published')
    or (old.published and not new.published)
  then
    raise exception 'score snapshot evidence is immutable outside publication'
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_storage_registry_mutation(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_storage_registry_mutation() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'private Storage registry is durable' using errcode = '55000';
  end if;
  if row(
    new.object_id, new.object_type, new.artifact_kind, new.bucket_name,
    new.object_path, new.content_sha256, new.byte_size, new.registered_at
  ) is distinct from row(
    old.object_id, old.object_type, old.artifact_kind, old.bucket_name,
    old.object_path, old.content_sha256, old.byte_size, old.registered_at
  ) then
    raise exception 'private Storage object identity is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_storage_reconciliation_history(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_storage_reconciliation_history() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  if tg_op='DELETE' then
    raise exception 'Storage reconciliation history cannot be deleted'
      using errcode='55000';
  end if;
  if old.mismatch_type='inventory_success' or new.mismatch_type='inventory_success' then
    raise exception 'successful Storage inventory epochs are append-only'
      using errcode='55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_submission_inbox_lifecycle(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.guard_submission_inbox_lifecycle() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  if tg_op = 'DELETE' then
    if old.expires_at > now()
      or exists (
        select 1 from aiq_private.aiq_submission_conflicts conflict
        where conflict.inbox_id = old.inbox_id
      )
      or exists (
        select 1 from aiq_private.aiq_verification_audit audit
        where audit.inbox_id = old.inbox_id
      )
      or exists (
        select 1 from aiq_private.aiq_matrix_batches batch
        where batch.package_sha256 = old.package_sha256
      )
      or exists (
        select 1 from aiq_private.calibration_runs calibration
        where calibration.package_sha256 = old.package_sha256
      )
    then
      raise exception 'retained submission inbox evidence cannot be deleted'
        using errcode = '55000';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - array[
      'verification_status', 'state', 'expires_at', 'retention_state',
      'object_bucket', 'object_key', 'object_content_sha256', 'object_bytes',
      'claim_token', 'claim_expires_at', 'claim_attempts', 'claim_ack'
    ]::text[])
      is distinct from
     (to_jsonb(old) - array[
      'verification_status', 'state', 'expires_at', 'retention_state',
      'object_bucket', 'object_key', 'object_content_sha256', 'object_bytes',
      'claim_token', 'claim_expires_at', 'claim_attempts', 'claim_ack'
    ]::text[])
    or (
      old.object_bucket is not null
      and row(
        new.object_bucket, new.object_key, new.object_content_sha256, new.object_bytes
      ) is distinct from row(
        old.object_bucket, old.object_key, old.object_content_sha256, old.object_bytes
      )
    )
    or (
      new.verification_status is distinct from old.verification_status
      and not (
        old.verification_status = 'unverified'
        and new.verification_status in ('verified', 'rejected')
      )
    )
    or (
      new.state is distinct from old.state
      and not (
        (old.state = 'queued' and new.state in ('processed', 'rejected'))
        or (old.state = 'processed' and new.state = 'rejected')
      )
    )
    or (
      new.retention_state is distinct from old.retention_state
      and not (
        (old.retention_state = 'active' and new.retention_state in ('expired', 'purged'))
        or (old.retention_state = 'expired' and new.retention_state = 'purged')
      )
    )
  then
    raise exception 'submission inbox evidence is immutable outside forward lifecycle changes'
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: has_exact_jsonb_keys(jsonb, text[]); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.has_exact_jsonb_keys(value jsonb, expected_keys text[]) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $$
declare
  observed_keys text[];
  normalized_expected_keys text[];
begin
  if jsonb_typeof(value) is distinct from 'object' then
    return false;
  end if;
  select array_agg(key order by key) into observed_keys
  from jsonb_object_keys(value) key;
  select array_agg(key order by key) into normalized_expected_keys
  from unnest(expected_keys) key;
  return observed_keys is not distinct from normalized_expected_keys;
end;
$$;


--
-- Name: jcs_bytes_is_within(jsonb, integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.jcs_bytes_is_within(candidate jsonb, maximum_bytes integer) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $$
declare
  canonical text;
begin
  canonical := aiq_private.jcs_text(candidate);
  return canonical is not null
    and maximum_bytes >= 0
    and octet_length(convert_to(canonical,'utf8')) <= maximum_bytes;
exception when others then
  return false;
end;
$$;


--
-- Name: jcs_number_text(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.jcs_number_text(candidate jsonb) returns text
    language plpgsql stable
    SET search_path to ''
    SET extra_float_digits to '3'
    as $$
declare
  rendered text;
  unsigned text;
  mantissa text;
  digits text;
  sign text := '';
  exponent_text text;
  exponent integer;
  decimal_position integer;
  leading_zeroes integer;
begin
  if jsonb_typeof(candidate) <> 'number' then return null; end if;
  rendered := ((candidate #>> '{}')::double precision)::text;
  if rendered in ('Infinity','-Infinity','NaN') then return null; end if;
  if rendered::double precision = 0 then return '0'; end if;
  if left(rendered,1) = '-' then
    sign := '-';
    unsigned := substr(rendered,2);
  else
    unsigned := rendered;
  end if;
  if unsigned ~* 'e' then
    mantissa := split_part(lower(unsigned),'e',1);
    exponent_text := split_part(lower(unsigned),'e',2);
    exponent := exponent_text::integer;
    decimal_position := case when strpos(mantissa,'.') = 0
      then length(mantissa) else strpos(mantissa,'.') - 1 end;
  else
    mantissa := unsigned;
    exponent := 0;
    decimal_position := case when strpos(mantissa,'.') = 0
      then length(mantissa) else strpos(mantissa,'.') - 1 end;
  end if;
  digits := replace(mantissa,'.','');
  leading_zeroes := length(digits) - length(ltrim(digits,'0'));
  digits := ltrim(digits,'0');
  exponent := exponent + decimal_position - leading_zeroes - 1;
  digits := rtrim(digits,'0');
  if exponent between -6 and 20 then
    if exponent < 0 then
      return sign || '0.' || repeat('0',-exponent-1) || digits;
    elsif length(digits) <= exponent + 1 then
      return sign || digits || repeat('0',exponent + 1 - length(digits));
    end if;
    return sign || substr(digits,1,exponent+1) || '.' ||
      substr(digits,exponent+2);
  end if;
  return sign || left(digits,1) ||
    case when length(digits) = 1 then '' else '.' || substr(digits,2) end ||
    'e' || case when exponent >= 0 then '+' else '' end || exponent::text;
exception when others then
  return null;
end;
$$;


--
-- Name: jcs_sha256(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.jcs_sha256(candidate jsonb) returns text
    language plpgsql stable
    SET search_path to ''
    as $$
declare
  canonical text;
begin
  canonical := aiq_private.jcs_text(candidate);
  if canonical is null then
    return null;
  end if;
  return 'sha256:' || encode(
    extensions.digest(convert_to(canonical, 'utf8'), 'sha256'), 'hex'
  );
exception when others then
  return null;
end;
$$;


--
-- Name: jcs_text(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.jcs_text(candidate jsonb) returns text
    language plpgsql stable
    SET search_path to ''
    as $$
declare
  result text;
begin
  case jsonb_typeof(candidate)
    when 'object' then
      select '{' || coalesce(string_agg(
        to_jsonb(member.key)::text || ':' || aiq_private.jcs_text(member.value),
        ',' order by member.key collate "C"
      ), '') || '}'
      into result
      from jsonb_each(candidate) member;
    when 'array' then
      select '[' || coalesce(string_agg(
        aiq_private.jcs_text(member.value), ',' order by member.ordinality
      ), '') || ']'
      into result
      from jsonb_array_elements(candidate) with ordinality member(value, ordinality);
    when 'number' then
      result := aiq_private.jcs_number_text(candidate);
    else
      result := candidate::text;
  end case;
  return result;
exception when others then
  return null;
end;
$$;


--
-- Name: jsonb_sha256_field_is_valid(jsonb, text, boolean); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.jsonb_sha256_field_is_valid(document jsonb, field_name text, prefixed boolean) returns boolean
    language sql immutable
    SET search_path to ''
    as $_$
  select jsonb_typeof(document -> field_name) is not distinct from 'string'
    and coalesce(
      case when prefixed
        then document ->> field_name ~ '^sha256:[0-9a-f]{64}$'
          and document ->> field_name is distinct from
            'sha256:' || repeat('0', 64)
        else document ->> field_name ~ '^[0-9a-f]{64}$'
          and document ->> field_name is distinct from repeat('0', 64)
      end,
      false
    );
$_$;


--
-- Name: jsonb_wire_value_is_bounded(jsonb, integer, integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.jsonb_wire_value_is_bounded(candidate jsonb, maximum_depth integer default 32, maximum_nodes integer default 100000) returns boolean
    language sql immutable
    SET search_path to ''
    as $$
  with recursive nodes(value, depth) as (
    select candidate, 1
    union all
    select child.value, parent.depth + 1
    from nodes parent
    cross join lateral (
      select array_value.value
      from jsonb_array_elements(
        case when jsonb_typeof(parent.value) = 'array'
          then parent.value else '[]'::jsonb end
      ) array_value
      union all
      select object_value.value
      from jsonb_each(
        case when jsonb_typeof(parent.value) = 'object'
          then parent.value else '{}'::jsonb end
      ) object_value
    ) child
    where parent.depth < maximum_depth + 1
  ),
  summary as (
    select
      count(*) as node_count,
      coalesce(max(depth), 0) as observed_depth,
      bool_and(
        case jsonb_typeof(value)
          when 'array' then jsonb_array_length(value) <= 1224
          when 'object' then
            (select count(*) <= 256
               and coalesce(max(length(key)), 0) <= 256
             from jsonb_object_keys(value) key)
          when 'string' then length(value #>> '{}') <= 65536
          else true
        end
      ) as values_are_bounded
    from nodes
  )
  select candidate is not null
    and node_count <= maximum_nodes
    and observed_depth <= maximum_depth
    and values_are_bounded
  from summary;
$$;


--
-- Name: node_public_key_matches_id(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.node_public_key_matches_id(node_id text, public_key text) returns boolean
    language sql immutable
    SET search_path to ''
    as $_$
  select coalesce(
    node_id ~ '^node_[0-9a-f]{64}$'
      and public_key ~ '^[0-9a-f]{64}$'
      and public_key is distinct from repeat('0', 64)
      and node_id is not distinct from 'node_' || encode(
        extensions.digest(decode(public_key, 'hex'), 'sha256'), 'hex'
      ),
    false
  );
$_$;


--
-- Name: normalized_domain_score_summary(jsonb, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.normalized_domain_score_summary(candidate_results jsonb, target_task_set_id text, target_task_set_version text) returns table(minimum_domain_count integer, fixed_score numeric, domain_scores jsonb)
    language sql stable
    SET search_path to ''
    as $$
  select
    coalesce(min(domain.valid_in_domain), 0)::integer,
    avg(domain.domain_score) * 100,
    coalesce(
      jsonb_object_agg(
        domain.domain,
        coalesce(to_jsonb(round(domain.domain_score, 5)), 'null'::jsonb)
      ),
      '{}'::jsonb
    )
  from (
    select
      task.domain,
      count(result.value) filter (
        where result.value is not null
          and result.value -> 'task_score' is distinct from 'null'::jsonb
      )::integer as valid_in_domain,
      avg((result.value ->> 'task_score')::numeric) filter (
        where result.value is not null
          and result.value -> 'task_score' is distinct from 'null'::jsonb
      ) as domain_score
    from aiq_private.aiq_task_catalog task
    left join jsonb_array_elements(candidate_results) result(value)
      on result.value ->> 'task_id' = task.task_id
     and result.value ->> 'task_version' = task.task_version
    where task.task_set_id = target_task_set_id
      and task.task_set_version = target_task_set_version
    group by task.domain
  ) domain;
$$;


--
-- Name: normalized_outcome_from_source(jsonb, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.normalized_outcome_from_source(source jsonb, score_tier text) returns text
    language plpgsql immutable
    SET search_path to ''
    as $$
declare
  status text := source ->> 'status';
  evaluation text := source ->> 'evaluation';
  failure_kind text := source -> 'failure' ->> 'kind';
begin
  if score_tier = 'not_applicable'
    and status = 'unsupported'
    and failure_kind = 'capability_unavailable'
  then
    return 'not_applicable';
  end if;
  if status = 'completed' and evaluation = 'correct' and source -> 'failure' = 'null'::jsonb
  then return 'correct';
  elsif status = 'completed' and evaluation = 'partial' and source -> 'failure' = 'null'::jsonb
  then return 'partial';
  elsif status = 'completed' and evaluation = 'incorrect' and source -> 'failure' = 'null'::jsonb
  then return 'incorrect';
  elsif status = 'failed' and failure_kind = 'timeout'
  then return 'timeout';
  elsif status = 'failed' and failure_kind = 'budget_exceeded'
  then return 'budget_exhausted';
  elsif status = 'failed' and failure_kind in ('unsupported_model', 'non_zero_exit')
  then return 'tool_failure';
  elsif status = 'failed' and failure_kind = 'missing_response'
  then return 'wrong_artifact';
  elsif status = 'failed' and failure_kind = 'output_truncated'
  then return 'policy_failure';
  elsif (
    status in ('failed', 'unevaluated')
    and failure_kind in (
      'evaluator_failure', 'workspace_unavailable', 'workspace_integrity', 'missing_evaluator',
      'spawn', 'authentication', 'subscription_limit', 'capability_validation_failed'
    )
  )
  then return 'invalid';
  end if;
  return null;
end;
$$;


--
-- Name: normalized_responsibility_from_source(jsonb, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.normalized_responsibility_from_source(source jsonb, score_tier text) returns text
    language sql immutable
    SET search_path to ''
    as $$
  select case
    when score_tier = 'not_applicable' then null
    when source ->> 'status' = 'completed'
      and source ->> 'evaluation' = 'incorrect' then 'agent'
    when source -> 'failure' ->> 'kind' = 'timeout' then 'timeout'
    when source -> 'failure' ->> 'kind' = 'budget_exceeded' then 'budget'
    when source -> 'failure' ->> 'kind' = 'unsupported_model' then 'model'
    when source -> 'failure' ->> 'kind' = 'non_zero_exit' then 'tool'
    when source -> 'failure' ->> 'kind' in ('missing_response', 'output_truncated')
      then 'wrong_artifact'
    when source -> 'failure' ->> 'kind' in (
      'evaluator_failure', 'workspace_unavailable', 'workspace_integrity', 'missing_evaluator'
    ) then 'benchmark_infrastructure'
    when source -> 'failure' ->> 'kind' in (
      'spawn', 'authentication', 'subscription_limit', 'capability_validation_failed'
    ) then 'platform'
    else null
  end;
$$;


--
-- Name: official_model_matrix_is_exact(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.official_model_matrix_is_exact(models jsonb) returns boolean
    language sql immutable
    SET search_path to ''
    as $$
  select models is not distinct from '[
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
$$;


--
-- Name: ordered_catalog_identity_sha256(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.ordered_catalog_identity_sha256(target_task_set_id text, target_task_set_version text) returns text
    language sql stable
    SET search_path to ''
    as $$
  with catalog as (
    select
      task.*,
      task.full_public_metadata::jsonb as metadata
    from aiq_private.aiq_task_catalog task
    where task.task_set_id = target_task_set_id
      and task.task_set_version = target_task_set_version
  ),
  validated as (
    select
      count(*) as task_count,
      count(catalog.catalog_ordinal) as ordinal_count,
      count(catalog.full_public_metadata) as metadata_count,
      count(distinct catalog.catalog_ordinal) as distinct_ordinal_count,
      min(catalog.catalog_ordinal) as first_ordinal,
      max(catalog.catalog_ordinal) as last_ordinal,
      bool_and(
        jsonb_typeof(catalog.metadata) = 'object'
        and catalog.metadata ->> 'task_id' = catalog.task_id
        and catalog.metadata ->> 'task_version' = catalog.task_version
        and catalog.metadata ->> 'title' = catalog.title
        and catalog.metadata ->> 'domain' = catalog.domain
        and catalog.metadata ->> 'difficulty' = catalog.difficulty
        and catalog.metadata ->> 'summary' = catalog.summary
        and catalog.metadata -> 'evaluator' ->> 'kind' =
          catalog.evaluator_kind
        and catalog.metadata -> 'evaluator' ->> 'scorer_version' =
          catalog.scorer_version
        and catalog.metadata -> 'allowed_tools' = catalog.allowed_tools
        and catalog.metadata -> 'budget' = catalog.budget
        and catalog.metadata -> 'tags' = to_jsonb(catalog.tags)
        and catalog.metadata -> 'leakage_review' ->> 'notes' =
          catalog.leakage_notes
        and catalog.fixture_commitment is not null
        and catalog.hidden_content_ref is null
        and catalog.public_metadata
      ) as relational_binding_is_exact,
      jsonb_agg(catalog.metadata order by catalog.catalog_ordinal)
        as ordered_metadata
    from catalog
  )
  select case
    when validated.task_count = 72
      and validated.ordinal_count = 72
      and validated.metadata_count = 72
      and validated.distinct_ordinal_count = 72
      and validated.first_ordinal = 1
      and validated.last_ordinal = 72
      and validated.relational_binding_is_exact
    then replace(aiq_private.jcs_sha256(validated.ordered_metadata), 'sha256:', '')
    else null
  end
  from validated;
$$;


--
-- Name: package_evidence_is_staged(text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.package_evidence_is_staged(target_package_sha256 text) returns boolean
    language sql stable
    SET search_path to ''
    as $$
  select exists (
    select 1
    from aiq_private.aiq_submission_inbox inbox
    where inbox.package_sha256 = target_package_sha256
      and (
        inbox.state <> 'queued'
        or exists (
          select 1
          from aiq_private.aiq_verification_audit audit
          where audit.inbox_id = inbox.inbox_id
            and audit.package_sha256 = target_package_sha256
            and audit.event_type = 'staged'
        )
      )
  );
$$;


--
-- Name: production_execution_identities_are_authorized(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.production_execution_identities_are_authorized(runner_node_id text, verifier_node_id text) returns boolean
    language sql stable
    SET search_path to ''
    as $$
  select coalesce(
    runner_node_id is not null
      and (
        verifier_node_id is null
        or verifier_node_id is distinct from runner_node_id
      )
      and exists (
        select 1
        from aiq_private.aiq_nodes runner
        where runner.node_id = runner_node_id
          and runner.operator_class = 'official'
          and not runner.synthetic
          and runner.status = 'active'
          and runner.signature_algorithm = 'ed25519'
          and runner.signature_status = 'verified'
          and runner.trust_tier in (
            'trusted_verified'::aiq_private.trust_tier,
            'independently_reproduced'::aiq_private.trust_tier
          )
          and runner.public_visible
          and runner.capabilities @> array['runner']::text[]
          and runner.metadata @> '{"approved_role":"runner"}'::jsonb
          and aiq_private.node_public_key_matches_id(
            runner.node_id, runner.public_key
          )
      )
      and (
        verifier_node_id is null
        or exists (
          select 1
          from aiq_private.aiq_nodes verifier
          where verifier.node_id = verifier_node_id
            and verifier.operator_class = 'verifier'
            and not verifier.synthetic
            and verifier.status = 'active'
            and verifier.signature_algorithm = 'ed25519'
            and verifier.signature_status = 'verified'
            and verifier.trust_tier in (
              'trusted_verified'::aiq_private.trust_tier,
              'independently_reproduced'::aiq_private.trust_tier
            )
            and verifier.public_visible
            and aiq_private.node_public_key_matches_id(
              verifier.node_id, verifier.public_key
            )
        )
      ),
    false
  );
$$;


--
-- Name: production_publisher_identity_is_authorized(text, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.production_publisher_identity_is_authorized(publisher_node_id text, runner_node_id text, verifier_node_id text) returns boolean
    language sql stable
    SET search_path to ''
    as $$
  select coalesce(
    publisher_node_id is not null
      and runner_node_id is not null
      and verifier_node_id is not null
      and publisher_node_id is distinct from runner_node_id
      and publisher_node_id is distinct from verifier_node_id
      and exists (
        select 1
        from aiq_private.aiq_nodes publisher
        where publisher.node_id = publisher_node_id
          and publisher.operator_class = 'official'
          and publisher.publisher_authorized
          and not publisher.synthetic
          and publisher.status = 'active'
          and publisher.signature_algorithm = 'ed25519'
          and publisher.signature_status = 'verified'
          and publisher.trust_tier = 'trusted_verified'
          and publisher.public_visible
          and publisher.capabilities @> array['publisher']::text[]
          and publisher.metadata @> '{"approved_role":"publisher"}'::jsonb
          and publisher.key_fingerprint = 'sha256:' || substring(
            publisher.node_id from 6
          )
          and aiq_private.node_public_key_matches_id(
            publisher.node_id, publisher.public_key
          )
      ),
    false
  );
$$;



--
-- Name: reject_artifact_ingress_mutation(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.reject_artifact_ingress_mutation() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'aiq_artifact_ingress_claims' then
      if old.expires_at <= now()
        and not exists (
          select 1
          from aiq_private.aiq_artifact_claim_bindings binding
          join aiq_private.aiq_submission_inbox inbox on inbox.inbox_id = binding.inbox_id
          where inbox.idempotency_key = old.claimed_run_id
            and binding.artifact_kind = old.artifact_kind
            and binding.content_sha256 = old.content_sha256
        )
      then
        return old;
      end if;
    elsif tg_table_name = 'aiq_artifact_ingress_objects' then
      if old.expires_at <= now()
        and not exists (
          select 1 from aiq_private.aiq_artifact_ingress_claims ingress_claim
          where ingress_claim.artifact_kind = old.artifact_kind
            and ingress_claim.content_sha256 = old.content_sha256
        )
        and not exists (
          select 1 from aiq_private.aiq_artifact_claim_bindings binding
          where binding.artifact_kind = old.artifact_kind
            and binding.content_sha256 = old.content_sha256
        )
      then
        return old;
      end if;
    end if;
  end if;
  raise exception 'artifact ingress evidence is immutable' using errcode = '55000';
end;
$$;


--
-- Name: reject_claim_artifact_reference_event_mutation(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.reject_claim_artifact_reference_event_mutation() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  raise exception 'claim artifact reference events are append-only'
    using errcode = '55000';
end;
$$;


--
-- Name: reject_distributed_evidence_mutation(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.reject_distributed_evidence_mutation() returns trigger
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  raise exception '% distributed evidence is append-only', tg_table_name
    using errcode = '55000';
end;
$$;


--
-- Name: reject_staged_evidence_mutation(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.reject_staged_evidence_mutation() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  raise exception '% records are append-only', tg_table_name using errcode = '55000';
end;
$$;


--
-- Name: reject_storage_history_mutation(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.reject_storage_history_mutation() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  raise exception 'private Storage history is append-only' using errcode = '55000';
end;
$$;


--
-- Name: reject_verification_audit_mutation(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.reject_verification_audit_mutation() returns trigger
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  raise exception 'verification audit records are append-only' using errcode = '55000';
end;
$$;


--
-- Name: request_jwt_role(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.request_jwt_role() returns text
    language plpgsql stable
    SET search_path to ''
    as $$
declare
  claims jsonb;
begin
  begin
    claims := nullif(
      current_setting('request.jwt.claims', true),
      ''
    )::jsonb;
  exception
    when invalid_text_representation then
      return null;
  end;
  if jsonb_typeof(claims) is distinct from 'object' then
    return null;
  end if;
  return claims ->> 'role';
end;
$$;


--
-- Name: request_publisher_node_id(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.request_publisher_node_id() returns text
    language plpgsql stable
    SET search_path to ''
    as $_$
declare
  claims jsonb;
  actor_node_id text;
begin
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception
    when invalid_text_representation then
      return null;
  end;
  if jsonb_typeof(claims) is distinct from 'object'
    or jsonb_typeof(claims -> 'aiq_publisher_node_id') is distinct from 'string'
  then
    return null;
  end if;
  actor_node_id := claims ->> 'aiq_publisher_node_id';
  if not coalesce(actor_node_id ~ '^node_[0-9a-f]{64}$', false) then
    return null;
  end if;
  return actor_node_id;
end;
$_$;


--
-- Name: require_request_role(text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.require_request_role(expected_role text) returns void
    language plpgsql stable
    SET search_path to ''
    as $$
begin
  if aiq_private.request_jwt_role() is distinct from expected_role
    or current_setting('role', true) is distinct from expected_role
  then
    raise exception 'request and database roles must both be %', expected_role
      using errcode = '42501';
  end if;
end;
$$;


set default_tablespace = '';

set default_table_access_method = heap;

--
-- Name: aiq_submission_inbox; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_submission_inbox (
    inbox_id uuid default extensions.gen_random_uuid() not null,
    idempotency_key text not null,
    package_sha256 text not null,
    envelope jsonb not null,
    request_context jsonb not null,
    verification_status text default 'unverified'::text not null,
    state text default 'queued'::text not null,
    received_at timestamp with time zone not null,
    expires_at timestamp with time zone not null,
    retention_state text default 'active'::text not null,
    object_bucket text,
    object_key text,
    object_content_sha256 text,
    object_bytes bigint,
    claim_token uuid,
    claim_expires_at timestamp with time zone,
    claim_attempts integer default 0 not null,
    claim_ack text,
    constraint aiq_submission_claim_shape check (((claim_attempts >= 0) and ((claim_token IS not null) or (claim_expires_at IS null)) and (claim_ack = ANY (ARRAY['retry'::text, 'completed'::text])))),
    constraint aiq_submission_inbox_check check ((expires_at > received_at)),
    constraint aiq_submission_inbox_idempotency_key_check check ((idempotency_key ~ '^run_[0-9a-f]{64}$'::text)),
    constraint aiq_submission_inbox_package_sha256_check check ((package_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_submission_inbox_retention_state_check check ((retention_state = ANY (ARRAY['active'::text, 'expired'::text, 'purged'::text]))),
    constraint aiq_submission_inbox_state_check check ((state = ANY (ARRAY['queued'::text, 'processed'::text, 'rejected'::text]))),
    constraint aiq_submission_inbox_verification_status_check check ((verification_status = ANY (ARRAY['unverified'::text, 'verified'::text, 'rejected'::text]))),
    constraint aiq_submission_object_binding_complete check ((((object_bucket IS null) and (object_key IS null) and (object_content_sha256 IS null) and (object_bytes IS null)) or ((object_bucket IS not null) and (object_bucket <> ''::text) and (object_key = ('sha256/'::text || package_sha256)) and (object_content_sha256 = package_sha256) and ((object_bytes >= 1) and (object_bytes <= 4194304)) and (object_bytes = ((request_context ->> 'body_bytes'::text))::bigint))))
);


--
-- Name: table aiq_submission_inbox; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_submission_inbox IS 'Service-only unverified queue. The bounded purge RPC removes only expired rows with no conflict or immutable verification audit; no scheduler is created.';


--
-- Name: require_verification_claim(uuid, uuid, integer, text, text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.require_verification_claim(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, target_run_id text, target_package_sha256 text, completed_terminal text default null::text) returns aiq_private.aiq_submission_inbox
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
  completed_retry boolean;
begin
  select * into claimed
  from aiq_private.aiq_submission_inbox inbox
  where inbox.inbox_id = target_inbox_id
  for update;
  if claimed.inbox_id is null
    or claimed.idempotency_key is distinct from target_run_id
    or claimed.package_sha256 is distinct from target_package_sha256
    or claimed.claim_token is distinct from supplied_lease_token
    or claimed.claim_attempts is distinct from supplied_attempt
  then
    raise exception 'verification claim identity is absent, stale, or superseded'
      using errcode = '55000';
  end if;

  completed_retry := claimed.claim_ack = 'completed'
    and claimed.claim_expires_at is null
    and (
      (
        completed_terminal = 'published'
        and claimed.state = 'processed'
        and claimed.verification_status = 'verified'
        and exists (
          select 1
          from aiq_private.aiq_verification_audit audit
          where audit.inbox_id = claimed.inbox_id
            and audit.package_sha256 = claimed.package_sha256
            and audit.event_type = 'verified_published'
        )
      )
      or
      (
        completed_terminal = 'rejected'
        and claimed.state = 'rejected'
        and claimed.verification_status = 'rejected'
        and exists (
          select 1
          from aiq_private.aiq_verification_audit audit
          where audit.inbox_id = claimed.inbox_id
            and audit.package_sha256 = claimed.package_sha256
            and audit.event_type = 'rejected'
        )
      )
    );
  if completed_retry then
    return claimed;
  end if;
  if completed_terminal is not null
    and completed_terminal not in ('published', 'rejected')
  then
    raise exception 'invalid terminal verification claim mode'
      using errcode = '22023';
  end if;
  if claimed.claim_ack is not null
    or claimed.claim_expires_at is null
    or claimed.claim_expires_at <= clock_timestamp()
    or claimed.verification_status <> 'unverified'
    or not (
      claimed.state = 'queued'
      or (
        claimed.state = 'processed'
        and not exists (
          select 1
          from aiq_private.aiq_verification_audit audit
          where audit.inbox_id = claimed.inbox_id
            and audit.package_sha256 = claimed.package_sha256
            and audit.event_type in ('verified_published', 'rejected')
        )
      )
    )
  then
    raise exception 'verification claim lease is expired, released, or terminal'
      using errcode = '55000';
  end if;
  return claimed;
end;
$$;


--
-- Name: result_package_v3_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.efficiency_pricing_v1_is_valid(candidate jsonb)
returns boolean language plpgsql immutable set search_path to '' as $$
begin
  return jsonb_typeof(candidate)='object'
    and aiq_private.has_exact_jsonb_keys(candidate,array[
      'as_of','currency','formula','hosted_tool_fees_included','limitation',
      'method','processing_tier','rates','source','version'
    ]::text[])
    and candidate->>'method'='standard_api_equivalent_text_token_estimate'
    and candidate->>'version'='aiq.standard-api-equivalent-usd.v1'
    and candidate->>'as_of'='2026-08-02'
    and candidate->>'source'='https://developers.openai.com/api/docs/pricing'
    and candidate->>'currency'='USD'
    and candidate->>'processing_tier'='standard'
    and candidate->'hosted_tool_fees_included'='false'::jsonb
    and candidate->>'formula'=
      '(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again'
    and candidate->>'limitation'=
      'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing'
    and candidate->'rates'=jsonb_build_array(
      jsonb_build_object('model','gpt-5.6-sol','input_usd_nanos_per_token',5000,
        'cached_input_usd_nanos_per_token',500,'cache_write_input_usd_nanos_per_token',6250,
        'output_usd_nanos_per_token',30000),
      jsonb_build_object('model','gpt-5.6-terra','input_usd_nanos_per_token',2000,
        'cached_input_usd_nanos_per_token',200,'cache_write_input_usd_nanos_per_token',2500,
        'output_usd_nanos_per_token',12000),
      jsonb_build_object('model','gpt-5.6-luna','input_usd_nanos_per_token',200,
        'cached_input_usd_nanos_per_token',20,'cache_write_input_usd_nanos_per_token',250,
        'output_usd_nanos_per_token',1200)
    );
exception when others then return false;
end;
$$;

create function aiq_private.provider_token_usage_is_valid(candidate jsonb)
returns boolean language plpgsql immutable set search_path to '' as $$
begin
  return jsonb_typeof(candidate)='object'
    and (select count(*) from jsonb_object_keys(candidate)) between 0 and 6
    and not exists(select 1 from jsonb_each(candidate) token
      where token.key not in ('input','cached_input','cache_write_input','output','reasoning','total')
        or not aiq_private.dto_uint_is_valid(token.value,9007199254740991))
    and (candidate->>'cached_input' is null or candidate->>'input' is null
      or (candidate->>'cached_input')::numeric <= (candidate->>'input')::numeric)
    and (candidate->>'reasoning' is null or candidate->>'output' is null
      or (candidate->>'reasoning')::numeric <= (candidate->>'output')::numeric);
exception when others then return false;
end;
$$;

create function aiq_private.result_efficiency_v1_is_valid(candidate jsonb)
returns boolean language plpgsql stable set search_path to '' as $$
declare
  input_tokens numeric;
  cached_input_tokens numeric;
  cache_write_input_tokens numeric;
  output_tokens numeric;
  input_rate numeric;
  cached_input_rate numeric;
  cache_write_input_rate numeric;
  output_rate numeric;
  expected_cost numeric;
begin
  if not (jsonb_typeof(candidate)='object'
    and aiq_private.has_exact_jsonb_keys(candidate,array[
      'cost_evidence_level','cost_status','model','observed_wall_ms','provider_tokens',
      'provider_tokens_evidence_level','provider_tokens_source','source_result_id',
      'standard_api_equivalent_usd_nanos','task_id','wall_time_evidence_level'
    ]::text[])
    and aiq_private.calibration_model_is_valid(candidate->'model')
    and candidate->>'source_result_id' ~ '^result_[0-9a-f]{64}$'
    and aiq_private.dto_identifier_is_valid(candidate->'task_id',64)
    and (candidate->'observed_wall_ms'='null'::jsonb
      or aiq_private.dto_uint_is_valid(candidate->'observed_wall_ms',9007199254740991))
    and aiq_private.provider_token_usage_is_valid(candidate->'provider_tokens')
    and candidate->>'cost_status' in (
      'estimated','unavailable_missing_usage','unavailable_invalid_usage',
      'unavailable_context_band'
    )
    and ((candidate->'observed_wall_ms'='null'::jsonb)
      = (candidate->'wall_time_evidence_level'='null'::jsonb))
    and (candidate->'wall_time_evidence_level'='null'::jsonb
      or candidate->>'wall_time_evidence_level'='runner_observed')
    and ((candidate->'provider_tokens'='{}'::jsonb)
      = (candidate->'provider_tokens_source'='null'::jsonb))
    and ((candidate->'provider_tokens'='{}'::jsonb)
      = (candidate->'provider_tokens_evidence_level'='null'::jsonb))
    and (candidate->'provider_tokens_source'='null'::jsonb
      or candidate->>'provider_tokens_source'='provider_reported')
    and (candidate->'provider_tokens_evidence_level'='null'::jsonb
      or candidate->>'provider_tokens_evidence_level'='verifier_recomputed')
    and ((candidate->>'cost_status'='estimated')
      = (candidate->'standard_api_equivalent_usd_nanos'<>'null'::jsonb))
    and (candidate->'standard_api_equivalent_usd_nanos'='null'::jsonb
      or aiq_private.dto_uint_is_valid(
        candidate->'standard_api_equivalent_usd_nanos',9007199254740991
      ))
    and ((candidate->'standard_api_equivalent_usd_nanos'='null'::jsonb)
      = (candidate->'cost_evidence_level'='null'::jsonb))
    and (candidate->'cost_evidence_level'='null'::jsonb
      or candidate->>'cost_evidence_level'='verifier_recomputed'))
  then return false; end if;

  if not (candidate->'provider_tokens'?'input')
    or not (candidate->'provider_tokens'?'cached_input')
    or not (candidate->'provider_tokens'?'cache_write_input')
    or not (candidate->'provider_tokens'?'output')
  then return candidate->>'cost_status'='unavailable_missing_usage'; end if;
  input_tokens := (candidate#>>'{provider_tokens,input}')::numeric;
  cached_input_tokens := (candidate#>>'{provider_tokens,cached_input}')::numeric;
  cache_write_input_tokens := (candidate#>>'{provider_tokens,cache_write_input}')::numeric;
  output_tokens := (candidate#>>'{provider_tokens,output}')::numeric;
  if input_tokens>272000
  then return candidate->>'cost_status'='unavailable_context_band'; end if;
  if input_tokens<cached_input_tokens+cache_write_input_tokens
  then return candidate->>'cost_status'='unavailable_invalid_usage'; end if;

  case candidate#>>'{model,family}'
    when 'sol' then
      input_rate:=5000; cached_input_rate:=500; cache_write_input_rate:=6250;
      output_rate:=30000;
    when 'terra' then
      input_rate:=2000; cached_input_rate:=200; cache_write_input_rate:=2500;
      output_rate:=12000;
    when 'luna' then
      input_rate:=200; cached_input_rate:=20; cache_write_input_rate:=250;
      output_rate:=1200;
    else return false;
  end case;
  expected_cost := (input_tokens-cached_input_tokens-cache_write_input_tokens)*input_rate
    + cached_input_tokens*cached_input_rate
    + cache_write_input_tokens*cache_write_input_rate
    + output_tokens*output_rate;
  if expected_cost>9007199254740991
  then return candidate->>'cost_status'='unavailable_invalid_usage'; end if;
  return candidate->>'cost_status'='estimated'
    and (candidate->>'standard_api_equivalent_usd_nanos')::numeric=expected_cost;
exception when others then return false;
end;
$$;

create function aiq_private.efficiency_aggregate_v1_is_valid(candidate jsonb)
returns boolean language plpgsql stable set search_path to '' as $$
declare selected_count integer; observed_count integer; estimated_count integer;
begin
  if jsonb_typeof(candidate)<>'object'
    or not aiq_private.has_exact_jsonb_keys(candidate,array[
      'estimated_cost_tasks','median_observed_wall_ms','model','observed_wall_tasks',
      'p95_observed_wall_ms','provider_token_coverage','provider_token_totals',
      'schema_version','selected_tasks','standard_api_equivalent_usd_nanos',
      'total_observed_wall_ms'
    ]::text[])
    or candidate->>'schema_version'<>'aiq.calibration-efficiency.v1'
    or not aiq_private.calibration_model_is_valid(candidate->'model')
    or not aiq_private.dto_uint_is_valid(candidate->'selected_tasks',72)
    or not aiq_private.dto_uint_is_valid(candidate->'observed_wall_tasks',72)
    or not aiq_private.dto_uint_is_valid(candidate->'estimated_cost_tasks',72)
    or not aiq_private.provider_token_usage_is_valid(candidate->'provider_token_totals')
    or not aiq_private.has_exact_jsonb_keys(candidate->'provider_token_coverage',array[
      'cache_write_input_tasks','cached_input_tasks','input_tasks','output_tasks',
      'reasoning_tasks','selected_tasks','total_tasks'
    ]::text[])
    or exists(select 1 from jsonb_each(candidate->'provider_token_coverage') coverage
      where not aiq_private.dto_uint_is_valid(coverage.value,72))
  then return false; end if;
  selected_count := (candidate->>'selected_tasks')::integer;
  observed_count := (candidate->>'observed_wall_tasks')::integer;
  estimated_count := (candidate->>'estimated_cost_tasks')::integer;
  return selected_count between 1 and 72
    and observed_count between 0 and selected_count
    and estimated_count between 0 and selected_count
    and (candidate#>>'{provider_token_coverage,selected_tasks}')::integer=selected_count
    and not exists(select 1 from jsonb_each(candidate->'provider_token_coverage') coverage
      where coverage.key<>'selected_tasks' and (coverage.value#>>'{}')::integer>selected_count)
    and ((observed_count=0) = (candidate->'total_observed_wall_ms'='null'::jsonb))
    and ((observed_count=0) = (candidate->'median_observed_wall_ms'='null'::jsonb))
    and ((observed_count=0) = (candidate->'p95_observed_wall_ms'='null'::jsonb))
    and (candidate->'total_observed_wall_ms'='null'::jsonb
      or aiq_private.dto_uint_is_valid(candidate->'total_observed_wall_ms',9007199254740991))
    and (candidate->'median_observed_wall_ms'='null'::jsonb
      or aiq_private.dto_uint_is_valid(candidate->'median_observed_wall_ms',9007199254740991))
    and (candidate->'p95_observed_wall_ms'='null'::jsonb
      or aiq_private.dto_uint_is_valid(candidate->'p95_observed_wall_ms',9007199254740991))
    and (candidate->'standard_api_equivalent_usd_nanos'='null'::jsonb
      or (estimated_count=selected_count and aiq_private.dto_uint_is_valid(
        candidate->'standard_api_equivalent_usd_nanos',9007199254740991
      )));
exception when others then return false;
end;
$$;

create function aiq_private.efficiency_aggregate_matches_results(
  candidate jsonb, result_efficiency jsonb
) returns boolean language plpgsql stable set search_path to '' as $$
declare
  selected_count integer;
  model_results jsonb;
  observed_count integer;
  observed_total numeric;
  observed_walls numeric[];
  expected_median numeric;
  expected_p95 numeric;
  estimated_count integer;
  estimated_total numeric;
  token_totals jsonb;
  token_coverage jsonb;
  cost_is_available boolean;
begin
  if aiq_private.efficiency_aggregate_v1_is_valid(candidate) is not true
    or jsonb_typeof(result_efficiency)<>'array'
  then return false; end if;
  selected_count := (candidate->>'selected_tasks')::integer;
  select coalesce(jsonb_agg(evidence.value),'[]'::jsonb) into model_results
  from jsonb_array_elements(result_efficiency) evidence(value)
  where evidence.value->'model'=candidate->'model';
  if jsonb_array_length(model_results)<>selected_count then return false; end if;

  select count(*) filter(where evidence->'observed_wall_ms'<>'null'::jsonb)::integer,
    sum((evidence->>'observed_wall_ms')::numeric)
      filter(where evidence->'observed_wall_ms'<>'null'::jsonb),
    count(*) filter(where evidence->>'cost_status'='estimated')::integer,
    sum((evidence->>'standard_api_equivalent_usd_nanos')::numeric)
      filter(where evidence->>'cost_status'='estimated')
  into observed_count,observed_total,estimated_count,estimated_total
  from jsonb_array_elements(model_results) evidence;
  select array_agg(
    (evidence->>'observed_wall_ms')::numeric
    order by (evidence->>'observed_wall_ms')::numeric
  ) into observed_walls
  from jsonb_array_elements(model_results) evidence
  where evidence->'observed_wall_ms'<>'null'::jsonb;
  if observed_count>0 then
    if observed_count%2=0 then
      expected_median:=trunc(
        (observed_walls[observed_count/2]+observed_walls[observed_count/2+1])/2
      );
    else
      expected_median:=observed_walls[(observed_count+1)/2];
    end if;
    expected_p95:=observed_walls[(observed_count*95+99)/100];
  end if;

  select coalesce(jsonb_object_agg(total.key,total.value order by total.key),'{}'::jsonb)
  into token_totals
  from (
    select token.key,sum((token.value#>>'{}')::numeric) as value
    from jsonb_array_elements(model_results) evidence
    cross join lateral jsonb_each(evidence->'provider_tokens') token
    group by token.key
  ) total;
  select jsonb_build_object(
    'selected_tasks',selected_count,
    'input_tasks',count(*) filter(where evidence->'provider_tokens'?'input'),
    'cached_input_tasks',count(*) filter(where evidence->'provider_tokens'?'cached_input'),
    'cache_write_input_tasks',count(*) filter(where evidence->'provider_tokens'?'cache_write_input'),
    'output_tasks',count(*) filter(where evidence->'provider_tokens'?'output'),
    'reasoning_tasks',count(*) filter(where evidence->'provider_tokens'?'reasoning'),
    'total_tasks',count(*) filter(where evidence->'provider_tokens'?'total')
  ) into token_coverage
  from jsonb_array_elements(model_results) evidence;
  cost_is_available := estimated_count=selected_count
    and estimated_total between 0 and 9007199254740991;

  return observed_count=(candidate->>'observed_wall_tasks')::integer
    and (observed_count=0 or observed_total=(candidate->>'total_observed_wall_ms')::numeric)
    and (observed_count=0 or expected_median=(candidate->>'median_observed_wall_ms')::numeric)
    and (observed_count=0 or expected_p95=(candidate->>'p95_observed_wall_ms')::numeric)
    and estimated_count=(candidate->>'estimated_cost_tasks')::integer
    and token_totals=candidate->'provider_token_totals'
    and token_coverage=candidate->'provider_token_coverage'
    and (
      (not cost_is_available
        and candidate->'standard_api_equivalent_usd_nanos'='null'::jsonb)
      or (cost_is_available
        and (candidate->>'standard_api_equivalent_usd_nanos')::numeric=estimated_total)
    );
exception when others then return false;
end;
$$;

create function aiq_private.result_package_v3_is_valid(envelope jsonb) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $_$
declare
  payload jsonb;
  candidate_result jsonb;
  synthetic boolean;
  preflight jsonb;
  provenance jsonb;
  task_count integer;
  pair_count integer;
  task_set_hash text;
  preflight_digest text;
  expected_run_id text;
begin
  if jsonb_typeof(envelope) <> 'object'
    or aiq_private.jcs_bytes_is_within(envelope,3948544) is distinct from true
    or aiq_private.jsonb_wire_value_is_bounded(envelope) is distinct from true
    or not aiq_private.has_exact_jsonb_keys(envelope, array[
      'claimed_trust','content_hash','idempotency_key','payload',
      'payload_type','schema_version','signature','signer'
    ]::text[])
    or jsonb_typeof(envelope -> 'schema_version') is distinct from 'string'
    or envelope ->> 'schema_version' is distinct from 'aiq.result-package.v3'
    or envelope ->> 'payload_type' <> 'aiq.run.v3'
    or envelope ->> 'idempotency_key' !~ '^run_[0-9a-f]{64}$'
    or envelope ->> 'claimed_trust' not in ('trusted','untrusted')
    or not aiq_private.dto_sha256_is_valid(envelope -> 'content_hash')
    or envelope ->> 'signature' !~ '^[0-9a-f]{128}$'
    or envelope ->> 'signature' = repeat('0',128)
    or jsonb_typeof(envelope -> 'signer') <> 'object'
    or not aiq_private.has_exact_jsonb_keys(
      envelope -> 'signer', array['node_id','public_key']::text[]
    )
    or envelope #>> '{signer,node_id}' !~ '^node_[0-9a-f]{64}$'
    or envelope #>> '{signer,public_key}' !~ '^[0-9a-f]{64}$'
    or envelope #>> '{signer,public_key}' = repeat('0',64)
    or jsonb_typeof(envelope -> 'payload') <> 'object'
  then return false;
  end if;
  payload := envelope -> 'payload';
  if aiq_private.jcs_sha256(payload) is distinct from envelope ->> 'content_hash'
  then return false;
  end if;
  if not aiq_private.has_exact_jsonb_keys(payload, array[
      'capability_validation','evaluator_results_artifact','execution_concurrency',
      'finished_unix_ms','models','provenance','results','run_id','schedule_slot',
      'schema_version','scoring_version','started_unix_ms','synthetic',
      'task_set_hash'
    ]::text[])
    or jsonb_typeof(payload -> 'schema_version') is distinct from 'string'
    or payload ->> 'schema_version' is distinct from 'aiq.run.v3'
    or payload ->> 'run_id' is distinct from envelope ->> 'idempotency_key'
    or payload ->> 'scoring_version' <> '1.0.5'
    or not aiq_private.dto_uint_is_valid(payload -> 'execution_concurrency',32)
    or (payload->>'execution_concurrency')::integer not between 1 and 32
    or jsonb_typeof(payload -> 'synthetic') <> 'boolean'
    or not aiq_private.dto_schedule_is_valid(payload -> 'schedule_slot')
    or not aiq_private.dto_sha256_is_valid(payload -> 'task_set_hash')
    or not aiq_private.dto_uint_is_valid(
      payload -> 'started_unix_ms', 9007199254740991
    )
    or not aiq_private.dto_uint_is_valid(
      payload -> 'finished_unix_ms', 9007199254740991
    )
    or (payload ->> 'finished_unix_ms')::numeric <
      (payload ->> 'started_unix_ms')::numeric
    or not aiq_private.official_model_matrix_is_exact(payload -> 'models')
    or jsonb_typeof(payload -> 'results') <> 'array'
    or jsonb_array_length(payload -> 'results') <> 1224
    or aiq_private.evaluator_result_bindings_v3_are_valid(payload)
      is distinct from true
    or not aiq_private.dto_artifact_is_valid(
      payload -> 'evaluator_results_artifact',
      array['evaluator-results.json'], 3948544
    )
  then return false;
  end if;
  synthetic := (payload ->> 'synthetic')::boolean;
  preflight := payload -> 'capability_validation';
  provenance := payload -> 'provenance';
  if synthetic then
    if preflight <> 'null'::jsonb or provenance <> 'null'::jsonb then return false; end if;
  else
    if not aiq_private.dto_preflight_is_valid(preflight, payload -> 'models')
    then return false; end if;
    preflight_digest := aiq_private.jcs_sha256(preflight);
    if not aiq_private.dto_run_provenance_is_valid(
      provenance, payload ->> 'task_set_hash', preflight_digest
    )
      or preflight ->> 'node_id' is distinct from envelope #>> '{signer,node_id}'
      or aiq_private.node_public_key_matches_id(
        envelope #>> '{signer,node_id}', envelope #>> '{signer,public_key}'
      ) is distinct from true
    then return false; end if;
  end if;

  for candidate_result in
    select value from jsonb_array_elements(payload -> 'results')
  loop
    if not aiq_private.dto_result_is_valid(
      candidate_result, payload ->> 'run_id', synthetic, preflight
    ) then return false; end if;
  end loop;
  select count(distinct result ->> 'task_id'),
    count(distinct (result ->> 'task_id', result -> 'model'))
  into task_count, pair_count
  from jsonb_array_elements(payload -> 'results') result;
  if task_count <> 72 or pair_count <> 1224
    or exists (
      select 1
      from jsonb_array_elements(payload -> 'results') left_result
      join jsonb_array_elements(payload -> 'results') right_result
        on left_result ->> 'task_id' = right_result ->> 'task_id'
      where left_result ->> 'task_version' <> right_result ->> 'task_version'
         or left_result ->> 'task_hash' <> right_result ->> 'task_hash'
    )
  then return false; end if;

  select aiq_private.jcs_sha256(jsonb_agg(task_hash order by task_hash collate "C"))
  into task_set_hash
  from (
    select distinct result ->> 'task_hash' as task_hash
    from jsonb_array_elements(payload -> 'results') result
  ) hashes;
  if task_set_hash is distinct from payload ->> 'task_set_hash' then return false; end if;

  expected_run_id := 'run_' || substr(aiq_private.jcs_sha256(
    case when synthetic then jsonb_build_object(
      'schema_version','aiq.run-identity.v1',
      'slot',payload -> 'schedule_slot',
      'task_set_hash',payload -> 'task_set_hash',
      'models',payload -> 'models',
      'scoring_version',payload -> 'scoring_version'
    ) else jsonb_build_object(
      'schema_version','aiq.run-identity.v3',
      'run_class','official',
      'slot',payload -> 'schedule_slot',
      'task_set_hash',payload -> 'task_set_hash',
      'corpus_commitment_sha256',provenance -> 'corpus_commitment_sha256',
      'models',payload -> 'models',
      'scoring_version',payload -> 'scoring_version'
    ) end
  ), 8);
  if payload ->> 'run_id' is distinct from expected_run_id then return false; end if;
  return true;
exception when others then return false;
end;
$_$;



--
-- Name: retire_claim_artifact_references(uuid, uuid, integer, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.retire_claim_artifact_references(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, supplied_reason text) returns integer
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  retired_count integer;
begin
  if supplied_reason not in ('completed', 'rejected', 'abandoned', 'lease_expired')
    or supplied_lease_token is null
    or supplied_attempt is null
    or supplied_attempt < 1
  then
    raise exception 'invalid claim artifact reference retirement'
      using errcode = '22023';
  end if;
  with retired as (
    update aiq_private.aiq_storage_object_references reference
    set active = false, deactivated_at = clock_timestamp()
    from aiq_private.aiq_artifact_claim_bindings binding
    where binding.inbox_id = target_inbox_id
      and reference.reference_type = 'artifact_claim_binding'
      and reference.reference_key = aiq_private.claim_artifact_reference_key(
        binding.inbox_id, binding.artifact_kind, binding.content_sha256
      )
      and reference.active
    returning binding.artifact_kind, binding.content_sha256
  ), audited as (
    insert into aiq_private.aiq_claim_artifact_reference_events (
      inbox_id, lease_token, attempt, artifact_kind, content_sha256,
      transition, reason
    )
    select target_inbox_id, supplied_lease_token, supplied_attempt,
      retired.artifact_kind, retired.content_sha256, 'retired', supplied_reason
    from retired
    on conflict do nothing
    returning 1
  )
  select count(*) into retired_count from audited;
  return retired_count;
end;
$$;


--
-- Name: retire_expired_claim_artifact_references(integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.retire_expired_claim_artifact_references(max_claims integer) returns integer
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  expired record;
  retired integer := 0;
begin
  if max_claims not between 1 and 1000 then
    raise exception 'invalid expired claim retirement bound'
      using errcode = '22023';
  end if;
  for expired in
    select inbox.inbox_id, inbox.claim_token, inbox.claim_attempts
    from aiq_private.aiq_submission_inbox inbox
    where inbox.claim_token is not null
      and inbox.claim_expires_at is not null
      and inbox.claim_expires_at <= clock_timestamp()
      and inbox.claim_ack is null
      and exists (
        select 1
        from aiq_private.aiq_artifact_claim_bindings binding
        join aiq_private.aiq_storage_object_references reference
          on reference.reference_type = 'artifact_claim_binding'
          and reference.reference_key = aiq_private.claim_artifact_reference_key(
            binding.inbox_id, binding.artifact_kind, binding.content_sha256
          )
          and reference.active
        where binding.inbox_id = inbox.inbox_id
      )
    order by inbox.claim_expires_at, inbox.inbox_id
    for update skip locked
    limit max_claims
  loop
    retired := retired + aiq_private.retire_claim_artifact_references(
      expired.inbox_id, expired.claim_token, expired.claim_attempts, 'lease_expired'
    );
  end loop;
  return retired;
end;
$$;


--
-- Name: run_evidence_is_staged(text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.run_evidence_is_staged(target_run_id text) returns boolean
    language sql stable
    SET search_path to ''
    as $$
  select exists (
    select 1
    from aiq_private.aiq_package_runs link
    where link.run_id = target_run_id
      and aiq_private.package_evidence_is_staged(link.package_sha256)
  );
$$;



--
-- Name: run_provenance_v2_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.run_provenance_v2_is_valid(candidate jsonb) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $_$
declare
  digest_key text;
begin
  if jsonb_typeof(candidate) is distinct from 'object'
    or not aiq_private.has_exact_jsonb_keys(
    candidate,
    array[
      'catalog_digest', 'codex_executable_digest',
      'corpus_commitment_sha256', 'corpus_release_id',
      'environment_digest', 'evaluator_digest', 'harness_digest',
      'network_policy_digest', 'permission_evidence_digest', 'preflight_digest',
      'prompt_digest', 'run_class', 'runner_executable_digest',
      'runtime_digest', 'schema_version', 'source_manifest_digest',
      'task_set_digest', 'tool_policy_digest'
    ]::text[]
  )
    or jsonb_typeof(candidate -> 'schema_version') is distinct from 'string'
    or candidate ->> 'schema_version' is distinct from 'aiq.run-provenance.v2'
    or jsonb_typeof(candidate -> 'run_class') is distinct from 'string'
    or candidate ->> 'run_class' not in ('official', 'calibration')
    or jsonb_typeof(candidate -> 'corpus_release_id') is distinct from 'string'
    or not coalesce(
      candidate ->> 'corpus_release_id'
        ~ '^corpus_[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$', false
    )
    or aiq_private.jsonb_wire_value_is_bounded(candidate) is distinct from true
  then
    return false;
  end if;

  foreach digest_key in array array[
    'catalog_digest', 'codex_executable_digest',
    'corpus_commitment_sha256', 'environment_digest', 'evaluator_digest',
    'harness_digest', 'network_policy_digest', 'permission_evidence_digest', 'preflight_digest',
    'prompt_digest', 'runner_executable_digest', 'runtime_digest',
    'source_manifest_digest', 'task_set_digest', 'tool_policy_digest'
  ]::text[]
  loop
    if not aiq_private.jsonb_sha256_field_is_valid(
      candidate, digest_key, true
    ) then
      return false;
    end if;
  end loop;

  return candidate ->> 'catalog_digest' is not distinct from
    'sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7';
end;
$_$;


--
-- Name: run_provenance_v2_matches_stage(jsonb, jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.run_provenance_v2_matches_stage(candidate jsonb, stage jsonb) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $$
begin
  if aiq_private.run_provenance_v2_is_valid(candidate) is distinct from true
    or jsonb_typeof(stage) is distinct from 'object'
    or jsonb_typeof(stage -> 'run_class') is distinct from 'string'
    or stage ->> 'run_class' is distinct from 'official'
    or jsonb_typeof(stage -> 'task_set_id') is distinct from 'string'
    or jsonb_typeof(stage -> 'task_set_version') is distinct from 'string'
    or not aiq_private.jsonb_sha256_field_is_valid(stage, 'task_set_hash', true)
    or not aiq_private.jsonb_sha256_field_is_valid(
      stage, 'capability_validation_digest', true
    )
    or not aiq_private.jsonb_sha256_field_is_valid(
      stage, 'prompt_set_digest', true
    )
    or jsonb_typeof(stage -> 'signer') is distinct from 'object'
    or jsonb_typeof(stage -> 'signer' -> 'node_id') is distinct from 'string'
    or candidate ->> 'run_class' is distinct from stage ->> 'run_class'
    or candidate ->> 'task_set_digest' is distinct from
      'sha256:f6fc21fa2deb3788c186437c45f8e1c8d5d1e366d32bc81e3b5f847e9844cf05'
    or candidate ->> 'evaluator_digest' is distinct from
      'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c'
    or candidate ->> 'task_set_digest' is distinct from stage ->> 'task_set_hash'
    or candidate ->> 'preflight_digest' is distinct from
      stage ->> 'capability_validation_digest'
    or candidate ->> 'prompt_digest' is distinct from stage ->> 'prompt_set_digest'
    or not exists (
      select 1
      from aiq_private.aiq_task_sets task_set
      where task_set.task_set_id = stage ->> 'task_set_id'
        and task_set.task_set_version = stage ->> 'task_set_version'
        and task_set.catalog_sha256 =
          replace(candidate ->> 'catalog_digest', 'sha256:', '')
        and task_set.hidden_payload_commitment =
          replace(candidate ->> 'corpus_commitment_sha256', 'sha256:', '')
        and task_set.metadata ->> 'corpus_release_id' is not distinct from
          candidate ->> 'corpus_release_id'
        and task_set.metadata ->> 'corpus_commitment_sha256' is not distinct from
          candidate ->> 'corpus_commitment_sha256'
    )
  then
    return false;
  end if;
  return true;
end;
$$;


--
-- Name: safe_unsigned_integer_jsonb_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.safe_unsigned_integer_jsonb_is_valid(candidate jsonb) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $$
declare
  numeric_candidate numeric;
begin
  if jsonb_typeof(candidate) is distinct from 'number' then
    return false;
  end if;
  numeric_candidate := (candidate #>> '{}')::numeric;
  return numeric_candidate between 0 and 9007199254740991
    and numeric_candidate = trunc(numeric_candidate);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;


--
-- Name: score_tier_is_valid(aiq_private.score_status, integer, integer, integer, integer, integer, integer); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.score_tier_is_valid(claimed_status aiq_private.score_status, valid_count integer, invalid_count integer, missing_count integer, not_applicable_count integer, covered_domains integer, minimum_domain_count integer) returns boolean
    language sql immutable
    SET search_path to ''
    as $$
  select case claimed_status
    when 'official' then
      valid_count = 72
      and covered_domains = 10
      and invalid_count = 0
      and missing_count = 0
      and not_applicable_count = 0
    when 'synthetic_complete' then
      valid_count = 72
      and covered_domains = 10
      and invalid_count = 0
      and missing_count = 0
      and not_applicable_count = 0
    when 'provisional' then
      valid_count between 60 and 71
      and covered_domains = 10
      and minimum_domain_count >= 4
      and not (not_applicable_count = 72)
    when 'coverage_only' then
      not (not_applicable_count = 72)
      and (
        valid_count < 60
        or covered_domains < 10
        or minimum_domain_count < 4
      )
    when 'not_applicable' then
      valid_count = 0
      and invalid_count = 0
      and missing_count = 0
      and not_applicable_count = 72
      and covered_domains = 0
    else false
  end;
$$;


--
-- Name: stage_verifier_result_core(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.stage_verifier_result_core(stage jsonb) returns text
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  inbox aiq_private.aiq_submission_inbox%rowtype;
  payload jsonb;
  batch_id text;
  package_id text;
  normalization text;
  source_node text;
  is_synthetic boolean;
  stage_provenance jsonb;
  child jsonb;
  score jsonb;
  normalized_results jsonb;
  model aiq_private.aiq_model_configs%rowtype;
  child_id text;
  valid_count integer;
  invalid_count integer;
  missing_count integer := 0;
  na_count integer;
  domain_count integer;
  minimum_domain_count integer;
  fixed_score numeric;
  supplied_fixed numeric;
  computed_completion_low numeric;
  computed_completion_high numeric;
  binary_sample_count integer;
  binary_success_count integer;
  computed_domains jsonb;
  supplied_domains jsonb;
  efficiency_entry jsonb;
  pricing jsonb;
  computed_pricing_digest text;
  signed_results_by_id jsonb;
  result_efficiency_by_id jsonb;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  if jsonb_typeof(stage) is distinct from 'object' then
    raise exception 'invalid aiq.normalized-batch.v3 envelope' using errcode = '22023';
  end if;
  if octet_length(stage::text) > 4 * 1024 * 1024
    or not aiq_private.has_exact_jsonb_keys(
      stage,
      array[
        'benchmark_version', 'capability_validation_digest', 'content_hash',
        'efficiency', 'execution_concurrency', 'finished_unix_ms',
        'matrix_batch_id', 'normalization_digest',
        'package_sha256', 'pricing', 'prompt_set_digest', 'provenance', 'region',
        'result_efficiency', 'run_class', 'runner_commit', 'runs', 'scheduled_unix_ms',
        'schema_version', 'scoring_version', 'signer', 'started_unix_ms',
        'synthetic', 'task_set_hash', 'task_set_id', 'task_set_version'
      ]::text[]
    )
    or stage ->> 'schema_version' is distinct from 'aiq.normalized-batch.v3'
    or stage ->> 'scoring_version' is distinct from '1.0.5'
    or jsonb_typeof(stage -> 'benchmark_version') is distinct from 'string'
    or jsonb_typeof(stage -> 'content_hash') is distinct from 'string'
    or jsonb_typeof(stage -> 'matrix_batch_id') is distinct from 'string'
    or jsonb_typeof(stage -> 'normalization_digest') is distinct from 'string'
    or jsonb_typeof(stage -> 'package_sha256') is distinct from 'string'
    or jsonb_typeof(stage -> 'prompt_set_digest') is distinct from 'string'
    or jsonb_typeof(stage -> 'region') is distinct from 'string'
    or jsonb_typeof(stage -> 'runner_commit') is distinct from 'string'
    or jsonb_typeof(stage -> 'schema_version') is distinct from 'string'
    or jsonb_typeof(stage -> 'scoring_version') is distinct from 'string'
    or jsonb_typeof(stage -> 'task_set_hash') is distinct from 'string'
    or jsonb_typeof(stage -> 'task_set_id') is distinct from 'string'
    or jsonb_typeof(stage -> 'task_set_version') is distinct from 'string'
    or jsonb_typeof(stage -> 'signer') is distinct from 'object'
    or not aiq_private.has_exact_jsonb_keys(
      stage -> 'signer', array['node_id', 'public_key']::text[]
    )
    or jsonb_typeof(stage -> 'signer' -> 'node_id') is distinct from 'string'
    or jsonb_typeof(stage -> 'signer' -> 'public_key') is distinct from 'string'
    or jsonb_typeof(stage -> 'runs') is distinct from 'array'
    or jsonb_array_length(stage -> 'runs') is distinct from 17
    or not aiq_private.dto_uint_is_valid(stage -> 'execution_concurrency',32)
    or (stage->>'execution_concurrency')::integer not between 1 and 32
    or jsonb_typeof(stage->'result_efficiency') is distinct from 'array'
    or jsonb_array_length(stage->'result_efficiency') is distinct from 1224
    or jsonb_typeof(stage->'efficiency') is distinct from 'array'
    or jsonb_array_length(stage->'efficiency') is distinct from 17
    or aiq_private.efficiency_pricing_v1_is_valid(stage->'pricing') is not true
    or exists(select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
      where aiq_private.result_efficiency_v1_is_valid(evidence) is not true)
    or exists(select 1 from jsonb_array_elements(stage->'efficiency') aggregate
      where aiq_private.efficiency_aggregate_v1_is_valid(aggregate) is not true)
    or exists(select 1 from jsonb_array_elements(stage->'efficiency') aggregate
      where aiq_private.efficiency_aggregate_matches_results(
        aggregate,stage->'result_efficiency'
      ) is not true)
    or (select count(distinct evidence->>'source_result_id')
      from jsonb_array_elements(stage->'result_efficiency') evidence)<>1224
    or (select count(distinct (evidence->'model',evidence->>'task_id'))
      from jsonb_array_elements(stage->'result_efficiency') evidence)<>1224
    or (select count(distinct aggregate->'model')
      from jsonb_array_elements(stage->'efficiency') aggregate)<>17
    or aiq_private.official_model_matrix_is_exact((
      select jsonb_agg(aggregate.value->'model' order by aggregate.ordinality)
      from jsonb_array_elements(stage->'efficiency') with ordinality aggregate(value,ordinality)
    )) is not true
    or not coalesce(stage ->> 'matrix_batch_id' ~ '^run_[0-9a-f]{64}$', false)
    or not coalesce(stage ->> 'normalization_digest' ~ '^sha256:[0-9a-f]{64}$', false)
    or not coalesce(stage ->> 'package_sha256' ~ '^[0-9a-f]{64}$', false)
    or not coalesce(stage ->> 'content_hash' ~ '^sha256:[0-9a-f]{64}$', false)
    or not coalesce(stage ->> 'task_set_hash' ~ '^sha256:[0-9a-f]{64}$', false)
    or not coalesce(stage ->> 'prompt_set_digest' ~ '^sha256:[0-9a-f]{64}$', false)
    or not coalesce(stage ->> 'runner_commit' ~ '^[0-9a-f]{7,40}$', false)
    or octet_length(stage ->> 'region') not between 1 and 64
    or octet_length(stage ->> 'task_set_id') not between 1 and 128
    or not coalesce(
      stage ->> 'task_set_version'
        ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$',
      false
    )
    or not coalesce(stage -> 'signer' ->> 'node_id' ~ '^node_[0-9a-f]{64}$', false)
    or not coalesce(stage -> 'signer' ->> 'public_key' ~ '^[0-9a-f]{64}$', false)
    or (
      stage -> 'capability_validation_digest' is distinct from 'null'::jsonb
      and not coalesce(
        stage ->> 'capability_validation_digest' ~ '^sha256:[0-9a-f]{64}$',
        false
      )
    )
    or jsonb_typeof(stage -> 'synthetic') is distinct from 'boolean'
    or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
      stage -> 'scheduled_unix_ms'
    )
    or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
      stage -> 'started_unix_ms'
    )
    or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
      stage -> 'finished_unix_ms'
    )
    or (stage ->> 'started_unix_ms')::numeric
      < (stage ->> 'scheduled_unix_ms')::numeric
    or (stage ->> 'finished_unix_ms')::numeric
      < (stage ->> 'started_unix_ms')::numeric
  then
    raise exception 'invalid aiq.normalized-batch.v3 envelope' using errcode = '22023';
  end if;

  batch_id := stage ->> 'matrix_batch_id';
  package_id := stage ->> 'package_sha256';
  normalization := stage ->> 'normalization_digest';
  source_node := stage -> 'signer' ->> 'node_id';
  is_synthetic := (stage ->> 'synthetic')::boolean;
  stage_provenance := nullif(stage -> 'provenance', 'null'::jsonb);
  select * into inbox
  from aiq_private.aiq_submission_inbox queued
  where queued.idempotency_key = batch_id
    and queued.package_sha256 = package_id
  for update;
  if not found then
    raise exception 'immutable submission inbox record not found' using errcode = 'P0002';
  end if;
  -- An exact retry is a no-op. This lets the verification gateway resume after
  -- a later RPC failed without accepting a different normalized batch.
  if inbox.state = 'processed'
    and inbox.retention_state = 'active'
    and inbox.verification_status in ('unverified', 'verified')
    and (
      select count(*)
      from aiq_private.aiq_matrix_batches existing_batch
      join aiq_private.aiq_result_packages existing_package
        on existing_package.package_sha256 = existing_batch.package_sha256
      where existing_batch.matrix_batch_id = batch_id
        and existing_batch.package_sha256 = package_id
        and existing_batch.content_hash = stage ->> 'content_hash'
        and existing_batch.normalization_digest = normalization
        and existing_batch.source_node_id = source_node
        and existing_batch.task_set_id = stage ->> 'task_set_id'
        and existing_batch.task_set_version = stage ->> 'task_set_version'
        and existing_batch.scoring_version = '1.0.5'
        and existing_batch.synthetic = is_synthetic
        and existing_batch.task_set_hash = stage ->> 'task_set_hash'
        and existing_batch.capability_validation_digest
          is not distinct from nullif(stage ->> 'capability_validation_digest', '')
        and existing_batch.benchmark_version = stage ->> 'benchmark_version'
        and existing_batch.prompt_set_digest = stage ->> 'prompt_set_digest'
        and existing_batch.source_scoring_version = stage ->> 'scoring_version'
        and existing_batch.runner_commit = stage ->> 'runner_commit'
        and existing_batch.region = stage ->> 'region'
        and existing_batch.execution_concurrency =
          (stage ->> 'execution_concurrency')::integer
        and existing_batch.scheduled_unix_ms = (stage ->> 'scheduled_unix_ms')::bigint
        and existing_batch.started_unix_ms = (stage ->> 'started_unix_ms')::bigint
        and existing_batch.finished_unix_ms = (stage ->> 'finished_unix_ms')::bigint
        and existing_batch.run_provenance is not distinct from stage_provenance
        and existing_batch.normalized_stage is not distinct from stage
        and existing_package.idempotency_key = batch_id
        and existing_package.run_id = batch_id
        and existing_package.node_id = source_node
        and existing_package.content_hash = stage ->> 'content_hash'
        and existing_package.envelope = inbox.envelope
        and existing_package.matrix_batch_id = batch_id
        and existing_package.normalization_digest = normalization
        and existing_package.run_provenance is not distinct from stage_provenance
    ) = 1
    and (
      select count(*) from aiq_private.aiq_package_runs link
      where link.package_sha256 = package_id
    ) = 17
    and (
      select count(*)
      from aiq_private.aiq_task_results result
      join aiq_private.aiq_package_runs link on link.run_id = result.run_id
      where link.package_sha256 = package_id
    ) = 1224
    and (
      select count(*) from aiq_private.efficiency_official_models efficiency
      join aiq_private.aiq_package_runs link using(run_id)
      where link.package_sha256=package_id
    ) = 17
    and (
      select count(*)
      from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = package_id
        and audit.event_type = 'staged'
    ) = 1
  then
    return batch_id;
  end if;
  if inbox.state <> 'queued'
    or inbox.verification_status <> 'unverified'
    or inbox.retention_state <> 'active'
    or exists (
      select 1 from aiq_private.aiq_submission_conflicts conflict
      where conflict.inbox_id = inbox.inbox_id
    )
  then
    raise exception 'submission is not eligible for staging' using errcode = '55000';
  end if;
  payload := inbox.envelope -> 'payload';
  select jsonb_object_agg(result ->> 'result_id', result)
  into signed_results_by_id
  from jsonb_array_elements(payload -> 'results') result;
  select jsonb_object_agg(evidence ->> 'source_result_id', evidence)
  into result_efficiency_by_id
  from jsonb_array_elements(stage -> 'result_efficiency') evidence;

  if inbox.envelope ->> 'schema_version' is distinct from 'aiq.result-package.v3'
    or inbox.envelope ->> 'payload_type' is distinct from 'aiq.run.v3'
    or inbox.envelope ->> 'idempotency_key' is distinct from batch_id
    or inbox.envelope ->> 'content_hash' is distinct from stage ->> 'content_hash'
    or inbox.request_context ->> 'package_sha256' is distinct from package_id
    or payload ->> 'run_id' is distinct from batch_id
    or payload ->> 'task_set_hash' is distinct from stage ->> 'task_set_hash'
    or payload ->> 'scoring_version' is distinct from stage ->> 'scoring_version'
    or payload -> 'synthetic' is distinct from stage -> 'synthetic'
    or payload -> 'provenance' is distinct from stage -> 'provenance'
    or payload -> 'execution_concurrency' is distinct from stage -> 'execution_concurrency'
    or inbox.envelope -> 'signer' is distinct from stage -> 'signer'
    or jsonb_array_length(payload -> 'models') is distinct from 17
    or jsonb_array_length(payload -> 'results') is distinct from 1224
    or stage ->> 'benchmark_version' is distinct from
      (stage ->> 'task_set_id') || '@' || (stage ->> 'task_set_version')
    or (stage ->> 'started_unix_ms')::bigint
      is distinct from (payload ->> 'started_unix_ms')::bigint
    or (stage ->> 'finished_unix_ms')::bigint
      is distinct from (payload ->> 'finished_unix_ms')::bigint
    or exists(select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
      where signed_results_by_id -> (evidence->>'source_result_id') is null
        or signed_results_by_id #>> array[evidence->>'source_result_id','task_id']
          is distinct from evidence->>'task_id'
        or signed_results_by_id #> array[evidence->>'source_result_id','model']
          is distinct from evidence->'model')
    or exists(
      select 1
      from jsonb_array_elements(stage->'result_efficiency') evidence
      where signed_results_by_id #>> array[
        evidence->>'source_result_id','failure','kind'
      ] in (
        'capability_unavailable','capability_validation_failed','workspace_unavailable'
      ) and (
        evidence->'observed_wall_ms'<>'null'::jsonb
        or evidence->'provider_tokens'<>'{}'::jsonb
        or evidence->>'cost_status'<>'unavailable_missing_usage'
      )
    )
    or (
      is_synthetic
      and (
        stage -> 'capability_validation_digest' is distinct from 'null'::jsonb
        or payload -> 'capability_validation' is distinct from 'null'::jsonb
      )
    )
    or (
      not is_synthetic
      and (
        stage -> 'capability_validation_digest' = 'null'::jsonb
        or jsonb_typeof(payload -> 'capability_validation') is distinct from 'object'
        or not aiq_private.has_exact_jsonb_keys(
          payload -> 'capability_validation',
          array[
            'authentication_probe', 'cli_probe', 'manifest_issues', 'models',
            'node_id', 'schema_version'
          ]::text[]
        )
        or payload -> 'capability_validation' ->> 'schema_version'
          is distinct from 'aiq.capability-validation.v2'
        or payload -> 'capability_validation' ->> 'node_id'
          is distinct from source_node
        or jsonb_typeof(payload -> 'capability_validation' -> 'manifest_issues')
          is distinct from 'array'
        or jsonb_array_length(
          payload -> 'capability_validation' -> 'manifest_issues'
        ) is distinct from 0
        or payload -> 'capability_validation' -> 'cli_probe' ->> 'status'
          is distinct from 'available'
        or jsonb_typeof(
          payload -> 'capability_validation' -> 'cli_probe' -> 'version'
        ) is distinct from 'string'
        or payload -> 'capability_validation' -> 'authentication_probe' ->> 'status'
          is distinct from 'available'
        or payload -> 'capability_validation' -> 'authentication_probe' ->> 'mode'
          is distinct from 'chatgpt_subscription'
        or jsonb_typeof(payload -> 'capability_validation' -> 'models')
          is distinct from 'array'
        or jsonb_array_length(payload -> 'capability_validation' -> 'models')
          is distinct from 17
      )
    )
  then
    raise exception 'normalized batch identity differs from immutable signed payload'
      using errcode = '22023';
  end if;

  pricing := stage->'pricing';
  computed_pricing_digest := aiq_private.jcs_sha256(pricing);
  insert into aiq_private.efficiency_pricing_methods(
    pricing_digest,method,version,as_of,source,currency,processing_tier,
    rates,formula,limitations,pricing_record
  ) values(
    computed_pricing_digest,pricing->>'method',pricing->>'version',(pricing->>'as_of')::date,
    pricing->>'source',pricing->>'currency',pricing->>'processing_tier',pricing->'rates',
    pricing->>'formula',array[pricing->>'limitation'],pricing
  ) on conflict on constraint efficiency_pricing_methods_pkey do nothing;
  if not exists(select 1 from aiq_private.efficiency_pricing_methods method
    where method.pricing_digest=computed_pricing_digest and method.pricing_record=pricing)
  then raise exception 'conflicting Official pricing evidence' using errcode='23505'; end if;

  if not exists (
    select 1 from aiq_private.aiq_nodes node
    where node.node_id = source_node
      and node.public_key = stage -> 'signer' ->> 'public_key'
      and node.synthetic = is_synthetic
      and node.status <> 'revoked'
  )
    or not exists (
      select 1 from aiq_private.aiq_task_sets task_set
      where task_set.task_set_id = stage ->> 'task_set_id'
        and task_set.task_set_version = stage ->> 'task_set_version'
        and task_set.task_count = 72 and task_set.domain_count = 10
        and (
          (
            aiq_private.synthetic_commitment_exception_allowed(
              is_synthetic,
              coalesce((task_set.metadata ->> 'synthetic')::boolean, false)
            )
          )
          or (
            not is_synthetic
            and not coalesce((task_set.metadata ->> 'synthetic')::boolean, true)
            and stage ->> 'task_set_hash' = (
              select aiq_private.jcs_sha256(
                jsonb_agg(task_hash order by task_hash collate "C")
              )
              from (
                select 'sha256:' || catalog.fixture_commitment as task_hash
                from aiq_private.aiq_task_catalog catalog
                where catalog.task_set_id = task_set.task_set_id
                  and catalog.task_set_version = task_set.task_set_version
                  and catalog.fixture_commitment is not null
              ) catalog_hashes
            )
          )
        )
    )
  then
    raise exception 'normalized source node or task-set commitment is unknown'
      using errcode = '22023';
  end if;

  if not aiq_private.task_catalog_is_exact(
    stage ->> 'task_set_id',
    stage ->> 'task_set_version'
  )
  then
    raise exception 'target task catalog is not the exact 72-task version'
      using errcode = '22023';
  end if;

  if not is_synthetic then
    insert into aiq_private.aiq_node_capability_snapshots (
      capability_sha256, node_id, schema_version, runner_version,
      runner_sha256, harness_sha256, environment, model_capabilities,
      validation_status, validated_at, validation_report
    ) values (
      replace(stage ->> 'capability_validation_digest', 'sha256:', ''),
      source_node,
      payload -> 'capability_validation' ->> 'schema_version',
      payload -> 'capability_validation' -> 'cli_probe' ->> 'version',
      encode(
        extensions.digest(
          convert_to(stage ->> 'runner_commit', 'utf8'),
          'sha256'
        ),
        'hex'
      ),
      replace(stage ->> 'task_set_hash', 'sha256:', ''),
      jsonb_build_object(
        'authentication_mode',
          payload -> 'capability_validation' -> 'authentication_probe' ->> 'mode',
        'region', stage ->> 'region',
        'runner_commit', stage ->> 'runner_commit',
        'source', 'signed_capability_validation'
      ),
      payload -> 'capability_validation' -> 'models',
      'valid',
      to_timestamp((stage ->> 'started_unix_ms')::double precision / 1000),
      payload -> 'capability_validation'
    )
    on conflict (capability_sha256) do nothing;

    if not exists (
      select 1
      from aiq_private.aiq_node_capability_snapshots snapshot
      where snapshot.capability_sha256 =
          replace(stage ->> 'capability_validation_digest', 'sha256:', '')
        and snapshot.node_id = source_node
        and snapshot.validation_status = 'valid'
        and snapshot.validation_report = payload -> 'capability_validation'
    )
    then
      raise exception 'capability commitment conflicts with stored verifier evidence'
        using errcode = '22023';
    end if;
  end if;

  if (
    select count(distinct value ->> 'model_config_id')
    from jsonb_array_elements(stage -> 'runs')
  ) <> 17
    or exists (
      select 1
      from jsonb_array_elements(stage -> 'runs') with ordinality run(value, ordinal)
      full join aiq_private.aiq_model_configs expected
        on expected.matrix_order = run.ordinal and expected.expected_in_matrix
      where expected.model_config_id is null
         or not aiq_private.has_exact_jsonb_keys(
           run.value,
           array[
             'matrix_batch_id', 'model', 'model_config_id', 'results',
             'run_id', 'schema_version', 'score'
           ]::text[]
         )
         or not aiq_private.has_exact_jsonb_keys(
           run.value -> 'model',
           array['family', 'reasoning_effort']::text[]
         )
         or run.value ->> 'schema_version'
           is distinct from 'aiq.normalized-model-run.v1'
         or run.value ->> 'matrix_batch_id' is distinct from batch_id
         or run.value ->> 'model_config_id' is distinct from expected.model_config_id
         or run.value -> 'model' ->> 'family' is distinct from expected.model_family
         or run.value -> 'model' ->> 'reasoning_effort'
           is distinct from expected.reasoning_effort
         or run.value ->> 'run_id' is distinct from 'run_' || encode(
           extensions.digest(
             convert_to(
               'aiq.model-run-identity.v1' || chr(10)
               || batch_id || chr(10)
               || expected.model_config_id,
               'utf8'
             ),
             'sha256'
           ),
           'hex'
         )
         or jsonb_array_length(run.value -> 'results') is distinct from 72
    )
    or exists (
      select 1
      from jsonb_array_elements(stage -> 'runs') run
      where (
        select count(distinct (
          result.value ->> 'task_id',
          result.value ->> 'task_version'
        ))
        from jsonb_array_elements(run.value -> 'results') result
      ) <> 72
    )
    or exists (
      select 1
      from jsonb_array_elements(stage -> 'runs') run
      cross join aiq_private.aiq_task_catalog task
      where task.task_set_id = stage ->> 'task_set_id'
        and task.task_set_version = stage ->> 'task_set_version'
        and not exists (
          select 1
          from jsonb_array_elements(run.value -> 'results') result
          where result.value ->> 'task_id' = task.task_id
            and result.value ->> 'task_version' = task.task_version
        )
    )
  then
    raise exception 'normalized child runs do not match the exact ordered model matrix'
      using errcode = '22023';
  end if;

  -- Every normalized field that affects identity, outcome, score, or provenance
  -- must equal its signed source or the frozen catalog derivation.
  if (
    select count(distinct normalized ->> 'source_result_id')
    from jsonb_array_elements(stage -> 'runs') run,
         jsonb_array_elements(run -> 'results') normalized
  ) <> 1224
    or exists (
      select 1
      from jsonb_array_elements(stage -> 'runs') run,
           jsonb_array_elements(run -> 'results') normalized
      left join lateral (
        select signed_results_by_id -> (normalized ->> 'source_result_id') as value
      ) signed on true
      left join aiq_private.aiq_task_catalog task
        on task.task_set_id = stage ->> 'task_set_id'
       and task.task_set_version = stage ->> 'task_set_version'
       and task.task_id = normalized ->> 'task_id'
       and task.task_version = normalized ->> 'task_version'
      where signed.value is null
         or not aiq_private.has_exact_jsonb_keys(
           normalized,
           array[
             'artifacts', 'domain', 'evaluator_stdout_sha256', 'failure',
             'failure_responsibility', 'latency', 'matrix_batch_id', 'model',
             'outcome', 'provenance', 'response', 'response_sha256',
             'run_id', 'schema_version',
             'scorer_version', 'source_evaluation', 'source_result_id',
             'source_status', 'task_hash', 'task_id', 'task_score',
             'task_version', 'tool_usage'
           ]::text[]
         )
         or normalized ->> 'schema_version'
           is distinct from 'aiq.normalized-result.v1'
         or normalized ->> 'matrix_batch_id' is distinct from batch_id
         or normalized ->> 'run_id' is distinct from run ->> 'run_id'
         or normalized -> 'model' is distinct from signed.value -> 'model'
         or normalized ->> 'task_id' is distinct from signed.value ->> 'task_id'
         or normalized ->> 'task_version'
           is distinct from signed.value ->> 'task_version'
         or normalized ->> 'task_hash' is distinct from signed.value ->> 'task_hash'
         or normalized ->> 'source_status'
           is distinct from signed.value ->> 'status'
         or normalized ->> 'source_evaluation'
           is distinct from signed.value ->> 'evaluation'
         or normalized -> 'task_score' is distinct from signed.value -> 'task_score'
         or normalized -> 'failure' is distinct from signed.value -> 'failure'
         or normalized -> 'response' is distinct from signed.value -> 'response'
         or normalized -> 'response_sha256'
              is distinct from signed.value -> 'response_sha256'
         or normalized -> 'evaluator_stdout_sha256'
              is distinct from signed.value -> 'evaluator_stdout_sha256'
         or normalized -> 'artifacts' is distinct from signed.value -> 'artifacts'
         or normalized -> 'latency' is distinct from signed.value -> 'latency'
         or normalized -> 'tool_usage' is distinct from signed.value -> 'tool_usage'
         or normalized -> 'provenance' is distinct from signed.value -> 'provenance'
         or task.task_id is null
         or normalized ->> 'domain' is distinct from task.domain
         or normalized ->> 'scorer_version' is distinct from task.scorer_version
         or (
           not is_synthetic
           and normalized ->> 'task_hash'
             is distinct from 'sha256:' || task.fixture_commitment
         )
         or normalized ->> 'outcome' is distinct from
           aiq_private.normalized_outcome_from_source(
             signed.value, run -> 'score' ->> 'tier'
           )
         or normalized ->> 'failure_responsibility' is distinct from
           aiq_private.normalized_responsibility_from_source(
             signed.value, run -> 'score' ->> 'tier'
           )
    )
  then
    raise exception 'normalized result differs from signed source or frozen catalog'
      using errcode = '22023';
  end if;

  insert into aiq_private.aiq_matrix_batches (
    matrix_batch_id, package_sha256, content_hash, normalization_digest,
    source_node_id, task_set_id, task_set_version, scoring_version, synthetic,
    task_set_hash, capability_validation_digest, benchmark_version,
    prompt_set_digest, source_scoring_version, runner_commit, region,
    execution_concurrency,
    scheduled_unix_ms, started_unix_ms, finished_unix_ms, run_provenance,
    normalized_stage
  ) values (
    batch_id, package_id, stage ->> 'content_hash', normalization,
    source_node, stage ->> 'task_set_id', stage ->> 'task_set_version',
    '1.0.5', is_synthetic, stage ->> 'task_set_hash',
    nullif(stage ->> 'capability_validation_digest', ''),
    stage ->> 'benchmark_version', stage ->> 'prompt_set_digest',
    stage ->> 'scoring_version', stage ->> 'runner_commit', stage ->> 'region',
    (stage ->> 'execution_concurrency')::integer,
    (stage ->> 'scheduled_unix_ms')::bigint,
    (stage ->> 'started_unix_ms')::bigint,
    (stage ->> 'finished_unix_ms')::bigint,
    stage_provenance,
    stage
  );
  insert into aiq_private.aiq_result_packages (
    package_sha256, schema_version, idempotency_key, run_id, node_id,
    content_hash, envelope, signature, signature_verified,
    verifier_attestation, trust_tier, received_at, provenance,
    matrix_batch_id, normalization_digest, run_provenance
  ) values (
    package_id, 'aiq.result-package.v3', batch_id, batch_id, source_node,
    stage ->> 'content_hash', inbox.envelope, inbox.envelope ->> 'signature',
    false, null, 'unverified', inbox.received_at,
    jsonb_build_object('schema_version', 'aiq.package-binding.v3'),
    batch_id, normalization, stage_provenance
  );

  for model in
    select * from aiq_private.aiq_model_configs
    where expected_in_matrix order by matrix_order
  loop
    select value into child
    from jsonb_array_elements(stage -> 'runs')
    where value ->> 'model_config_id' = model.model_config_id;
    score := child -> 'score';
    normalized_results := child -> 'results';
    child_id := child ->> 'run_id';
    if jsonb_typeof(score) is distinct from 'object'
      or not aiq_private.has_exact_jsonb_keys(
      score,
      array[
        'binary_micro_diagnostic', 'completion_bounds',
        'conditional_observed_aiq', 'coverage', 'difficulty_coverage',
        'domains', 'duplicate_results', 'model', 'official_aiq',
        'ranking_eligible', 'rule', 'schema_version', 'scoring_version',
        'task_resampling_sensitivity_interval', 'tier'
      ]::text[]
    )
      or score ->> 'schema_version' is distinct from 'aiq.score-report.v1'
      or score ->> 'scoring_version' is distinct from stage ->> 'scoring_version'
      or score -> 'model' is distinct from child -> 'model'
      or jsonb_typeof(score -> 'tier') is distinct from 'string'
      or jsonb_typeof(score -> 'rule') is distinct from 'string'
      or score ->> 'rule' is distinct from
        'AIQ v1: 100 × the equal-weight mean of 10 domain scores; each domain is the equal-weight mean of valid task scores. Coverage and difficulty do not alter weights. Official requires non-synthetic 72/72 coverage and 10/10 domains. A complete synthetic fixture is descriptive, has no Official AIQ, and is not ranking eligible. Provisional requires at least 60/72 and at least four valid tasks per domain, is conditional, and is not ranking eligible. Lower coverage publishes no estimate. The task-resampling interval uses finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction calibrated for this fixed benchmark fixture. It is a fixed-fixture calibrated sensitivity interval, not a universal confidence interval for model capability.'
      or jsonb_typeof(score -> 'ranking_eligible') is distinct from 'boolean'
      or (
        jsonb_typeof(score -> 'official_aiq') is distinct from 'null'
        and jsonb_typeof(score -> 'official_aiq') is distinct from 'number'
      )
      or (
        jsonb_typeof(score -> 'conditional_observed_aiq') is distinct from 'null'
        and jsonb_typeof(score -> 'conditional_observed_aiq') is distinct from 'number'
      )
      or (
        jsonb_typeof(score -> 'completion_bounds') is distinct from 'null'
        and jsonb_typeof(score -> 'completion_bounds') is distinct from 'object'
      )
      or (
        jsonb_typeof(score -> 'task_resampling_sensitivity_interval')
          is distinct from 'null'
        and jsonb_typeof(score -> 'task_resampling_sensitivity_interval')
          is distinct from 'object'
      )
      or jsonb_typeof(score -> 'binary_micro_diagnostic') is distinct from 'object'
      or jsonb_typeof(score -> 'coverage') is distinct from 'object'
      or not aiq_private.has_exact_jsonb_keys(
        score -> 'coverage',
        array[
          'covered_domains', 'expected_domains', 'expected_tasks',
          'invalid_tasks', 'missing_tasks', 'not_applicable_tasks',
          'valid_tasks'
        ]::text[]
      )
      or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
        score -> 'coverage' -> 'expected_tasks'
      )
      or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
        score -> 'coverage' -> 'valid_tasks'
      )
      or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
        score -> 'coverage' -> 'invalid_tasks'
      )
      or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
        score -> 'coverage' -> 'missing_tasks'
      )
      or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
        score -> 'coverage' -> 'not_applicable_tasks'
      )
      or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
        score -> 'coverage' -> 'expected_domains'
      )
      or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
        score -> 'coverage' -> 'covered_domains'
      )
      or jsonb_typeof(score -> 'domains') is distinct from 'array'
      or jsonb_array_length(score -> 'domains') is distinct from 10
      or jsonb_typeof(score -> 'difficulty_coverage') is distinct from 'object'
      or not aiq_private.has_exact_jsonb_keys(
        score -> 'difficulty_coverage',
        array['easy', 'hard', 'medium']::text[]
      )
      or not aiq_private.safe_unsigned_integer_jsonb_is_valid(
        score -> 'duplicate_results'
      )
      or (score ->> 'duplicate_results')::integer is distinct from 0
    then
      raise exception 'normalized score report is malformed for %', model.model_config_id
        using errcode = '22023';
    end if;

    select
      count(*) filter (where (value -> 'task_score') <> 'null'::jsonb)::integer,
      count(*) filter (where value ->> 'outcome' = 'invalid')::integer,
      count(*) filter (where value ->> 'outcome' = 'not_applicable')::integer,
      count(distinct value ->> 'domain')
        filter (where value -> 'task_score' <> 'null'::jsonb)::integer
    into valid_count, invalid_count, na_count, domain_count
    from jsonb_array_elements(normalized_results);
    select
      summary.minimum_domain_count,
      summary.fixed_score,
      summary.domain_scores
    into minimum_domain_count, fixed_score, computed_domains
    from aiq_private.normalized_domain_score_summary(
      normalized_results,
      stage ->> 'task_set_id',
      stage ->> 'task_set_version'
    ) summary;
    select
      round(10 * sum(domain_score_sum / expected_in_domain), 6),
      round(
        10 * sum(
          (domain_score_sum + expected_in_domain - valid_in_domain)
            / expected_in_domain
        ),
        6
      )
    into computed_completion_low, computed_completion_high
    from (
      select
        task.domain,
        count(*)::numeric as expected_in_domain,
        count(result.value) filter (
          where result.value is not null
            and result.value -> 'task_score' is distinct from 'null'::jsonb
        )::numeric as valid_in_domain,
        coalesce(
          sum((result.value ->> 'task_score')::numeric) filter (
            where result.value is not null
              and result.value -> 'task_score' is distinct from 'null'::jsonb
          ),
          0
        ) as domain_score_sum
      from aiq_private.aiq_task_catalog task
      left join jsonb_array_elements(normalized_results) result(value)
        on result.value ->> 'task_id' = task.task_id
       and result.value ->> 'task_version' = task.task_version
      where task.task_set_id = stage ->> 'task_set_id'
        and task.task_set_version = stage ->> 'task_set_version'
      group by task.domain
    ) completion_domains;
    select
      count(*) filter (
        where value -> 'task_score' in ('0'::jsonb, '1'::jsonb)
      )::integer,
      count(*) filter (where value -> 'task_score' = '1'::jsonb)::integer
    into binary_sample_count, binary_success_count
    from jsonb_array_elements(normalized_results);
    select coalesce(
      jsonb_object_agg(
        value ->> 'domain',
        case when value -> 'score' = 'null'::jsonb then 'null'::jsonb
          else to_jsonb(round((value ->> 'score')::numeric, 5)) end
      ),
      '{}'::jsonb
    ) into supplied_domains
    from jsonb_array_elements(score -> 'domains');
    supplied_fixed := coalesce(
      (score ->> 'official_aiq')::numeric,
      (score ->> 'conditional_observed_aiq')::numeric
    );

    if (score -> 'coverage' ->> 'expected_tasks')::integer is distinct from 72
      or (score -> 'coverage' ->> 'valid_tasks')::integer
        is distinct from valid_count
      or (score -> 'coverage' ->> 'invalid_tasks')::integer
        is distinct from invalid_count
      or (score -> 'coverage' ->> 'missing_tasks')::integer
        is distinct from missing_count
      or (score -> 'coverage' ->> 'not_applicable_tasks')::integer
        is distinct from na_count
      or (score -> 'coverage' ->> 'expected_domains')::integer
        is distinct from 10
      or (score -> 'coverage' ->> 'covered_domains')::integer
        is distinct from domain_count
      or supplied_domains is distinct from computed_domains
      or score ->> 'tier'
        not in (
          'official', 'synthetic_complete', 'provisional',
          'coverage_only', 'not_applicable'
        )
      or not aiq_private.score_tier_is_valid(
        (score ->> 'tier')::aiq_private.score_status,
        valid_count, invalid_count, missing_count, na_count,
        domain_count, minimum_domain_count
      )
      or (
        is_synthetic
        and valid_count = 72
        and invalid_count = 0
        and missing_count = 0
        and na_count = 0
        and domain_count = 10
        and score ->> 'tier' <> 'synthetic_complete'
      )
      or (score ->> 'tier' = 'synthetic_complete' and not is_synthetic)
      or (score ->> 'tier' = 'official' and is_synthetic)
      or (
        jsonb_typeof(score -> 'official_aiq') = 'number'
        and (score ->> 'official_aiq')::numeric not between 0 and 100
      )
      or (
        jsonb_typeof(score -> 'conditional_observed_aiq') = 'number'
        and (score ->> 'conditional_observed_aiq')::numeric not between 0 and 100
      )
      or (
        score ->> 'tier' = 'official'
        and (
          jsonb_typeof(score -> 'official_aiq') is distinct from 'number'
          or jsonb_typeof(score -> 'conditional_observed_aiq')
            is distinct from 'number'
          or round((score ->> 'official_aiq')::numeric, 3)
            is distinct from round(fixed_score, 3)
          or round((score ->> 'conditional_observed_aiq')::numeric, 3)
            is distinct from round(fixed_score, 3)
        )
      )
      or (
        score ->> 'tier' in ('synthetic_complete', 'provisional')
        and (
          score -> 'official_aiq' is distinct from 'null'::jsonb
          or jsonb_typeof(score -> 'conditional_observed_aiq')
            is distinct from 'number'
          or round((score ->> 'conditional_observed_aiq')::numeric, 3)
            is distinct from round(fixed_score, 3)
        )
      )
      or (
        score ->> 'tier' in ('coverage_only', 'not_applicable')
        and (
          score -> 'official_aiq' is distinct from 'null'::jsonb
          or score -> 'conditional_observed_aiq' is distinct from 'null'::jsonb
          or supplied_fixed is not null
        )
      )
      or (
        score ->> 'tier' in ('official', 'synthetic_complete', 'provisional')
        and (
          not aiq_private.completion_bounds_jsonb_is_valid(
            score -> 'completion_bounds'
          )
          or round((score -> 'completion_bounds' ->> 'lower')::numeric, 3)
            is distinct from round(computed_completion_low, 3)
          or round((score -> 'completion_bounds' ->> 'upper')::numeric, 3)
            is distinct from round(computed_completion_high, 3)
        )
      )
      or (
        score ->> 'tier' in ('coverage_only', 'not_applicable')
        and score -> 'completion_bounds' is distinct from 'null'::jsonb
      )
      or (
        score ->> 'tier' in ('official', 'synthetic_complete', 'provisional')
        and not aiq_private.task_resampling_interval_is_valid(
          score -> 'task_resampling_sensitivity_interval'
        )
      )
      or (
        score ->> 'tier' in ('coverage_only', 'not_applicable')
        and score -> 'task_resampling_sensitivity_interval'
          is distinct from 'null'::jsonb
      )
      or not aiq_private.binary_micro_diagnostic_jsonb_is_valid(
        score -> 'binary_micro_diagnostic',
        binary_sample_count,
        binary_success_count
      )
      or (score ->> 'ranking_eligible')::boolean is distinct from false
    then
      raise exception 'normalized score report differs from recomputed task evidence for %',
        model.model_config_id using errcode = '22023';
    end if;

    insert into aiq_private.aiq_runs (
      run_id, matrix_batch_id, idempotency_key, schedule_slot, scheduled_for,
      schedule_timezone, task_set_id, task_set_version, benchmark_version,
      scoring_version, model_config_id, source_node_id, status, trust_tier,
      capability_sha256, synthetic, published, started_at, completed_at, prompt_set_digest,
      runner_commit, region, provenance, run_provenance
    ) values (
      child_id, batch_id, child_id, 'manual',
      to_timestamp((stage ->> 'scheduled_unix_ms')::double precision / 1000),
      'UTC', stage ->> 'task_set_id', stage ->> 'task_set_version',
      stage ->> 'benchmark_version', '1.0.5', model.model_config_id,
      source_node,
      (case when valid_count = 72 then 'completed' else 'partial' end)
        ::aiq_private.run_status,
      'unverified',
      case when is_synthetic then null
        else replace(stage ->> 'capability_validation_digest', 'sha256:', '') end,
      is_synthetic, false,
      to_timestamp((stage ->> 'started_unix_ms')::double precision / 1000),
      to_timestamp((stage ->> 'finished_unix_ms')::double precision / 1000),
      replace(stage ->> 'prompt_set_digest', 'sha256:', ''),
      stage ->> 'runner_commit', stage ->> 'region',
      jsonb_build_object(
        'schema_version', 'aiq.child-run-binding.v3',
        'normalization_digest', normalization,
        'synthetic', is_synthetic
      ),
      stage_provenance
    );
    select value into efficiency_entry
    from jsonb_array_elements(stage->'efficiency') aggregate
    where aggregate->'model'=child->'model';
    if efficiency_entry is null
      or (efficiency_entry->>'selected_tasks')::integer<>72
    then raise exception 'Official model efficiency aggregate is absent or incomplete'
      using errcode='22023'; end if;
    insert into aiq_private.efficiency_official_models(
      run_id,result_count,attempted_result_count,execution_concurrency,invoked_result_count,
      adapter_elapsed_observed_result_count,observed_total_wall_ms,
      observed_median_wall_ms,observed_p95_wall_ms,input_tokens,cached_input_tokens,
      cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
      token_observed_result_count,input_token_observed_result_count,
      cached_input_token_observed_result_count,cache_write_input_token_observed_result_count,
      output_token_observed_result_count,reasoning_token_observed_result_count,
      total_token_observed_result_count,priced_result_count,standard_api_equivalent_usd_nanos,
      cost_estimator_status,cost_evidence_level,pricing_digest,efficiency_record
    ) values(
      child_id,72,
      case when is_synthetic then 0 else
        (select count(*)::integer from jsonb_array_elements(normalized_results) result
          where coalesce(result#>>'{failure,kind}','') not in (
            'capability_unavailable','capability_validation_failed'
          ))
      end,
      (stage->>'execution_concurrency')::integer,
      case when is_synthetic then 0 else
        (select count(*)::integer from jsonb_array_elements(normalized_results) result
          where coalesce(result#>>'{failure,kind}','') not in (
            'capability_unavailable','capability_validation_failed','workspace_unavailable'
          ))
      end,
      (efficiency_entry->>'observed_wall_tasks')::integer,
      (efficiency_entry->>'total_observed_wall_ms')::bigint,
      (efficiency_entry->>'median_observed_wall_ms')::bigint,
      (efficiency_entry->>'p95_observed_wall_ms')::bigint,
      (efficiency_entry#>>'{provider_token_totals,input}')::bigint,
      (efficiency_entry#>>'{provider_token_totals,cached_input}')::bigint,
      (efficiency_entry#>>'{provider_token_totals,cache_write_input}')::bigint,
      (efficiency_entry#>>'{provider_token_totals,output}')::bigint,
      (efficiency_entry#>>'{provider_token_totals,reasoning}')::bigint,
      (efficiency_entry#>>'{provider_token_totals,total}')::bigint,
      (select count(*)::integer from jsonb_array_elements(stage->'result_efficiency') evidence
        where evidence->'model'=child->'model' and evidence->'provider_tokens'<>'{}'::jsonb),
      (efficiency_entry#>>'{provider_token_coverage,input_tasks}')::integer,
      (efficiency_entry#>>'{provider_token_coverage,cached_input_tasks}')::integer,
      (efficiency_entry#>>'{provider_token_coverage,cache_write_input_tasks}')::integer,
      (efficiency_entry#>>'{provider_token_coverage,output_tasks}')::integer,
      (efficiency_entry#>>'{provider_token_coverage,reasoning_tasks}')::integer,
      (efficiency_entry#>>'{provider_token_coverage,total_tasks}')::integer,
      (efficiency_entry->>'estimated_cost_tasks')::integer,
      (efficiency_entry->>'standard_api_equivalent_usd_nanos')::bigint,
      case when efficiency_entry->'standard_api_equivalent_usd_nanos'<>'null'::jsonb
        and (efficiency_entry->>'estimated_cost_tasks')::integer=72 then 'estimated'
        when (efficiency_entry->>'estimated_cost_tasks')::integer=72
          then 'unavailable_invalid_usage'
        when exists(
          select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
          where evidence->'model'=child->'model'
            and evidence->>'cost_status'='unavailable_invalid_usage'
        ) then 'unavailable_invalid_usage'
        when exists(
          select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
          where evidence->'model'=child->'model'
            and evidence->>'cost_status'='unavailable_context_band'
        ) then 'unavailable_context_band'
        else 'unavailable_missing_usage' end,
      case when efficiency_entry->'standard_api_equivalent_usd_nanos'<>'null'::jsonb
        then 'verifier_recomputed' end,
      computed_pricing_digest,efficiency_entry
    );
    insert into aiq_private.aiq_package_runs
      (package_sha256, run_id, model_config_id, matrix_order)
    values (package_id, child_id, model.model_config_id, model.matrix_order);
    insert into aiq_private.aiq_task_results (
      source_result_id, run_id, task_id, task_version, domain, attempt_number,
      outcome, task_score, scorer_version, failure_code,
      failure_responsibility, failure_detail, failure_retryable, latency_ms,
      latency_evidence_level,
      tool_usage, usage,input_tokens,cached_input_tokens,cache_write_input_tokens,
      output_tokens,reasoning_output_tokens,total_tokens,token_usage_evidence_level,
      standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level,
      pricing_digest,result_package_sha256, provenance
    )
    select
      value ->> 'source_result_id', child_id, value ->> 'task_id',
      value ->> 'task_version', value ->> 'domain', 1,
      (value ->> 'outcome')::aiq_private.result_outcome,
      (value ->> 'task_score')::numeric, '1.0.5',
      value -> 'failure' ->> 'kind', value ->> 'failure_responsibility',
      value -> 'failure' ->> 'message',
      (value -> 'failure' ->> 'retryable')::boolean,
      (verified.evidence->>'observed_wall_ms')::bigint,
      verified.evidence->>'wall_time_evidence_level',
      value -> 'tool_usage',
      jsonb_build_object(
        'response_sha256', value -> 'response_sha256',
        'evaluator_stdout_sha256', value -> 'evaluator_stdout_sha256'
      ),
      (verified.evidence#>>'{provider_tokens,input}')::bigint,
      (verified.evidence#>>'{provider_tokens,cached_input}')::bigint,
      (verified.evidence#>>'{provider_tokens,cache_write_input}')::bigint,
      (verified.evidence#>>'{provider_tokens,output}')::bigint,
      (verified.evidence#>>'{provider_tokens,reasoning}')::bigint,
      (verified.evidence#>>'{provider_tokens,total}')::bigint,
      verified.evidence->>'provider_tokens_evidence_level',
      (verified.evidence->>'standard_api_equivalent_usd_nanos')::bigint,
      verified.evidence->>'cost_status',verified.evidence->>'cost_evidence_level',
      computed_pricing_digest,package_id,
      (value -> 'provenance') || jsonb_build_object(
        'source_result_id', value ->> 'source_result_id',
        'task_hash', value ->> 'task_hash',
        'normalization_digest', normalization,
        'rerun_required', value ->> 'outcome' = 'invalid'
      )
    from jsonb_array_elements(normalized_results)
    cross join lateral (
      select result_efficiency_by_id -> (value->>'source_result_id') as evidence
    ) verified;

    insert into aiq_private.aiq_score_snapshots (
      run_id, scoring_version, score_status, fixed_fixture_aiq,
      task_resampling_low, task_resampling_high, completion_bound_low,
      completion_bound_high, micro_accuracy, micro_wilson_low,
      micro_wilson_high, valid_task_count, expected_task_count,
      covered_domain_count, expected_domain_count, invalid_count, missing_count,
      not_applicable_count, domain_scores, interval_parameters, published,
      normalization_digest
    ) values (
      child_id, '1.0.5', (score ->> 'tier')::aiq_private.score_status,
      case when score ->> 'tier' in ('official', 'synthetic_complete', 'provisional')
        then round(fixed_score, 3) end,
      (score -> 'task_resampling_sensitivity_interval' ->> 'lower')::numeric,
      (score -> 'task_resampling_sensitivity_interval' ->> 'upper')::numeric,
      case when score ->> 'tier' in ('official', 'synthetic_complete', 'provisional')
        then round(computed_completion_low, 3) else 0 end,
      case when score ->> 'tier' in ('official', 'synthetic_complete', 'provisional')
        then round(computed_completion_high, 3) else 100 end,
      (score -> 'binary_micro_diagnostic' ->> 'proportion')::numeric,
      (score -> 'binary_micro_diagnostic' ->> 'wilson_lower')::numeric,
      (score -> 'binary_micro_diagnostic' ->> 'wilson_upper')::numeric,
      valid_count, 72, domain_count, 10, invalid_count, missing_count, na_count,
      computed_domains, score -> 'task_resampling_sensitivity_interval',
      false, normalization
    );
  end loop;

  update aiq_private.aiq_submission_inbox set state = 'processed'
  where inbox_id = inbox.inbox_id;
  insert into aiq_private.aiq_verification_audit (
    inbox_id, package_sha256, event_type, actor_node_id, event_record
  ) values (
    inbox.inbox_id, package_id, 'staged', source_node,
    jsonb_build_object(
      'schema_version', 'aiq.stage-audit.v3',
      'matrix_batch_id', batch_id,
      'normalization_digest', normalization,
      'run_class', stage -> 'run_class',
      'provenance', stage -> 'provenance',
      'child_count', 17,
      'task_result_count', 1224
    )
  );
  return batch_id;
exception
  when unique_violation then
    raise exception 'submission batch was already staged or contains duplicate identity'
      using errcode = '23505';
  when invalid_text_representation or numeric_value_out_of_range
    or datetime_field_overflow
  then
    raise exception 'normalized batch contains an invalid typed value'
      using errcode = '22023';
end;
$_$;



--
-- Name: staged_submission_is_recoverable(uuid); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.staged_submission_is_recoverable(target_inbox_id uuid) returns boolean
    language sql stable
    SET search_path to ''
    as $$
  select coalesce(exists (
    select 1
    from aiq_private.aiq_submission_inbox inbox
    join aiq_private.aiq_matrix_batches batch
      on batch.matrix_batch_id = inbox.idempotency_key
      and batch.package_sha256 = inbox.package_sha256
    join aiq_private.aiq_result_packages package
      on package.matrix_batch_id = batch.matrix_batch_id
      and package.package_sha256 = batch.package_sha256
    where inbox.inbox_id = target_inbox_id
      and inbox.state = 'processed'
      and inbox.verification_status = 'unverified'
      and batch.normalized_stage is not null
      and batch.verified_at is null
      and batch.published_at is null
      and not package.signature_verified
      and package.verified_at is null
      and package.verifier_attestation is null
      and package.rejection_code is null
      and package.envelope is not distinct from inbox.envelope
      and package.run_provenance is not distinct from batch.run_provenance
      and batch.normalized_stage ->> 'matrix_batch_id' = batch.matrix_batch_id
      and batch.normalized_stage ->> 'package_sha256' = batch.package_sha256
      and batch.normalized_stage ->> 'content_hash' = batch.content_hash
      and batch.normalized_stage ->> 'normalization_digest' =
        batch.normalization_digest
      and not exists (
        select 1
        from aiq_private.aiq_submission_conflicts conflict
        where conflict.inbox_id = inbox.inbox_id
          and conflict.retention_state = 'active'
      )
      and (
        select count(*)
        from aiq_private.aiq_verification_audit audit
        where audit.inbox_id = inbox.inbox_id
          and audit.package_sha256 = inbox.package_sha256
          and audit.event_type = 'staged'
      ) = 1
      and (
        select count(*)
        from aiq_private.aiq_verification_audit audit
        where audit.inbox_id = inbox.inbox_id
          and audit.package_sha256 = inbox.package_sha256
          and audit.event_type = 'verifier_attested'
      ) <= 1
      and not exists (
        select 1
        from aiq_private.aiq_verification_audit audit
        where audit.inbox_id = inbox.inbox_id
          and audit.package_sha256 = inbox.package_sha256
          and audit.event_type = 'verifier_attested'
          and (
            audit.actor_node_id is distinct from
              audit.event_record -> 'verifier' ->> 'node_id'
            or aiq_private.verifier_attestation_v3_binding_is_valid(
              audit.event_record, batch, package
            ) is distinct from true
          )
      )
      and not exists (
        select 1
        from aiq_private.aiq_verification_audit audit
        where audit.inbox_id = inbox.inbox_id
          and audit.package_sha256 = inbox.package_sha256
          and audit.event_type in ('verified_published', 'rejected')
      )
  ), false);
$$;


--
-- Name: sync_artifact_storage_reference(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.sync_artifact_storage_reference() returns trigger
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  storage_object_id uuid;
  object_record aiq_private.aiq_artifact_ingress_objects%rowtype;
  reference_identity text;
  reference_kind text;
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'aiq_artifact_ingress_objects' then return old; end if;
    reference_kind := case when tg_table_name = 'aiq_artifact_ingress_claims'
      then 'artifact_ingress_claim' else 'artifact_claim_binding' end;
    reference_identity := case when tg_table_name = 'aiq_artifact_ingress_claims'
      then (to_jsonb(old) ->> 'claimed_run_id') || '/' || old.content_sha256 || '/' || old.artifact_kind
      else (to_jsonb(old) ->> 'inbox_id') || '/' || old.content_sha256 || '/' || old.artifact_kind end;
    perform aiq_private.deactivate_storage_reference(reference_kind, reference_identity);
    return old;
  end if;
  if tg_table_name = 'aiq_artifact_ingress_objects' then
    perform aiq_private.ensure_storage_object(
      'runner_artifact', new.artifact_kind, new.bucket_name, new.object_path,
      new.content_sha256, new.byte_size, 'ephemeral_30d', new.expires_at
    );
    return new;
  end if;
  reference_kind := case when tg_table_name = 'aiq_artifact_ingress_claims'
    then 'artifact_ingress_claim' else 'artifact_claim_binding' end;
  reference_identity := case when tg_table_name = 'aiq_artifact_ingress_claims'
    then (to_jsonb(new) ->> 'claimed_run_id') || '/' || new.content_sha256 || '/' || new.artifact_kind
    else (to_jsonb(new) ->> 'inbox_id') || '/' || new.content_sha256 || '/' || new.artifact_kind end;
  select * into strict object_record
  from aiq_private.aiq_artifact_ingress_objects object
  where object.artifact_kind = new.artifact_kind
    and object.content_sha256 = new.content_sha256;
  storage_object_id := aiq_private.ensure_storage_object(
    'runner_artifact', object_record.artifact_kind, object_record.bucket_name,
    object_record.object_path, object_record.content_sha256, object_record.byte_size,
    'ephemeral_30d', object_record.expires_at
  );
  perform aiq_private.attach_storage_reference(
    storage_object_id, reference_kind, reference_identity
  );
  return new;
end;
$$;


--
-- Name: sync_submission_storage_reference(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.sync_submission_storage_reference() returns trigger
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  storage_object_id uuid;
  reference_kind text := case when tg_table_name = 'aiq_submission_inbox'
    then 'submission_inbox' else 'submission_conflict' end;
  reference_identity text;
begin
  if tg_op = 'DELETE' then
    reference_identity := case when tg_table_name = 'aiq_submission_inbox'
      then to_jsonb(old) ->> 'inbox_id' else to_jsonb(old) ->> 'conflict_id' end;
    perform aiq_private.deactivate_storage_reference(reference_kind, reference_identity);
    return old;
  end if;
  if new.object_bucket is null then return new; end if;
  reference_identity := case when tg_table_name = 'aiq_submission_inbox'
    then to_jsonb(new) ->> 'inbox_id' else to_jsonb(new) ->> 'conflict_id' end;
  storage_object_id := aiq_private.ensure_storage_object(
    'submission_package', null, new.object_bucket, new.object_key,
    new.object_content_sha256, new.object_bytes, 'ephemeral_30d', new.expires_at
  );
  perform aiq_private.attach_storage_reference(
    storage_object_id, reference_kind, reference_identity
  );
  return new;
end;
$$;


--
-- Name: synthetic_commitment_exception_allowed(boolean, boolean); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.synthetic_commitment_exception_allowed(stage_synthetic boolean, task_set_synthetic boolean) returns boolean
    language sql immutable
    SET search_path to ''
    as $$
  select stage_synthetic is true and task_set_synthetic is true;
$$;


--
-- Name: task_catalog_is_exact(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.task_catalog_is_exact(target_task_set_id text, target_task_set_version text) returns boolean
    language sql stable
    SET search_path to ''
    as $$
  select case
    when coalesce((task_set.metadata ->> 'synthetic')::boolean, false)
    then (
      select count(*) = 72 and count(distinct task.task_id) = 72
      from aiq_private.aiq_task_catalog task
      where task.task_set_id = target_task_set_id
        and task.task_set_version = target_task_set_version
    )
    else aiq_private.frozen_catalog_identity_is_valid(
      target_task_set_id, target_task_set_version, '1.0.5'
    )
  end
  from aiq_private.aiq_task_sets task_set
  where task_set.task_set_id = target_task_set_id
    and task_set.task_set_version = target_task_set_version;
$$;


--
-- Name: task_resampling_interval_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.task_resampling_interval_is_valid(candidate jsonb) returns boolean
    language plpgsql immutable
    SET search_path to ''
    as $$
begin
  if jsonb_typeof(candidate) is distinct from 'object'
    or not aiq_private.has_exact_jsonb_keys(
      candidate,
      array['central_mass', 'lower', 'method', 'samples', 'seed', 'upper']::text[]
    )
  then
    return false;
  end if;
  if jsonb_typeof(candidate -> 'central_mass') is distinct from 'number'
    or jsonb_typeof(candidate -> 'lower') is distinct from 'number'
    or jsonb_typeof(candidate -> 'samples') is distinct from 'number'
    or jsonb_typeof(candidate -> 'seed') is distinct from 'number'
    or jsonb_typeof(candidate -> 'upper') is distinct from 'number'
  then
    return false;
  end if;
  return coalesce(
    candidate ->> 'method'
      = 'finite_cluster_calibrated_percentile_sensitivity_v1'
    and (candidate ->> 'central_mass')::numeric = 0.95
    and (candidate ->> 'samples')::numeric = 10000
    and (candidate ->> 'seed')::numeric = 71783153620529
    and (candidate ->> 'lower')::numeric between 0 and 100
    and (candidate ->> 'upper')::numeric between 0 and 100
    and (candidate ->> 'lower')::numeric <= (candidate ->> 'upper')::numeric,
    false
  );
end;
$$;


--
-- Name: publication_is_complete(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.publication_is_complete(target_batch_id text, target_package_sha256 text) returns boolean
    language plpgsql
    SET search_path to ''
    as $$
declare
  batch aiq_private.aiq_matrix_batches%rowtype;
  package aiq_private.aiq_result_packages%rowtype;
  attestation jsonb;
begin
  select * into batch
  from aiq_private.aiq_matrix_batches record
  where record.matrix_batch_id = target_batch_id
    and record.package_sha256 = target_package_sha256;
  if not found then
    return false;
  end if;
  select * into package
  from aiq_private.aiq_result_packages record
  where record.matrix_batch_id = target_batch_id
    and record.package_sha256 = target_package_sha256;
  if not found
    or aiq_private.publication_is_complete_without_publisher(
      target_batch_id, target_package_sha256
    ) is distinct from true
  then
    return false;
  end if;
  if batch.synthetic then
    return false;
  end if;
  attestation := package.verifier_attestation;
  return exists (
    select 1
    from aiq_private.aiq_publication_actors binding
    join aiq_private.aiq_nodes publisher
      on publisher.node_id = binding.publisher_node_id
    where binding.matrix_batch_id = target_batch_id
      and binding.package_sha256 = target_package_sha256
      and binding.publisher_public_key = publisher.public_key
      and binding.publisher_node_id is distinct from batch.source_node_id
      and binding.publisher_node_id is distinct from
        attestation -> 'verifier' ->> 'node_id'
      and publisher.operator_class = 'official'
      and publisher.signature_algorithm = 'ed25519'
      and not publisher.synthetic
      and aiq_private.node_public_key_matches_id(
        binding.publisher_node_id, binding.publisher_public_key
      )
  );
end;
$$;


--
-- Name: publication_is_complete_without_publisher(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.publication_is_complete_without_publisher(target_batch_id text, target_package_sha256 text) returns boolean
    language plpgsql
    SET search_path to ''
    as $$
declare
  batch aiq_private.aiq_matrix_batches%rowtype;
  package aiq_private.aiq_result_packages%rowtype;
  inbox aiq_private.aiq_submission_inbox%rowtype;
  attestation jsonb;
  observed_at timestamptz;
begin
  select * into batch
  from aiq_private.aiq_matrix_batches record
  where record.matrix_batch_id = target_batch_id
    and record.package_sha256 = target_package_sha256;
  if not found then return false; end if;

  select * into package
  from aiq_private.aiq_result_packages record
  where record.package_sha256 = target_package_sha256
    and record.matrix_batch_id = target_batch_id;
  if not found then return false; end if;

  select * into inbox
  from aiq_private.aiq_submission_inbox record
  where record.idempotency_key = target_batch_id
    and record.package_sha256 = target_package_sha256;
  if not found then return false; end if;

  attestation := package.verifier_attestation;
  if batch.verified_at is null
    or batch.published_at is null
    or package.schema_version <> 'aiq.result-package.v3'
    or not package.signature_verified
    or package.trust_tier <> 'trusted_verified'
    or package.rejection_code is not null
    or package.idempotency_key <> target_batch_id
    or package.run_id <> target_batch_id
    or package.node_id <> batch.source_node_id
    or package.content_hash <> batch.content_hash
    or package.normalization_digest <> batch.normalization_digest
    or package.run_provenance is distinct from batch.run_provenance
    or package.envelope is distinct from inbox.envelope
    or package.envelope ->> 'schema_version' is distinct from
      'aiq.result-package.v3'
    or package.envelope ->> 'payload_type' is distinct from 'aiq.run.v3'
    or package.envelope -> 'payload' ->> 'schema_version' is distinct from
      'aiq.run.v3'
    or package.envelope -> 'payload' -> 'provenance' is distinct from
      coalesce(batch.run_provenance, 'null'::jsonb)
    or (
      batch.normalized_stage is not null
      and (
        batch.normalized_stage ->> 'schema_version' is distinct from
          'aiq.normalized-batch.v3'
        or batch.normalized_stage -> 'provenance' is distinct from
          coalesce(batch.run_provenance, 'null'::jsonb)
      )
    )
    or inbox.state <> 'processed'
    or inbox.verification_status <> 'verified'
    or not aiq_private.verifier_attestation_v3_binding_is_valid(
      attestation, batch, package
    )
  then
    return false;
  end if;

  observed_at := to_timestamp(
    (attestation ->> 'observed_unix_ms')::double precision / 1000
  );
  if package.verified_at is distinct from observed_at
    or batch.verified_at is distinct from observed_at
    or (
      select count(*) from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'staged'
    ) <> 1
    or (
      select count(*) from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'verifier_attested'
    ) <> 1
    or (
      select count(*) from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'verifier_attested'
        and audit.actor_node_id = attestation -> 'verifier' ->> 'node_id'
        and audit.event_record = attestation
    ) <> 1
    or (
      select count(*) from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'verified_published'
    ) <> 1
    or (
      select count(*) from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'verified_published'
        and audit.actor_node_id = attestation -> 'verifier' ->> 'node_id'
        and audit.event_record = attestation
    ) <> 1
    or exists (
      select 1 from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'rejected'
    )
    or (
      select count(*) from aiq_private.aiq_package_runs link
      where link.package_sha256 = target_package_sha256
    ) <> 17
    or (
      select count(*)
      from aiq_private.aiq_package_runs link
      join aiq_private.aiq_runs run on run.run_id = link.run_id
      where link.package_sha256 = target_package_sha256
        and run.matrix_batch_id = target_batch_id
        and run.task_set_id = batch.task_set_id
        and run.task_set_version = batch.task_set_version
        and run.scoring_version = batch.scoring_version
        and run.source_node_id = batch.source_node_id
        and run.synthetic = batch.synthetic
        and run.status = 'completed'
        and run.published
        and run.trust_tier = 'trusted_verified'
        and run.failure_code is null
        and run.failure_detail is null
        and run.prompt_set_digest = replace(batch.prompt_set_digest, 'sha256:', '')
    ) <> 17
    or exists (
      select 1
      from aiq_private.aiq_package_runs link
      where link.package_sha256 = target_package_sha256
        and (
          select count(*) = 72
            and count(distinct result.task_id) = 72
            and count(distinct result.domain) = 10
            and bool_and(result.attempt_number = 1)
            and bool_and(result.result_package_sha256 = target_package_sha256)
            and bool_and(result.task_score is not null)
            and bool_and(
              result.outcome not in ('invalid', 'missing', 'not_applicable')
            )
            and bool_and(result.scorer_version = batch.scoring_version)
          from aiq_private.aiq_task_results result
          where result.run_id = link.run_id
        ) is not true
    )
    or (
      select count(*)
      from aiq_private.aiq_task_results result
      join aiq_private.aiq_package_runs link on link.run_id = result.run_id
      where link.package_sha256 = target_package_sha256
    ) <> 1224
    or (
      select count(*)
      from aiq_private.aiq_score_snapshots score
      join aiq_private.aiq_package_runs link on link.run_id = score.run_id
      where link.package_sha256 = target_package_sha256
        and score.scoring_version = batch.scoring_version
        and score.score_status = 'official'
        and score.valid_task_count = 72
        and score.expected_task_count = 72
        and score.covered_domain_count = 10
        and score.expected_domain_count = 10
        and score.invalid_count = 0
        and score.missing_count = 0
        and score.not_applicable_count = 0
        and score.published
        and score.normalization_digest = batch.normalization_digest
        and aiq_private.task_resampling_interval_is_valid(
          score.interval_parameters
        )
        and score.task_resampling_low =
          round((score.interval_parameters ->> 'lower')::numeric, 3)
        and score.task_resampling_high =
          round((score.interval_parameters ->> 'upper')::numeric, 3)
    ) <> 17
  then
    return false;
  end if;
  return true;
end;
$$;


--
-- Name: publication_transition_is_eligible(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.publication_transition_is_eligible(target_batch_id text, target_package_sha256 text) returns boolean
    language plpgsql
    SET search_path to ''
    as $$
declare
  batch aiq_private.aiq_matrix_batches%rowtype;
  package aiq_private.aiq_result_packages%rowtype;
  inbox aiq_private.aiq_submission_inbox%rowtype;
  attestation jsonb;
  publisher_node_id text;
  locked_identity_count integer;
begin
  select * into batch from aiq_private.aiq_matrix_batches record
  where record.matrix_batch_id = target_batch_id
    and record.package_sha256 = target_package_sha256
  for share;
  select * into package from aiq_private.aiq_result_packages record
  where record.matrix_batch_id = target_batch_id
    and record.package_sha256 = target_package_sha256
  for share;
  select * into inbox from aiq_private.aiq_submission_inbox record
  where record.idempotency_key = target_batch_id
    and record.package_sha256 = target_package_sha256
  for share;
  if batch.matrix_batch_id is null or package.package_sha256 is null
    or inbox.inbox_id is null
    or batch.synthetic
    or batch.run_provenance is distinct from package.run_provenance
    or package.envelope is distinct from inbox.envelope
    or jsonb_typeof(package.envelope -> 'payload_type') is distinct from 'string'
    or package.envelope ->> 'payload_type' is distinct from 'aiq.run.v3'
    or jsonb_typeof(package.envelope -> 'payload' -> 'schema_version')
      is distinct from 'string'
    or package.envelope -> 'payload' ->> 'schema_version'
      is distinct from 'aiq.run.v3'
    or exists (
      select 1 from aiq_private.aiq_submission_conflicts conflict
      where conflict.inbox_id = inbox.inbox_id
    )
  then
    return false;
  end if;
  if package.schema_version is distinct from 'aiq.result-package.v3' then
    return false;
  end if;
  attestation := package.verifier_attestation;
  if attestation is null then
    select audit.event_record into attestation
    from aiq_private.aiq_verification_audit audit
    where audit.inbox_id = inbox.inbox_id
      and audit.package_sha256 = target_package_sha256
      and audit.event_type = 'verifier_attested';
  end if;
  if not batch.synthetic then
    publisher_node_id := aiq_private.request_publisher_node_id();
    select count(*) into locked_identity_count
    from (
      select identity.node_id
      from aiq_private.aiq_nodes identity
      where identity.node_id in (
        batch.source_node_id,
        attestation -> 'verifier' ->> 'node_id',
        publisher_node_id
      )
      for share
    ) locked_identity;
    if locked_identity_count <> 3 then
      return false;
    end if;
  end if;
  if aiq_private.verifier_attestation_v3_is_valid(
      attestation, batch, package
    ) is distinct from true
    or aiq_private.task_catalog_is_exact(
      batch.task_set_id, batch.task_set_version
    ) is distinct from true
    or (
      not batch.synthetic
      and (
        batch.normalized_stage is null
        or aiq_private.run_provenance_v2_is_valid(batch.run_provenance)
          is distinct from true
        or batch.run_provenance ->> 'run_class' is distinct from 'official'
        or aiq_private.production_execution_identities_are_authorized(
          batch.source_node_id,
          attestation -> 'verifier' ->> 'node_id'
        ) is distinct from true
        or aiq_private.production_publisher_identity_is_authorized(
          publisher_node_id,
          batch.source_node_id,
          attestation -> 'verifier' ->> 'node_id'
        ) is distinct from true
        or aiq_private.frozen_catalog_identity_is_valid(
          batch.task_set_id, batch.task_set_version, batch.scoring_version
        ) is distinct from true
        or not exists (
          select 1
          from aiq_private.aiq_node_capability_snapshots snapshot
          where snapshot.capability_sha256 =
              replace(batch.capability_validation_digest, 'sha256:', '')
            and snapshot.node_id = batch.source_node_id
            and snapshot.validation_status = 'valid'
            and snapshot.validation_report =
              package.envelope -> 'payload' -> 'capability_validation'
        )
      )
    )
    or (batch.synthetic and batch.run_provenance is not null)
  then
    return false;
  end if;
  return true;
end;
$$;


--
-- Name: validate_distributed_aggregation_input(); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.validate_distributed_aggregation_input() returns trigger
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  receipt_record aiq_private.aiq_distributed_result_receipts%rowtype;
begin
  if new.receipt_id is not null then
    select receipt.*
    into strict receipt_record
    from aiq_private.aiq_distributed_result_receipts receipt
    where receipt.receipt_id = new.receipt_id
      and receipt.assignment_id = new.assignment_id
      and receipt.lease_attempt = new.lease_attempt
      and receipt.node_id = new.node_id
      and receipt.receipt_hash = new.receipt_hash
      and receipt.result_package_hash = new.result_package_hash
      and receipt.synthetic = new.synthetic;
  end if;

  if new.trust_classification = 'receiver_verified_trusted'
    and (
      new.synthetic
      or receipt_record.signature_status <> 'verified'
      or receipt_record.status <> 'accepted'
    )
  then
    raise exception 'trusted aggregation input requires accepted verified receipt evidence'
      using errcode = '23514';
  end if;

  if new.trust_classification = 'signed_untrusted'
    and (
      receipt_record.status not in ('received', 'accepted')
      or (
        new.synthetic and receipt_record.signature_status <> 'unverified'
      )
      or (
        not new.synthetic and receipt_record.signature_status <> 'verified'
      )
    )
  then
    raise exception 'signed aggregation input requires matching signed receipt evidence'
      using errcode = '23514';
  end if;

  if new.trust_classification = 'rejected'
    and new.receipt_id is not null
    and receipt_record.status <> 'rejected'
  then
    raise exception 'receipt-bound rejected input requires rejected receipt evidence'
      using errcode = '23514';
  end if;

  return new;
exception
  when no_data_found then
    raise exception 'aggregation input receipt evidence does not match'
      using errcode = '23503';
end;
$$;



--
-- Name: aiq_matrix_batches; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_matrix_batches (
    matrix_batch_id text not null,
    package_sha256 text not null,
    content_hash text not null,
    normalization_digest text not null,
    source_node_id text not null,
    task_set_id text not null,
    task_set_version text not null,
    scoring_version text not null,
    synthetic boolean not null,
    child_count integer default 17 not null,
    result_count integer default 1224 not null,
    staged_at timestamp with time zone default now() not null,
    verified_at timestamp with time zone,
    published_at timestamp with time zone,
    task_set_hash text,
    capability_validation_digest text,
    benchmark_version text,
    prompt_set_digest text,
    source_scoring_version text,
    runner_commit text,
    region text,
    execution_concurrency integer not null,
    scheduled_unix_ms bigint,
    started_unix_ms bigint,
    finished_unix_ms bigint,
    run_provenance jsonb,
    normalized_stage jsonb,
    constraint aiq_batch_capability_evidence_policy check (((synthetic and (capability_validation_digest IS null)) or ((not synthetic) and (capability_validation_digest IS not null) and (capability_validation_digest ~ '^sha256:[0-9a-f]{64}$'::text)))),
    constraint aiq_batch_source_commitments check ((((task_set_hash IS null) or (task_set_hash ~ '^sha256:[0-9a-f]{64}$'::text)) and ((capability_validation_digest IS null) or (capability_validation_digest ~ '^sha256:[0-9a-f]{64}$'::text)) and ((prompt_set_digest IS null) or (prompt_set_digest ~ '^sha256:[0-9a-f]{64}$'::text)) and ((source_scoring_version IS null) or (source_scoring_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'::text)) and ((runner_commit IS null) or (runner_commit ~ '^[0-9a-f]{7,40}$'::text)) and (execution_concurrency between 1 and 32) and ((scheduled_unix_ms IS null) or (((scheduled_unix_ms >= 0) and (scheduled_unix_ms <= '9007199254740991'::bigint)) and ((started_unix_ms >= scheduled_unix_ms) and (started_unix_ms <= '9007199254740991'::bigint)) and ((finished_unix_ms >= started_unix_ms) and (finished_unix_ms <= '9007199254740991'::bigint)))))),
    constraint aiq_matrix_batches_check check (((published_at IS null) or (verified_at IS not null))),
    constraint aiq_matrix_batches_child_count_check check ((child_count = 17)),
    constraint aiq_matrix_batches_content_hash_check check ((content_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_matrix_batches_matrix_batch_id_check check ((matrix_batch_id ~ '^run_[0-9a-f]{64}$'::text)),
    constraint aiq_matrix_batches_normalization_digest_check check ((normalization_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_matrix_batches_package_sha256_check check ((package_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_matrix_batches_result_count_check check ((result_count = 1224))
);


--
-- Name: table aiq_matrix_batches; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_matrix_batches IS 'Immutable binding of one signed aiq.run.v3 package to 17 child runs and 1,224 results.';


--
-- Name: aiq_result_packages; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_result_packages (
    package_sha256 text not null,
    schema_version text not null,
    idempotency_key text not null,
    run_id text not null,
    node_id text not null,
    content_hash text not null,
    envelope jsonb not null,
    signature text not null,
    signature_verified boolean default false not null,
    verifier_attestation jsonb,
    trust_tier aiq_private.trust_tier default 'unverified'::aiq_private.trust_tier not null,
    received_at timestamp with time zone default now() not null,
    verified_at timestamp with time zone,
    rejection_code text,
    artifact_expires_at timestamp with time zone,
    provenance jsonb not null,
    matrix_batch_id text,
    normalization_digest text,
    run_provenance jsonb,
    constraint aiq_package_batch_id_format check (((matrix_batch_id IS null) or (matrix_batch_id ~ '^run_[0-9a-f]{64}$'::text))),
    constraint aiq_package_normalization_digest_format check (((normalization_digest IS null) or (normalization_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    constraint aiq_result_packages_check check ((idempotency_key = run_id)),
    constraint aiq_result_packages_check1 check (((not signature_verified) or ((verified_at IS not null) and (verifier_attestation IS not null) and (trust_tier = ANY (ARRAY['trusted_verified'::aiq_private.trust_tier, 'independently_reproduced'::aiq_private.trust_tier]))))),
    constraint aiq_result_packages_content_hash_check check ((content_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_result_packages_package_sha256_check check ((package_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_result_packages_provenance_check check ((provenance = '{"schema_version": "aiq.package-binding.v3"}'::jsonb)),
    constraint aiq_result_packages_schema_version_check check ((schema_version = 'aiq.result-package.v3'::text)),
    constraint aiq_result_packages_signature_check check ((signature ~ '^[0-9a-f]{128}$'::text))
);


--
-- Name: COLUMN aiq_result_packages.signature_verified; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on COLUMN aiq_private.aiq_result_packages.signature_verified IS 'Publisher assertion that external Ed25519 verification succeeded; verifier attestation v3 is retained separately.';



--
-- Name: verifier_attestation_v3_binding_is_valid(jsonb, aiq_private.aiq_matrix_batches, aiq_private.aiq_result_packages); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.verifier_attestation_v3_binding_is_valid(attestation jsonb, batch aiq_private.aiq_matrix_batches, package aiq_private.aiq_result_packages) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $_$
begin
  if jsonb_typeof(attestation) is distinct from 'object'
    or aiq_private.jsonb_wire_value_is_bounded(attestation) is distinct from true
    or jsonb_typeof(attestation -> 'verifier') is distinct from 'object'
    or not aiq_private.has_exact_jsonb_keys(
      attestation,
      array[
        'benchmark_version', 'capability_validation_digest', 'content_hash',
        'matrix_batch_id', 'normalization_digest', 'observed_unix_ms',
        'package_sha256', 'policy', 'prompt_set_digest', 'provenance',
        'replay_status', 'schema_version', 'scoring_version', 'signature',
        'signature_algorithm', 'signature_version', 'synthetic',
        'task_set_hash', 'verifier'
      ]::text[]
    )
    or not aiq_private.has_exact_jsonb_keys(
      attestation -> 'verifier', array['node_id', 'public_key']::text[]
    )
    or jsonb_typeof(attestation -> 'schema_version') is distinct from 'string'
    or jsonb_typeof(attestation -> 'signature_algorithm') is distinct from 'string'
    or jsonb_typeof(attestation -> 'signature_version') is distinct from 'string'
    or jsonb_typeof(attestation -> 'matrix_batch_id') is distinct from 'string'
    or jsonb_typeof(attestation -> 'package_sha256') is distinct from 'string'
    or jsonb_typeof(attestation -> 'content_hash') is distinct from 'string'
    or jsonb_typeof(attestation -> 'normalization_digest') is distinct from 'string'
    or jsonb_typeof(attestation -> 'task_set_hash') is distinct from 'string'
    or jsonb_typeof(attestation -> 'benchmark_version') is distinct from 'string'
    or jsonb_typeof(attestation -> 'prompt_set_digest') is distinct from 'string'
    or jsonb_typeof(attestation -> 'scoring_version') is distinct from 'string'
    or jsonb_typeof(attestation -> 'replay_status') is distinct from 'string'
    or jsonb_typeof(attestation -> 'policy') is distinct from 'string'
    or jsonb_typeof(attestation -> 'synthetic') is distinct from 'boolean'
    or jsonb_typeof(attestation -> 'signature') is distinct from 'string'
    or jsonb_typeof(attestation -> 'verifier' -> 'node_id') is distinct from 'string'
    or jsonb_typeof(attestation -> 'verifier' -> 'public_key') is distinct from 'string'
    or jsonb_typeof(attestation -> 'capability_validation_digest')
      is distinct from (
        case
        when batch.synthetic then 'null' else 'string'
        end
      )
    or attestation ->> 'schema_version' is distinct from 'aiq.verifier-attestation.v3'
    or attestation ->> 'signature_algorithm' is distinct from 'ed25519'
    or attestation ->> 'signature_version' is distinct from 'aiq.ed25519-jcs.v1'
    or not coalesce(attestation ->> 'signature' ~ '^[0-9a-f]{128}$', false)
    or attestation ->> 'signature' is not distinct from repeat('0', 128)
    or aiq_private.safe_unsigned_integer_jsonb_is_valid(
      attestation -> 'observed_unix_ms'
    ) is distinct from true
    or not coalesce(attestation ->> 'matrix_batch_id' ~ '^run_[0-9a-f]{64}$', false)
    or not aiq_private.jsonb_sha256_field_is_valid(
      attestation, 'package_sha256', false
    )
    or not aiq_private.jsonb_sha256_field_is_valid(attestation, 'content_hash', true)
    or not aiq_private.jsonb_sha256_field_is_valid(
      attestation, 'normalization_digest', true
    )
    or not aiq_private.jsonb_sha256_field_is_valid(attestation, 'task_set_hash', true)
    or (
      not batch.synthetic
      and not aiq_private.jsonb_sha256_field_is_valid(
        attestation, 'capability_validation_digest', true
      )
    )
    or not coalesce(
      attestation -> 'verifier' ->> 'node_id' ~ '^node_[0-9a-f]{64}$', false
    )
    or not coalesce(
      attestation -> 'verifier' ->> 'public_key' ~ '^[0-9a-f]{64}$', false
    )
    or attestation -> 'verifier' ->> 'public_key' is not distinct from repeat('0', 64)
    or attestation ->> 'matrix_batch_id' is distinct from batch.matrix_batch_id
    or attestation ->> 'package_sha256' is distinct from batch.package_sha256
    or attestation ->> 'content_hash' is distinct from batch.content_hash
    or attestation ->> 'normalization_digest' is distinct from batch.normalization_digest
    or attestation ->> 'task_set_hash' is distinct from batch.task_set_hash
    or attestation -> 'capability_validation_digest' is distinct from
      coalesce(to_jsonb(batch.capability_validation_digest), 'null'::jsonb)
    or attestation -> 'provenance' is distinct from
      coalesce(batch.run_provenance, 'null'::jsonb)
    or package.run_provenance is distinct from batch.run_provenance
    or package.envelope -> 'payload' -> 'provenance' is distinct from
      coalesce(batch.run_provenance, 'null'::jsonb)
    or (
      not batch.synthetic
      and (
        attestation -> 'verifier' ->> 'node_id' is not distinct from batch.source_node_id
      )
    )
    or attestation ->> 'benchmark_version' is distinct from batch.benchmark_version
    or attestation ->> 'prompt_set_digest' is distinct from batch.prompt_set_digest
    or attestation ->> 'scoring_version' is distinct from batch.source_scoring_version
    or (attestation ->> 'synthetic')::boolean is distinct from batch.synthetic
    or attestation ->> 'policy' is distinct from (
      case when batch.synthetic then 'synthetic_test' else 'production' end
    )
    or not coalesce(attestation ->> 'replay_status' in (
      'evaluator_replayed', 'commitments_verified'
    ), false)
    or (
      not batch.synthetic
      and (
        attestation ->> 'replay_status' is distinct from 'evaluator_replayed'
        or batch.normalized_stage is null
        or jsonb_typeof(batch.normalized_stage) is distinct from 'object'
        or jsonb_typeof(batch.normalized_stage -> 'schema_version')
          is distinct from 'string'
        or batch.normalized_stage ->> 'schema_version' is distinct from
          'aiq.normalized-batch.v3'
        or jsonb_typeof(batch.normalized_stage -> 'run_class')
          is distinct from 'string'
        or batch.normalized_stage ->> 'run_class' is distinct from 'official'
        or batch.normalized_stage -> 'provenance' is distinct from
          attestation -> 'provenance'
        or batch.normalized_stage ->> 'normalization_digest' is distinct from
          attestation ->> 'normalization_digest'
        or aiq_private.run_provenance_v2_is_valid(
          attestation -> 'provenance'
        ) is distinct from true
      )
    )
    or (
      batch.synthetic
      and (
        attestation -> 'provenance' is distinct from 'null'::jsonb
        or batch.run_provenance is not null
        or (
          batch.normalized_stage is not null
          and (
            batch.normalized_stage -> 'run_class' is distinct from 'null'::jsonb
            or batch.normalized_stage -> 'provenance' is distinct from 'null'::jsonb
          )
        )
      )
    )
  then
    return false;
  end if;
  -- Immutable binding depends on identity and role fields only.
  -- Current operational eligibility is checked separately at each first
  -- lifecycle transition.
  return exists (
    select 1
    from aiq_private.aiq_nodes verifier
    where verifier.node_id = attestation -> 'verifier' ->> 'node_id'
      and verifier.public_key = attestation -> 'verifier' ->> 'public_key'
      and verifier.operator_class = 'verifier'
      and verifier.signature_algorithm = 'ed25519'
      and verifier.synthetic = batch.synthetic
      and aiq_private.node_public_key_matches_id(
        verifier.node_id, verifier.public_key
      )
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$_$;


--
-- Name: verifier_attestation_v3_is_valid(jsonb, aiq_private.aiq_matrix_batches, aiq_private.aiq_result_packages); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.verifier_attestation_v3_is_valid(attestation jsonb, batch aiq_private.aiq_matrix_batches, package aiq_private.aiq_result_packages) returns boolean
    language sql stable
    SET search_path to ''
    as $$
  select aiq_private.verifier_attestation_v3_binding_is_valid(
    attestation, batch, package
  )
    and exists (
      select 1
      from aiq_private.aiq_nodes verifier
      where verifier.node_id = attestation -> 'verifier' ->> 'node_id'
        and verifier.public_key = attestation -> 'verifier' ->> 'public_key'
        and verifier.status in (
          'active'::aiq_private.node_status,
          'degraded'::aiq_private.node_status
        )
        and aiq_private.verifier_registry_trust_is_eligible(
          verifier.signature_status,
          verifier.trust_tier,
          verifier.synthetic,
          batch.synthetic
        )
    );
$$;


--
-- Name: verifier_registry_trust_is_eligible(text, aiq_private.trust_tier, boolean, boolean); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.verifier_registry_trust_is_eligible(signature_status text, trust_tier aiq_private.trust_tier, synthetic boolean, expected_synthetic boolean) returns boolean
    language sql immutable
    SET search_path to ''
    as $$
  select synthetic is not distinct from expected_synthetic
    and (
      (
        expected_synthetic
        and signature_status = 'unverified'
        and trust_tier = 'unverified'
      )
      or (
        not expected_synthetic
        and signature_status = 'verified'
      )
    );
$$;


--
-- Name: verifier_rejection_v2_is_valid(jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.verifier_rejection_v2_is_valid(rejection jsonb) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $_$
begin
  if not aiq_private.has_exact_jsonb_keys(
    rejection,
    array[
      'matrix_batch_id', 'observed_at', 'package_sha256', 'production',
      'reason_code', 'reason_detail', 'schema_version', 'synthetic',
      'verifier_node_id'
    ]::text[]
  )
    or jsonb_typeof(rejection -> 'schema_version') is distinct from 'string'
    or jsonb_typeof(rejection -> 'matrix_batch_id') is distinct from 'string'
    or jsonb_typeof(rejection -> 'package_sha256') is distinct from 'string'
    or jsonb_typeof(rejection -> 'observed_at') is distinct from 'string'
    or jsonb_typeof(rejection -> 'production') is distinct from 'boolean'
    or jsonb_typeof(rejection -> 'reason_code') is distinct from 'string'
    or jsonb_typeof(rejection -> 'reason_detail') is distinct from 'string'
    or jsonb_typeof(rejection -> 'synthetic') is distinct from 'boolean'
    or jsonb_typeof(rejection -> 'verifier_node_id') is distinct from 'string'
  then
    return false;
  end if;
  if not coalesce(
    rejection ->> 'observed_at'
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$',
    false
  )
    or not pg_input_is_valid(rejection ->> 'observed_at', 'timestamptz')
  then
    return false;
  end if;
  return coalesce(
    rejection ->> 'schema_version' = 'aiq.verifier-rejection.v2'
    and rejection ->> 'matrix_batch_id' ~ '^run_[0-9a-f]{64}$'
    and rejection ->> 'package_sha256' ~ '^[0-9a-f]{64}$'
    and substring(rejection ->> 'observed_at' from 12 for 2)::integer between 0 and 23
    and substring(rejection ->> 'observed_at' from 15 for 2)::integer between 0 and 59
    and substring(rejection ->> 'observed_at' from 18 for 2)::integer between 0 and 59
    and (rejection ->> 'production')::boolean
      <> (rejection ->> 'synthetic')::boolean
    and rejection ->> 'reason_code' ~ '^[a-z0-9_]{3,64}$'
    and octet_length(rejection ->> 'reason_detail') <= 4096
    and rejection ->> 'verifier_node_id' ~ '^node_[0-9a-f]{64}$',
    false
  );
end;
$_$;


--
-- Name: verify_and_publish_core(text, text); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.verify_and_publish_core(target_run_id text, target_package_sha256 text) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  batch aiq_private.aiq_matrix_batches%rowtype;
  package aiq_private.aiq_result_packages%rowtype;
  inbox aiq_private.aiq_submission_inbox%rowtype;
  attestation jsonb;
  observed_at timestamptz;
begin
  perform aiq_private.require_request_role('aiq_publisher');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'aiq.v3.batch-lock:' || target_run_id || ':' || target_package_sha256,
      71783153620529
    )
  );
  select * into batch from aiq_private.aiq_matrix_batches record
  where record.matrix_batch_id = target_run_id
    and record.package_sha256 = target_package_sha256 for update;
  select * into package from aiq_private.aiq_result_packages record
  where record.package_sha256 = target_package_sha256
    and record.matrix_batch_id = target_run_id for update;
  select * into inbox from aiq_private.aiq_submission_inbox record
  where record.idempotency_key = target_run_id
    and record.package_sha256 = target_package_sha256 for update;
  if batch.matrix_batch_id is null or package.package_sha256 is null or inbox.inbox_id is null
  then raise exception 'immutable staged batch evidence was not found' using errcode = 'P0002';
  end if;
  -- Exact publication replay is a no-op. Every publication identity and
  -- append-only event must still describe the already published package.
  -- Conflicts received after publication are incidents; they do not rewrite
  -- the published decision.
  if aiq_private.publication_is_complete(
    target_run_id, target_package_sha256
  ) then
    return;
  end if;
  if batch.verified_at is not null or package.signature_verified
    or inbox.state <> 'processed' or inbox.verification_status <> 'unverified'
    or exists (
      select 1 from aiq_private.aiq_submission_conflicts conflict
      where conflict.inbox_id = inbox.inbox_id
    )
    or (select count(*) from aiq_private.aiq_package_runs link
        where link.package_sha256 = target_package_sha256) <> 17
    or (select count(*) from aiq_private.aiq_task_results result
        join aiq_private.aiq_package_runs link on link.run_id = result.run_id
        where link.package_sha256 = target_package_sha256) <> 1224
    or (select count(*) from aiq_private.aiq_score_snapshots score
        join aiq_private.aiq_package_runs link on link.run_id = score.run_id
        where link.package_sha256 = target_package_sha256) <> 17
    or (select count(*) from aiq_private.aiq_score_snapshots score
        join aiq_private.aiq_package_runs link on link.run_id = score.run_id
        where link.package_sha256 = target_package_sha256
          and score.score_status = 'official') <> 17
    or (
      select count(*)
      from aiq_private.aiq_verification_audit audit
      where audit.inbox_id = inbox.inbox_id
        and audit.package_sha256 = target_package_sha256
        and audit.event_type = 'verifier_attested'
    ) <> 1
    or (
      not batch.synthetic
      and not exists (
        select 1
        from aiq_private.aiq_node_capability_snapshots snapshot
        where snapshot.capability_sha256 =
            replace(batch.capability_validation_digest, 'sha256:', '')
          and snapshot.node_id = batch.source_node_id
          and snapshot.validation_status = 'valid'
          and snapshot.validation_report =
            package.envelope -> 'payload' -> 'capability_validation'
      )
    )
  then raise exception 'batch is not eligible for publication' using errcode = '55000';
  end if;
  select audit.event_record into strict attestation
  from aiq_private.aiq_verification_audit audit
  where audit.inbox_id = inbox.inbox_id
    and audit.package_sha256 = target_package_sha256
    and audit.event_type = 'verifier_attested';
  -- Serialize publication with node revocation or eligibility changes.
  perform 1
  from aiq_private.aiq_nodes verifier
  where verifier.node_id = attestation -> 'verifier' ->> 'node_id'
  for share;
  if not found then
    raise exception 'stored verifier identity is not registered'
      using errcode = '55000';
  end if;
  if not aiq_private.verifier_attestation_v3_is_valid(attestation, batch, package)
  then
    raise exception 'stored verifier attestation is no longer bound to staged data'
      using errcode = '55000';
  end if;
  observed_at := to_timestamp(
    (attestation ->> 'observed_unix_ms')::double precision / 1000
  );
  insert into aiq_private.aiq_verification_audit (
    inbox_id, package_sha256, event_type, actor_node_id, event_record
  ) values (
    inbox.inbox_id, target_package_sha256, 'verified_published',
    attestation -> 'verifier' ->> 'node_id', attestation
  );
  update aiq_private.aiq_result_packages
  set signature_verified = true, verified_at = observed_at,
      verifier_attestation = attestation, trust_tier = 'trusted_verified'
  where package_sha256 = target_package_sha256;
  update aiq_private.aiq_matrix_batches
  set verified_at = observed_at, published_at = now()
  where matrix_batch_id = target_run_id;
  update aiq_private.aiq_score_snapshots score set published = true
  from aiq_private.aiq_package_runs link
  where link.package_sha256 = target_package_sha256 and link.run_id = score.run_id;
  update aiq_private.aiq_runs run
  set published = true, trust_tier = 'trusted_verified'
  from aiq_private.aiq_package_runs link
  where link.package_sha256 = target_package_sha256 and link.run_id = run.run_id;
update aiq_private.aiq_submission_inbox set verification_status = 'verified'
  where inbox_id = inbox.inbox_id;
end;
$$;


--
-- Name: aiq_ack_storage_deletion(uuid, uuid, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_ack_storage_deletion(target_object_id uuid, supplied_lease_token uuid, supplied_outcome text) returns text
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  object aiq_private.aiq_storage_objects%rowtype;
  database_now timestamptz;
begin
  perform aiq_private.require_request_role('service_role');
  if supplied_outcome not in ('deleted', 'not_found') then
    raise exception 'invalid Storage deletion outcome' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.storage.inventory-deletion-gate',71783153620529
  ));
  database_now:=clock_timestamp();
  select * into object from aiq_private.aiq_storage_objects candidate
  where candidate.object_id = target_object_id for update;
  if object.object_id is null then
    raise exception 'Storage deletion claim is absent' using errcode = '55000';
  end if;
  if object.lifecycle_state = 'deleted' and object.last_outcome = supplied_outcome then
    return 'idempotent';
  end if;
  if object.lifecycle_state <> 'delete_pending'
    or object.deletion_lease_token is distinct from supplied_lease_token
    or object.deletion_lease_expires_at <= database_now
    or object.legal_hold
    or exists (
      select 1 from aiq_private.aiq_storage_object_references reference
      where reference.object_id = object.object_id and reference.active
    )
  then
    raise exception 'Storage deletion claim is stale or no longer eligible'
      using errcode = '55000';
  end if;
  update aiq_private.aiq_storage_objects candidate
  set lifecycle_state = 'deleted', deletion_lease_token = null,
      deletion_lease_expires_at = null, deleted_at = database_now,
      last_outcome = supplied_outcome, last_error_code = null,
      updated_at = database_now
  where candidate.object_id = target_object_id;
  return 'acknowledged';
end;
$$;


--
-- Name: aiq_ack_submission_claim(uuid, uuid, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_ack_submission_claim(target_inbox_id uuid, supplied_lease_token uuid, supplied_disposition text) returns text
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  result text;
  supplied_attempt integer;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  select inbox.claim_attempts into supplied_attempt
  from aiq_private.aiq_submission_inbox inbox
  where inbox.inbox_id = target_inbox_id
    and inbox.claim_token = supplied_lease_token
  for update;
  result := aiq_private.aiq_ack_submission_claim_reference_core(
    target_inbox_id, supplied_lease_token, supplied_disposition
  );
  if supplied_disposition = 'retry' and result in ('acknowledged', 'idempotent') then
    perform aiq_private.retire_claim_artifact_references(
      target_inbox_id, supplied_lease_token, supplied_attempt, 'abandoned'
    );
  end if;
  return result;
end;
$$;


--
-- Name: aiq_attach_storage_reference(uuid, text, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_attach_storage_reference(supplied_object_id uuid, supplied_reference_type text, supplied_reference_key text) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  perform aiq_private.require_request_role('service_role');
  perform aiq_private.attach_storage_reference(
    supplied_object_id, supplied_reference_type, supplied_reference_key
  );
end;
$$;


--
-- Name: aiq_claim_storage_deletions(integer, integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_claim_storage_deletions(max_rows integer, requested_lease_seconds integer) returns table(object_id uuid, object_type text, artifact_kind text, bucket_name text, object_path text, content_sha256 text, byte_size bigint, lease_token uuid, lease_expires_at timestamp with time zone, attempt integer)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  perform aiq_private.require_request_role('service_role');
  perform aiq_private.retire_expired_claim_artifact_references(1000);
  return query
    select * from aiq_private.aiq_claim_storage_deletions_reference_core(
      max_rows, requested_lease_seconds
    );
end;
$$;


--
-- Name: aiq_claim_submission(integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_claim_submission(requested_lease_seconds integer default 300) returns table(inbox_id uuid, idempotency_key text, package_sha256 text, body_bytes bigint, object_bucket text, object_key text, object_content_sha256 text, lease_token uuid, lease_expires_at timestamp with time zone, attempt integer)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  perform aiq_private.require_request_role('aiq_verifier');
  perform aiq_private.retire_expired_claim_artifact_references(100);
  return query
    select * from aiq_private.aiq_claim_submission_reference_core(
      requested_lease_seconds
    );
end;
$$;


--
-- Name: aiq_deactivate_storage_reference(text, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_deactivate_storage_reference(supplied_reference_type text, supplied_reference_key text) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  perform aiq_private.require_request_role('service_role');
  perform aiq_private.deactivate_storage_reference(
    supplied_reference_type, supplied_reference_key
  );
end;
$$;


--
-- Name: aiq_describe_web_rpc_contract(); Type: function; Schema: public; Owner: -
--

create function public.aiq_describe_web_rpc_contract() returns jsonb
    language sql stable security DEFINER
    SET search_path to ''
    as $$
  with expected(function_name, identity_arguments) as (
    values
      ('public_trend_points'::text, 'text'::text),
      ('aiq_gateway_role_probe', ''),
      ('aiq_enqueue_submission', 'jsonb, jsonb, jsonb'),
      ('aiq_record_artifact_ingress', 'text, text, text, bigint, jsonb'),
      ('aiq_register_storage_object', 'text, text, text, text, text, bigint, text, timestamp with time zone'),
      ('aiq_production_reference_status', 'text'),
      ('aiq_claim_submission', 'integer'),
      ('aiq_renew_submission_claim', 'uuid, uuid, integer'),
      ('aiq_ack_submission_claim', 'uuid, uuid, text'),
      ('aiq_resolve_claim_artifact', 'uuid, uuid, text, text'),
      ('aiq_stage_verifier_result', 'jsonb, uuid, uuid, integer'),
      ('aiq_record_verifier_attestation', 'text, text, jsonb, uuid, uuid, integer'),
      ('aiq_record_verification_rejection', 'text, text, jsonb, uuid, uuid, integer'),
      ('aiq_verify_and_publish', 'text, text, uuid, uuid, integer'),
      ('aiq_stage_calibration_verification', 'jsonb, uuid, uuid, integer'),
      ('aiq_record_calibration_attestation', 'jsonb, uuid, uuid, integer'),
      ('aiq_publish_calibration_evidence', 'text, text, uuid, uuid, integer')
  ),
  contracts as (
    select
      procedure.oid,
      procedure.proname::text as function_name,
      pg_catalog.pg_get_function_arguments(procedure.oid) as arguments,
      pg_catalog.pg_get_function_result(procedure.oid) as result,
      procedure.pronargdefaults as default_count,
      coalesce(procedure.proargmodes::text[], array[]::text[]) as argument_modes,
      jsonb_build_object(
        'anon', pg_catalog.has_function_privilege('anon', procedure.oid, 'execute'),
        'authenticated', pg_catalog.has_function_privilege(
          'authenticated', procedure.oid, 'execute'
        ),
        'service_role', pg_catalog.has_function_privilege(
          'service_role', procedure.oid, 'execute'
        ),
        'aiq_verifier', pg_catalog.has_function_privilege(
          'aiq_verifier', procedure.oid, 'execute'
        ),
        'aiq_publisher', pg_catalog.has_function_privilege(
          'aiq_publisher', procedure.oid, 'execute'
        )
      ) as executable_roles
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    join expected
      on expected.function_name = procedure.proname
      and expected.identity_arguments = pg_catalog.oidvectortypes(procedure.proargtypes)
    where namespace.nspname = 'public'
  )
  select case
    when count(*) = 17
      and count(distinct function_name) = 17
      and not exists (
        select 1
        from pg_catalog.pg_proc unexpected
        join pg_catalog.pg_namespace namespace
          on namespace.oid = unexpected.pronamespace
        where namespace.nspname = 'public'
          and unexpected.proname in (select function_name from expected)
          and not exists (
            select 1
            from expected contract
            where contract.function_name = unexpected.proname
              and contract.identity_arguments =
                pg_catalog.oidvectortypes(unexpected.proargtypes)
          )
          and (
            pg_catalog.has_function_privilege(
              'anon', unexpected.oid, 'execute'
            )
            or pg_catalog.has_function_privilege(
              'authenticated', unexpected.oid, 'execute'
            )
            or pg_catalog.has_function_privilege(
              'service_role', unexpected.oid, 'execute'
            )
            or pg_catalog.has_function_privilege(
              'aiq_verifier', unexpected.oid, 'execute'
            )
            or pg_catalog.has_function_privilege(
              'aiq_publisher', unexpected.oid, 'execute'
            )
          )
      )
    then
      jsonb_agg(
        jsonb_build_object(
          'name', function_name,
          'arguments', arguments,
          'result', result,
          'default_count', default_count,
          'argument_modes', to_jsonb(argument_modes),
          'executable_roles', executable_roles
        )
        order by function_name
      )
    else null
  end
  from contracts;
$$;


--
-- Name: function aiq_describe_web_rpc_contract(); Type: COMMENT; Schema: public; Owner: -
--

comment on function public.aiq_describe_web_rpc_contract() IS 'Service-only exact RPC signature and role contract used by production readiness checks.';


--
-- Name: enqueue_submission_core(jsonb, jsonb); Type: function; Schema: aiq_private; Owner: -
--

create function aiq_private.enqueue_submission_core(envelope jsonb, request_context jsonb) returns table(inbox_id uuid, disposition text)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  queued_id uuid;
  existing_record aiq_private.aiq_submission_inbox%rowtype;
  supplied_idempotency_key text;
  supplied_package_sha256 text;
  supplied_received_at timestamptz;
begin
  perform aiq_private.require_request_role('service_role');
  if not (
      aiq_private.result_package_v3_is_valid(envelope) is true
      or aiq_private.calibration_package_v3_is_valid(envelope) is true
    )
    or jsonb_typeof(request_context) is distinct from 'object'
    or not aiq_private.has_exact_jsonb_keys(request_context, array[
      'body_bytes','idempotency_key','package_sha256','received_at','source'
    ]::text[])
    or jsonb_typeof(request_context -> 'idempotency_key') <> 'string'
    or jsonb_typeof(request_context -> 'package_sha256') <> 'string'
    or jsonb_typeof(request_context -> 'received_at') <> 'string'
    or jsonb_typeof(request_context -> 'source') <> 'string'
    or not aiq_private.dto_uint_is_valid(request_context -> 'body_bytes', 3948544)
    or (request_context ->> 'body_bytes')::bigint not between 1 and 3948544
    or not aiq_private.jsonb_sha256_field_is_valid(
      request_context, 'package_sha256', false
    )
  then raise exception 'invalid signed result or calibration package or request context'
    using errcode = '22023';
  end if;
  supplied_idempotency_key := envelope ->> 'idempotency_key';
  supplied_package_sha256 := request_context ->> 'package_sha256';
  begin
    supplied_received_at := (request_context ->> 'received_at')::timestamptz;
  exception when others then
    raise exception 'request_context.received_at must be a timestamp'
      using errcode = '22023';
  end;
  if request_context ->> 'idempotency_key' is distinct from supplied_idempotency_key
    or request_context ->> 'source' is not distinct from ''
    or supplied_received_at is null
  then raise exception 'invalid result package identity or request context'
    using errcode = '22023';
  end if;
  insert into aiq_private.aiq_submission_inbox (
    idempotency_key, package_sha256, envelope, request_context,
    received_at, expires_at
  ) values (
    supplied_idempotency_key, supplied_package_sha256, envelope,
    request_context, supplied_received_at, supplied_received_at + interval '30 days'
  )
  on conflict (idempotency_key) do nothing
  returning aiq_submission_inbox.inbox_id into queued_id;
  if queued_id is not null then
    return query select queued_id, 'accepted'::text; return;
  end if;
  select * into existing_record
  from aiq_private.aiq_submission_inbox queued
  where queued.idempotency_key = supplied_idempotency_key
  for update;
  if existing_record.package_sha256 is not distinct from supplied_package_sha256
    and existing_record.envelope is not distinct from envelope
  then return query select existing_record.inbox_id, 'duplicate'::text; return;
  end if;
  if exists (
      select 1 from aiq_private.aiq_submission_conflicts conflict
      where conflict.inbox_id = existing_record.inbox_id
        and conflict.package_sha256 = supplied_package_sha256
    )
    or (select count(*) from aiq_private.aiq_submission_conflicts conflict
        where conflict.inbox_id = existing_record.inbox_id
          and conflict.retention_state = 'active') >= 8
    or (select coalesce(sum((conflict.request_context ->> 'body_bytes')::bigint),0)
        from aiq_private.aiq_submission_conflicts conflict
        where conflict.inbox_id = existing_record.inbox_id
          and conflict.retention_state = 'active')
        + (request_context ->> 'body_bytes')::bigint > 16777216
  then return query select existing_record.inbox_id, 'conflict'::text; return;
  end if;
  insert into aiq_private.aiq_submission_conflicts (
    inbox_id,idempotency_key,package_sha256,envelope,request_context,expires_at
  ) values (
    existing_record.inbox_id,supplied_idempotency_key,supplied_package_sha256,
    envelope,request_context,greatest(now(),supplied_received_at)+interval '90 days'
  );
  return query select existing_record.inbox_id, 'conflict'::text;
end;
$$;


--
-- Name: aiq_enqueue_submission(jsonb, jsonb, jsonb); Type: function; Schema: public; Owner: -
--

create function public.aiq_enqueue_submission(envelope jsonb, request_context jsonb, object_identity jsonb) returns table(inbox_id uuid, disposition text, object_recorded boolean)
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  result_record record;
  supplied_digest text;
  supplied_bytes bigint;
  binding_recorded boolean := true;
begin
  perform aiq_private.require_request_role('service_role');
  if not aiq_private.has_exact_jsonb_keys(
    object_identity,
    array['bucket', 'bytes', 'content_sha256', 'key']::text[]
  )
    or jsonb_typeof(object_identity -> 'bucket') is distinct from 'string'
    or jsonb_typeof(object_identity -> 'key') is distinct from 'string'
    or jsonb_typeof(object_identity -> 'content_sha256') is distinct from 'string'
    or jsonb_typeof(object_identity -> 'bytes') is distinct from 'number'
    or (object_identity ->> 'bytes') !~ '^[0-9]+$'
  then
    raise exception 'invalid submission object identity' using errcode = '22023';
  end if;
  supplied_digest := request_context ->> 'package_sha256';
  supplied_bytes := (object_identity ->> 'bytes')::bigint;
  if object_identity ->> 'bucket' = ''
    or object_identity ->> 'key' is distinct from 'sha256/' || supplied_digest
    or object_identity ->> 'content_sha256' is distinct from supplied_digest
    or supplied_bytes is distinct from (request_context ->> 'body_bytes')::bigint
    or supplied_bytes not between 1 and 4194304
  then
    raise exception 'submission object identity does not bind request bytes'
      using errcode = '22023';
  end if;

  select * into strict result_record
  from aiq_private.enqueue_submission_core(envelope, request_context);

  if result_record.disposition in ('accepted', 'duplicate') then
    update aiq_private.aiq_submission_inbox inbox
    set object_bucket = object_identity ->> 'bucket',
        object_key = object_identity ->> 'key',
        object_content_sha256 = object_identity ->> 'content_sha256',
        object_bytes = supplied_bytes
    where inbox.inbox_id = result_record.inbox_id
      and inbox.object_bucket is null;
    if not exists (
      select 1 from aiq_private.aiq_submission_inbox inbox
      where inbox.inbox_id = result_record.inbox_id
        and inbox.object_bucket = object_identity ->> 'bucket'
        and inbox.object_key = object_identity ->> 'key'
        and inbox.object_content_sha256 = supplied_digest
        and inbox.object_bytes = supplied_bytes
    ) then
      raise exception 'duplicate submission object binding differs' using errcode = '23505';
    end if;
  else
    update aiq_private.aiq_submission_conflicts conflict
    set object_bucket = object_identity ->> 'bucket',
        object_key = object_identity ->> 'key',
        object_content_sha256 = object_identity ->> 'content_sha256',
        object_bytes = supplied_bytes
    where conflict.inbox_id = result_record.inbox_id
      and conflict.package_sha256 = supplied_digest
      and conflict.object_bucket is null;
    if exists (
      select 1 from aiq_private.aiq_submission_conflicts conflict
      where conflict.inbox_id = result_record.inbox_id
        and conflict.package_sha256 = supplied_digest
        and (
          conflict.object_bucket is distinct from object_identity ->> 'bucket'
          or conflict.object_key is distinct from object_identity ->> 'key'
          or conflict.object_content_sha256 is distinct from supplied_digest
          or conflict.object_bytes is distinct from supplied_bytes
        )
    ) then
      raise exception 'conflict submission object binding differs' using errcode = '23505';
    end if;
    -- The enqueue contract returns conflict after its bounded evidence
    -- quota is full. Existing recorded conflicts are bound above; later
    -- over-quota objects stay content-addressed for operator reconciliation.
    select exists (
      select 1 from aiq_private.aiq_submission_conflicts conflict
      where conflict.inbox_id = result_record.inbox_id
        and conflict.package_sha256 = supplied_digest
        and conflict.object_bucket = object_identity ->> 'bucket'
        and conflict.object_key = object_identity ->> 'key'
        and conflict.object_content_sha256 = supplied_digest
        and conflict.object_bytes = supplied_bytes
    ) into binding_recorded;
  end if;
  return query select result_record.inbox_id, result_record.disposition, binding_recorded;
end;
$_$;


--
-- Name: aiq_gateway_role_probe(); Type: function; Schema: public; Owner: -
--

create function public.aiq_gateway_role_probe() returns text
    language plpgsql stable
    SET search_path to ''
    as $$
declare
  claims jsonb;
  claimed_role text;
begin
  begin
    claims := nullif(
      current_setting('request.jwt.claims', true),
      ''
    )::jsonb;
  exception
    when invalid_text_representation then
      raise exception 'gateway role identity is invalid'
        using errcode = '42501';
  end;
  if jsonb_typeof(claims) is distinct from 'object' then
    raise exception 'gateway role identity is invalid'
      using errcode = '42501';
  end if;
  claimed_role := claims ->> 'role';
  if claimed_role not in ('aiq_verifier', 'aiq_publisher')
    or current_setting('role', true) is distinct from claimed_role
  then
    raise exception 'request and database gateway roles do not match'
      using errcode = '42501';
  end if;
  return claimed_role;
end;
$$;


--
-- Name: function aiq_gateway_role_probe(); Type: COMMENT; Schema: public; Owner: -
--

comment on function public.aiq_gateway_role_probe() IS 'Read-only readiness probe for the exact custom role assumed by the Supabase gateway.';


--
-- Name: aiq_list_storage_reconciliation(text, text, text, integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_list_storage_reconciliation(supplied_bucket text, after_path text, after_mismatch_type text, max_rows integer) returns table(object_path text, mismatch_type text)
    language plpgsql stable security DEFINER
    SET search_path to ''
    as $_$
begin
  perform aiq_private.require_request_role('service_role');
  if not coalesce(supplied_bucket ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$', false)
    or max_rows not between 1 and 1000
    or ((after_path is null) is distinct from (after_mismatch_type is null))
    or (after_path is not null and after_path !~ '^sha256/[0-9a-f]{64}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$')
    or (after_mismatch_type is not null and after_mismatch_type not in (
      'storage_only', 'registry_only', 'identity_mismatch'
    ))
  then
    raise exception 'invalid Storage reconciliation page' using errcode = '22023';
  end if;
  return query
  select event.object_path, event.mismatch_type
  from aiq_private.aiq_storage_reconciliation_events event
  where event.bucket_name = supplied_bucket
    and event.resolved_at is null
    and (
      after_path is null
      or (event.object_path, event.mismatch_type) > (after_path, after_mismatch_type)
    )
  order by event.object_path, event.mismatch_type
  limit max_rows;
end;
$_$;


--
-- Name: aiq_list_storage_registry(text, text, integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_list_storage_registry(supplied_bucket text, after_path text, max_rows integer) returns table(object_id uuid, object_path text, content_sha256 text, byte_size bigint, lifecycle_state text, legal_hold boolean, active_references bigint)
    language plpgsql stable security DEFINER
    SET search_path to ''
    as $_$
begin
  perform aiq_private.require_request_role('service_role');
  if not coalesce(supplied_bucket ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$', false)
    or max_rows not between 1 and 1000
    or (after_path is not null and after_path !~ '^sha256/[0-9a-f]{64}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$')
  then raise exception 'invalid Storage registry page' using errcode = '22023'; end if;
  return query
  with page as (
    select object.object_id, object.object_path, object.content_sha256,
      object.byte_size, object.lifecycle_state, object.legal_hold
    from aiq_private.aiq_storage_objects object
    where object.bucket_name = supplied_bucket
      and (after_path is null or object.object_path > after_path)
    order by object.object_path
    limit max_rows
  )
  select page.object_id, page.object_path, page.content_sha256,
    page.byte_size, page.lifecycle_state, page.legal_hold,
    (
      select count(*)
      from aiq_private.aiq_storage_object_references reference
      where reference.object_id = page.object_id and reference.active
    )
  from page
  order by page.object_path;
end;
$_$;


--
-- Name: aiq_production_reference_status(text); Type: function; Schema: public; Owner: -
--

create function public.aiq_production_reference_status(expected_publisher_node_id text) returns jsonb
    language plpgsql stable security DEFINER
    SET search_path to ''
    as $$
begin
  perform aiq_private.require_request_role('service_role');
  return (
  with expected_models(
    model_config_id, provider, model_family, provider_model_id,
    reasoning_effort, matrix_order
  ) as (
    values
      ('sol-low', 'openai', 'sol', 'gpt-5.6-sol', 'low', 1),
      ('sol-medium', 'openai', 'sol', 'gpt-5.6-sol', 'medium', 2),
      ('sol-high', 'openai', 'sol', 'gpt-5.6-sol', 'high', 3),
      ('sol-xhigh', 'openai', 'sol', 'gpt-5.6-sol', 'xhigh', 4),
      ('sol-max', 'openai', 'sol', 'gpt-5.6-sol', 'max', 5),
      ('sol-ultra', 'openai', 'sol', 'gpt-5.6-sol', 'ultra', 6),
      ('terra-low', 'openai', 'terra', 'gpt-5.6-terra', 'low', 7),
      ('terra-medium', 'openai', 'terra', 'gpt-5.6-terra', 'medium', 8),
      ('terra-high', 'openai', 'terra', 'gpt-5.6-terra', 'high', 9),
      ('terra-xhigh', 'openai', 'terra', 'gpt-5.6-terra', 'xhigh', 10),
      ('terra-max', 'openai', 'terra', 'gpt-5.6-terra', 'max', 11),
      ('terra-ultra', 'openai', 'terra', 'gpt-5.6-terra', 'ultra', 12),
      ('luna-low', 'openai', 'luna', 'gpt-5.6-luna', 'low', 13),
      ('luna-medium', 'openai', 'luna', 'gpt-5.6-luna', 'medium', 14),
      ('luna-high', 'openai', 'luna', 'gpt-5.6-luna', 'high', 15),
      ('luna-xhigh', 'openai', 'luna', 'gpt-5.6-luna', 'xhigh', 16),
      ('luna-max', 'openai', 'luna', 'gpt-5.6-luna', 'max', 17)
  ),
  model_facts as (
    select
      count(*) filter (
        where actual.expected_in_matrix and actual.is_enabled
      )::integer as enabled_count,
      count(*) filter (
        where actual.model_config_id is null
          or not actual.expected_in_matrix
          or not actual.is_enabled
          or actual.provider is distinct from expected.provider
          or actual.model_family is distinct from expected.model_family
          or actual.provider_model_id is distinct from expected.provider_model_id
          or actual.reasoning_effort is distinct from expected.reasoning_effort
          or actual.matrix_order is distinct from expected.matrix_order
      )::integer as mismatch_count
    from expected_models expected
    full join aiq_private.aiq_model_configs actual
      on actual.model_config_id = expected.model_config_id
      and actual.expected_in_matrix
  ),
  scoring_facts as (
    select
      count(*)::integer as scoring_count,
      count(*) filter (
        where scoring.benchmark_version = 'aiq-core@1.0.5'
          and scoring.is_published
          and not scoring.synthetic
          and scoring.formula = '{
            "aggregate":"mean_of_domain_means",
            "coverage_multiplier":false,
            "domain_weight":0.1,
            "official_valid_task_count":72,
            "official_covered_domain_count":10,
            "synthetic_complete":{
              "covered_domain_count":10,
              "official_aiq":null,
              "ranking_eligible":false,
              "valid_task_count":72
            }
          }'::jsonb
          and scoring.interval_method = '{
            "central_mass":0.95,
            "deviation_scale":1.3,
            "method":"finite_cluster_calibrated_percentile_sensitivity_v1",
            "samples":10000,
            "scope":"fixed_fixture_calibrated_sensitivity",
            "synthetic":false,
            "universal_confidence_interval":false
          }'::jsonb
          and scoring.failure_policy = '{
            "attributable_failure_score":0,
            "infrastructure_failure_score":null,
            "missing_blocks_official":true,
            "provisional_ranked":false,
            "synthetic_complete_ranked":false
          }'::jsonb
      )::integer as valid_scoring_count
    from aiq_private.aiq_scoring_versions scoring
    where scoring.scoring_version = '1.0.5'
  ),
  task_facts as (
    select
      count(*)::integer as task_count,
      count(distinct task.task_id)::integer as distinct_task_count,
      count(*) filter (where task.domain = 'coding')::integer as coding_count,
      count(*) filter (where task.domain = 'debugging')::integer as debugging_count,
      count(*) filter (where task.domain = 'repository_understanding')::integer
        as repository_understanding_count,
      count(*) filter (where task.domain = 'data_processing')::integer
        as data_processing_count,
      count(*) filter (where task.domain = 'retrieval_verification')::integer
        as retrieval_verification_count,
      count(*) filter (where task.domain = 'documentation_communication')::integer
        as documentation_communication_count,
      count(*) filter (where task.domain = 'planning_execution')::integer
        as planning_execution_count,
      count(*) filter (where task.domain = 'tool_use')::integer as tool_use_count,
      count(*) filter (where task.domain = 'instruction_following')::integer
        as instruction_following_count,
      count(*) filter (where task.domain = 'reliability_recovery')::integer
        as reliability_recovery_count,
      case when count(*) = 72 and count(task.fixture_commitment) = 72
        then aiq_private.jcs_sha256(
          jsonb_agg(
            'sha256:' || task.fixture_commitment
            order by ('sha256:' || task.fixture_commitment) collate "C"
          )
        )
        else null
      end as task_set_identity_sha256
    from aiq_private.aiq_task_catalog task
    where task.task_set_id = 'aiq-core'
      and task.task_set_version = '1.0.5'
  ),
  catalog_facts as (
    select
      case when count(*) = 1
        then 'sha256:' || min(task_set.catalog_sha256)
        else null
      end as catalog_identity_sha256,
      case when count(*) = 1
        then min(task_set.metadata ->> 'evaluator_identity_sha256')
        else null
      end as evaluator_identity_sha256
    from aiq_private.aiq_task_sets task_set
    where task_set.task_set_id = 'aiq-core'
      and task_set.task_set_version = '1.0.5'
  ),
  eligible_nodes as (
    select node.node_id, 'runner'::text as approved_role
    from aiq_private.aiq_nodes node
    where node.status = 'active'
      and not node.synthetic
      and node.public_visible
      and node.signature_algorithm = 'ed25519'
      and node.signature_status = 'verified'
      and node.trust_tier in ('trusted_verified', 'independently_reproduced')
      and node.operator_class = 'official'
      and node.metadata ->> 'approved_role' = 'runner'
      and node.capabilities @> array['runner']::text[]
      and node.key_fingerprint = 'sha256:' || substring(node.node_id from 6)
      and aiq_private.node_public_key_matches_id(node.node_id, node.public_key)
    union all
    select node.node_id, 'verifier'
    from aiq_private.aiq_nodes node
    where node.status = 'active'
      and not node.synthetic
      and node.public_visible
      and node.signature_algorithm = 'ed25519'
      and node.signature_status = 'verified'
      and node.trust_tier in ('trusted_verified', 'independently_reproduced')
      and node.operator_class = 'verifier'
      and node.metadata ->> 'approved_role' = 'verifier'
      and node.capabilities @> array['verifier']::text[]
      and node.key_fingerprint = 'sha256:' || substring(node.node_id from 6)
      and aiq_private.node_public_key_matches_id(node.node_id, node.public_key)
    union all
    select node.node_id, 'publisher'
    from aiq_private.aiq_nodes node
    where node.node_id = expected_publisher_node_id
      and node.status = 'active'
      and not node.synthetic
      and node.public_visible
      and node.signature_algorithm = 'ed25519'
      and node.signature_status = 'verified'
      and node.trust_tier = 'trusted_verified'
      and node.operator_class = 'official'
      and node.publisher_authorized
      and node.metadata ->> 'approved_role' = 'publisher'
      and node.capabilities @> array['publisher']::text[]
      and node.key_fingerprint = 'sha256:' || substring(node.node_id from 6)
      and aiq_private.node_public_key_matches_id(node.node_id, node.public_key)
  ),
  node_facts as (
    select
      count(*)::integer as node_count,
      count(distinct node.node_id)::integer as distinct_node_count,
      count(*) filter (where node.approved_role = 'runner')::integer
        as runner_count,
      count(*) filter (where node.approved_role = 'verifier')::integer
        as verifier_count,
      count(*) filter (where node.approved_role = 'publisher')::integer
        as publisher_count
    from eligible_nodes node
  ),
  schema_facts as (
    select
      count(*)::integer as private_table_count,
      count(*) filter (
        where relation.relrowsecurity and relation.relforcerowsecurity
      )::integer as forced_rls_table_count
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid=relation.relnamespace
    where namespace.nspname='aiq_private'
      and relation.relkind in ('r','p')
  ),
  view_facts as (
    select count(*)::integer as public_view_count,
      count(*) filter(where coalesce(relation.reloptions,array[]::text[])
        @>array['security_invoker=true'])::integer as security_invoker_view_count,
      count(*)::integer as canonical_public_view_count
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid=relation.relnamespace
    where namespace.nspname='public' and relation.relkind='v'
      and relation.relname in (
        'public_distributed_radar','public_leaderboard','public_model_matrix',
        'public_nodes','public_run_results','public_runs',
        'public_scoring_versions','public_task_coverage',
        'public_calibration_runs','public_calibration_results',
        'public_calibration_scores','public_model_efficiency'
      )
  ),
  role_facts as (
    select count(*)::integer as hardened_gateway_role_count
    from pg_catalog.pg_roles gateway_role
    where gateway_role.rolname in ('aiq_verifier','aiq_publisher')
      and not gateway_role.rolsuper and not gateway_role.rolcreatedb
      and not gateway_role.rolcreaterole and not gateway_role.rolreplication
      and not gateway_role.rolbypassrls and not gateway_role.rolcanlogin
      and not gateway_role.rolinherit
      and pg_catalog.pg_has_role('authenticator',gateway_role.rolname,'MEMBER')
  ),
  facts as (
    select
      model_facts.*,
      scoring_facts.*,
      task_facts.*,
      catalog_facts.*,
      node_facts.*,
      schema_facts.*,
      view_facts.*,
      role_facts.*,
      aiq_private.frozen_catalog_identity_is_valid(
        'aiq-core', '1.0.5', '1.0.5'
      ) as frozen_catalog_valid
    from model_facts
    cross join scoring_facts
    cross join task_facts
    cross join catalog_facts
    cross join node_facts
    cross join schema_facts
    cross join view_facts
    cross join role_facts
  )
  select jsonb_build_object(
    'initialized',
      enabled_count = 17 and mismatch_count = 0
      and scoring_count = 1 and valid_scoring_count = 1
      and task_count = 72 and distinct_task_count = 72
      and coding_count = 8 and debugging_count = 8
      and repository_understanding_count = 7 and data_processing_count = 8
      and retrieval_verification_count = 7
      and documentation_communication_count = 7
      and planning_execution_count = 7 and tool_use_count = 7
      and instruction_following_count = 6 and reliability_recovery_count = 7
      and task_set_identity_sha256 =
        'sha256:f6fc21fa2deb3788c186437c45f8e1c8d5d1e366d32bc81e3b5f847e9844cf05'
      and frozen_catalog_valid
      and evaluator_identity_sha256 =
        'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c'
      and node_count = 3 and distinct_node_count = 3
      and runner_count = 1
      and verifier_count = 1 and publisher_count = 1
      and private_table_count=40 and forced_rls_table_count=40
      and public_view_count=12 and security_invoker_view_count=12
      and canonical_public_view_count=12
      and hardened_gateway_role_count=2,
    'model_config_count', enabled_count,
    'model_config_mismatch_count', mismatch_count,
    'scoring_version_count', scoring_count,
    'scoring_version_valid', valid_scoring_count = 1,
    'task_count', task_count,
    'distinct_task_count', distinct_task_count,
    'domain_counts', jsonb_build_object(
      'coding', coding_count,
      'debugging', debugging_count,
      'repository_understanding', repository_understanding_count,
      'data_processing', data_processing_count,
      'retrieval_verification', retrieval_verification_count,
      'documentation_communication', documentation_communication_count,
      'planning_execution', planning_execution_count,
      'tool_use', tool_use_count,
      'instruction_following', instruction_following_count,
      'reliability_recovery', reliability_recovery_count
    ),
    'catalog_identity_sha256', catalog_identity_sha256,
    'task_set_identity_sha256', task_set_identity_sha256,
    'task_set_identity_valid', task_set_identity_sha256 =
      'sha256:f6fc21fa2deb3788c186437c45f8e1c8d5d1e366d32bc81e3b5f847e9844cf05',
    'evaluator_identity_sha256', evaluator_identity_sha256,
    'evaluator_identity_valid', evaluator_identity_sha256 =
      'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c',
    'frozen_catalog_valid', frozen_catalog_valid,
    'production_node_count', node_count,
    'distinct_production_node_count', distinct_node_count,
    'runner_count', runner_count,
    'verifier_count', verifier_count,
    'publisher_count', publisher_count,
    'private_table_count', private_table_count,
    'forced_rls_table_count', forced_rls_table_count,
    'public_view_count', public_view_count,
    'security_invoker_view_count', security_invoker_view_count,
    'hardened_gateway_role_count', hardened_gateway_role_count
  )
  from facts
  );
end;
$$;


--
-- Name: aiq_promote_storage_orphan(text, text, text, text, text, bigint); Type: function; Schema: public; Owner: -
--

create function public.aiq_promote_storage_orphan(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint) returns uuid
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  event_record aiq_private.aiq_storage_reconciliation_events%rowtype;
begin
  perform aiq_private.require_request_role('service_role');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.storage.inventory-deletion-gate',71783153620529
  ));
  select * into event_record
  from aiq_private.aiq_storage_reconciliation_events event
  where event.bucket_name = supplied_bucket
    and event.object_path = supplied_path
    and event.mismatch_type = 'storage_only'
    and event.resolved_at is null
  for update;
  if event_record.event_id is null
    or event_record.eligible_after is null
    or event_record.eligible_after > clock_timestamp()
  then
    return null;
  end if;
  return aiq_private.ensure_storage_object(
    supplied_object_type, supplied_artifact_kind, supplied_bucket, supplied_path,
    supplied_sha256, supplied_bytes, 'ephemeral_30d', event_record.eligible_after
  );
end;
$$;


--
-- Name: aiq_purge_expired_artifact_ingress(integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_purge_expired_artifact_ingress(max_rows integer) returns table(claims_purged integer, objects_purged integer)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  deleted_claims integer;
  deleted_objects integer;
begin
  perform aiq_private.require_request_role('service_role');
  if max_rows not between 1 and 1000 then
    raise exception 'artifact purge max_rows must be between 1 and 1000'
      using errcode = '22023';
  end if;
  with candidates as (
    select ingress_claim.ctid
    from aiq_private.aiq_artifact_ingress_claims ingress_claim
    where ingress_claim.expires_at <= now()
      and not exists (
        select 1
        from aiq_private.aiq_artifact_claim_bindings binding
        join aiq_private.aiq_submission_inbox inbox on inbox.inbox_id = binding.inbox_id
        where inbox.idempotency_key = ingress_claim.claimed_run_id
          and binding.artifact_kind = ingress_claim.artifact_kind
          and binding.content_sha256 = ingress_claim.content_sha256
      )
    order by ingress_claim.expires_at
    for update skip locked
    limit max_rows
  )
  delete from aiq_private.aiq_artifact_ingress_claims ingress_claim
  using candidates
  where ingress_claim.ctid = candidates.ctid;
  get diagnostics deleted_claims = row_count;

  with candidates as (
    select artifact.ctid
    from aiq_private.aiq_artifact_ingress_objects artifact
    where artifact.expires_at <= now()
      and not exists (
        select 1 from aiq_private.aiq_artifact_ingress_claims ingress_claim
        where ingress_claim.artifact_kind = artifact.artifact_kind
          and ingress_claim.content_sha256 = artifact.content_sha256
      )
      and not exists (
        select 1 from aiq_private.aiq_artifact_claim_bindings binding
        where binding.artifact_kind = artifact.artifact_kind
          and binding.content_sha256 = artifact.content_sha256
      )
    order by artifact.expires_at
    for update skip locked
    limit max_rows
  )
  delete from aiq_private.aiq_artifact_ingress_objects artifact
  using candidates
  where artifact.ctid = candidates.ctid;
  get diagnostics deleted_objects = row_count;
  return query select deleted_claims, deleted_objects;
end;
$$;


--
-- Name: aiq_purge_expired_submissions(integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_purge_expired_submissions(max_rows integer) returns table(conflicts_purged integer, inbox_rows_purged integer)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  conflict_count integer;
  inbox_count integer;
begin
  perform aiq_private.require_request_role('service_role');
  if max_rows is null or max_rows < 1 or max_rows > 1000 then
    raise exception 'max_rows must be between 1 and 1000' using errcode = '22023';
  end if;
  with candidates as (
    select conflict.conflict_id
    from aiq_private.aiq_submission_conflicts conflict
    where conflict.expires_at <= now()
      and conflict.retention_state = 'active'
      and not exists (
        select 1 from aiq_private.aiq_verification_audit audit
        where audit.inbox_id = conflict.inbox_id
      )
      and not exists (
        select 1 from aiq_private.aiq_matrix_batches batch
        join aiq_private.aiq_submission_inbox inbox
          on inbox.package_sha256 = batch.package_sha256
        where inbox.inbox_id = conflict.inbox_id
      )
    order by conflict.expires_at
    limit max_rows for update skip locked
  )
  delete from aiq_private.aiq_submission_conflicts conflict
  using candidates where conflict.conflict_id = candidates.conflict_id;
  get diagnostics conflict_count = row_count;
  with candidates as (
    select inbox.inbox_id
    from aiq_private.aiq_submission_inbox inbox
    where inbox.expires_at <= now()
      and inbox.retention_state = 'active'
      and not exists (
        select 1 from aiq_private.aiq_submission_conflicts conflict
        where conflict.inbox_id = inbox.inbox_id
      )
      and not exists (
        select 1 from aiq_private.aiq_verification_audit audit
        where audit.inbox_id = inbox.inbox_id
      )
      and not exists (
        select 1 from aiq_private.aiq_matrix_batches batch
        where batch.package_sha256 = inbox.package_sha256
      )
    order by inbox.expires_at
    limit max_rows for update skip locked
  )
  delete from aiq_private.aiq_submission_inbox inbox
  using candidates where inbox.inbox_id = candidates.inbox_id;
  get diagnostics inbox_count = row_count;
  return query select conflict_count, inbox_count;
end;
$$;


--
-- Name: aiq_record_artifact_ingress(text, text, text, bigint, jsonb); Type: function; Schema: public; Owner: -
--

create function public.aiq_record_artifact_ingress(target_run_id text, supplied_kind text, supplied_sha256 text, supplied_byte_size bigint, object_identity jsonb) returns text
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  existing_object aiq_private.aiq_artifact_ingress_objects%rowtype;
  claim_inserted integer;
begin
  perform aiq_private.require_request_role('service_role');
  if not coalesce(target_run_id ~ '^run_[0-9a-f]{64}$', false)
    or supplied_kind not in (
      'evaluator-results.json', 'final-response.txt', 'stderr.txt', 'stdout.jsonl',
      'workspace-manifest.json', 'workspace-snapshot.json'
    )
    or not coalesce(supplied_sha256 ~ '^[0-9a-f]{64}$', false)
    or supplied_byte_size not between 1 and (
      case when supplied_kind = 'evaluator-results.json' then 3948544 else 4194304 end
    )
    or not aiq_private.has_exact_jsonb_keys(
      object_identity, array['bucket', 'key']::text[]
    )
    or jsonb_typeof(object_identity -> 'bucket') is distinct from 'string'
    or jsonb_typeof(object_identity -> 'key') is distinct from 'string'
    or object_identity ->> 'bucket' = ''
    or object_identity ->> 'key'
      is distinct from 'sha256/' || supplied_sha256 || '/' || supplied_kind
  then
    raise exception 'invalid artifact ingress identity' using errcode = '22023';
  end if;

  insert into aiq_private.aiq_artifact_ingress_objects (
    artifact_kind, content_sha256, bucket_name, object_path, byte_size
  ) values (
    supplied_kind, supplied_sha256, object_identity ->> 'bucket',
    object_identity ->> 'key', supplied_byte_size
  )
  on conflict (artifact_kind, content_sha256) do nothing;

  select * into strict existing_object
  from aiq_private.aiq_artifact_ingress_objects artifact
  where artifact.artifact_kind = supplied_kind
    and artifact.content_sha256 = supplied_sha256;
  if row(
    existing_object.bucket_name, existing_object.object_path, existing_object.byte_size
  ) is distinct from row(
    object_identity ->> 'bucket', object_identity ->> 'key', supplied_byte_size
  ) then
    raise exception 'artifact ingress conflicts with immutable object evidence'
      using errcode = '23505';
  end if;

  insert into aiq_private.aiq_artifact_ingress_claims (
    claimed_run_id, artifact_kind, content_sha256
  ) values (target_run_id, supplied_kind, supplied_sha256)
  on conflict do nothing;
  get diagnostics claim_inserted = row_count;
  if claim_inserted = 0 then
    return 'duplicate';
  end if;
  return 'accepted';
end;
$_$;


--
-- Name: aiq_record_storage_reconciliation(text, text, text, text, timestamp with time zone); Type: function; Schema: public; Owner: -
--

create function public.aiq_record_storage_reconciliation(supplied_bucket text, supplied_path text, supplied_mismatch_type text, supplied_detail_code text, supplied_eligible_after timestamp with time zone) returns uuid
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  recorded_id uuid;
  database_now timestamptz;
begin
  perform aiq_private.require_request_role('service_role');
  if not coalesce(supplied_bucket ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$', false)
    or not coalesce(supplied_path ~ '^sha256/[0-9a-f]{64}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$', false)
    or supplied_mismatch_type not in ('storage_only', 'registry_only', 'identity_mismatch')
    or not coalesce(supplied_detail_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$', false)
    or (supplied_mismatch_type = 'storage_only' and supplied_eligible_after is null)
  then raise exception 'invalid Storage reconciliation event' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.storage.inventory-deletion-gate',71783153620529
  ));
  database_now:=clock_timestamp();
  insert into aiq_private.aiq_storage_reconciliation_events (
    bucket_name, object_path, mismatch_type,observed_at,eligible_after,
    detail_code,last_observed_at
  ) values (
    supplied_bucket, supplied_path, supplied_mismatch_type,database_now,
    supplied_eligible_after,supplied_detail_code,database_now
  ) on conflict (bucket_name, object_path, mismatch_type) do update
    set occurrence_count = aiq_storage_reconciliation_events.occurrence_count + 1,
        last_observed_at = database_now, detail_code = excluded.detail_code,
        eligible_after = case
          -- A resolved event that recurs is a new observation window. Reusing
          -- its historical deadline could make a reappearing object eligible
          -- before the configured grace period elapses.
          when aiq_storage_reconciliation_events.resolved_at is not null
            then excluded.eligible_after
          when aiq_storage_reconciliation_events.eligible_after is null
            then excluded.eligible_after
          when excluded.eligible_after is null
            then aiq_storage_reconciliation_events.eligible_after
          else least(
            aiq_storage_reconciliation_events.eligible_after,
            excluded.eligible_after
          )
        end,
        resolved_at = null
  returning event_id into recorded_id;
  return recorded_id;
end;
$_$;


--
-- Name: aiq_record_storage_inventory_epoch(bigint, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_record_storage_inventory_epoch(
  supplied_inventory_object_count bigint,supplied_inventory_digest text
) returns timestamp with time zone
    language plpgsql security definer
    SET search_path to ''
    as $$
declare
  database_now timestamptz;
  epoch_id uuid;
begin
  perform aiq_private.require_request_role('service_role');
  if supplied_inventory_object_count is null
    or supplied_inventory_object_count not between 0 and 9007199254740991
    or not coalesce(supplied_inventory_digest~'^sha256:[0-9a-f]{64}$',false)
  then raise exception 'invalid Storage inventory identity'
    using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.storage.inventory-deletion-gate',71783153620529
  ));
  database_now:=clock_timestamp();
  epoch_id:=extensions.gen_random_uuid();
  if exists(select 1 from aiq_private.aiq_storage_reconciliation_events event
      where event.mismatch_type in ('storage_only','registry_only','identity_mismatch')
        and event.resolved_at is null)
    or supplied_inventory_object_count<>(
      select count(*)
      from aiq_private.aiq_storage_objects object
      where object.lifecycle_state<>'deleted'
    )
    or supplied_inventory_digest is distinct from
      aiq_private.storage_registry_inventory_digest()
  then raise exception 'Storage inventory epoch is not reconciled with the registry'
    using errcode='55000'; end if;
  insert into aiq_private.aiq_storage_reconciliation_events(
    event_id,bucket_name,object_path,mismatch_type,observed_at,eligible_after,
    detail_code,resolved_at,inventory_object_count,inventory_digest,
    occurrence_count,last_observed_at
  ) values(
    epoch_id,'aiq-system','sha256/'||encode(extensions.digest(convert_to(
      epoch_id::text||':'||database_now::text||':'||supplied_inventory_object_count::text||
        ':'||supplied_inventory_digest,
      'utf8'
    ),'sha256'),'hex')||'/inventory','inventory_success',
    database_now,null,'inventory_complete',database_now,
    supplied_inventory_object_count,supplied_inventory_digest,1,database_now
  );
  return database_now;
end;
$$;


--
-- Name: aiq_record_verification_rejection(text, text, jsonb, uuid, uuid, integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_record_verification_rejection(target_run_id text, target_package_sha256 text, rejection jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  claimed := aiq_private.require_verification_claim(
    target_inbox_id, supplied_lease_token, supplied_attempt,
    target_run_id, target_package_sha256, 'rejected'
  );
  perform aiq_private.aiq_record_verification_rejection_unbound_core(
    target_run_id, target_package_sha256, rejection
  );
  if claimed.claim_ack is null then
    update aiq_private.aiq_submission_inbox inbox
    set claim_ack = 'completed', claim_expires_at = null
    where inbox.inbox_id = target_inbox_id
      and inbox.claim_token = supplied_lease_token
      and inbox.claim_attempts = supplied_attempt;
    perform aiq_private.retire_claim_artifact_references(
      target_inbox_id, supplied_lease_token, supplied_attempt, 'rejected'
    );
  end if;
end;
$$;


--
-- Name: aiq_record_verifier_attestation(text, text, jsonb, uuid, uuid, integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_record_verifier_attestation(target_run_id text, target_package_sha256 text, attestation jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  perform aiq_private.require_request_role('aiq_verifier');
  perform aiq_private.require_verification_claim(
    target_inbox_id, supplied_lease_token, supplied_attempt,
    target_run_id, target_package_sha256, 'published'
  );
  perform aiq_private.aiq_record_verifier_attestation_unbound_core(
    target_run_id, target_package_sha256, attestation
  );
end;
$$;


--
-- Name: aiq_register_storage_object(text, text, text, text, text, bigint, text, timestamp with time zone); Type: function; Schema: public; Owner: -
--

create function public.aiq_register_storage_object(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone) returns uuid
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
begin
  perform aiq_private.require_request_role('service_role');
  return aiq_private.ensure_storage_object(
    supplied_object_type, supplied_artifact_kind, supplied_bucket, supplied_path,
    supplied_sha256, supplied_bytes, supplied_retention_class, supplied_expires_at
  );
end;
$$;


--
-- Name: aiq_renew_submission_claim(uuid, uuid, integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_renew_submission_claim(target_inbox_id uuid, supplied_lease_token uuid, requested_lease_seconds integer) returns table(inbox_id uuid, lease_token uuid, lease_expires_at timestamp with time zone, attempt integer)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
  database_now timestamptz;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  if requested_lease_seconds is null
    or requested_lease_seconds not between 30 and 900
  then
    raise exception 'claim lease must be between 30 and 900 seconds'
      using errcode = '22023';
  end if;

  select * into claimed
  from aiq_private.aiq_submission_inbox candidate
  where candidate.inbox_id = target_inbox_id
  for update;
  database_now := clock_timestamp();
  if claimed.inbox_id is null
    or claimed.verification_status <> 'unverified'
    or claimed.claim_token is distinct from supplied_lease_token
    or claimed.claim_expires_at is null
    or claimed.claim_expires_at <= database_now
    or not (
      claimed.state = 'queued'
      or aiq_private.staged_submission_is_recoverable(claimed.inbox_id)
    )
  then
    raise exception 'claim lease is absent, stale, expired, or terminal'
      using errcode = '55000';
  end if;

  update aiq_private.aiq_submission_inbox candidate
  set claim_expires_at = greatest(
    candidate.claim_expires_at,
    database_now + make_interval(secs => requested_lease_seconds)
  )
  where candidate.inbox_id = target_inbox_id
  returning candidate.* into claimed;

  return query select
    claimed.inbox_id,
    claimed.claim_token,
    claimed.claim_expires_at,
    claimed.claim_attempts;
end;
$$;


--
-- Name: aiq_resolve_claim_artifact(uuid, uuid, text, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_resolve_claim_artifact(target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text) returns table(object_bucket text, object_key text, artifact_kind text, content_sha256 text, byte_size bigint, lease_expires_at timestamp with time zone)
    language plpgsql security DEFINER
    SET search_path to ''
    as $$
declare
  resolved record;
  supplied_attempt integer;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  select * into resolved
  from aiq_private.aiq_resolve_claim_artifact_reference_core(
    target_inbox_id, supplied_lease_token, requested_kind, requested_sha256
  );
  select inbox.claim_attempts into strict supplied_attempt
  from aiq_private.aiq_submission_inbox inbox
  where inbox.inbox_id = target_inbox_id
    and inbox.claim_token = supplied_lease_token
    and inbox.claim_expires_at > clock_timestamp()
  for update;
  perform aiq_private.activate_claim_artifact_reference(
    target_inbox_id, supplied_lease_token, supplied_attempt,
    requested_kind, requested_sha256
  );
  return query select
    resolved.object_bucket::text, resolved.object_key::text,
    resolved.artifact_kind::text, resolved.content_sha256::text,
    resolved.byte_size::bigint, resolved.lease_expires_at::timestamptz;
end;
$$;


--
-- Name: aiq_resolve_storage_reconciliation(text, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_resolve_storage_reconciliation(supplied_bucket text, supplied_path text) returns integer
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare resolved_count integer;
begin
  perform aiq_private.require_request_role('service_role');
  if not coalesce(supplied_bucket ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$', false)
    or not coalesce(supplied_path ~ '^sha256/[0-9a-f]{64}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$', false)
  then raise exception 'invalid Storage reconciliation identity' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.storage.inventory-deletion-gate',71783153620529
  ));
  update aiq_private.aiq_storage_reconciliation_events event
  set resolved_at = clock_timestamp()
  where event.bucket_name = supplied_bucket and event.object_path = supplied_path
    and event.mismatch_type in ('storage_only','registry_only','identity_mismatch')
    and event.resolved_at is null;
  get diagnostics resolved_count = row_count;
  return resolved_count;
end;
$_$;


--
-- Name: aiq_retry_storage_deletion(uuid, uuid, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_retry_storage_deletion(target_object_id uuid, supplied_lease_token uuid, supplied_error_code text) returns timestamp with time zone
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare
  object aiq_private.aiq_storage_objects%rowtype;
  retry_at timestamptz;
  database_now timestamptz := clock_timestamp();
begin
  perform aiq_private.require_request_role('service_role');
  if not coalesce(supplied_error_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$', false) then
    raise exception 'invalid sanitized Storage error code' using errcode = '22023';
  end if;
  select * into object from aiq_private.aiq_storage_objects candidate
  where candidate.object_id = target_object_id for update;
  if object.object_id is null
    or object.lifecycle_state <> 'delete_pending'
    or object.deletion_lease_token is distinct from supplied_lease_token
    or object.deletion_lease_expires_at <= database_now
  then
    raise exception 'Storage deletion claim is stale' using errcode = '55000';
  end if;
  retry_at := database_now + least(
    interval '6 hours',
    interval '30 seconds' * power(2::numeric, least(object.deletion_attempts - 1, 10))
  );
  update aiq_private.aiq_storage_objects candidate
  set lifecycle_state = 'active', deletion_lease_token = null,
      deletion_lease_expires_at = null, next_attempt_at = retry_at,
      last_outcome = 'retry', last_error_code = supplied_error_code,
      updated_at = database_now
  where candidate.object_id = target_object_id;
  return retry_at;
end;
$_$;


--
-- Name: aiq_set_storage_legal_hold(uuid, boolean, text, text); Type: function; Schema: public; Owner: -
--

create function public.aiq_set_storage_legal_hold(target_object_id uuid, hold_enabled boolean, supplied_reason text, supplied_actor text) returns text
    language plpgsql security DEFINER
    SET search_path to ''
    as $_$
declare target_state text;
begin
  perform aiq_private.require_request_role('service_role');
  if hold_enabled is null
    or (hold_enabled and not coalesce(supplied_reason ~ '^[a-z0-9][a-z0-9._:-]{0,127}$', false))
    or (not hold_enabled and supplied_reason is not null)
    or not coalesce(supplied_actor ~ '^[a-z0-9][a-z0-9._:@-]{0,127}$', false)
  then
    raise exception 'invalid legal hold request' using errcode = '22023';
  end if;
  select object.lifecycle_state into target_state
  from aiq_private.aiq_storage_objects object
  where object.object_id = target_object_id
  for update;
  if target_state is null or target_state = 'deleted' then
    raise exception 'hold target is absent or deleted' using errcode = '55000';
  end if;
  if hold_enabled and target_state = 'delete_pending' then
    raise exception 'deletion is already in flight; legal hold was not applied'
      using errcode = '55000';
  end if;
  update aiq_private.aiq_storage_objects object
  set legal_hold = hold_enabled,
      legal_hold_reason = case when hold_enabled then supplied_reason else null end,
      legal_hold_changed_at = now(),
      updated_at = now()
  where object.object_id = target_object_id;
  insert into aiq_private.aiq_storage_legal_hold_events (
    object_id, enabled, reason, actor
  ) values (target_object_id, hold_enabled, supplied_reason, supplied_actor);
  return case when hold_enabled then 'held' else 'released' end;
end;
$_$;


--
-- Name: aiq_stage_verifier_result(jsonb, uuid, uuid, integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_stage_verifier_result(stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) returns text
    language plpgsql security DEFINER
    SET search_path to ''
    SET statement_timeout to '110s'
    as $$
begin
  perform aiq_private.require_request_role('aiq_verifier');
  perform aiq_private.require_verification_claim(
    target_inbox_id, supplied_lease_token, supplied_attempt,
    stage ->> 'matrix_batch_id', stage ->> 'package_sha256', 'published'
  );
  return aiq_private.aiq_stage_verifier_result_unbound_core(stage);
end;
$$;


--
-- Name: aiq_storage_lifecycle_status(); Type: function; Schema: public; Owner: -
--

create function public.aiq_storage_lifecycle_status() returns jsonb
    language plpgsql stable security DEFINER
    SET search_path to ''
    as $$
begin
  perform aiq_private.require_request_role('service_role');
  return jsonb_build_object(
    'active_objects', (select count(*) from aiq_private.aiq_storage_objects where lifecycle_state = 'active'),
    'pending_objects', (select count(*) from aiq_private.aiq_storage_objects where lifecycle_state = 'delete_pending'),
    'deleted_objects', (select count(*) from aiq_private.aiq_storage_objects where lifecycle_state = 'deleted'),
    'held_objects', (select count(*) from aiq_private.aiq_storage_objects where legal_hold),
    'legal_hold_events', (select count(*) from aiq_private.aiq_storage_legal_hold_events),
    'active_references', (select count(*) from aiq_private.aiq_storage_object_references where active),
    'unresolved_mismatches', (select count(*)
      from aiq_private.aiq_storage_reconciliation_events
      where mismatch_type in ('storage_only','registry_only','identity_mismatch')
        and resolved_at is null),
    'latest_inventory_epoch_at', (select max(last_observed_at)
      from aiq_private.aiq_storage_reconciliation_events
      where mismatch_type='inventory_success' and resolved_at is not null),
    'registry_inventory_digest',aiq_private.storage_registry_inventory_digest(),
    'deletion_inventory_gate_ready', exists(
      select 1 from aiq_private.aiq_storage_reconciliation_events epoch
      where epoch.mismatch_type='inventory_success'
        and epoch.resolved_at is not null
        and epoch.last_observed_at>=now()-interval '24 hours'
        and epoch.last_observed_at>=coalesce((select max(event.last_observed_at)
          from aiq_private.aiq_storage_reconciliation_events event
          where event.mismatch_type in (
            'storage_only','registry_only','identity_mismatch'
          )),'-infinity'::timestamptz)
        and not exists(select 1 from aiq_private.aiq_storage_reconciliation_events open_event
          where open_event.mismatch_type in (
            'storage_only','registry_only','identity_mismatch'
          ) and open_event.resolved_at is null)
    ),
    'retained_bytes', (select coalesce(sum(byte_size), 0) from aiq_private.aiq_storage_objects where lifecycle_state <> 'deleted'),
    'oldest_due_at', (select min(expires_at) from aiq_private.aiq_storage_objects
      where lifecycle_state <> 'deleted' and not legal_hold and expires_at <= now())
  );
end;
$$;


--
-- Name: aiq_verify_and_publish(text, text, uuid, uuid, integer); Type: function; Schema: public; Owner: -
--

create function public.aiq_verify_and_publish(target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) returns void
    language plpgsql security DEFINER
    SET search_path to ''
    SET statement_timeout to '110s'
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
begin
  perform aiq_private.require_request_role('aiq_publisher');
  claimed := aiq_private.require_verification_claim(
    target_inbox_id, supplied_lease_token, supplied_attempt,
    target_run_id, target_package_sha256, 'published'
  );
  perform aiq_private.aiq_verify_and_publish_unbound_core(
    target_run_id, target_package_sha256
  );
  perform aiq_private.reconcile_publication_storage_evidence(
    'official',target_run_id,target_package_sha256,target_inbox_id
  );
  if claimed.claim_ack is null then
    update aiq_private.aiq_submission_inbox inbox
    set claim_ack = 'completed', claim_expires_at = null
    where inbox.inbox_id = target_inbox_id
      and inbox.claim_token = supplied_lease_token
      and inbox.claim_attempts = supplied_attempt;
    perform aiq_private.retire_claim_artifact_references(
      target_inbox_id, supplied_lease_token, supplied_attempt, 'completed'
    );
  end if;
end;
$$;


--
-- Name: public_trend_points(text); Type: function; Schema: public; Owner: -
--

create function public.public_trend_points(supplied_range text) returns table(matrix_id text, run_id text, scoring_version text, recorded_at timestamp with time zone, bucket_started_at timestamp with time zone, bucket_ended_at timestamp with time zone, score numeric, sensitivity_low numeric, sensitivity_high numeric, sample_size integer, represented_run_count bigint, resolution_seconds bigint, synthetic boolean)
    language plpgsql stable
    SET search_path to ''
    as $$
declare
  latest_recorded_at timestamp with time zone;
  oldest_recorded_at timestamp with time zone;
  range_started_at timestamp with time zone;
  range_ended_at timestamp with time zone;
  bucket_seconds bigint;
  canonical_series_count integer;
begin
  if supplied_range not in ('day', 'week', 'month', 'all') then
    raise exception 'unsupported public trend range' using errcode = '22023';
  end if;

  select count(*)
  into canonical_series_count
  from aiq_private.aiq_model_configs config
  where config.expected_in_matrix;

  if canonical_series_count <> 17 then
    raise exception 'public trend matrix must contain exactly 17 expected configurations'
      using errcode = '23514';
  end if;

  select max(run.scheduled_for), min(run.scheduled_for)
  into latest_recorded_at, oldest_recorded_at
  from aiq_private.aiq_runs run
  join aiq_private.aiq_model_configs config
    on config.model_config_id = run.model_config_id
    and config.expected_in_matrix
  where run.published;

  if latest_recorded_at is null then
    return;
  end if;

  range_started_at := case supplied_range
    when 'day' then latest_recorded_at - interval '1 day'
    when 'week' then latest_recorded_at - interval '7 days'
    when 'month' then latest_recorded_at - interval '31 days'
    else oldest_recorded_at
  end;
  range_ended_at := latest_recorded_at + interval '1 millisecond';
  bucket_seconds := greatest(
    1,
    ceil(extract(epoch from range_ended_at - range_started_at) / 20)::bigint
  );

  return query
  with series as (
    select config.model_config_id
    from aiq_private.aiq_model_configs config
    where config.expected_in_matrix
  ),
  buckets as (
    select
      series.model_config_id,
      range_started_at + make_interval(secs => bucket_seconds * bucket_number)
        as bucket_start,
      least(
        range_ended_at,
        range_started_at + make_interval(secs => bucket_seconds * (bucket_number + 1))
      ) as bucket_end
    from series
    cross join generate_series(0, 19) bucket_number
  )
  select
    buckets.model_config_id,
    observation.run_id,
    observation.scoring_version,
    observation.recorded_at,
    buckets.bucket_start,
    buckets.bucket_end,
    observation.score,
    observation.sensitivity_low,
    observation.sensitivity_high,
    observation.sample_size,
    observation.represented_run_count,
    bucket_seconds,
    observation.synthetic
  from buckets
  cross join lateral (
    select
      run.run_id,
      score.scoring_version,
      run.scheduled_for as recorded_at,
      score.fixed_fixture_aiq as score,
      score.task_resampling_low as sensitivity_low,
      score.task_resampling_high as sensitivity_high,
      score.valid_task_count as sample_size,
      count(*) over () as represented_run_count,
      run.synthetic
    from aiq_private.aiq_runs run
    join aiq_private.aiq_score_snapshots score on score.run_id = run.run_id
    where run.model_config_id = buckets.model_config_id
      and run.scheduled_for >= buckets.bucket_start
      and run.scheduled_for < buckets.bucket_end
      and run.published
      and score.published
      and score.score_status = 'official'
    order by run.scheduled_for desc, run.run_id desc
    limit 1
  ) observation
  order by observation.recorded_at, buckets.model_config_id
  limit 340;
end;
$$;


--
-- Name: function public_trend_points(supplied_range text); Type: COMMENT; Schema: public; Owner: -
--

comment on function public.public_trend_points(text) IS 'Published fixed-fixture task-mix sensitivity ranges. These deterministic ranges do not provide inferential confidence coverage for model capability.';


--
-- Name: aiq_artifact_claim_bindings; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_artifact_claim_bindings (
    inbox_id uuid not null,
    artifact_kind text not null,
    content_sha256 text not null,
    bound_at timestamp with time zone default now() not null
);


--
-- Name: table aiq_artifact_claim_bindings; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_artifact_claim_bindings IS 'Append-only evidence that an active verifier lease resolved an exact package artifact reference.';


--
-- Name: aiq_artifact_ingress_claims; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_artifact_ingress_claims (
    claimed_run_id text not null,
    artifact_kind text not null,
    content_sha256 text not null,
    claimed_at timestamp with time zone default now() not null,
    expires_at timestamp with time zone default (now() + '30 days'::interval) not null,
    constraint aiq_artifact_ingress_claims_check check ((expires_at >= (claimed_at + '30 days'::interval))),
    constraint aiq_artifact_ingress_claims_claimed_run_id_check check ((claimed_run_id ~ '^run_[0-9a-f]{64}$'::text))
);


--
-- Name: table aiq_artifact_ingress_claims; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_artifact_ingress_claims IS 'Untrusted-at-ingress runner run claims. The verifier resolver binds them to exact references in the signed queued package.';


--
-- Name: aiq_artifact_ingress_objects; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_artifact_ingress_objects (
    artifact_kind text not null,
    content_sha256 text not null,
    bucket_name text not null,
    object_path text not null,
    byte_size bigint not null,
    received_at timestamp with time zone default now() not null,
    expires_at timestamp with time zone default (now() + '30 days'::interval) not null,
    constraint aiq_artifact_ingress_objects_artifact_kind_check check ((artifact_kind = ANY (ARRAY['evaluator-results.json'::text, 'final-response.txt'::text, 'stderr.txt'::text, 'stdout.jsonl'::text, 'workspace-manifest.json'::text, 'workspace-snapshot.json'::text]))),
    constraint aiq_artifact_ingress_objects_bucket_name_check check ((bucket_name <> ''::text)),
    constraint aiq_artifact_ingress_objects_check check ((object_path = ((('sha256/'::text || content_sha256) || '/'::text) || artifact_kind))),
    constraint aiq_artifact_ingress_objects_check1 check (((artifact_kind = ANY (ARRAY['evaluator-results.json'::text, 'final-response.txt'::text, 'stderr.txt'::text, 'stdout.jsonl'::text, 'workspace-manifest.json'::text, 'workspace-snapshot.json'::text])) and ((byte_size >= 1) and (byte_size <=
case
    when (artifact_kind = 'evaluator-results.json'::text) then 3948544
    else 4194304
end)))),
    constraint aiq_artifact_ingress_objects_check2 check ((expires_at >= (received_at + '30 days'::interval))),
    constraint aiq_artifact_ingress_objects_content_sha256_check check ((content_sha256 ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: table aiq_artifact_ingress_objects; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_artifact_ingress_objects IS 'Immutable private metadata for runner-uploaded content-addressed artifacts. Storage lifecycle and deletion remain deployment-owned.';


--
-- Name: aiq_claim_artifact_reference_events; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_claim_artifact_reference_events (
    event_id uuid default extensions.gen_random_uuid() not null,
    inbox_id uuid not null,
    lease_token uuid not null,
    attempt integer not null,
    artifact_kind text not null,
    content_sha256 text not null,
    transition text not null,
    reason text,
    recorded_at timestamp with time zone default clock_timestamp() not null,
    constraint aiq_claim_artifact_reference_events_attempt_check check ((attempt > 0)),
    constraint aiq_claim_artifact_reference_events_check check ((((transition = 'activated'::text) and (reason IS null)) or ((transition = 'retired'::text) and (reason = ANY (ARRAY['completed'::text, 'rejected'::text, 'abandoned'::text, 'lease_expired'::text]))))),
    constraint aiq_claim_artifact_reference_events_transition_check check ((transition = ANY (ARRAY['activated'::text, 'retired'::text])))
);


--
-- Name: aiq_distributed_aggregation_inputs; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_distributed_aggregation_inputs (
    aggregation_input_id uuid not null,
    schema_version text not null,
    task_package_id text not null,
    package_version integer not null,
    run_id text not null,
    assignment_id text not null,
    lease_attempt integer not null,
    node_id text not null,
    model_config_id text not null,
    observation_id text,
    receipt_id text,
    receipt_hash text,
    result_package_hash text,
    input_sequence bigint not null,
    input_hash text not null,
    trust_classification text not null,
    classification_reason text not null,
    classified_at timestamp with time zone not null,
    synthetic boolean default false not null,
    constraint aiq_distributed_aggregation_inputs_assignment_id_check check ((assignment_id ~ '^assignment_[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_aggregation_inputs_check check ((((trust_classification = ANY (ARRAY['receiver_verified_trusted'::text, 'signed_untrusted'::text])) and (receipt_id IS not null) and (receipt_hash IS not null) and (result_package_hash IS not null)) or ((trust_classification = 'rejected'::text) and (((receipt_id IS null) and (receipt_hash IS null) and (result_package_hash IS null)) or ((receipt_id IS not null) and (receipt_hash IS not null) and (result_package_hash IS not null)))) or ((trust_classification = 'missing'::text) and (observation_id IS null) and (receipt_id IS null) and (receipt_hash IS null) and (result_package_hash IS null)))),
    constraint aiq_distributed_aggregation_inputs_check1 check (((not synthetic) or (trust_classification <> 'receiver_verified_trusted'::text))),
    constraint aiq_distributed_aggregation_inputs_check2 check (((not synthetic) or (classification_reason = ANY (ARRAY['synthetic_unverified_fixture'::text, 'synthetic_missing_fixture'::text])))),
    constraint aiq_distributed_aggregation_inputs_classification_reason_check check ((classification_reason ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    constraint aiq_distributed_aggregation_inputs_input_hash_check check ((input_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_aggregation_inputs_input_sequence_check check (((input_sequence >= 0) and (input_sequence <= '9007199254740991'::bigint))),
    constraint aiq_distributed_aggregation_inputs_lease_attempt_check check (((lease_attempt >= 1) and (lease_attempt <= 100))),
    constraint aiq_distributed_aggregation_inputs_receipt_hash_check check (((receipt_hash IS null) or (receipt_hash ~ '^sha256:[0-9a-f]{64}$'::text))),
    constraint aiq_distributed_aggregation_inputs_result_package_hash_check check (((result_package_hash IS null) or (result_package_hash ~ '^sha256:[0-9a-f]{64}$'::text))),
    constraint aiq_distributed_aggregation_inputs_run_id_check check ((run_id ~ '^run_[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_aggregation_inputs_schema_version_check check ((schema_version = 'aiq.distributed-aggregation-input.v1'::text)),
    constraint aiq_distributed_aggregation_inputs_trust_classification_check check ((trust_classification = ANY (ARRAY['receiver_verified_trusted'::text, 'signed_untrusted'::text, 'rejected'::text, 'missing'::text])))
);


--
-- Name: aiq_distributed_assignment_models; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_distributed_assignment_models (
    run_id text not null,
    assignment_id text not null,
    lease_attempt integer not null,
    node_id text not null,
    model_config_id text not null,
    synthetic boolean not null,
    constraint aiq_distributed_assignment_models_run_id_check check ((run_id ~ '^run_[0-9a-f]{64}$'::text))
);


--
-- Name: aiq_distributed_assignments; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_distributed_assignments (
    assignment_id text not null,
    lease_attempt integer not null,
    schema_version text not null,
    task_package_id text not null,
    package_version integer not null,
    package_hash text not null,
    assignment_hash text not null,
    run_id text not null,
    coordinator_node_id text not null,
    node_id text not null,
    assignment_sequence bigint not null,
    status text not null,
    lease_id text not null,
    signature_algorithm text not null,
    signature text not null,
    signature_status text not null,
    synthetic boolean default false not null,
    offered_at timestamp with time zone not null,
    accepted_at timestamp with time zone,
    running_at timestamp with time zone,
    completed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    expired_at timestamp with time zone,
    expires_at timestamp with time zone not null,
    updated_at timestamp with time zone not null,
    constraint aiq_distributed_assignments_assignment_hash_check check ((assignment_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_assignments_assignment_id_check check ((assignment_id ~ '^assignment_[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_assignments_assignment_sequence_check check (((assignment_sequence >= 0) and (assignment_sequence <= '9007199254740991'::bigint))),
    constraint aiq_distributed_assignments_check check (((updated_at >= offered_at) and (expires_at > offered_at))),
    constraint aiq_distributed_assignments_check1 check (((status <> all (ARRAY['accepted'::text, 'running'::text, 'completed'::text])) or (accepted_at IS not null))),
    constraint aiq_distributed_assignments_check10 check (((completed_at IS null) or (completed_at >= running_at))),
    constraint aiq_distributed_assignments_check11 check (((revoked_at IS null) or (revoked_at >= offered_at))),
    constraint aiq_distributed_assignments_check12 check (((accepted_at IS null) or (accepted_at < expires_at))),
    constraint aiq_distributed_assignments_check13 check (((running_at IS null) or (running_at < expires_at))),
    constraint aiq_distributed_assignments_check14 check (((completed_at IS null) or (completed_at < expires_at))),
    constraint aiq_distributed_assignments_check15 check (((expired_at IS null) or (expired_at >= expires_at))),
    constraint aiq_distributed_assignments_check16 check ((updated_at =
case status
    when 'offered'::text then offered_at
    when 'accepted'::text then accepted_at
    when 'running'::text then running_at
    when 'completed'::text then completed_at
    when 'revoked'::text then revoked_at
    when 'expired'::text then expired_at
    else null::timestamp with time zone
end)),
    constraint aiq_distributed_assignments_check17 check (((not synthetic) or (signature_status <> 'verified'::text))),
    constraint aiq_distributed_assignments_check2 check (((status <> 'offered'::text) or (accepted_at IS null))),
    constraint aiq_distributed_assignments_check3 check (((status <> all (ARRAY['running'::text, 'completed'::text])) or (running_at IS not null))),
    constraint aiq_distributed_assignments_check4 check (((status <> all (ARRAY['offered'::text, 'accepted'::text])) or (running_at IS null))),
    constraint aiq_distributed_assignments_check5 check (((completed_at IS not null) = (status = 'completed'::text))),
    constraint aiq_distributed_assignments_check6 check (((revoked_at IS not null) = (status = 'revoked'::text))),
    constraint aiq_distributed_assignments_check7 check (((expired_at IS not null) = (status = 'expired'::text))),
    constraint aiq_distributed_assignments_check8 check (((accepted_at IS null) or (accepted_at >= offered_at))),
    constraint aiq_distributed_assignments_check9 check (((running_at IS null) or (running_at >= accepted_at))),
    constraint aiq_distributed_assignments_lease_attempt_check check (((lease_attempt >= 1) and (lease_attempt <= 100))),
    constraint aiq_distributed_assignments_lease_id_check check ((lease_id ~ '^lease_[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_assignments_run_id_check check ((run_id ~ '^run_[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_assignments_schema_version_check check ((schema_version = 'aiq.distributed-assignment.v1'::text)),
    constraint aiq_distributed_assignments_signature_algorithm_check check ((signature_algorithm = 'ed25519'::text)),
    constraint aiq_distributed_assignments_signature_check check ((signature ~ '^[0-9a-f]{128}$'::text)),
    constraint aiq_distributed_assignments_signature_status_check check ((signature_status = ANY (ARRAY['unverified'::text, 'verified'::text, 'rejected'::text]))),
    constraint aiq_distributed_assignments_status_check check ((status = ANY (ARRAY['offered'::text, 'accepted'::text, 'running'::text, 'completed'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: aiq_distributed_capability_declarations; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_distributed_capability_declarations (
    declaration_id uuid not null,
    schema_version text not null,
    node_id text not null,
    declaration_sequence bigint not null,
    declaration_hash text not null,
    capability_hash text not null,
    status text not null,
    signature_algorithm text not null,
    signature text not null,
    signature_status text not null,
    issued_at timestamp with time zone not null,
    expires_at timestamp with time zone not null,
    synthetic boolean default false not null,
    constraint aiq_distributed_capability_declarati_declaration_sequence_check check (((declaration_sequence >= 0) and (declaration_sequence <= '9007199254740991'::bigint))),
    constraint aiq_distributed_capability_declaratio_signature_algorithm_check check ((signature_algorithm = 'ed25519'::text)),
    constraint aiq_distributed_capability_declarations_capability_hash_check check ((capability_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_capability_declarations_check check ((expires_at > issued_at)),
    constraint aiq_distributed_capability_declarations_check1 check (((not synthetic) or (signature_status <> 'verified'::text))),
    constraint aiq_distributed_capability_declarations_declaration_hash_check check ((declaration_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_capability_declarations_schema_version_check check ((schema_version = 'aiq.distributed-capability.v1'::text)),
    constraint aiq_distributed_capability_declarations_signature_check check ((signature ~ '^[0-9a-f]{128}$'::text)),
    constraint aiq_distributed_capability_declarations_signature_status_check check ((signature_status = ANY (ARRAY['unverified'::text, 'verified'::text, 'rejected'::text]))),
    constraint aiq_distributed_capability_declarations_status_check check ((status = ANY (ARRAY['declared'::text, 'validated'::text, 'rejected'::text, 'expired'::text])))
);


--
-- Name: aiq_distributed_node_observations; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_distributed_node_observations (
    observation_id text not null,
    schema_version text not null,
    node_id text not null,
    declaration_id uuid not null,
    observation_sequence bigint not null,
    observation_hash text not null,
    node_state text not null,
    receiver_status text not null,
    provenance_hash text not null,
    signature_algorithm text not null,
    signature text not null,
    signature_status text not null,
    observed_at timestamp with time zone not null,
    received_at timestamp with time zone not null,
    synthetic boolean default false not null,
    constraint aiq_distributed_node_observations_check check ((received_at >= observed_at)),
    constraint aiq_distributed_node_observations_check1 check (((not synthetic) or (signature_status <> 'verified'::text))),
    constraint aiq_distributed_node_observations_node_state_check check ((node_state = ANY (ARRAY['ready'::text, 'busy'::text, 'degraded'::text, 'draining'::text, 'offline'::text]))),
    constraint aiq_distributed_node_observations_observation_hash_check check ((observation_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_node_observations_observation_id_check check ((observation_id ~ '^observation_[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_node_observations_observation_sequence_check check (((observation_sequence >= 1) and (observation_sequence <= '9007199254740991'::bigint))),
    constraint aiq_distributed_node_observations_provenance_hash_check check ((provenance_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_node_observations_receiver_status_check check ((receiver_status = ANY (ARRAY['observed'::text, 'accepted'::text, 'rejected'::text, 'stale'::text]))),
    constraint aiq_distributed_node_observations_schema_version_check check ((schema_version = 'aiq.distributed-observation.v1'::text)),
    constraint aiq_distributed_node_observations_signature_algorithm_check check ((signature_algorithm = 'ed25519'::text)),
    constraint aiq_distributed_node_observations_signature_check check ((signature ~ '^[0-9a-f]{128}$'::text)),
    constraint aiq_distributed_node_observations_signature_status_check check ((signature_status = ANY (ARRAY['unverified'::text, 'verified'::text, 'rejected'::text])))
);


--
-- Name: aiq_distributed_result_receipts; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_distributed_result_receipts (
    receipt_id text not null,
    schema_version text not null,
    assignment_id text not null,
    lease_attempt integer not null,
    receiver_node_id text not null,
    node_id text not null,
    result_package_hash text not null,
    receipt_hash text not null,
    provenance_hash text not null,
    status text not null,
    signature_algorithm text not null,
    signature text not null,
    signature_status text not null,
    received_at timestamp with time zone not null,
    decided_at timestamp with time zone,
    synthetic boolean default false not null,
    constraint aiq_distributed_result_receipts_check check (((decided_at IS not null) = (status = ANY (ARRAY['accepted'::text, 'rejected'::text])))),
    constraint aiq_distributed_result_receipts_check1 check (((decided_at IS null) or (decided_at >= received_at))),
    constraint aiq_distributed_result_receipts_check2 check (((not synthetic) or (signature_status <> 'verified'::text))),
    constraint aiq_distributed_result_receipts_provenance_hash_check check ((provenance_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_result_receipts_receipt_hash_check check ((receipt_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_result_receipts_receipt_id_check check ((receipt_id ~ '^receipt_[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_result_receipts_result_package_hash_check check ((result_package_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_result_receipts_schema_version_check check ((schema_version = 'aiq.distributed-result-receipt.v1'::text)),
    constraint aiq_distributed_result_receipts_signature_algorithm_check check ((signature_algorithm = 'ed25519'::text)),
    constraint aiq_distributed_result_receipts_signature_check check ((signature ~ '^[0-9a-f]{128}$'::text)),
    constraint aiq_distributed_result_receipts_signature_status_check check ((signature_status = ANY (ARRAY['unverified'::text, 'verified'::text, 'rejected'::text]))),
    constraint aiq_distributed_result_receipts_status_check check ((status = ANY (ARRAY['received'::text, 'accepted'::text, 'rejected'::text])))
);


--
-- Name: aiq_distributed_task_packages; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_distributed_task_packages (
    task_package_id text not null,
    package_version integer not null,
    schema_version text not null,
    idempotency_key text not null,
    package_hash text not null,
    coordinator_node_id text not null,
    task_set_id text not null,
    task_set_version text not null,
    task_count integer not null,
    manifest_bytes integer not null,
    signature_algorithm text not null,
    signature text not null,
    signature_status text not null,
    synthetic boolean default false not null,
    created_at timestamp with time zone not null,
    expires_at timestamp with time zone not null,
    constraint aiq_distributed_task_packages_check check ((expires_at > created_at)),
    constraint aiq_distributed_task_packages_check1 check (((not synthetic) or (signature_status <> 'verified'::text))),
    constraint aiq_distributed_task_packages_idempotency_key_check check ((idempotency_key ~ '^taskpkg_[0-9a-f]{64}:[1-9][0-9]{0,9}$'::text)),
    constraint aiq_distributed_task_packages_manifest_bytes_check check (((manifest_bytes >= 1) and (manifest_bytes <= 1048576))),
    constraint aiq_distributed_task_packages_package_hash_check check ((package_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    constraint aiq_distributed_task_packages_package_version_check check (((package_version >= 1) and (package_version <= 2147483647))),
    constraint aiq_distributed_task_packages_schema_version_check check ((schema_version = 'aiq.distributed-task-package.v1'::text)),
    constraint aiq_distributed_task_packages_signature_algorithm_check check ((signature_algorithm = 'ed25519'::text)),
    constraint aiq_distributed_task_packages_signature_check check ((signature ~ '^[0-9a-f]{128}$'::text)),
    constraint aiq_distributed_task_packages_signature_status_check check ((signature_status = ANY (ARRAY['unverified'::text, 'verified'::text, 'rejected'::text]))),
    constraint aiq_distributed_task_packages_task_count_check check (((task_count >= 1) and (task_count <= 72))),
    constraint aiq_distributed_task_packages_task_package_id_check check ((task_package_id ~ '^taskpkg_[0-9a-f]{64}$'::text))
);


--
-- Name: aiq_model_configs; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_model_configs (
    model_config_id text not null,
    provider text not null,
    model_family text not null,
    provider_model_id text not null,
    reasoning_effort text not null,
    display_name text not null,
    matrix_order smallint not null,
    expected_in_matrix boolean default true not null,
    capability_status text default 'unverified'::text not null,
    provider_fingerprint text,
    is_enabled boolean default true not null,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    constraint aiq_model_configs_capability_status_check check ((capability_status = ANY (ARRAY['unverified'::text, 'available'::text, 'unavailable'::text, 'probe_failed'::text]))),
    constraint aiq_model_configs_check check (((model_family <> 'luna'::text) or (reasoning_effort <> 'ultra'::text))),
    constraint aiq_model_configs_model_family_check check ((model_family = ANY (ARRAY['sol'::text, 'terra'::text, 'luna'::text]))),
    constraint aiq_model_configs_reasoning_effort_check check ((reasoning_effort = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'xhigh'::text, 'max'::text, 'ultra'::text])))
);


--
-- Name: aiq_node_capability_snapshots; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_node_capability_snapshots (
    capability_sha256 text not null,
    node_id text not null,
    schema_version text not null,
    runner_version text not null,
    runner_sha256 text not null,
    harness_sha256 text not null,
    environment jsonb not null,
    model_capabilities jsonb not null,
    validation_status text not null,
    validated_at timestamp with time zone not null,
    created_at timestamp with time zone default now() not null,
    validation_report jsonb,
    constraint aiq_capability_validation_report_shape check (((validation_report IS null) or ((jsonb_typeof(validation_report) = 'object'::text) and ((validation_report ->> 'schema_version'::text) = 'aiq.capability-validation.v2'::text)))),
    constraint aiq_node_capability_snapshots_capability_sha256_check check ((capability_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_node_capability_snapshots_harness_sha256_check check ((harness_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_node_capability_snapshots_runner_sha256_check check ((runner_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_node_capability_snapshots_validation_status_check check ((validation_status = ANY (ARRAY['valid'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: aiq_nodes; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_nodes (
    node_id text not null,
    display_name text not null,
    key_fingerprint text not null,
    signature_algorithm text not null,
    public_key text not null,
    status aiq_private.node_status default 'pending'::aiq_private.node_status not null,
    trust_tier aiq_private.trust_tier default 'unverified'::aiq_private.trust_tier not null,
    operator_class text not null,
    capabilities text[] default '{}'::text[] not null,
    source text not null,
    signature_status text not null,
    provenance text not null,
    synthetic boolean default false not null,
    public_visible boolean default false not null,
    registered_at timestamp with time zone default now() not null,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    metadata jsonb default '{}'::jsonb not null,
    publisher_authorized boolean default false not null,
    constraint aiq_nodes_check check (((status = 'revoked'::aiq_private.node_status) = (revoked_at IS not null))),
    constraint aiq_nodes_node_id_check check ((node_id ~ '^node_[0-9a-f]{64}$'::text)),
    constraint aiq_nodes_operator_class_check check ((operator_class = ANY (ARRAY['official'::text, 'community'::text, 'verifier'::text]))),
    constraint aiq_nodes_public_key_check check ((public_key ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_nodes_signature_algorithm_check check ((signature_algorithm = 'ed25519'::text)),
    constraint aiq_nodes_signature_status_check check ((signature_status = ANY (ARRAY['verified'::text, 'unverified'::text]))),
    constraint aiq_nodes_synthetic_untrusted_check check (((not synthetic) or ((signature_status = 'unverified'::text) and (trust_tier = 'unverified'::aiq_private.trust_tier) and (not publisher_authorized))))
);


--
-- Name: aiq_package_runs; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_package_runs (
    package_sha256 text not null,
    run_id text not null,
    model_config_id text not null,
    matrix_order smallint not null,
    constraint aiq_package_runs_matrix_order_check check (((matrix_order >= 1) and (matrix_order <= 17)))
);


--
-- Name: aiq_publication_actors; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_publication_actors (
    matrix_batch_id text not null,
    package_sha256 text not null,
    publisher_node_id text not null,
    publisher_public_key text not null,
    bound_at timestamp with time zone default now() not null,
    constraint aiq_publication_actors_matrix_batch_id_check check ((matrix_batch_id ~ '^run_[0-9a-f]{64}$'::text)),
    constraint aiq_publication_actors_package_sha256_check check ((package_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_publication_actors_publisher_node_id_check check ((publisher_node_id ~ '^node_[0-9a-f]{64}$'::text)),
    constraint aiq_publication_actors_publisher_public_key_check check ((publisher_public_key ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_publication_actors_publisher_public_key_check1 check ((publisher_public_key <> repeat('0'::text, 64)))
);


--
-- Name: aiq_runs; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_runs (
    run_id text not null,
    matrix_batch_id text not null,
    idempotency_key text not null,
    schedule_slot text not null,
    scheduled_for timestamp with time zone not null,
    schedule_timezone text not null,
    task_set_id text not null,
    task_set_version text not null,
    benchmark_version text not null,
    scoring_version text not null,
    model_config_id text not null,
    source_node_id text,
    capability_sha256 text,
    status aiq_private.run_status not null,
    trust_tier aiq_private.trust_tier default 'unverified'::aiq_private.trust_tier not null,
    synthetic boolean default false not null,
    published boolean default false not null,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    prompt_set_digest text not null,
    runner_commit text not null,
    region text not null,
    failure_code text,
    failure_detail text,
    provenance jsonb not null,
    created_at timestamp with time zone default now() not null,
    run_provenance jsonb,
    constraint aiq_runs_check check ((idempotency_key = run_id)),
    constraint aiq_runs_check1 check (((completed_at IS null) or (started_at IS null) or (completed_at >= started_at))),
    constraint aiq_runs_check2 check (((status <> all (ARRAY['completed'::aiq_private.run_status, 'partial'::aiq_private.run_status, 'failed'::aiq_private.run_status, 'cancelled'::aiq_private.run_status])) or (completed_at IS not null))),
    constraint aiq_runs_prompt_set_digest_check check ((prompt_set_digest ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_runs_run_id_check check ((run_id ~ '^run_[0-9a-f]{64}$'::text)),
    constraint aiq_runs_runner_commit_check check ((runner_commit ~ '^[0-9a-f]{7,40}$'::text)),
    constraint aiq_runs_schedule_slot_check check ((schedule_slot = ANY (ARRAY['day'::text, 'night'::text, 'manual'::text])))
);


--
-- Name: aiq_score_snapshots; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_score_snapshots (
    score_snapshot_id uuid default extensions.gen_random_uuid() not null,
    run_id text not null,
    scoring_version text not null,
    score_status aiq_private.score_status not null,
    fixed_fixture_aiq numeric(6,3),
    task_resampling_low numeric(6,3),
    task_resampling_high numeric(6,3),
    completion_bound_low numeric(6,3) not null,
    completion_bound_high numeric(6,3) not null,
    micro_accuracy numeric(7,6),
    micro_wilson_low numeric(7,6),
    micro_wilson_high numeric(7,6),
    valid_task_count integer not null,
    expected_task_count integer not null,
    covered_domain_count integer not null,
    expected_domain_count integer not null,
    invalid_count integer default 0 not null,
    missing_count integer default 0 not null,
    not_applicable_count integer default 0 not null,
    domain_scores jsonb not null,
    interval_parameters jsonb not null,
    published boolean default false not null,
    calculated_at timestamp with time zone default now() not null,
    normalization_digest text,
    constraint aiq_published_score_is_official check (((not published) or (score_status = 'official'::aiq_private.score_status))),
    constraint aiq_score_binary_micro_bounds check ((((micro_accuracy IS null) and (micro_wilson_low IS null) and (micro_wilson_high IS null)) or ((micro_accuracy IS not null) and (micro_wilson_low IS not null) and (micro_wilson_high IS not null) and ((micro_accuracy >= (0)::numeric) and (micro_accuracy <= (1)::numeric)) and ((micro_wilson_low >= (0)::numeric) and (micro_wilson_low <= (1)::numeric)) and ((micro_wilson_high >= (0)::numeric) and (micro_wilson_high <= (1)::numeric)) and (micro_wilson_low <= micro_wilson_high) and ((micro_accuracy >= micro_wilson_low) and (micro_accuracy <= micro_wilson_high))))),
    constraint aiq_score_normalization_digest_format check (((normalization_digest IS null) or (normalization_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    constraint aiq_score_snapshots_check check (((task_resampling_low IS null) or (task_resampling_high IS null) or (task_resampling_low <= task_resampling_high))),
    constraint aiq_score_snapshots_check1 check ((((completion_bound_low >= (0)::numeric) and (completion_bound_low <= (100)::numeric)) and ((completion_bound_high >= (0)::numeric) and (completion_bound_high <= (100)::numeric)) and (completion_bound_low <= completion_bound_high))),
    constraint aiq_score_snapshots_check2 check (((valid_task_count >= 0) and (expected_task_count = 72))),
    constraint aiq_score_snapshots_check3 check (((covered_domain_count >= 0) and (expected_domain_count = 10) and (covered_domain_count <= expected_domain_count))),
    constraint aiq_score_snapshots_check4 check (((score_status <> all (ARRAY['official'::aiq_private.score_status, 'synthetic_complete'::aiq_private.score_status])) or ((valid_task_count = expected_task_count) and (covered_domain_count = expected_domain_count) and (invalid_count = 0) and (missing_count = 0) and (not_applicable_count = 0) and (fixed_fixture_aiq IS not null)))),
    constraint aiq_score_snapshots_check5 check (((score_status <> 'coverage_only'::aiq_private.score_status) or (task_resampling_low IS null))),
    constraint aiq_score_snapshots_fixed_fixture_aiq_check check (((fixed_fixture_aiq IS null) or ((fixed_fixture_aiq >= (0)::numeric) and (fixed_fixture_aiq <= (100)::numeric)))),
    constraint aiq_score_snapshots_task_resampling_high_check check (((task_resampling_high IS null) or ((task_resampling_high >= (0)::numeric) and (task_resampling_high <= (100)::numeric)))),
    constraint aiq_score_snapshots_task_resampling_low_check check (((task_resampling_low IS null) or ((task_resampling_low >= (0)::numeric) and (task_resampling_low <= (100)::numeric)))),
    constraint aiq_score_tier_metric_nullability check ((((score_status = ANY (ARRAY['official'::aiq_private.score_status, 'synthetic_complete'::aiq_private.score_status, 'provisional'::aiq_private.score_status])) and (fixed_fixture_aiq IS not null) and (task_resampling_low IS not null) and (task_resampling_high IS not null) and ((task_resampling_low >= (0)::numeric) and (task_resampling_low <= (100)::numeric)) and ((task_resampling_high >= (0)::numeric) and (task_resampling_high <= (100)::numeric)) and (task_resampling_low <= task_resampling_high)) or ((score_status = ANY (ARRAY['coverage_only'::aiq_private.score_status, 'not_applicable'::aiq_private.score_status])) and (fixed_fixture_aiq IS null) and (task_resampling_low IS null) and (task_resampling_high IS null))))
);


--
-- Name: aiq_scoring_versions; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_scoring_versions (
    scoring_version text not null,
    schema_version text not null,
    benchmark_version text not null,
    name text not null,
    fixed_fixture_estimand text not null,
    principles text[] not null,
    missing_policy text not null,
    failure_policy_text text not null,
    confidence_policy text not null,
    formula jsonb not null,
    interval_method jsonb not null,
    failure_policy jsonb not null,
    synthetic boolean default false not null,
    is_published boolean default false not null,
    published_at timestamp with time zone,
    created_at timestamp with time zone default now() not null,
    constraint aiq_scoring_versions_check check (((not is_published) or (published_at IS not null))),
    constraint aiq_scoring_versions_scoring_version_check check ((scoring_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'::text))
);


--
-- Name: aiq_storage_legal_hold_events; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_storage_legal_hold_events (
    hold_event_id uuid default extensions.gen_random_uuid() not null,
    object_id uuid not null,
    enabled boolean not null,
    reason text,
    actor text not null,
    recorded_at timestamp with time zone default now() not null,
    constraint aiq_storage_legal_hold_events_actor_check check ((actor ~ '^[a-z0-9][a-z0-9._:@-]{0,127}$'::text)),
    constraint aiq_storage_legal_hold_events_check check (((enabled and (reason ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'::text)) or ((not enabled) and (reason IS null))))
);


--
-- Name: table aiq_storage_legal_hold_events; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_storage_legal_hold_events IS 'Append-only legal-hold enable and release history with sanitized operator identity.';


--
-- Name: aiq_storage_object_references; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_storage_object_references (
    reference_id uuid default extensions.gen_random_uuid() not null,
    object_id uuid not null,
    reference_type text not null,
    reference_key text not null,
    active boolean default true not null,
    attached_at timestamp with time zone default now() not null,
    deactivated_at timestamp with time zone,
    constraint aiq_storage_object_references_check check (((active and (deactivated_at IS null)) or ((not active) and (deactivated_at IS not null)))),
    constraint aiq_storage_object_references_reference_key_check check ((reference_key ~ '^[a-z0-9][a-z0-9._:/-]{0,254}$'::text)),
    constraint aiq_storage_object_references_reference_type_check check ((reference_type = ANY (ARRAY['submission_inbox'::text, 'submission_conflict'::text, 'artifact_ingress_claim'::text, 'artifact_claim_binding'::text, 'calibration_run'::text, 'official_publication'::text])))
);


--
-- Name: table aiq_storage_object_references; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_storage_object_references IS 'Durable expected/live references. Object deletion is eligible only after every reference is inactive.';


--
-- Name: aiq_storage_objects; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_storage_objects (
    object_id uuid default extensions.gen_random_uuid() not null,
    object_type text not null,
    artifact_kind text,
    bucket_name text not null,
    object_path text not null,
    content_sha256 text not null,
    byte_size bigint not null,
    retention_class text not null,
    expires_at timestamp with time zone,
    lifecycle_state text default 'active'::text not null,
    deletion_attempts integer default 0 not null,
    deletion_lease_token uuid,
    deletion_lease_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone default now() not null,
    legal_hold boolean default false not null,
    legal_hold_reason text,
    legal_hold_changed_at timestamp with time zone,
    last_outcome text,
    last_error_code text,
    deleted_at timestamp with time zone,
    registered_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    constraint aiq_storage_objects_bucket_name_check check ((((object_type = 'submission_package'::text) and (bucket_name = 'aiq-submission-packages'::text)) or ((object_type = 'runner_artifact'::text) and (bucket_name = 'aiq-runner-artifacts'::text)))),
    constraint aiq_storage_objects_check check ((((object_type = 'submission_package'::text) and (artifact_kind IS null) and (object_path = ('sha256/'::text || content_sha256))) or ((object_type = 'runner_artifact'::text) and (artifact_kind = ANY (ARRAY['evaluator-results.json'::text, 'final-response.txt'::text, 'stderr.txt'::text, 'stdout.jsonl'::text, 'workspace-manifest.json'::text, 'workspace-snapshot.json'::text])) and (object_path = ((('sha256/'::text || content_sha256) || '/'::text) || artifact_kind))))),
    constraint aiq_storage_objects_check1 check (((byte_size >= 1) and (byte_size <=
case
    when (artifact_kind = 'evaluator-results.json'::text) then 3948544
    else 4194304
end))),
    constraint aiq_storage_objects_check2 check (((retention_class = 'preserve'::text) = (expires_at IS null))),
    constraint aiq_storage_objects_check3 check ((((deletion_lease_token IS null) and (deletion_lease_expires_at IS null)) or ((deletion_lease_token IS not null) and (deletion_lease_expires_at IS not null)))),
    constraint aiq_storage_objects_check4 check (((lifecycle_state = 'delete_pending'::text) = (deletion_lease_token IS not null))),
    constraint aiq_storage_objects_check5 check (((lifecycle_state = 'deleted'::text) = (deleted_at IS not null))),
    constraint aiq_storage_objects_check6 check ((((not legal_hold) and (legal_hold_reason IS null)) or (legal_hold and (legal_hold_reason ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'::text)))),
    constraint aiq_storage_objects_content_sha256_check check ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_storage_objects_deletion_attempts_check check ((deletion_attempts >= 0)),
    constraint aiq_storage_objects_last_error_code_check check (((last_error_code IS null) or (last_error_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'::text))),
    constraint aiq_storage_objects_last_outcome_check check ((last_outcome = ANY (ARRAY['deleted'::text, 'not_found'::text, 'retry'::text]))),
    constraint aiq_storage_objects_lifecycle_state_check check ((lifecycle_state = ANY (ARRAY['active'::text, 'delete_pending'::text, 'deleted'::text]))),
    constraint aiq_storage_objects_object_type_check check ((object_type = ANY (ARRAY['submission_package'::text, 'runner_artifact'::text]))),
    constraint aiq_storage_objects_retention_class_check check ((retention_class = ANY (ARRAY['ephemeral_30d'::text, 'audit_1y'::text, 'preserve'::text])))
);


--
-- Name: table aiq_storage_objects; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_storage_objects IS 'Durable identity and deletion state for private package and runner-artifact Storage objects.';


--
-- Name: aiq_storage_reconciliation_events; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_storage_reconciliation_events (
    event_id uuid default extensions.gen_random_uuid() not null,
    bucket_name text not null,
    object_path text not null,
    mismatch_type text not null,
    observed_at timestamp with time zone default now() not null,
    eligible_after timestamp with time zone,
    detail_code text not null,
    resolved_at timestamp with time zone,
    inventory_object_count bigint,
    inventory_digest text,
    occurrence_count integer default 1 not null,
    last_observed_at timestamp with time zone default now() not null,
    constraint aiq_storage_reconciliation_events_bucket_name_check check ((bucket_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'::text)),
    constraint aiq_storage_reconciliation_events_detail_code_check check ((detail_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'::text)),
    constraint aiq_storage_reconciliation_events_mismatch_type_check check ((mismatch_type = ANY (ARRAY['storage_only'::text, 'registry_only'::text, 'identity_mismatch'::text, 'inventory_success'::text]))),
    constraint aiq_storage_reconciliation_events_object_path_check check ((object_path ~ '^sha256/[0-9a-f]{64}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$'::text)),
    constraint aiq_storage_reconciliation_events_occurrence_count_check check ((occurrence_count > 0)),
    constraint aiq_storage_reconciliation_events_inventory_shape check (
      ((mismatch_type = 'inventory_success'::text)
        and bucket_name = 'aiq-system'::text
        and object_path ~ '^sha256/[0-9a-f]{64}/inventory$'::text
        and detail_code = 'inventory_complete'::text
        and eligible_after is null and resolved_at is not null
        and observed_at=last_observed_at and resolved_at=last_observed_at
        and occurrence_count=1
        and inventory_object_count is not null
        and inventory_object_count between 0 and '9007199254740991'::bigint
        and inventory_digest is not null
        and inventory_digest~'^sha256:[0-9a-f]{64}$'::text)
      or ((mismatch_type <> 'inventory_success'::text)
        and inventory_object_count is null and inventory_digest is null)
    )
);


--
-- Name: table aiq_storage_reconciliation_events; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_storage_reconciliation_events IS 'Durable sanitized mismatch observations plus append-only successful full-inventory epochs that gate deletion leasing.';


--
-- Name: aiq_submission_conflicts; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_submission_conflicts (
    conflict_id uuid default extensions.gen_random_uuid() not null,
    inbox_id uuid not null,
    idempotency_key text not null,
    package_sha256 text not null,
    envelope jsonb not null,
    request_context jsonb not null,
    detected_at timestamp with time zone default now() not null,
    expires_at timestamp with time zone not null,
    retention_state text default 'active'::text not null,
    object_bucket text,
    object_key text,
    object_content_sha256 text,
    object_bytes bigint,
    constraint aiq_submission_conflict_object_binding_complete check ((((object_bucket IS null) and (object_key IS null) and (object_content_sha256 IS null) and (object_bytes IS null)) or ((object_bucket IS not null) and (object_bucket <> ''::text) and (object_key = ('sha256/'::text || package_sha256)) and (object_content_sha256 = package_sha256) and ((object_bytes >= 1) and (object_bytes <= 4194304)) and (object_bytes = ((request_context ->> 'body_bytes'::text))::bigint)))),
    constraint aiq_submission_conflicts_check check ((expires_at > detected_at)),
    constraint aiq_submission_conflicts_idempotency_key_check check ((idempotency_key ~ '^run_[0-9a-f]{64}$'::text)),
    constraint aiq_submission_conflicts_package_sha256_check check ((package_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_submission_conflicts_retention_state_check check ((retention_state = ANY (ARRAY['active'::text, 'expired'::text, 'purged'::text])))
);


--
-- Name: table aiq_submission_conflicts; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_submission_conflicts IS 'Append-only service audit records. Conflicts are never overwritten; expired rows are removed only by the bounded purge RPC.';


--
-- Name: aiq_task_catalog; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_task_catalog (
    task_set_id text not null,
    task_set_version text not null,
    task_id text not null,
    task_version text not null,
    title text not null,
    domain text not null,
    difficulty text not null,
    summary text not null,
    evaluator_kind text not null,
    scorer_version text not null,
    allowed_tools jsonb not null,
    budget jsonb not null,
    tags text[] default '{}'::text[] not null,
    fixture_commitment text,
    task_hash text generated always as ('sha256:'::text || fixture_commitment) stored,
    hidden_content_ref text,
    leakage_notes text not null,
    public_metadata boolean default true not null,
    created_at timestamp with time zone default now() not null,
    catalog_ordinal smallint,
    full_public_metadata json,
    constraint aiq_task_catalog_allowed_tools_check check ((jsonb_typeof(allowed_tools) = 'array'::text)),
    constraint aiq_task_catalog_budget_check check ((jsonb_typeof(budget) = 'object'::text)),
    constraint aiq_task_catalog_difficulty_check check ((difficulty = ANY (ARRAY['easy'::text, 'medium'::text, 'hard'::text]))),
    constraint aiq_task_catalog_domain_check check ((domain = ANY (ARRAY['coding'::text, 'debugging'::text, 'repository_understanding'::text, 'data_processing'::text, 'retrieval_verification'::text, 'documentation_communication'::text, 'planning_execution'::text, 'tool_use'::text, 'instruction_following'::text, 'reliability_recovery'::text]))),
    constraint aiq_task_catalog_fixture_commitment_check check (((fixture_commitment IS null) or (fixture_commitment ~ '^[0-9a-f]{64}$'::text))),
    constraint aiq_task_catalog_exact_commitment_key unique (
        task_set_id, task_set_version, task_id, task_version, task_hash
    ),
    constraint aiq_task_catalog_identity_pair check (((catalog_ordinal IS null) = (full_public_metadata IS null))),
    constraint aiq_task_catalog_ordinal_range check (((catalog_ordinal IS null) or ((catalog_ordinal >= 1) and (catalog_ordinal <= 72)))),
    constraint aiq_task_catalog_scorer_version_check check ((scorer_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'::text)),
    constraint aiq_task_catalog_task_version_check check ((task_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'::text))
);


comment on column aiq_private.aiq_task_catalog.task_hash IS
  'Exact wire task hash derived from the committed fixture digest.';


--
-- Name: aiq_task_results; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_task_results (
    result_id uuid default extensions.gen_random_uuid() not null,
    run_id text not null,
    task_id text not null,
    task_version text not null,
    domain text not null,
    attempt_number integer default 1 not null,
    outcome aiq_private.result_outcome not null,
    task_score numeric(6,5),
    scorer_version text not null,
    failure_code text,
    failure_responsibility text,
    failure_detail text,
    failure_retryable boolean,
    latency_ms bigint,
    latency_evidence_level text,
    tool_usage jsonb default '{}'::jsonb not null,
    usage jsonb default '{}'::jsonb not null,
    input_tokens bigint,
    cached_input_tokens bigint,
    cache_write_input_tokens bigint,
    output_tokens bigint,
    reasoning_output_tokens bigint,
    total_tokens bigint,
    token_usage_evidence_level text,
    standard_api_equivalent_usd_nanos bigint,
    cost_estimator_status text default 'unavailable_missing_usage' not null,
    cost_evidence_level text,
    pricing_digest text,
    result_package_sha256 text,
    provenance jsonb not null,
    created_at timestamp with time zone default now() not null,
    source_result_id text,
    constraint aiq_source_result_id_format check (((source_result_id IS null) or (source_result_id ~ '^result_[0-9a-f]{64}$'::text))),
    constraint aiq_task_results_attempt_number_check check ((attempt_number > 0)),
    constraint aiq_task_results_check check ((((outcome = ANY (ARRAY['invalid'::aiq_private.result_outcome, 'missing'::aiq_private.result_outcome, 'not_applicable'::aiq_private.result_outcome])) and (task_score IS null)) or ((outcome <> all (ARRAY['invalid'::aiq_private.result_outcome, 'missing'::aiq_private.result_outcome, 'not_applicable'::aiq_private.result_outcome])) and (task_score IS not null)))),
    constraint aiq_task_results_check1 check (((outcome <> 'invalid'::aiq_private.result_outcome) or (COALESCE((failure_responsibility = ANY (ARRAY['benchmark_infrastructure'::text, 'platform'::text])), false) and COALESCE(((provenance ->> 'rerun_required'::text) = 'true'::text), false)))),
    constraint aiq_task_results_check2 check (((failure_responsibility <> all (ARRAY['benchmark_infrastructure'::text, 'platform'::text])) or ((outcome = 'invalid'::aiq_private.result_outcome) and (task_score IS null)))),
    constraint aiq_task_results_check3 check (((failure_responsibility <> all (ARRAY['agent'::text, 'model'::text, 'tool'::text, 'timeout'::text, 'budget'::text, 'wrong_artifact'::text])) or (task_score = (0)::numeric))),
    constraint aiq_task_results_check4 check (((outcome <> all (ARRAY['timeout'::aiq_private.result_outcome, 'budget_exhausted'::aiq_private.result_outcome, 'tool_failure'::aiq_private.result_outcome, 'policy_failure'::aiq_private.result_outcome, 'wrong_artifact'::aiq_private.result_outcome])) or (task_score = (0)::numeric))),
    constraint aiq_task_results_domain_check check ((domain = ANY (ARRAY['coding'::text, 'debugging'::text, 'repository_understanding'::text, 'data_processing'::text, 'retrieval_verification'::text, 'documentation_communication'::text, 'planning_execution'::text, 'tool_use'::text, 'instruction_following'::text, 'reliability_recovery'::text]))),
    constraint aiq_task_results_failure_responsibility_check check (((failure_responsibility IS null) or (failure_responsibility = ANY (ARRAY['agent'::text, 'model'::text, 'tool'::text, 'timeout'::text, 'budget'::text, 'wrong_artifact'::text, 'benchmark_infrastructure'::text, 'platform'::text])))),
    constraint aiq_task_results_latency_ms_check check (((latency_ms IS null) or (latency_ms >= 0))),
    constraint aiq_task_results_latency_evidence_check check (
      (latency_ms is null) = (latency_evidence_level is null)
      and (latency_evidence_level is null or latency_evidence_level = 'runner_observed')
    ),
    constraint aiq_task_results_result_package_sha256_check check (((result_package_sha256 IS null) or (result_package_sha256 ~ '^[0-9a-f]{64}$'::text))),
    constraint aiq_task_results_task_score_check check (((task_score IS null) or ((task_score >= (0)::numeric) and (task_score <= (1)::numeric))))
    ,constraint aiq_task_results_structured_usage_nonnegative check (
      input_tokens >= 0 and cached_input_tokens >= 0 and cache_write_input_tokens >= 0
      and output_tokens >= 0 and reasoning_output_tokens >= 0 and total_tokens >= 0
      and standard_api_equivalent_usd_nanos >= 0
    )
    ,constraint aiq_task_results_structured_usage_bounds check (
      (cached_input_tokens is null or input_tokens is null or cached_input_tokens <= input_tokens)
      and (reasoning_output_tokens is null or output_tokens is null or reasoning_output_tokens <= output_tokens)
    )
    ,constraint aiq_task_results_usage_evidence check (
      (token_usage_evidence_level is null
        or token_usage_evidence_level = 'verifier_recomputed')
      and ((input_tokens is null and cached_input_tokens is null
        and cache_write_input_tokens is null and output_tokens is null
        and reasoning_output_tokens is null and total_tokens is null)
        = (token_usage_evidence_level is null))
    )
    ,constraint aiq_task_results_cost_status check (
      cost_estimator_status in (
        'estimated','unavailable_missing_usage','unavailable_invalid_usage',
        'unavailable_context_band'
      )
      and (cost_estimator_status <> 'estimated' or standard_api_equivalent_usd_nanos is not null)
      and (cost_estimator_status = 'estimated' or standard_api_equivalent_usd_nanos is null)
      and (cost_evidence_level is null or cost_evidence_level = 'verifier_recomputed')
      and ((standard_api_equivalent_usd_nanos is null) = (cost_evidence_level is null))
      and ((cost_estimator_status = 'unavailable_context_band') = coalesce((
        input_tokens > 272000 and cached_input_tokens is not null
        and cache_write_input_tokens is not null and output_tokens is not null
      ), false))
    )
);


--
-- Name: COLUMN aiq_task_results.failure_detail; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on COLUMN aiq_private.aiq_task_results.failure_detail IS 'Restricted raw failure detail. Public views expose only a fixed summary.';

comment on COLUMN aiq_private.aiq_task_results.latency_ms IS
  'Observed Codex adapter invocation elapsed milliseconds. It is NULL when the adapter was not invoked.';


--
-- Name: aiq_task_sets; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_task_sets (
    task_set_id text not null,
    task_set_version text not null,
    title text not null,
    task_count integer not null,
    domain_count integer not null,
    catalog_sha256 text not null,
    hidden_payload_commitment text,
    content_status text not null,
    is_published boolean default false not null,
    published_at timestamp with time zone,
    retired_at timestamp with time zone,
    metadata jsonb default '{}'::jsonb not null,
    created_at timestamp with time zone default now() not null,
    catalog_identity_scope text,
    constraint aiq_task_set_catalog_identity_scope check (((catalog_identity_scope IS null) or (catalog_identity_scope = 'ordered_full_task_metadata'::text))),
    constraint aiq_task_sets_catalog_sha256_check check ((catalog_sha256 ~ '^[0-9a-f]{64}$'::text)),
    constraint aiq_task_sets_check check (((not is_published) or (published_at IS not null))),
    constraint aiq_task_sets_content_status_check check ((content_status = ANY (ARRAY['metadata_only'::text, 'committed'::text, 'retired_public'::text]))),
    constraint aiq_task_sets_domain_count_check check ((domain_count = 10)),
    constraint aiq_task_sets_hidden_payload_commitment_check check (((hidden_payload_commitment IS null) or (hidden_payload_commitment ~ '^[0-9a-f]{64}$'::text))),
    constraint aiq_task_sets_task_count_check check ((task_count = 72)),
    constraint aiq_task_sets_task_set_version_check check ((task_set_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'::text))
);


--
-- Name: aiq_verification_audit; Type: table; Schema: aiq_private; Owner: -
--

create table aiq_private.aiq_verification_audit (
    audit_id uuid default extensions.gen_random_uuid() not null,
    inbox_id uuid not null,
    run_id text,
    package_sha256 text not null,
    event_type text not null,
    actor_node_id text,
    event_record jsonb not null,
    recorded_at timestamp with time zone default now() not null,
    constraint aiq_verification_audit_event_record_check check (((jsonb_typeof(event_record) = 'object'::text) and (event_record <> '{}'::jsonb))),
    constraint aiq_verification_audit_event_type_check check ((event_type = ANY (ARRAY['staged'::text, 'verifier_attested'::text, 'verified_published'::text, 'rejected'::text]))),
    constraint aiq_verification_audit_package_sha256_check check ((package_sha256 ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: table aiq_verification_audit; Type: COMMENT; Schema: aiq_private; Owner: -
--

comment on table aiq_private.aiq_verification_audit IS 'Append-only verifier staging, publication, and rejection evidence. Rows have no browser or direct service-role grants.';


--
-- Name: public_distributed_radar; Type: view; Schema: public; Owner: -
--

create view public.public_distributed_radar with (security_invoker = true) as
 select node.node_id,
    node.display_name as name,
    node.operator_class as operator,
    node.key_fingerprint as public_key_fingerprint,
    (node.trust_tier)::text as registry_trust,
    (node.status)::text as registry_status,
    node.last_seen_at,
    node.synthetic,
    capability.schema_version as latest_capability_schema_version,
    capability.capability_hash as latest_capability_hash,
    capability.status as latest_capability_status,
    capability.signature_status as latest_capability_signature_status,
    capability.issued_at as latest_capability_observed_at,
    observation.schema_version as latest_observation_schema_version,
    observation.node_state as latest_observation_state,
    observation.observation_sequence as latest_observation_sequence,
    observation.observation_hash as latest_observation_hash,
    observation.receiver_status as latest_observation_status,
    observation.signature_status as latest_observation_signature_status,
    observation.observed_at as latest_observation_observed_at,
    observation.provenance_hash as latest_observation_provenance_hash,
    COALESCE(assignments.total_count, (0)::bigint) as assignment_total_count,
    COALESCE(assignments.offered_count, (0)::bigint) as assignment_offered_count,
    COALESCE(assignments.accepted_count, (0)::bigint) as assignment_accepted_count,
    COALESCE(assignments.running_count, (0)::bigint) as assignment_running_count,
    COALESCE(assignments.completed_count, (0)::bigint) as assignment_completed_count,
    COALESCE(assignments.revoked_count, (0)::bigint) as assignment_revoked_count,
    COALESCE(assignments.expired_count, (0)::bigint) as assignment_expired_count,
    COALESCE(receipts.total_count, (0)::bigint) as receipt_total_count,
    COALESCE(receipts.received_count, (0)::bigint) as receipt_received_count,
    COALESCE(receipts.accepted_count, (0)::bigint) as receipt_accepted_count,
    COALESCE(receipts.rejected_count, (0)::bigint) as receipt_rejected_count,
    COALESCE(aggregation.receiver_verified_trusted_count, (0)::bigint) as receiver_verified_trusted_count,
    COALESCE(aggregation.signed_untrusted_count, (0)::bigint) as signed_untrusted_count,
    COALESCE(aggregation.rejected_count, (0)::bigint) as rejected_count,
    COALESCE(aggregation.missing_count, (0)::bigint) as missing_count,
    aggregation.aggregated_at
   from (((((aiq_private.aiq_nodes node
     left join LATERAL ( select declaration.schema_version,
            declaration.capability_hash,
            declaration.status,
            declaration.signature_status,
            declaration.issued_at
           from aiq_private.aiq_distributed_capability_declarations declaration
          where (declaration.node_id = node.node_id)
          ORDER BY declaration.declaration_sequence DESC, declaration.issued_at DESC
         LIMIT 1) capability on (true))
     left join LATERAL ( select observed.schema_version,
            observed.node_state,
            observed.observation_sequence,
            observed.observation_hash,
            observed.receiver_status,
            observed.signature_status,
            observed.observed_at,
            observed.provenance_hash
           from aiq_private.aiq_distributed_node_observations observed
          where (observed.node_id = node.node_id)
          ORDER BY observed.observation_sequence DESC, observed.observed_at DESC
         LIMIT 1) observation on (true))
     left join LATERAL ( select count(*) as total_count,
            count(*) FILTER (where (assignment.status = 'offered'::text)) as offered_count,
            count(*) FILTER (where (assignment.status = 'accepted'::text)) as accepted_count,
            count(*) FILTER (where (assignment.status = 'running'::text)) as running_count,
            count(*) FILTER (where (assignment.status = 'completed'::text)) as completed_count,
            count(*) FILTER (where (assignment.status = 'revoked'::text)) as revoked_count,
            count(*) FILTER (where (assignment.status = 'expired'::text)) as expired_count
           from aiq_private.aiq_distributed_assignments assignment
          where (assignment.node_id = node.node_id)) assignments on (true))
     left join LATERAL ( select count(*) as total_count,
            count(*) FILTER (where (receipt.status = 'received'::text)) as received_count,
            count(*) FILTER (where (receipt.status = 'accepted'::text)) as accepted_count,
            count(*) FILTER (where (receipt.status = 'rejected'::text)) as rejected_count
           from aiq_private.aiq_distributed_result_receipts receipt
          where (receipt.node_id = node.node_id)) receipts on (true))
     left join LATERAL ( select count(*) FILTER (where (input.trust_classification = 'receiver_verified_trusted'::text)) as receiver_verified_trusted_count,
            count(*) FILTER (where (input.trust_classification = 'signed_untrusted'::text)) as signed_untrusted_count,
            count(*) FILTER (where (input.trust_classification = 'rejected'::text)) as rejected_count,
            count(*) FILTER (where (input.trust_classification = 'missing'::text)) as missing_count,
            max(input.classified_at) as aggregated_at
           from aiq_private.aiq_distributed_aggregation_inputs input
          where (input.node_id = node.node_id)) aggregation on (true))
  where node.public_visible;


--
-- Name: view public_distributed_radar; Type: COMMENT; Schema: public; Owner: -
--

comment on view public.public_distributed_radar IS 'Public aggregate metadata for the undeployed distributed radar protocol. Signatures, lease tokens, and raw package content remain private.';


--
-- Name: public_leaderboard; Type: view; Schema: public; Owner: -
--

create view public.public_leaderboard with (security_invoker = true) as
 with latest_evidence as (
         select DISTINCT on (run.model_config_id) run.run_id,
            run.model_config_id,
            run.synthetic,
            score.scoring_version,
            score.score_status,
            score.fixed_fixture_aiq,
            score.task_resampling_low,
            score.task_resampling_high,
            score.valid_task_count,
            score.expected_task_count,
            score.invalid_count,
            score.missing_count,
            ( select (count(*))::integer as count
                   from aiq_private.aiq_task_results result
                  where ((result.run_id = run.run_id) and (result.outcome = ANY (ARRAY['timeout'::aiq_private.result_outcome, 'budget_exhausted'::aiq_private.result_outcome, 'tool_failure'::aiq_private.result_outcome, 'policy_failure'::aiq_private.result_outcome, 'wrong_artifact'::aiq_private.result_outcome])))) as runtime_issue_count
           from (aiq_private.aiq_runs run
             join aiq_private.aiq_score_snapshots score on ((score.run_id = run.run_id)))
          where (run.published and score.published)
          ORDER BY run.model_config_id, run.scheduled_for DESC, score.calculated_at DESC
        )
 select model_config_id as matrix_id,
    run_id,
        case
            when (score_status = 'official'::aiq_private.score_status) then fixed_fixture_aiq
            else null::numeric
        end as score,
        case
            when (score_status = 'official'::aiq_private.score_status) then task_resampling_low
            else null::numeric
        end as sensitivity_low,
        case
            when (score_status = 'official'::aiq_private.score_status) then task_resampling_high
            else null::numeric
        end as sensitivity_high,
        case
            when (score_status = 'official'::aiq_private.score_status) then valid_task_count
            else null::integer
        end as sample_size,
        case
            when (score_status = 'official'::aiq_private.score_status) then round((((valid_task_count)::numeric * (100)::numeric) / (expected_task_count)::numeric), 1)
            else null::numeric
        end as coverage_percent,
        case
            when (score_status = 'official'::aiq_private.score_status) then runtime_issue_count
            else null::integer
        end as runtime_issues,
        case
            when (score_status = 'official'::aiq_private.score_status) then missing_count
            else null::integer
        end as missing,
    scoring_version,
        case
            when (score_status = 'official'::aiq_private.score_status) then 'official'::text
            when (score_status = 'not_applicable'::aiq_private.score_status) then 'not_applicable'::text
            else 'missing'::text
        end as score_status,
    synthetic
   from latest_evidence;


--
-- Name: view public_leaderboard; Type: COMMENT; Schema: public; Owner: -
--

comment on view public.public_leaderboard IS 'Published Official scores with deterministic fixed-fixture task-mix sensitivity ranges, not inferential confidence intervals.';


--
-- Name: public_model_matrix; Type: view; Schema: public; Owner: -
--

create view public.public_model_matrix with (security_invoker = true) as
 select model_config_id as id,
        case model_family
            when 'sol'::text then 'Sol'::text
            when 'terra'::text then 'Terra'::text
            else 'Luna'::text
        end as model_family,
    provider_model_id as model_name,
    reasoning_effort as reasoning_tier
   from aiq_private.aiq_model_configs
  where expected_in_matrix;


--
-- Name: public_nodes; Type: view; Schema: public; Owner: -
--

create view public.public_nodes with (security_invoker = true) as
 select node_id as id,
    display_name as name,
    operator_class as operator,
    key_fingerprint as public_key_fingerprint,
    capabilities,
    source,
    (trust_tier)::text as trust,
        case
            when (status = 'active'::aiq_private.node_status) then 'online'::text
            when (status = 'degraded'::aiq_private.node_status) then 'degraded'::text
            else 'offline'::text
        end as status,
    last_seen_at,
    signature_status,
    provenance,
    synthetic
   from aiq_private.aiq_nodes
  where public_visible;


--
-- Name: public_run_results; Type: view; Schema: public; Owner: -
--

create view public.public_run_results with (security_invoker = true) as
 select result.run_id,
    result.result_id as id,
    result.task_id,
    COALESCE(catalog.title, result.task_id) as task,
    result.domain,
    (result.outcome)::text as outcome,
        case
            when (result.outcome = ANY (ARRAY['correct'::aiq_private.result_outcome, 'partial'::aiq_private.result_outcome, 'incorrect'::aiq_private.result_outcome])) then 'completed'::text
            when (result.outcome = ANY (ARRAY['timeout'::aiq_private.result_outcome, 'budget_exhausted'::aiq_private.result_outcome, 'tool_failure'::aiq_private.result_outcome, 'policy_failure'::aiq_private.result_outcome, 'wrong_artifact'::aiq_private.result_outcome])) then 'runtime_issue'::text
            when (result.outcome = 'invalid'::aiq_private.result_outcome) then 'invalid'::text
            when (result.outcome = 'missing'::aiq_private.result_outcome) then 'missing'::text
            when (result.outcome = 'not_applicable'::aiq_private.result_outcome) then 'not_applicable'::text
        end as execution_status,
    result.task_score as score,
    result.failure_code as explanation_code,
        case
            when (result.outcome = 'timeout'::aiq_private.result_outcome) then 'The task exceeded its time limit.'::text
            when (result.outcome = 'budget_exhausted'::aiq_private.result_outcome) then 'The task exceeded a resource budget.'::text
            when (result.outcome = 'tool_failure'::aiq_private.result_outcome) then 'A permitted execution tool failed.'::text
            when (result.outcome = 'policy_failure'::aiq_private.result_outcome) then 'The result violated a controlled-output policy.'::text
            when (result.outcome = 'wrong_artifact'::aiq_private.result_outcome) then 'The expected artifact was not produced.'::text
            when (result.outcome = 'invalid'::aiq_private.result_outcome) then 'Benchmark infrastructure invalidated this result; an audited rerun is required.'::text
            when (result.outcome = 'missing'::aiq_private.result_outcome) then 'No task result was available.'::text
            when (result.outcome = 'not_applicable'::aiq_private.result_outcome) then 'The complete model configuration was unavailable.'::text
            when (result.outcome = 'incorrect'::aiq_private.result_outcome) then 'The evaluator rejected the response.'::text
            else null::text
        end as explanation_summary,
    result.failure_retryable as retryable,
    COALESCE(ARRAY( select tool_name.tool_name
           from jsonb_object_keys(
                case
                    when (jsonb_typeof((result.tool_usage -> 'by_tool'::text)) = 'object'::text) then (result.tool_usage -> 'by_tool'::text)
                    else '{}'::jsonb
                end) tool_name(tool_name)
          ORDER BY tool_name.tool_name), '{}'::text[]) as tools,
    result.latency_ms,
    result.latency_evidence_level,
    result.input_tokens,
    result.cached_input_tokens,
    result.cache_write_input_tokens,
    result.output_tokens,
    result.reasoning_output_tokens,
    result.total_tokens,
    result.token_usage_evidence_level,
        case
            when (result.token_usage_evidence_level IS null) then null::text
            else 'provider_reported'::text
        end as token_usage_source_level,
    result.standard_api_equivalent_usd_nanos,
    result.cost_estimator_status,
    result.cost_evidence_level,
    result.pricing_digest
   from ((aiq_private.aiq_task_results result
     join aiq_private.aiq_runs run on ((run.run_id = result.run_id)))
     left join aiq_private.aiq_task_catalog catalog on (((catalog.task_set_id = run.task_set_id) and (catalog.task_set_version = run.task_set_version) and (catalog.task_id = result.task_id) and (catalog.task_version = result.task_version))))
  where run.published;


--
-- Name: public_runs; Type: view; Schema: public; Owner: -
--

create view public.public_runs with (security_invoker = true) as
 select run.run_id as id,
    run.model_config_id as matrix_id,
    run.started_at,
    run.completed_at,
    run.benchmark_version,
    run.scoring_version,
    ('sha256:'::text || run.prompt_set_digest) as prompt_set_digest,
    run.runner_commit,
    run.region,
    run.synthetic,
    (run.run_provenance ->> 'corpus_release_id'::text) as corpus_release_id,
    (run.run_provenance ->> 'corpus_commitment_sha256'::text) as corpus_commitment_sha256,
    (run.run_provenance ->> 'catalog_digest'::text) as catalog_digest,
    (run.run_provenance ->> 'task_set_digest'::text) as task_set_digest,
    (run.run_provenance ->> 'preflight_digest'::text) as preflight_digest,
    (run.run_provenance ->> 'runtime_digest'::text) as runtime_digest,
    (run.run_provenance ->> 'run_class'::text) as run_class,
    (run.run_provenance ->> 'permission_evidence_digest'::text) as permission_evidence_digest,
    result_summary.result_count,
    result_summary.correct_count,
    result_summary.partial_count,
    result_summary.incorrect_count,
    result_summary.runtime_issue_count,
    result_summary.invalid_count,
    result_summary.missing_count,
    result_summary.not_applicable_count,
    result_summary.completed_count,
    result_summary.observed_count,
    result_summary.covered_domain_count,
    result_summary.provisional_domain_count,
        case
            when (result_summary.result_count = 0) then null::numeric
            else round((((result_summary.observed_count)::numeric * (100)::numeric) / (result_summary.result_count)::numeric), 1)
        end as coverage_percent
   from (aiq_private.aiq_runs run
     CROSS join LATERAL ( select (COALESCE(sum(domain_summary.result_count), (0)::bigint))::integer as result_count,
            (COALESCE(sum(domain_summary.correct_count), (0)::bigint))::integer as correct_count,
            (COALESCE(sum(domain_summary.partial_count), (0)::bigint))::integer as partial_count,
            (COALESCE(sum(domain_summary.incorrect_count), (0)::bigint))::integer as incorrect_count,
            (COALESCE(sum(domain_summary.runtime_issue_count), (0)::bigint))::integer as runtime_issue_count,
            (COALESCE(sum(domain_summary.invalid_count), (0)::bigint))::integer as invalid_count,
            (COALESCE(sum(domain_summary.missing_count), (0)::bigint))::integer as missing_count,
            (COALESCE(sum(domain_summary.not_applicable_count), (0)::bigint))::integer as not_applicable_count,
            (COALESCE(sum(domain_summary.completed_count), (0)::bigint))::integer as completed_count,
            (COALESCE(sum(domain_summary.observed_count), (0)::bigint))::integer as observed_count,
            (count(*) FILTER (where (domain_summary.observed_count >= 1)))::integer as covered_domain_count,
            (count(*) FILTER (where (domain_summary.observed_count >= 4)))::integer as provisional_domain_count
           from ( select result.domain,
                    (count(*))::integer as result_count,
                    (count(*) FILTER (where (result.outcome = 'correct'::aiq_private.result_outcome)))::integer as correct_count,
                    (count(*) FILTER (where (result.outcome = 'partial'::aiq_private.result_outcome)))::integer as partial_count,
                    (count(*) FILTER (where (result.outcome = 'incorrect'::aiq_private.result_outcome)))::integer as incorrect_count,
                    (count(*) FILTER (where (result.outcome = ANY (ARRAY['timeout'::aiq_private.result_outcome, 'budget_exhausted'::aiq_private.result_outcome, 'tool_failure'::aiq_private.result_outcome, 'policy_failure'::aiq_private.result_outcome, 'wrong_artifact'::aiq_private.result_outcome]))))::integer as runtime_issue_count,
                    (count(*) FILTER (where (result.outcome = 'invalid'::aiq_private.result_outcome)))::integer as invalid_count,
                    (count(*) FILTER (where (result.outcome = 'missing'::aiq_private.result_outcome)))::integer as missing_count,
                    (count(*) FILTER (where (result.outcome = 'not_applicable'::aiq_private.result_outcome)))::integer as not_applicable_count,
                    (count(*) FILTER (where (result.outcome = ANY (ARRAY['correct'::aiq_private.result_outcome, 'partial'::aiq_private.result_outcome, 'incorrect'::aiq_private.result_outcome]))))::integer as completed_count,
                    (count(*) FILTER (where (result.outcome <> all (ARRAY['invalid'::aiq_private.result_outcome, 'missing'::aiq_private.result_outcome, 'not_applicable'::aiq_private.result_outcome]))))::integer as observed_count
                   from aiq_private.aiq_task_results result
                  where (result.run_id = run.run_id)
                  GROUP BY result.domain) domain_summary) result_summary)
  where run.published;


--
-- Name: public_scoring_versions; Type: view; Schema: public; Owner: -
--

create view public.public_scoring_versions with (security_invoker = true) as
 select benchmark_version,
    scoring_version,
    published_at,
    principles,
    missing_policy,
    failure_policy_text as failure_policy,
    confidence_policy as sensitivity_policy,
    synthetic
   from aiq_private.aiq_scoring_versions
  where is_published;


--
-- Name: view public_scoring_versions; Type: COMMENT; Schema: public; Owner: -
--

comment on view public.public_scoring_versions IS 'Published scoring metadata. The sensitivity policy describes deterministic fixed-fixture task-mix variation and does not claim inferential confidence coverage.';


--
-- Name: public_task_coverage; Type: view; Schema: public; Owner: -
--

create view public.public_task_coverage with (security_invoker = true) as
 with expected as (
         select aiq_task_catalog.task_set_id,
            aiq_task_catalog.task_set_version,
            aiq_task_catalog.domain,
            (count(*))::integer as task_count
           from aiq_private.aiq_task_catalog
          where aiq_task_catalog.public_metadata
          GROUP BY aiq_task_catalog.task_set_id, aiq_task_catalog.task_set_version, aiq_task_catalog.domain
        )
 select scoring.scoring_version,
    expected.domain,
    COALESCE(((scoring.formula ->> 'domain_weight'::text))::numeric, (((scoring.formula -> 'domain_weights'::text) ->> expected.domain))::numeric) as weight,
    expected.task_count
   from (aiq_private.aiq_scoring_versions scoring
     join expected on (((expected.task_set_id = split_part(scoring.benchmark_version, '@'::text, 1)) and (expected.task_set_version = split_part(scoring.benchmark_version, '@'::text, 2)))))
  where scoring.is_published;


--
-- Name: view public_task_coverage; Type: COMMENT; Schema: public; Owner: -
--

comment on view public.public_task_coverage IS 'Published task counts and canonical equal domain weight for each scoring version.';



--
-- Name: aiq_artifact_claim_bindings aiq_artifact_claim_bindings_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_artifact_claim_bindings
    ADD constraint aiq_artifact_claim_bindings_pkey primary key (inbox_id, artifact_kind, content_sha256);


--
-- Name: aiq_artifact_ingress_claims aiq_artifact_ingress_claims_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_artifact_ingress_claims
    ADD constraint aiq_artifact_ingress_claims_pkey primary key (claimed_run_id, artifact_kind, content_sha256);


--
-- Name: aiq_artifact_ingress_objects aiq_artifact_ingress_objects_bucket_name_object_path_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_artifact_ingress_objects
    ADD constraint aiq_artifact_ingress_objects_bucket_name_object_path_key unique (bucket_name, object_path);


--
-- Name: aiq_artifact_ingress_objects aiq_artifact_ingress_objects_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_artifact_ingress_objects
    ADD constraint aiq_artifact_ingress_objects_pkey primary key (artifact_kind, content_sha256);


--
-- Name: aiq_claim_artifact_reference_events aiq_claim_artifact_reference__inbox_id_lease_token_attempt__key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_claim_artifact_reference_events
    ADD constraint aiq_claim_artifact_reference__inbox_id_lease_token_attempt__key unique (inbox_id, lease_token, attempt, artifact_kind, content_sha256, transition);


--
-- Name: aiq_claim_artifact_reference_events aiq_claim_artifact_reference_events_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_claim_artifact_reference_events
    ADD constraint aiq_claim_artifact_reference_events_pkey primary key (event_id);


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_i_run_id_assignment_id_model_co_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_aggregation_inputs
    ADD constraint aiq_distributed_aggregation_i_run_id_assignment_id_model_co_key unique (run_id, assignment_id, model_config_id);


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_i_task_package_id_package_versi_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_aggregation_inputs
    ADD constraint aiq_distributed_aggregation_i_task_package_id_package_versi_key unique (task_package_id, package_version, node_id, input_sequence);


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_inputs_input_hash_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_aggregation_inputs
    ADD constraint aiq_distributed_aggregation_inputs_input_hash_key unique (input_hash);


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_inputs_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_aggregation_inputs
    ADD constraint aiq_distributed_aggregation_inputs_pkey primary key (aggregation_input_id);


--
-- Name: aiq_distributed_assignment_models aiq_distributed_assignment_mo_run_id_assignment_id_lease_at_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignment_models
    ADD constraint aiq_distributed_assignment_mo_run_id_assignment_id_lease_at_key unique (run_id, assignment_id, lease_attempt, node_id, model_config_id, synthetic);


--
-- Name: aiq_distributed_assignment_models aiq_distributed_assignment_models_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignment_models
    ADD constraint aiq_distributed_assignment_models_pkey primary key (run_id, assignment_id, lease_attempt, model_config_id);


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_assignment_hash_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_assignment_hash_key unique (assignment_hash);


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_assignment_id_lease_attempt_no_key1; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_assignment_id_lease_attempt_no_key1 unique (assignment_id, lease_attempt, node_id, synthetic);


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_assignment_id_lease_attempt_nod_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_assignment_id_lease_attempt_nod_key unique (assignment_id, lease_attempt, node_id);


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_lease_id_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_lease_id_key unique (lease_id);


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_node_id_assignment_sequence_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_node_id_assignment_sequence_key unique (node_id, assignment_sequence);


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_pkey primary key (assignment_id, lease_attempt);


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_run_id_assignment_id_lease_atte_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_run_id_assignment_id_lease_atte_key unique (run_id, assignment_id, lease_attempt, node_id, synthetic);


--
-- Name: aiq_distributed_capability_declarations aiq_distributed_capability_de_declaration_id_node_id_synthe_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_capability_declarations
    ADD constraint aiq_distributed_capability_de_declaration_id_node_id_synthe_key unique (declaration_id, node_id, synthetic);


--
-- Name: aiq_distributed_capability_declarations aiq_distributed_capability_dec_node_id_declaration_sequence_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_capability_declarations
    ADD constraint aiq_distributed_capability_dec_node_id_declaration_sequence_key unique (node_id, declaration_sequence);


--
-- Name: aiq_distributed_capability_declarations aiq_distributed_capability_declarations_declaration_hash_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_capability_declarations
    ADD constraint aiq_distributed_capability_declarations_declaration_hash_key unique (declaration_hash);


--
-- Name: aiq_distributed_capability_declarations aiq_distributed_capability_declarations_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_capability_declarations
    ADD constraint aiq_distributed_capability_declarations_pkey primary key (declaration_id);


--
-- Name: aiq_distributed_node_observations aiq_distributed_node_observat_observation_id_node_id_synthe_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_node_observations
    ADD constraint aiq_distributed_node_observat_observation_id_node_id_synthe_key unique (observation_id, node_id, synthetic);


--
-- Name: aiq_distributed_node_observations aiq_distributed_node_observati_node_id_observation_sequence_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_node_observations
    ADD constraint aiq_distributed_node_observati_node_id_observation_sequence_key unique (node_id, observation_sequence);


--
-- Name: aiq_distributed_node_observations aiq_distributed_node_observations_observation_hash_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_node_observations
    ADD constraint aiq_distributed_node_observations_observation_hash_key unique (observation_hash);


--
-- Name: aiq_distributed_node_observations aiq_distributed_node_observations_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_node_observations
    ADD constraint aiq_distributed_node_observations_pkey primary key (observation_id);


--
-- Name: aiq_distributed_result_receipts aiq_distributed_result_receip_receipt_id_assignment_id_leas_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_result_receipts
    ADD constraint aiq_distributed_result_receip_receipt_id_assignment_id_leas_key unique (receipt_id, assignment_id, lease_attempt, node_id, receipt_hash, result_package_hash, synthetic);


--
-- Name: aiq_distributed_result_receipts aiq_distributed_result_receipts_assignment_id_lease_attempt_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_result_receipts
    ADD constraint aiq_distributed_result_receipts_assignment_id_lease_attempt_key unique (assignment_id, lease_attempt);


--
-- Name: aiq_distributed_result_receipts aiq_distributed_result_receipts_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_result_receipts
    ADD constraint aiq_distributed_result_receipts_pkey primary key (receipt_id);


--
-- Name: aiq_distributed_result_receipts aiq_distributed_result_receipts_receipt_hash_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_result_receipts
    ADD constraint aiq_distributed_result_receipts_receipt_hash_key unique (receipt_hash);


--
-- Name: aiq_distributed_result_receipts aiq_distributed_result_receipts_receipt_id_node_id_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_result_receipts
    ADD constraint aiq_distributed_result_receipts_receipt_id_node_id_key unique (receipt_id, node_id);


--
-- Name: aiq_distributed_task_packages aiq_distributed_task_packages_idempotency_key_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_task_packages
    ADD constraint aiq_distributed_task_packages_idempotency_key_key unique (idempotency_key);


--
-- Name: aiq_distributed_task_packages aiq_distributed_task_packages_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_task_packages
    ADD constraint aiq_distributed_task_packages_pkey primary key (task_package_id, package_version);


--
-- Name: aiq_distributed_task_packages aiq_distributed_task_packages_task_package_id_package_vers_key1; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_task_packages
    ADD constraint aiq_distributed_task_packages_task_package_id_package_vers_key1 unique (task_package_id, package_version, package_hash, synthetic);


--
-- Name: aiq_distributed_task_packages aiq_distributed_task_packages_task_package_id_package_versi_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_task_packages
    ADD constraint aiq_distributed_task_packages_task_package_id_package_versi_key unique (task_package_id, package_version, synthetic);


--
-- Name: aiq_matrix_batches aiq_matrix_batches_normalization_digest_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_matrix_batches
    ADD constraint aiq_matrix_batches_normalization_digest_key unique (normalization_digest);


--
-- Name: aiq_matrix_batches aiq_matrix_batches_package_sha256_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_matrix_batches
    ADD constraint aiq_matrix_batches_package_sha256_key unique (package_sha256);


alter table ONLY aiq_private.aiq_matrix_batches
    ADD constraint aiq_matrix_batches_identity_package_key unique (matrix_batch_id, package_sha256);


--
-- Name: aiq_matrix_batches aiq_matrix_batches_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_matrix_batches
    ADD constraint aiq_matrix_batches_pkey primary key (matrix_batch_id);


--
-- Name: aiq_model_configs aiq_model_configs_matrix_order_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_model_configs
    ADD constraint aiq_model_configs_matrix_order_key unique (matrix_order);


--
-- Name: aiq_model_configs aiq_model_configs_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_model_configs
    ADD constraint aiq_model_configs_pkey primary key (model_config_id);


--
-- Name: aiq_model_configs aiq_model_configs_provider_provider_model_id_reasoning_effo_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_model_configs
    ADD constraint aiq_model_configs_provider_provider_model_id_reasoning_effo_key unique (provider, provider_model_id, reasoning_effort);


--
-- Name: aiq_node_capability_snapshots aiq_node_capability_snapshots_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_node_capability_snapshots
    ADD constraint aiq_node_capability_snapshots_pkey primary key (capability_sha256);


--
-- Name: aiq_nodes aiq_nodes_key_fingerprint_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_nodes
    ADD constraint aiq_nodes_key_fingerprint_key unique (key_fingerprint);


--
-- Name: aiq_nodes aiq_nodes_node_synthetic_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_nodes
    ADD constraint aiq_nodes_node_synthetic_key unique (node_id, synthetic);


--
-- Name: aiq_nodes aiq_nodes_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_nodes
    ADD constraint aiq_nodes_pkey primary key (node_id);


--
-- Name: aiq_package_runs aiq_package_runs_package_sha256_matrix_order_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_package_runs
    ADD constraint aiq_package_runs_package_sha256_matrix_order_key unique (package_sha256, matrix_order);


--
-- Name: aiq_package_runs aiq_package_runs_package_sha256_model_config_id_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_package_runs
    ADD constraint aiq_package_runs_package_sha256_model_config_id_key unique (package_sha256, model_config_id);


--
-- Name: aiq_package_runs aiq_package_runs_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_package_runs
    ADD constraint aiq_package_runs_pkey primary key (package_sha256, run_id);


--
-- Name: aiq_package_runs aiq_package_runs_run_id_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_package_runs
    ADD constraint aiq_package_runs_run_id_key unique (run_id);


--
-- Name: aiq_publication_actors aiq_publication_actors_package_sha256_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_publication_actors
    ADD constraint aiq_publication_actors_package_sha256_key unique (package_sha256);


--
-- Name: aiq_publication_actors aiq_publication_actors_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_publication_actors
    ADD constraint aiq_publication_actors_pkey primary key (matrix_batch_id);


--
-- Name: aiq_result_packages aiq_result_packages_idempotency_key_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_result_packages
    ADD constraint aiq_result_packages_idempotency_key_key unique (idempotency_key);


--
-- Name: aiq_result_packages aiq_result_packages_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_result_packages
    ADD constraint aiq_result_packages_pkey primary key (package_sha256);


--
-- Name: aiq_runs aiq_runs_idempotency_key_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_runs
    ADD constraint aiq_runs_idempotency_key_key unique (idempotency_key);


--
-- Name: aiq_runs aiq_runs_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_runs
    ADD constraint aiq_runs_pkey primary key (run_id);


--
-- Name: aiq_score_snapshots aiq_score_snapshots_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_score_snapshots
    ADD constraint aiq_score_snapshots_pkey primary key (score_snapshot_id);


--
-- Name: aiq_score_snapshots aiq_score_snapshots_run_id_scoring_version_calculated_at_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_score_snapshots
    ADD constraint aiq_score_snapshots_run_id_scoring_version_calculated_at_key unique (run_id, scoring_version, calculated_at);


--
-- Name: aiq_scoring_versions aiq_scoring_versions_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_scoring_versions
    ADD constraint aiq_scoring_versions_pkey primary key (scoring_version);


--
-- Name: aiq_storage_legal_hold_events aiq_storage_legal_hold_events_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_legal_hold_events
    ADD constraint aiq_storage_legal_hold_events_pkey primary key (hold_event_id);


--
-- Name: aiq_storage_object_references aiq_storage_object_references_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_object_references
    ADD constraint aiq_storage_object_references_pkey primary key (reference_id);


--
-- Name: aiq_storage_object_references aiq_storage_object_references_reference_type_reference_key_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_object_references
    ADD constraint aiq_storage_object_references_reference_type_reference_key_key unique (reference_type, reference_key);


--
-- Name: aiq_storage_objects aiq_storage_objects_bucket_name_object_path_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_objects
    ADD constraint aiq_storage_objects_bucket_name_object_path_key unique (bucket_name, object_path);


--
-- Name: aiq_storage_objects aiq_storage_objects_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_objects
    ADD constraint aiq_storage_objects_pkey primary key (object_id);


alter table ONLY aiq_private.aiq_storage_objects
    ADD constraint aiq_storage_objects_identity_digest_key unique (object_id, content_sha256);


--
-- Name: aiq_storage_reconciliation_events aiq_storage_reconciliation_ev_bucket_name_object_path_misma_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_reconciliation_events
    ADD constraint aiq_storage_reconciliation_ev_bucket_name_object_path_misma_key unique (bucket_name, object_path, mismatch_type);


--
-- Name: aiq_storage_reconciliation_events aiq_storage_reconciliation_events_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_reconciliation_events
    ADD constraint aiq_storage_reconciliation_events_pkey primary key (event_id);


--
-- Name: aiq_submission_conflicts aiq_submission_conflicts_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_submission_conflicts
    ADD constraint aiq_submission_conflicts_pkey primary key (conflict_id);


--
-- Name: aiq_submission_inbox aiq_submission_inbox_idempotency_key_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_submission_inbox
    ADD constraint aiq_submission_inbox_idempotency_key_key unique (idempotency_key);


--
-- Name: aiq_submission_inbox aiq_submission_inbox_inbox_id_package_sha256_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_submission_inbox
    ADD constraint aiq_submission_inbox_inbox_id_package_sha256_key unique (inbox_id, package_sha256);


--
-- Name: aiq_submission_inbox aiq_submission_inbox_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_submission_inbox
    ADD constraint aiq_submission_inbox_pkey primary key (inbox_id);


--
-- Name: aiq_task_catalog aiq_task_catalog_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_task_catalog
    ADD constraint aiq_task_catalog_pkey primary key (task_set_id, task_set_version, task_id, task_version);


--
-- Name: aiq_task_results aiq_task_results_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_task_results
    ADD constraint aiq_task_results_pkey primary key (result_id);


--
-- Name: aiq_task_results aiq_task_results_run_id_task_id_task_version_attempt_number_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_task_results
    ADD constraint aiq_task_results_run_id_task_id_task_version_attempt_number_key unique (run_id, task_id, task_version, attempt_number);


--
-- Name: aiq_task_results aiq_task_results_source_result_id_key; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_task_results
    ADD constraint aiq_task_results_source_result_id_key unique (source_result_id);


--
-- Name: aiq_task_sets aiq_task_sets_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_task_sets
    ADD constraint aiq_task_sets_pkey primary key (task_set_id, task_set_version);


--
-- Name: aiq_verification_audit aiq_verification_audit_pkey; Type: constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_verification_audit
    ADD constraint aiq_verification_audit_pkey primary key (audit_id);


--
-- Name: aiq_artifact_ingress_claims_expiry_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_artifact_ingress_claims_expiry_idx on aiq_private.aiq_artifact_ingress_claims using btree (expires_at);


--
-- Name: aiq_artifact_ingress_objects_expiry_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_artifact_ingress_objects_expiry_idx on aiq_private.aiq_artifact_ingress_objects using btree (expires_at);


--
-- Name: aiq_claim_artifact_reference_events_inbox_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_claim_artifact_reference_events_inbox_idx on aiq_private.aiq_claim_artifact_reference_events using btree (inbox_id, attempt, recorded_at, event_id);


--
-- Name: aiq_distributed_aggregation_node_class_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_distributed_aggregation_node_class_idx on aiq_private.aiq_distributed_aggregation_inputs using btree (node_id, trust_classification, classified_at DESC);


--
-- Name: aiq_distributed_aggregation_receipt_model_key; Type: index; Schema: aiq_private; Owner: -
--

create unique index aiq_distributed_aggregation_receipt_model_key on aiq_private.aiq_distributed_aggregation_inputs using btree (receipt_id, model_config_id) where (receipt_id IS not null);


--
-- Name: aiq_distributed_assignments_node_status_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_distributed_assignments_node_status_idx on aiq_private.aiq_distributed_assignments using btree (node_id, status);


--
-- Name: aiq_distributed_capability_node_latest_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_distributed_capability_node_latest_idx on aiq_private.aiq_distributed_capability_declarations using btree (node_id, declaration_sequence DESC, issued_at DESC);


--
-- Name: aiq_distributed_observation_node_latest_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_distributed_observation_node_latest_idx on aiq_private.aiq_distributed_node_observations using btree (node_id, observation_sequence DESC, observed_at DESC);


--
-- Name: aiq_distributed_receipts_node_status_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_distributed_receipts_node_status_idx on aiq_private.aiq_distributed_result_receipts using btree (node_id, status);


--
-- Name: aiq_one_verifier_attestation_per_package; Type: index; Schema: aiq_private; Owner: -
--

create unique index aiq_one_verifier_attestation_per_package on aiq_private.aiq_verification_audit using btree (package_sha256) where (event_type = 'verifier_attested'::text);


--
-- Name: aiq_result_packages_run_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_result_packages_run_idx on aiq_private.aiq_result_packages using btree (run_id);


--
-- Name: aiq_runs_model_time_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_runs_model_time_idx on aiq_private.aiq_runs using btree (model_config_id, scheduled_for DESC);


--
-- Name: aiq_runs_public_history_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_runs_public_history_idx on aiq_private.aiq_runs using btree (started_at DESC, run_id) where published;


--
-- Name: aiq_runs_public_trend_extent_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_runs_public_trend_extent_idx on aiq_private.aiq_runs using btree (scheduled_for DESC) where published;


--
-- Name: aiq_runs_public_trend_series_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_runs_public_trend_series_idx on aiq_private.aiq_runs using btree (model_config_id, scheduled_for DESC, run_id DESC) where published;


--
-- Name: aiq_storage_legal_hold_events_object_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_storage_legal_hold_events_object_idx on aiq_private.aiq_storage_legal_hold_events using btree (object_id);


--
-- Name: aiq_storage_object_content_identity_idx; Type: index; Schema: aiq_private; Owner: -
--

create unique index aiq_storage_object_content_identity_idx on aiq_private.aiq_storage_objects using btree (object_type, COALESCE(artifact_kind, ''::text), content_sha256, byte_size);


--
-- Name: aiq_storage_object_references_live_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_storage_object_references_live_idx on aiq_private.aiq_storage_object_references using btree (object_id) where active;


--
-- Name: aiq_storage_object_references_object_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_storage_object_references_object_idx on aiq_private.aiq_storage_object_references using btree (object_id);


--
-- Name: aiq_storage_objects_claim_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_storage_objects_claim_idx on aiq_private.aiq_storage_objects using btree (next_attempt_at, expires_at, registered_at, object_id) where ((lifecycle_state <> 'deleted'::text) and (not legal_hold));


--
-- Name: aiq_storage_reconciliation_events_open_page_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_storage_reconciliation_events_open_page_idx on aiq_private.aiq_storage_reconciliation_events using btree (bucket_name, object_path, mismatch_type) where (resolved_at IS null);

create index aiq_storage_inventory_epoch_latest_idx on aiq_private.aiq_storage_reconciliation_events using btree (last_observed_at DESC) where (mismatch_type = 'inventory_success'::text);


--
-- Name: aiq_submission_claimable_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_submission_claimable_idx on aiq_private.aiq_submission_inbox using btree (received_at, inbox_id) where ((state = 'queued'::text) and (verification_status = 'unverified'::text));


--
-- Name: aiq_submission_conflicts_expiry_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_submission_conflicts_expiry_idx on aiq_private.aiq_submission_conflicts using btree (expires_at) where (retention_state = 'active'::text);


--
-- Name: aiq_submission_conflicts_inbox_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_submission_conflicts_inbox_idx on aiq_private.aiq_submission_conflicts using btree (inbox_id);


--
-- Name: aiq_submission_inbox_expiry_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_submission_inbox_expiry_idx on aiq_private.aiq_submission_inbox using btree (expires_at) where (retention_state = 'active'::text);


--
-- Name: aiq_submission_inbox_package_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_submission_inbox_package_idx on aiq_private.aiq_submission_inbox using btree (package_sha256);


--
-- Name: aiq_task_catalog_domain_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_task_catalog_domain_idx on aiq_private.aiq_task_catalog using btree (task_set_id, task_set_version, domain, difficulty);


--
-- Name: aiq_task_catalog_ordinal_idx; Type: index; Schema: aiq_private; Owner: -
--

create unique index aiq_task_catalog_ordinal_idx on aiq_private.aiq_task_catalog using btree (task_set_id, task_set_version, catalog_ordinal) where (catalog_ordinal IS not null);


--
-- Name: aiq_task_results_run_domain_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_task_results_run_domain_idx on aiq_private.aiq_task_results using btree (run_id, domain);


--
-- Name: aiq_task_results_run_domain_outcome_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_task_results_run_domain_outcome_idx on aiq_private.aiq_task_results using btree (run_id, domain, outcome);


--
-- Name: aiq_verification_audit_evidence_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_verification_audit_evidence_idx on aiq_private.aiq_verification_audit using btree (inbox_id, package_sha256, event_type);


--
-- Name: aiq_verification_audit_run_idx; Type: index; Schema: aiq_private; Owner: -
--

create index aiq_verification_audit_run_idx on aiq_private.aiq_verification_audit using btree (run_id, recorded_at);


--
-- Name: aiq_artifact_claim_bindings aiq_artifact_claim_binding_reference; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_artifact_claim_binding_reference after insert or delete on aiq_private.aiq_artifact_claim_bindings for each row execute function aiq_private.sync_artifact_storage_reference();


--
-- Name: aiq_artifact_claim_bindings aiq_artifact_claim_bindings_immutable; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_artifact_claim_bindings_immutable before delete or update on aiq_private.aiq_artifact_claim_bindings for each row execute function aiq_private.reject_artifact_ingress_mutation();


--
-- Name: aiq_artifact_ingress_claims aiq_artifact_ingress_claim_reference; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_artifact_ingress_claim_reference after insert or delete on aiq_private.aiq_artifact_ingress_claims for each row execute function aiq_private.sync_artifact_storage_reference();


--
-- Name: aiq_artifact_ingress_claims aiq_artifact_ingress_claims_immutable; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_artifact_ingress_claims_immutable before delete or update on aiq_private.aiq_artifact_ingress_claims for each row execute function aiq_private.reject_artifact_ingress_mutation();


--
-- Name: aiq_artifact_ingress_objects aiq_artifact_ingress_object_registry; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_artifact_ingress_object_registry after insert on aiq_private.aiq_artifact_ingress_objects for each row execute function aiq_private.sync_artifact_storage_reference();


--
-- Name: aiq_artifact_ingress_objects aiq_artifact_ingress_objects_immutable; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_artifact_ingress_objects_immutable before delete or update on aiq_private.aiq_artifact_ingress_objects for each row execute function aiq_private.reject_artifact_ingress_mutation();


--
-- Name: aiq_claim_artifact_reference_events aiq_claim_artifact_reference_events_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_claim_artifact_reference_events_append_only before delete or update on aiq_private.aiq_claim_artifact_reference_events for each row execute function aiq_private.reject_claim_artifact_reference_event_mutation();


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_aggregation_append_only before delete or update on aiq_private.aiq_distributed_aggregation_inputs for each row execute function aiq_private.reject_distributed_evidence_mutation();


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_validate; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_aggregation_validate before insert on aiq_private.aiq_distributed_aggregation_inputs for each row execute function aiq_private.validate_distributed_aggregation_input();


--
-- Name: aiq_distributed_assignment_models aiq_distributed_assignment_models_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_assignment_models_append_only before delete or update on aiq_private.aiq_distributed_assignment_models for each row execute function aiq_private.reject_distributed_evidence_mutation();


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_forward_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_assignments_forward_only before update on aiq_private.aiq_distributed_assignments for each row execute function aiq_private.enforce_distributed_assignment_transition();


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_no_delete; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_assignments_no_delete before delete on aiq_private.aiq_distributed_assignments for each row execute function aiq_private.reject_distributed_evidence_mutation();


--
-- Name: aiq_distributed_capability_declarations aiq_distributed_capabilities_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_capabilities_append_only before delete or update on aiq_private.aiq_distributed_capability_declarations for each row execute function aiq_private.reject_distributed_evidence_mutation();


--
-- Name: aiq_distributed_node_observations aiq_distributed_observations_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_observations_append_only before delete or update on aiq_private.aiq_distributed_node_observations for each row execute function aiq_private.reject_distributed_evidence_mutation();


--
-- Name: aiq_distributed_result_receipts aiq_distributed_receipts_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_receipts_append_only before delete or update on aiq_private.aiq_distributed_result_receipts for each row execute function aiq_private.reject_distributed_evidence_mutation();


--
-- Name: aiq_distributed_task_packages aiq_distributed_task_packages_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_distributed_task_packages_append_only before delete or update on aiq_private.aiq_distributed_task_packages for each row execute function aiq_private.reject_distributed_evidence_mutation();


--
-- Name: aiq_matrix_batches aiq_matrix_batches_lifecycle_guard; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_matrix_batches_lifecycle_guard before delete or update on aiq_private.aiq_matrix_batches for each row execute function aiq_private.guard_matrix_batch_lifecycle();


--
-- Name: aiq_nodes aiq_nodes_identity_lifecycle_guard; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_nodes_identity_lifecycle_guard before update on aiq_private.aiq_nodes for each row execute function aiq_private.guard_node_identity_lifecycle();


--
-- Name: aiq_package_runs aiq_package_runs_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_package_runs_append_only before delete or update on aiq_private.aiq_package_runs for each row execute function aiq_private.reject_staged_evidence_mutation();


--
-- Name: aiq_package_runs aiq_package_runs_unpublished_insert; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_package_runs_unpublished_insert before insert on aiq_private.aiq_package_runs for each row execute function aiq_private.guard_evidence_insert_for_unpublished_run();


--
-- Name: aiq_publication_actors aiq_publication_actors_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_publication_actors_append_only before delete or update on aiq_private.aiq_publication_actors for each row execute function aiq_private.reject_staged_evidence_mutation();


--
-- Name: aiq_result_packages aiq_result_packages_lifecycle_guard; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_result_packages_lifecycle_guard before delete or update on aiq_private.aiq_result_packages for each row execute function aiq_private.guard_result_package_lifecycle();


--
-- Name: aiq_runs aiq_runs_lifecycle_guard; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_runs_lifecycle_guard before delete or update on aiq_private.aiq_runs for each row execute function aiq_private.guard_run_lifecycle();


--
-- Name: aiq_score_snapshots aiq_score_snapshots_lifecycle_guard; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_score_snapshots_lifecycle_guard before insert or delete or update on aiq_private.aiq_score_snapshots for each row execute function aiq_private.guard_score_snapshot_lifecycle();


--
-- Name: aiq_storage_legal_hold_events aiq_storage_legal_hold_events_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_storage_legal_hold_events_append_only before delete or update on aiq_private.aiq_storage_legal_hold_events for each row execute function aiq_private.reject_storage_history_mutation();


--
-- Name: aiq_storage_objects aiq_storage_objects_guard; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_storage_objects_guard before delete or update on aiq_private.aiq_storage_objects for each row execute function aiq_private.guard_storage_registry_mutation();


create trigger aiq_storage_reconciliation_history_guard before delete or update on aiq_private.aiq_storage_reconciliation_events for each row execute function aiq_private.guard_storage_reconciliation_history();


--
-- Name: aiq_submission_conflicts aiq_submission_conflict_storage_reference; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_submission_conflict_storage_reference after insert or delete or update OF object_bucket, object_key, object_content_sha256, object_bytes on aiq_private.aiq_submission_conflicts for each row execute function aiq_private.sync_submission_storage_reference();


--
-- Name: aiq_submission_inbox aiq_submission_inbox_lifecycle_guard; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_submission_inbox_lifecycle_guard before delete or update on aiq_private.aiq_submission_inbox for each row execute function aiq_private.guard_submission_inbox_lifecycle();


--
-- Name: aiq_submission_inbox aiq_submission_inbox_storage_reference; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_submission_inbox_storage_reference after insert or delete or update OF object_bucket, object_key, object_content_sha256, object_bytes on aiq_private.aiq_submission_inbox for each row execute function aiq_private.sync_submission_storage_reference();


--
-- Name: aiq_task_results aiq_task_results_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_task_results_append_only before delete or update on aiq_private.aiq_task_results for each row execute function aiq_private.reject_staged_evidence_mutation();


--
-- Name: aiq_task_results aiq_task_results_unpublished_insert; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_task_results_unpublished_insert before insert on aiq_private.aiq_task_results for each row execute function aiq_private.guard_evidence_insert_for_unpublished_run();


--
-- Name: aiq_verification_audit aiq_audit_publication_eligible; Type: trigger; Schema: aiq_private; Owner: -
--

create constraint trigger aiq_audit_publication_eligible after insert on aiq_private.aiq_verification_audit DEFERRABLE INITIALLY DEFERRED for each row execute function aiq_private.assert_publication_transition_eligible();


--
-- Name: aiq_matrix_batches aiq_batches_publication_eligible; Type: trigger; Schema: aiq_private; Owner: -
--

create constraint trigger aiq_batches_publication_eligible after insert or update on aiq_private.aiq_matrix_batches DEFERRABLE INITIALLY DEFERRED for each row when (((new.verified_at IS not null) or (new.published_at IS not null))) execute function aiq_private.assert_publication_transition_eligible();


--
-- Name: aiq_submission_inbox aiq_inbox_publication_eligible; Type: trigger; Schema: aiq_private; Owner: -
--

create constraint trigger aiq_inbox_publication_eligible after insert or update on aiq_private.aiq_submission_inbox DEFERRABLE INITIALLY DEFERRED for each row when ((new.verification_status = 'verified'::text)) execute function aiq_private.assert_publication_transition_eligible();


--
-- Name: aiq_result_packages aiq_packages_publication_eligible; Type: trigger; Schema: aiq_private; Owner: -
--

create constraint trigger aiq_packages_publication_eligible after insert or update on aiq_private.aiq_result_packages DEFERRABLE INITIALLY DEFERRED for each row when ((new.signature_verified or (new.verifier_attestation IS not null) or (new.verified_at IS not null) or (new.trust_tier >= 'trusted_verified'::aiq_private.trust_tier))) execute function aiq_private.assert_publication_transition_eligible();


--
-- Name: aiq_runs aiq_runs_publication_eligible; Type: trigger; Schema: aiq_private; Owner: -
--

create constraint trigger aiq_runs_publication_eligible after insert or update on aiq_private.aiq_runs DEFERRABLE INITIALLY DEFERRED for each row when ((new.published or (new.trust_tier >= 'trusted_verified'::aiq_private.trust_tier))) execute function aiq_private.assert_publication_transition_eligible();


--
-- Name: aiq_score_snapshots aiq_scores_publication_eligible; Type: trigger; Schema: aiq_private; Owner: -
--

create constraint trigger aiq_scores_publication_eligible after insert or update on aiq_private.aiq_score_snapshots DEFERRABLE INITIALLY DEFERRED for each row when (new.published) execute function aiq_private.assert_publication_transition_eligible();


--
-- Name: aiq_verification_audit aiq_verification_audit_append_only; Type: trigger; Schema: aiq_private; Owner: -
--

create trigger aiq_verification_audit_append_only before delete or update on aiq_private.aiq_verification_audit for each row execute function aiq_private.reject_verification_audit_mutation();


--
-- Name: aiq_artifact_claim_bindings aiq_artifact_claim_bindings_artifact_kind_content_sha256_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_artifact_claim_bindings
    ADD constraint aiq_artifact_claim_bindings_artifact_kind_content_sha256_fkey FOREIGN key (artifact_kind, content_sha256) references aiq_private.aiq_artifact_ingress_objects(artifact_kind, content_sha256) on delete restrict;


--
-- Name: aiq_artifact_claim_bindings aiq_artifact_claim_bindings_inbox_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_artifact_claim_bindings
    ADD constraint aiq_artifact_claim_bindings_inbox_id_fkey FOREIGN key (inbox_id) references aiq_private.aiq_submission_inbox(inbox_id) on delete restrict;


--
-- Name: aiq_artifact_ingress_claims aiq_artifact_ingress_claims_artifact_kind_content_sha256_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_artifact_ingress_claims
    ADD constraint aiq_artifact_ingress_claims_artifact_kind_content_sha256_fkey FOREIGN key (artifact_kind, content_sha256) references aiq_private.aiq_artifact_ingress_objects(artifact_kind, content_sha256) on delete restrict;


--
-- Name: aiq_claim_artifact_reference_events aiq_claim_artifact_reference__inbox_id_artifact_kind_conte_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_claim_artifact_reference_events
    ADD constraint aiq_claim_artifact_reference__inbox_id_artifact_kind_conte_fkey FOREIGN key (inbox_id, artifact_kind, content_sha256) references aiq_private.aiq_artifact_claim_bindings(inbox_id, artifact_kind, content_sha256) on delete restrict;


--
-- Name: aiq_claim_artifact_reference_events aiq_claim_artifact_reference_events_inbox_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_claim_artifact_reference_events
    ADD constraint aiq_claim_artifact_reference_events_inbox_id_fkey FOREIGN key (inbox_id) references aiq_private.aiq_submission_inbox(inbox_id) on delete restrict;


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_i_observation_id_node_id_synth_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_aggregation_inputs
    ADD constraint aiq_distributed_aggregation_i_observation_id_node_id_synth_fkey FOREIGN key (observation_id, node_id, synthetic) references aiq_private.aiq_distributed_node_observations(observation_id, node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_i_receipt_id_assignment_id_lea_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_aggregation_inputs
    ADD constraint aiq_distributed_aggregation_i_receipt_id_assignment_id_lea_fkey FOREIGN key (receipt_id, assignment_id, lease_attempt, node_id, receipt_hash, result_package_hash, synthetic) references aiq_private.aiq_distributed_result_receipts(receipt_id, assignment_id, lease_attempt, node_id, receipt_hash, result_package_hash, synthetic) on delete restrict;


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_i_run_id_assignment_id_lease_a_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_aggregation_inputs
    ADD constraint aiq_distributed_aggregation_i_run_id_assignment_id_lease_a_fkey FOREIGN key (run_id, assignment_id, lease_attempt, node_id, model_config_id, synthetic) references aiq_private.aiq_distributed_assignment_models(run_id, assignment_id, lease_attempt, node_id, model_config_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_i_task_package_id_package_vers_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_aggregation_inputs
    ADD constraint aiq_distributed_aggregation_i_task_package_id_package_vers_fkey FOREIGN key (task_package_id, package_version, synthetic) references aiq_private.aiq_distributed_task_packages(task_package_id, package_version, synthetic) on delete restrict;


--
-- Name: aiq_distributed_assignment_models aiq_distributed_assignment_mo_run_id_assignment_id_lease_a_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignment_models
    ADD constraint aiq_distributed_assignment_mo_run_id_assignment_id_lease_a_fkey FOREIGN key (run_id, assignment_id, lease_attempt, node_id, synthetic) references aiq_private.aiq_distributed_assignments(run_id, assignment_id, lease_attempt, node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_assignment_models aiq_distributed_assignment_models_model_config_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignment_models
    ADD constraint aiq_distributed_assignment_models_model_config_id_fkey FOREIGN key (model_config_id) references aiq_private.aiq_model_configs(model_config_id) on delete restrict;


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_coordinator_node_id_synthetic_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_coordinator_node_id_synthetic_fkey FOREIGN key (coordinator_node_id, synthetic) references aiq_private.aiq_nodes(node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_node_id_synthetic_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_node_id_synthetic_fkey FOREIGN key (node_id, synthetic) references aiq_private.aiq_nodes(node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_task_package_id_package_versio_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_assignments
    ADD constraint aiq_distributed_assignments_task_package_id_package_versio_fkey FOREIGN key (task_package_id, package_version, package_hash, synthetic) references aiq_private.aiq_distributed_task_packages(task_package_id, package_version, package_hash, synthetic) on delete restrict;


--
-- Name: aiq_distributed_capability_declarations aiq_distributed_capability_declarations_node_id_synthetic_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_capability_declarations
    ADD constraint aiq_distributed_capability_declarations_node_id_synthetic_fkey FOREIGN key (node_id, synthetic) references aiq_private.aiq_nodes(node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_node_observations aiq_distributed_node_observat_declaration_id_node_id_synth_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_node_observations
    ADD constraint aiq_distributed_node_observat_declaration_id_node_id_synth_fkey FOREIGN key (declaration_id, node_id, synthetic) references aiq_private.aiq_distributed_capability_declarations(declaration_id, node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_result_receipts aiq_distributed_result_receip_assignment_id_lease_attempt__fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_result_receipts
    ADD constraint aiq_distributed_result_receip_assignment_id_lease_attempt__fkey FOREIGN key (assignment_id, lease_attempt, node_id, synthetic) references aiq_private.aiq_distributed_assignments(assignment_id, lease_attempt, node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_result_receipts aiq_distributed_result_receipts_node_id_synthetic_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_result_receipts
    ADD constraint aiq_distributed_result_receipts_node_id_synthetic_fkey FOREIGN key (node_id, synthetic) references aiq_private.aiq_nodes(node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_result_receipts aiq_distributed_result_receipts_receiver_node_id_synthetic_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_result_receipts
    ADD constraint aiq_distributed_result_receipts_receiver_node_id_synthetic_fkey FOREIGN key (receiver_node_id, synthetic) references aiq_private.aiq_nodes(node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_task_packages aiq_distributed_task_packages_coordinator_node_id_syntheti_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_task_packages
    ADD constraint aiq_distributed_task_packages_coordinator_node_id_syntheti_fkey FOREIGN key (coordinator_node_id, synthetic) references aiq_private.aiq_nodes(node_id, synthetic) on delete restrict;


--
-- Name: aiq_distributed_task_packages aiq_distributed_task_packages_task_set_id_task_set_version_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_distributed_task_packages
    ADD constraint aiq_distributed_task_packages_task_set_id_task_set_version_fkey FOREIGN key (task_set_id, task_set_version) references aiq_private.aiq_task_sets(task_set_id, task_set_version) on delete restrict;


--
-- Name: aiq_matrix_batches aiq_matrix_batches_scoring_version_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_matrix_batches
    ADD constraint aiq_matrix_batches_scoring_version_fkey FOREIGN key (scoring_version) references aiq_private.aiq_scoring_versions(scoring_version) on delete restrict;


--
-- Name: aiq_matrix_batches aiq_matrix_batches_source_scoring_version_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_matrix_batches
    ADD constraint aiq_matrix_batches_source_scoring_version_fkey FOREIGN key (source_scoring_version) references aiq_private.aiq_scoring_versions(scoring_version) on delete restrict;


--
-- Name: aiq_matrix_batches aiq_matrix_batches_source_node_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_matrix_batches
    ADD constraint aiq_matrix_batches_source_node_id_fkey FOREIGN key (source_node_id) references aiq_private.aiq_nodes(node_id) on delete restrict;


--
-- Name: aiq_matrix_batches aiq_matrix_batches_task_set_id_task_set_version_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_matrix_batches
    ADD constraint aiq_matrix_batches_task_set_id_task_set_version_fkey FOREIGN key (task_set_id, task_set_version) references aiq_private.aiq_task_sets(task_set_id, task_set_version) on delete restrict;


--
-- Name: aiq_node_capability_snapshots aiq_node_capability_snapshots_node_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_node_capability_snapshots
    ADD constraint aiq_node_capability_snapshots_node_id_fkey FOREIGN key (node_id) references aiq_private.aiq_nodes(node_id) on delete restrict;


--
-- Name: aiq_package_runs aiq_package_runs_model_config_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_package_runs
    ADD constraint aiq_package_runs_model_config_id_fkey FOREIGN key (model_config_id) references aiq_private.aiq_model_configs(model_config_id) on delete restrict;


--
-- Name: aiq_package_runs aiq_package_runs_package_sha256_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_package_runs
    ADD constraint aiq_package_runs_package_sha256_fkey FOREIGN key (package_sha256) references aiq_private.aiq_result_packages(package_sha256) on delete restrict;


--
-- Name: aiq_package_runs aiq_package_runs_run_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_package_runs
    ADD constraint aiq_package_runs_run_id_fkey FOREIGN key (run_id) references aiq_private.aiq_runs(run_id) on delete restrict;


--
-- Name: aiq_publication_actors aiq_publication_actors_matrix_batch_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_publication_actors
    ADD constraint aiq_publication_actors_matrix_batch_id_fkey FOREIGN key (matrix_batch_id) references aiq_private.aiq_matrix_batches(matrix_batch_id) on delete restrict;


--
-- Name: aiq_publication_actors aiq_publication_actors_package_sha256_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_publication_actors
    ADD constraint aiq_publication_actors_package_sha256_fkey FOREIGN key (package_sha256) references aiq_private.aiq_result_packages(package_sha256) on delete restrict;


--
-- Name: aiq_publication_actors aiq_publication_actors_publisher_node_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_publication_actors
    ADD constraint aiq_publication_actors_publisher_node_id_fkey FOREIGN key (publisher_node_id) references aiq_private.aiq_nodes(node_id) on delete restrict;


--
-- Name: aiq_result_packages aiq_result_packages_node_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_result_packages
    ADD constraint aiq_result_packages_node_id_fkey FOREIGN key (node_id) references aiq_private.aiq_nodes(node_id) on delete restrict;


--
-- Name: aiq_runs aiq_runs_capability_sha256_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_runs
    ADD constraint aiq_runs_capability_sha256_fkey FOREIGN key (capability_sha256) references aiq_private.aiq_node_capability_snapshots(capability_sha256);


--
-- Name: aiq_runs aiq_runs_model_config_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_runs
    ADD constraint aiq_runs_model_config_id_fkey FOREIGN key (model_config_id) references aiq_private.aiq_model_configs(model_config_id);


--
-- Name: aiq_runs aiq_runs_scoring_version_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_runs
    ADD constraint aiq_runs_scoring_version_fkey FOREIGN key (scoring_version) references aiq_private.aiq_scoring_versions(scoring_version);


--
-- Name: aiq_runs aiq_runs_source_node_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_runs
    ADD constraint aiq_runs_source_node_id_fkey FOREIGN key (source_node_id) references aiq_private.aiq_nodes(node_id);


--
-- Name: aiq_runs aiq_runs_task_set_id_task_set_version_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_runs
    ADD constraint aiq_runs_task_set_id_task_set_version_fkey FOREIGN key (task_set_id, task_set_version) references aiq_private.aiq_task_sets(task_set_id, task_set_version) on delete restrict;


--
-- Name: aiq_score_snapshots aiq_score_snapshots_run_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_score_snapshots
    ADD constraint aiq_score_snapshots_run_id_fkey FOREIGN key (run_id) references aiq_private.aiq_runs(run_id) on delete restrict;


--
-- Name: aiq_score_snapshots aiq_score_snapshots_scoring_version_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_score_snapshots
    ADD constraint aiq_score_snapshots_scoring_version_fkey FOREIGN key (scoring_version) references aiq_private.aiq_scoring_versions(scoring_version);


--
-- Name: aiq_storage_legal_hold_events aiq_storage_legal_hold_events_object_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_legal_hold_events
    ADD constraint aiq_storage_legal_hold_events_object_id_fkey FOREIGN key (object_id) references aiq_private.aiq_storage_objects(object_id) on delete restrict;


--
-- Name: aiq_storage_object_references aiq_storage_object_references_object_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_storage_object_references
    ADD constraint aiq_storage_object_references_object_id_fkey FOREIGN key (object_id) references aiq_private.aiq_storage_objects(object_id) on delete restrict;


--
-- Name: aiq_submission_conflicts aiq_submission_conflicts_inbox_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_submission_conflicts
    ADD constraint aiq_submission_conflicts_inbox_id_fkey FOREIGN key (inbox_id) references aiq_private.aiq_submission_inbox(inbox_id) on delete restrict;


--
-- Name: aiq_task_catalog aiq_task_catalog_task_set_id_task_set_version_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_task_catalog
    ADD constraint aiq_task_catalog_task_set_id_task_set_version_fkey FOREIGN key (task_set_id, task_set_version) references aiq_private.aiq_task_sets(task_set_id, task_set_version) on delete restrict;


--
-- Name: aiq_task_results aiq_task_results_run_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_task_results
    ADD constraint aiq_task_results_run_id_fkey FOREIGN key (run_id) references aiq_private.aiq_runs(run_id) on delete restrict;


--
-- Name: aiq_verification_audit aiq_verification_audit_actor_node_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_verification_audit
    ADD constraint aiq_verification_audit_actor_node_id_fkey FOREIGN key (actor_node_id) references aiq_private.aiq_nodes(node_id) on delete restrict;


--
-- Name: aiq_verification_audit aiq_verification_audit_inbox_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_verification_audit
    ADD constraint aiq_verification_audit_inbox_id_fkey FOREIGN key (inbox_id) references aiq_private.aiq_submission_inbox(inbox_id) on delete restrict;


--
-- Name: aiq_verification_audit aiq_verification_audit_run_id_fkey; Type: FK constraint; Schema: aiq_private; Owner: -
--

alter table ONLY aiq_private.aiq_verification_audit
    ADD constraint aiq_verification_audit_run_id_fkey FOREIGN key (run_id) references aiq_private.aiq_runs(run_id) on delete restrict;


--
-- Name: aiq_artifact_claim_bindings; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_artifact_claim_bindings enable row level security;

--
-- Name: aiq_artifact_ingress_claims; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_artifact_ingress_claims enable row level security;

--
-- Name: aiq_artifact_ingress_objects; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_artifact_ingress_objects enable row level security;

--
-- Name: aiq_claim_artifact_reference_events; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_claim_artifact_reference_events enable row level security;

--
-- Name: aiq_distributed_aggregation_inputs; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_distributed_aggregation_inputs enable row level security;

--
-- Name: aiq_distributed_aggregation_inputs aiq_distributed_aggregation_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_distributed_aggregation_public_read on aiq_private.aiq_distributed_aggregation_inputs for select to anon, authenticated using ((EXISTS ( select 1
   from aiq_private.aiq_nodes node
  where ((node.node_id = aiq_distributed_aggregation_inputs.node_id) and node.public_visible))));


--
-- Name: aiq_distributed_assignment_models; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_distributed_assignment_models enable row level security;

--
-- Name: aiq_distributed_assignments; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_distributed_assignments enable row level security;

--
-- Name: aiq_distributed_assignments aiq_distributed_assignments_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_distributed_assignments_public_read on aiq_private.aiq_distributed_assignments for select to anon, authenticated using ((EXISTS ( select 1
   from aiq_private.aiq_nodes node
  where ((node.node_id = aiq_distributed_assignments.node_id) and node.public_visible))));


--
-- Name: aiq_distributed_capability_declarations aiq_distributed_capabilities_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_distributed_capabilities_public_read on aiq_private.aiq_distributed_capability_declarations for select to anon, authenticated using ((EXISTS ( select 1
   from aiq_private.aiq_nodes node
  where ((node.node_id = aiq_distributed_capability_declarations.node_id) and node.public_visible))));


--
-- Name: aiq_distributed_capability_declarations; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_distributed_capability_declarations enable row level security;

--
-- Name: aiq_distributed_node_observations; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_distributed_node_observations enable row level security;

--
-- Name: aiq_distributed_node_observations aiq_distributed_observations_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_distributed_observations_public_read on aiq_private.aiq_distributed_node_observations for select to anon, authenticated using ((EXISTS ( select 1
   from aiq_private.aiq_nodes node
  where ((node.node_id = aiq_distributed_node_observations.node_id) and node.public_visible))));


--
-- Name: aiq_distributed_result_receipts aiq_distributed_receipts_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_distributed_receipts_public_read on aiq_private.aiq_distributed_result_receipts for select to anon, authenticated using ((EXISTS ( select 1
   from aiq_private.aiq_nodes node
  where ((node.node_id = aiq_distributed_result_receipts.node_id) and node.public_visible))));


--
-- Name: aiq_distributed_result_receipts; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_distributed_result_receipts enable row level security;

--
-- Name: aiq_distributed_task_packages; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_distributed_task_packages enable row level security;

--
-- Name: aiq_distributed_task_packages aiq_distributed_task_packages_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_distributed_task_packages_public_read on aiq_private.aiq_distributed_task_packages for select to anon, authenticated using ((EXISTS ( select 1
   from (aiq_private.aiq_distributed_assignments assignment
     join aiq_private.aiq_nodes node on ((node.node_id = assignment.node_id)))
  where ((assignment.task_package_id = aiq_distributed_task_packages.task_package_id) and (assignment.package_version = aiq_distributed_task_packages.package_version) and node.public_visible))));


--
-- Name: aiq_matrix_batches; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_matrix_batches enable row level security;

--
-- Name: aiq_model_configs; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_model_configs enable row level security;

--
-- Name: aiq_model_configs aiq_model_configs_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_model_configs_public_read on aiq_private.aiq_model_configs for select to anon, authenticated using (is_enabled);


--
-- Name: aiq_node_capability_snapshots; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_node_capability_snapshots enable row level security;

--
-- Name: aiq_nodes; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_nodes enable row level security;

--
-- Name: aiq_nodes aiq_nodes_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_nodes_public_read on aiq_private.aiq_nodes for select to anon, authenticated using (public_visible);


--
-- Name: aiq_package_runs; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_package_runs enable row level security;

--
-- Name: aiq_publication_actors; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_publication_actors enable row level security;

--
-- Name: aiq_result_packages; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_result_packages enable row level security;

--
-- Name: aiq_runs; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_runs enable row level security;

--
-- Name: aiq_runs aiq_runs_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_runs_public_read on aiq_private.aiq_runs for select to anon, authenticated using (published);


--
-- Name: aiq_score_snapshots; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_score_snapshots enable row level security;

--
-- Name: aiq_score_snapshots aiq_score_snapshots_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_score_snapshots_public_read on aiq_private.aiq_score_snapshots for select to anon, authenticated using ((published and (EXISTS ( select 1
   from aiq_private.aiq_runs run
  where ((run.run_id = aiq_score_snapshots.run_id) and run.published)))));


--
-- Name: aiq_scoring_versions; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_scoring_versions enable row level security;

--
-- Name: aiq_scoring_versions aiq_scoring_versions_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_scoring_versions_public_read on aiq_private.aiq_scoring_versions for select to anon, authenticated using (is_published);


--
-- Name: aiq_storage_legal_hold_events; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_storage_legal_hold_events enable row level security;

--
-- Name: aiq_storage_object_references; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_storage_object_references enable row level security;

--
-- Name: aiq_storage_objects; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_storage_objects enable row level security;

--
-- Name: aiq_storage_reconciliation_events; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_storage_reconciliation_events enable row level security;

--
-- Name: aiq_submission_conflicts; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_submission_conflicts enable row level security;

--
-- Name: aiq_submission_inbox; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_submission_inbox enable row level security;

--
-- Name: aiq_task_catalog; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_task_catalog enable row level security;

--
-- Name: aiq_task_catalog aiq_task_catalog_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_task_catalog_public_read on aiq_private.aiq_task_catalog for select to anon, authenticated using (public_metadata);


--
-- Name: aiq_task_results; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_task_results enable row level security;

--
-- Name: aiq_task_results aiq_task_results_public_read; Type: policy; Schema: aiq_private; Owner: -
--

create policy aiq_task_results_public_read on aiq_private.aiq_task_results for select to anon, authenticated using ((EXISTS ( select 1
   from aiq_private.aiq_runs run
  where ((run.run_id = aiq_task_results.run_id) and run.published))));


--
-- Name: aiq_task_sets; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_task_sets enable row level security;

--
-- Name: aiq_verification_audit; Type: row security; Schema: aiq_private; Owner: -
--

alter table aiq_private.aiq_verification_audit enable row level security;

--
-- Name: schema aiq_private; Type: ACL; Schema: -; Owner: -
--

grant usage on schema aiq_private to anon;
grant usage on schema aiq_private to authenticated;


--
-- Name: function activate_claim_artifact_reference(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, requested_kind text, requested_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.activate_claim_artifact_reference(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, requested_kind text, requested_sha256 text) from PUBLIC;


--
-- Name: function aiq_ack_submission_claim_reference_core(target_inbox_id uuid, supplied_lease_token uuid, supplied_disposition text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.aiq_ack_submission_claim_reference_core(target_inbox_id uuid, supplied_lease_token uuid, supplied_disposition text) from PUBLIC;


--
-- Name: function aiq_claim_storage_deletions_reference_core(max_rows integer, requested_lease_seconds integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.aiq_claim_storage_deletions_reference_core(max_rows integer, requested_lease_seconds integer) from PUBLIC;


--
-- Name: function aiq_claim_submission_reference_core(requested_lease_seconds integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.aiq_claim_submission_reference_core(requested_lease_seconds integer) from PUBLIC;


--
-- Name: function aiq_record_verification_rejection_unbound_core(target_run_id text, target_package_sha256 text, rejection jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.aiq_record_verification_rejection_unbound_core(target_run_id text, target_package_sha256 text, rejection jsonb) from PUBLIC;


--
-- Name: function aiq_record_verifier_attestation_unbound_core(target_run_id text, target_package_sha256 text, attestation jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.aiq_record_verifier_attestation_unbound_core(target_run_id text, target_package_sha256 text, attestation jsonb) from PUBLIC;


--
-- Name: function aiq_resolve_claim_artifact_reference_core(target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.aiq_resolve_claim_artifact_reference_core(target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text) from PUBLIC;


--
-- Name: function aiq_stage_verifier_result_unbound_core(stage jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.aiq_stage_verifier_result_unbound_core(stage jsonb) from PUBLIC;


--
-- Name: function aiq_verify_and_publish_unbound_core(target_run_id text, target_package_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.aiq_verify_and_publish_unbound_core(target_run_id text, target_package_sha256 text) from PUBLIC;



--
-- Name: function assert_publication_transition_eligible(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.assert_publication_transition_eligible() from PUBLIC;


--
-- Name: function attach_storage_reference(supplied_object_id uuid, supplied_reference_type text, supplied_reference_key text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.attach_storage_reference(supplied_object_id uuid, supplied_reference_type text, supplied_reference_key text) from PUBLIC;



--
-- Name: function binary_micro_diagnostic_jsonb_is_valid(candidate jsonb, expected_sample_size integer, expected_successes integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.binary_micro_diagnostic_jsonb_is_valid(candidate jsonb, expected_sample_size integer, expected_successes integer) from PUBLIC;


--
-- Name: function claim_artifact_reference_key(target_inbox_id uuid, requested_kind text, requested_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.claim_artifact_reference_key(target_inbox_id uuid, requested_kind text, requested_sha256 text) from PUBLIC;


--
-- Name: function completion_bounds_jsonb_is_valid(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.completion_bounds_jsonb_is_valid(candidate jsonb) from PUBLIC;


--
-- Name: function deactivate_storage_reference(supplied_reference_type text, supplied_reference_key text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.deactivate_storage_reference(supplied_reference_type text, supplied_reference_key text) from PUBLIC;


--
-- Name: function dto_adapter_failure_is_valid(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_adapter_failure_is_valid(candidate jsonb) from PUBLIC;


--
-- Name: function dto_artifact_array_is_valid(candidates jsonb, allowed_kinds text[], maximum_count integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_artifact_array_is_valid(candidates jsonb, allowed_kinds text[], maximum_count integer) from PUBLIC;


--
-- Name: function dto_artifact_is_valid(candidate jsonb, allowed_kinds text[], maximum_bytes bigint); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_artifact_is_valid(candidate jsonb, allowed_kinds text[], maximum_bytes bigint) from PUBLIC;


--
-- Name: function dto_ascii_is_valid(candidate jsonb, maximum_bytes integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_ascii_is_valid(candidate jsonb, maximum_bytes integer) from PUBLIC;


--
-- Name: function dto_identifier_is_valid(candidate jsonb, maximum_bytes integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_identifier_is_valid(candidate jsonb, maximum_bytes integer) from PUBLIC;


--
-- Name: function dto_preflight_is_valid(candidate jsonb, expected_models jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_preflight_is_valid(candidate jsonb, expected_models jsonb) from PUBLIC;


--
-- Name: function dto_result_is_valid(candidate jsonb, expected_run_id text, synthetic boolean, preflight jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_result_is_valid(candidate jsonb, expected_run_id text, synthetic boolean, preflight jsonb) from PUBLIC;


--
-- Name: function dto_run_provenance_is_valid(candidate jsonb, task_set_hash text, preflight_digest text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_run_provenance_is_valid(candidate jsonb, task_set_hash text, preflight_digest text) from PUBLIC;


--
-- Name: function dto_schedule_is_valid(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_schedule_is_valid(candidate jsonb) from PUBLIC;


--
-- Name: function dto_sha256_is_valid(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_sha256_is_valid(candidate jsonb) from PUBLIC;


--
-- Name: function dto_uint_is_valid(candidate jsonb, maximum numeric); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.dto_uint_is_valid(candidate jsonb, maximum numeric) from PUBLIC;


--
-- Name: function enforce_distributed_assignment_transition(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.enforce_distributed_assignment_transition() from PUBLIC;


--
-- Name: function ensure_storage_object(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.ensure_storage_object(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone) from PUBLIC;


--
-- Name: function storage_registry_inventory_digest(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.storage_registry_inventory_digest() from PUBLIC;


--
-- Name: function evaluator_result_bindings_v3_are_valid(payload jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.evaluator_result_bindings_v3_are_valid(payload jsonb) from PUBLIC;


--
-- Name: function frozen_catalog_identity_is_valid(target_task_set_id text, target_task_set_version text, target_scoring_version text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.frozen_catalog_identity_is_valid(target_task_set_id text, target_task_set_version text, target_scoring_version text) from PUBLIC;


--
-- Name: function guard_evidence_insert_for_unpublished_run(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.guard_evidence_insert_for_unpublished_run() from PUBLIC;


--
-- Name: function guard_matrix_batch_lifecycle(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.guard_matrix_batch_lifecycle() from PUBLIC;


--
-- Name: function guard_node_identity_lifecycle(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.guard_node_identity_lifecycle() from PUBLIC;


--
-- Name: function guard_result_package_lifecycle(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.guard_result_package_lifecycle() from PUBLIC;


--
-- Name: function guard_run_lifecycle(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.guard_run_lifecycle() from PUBLIC;


--
-- Name: function guard_score_snapshot_lifecycle(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.guard_score_snapshot_lifecycle() from PUBLIC;


--
-- Name: function guard_storage_registry_mutation(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.guard_storage_registry_mutation() from PUBLIC;


revoke all on function aiq_private.guard_storage_reconciliation_history() from PUBLIC;


--
-- Name: function guard_submission_inbox_lifecycle(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.guard_submission_inbox_lifecycle() from PUBLIC;


--
-- Name: function has_exact_jsonb_keys(value jsonb, expected_keys text[]); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.has_exact_jsonb_keys(value jsonb, expected_keys text[]) from PUBLIC;


--
-- Name: function jcs_bytes_is_within(candidate jsonb, maximum_bytes integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.jcs_bytes_is_within(candidate jsonb, maximum_bytes integer) from PUBLIC;


--
-- Name: function jcs_number_text(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.jcs_number_text(candidate jsonb) from PUBLIC;


--
-- Name: function jcs_sha256(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.jcs_sha256(candidate jsonb) from PUBLIC;


--
-- Name: function jcs_text(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.jcs_text(candidate jsonb) from PUBLIC;


--
-- Name: function jsonb_sha256_field_is_valid(document jsonb, field_name text, prefixed boolean); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.jsonb_sha256_field_is_valid(document jsonb, field_name text, prefixed boolean) from PUBLIC;


--
-- Name: function jsonb_wire_value_is_bounded(candidate jsonb, maximum_depth integer, maximum_nodes integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.jsonb_wire_value_is_bounded(candidate jsonb, maximum_depth integer, maximum_nodes integer) from PUBLIC;


--
-- Name: function node_public_key_matches_id(node_id text, public_key text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.node_public_key_matches_id(node_id text, public_key text) from PUBLIC;


--
-- Name: function normalized_domain_score_summary(candidate_results jsonb, target_task_set_id text, target_task_set_version text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.normalized_domain_score_summary(candidate_results jsonb, target_task_set_id text, target_task_set_version text) from PUBLIC;


--
-- Name: function normalized_outcome_from_source(source jsonb, score_tier text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.normalized_outcome_from_source(source jsonb, score_tier text) from PUBLIC;


--
-- Name: function normalized_responsibility_from_source(source jsonb, score_tier text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.normalized_responsibility_from_source(source jsonb, score_tier text) from PUBLIC;


--
-- Name: function official_model_matrix_is_exact(models jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.official_model_matrix_is_exact(models jsonb) from PUBLIC;


--
-- Name: function ordered_catalog_identity_sha256(target_task_set_id text, target_task_set_version text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.ordered_catalog_identity_sha256(target_task_set_id text, target_task_set_version text) from PUBLIC;


--
-- Name: function package_evidence_is_staged(target_package_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.package_evidence_is_staged(target_package_sha256 text) from PUBLIC;


--
-- Name: function production_execution_identities_are_authorized(runner_node_id text, verifier_node_id text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.production_execution_identities_are_authorized(runner_node_id text, verifier_node_id text) from PUBLIC;


--
-- Name: function production_publisher_identity_is_authorized(publisher_node_id text, runner_node_id text, verifier_node_id text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.production_publisher_identity_is_authorized(publisher_node_id text, runner_node_id text, verifier_node_id text) from PUBLIC;



--
-- Name: function reject_artifact_ingress_mutation(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.reject_artifact_ingress_mutation() from PUBLIC;


--
-- Name: function reject_claim_artifact_reference_event_mutation(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.reject_claim_artifact_reference_event_mutation() from PUBLIC;


--
-- Name: function reject_distributed_evidence_mutation(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.reject_distributed_evidence_mutation() from PUBLIC;


--
-- Name: function reject_staged_evidence_mutation(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.reject_staged_evidence_mutation() from PUBLIC;


--
-- Name: function reject_storage_history_mutation(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.reject_storage_history_mutation() from PUBLIC;


--
-- Name: function reject_verification_audit_mutation(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.reject_verification_audit_mutation() from PUBLIC;


--
-- Name: function request_jwt_role(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.request_jwt_role() from PUBLIC;


--
-- Name: function request_publisher_node_id(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.request_publisher_node_id() from PUBLIC;


--
-- Name: function require_request_role(expected_role text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.require_request_role(expected_role text) from PUBLIC;


--
-- Name: function require_verification_claim(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, target_run_id text, target_package_sha256 text, completed_terminal text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.require_verification_claim(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, target_run_id text, target_package_sha256 text, completed_terminal text) from PUBLIC;


--
-- Name: function result_package_v3_is_valid(envelope jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.result_package_v3_is_valid(envelope jsonb) from PUBLIC;



--
-- Name: function retire_claim_artifact_references(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, supplied_reason text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.retire_claim_artifact_references(target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer, supplied_reason text) from PUBLIC;


--
-- Name: function retire_expired_claim_artifact_references(max_claims integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.retire_expired_claim_artifact_references(max_claims integer) from PUBLIC;


--
-- Name: function run_evidence_is_staged(target_run_id text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.run_evidence_is_staged(target_run_id text) from PUBLIC;



--
-- Name: function run_provenance_v2_is_valid(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.run_provenance_v2_is_valid(candidate jsonb) from PUBLIC;


--
-- Name: function run_provenance_v2_matches_stage(candidate jsonb, stage jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.run_provenance_v2_matches_stage(candidate jsonb, stage jsonb) from PUBLIC;


--
-- Name: function safe_unsigned_integer_jsonb_is_valid(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.safe_unsigned_integer_jsonb_is_valid(candidate jsonb) from PUBLIC;


--
-- Name: function score_tier_is_valid(claimed_status aiq_private.score_status, valid_count integer, invalid_count integer, missing_count integer, not_applicable_count integer, covered_domains integer, minimum_domain_count integer); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.score_tier_is_valid(claimed_status aiq_private.score_status, valid_count integer, invalid_count integer, missing_count integer, not_applicable_count integer, covered_domains integer, minimum_domain_count integer) from PUBLIC;


--
-- Name: function stage_verifier_result_core(stage jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.stage_verifier_result_core(stage jsonb) from PUBLIC;



--
-- Name: function staged_submission_is_recoverable(target_inbox_id uuid); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.staged_submission_is_recoverable(target_inbox_id uuid) from PUBLIC;


--
-- Name: function sync_artifact_storage_reference(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.sync_artifact_storage_reference() from PUBLIC;


--
-- Name: function sync_submission_storage_reference(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.sync_submission_storage_reference() from PUBLIC;


--
-- Name: function synthetic_commitment_exception_allowed(stage_synthetic boolean, task_set_synthetic boolean); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.synthetic_commitment_exception_allowed(stage_synthetic boolean, task_set_synthetic boolean) from PUBLIC;


--
-- Name: function task_catalog_is_exact(target_task_set_id text, target_task_set_version text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.task_catalog_is_exact(target_task_set_id text, target_task_set_version text) from PUBLIC;


--
-- Name: function task_resampling_interval_is_valid(candidate jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.task_resampling_interval_is_valid(candidate jsonb) from PUBLIC;


--
-- Name: function publication_is_complete(target_batch_id text, target_package_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.publication_is_complete(target_batch_id text, target_package_sha256 text) from PUBLIC;


--
-- Name: function publication_is_complete_without_publisher(target_batch_id text, target_package_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.publication_is_complete_without_publisher(target_batch_id text, target_package_sha256 text) from PUBLIC;


--
-- Name: function publication_transition_is_eligible(target_batch_id text, target_package_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.publication_transition_is_eligible(target_batch_id text, target_package_sha256 text) from PUBLIC;


--
-- Name: function validate_distributed_aggregation_input(); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.validate_distributed_aggregation_input() from PUBLIC;




--
-- Name: function verifier_attestation_v3_binding_is_valid(attestation jsonb, batch aiq_private.aiq_matrix_batches, package aiq_private.aiq_result_packages); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.verifier_attestation_v3_binding_is_valid(attestation jsonb, batch aiq_private.aiq_matrix_batches, package aiq_private.aiq_result_packages) from PUBLIC;


--
-- Name: function verifier_attestation_v3_is_valid(attestation jsonb, batch aiq_private.aiq_matrix_batches, package aiq_private.aiq_result_packages); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.verifier_attestation_v3_is_valid(attestation jsonb, batch aiq_private.aiq_matrix_batches, package aiq_private.aiq_result_packages) from PUBLIC;


--
-- Name: function verifier_registry_trust_is_eligible(signature_status text, trust_tier aiq_private.trust_tier, synthetic boolean, expected_synthetic boolean); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.verifier_registry_trust_is_eligible(signature_status text, trust_tier aiq_private.trust_tier, synthetic boolean, expected_synthetic boolean) from PUBLIC;


--
-- Name: function verifier_rejection_v2_is_valid(rejection jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.verifier_rejection_v2_is_valid(rejection jsonb) from PUBLIC;


--
-- Name: function verify_and_publish_core(target_run_id text, target_package_sha256 text); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.verify_and_publish_core(target_run_id text, target_package_sha256 text) from PUBLIC;


--
-- Name: function aiq_ack_storage_deletion(target_object_id uuid, supplied_lease_token uuid, supplied_outcome text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_ack_storage_deletion(target_object_id uuid, supplied_lease_token uuid, supplied_outcome text) from PUBLIC;
grant all on function public.aiq_ack_storage_deletion(target_object_id uuid, supplied_lease_token uuid, supplied_outcome text) to service_role;


--
-- Name: function aiq_ack_submission_claim(target_inbox_id uuid, supplied_lease_token uuid, supplied_disposition text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_ack_submission_claim(target_inbox_id uuid, supplied_lease_token uuid, supplied_disposition text) from PUBLIC;
grant all on function public.aiq_ack_submission_claim(target_inbox_id uuid, supplied_lease_token uuid, supplied_disposition text) to aiq_verifier;


--
-- Name: function aiq_attach_storage_reference(supplied_object_id uuid, supplied_reference_type text, supplied_reference_key text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_attach_storage_reference(supplied_object_id uuid, supplied_reference_type text, supplied_reference_key text) from PUBLIC;
grant all on function public.aiq_attach_storage_reference(supplied_object_id uuid, supplied_reference_type text, supplied_reference_key text) to service_role;


--
-- Name: function aiq_claim_storage_deletions(max_rows integer, requested_lease_seconds integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_claim_storage_deletions(max_rows integer, requested_lease_seconds integer) from PUBLIC;
grant all on function public.aiq_claim_storage_deletions(max_rows integer, requested_lease_seconds integer) to service_role;


--
-- Name: function aiq_claim_submission(requested_lease_seconds integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_claim_submission(requested_lease_seconds integer) from PUBLIC;
grant all on function public.aiq_claim_submission(requested_lease_seconds integer) to aiq_verifier;


--
-- Name: function aiq_deactivate_storage_reference(supplied_reference_type text, supplied_reference_key text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_deactivate_storage_reference(supplied_reference_type text, supplied_reference_key text) from PUBLIC;
grant all on function public.aiq_deactivate_storage_reference(supplied_reference_type text, supplied_reference_key text) to service_role;


--
-- Name: function aiq_describe_web_rpc_contract(); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_describe_web_rpc_contract() from PUBLIC;
grant all on function public.aiq_describe_web_rpc_contract() to service_role;


--
-- Name: function enqueue_submission_core(envelope jsonb, request_context jsonb); Type: ACL; Schema: aiq_private; Owner: -
--

revoke all on function aiq_private.enqueue_submission_core(envelope jsonb, request_context jsonb) from PUBLIC;


--
-- Name: function aiq_enqueue_submission(envelope jsonb, request_context jsonb, object_identity jsonb); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_enqueue_submission(envelope jsonb, request_context jsonb, object_identity jsonb) from PUBLIC;
grant all on function public.aiq_enqueue_submission(envelope jsonb, request_context jsonb, object_identity jsonb) to service_role;


--
-- Name: function aiq_gateway_role_probe(); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_gateway_role_probe() from PUBLIC;
grant all on function public.aiq_gateway_role_probe() to aiq_verifier;
grant all on function public.aiq_gateway_role_probe() to aiq_publisher;


--
-- Name: function aiq_list_storage_reconciliation(supplied_bucket text, after_path text, after_mismatch_type text, max_rows integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_list_storage_reconciliation(supplied_bucket text, after_path text, after_mismatch_type text, max_rows integer) from PUBLIC;
grant all on function public.aiq_list_storage_reconciliation(supplied_bucket text, after_path text, after_mismatch_type text, max_rows integer) to service_role;


--
-- Name: function aiq_list_storage_registry(supplied_bucket text, after_path text, max_rows integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_list_storage_registry(supplied_bucket text, after_path text, max_rows integer) from PUBLIC;
grant all on function public.aiq_list_storage_registry(supplied_bucket text, after_path text, max_rows integer) to service_role;


--
-- Name: function aiq_production_reference_status(expected_publisher_node_id text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_production_reference_status(expected_publisher_node_id text) from PUBLIC;
grant all on function public.aiq_production_reference_status(expected_publisher_node_id text) to service_role;


--
-- Name: function aiq_promote_storage_orphan(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_promote_storage_orphan(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint) from PUBLIC;
grant all on function public.aiq_promote_storage_orphan(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint) to service_role;


--
-- Name: function aiq_purge_expired_artifact_ingress(max_rows integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_purge_expired_artifact_ingress(max_rows integer) from PUBLIC;
grant all on function public.aiq_purge_expired_artifact_ingress(max_rows integer) to service_role;


--
-- Name: function aiq_purge_expired_submissions(max_rows integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_purge_expired_submissions(max_rows integer) from PUBLIC;
grant all on function public.aiq_purge_expired_submissions(max_rows integer) to service_role;


--
-- Name: function aiq_record_artifact_ingress(target_run_id text, supplied_kind text, supplied_sha256 text, supplied_byte_size bigint, object_identity jsonb); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_record_artifact_ingress(target_run_id text, supplied_kind text, supplied_sha256 text, supplied_byte_size bigint, object_identity jsonb) from PUBLIC;
grant all on function public.aiq_record_artifact_ingress(target_run_id text, supplied_kind text, supplied_sha256 text, supplied_byte_size bigint, object_identity jsonb) to service_role;


--
-- Name: function aiq_record_storage_reconciliation(supplied_bucket text, supplied_path text, supplied_mismatch_type text, supplied_detail_code text, supplied_eligible_after timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_record_storage_reconciliation(supplied_bucket text, supplied_path text, supplied_mismatch_type text, supplied_detail_code text, supplied_eligible_after timestamp with time zone) from PUBLIC;
grant all on function public.aiq_record_storage_reconciliation(supplied_bucket text, supplied_path text, supplied_mismatch_type text, supplied_detail_code text, supplied_eligible_after timestamp with time zone) to service_role;


--
-- Name: function aiq_record_storage_inventory_epoch(supplied_inventory_object_count bigint, supplied_inventory_digest text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_record_storage_inventory_epoch(supplied_inventory_object_count bigint, supplied_inventory_digest text) from PUBLIC;
grant all on function public.aiq_record_storage_inventory_epoch(supplied_inventory_object_count bigint, supplied_inventory_digest text) to service_role;


--
-- Name: function aiq_record_verification_rejection(target_run_id text, target_package_sha256 text, rejection jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_record_verification_rejection(target_run_id text, target_package_sha256 text, rejection jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) from PUBLIC;
grant all on function public.aiq_record_verification_rejection(target_run_id text, target_package_sha256 text, rejection jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) to aiq_verifier;


--
-- Name: function aiq_record_verifier_attestation(target_run_id text, target_package_sha256 text, attestation jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_record_verifier_attestation(target_run_id text, target_package_sha256 text, attestation jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) from PUBLIC;
grant all on function public.aiq_record_verifier_attestation(target_run_id text, target_package_sha256 text, attestation jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) to aiq_verifier;


--
-- Name: function aiq_register_storage_object(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_register_storage_object(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone) from PUBLIC;
grant all on function public.aiq_register_storage_object(supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone) to service_role;


--
-- Name: function aiq_renew_submission_claim(target_inbox_id uuid, supplied_lease_token uuid, requested_lease_seconds integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_renew_submission_claim(target_inbox_id uuid, supplied_lease_token uuid, requested_lease_seconds integer) from PUBLIC;
grant all on function public.aiq_renew_submission_claim(target_inbox_id uuid, supplied_lease_token uuid, requested_lease_seconds integer) to aiq_verifier;


--
-- Name: function aiq_resolve_claim_artifact(target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_resolve_claim_artifact(target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text) from PUBLIC;
grant all on function public.aiq_resolve_claim_artifact(target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text) to aiq_verifier;


--
-- Name: function aiq_resolve_storage_reconciliation(supplied_bucket text, supplied_path text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_resolve_storage_reconciliation(supplied_bucket text, supplied_path text) from PUBLIC;
grant all on function public.aiq_resolve_storage_reconciliation(supplied_bucket text, supplied_path text) to service_role;


--
-- Name: function aiq_retry_storage_deletion(target_object_id uuid, supplied_lease_token uuid, supplied_error_code text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_retry_storage_deletion(target_object_id uuid, supplied_lease_token uuid, supplied_error_code text) from PUBLIC;
grant all on function public.aiq_retry_storage_deletion(target_object_id uuid, supplied_lease_token uuid, supplied_error_code text) to service_role;


--
-- Name: function aiq_set_storage_legal_hold(target_object_id uuid, hold_enabled boolean, supplied_reason text, supplied_actor text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_set_storage_legal_hold(target_object_id uuid, hold_enabled boolean, supplied_reason text, supplied_actor text) from PUBLIC;
grant all on function public.aiq_set_storage_legal_hold(target_object_id uuid, hold_enabled boolean, supplied_reason text, supplied_actor text) to service_role;


--
-- Name: function aiq_stage_verifier_result(stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_stage_verifier_result(stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) from PUBLIC;
grant all on function public.aiq_stage_verifier_result(stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) to aiq_verifier;


--
-- Name: function aiq_storage_lifecycle_status(); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_storage_lifecycle_status() from PUBLIC;
grant all on function public.aiq_storage_lifecycle_status() to service_role;


--
-- Name: function aiq_verify_and_publish(target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.aiq_verify_and_publish(target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) from PUBLIC;
grant all on function public.aiq_verify_and_publish(target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer) to aiq_publisher;


--
-- Name: function public_trend_points(supplied_range text); Type: ACL; Schema: public; Owner: -
--

revoke all on function public.public_trend_points(supplied_range text) from PUBLIC;
grant all on function public.public_trend_points(supplied_range text) to anon;
grant all on function public.public_trend_points(supplied_range text) to authenticated;


--
-- Name: COLUMN aiq_distributed_aggregation_inputs.node_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(node_id) on table aiq_private.aiq_distributed_aggregation_inputs to anon;
grant select(node_id) on table aiq_private.aiq_distributed_aggregation_inputs to authenticated;


--
-- Name: COLUMN aiq_distributed_aggregation_inputs.trust_classification; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(trust_classification) on table aiq_private.aiq_distributed_aggregation_inputs to anon;
grant select(trust_classification) on table aiq_private.aiq_distributed_aggregation_inputs to authenticated;


--
-- Name: COLUMN aiq_distributed_aggregation_inputs.classified_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(classified_at) on table aiq_private.aiq_distributed_aggregation_inputs to anon;
grant select(classified_at) on table aiq_private.aiq_distributed_aggregation_inputs to authenticated;


--
-- Name: COLUMN aiq_distributed_aggregation_inputs.synthetic; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(synthetic) on table aiq_private.aiq_distributed_aggregation_inputs to anon;
grant select(synthetic) on table aiq_private.aiq_distributed_aggregation_inputs to authenticated;


--
-- Name: COLUMN aiq_distributed_assignments.assignment_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(assignment_id) on table aiq_private.aiq_distributed_assignments to anon;
grant select(assignment_id) on table aiq_private.aiq_distributed_assignments to authenticated;


--
-- Name: COLUMN aiq_distributed_assignments.lease_attempt; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(lease_attempt) on table aiq_private.aiq_distributed_assignments to anon;
grant select(lease_attempt) on table aiq_private.aiq_distributed_assignments to authenticated;


--
-- Name: COLUMN aiq_distributed_assignments.task_package_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_package_id) on table aiq_private.aiq_distributed_assignments to anon;
grant select(task_package_id) on table aiq_private.aiq_distributed_assignments to authenticated;


--
-- Name: COLUMN aiq_distributed_assignments.package_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(package_version) on table aiq_private.aiq_distributed_assignments to anon;
grant select(package_version) on table aiq_private.aiq_distributed_assignments to authenticated;


--
-- Name: COLUMN aiq_distributed_assignments.node_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(node_id) on table aiq_private.aiq_distributed_assignments to anon;
grant select(node_id) on table aiq_private.aiq_distributed_assignments to authenticated;


--
-- Name: COLUMN aiq_distributed_assignments.status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(status) on table aiq_private.aiq_distributed_assignments to anon;
grant select(status) on table aiq_private.aiq_distributed_assignments to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.declaration_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(declaration_id) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(declaration_id) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.schema_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(schema_version) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(schema_version) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.node_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(node_id) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(node_id) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.declaration_sequence; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(declaration_sequence) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(declaration_sequence) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.capability_hash; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(capability_hash) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(capability_hash) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(status) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(status) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.signature_status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(signature_status) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(signature_status) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.issued_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(issued_at) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(issued_at) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_capability_declarations.synthetic; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(synthetic) on table aiq_private.aiq_distributed_capability_declarations to anon;
grant select(synthetic) on table aiq_private.aiq_distributed_capability_declarations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.observation_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(observation_id) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(observation_id) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.schema_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(schema_version) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(schema_version) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.node_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(node_id) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(node_id) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.observation_sequence; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(observation_sequence) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(observation_sequence) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.observation_hash; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(observation_hash) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(observation_hash) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.node_state; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(node_state) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(node_state) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.receiver_status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(receiver_status) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(receiver_status) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.provenance_hash; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(provenance_hash) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(provenance_hash) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.signature_status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(signature_status) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(signature_status) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.observed_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(observed_at) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(observed_at) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_node_observations.synthetic; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(synthetic) on table aiq_private.aiq_distributed_node_observations to anon;
grant select(synthetic) on table aiq_private.aiq_distributed_node_observations to authenticated;


--
-- Name: COLUMN aiq_distributed_result_receipts.receipt_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(receipt_id) on table aiq_private.aiq_distributed_result_receipts to anon;
grant select(receipt_id) on table aiq_private.aiq_distributed_result_receipts to authenticated;


--
-- Name: COLUMN aiq_distributed_result_receipts.node_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(node_id) on table aiq_private.aiq_distributed_result_receipts to anon;
grant select(node_id) on table aiq_private.aiq_distributed_result_receipts to authenticated;


--
-- Name: COLUMN aiq_distributed_result_receipts.status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(status) on table aiq_private.aiq_distributed_result_receipts to anon;
grant select(status) on table aiq_private.aiq_distributed_result_receipts to authenticated;


--
-- Name: COLUMN aiq_distributed_result_receipts.signature_status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(signature_status) on table aiq_private.aiq_distributed_result_receipts to anon;
grant select(signature_status) on table aiq_private.aiq_distributed_result_receipts to authenticated;


--
-- Name: COLUMN aiq_distributed_result_receipts.received_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(received_at) on table aiq_private.aiq_distributed_result_receipts to anon;
grant select(received_at) on table aiq_private.aiq_distributed_result_receipts to authenticated;


--
-- Name: COLUMN aiq_distributed_result_receipts.synthetic; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(synthetic) on table aiq_private.aiq_distributed_result_receipts to anon;
grant select(synthetic) on table aiq_private.aiq_distributed_result_receipts to authenticated;


--
-- Name: COLUMN aiq_distributed_task_packages.task_package_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_package_id) on table aiq_private.aiq_distributed_task_packages to anon;
grant select(task_package_id) on table aiq_private.aiq_distributed_task_packages to authenticated;


--
-- Name: COLUMN aiq_distributed_task_packages.package_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(package_version) on table aiq_private.aiq_distributed_task_packages to anon;
grant select(package_version) on table aiq_private.aiq_distributed_task_packages to authenticated;


--
-- Name: COLUMN aiq_distributed_task_packages.package_hash; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(package_hash) on table aiq_private.aiq_distributed_task_packages to anon;
grant select(package_hash) on table aiq_private.aiq_distributed_task_packages to authenticated;


--
-- Name: COLUMN aiq_distributed_task_packages.synthetic; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(synthetic) on table aiq_private.aiq_distributed_task_packages to anon;
grant select(synthetic) on table aiq_private.aiq_distributed_task_packages to authenticated;


--
-- Name: COLUMN aiq_model_configs.model_config_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(model_config_id) on table aiq_private.aiq_model_configs to anon;
grant select(model_config_id) on table aiq_private.aiq_model_configs to authenticated;


--
-- Name: COLUMN aiq_model_configs.model_family; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(model_family) on table aiq_private.aiq_model_configs to anon;
grant select(model_family) on table aiq_private.aiq_model_configs to authenticated;


--
-- Name: COLUMN aiq_model_configs.provider_model_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(provider_model_id) on table aiq_private.aiq_model_configs to anon;
grant select(provider_model_id) on table aiq_private.aiq_model_configs to authenticated;


--
-- Name: COLUMN aiq_model_configs.reasoning_effort; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(reasoning_effort) on table aiq_private.aiq_model_configs to anon;
grant select(reasoning_effort) on table aiq_private.aiq_model_configs to authenticated;


--
-- Name: COLUMN aiq_model_configs.expected_in_matrix; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(expected_in_matrix) on table aiq_private.aiq_model_configs to anon;
grant select(expected_in_matrix) on table aiq_private.aiq_model_configs to authenticated;


--
-- Name: COLUMN aiq_model_configs.is_enabled; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(is_enabled) on table aiq_private.aiq_model_configs to anon;
grant select(is_enabled) on table aiq_private.aiq_model_configs to authenticated;


--
-- Name: COLUMN aiq_nodes.node_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(node_id) on table aiq_private.aiq_nodes to anon;
grant select(node_id) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.display_name; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(display_name) on table aiq_private.aiq_nodes to anon;
grant select(display_name) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.key_fingerprint; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(key_fingerprint) on table aiq_private.aiq_nodes to anon;
grant select(key_fingerprint) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(status) on table aiq_private.aiq_nodes to anon;
grant select(status) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.trust_tier; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(trust_tier) on table aiq_private.aiq_nodes to anon;
grant select(trust_tier) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.operator_class; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(operator_class) on table aiq_private.aiq_nodes to anon;
grant select(operator_class) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.capabilities; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(capabilities) on table aiq_private.aiq_nodes to anon;
grant select(capabilities) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.source; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(source) on table aiq_private.aiq_nodes to anon;
grant select(source) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.signature_status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(signature_status) on table aiq_private.aiq_nodes to anon;
grant select(signature_status) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.provenance; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(provenance) on table aiq_private.aiq_nodes to anon;
grant select(provenance) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.synthetic; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(synthetic) on table aiq_private.aiq_nodes to anon;
grant select(synthetic) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.public_visible; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(public_visible) on table aiq_private.aiq_nodes to anon;
grant select(public_visible) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_nodes.last_seen_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(last_seen_at) on table aiq_private.aiq_nodes to anon;
grant select(last_seen_at) on table aiq_private.aiq_nodes to authenticated;


--
-- Name: COLUMN aiq_runs.run_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(run_id) on table aiq_private.aiq_runs to anon;
grant select(run_id) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.matrix_batch_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(matrix_batch_id) on table aiq_private.aiq_runs to anon;
grant select(matrix_batch_id) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.scheduled_for; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(scheduled_for) on table aiq_private.aiq_runs to anon;
grant select(scheduled_for) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.task_set_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_set_id) on table aiq_private.aiq_runs to anon;
grant select(task_set_id) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.task_set_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_set_version) on table aiq_private.aiq_runs to anon;
grant select(task_set_version) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.benchmark_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(benchmark_version) on table aiq_private.aiq_runs to anon;
grant select(benchmark_version) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.scoring_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(scoring_version) on table aiq_private.aiq_runs to anon;
grant select(scoring_version) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.model_config_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(model_config_id) on table aiq_private.aiq_runs to anon;
grant select(model_config_id) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.synthetic; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(synthetic) on table aiq_private.aiq_runs to anon;
grant select(synthetic) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.published; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(published) on table aiq_private.aiq_runs to anon;
grant select(published) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.started_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(started_at) on table aiq_private.aiq_runs to anon;
grant select(started_at) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.completed_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(completed_at) on table aiq_private.aiq_runs to anon;
grant select(completed_at) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.prompt_set_digest; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(prompt_set_digest) on table aiq_private.aiq_runs to anon;
grant select(prompt_set_digest) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.runner_commit; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(runner_commit) on table aiq_private.aiq_runs to anon;
grant select(runner_commit) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.region; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(region) on table aiq_private.aiq_runs to anon;
grant select(region) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_runs.run_provenance; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(run_provenance) on table aiq_private.aiq_runs to anon;
grant select(run_provenance) on table aiq_private.aiq_runs to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.run_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(run_id) on table aiq_private.aiq_score_snapshots to anon;
grant select(run_id) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.scoring_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(scoring_version) on table aiq_private.aiq_score_snapshots to anon;
grant select(scoring_version) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.score_status; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(score_status) on table aiq_private.aiq_score_snapshots to anon;
grant select(score_status) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.fixed_fixture_aiq; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(fixed_fixture_aiq) on table aiq_private.aiq_score_snapshots to anon;
grant select(fixed_fixture_aiq) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.task_resampling_low; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_resampling_low) on table aiq_private.aiq_score_snapshots to anon;
grant select(task_resampling_low) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.task_resampling_high; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_resampling_high) on table aiq_private.aiq_score_snapshots to anon;
grant select(task_resampling_high) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.valid_task_count; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(valid_task_count) on table aiq_private.aiq_score_snapshots to anon;
grant select(valid_task_count) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.expected_task_count; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(expected_task_count) on table aiq_private.aiq_score_snapshots to anon;
grant select(expected_task_count) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.invalid_count; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(invalid_count) on table aiq_private.aiq_score_snapshots to anon;
grant select(invalid_count) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.missing_count; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(missing_count) on table aiq_private.aiq_score_snapshots to anon;
grant select(missing_count) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.published; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(published) on table aiq_private.aiq_score_snapshots to anon;
grant select(published) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_score_snapshots.calculated_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(calculated_at) on table aiq_private.aiq_score_snapshots to anon;
grant select(calculated_at) on table aiq_private.aiq_score_snapshots to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.scoring_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(scoring_version) on table aiq_private.aiq_scoring_versions to anon;
grant select(scoring_version) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.benchmark_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(benchmark_version) on table aiq_private.aiq_scoring_versions to anon;
grant select(benchmark_version) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.principles; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(principles) on table aiq_private.aiq_scoring_versions to anon;
grant select(principles) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.missing_policy; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(missing_policy) on table aiq_private.aiq_scoring_versions to anon;
grant select(missing_policy) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.failure_policy_text; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(failure_policy_text) on table aiq_private.aiq_scoring_versions to anon;
grant select(failure_policy_text) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.confidence_policy; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(confidence_policy) on table aiq_private.aiq_scoring_versions to anon;
grant select(confidence_policy) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.formula; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(formula) on table aiq_private.aiq_scoring_versions to anon;
grant select(formula) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.synthetic; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(synthetic) on table aiq_private.aiq_scoring_versions to anon;
grant select(synthetic) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.is_published; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(is_published) on table aiq_private.aiq_scoring_versions to anon;
grant select(is_published) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_scoring_versions.published_at; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(published_at) on table aiq_private.aiq_scoring_versions to anon;
grant select(published_at) on table aiq_private.aiq_scoring_versions to authenticated;


--
-- Name: COLUMN aiq_task_catalog.task_set_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_set_id) on table aiq_private.aiq_task_catalog to anon;
grant select(task_set_id) on table aiq_private.aiq_task_catalog to authenticated;


--
-- Name: COLUMN aiq_task_catalog.task_set_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_set_version) on table aiq_private.aiq_task_catalog to anon;
grant select(task_set_version) on table aiq_private.aiq_task_catalog to authenticated;


--
-- Name: COLUMN aiq_task_catalog.task_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_id) on table aiq_private.aiq_task_catalog to anon;
grant select(task_id) on table aiq_private.aiq_task_catalog to authenticated;


--
-- Name: COLUMN aiq_task_catalog.task_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_version) on table aiq_private.aiq_task_catalog to anon;
grant select(task_version) on table aiq_private.aiq_task_catalog to authenticated;


--
-- Name: COLUMN aiq_task_catalog.title; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(title) on table aiq_private.aiq_task_catalog to anon;
grant select(title) on table aiq_private.aiq_task_catalog to authenticated;


--
-- Name: COLUMN aiq_task_catalog.domain; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(domain) on table aiq_private.aiq_task_catalog to anon;
grant select(domain) on table aiq_private.aiq_task_catalog to authenticated;


--
-- Name: COLUMN aiq_task_catalog.public_metadata; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(public_metadata) on table aiq_private.aiq_task_catalog to anon;
grant select(public_metadata) on table aiq_private.aiq_task_catalog to authenticated;


--
-- Name: COLUMN aiq_task_results.result_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(result_id) on table aiq_private.aiq_task_results to anon;
grant select(result_id) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.run_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(run_id) on table aiq_private.aiq_task_results to anon;
grant select(run_id) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.task_id; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_id) on table aiq_private.aiq_task_results to anon;
grant select(task_id) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.task_version; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_version) on table aiq_private.aiq_task_results to anon;
grant select(task_version) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.domain; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(domain) on table aiq_private.aiq_task_results to anon;
grant select(domain) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.outcome; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(outcome) on table aiq_private.aiq_task_results to anon;
grant select(outcome) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.task_score; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(task_score) on table aiq_private.aiq_task_results to anon;
grant select(task_score) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.failure_code; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(failure_code) on table aiq_private.aiq_task_results to anon;
grant select(failure_code) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.failure_retryable; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(failure_retryable) on table aiq_private.aiq_task_results to anon;
grant select(failure_retryable) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.latency_ms; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(latency_ms) on table aiq_private.aiq_task_results to anon;
grant select(latency_ms) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: COLUMN aiq_task_results.tool_usage; Type: ACL; Schema: aiq_private; Owner: -
--

grant select(tool_usage) on table aiq_private.aiq_task_results to anon;
grant select(tool_usage) on table aiq_private.aiq_task_results to authenticated;


--
-- Name: table public_distributed_radar; Type: ACL; Schema: public; Owner: -
--

-- Supabase can grant broad public-schema defaults to browser roles. Remove
-- those inherited grants before adding the exact read-only surface.
revoke all on table
  public.public_distributed_radar,
  public.public_leaderboard,
  public.public_model_matrix,
  public.public_nodes,
  public.public_run_results,
  public.public_runs,
  public.public_scoring_versions,
  public.public_task_coverage
from public, anon, authenticated;

grant select on table public.public_distributed_radar to anon;
grant select on table public.public_distributed_radar to authenticated;


--
-- Name: table public_leaderboard; Type: ACL; Schema: public; Owner: -
--

grant select on table public.public_leaderboard to anon;
grant select on table public.public_leaderboard to authenticated;


--
-- Name: table public_model_matrix; Type: ACL; Schema: public; Owner: -
--

grant select on table public.public_model_matrix to anon;
grant select on table public.public_model_matrix to authenticated;


--
-- Name: table public_nodes; Type: ACL; Schema: public; Owner: -
--

grant select on table public.public_nodes to anon;
grant select on table public.public_nodes to authenticated;


--
-- Name: table public_run_results; Type: ACL; Schema: public; Owner: -
--

grant select on table public.public_run_results to anon;
grant select on table public.public_run_results to authenticated;


--
-- Name: table public_runs; Type: ACL; Schema: public; Owner: -
--

grant select on table public.public_runs to anon;
grant select on table public.public_runs to authenticated;


--
-- Name: table public_scoring_versions; Type: ACL; Schema: public; Owner: -
--

grant select on table public.public_scoring_versions to anon;
grant select on table public.public_scoring_versions to authenticated;


--
-- Name: table public_task_coverage; Type: ACL; Schema: public; Owner: -
--

grant select on table public.public_task_coverage to anon;
grant select on table public.public_task_coverage to authenticated;


-- Calibration evidence is a separate, explicitly non-Official publication
-- surface. It reuses package ingress and verifier claims, but it cannot write
-- any Official batch, package, run, score, leaderboard, or trend relation.
create function aiq_private.calibration_model_is_valid(candidate jsonb) returns boolean
    language sql stable
    SET search_path to ''
    as $$
  select coalesce(
    jsonb_typeof(candidate) = 'object'
      and aiq_private.has_exact_jsonb_keys(
        candidate, array['family','reasoning_effort']::text[]
      )
      and exists (
        select 1
        from aiq_private.aiq_model_configs model
        where model.model_family = candidate ->> 'family'
          and model.reasoning_effort = candidate ->> 'reasoning_effort'
          and model.is_enabled
      ),
    false
  );
$$;

create function aiq_private.calibration_package_v3_is_valid(envelope jsonb) returns boolean
    language plpgsql stable
    SET search_path to ''
    as $$
declare
  payload jsonb;
  preflight jsonb;
  provenance jsonb;
  result jsonb;
  model jsonb;
  candidate_task_id jsonb;
  expected_run_id text;
  expected_task_set_hash text;
begin
  if jsonb_typeof(envelope) <> 'object'
    or aiq_private.jcs_bytes_is_within(envelope,3948544) is not true
    or aiq_private.jsonb_wire_value_is_bounded(envelope) is not true
    or not aiq_private.has_exact_jsonb_keys(envelope,array[
      'claimed_trust','content_hash','idempotency_key','payload','payload_type',
      'schema_version','signature','signer'
    ]::text[])
    or envelope ->> 'schema_version' <> 'aiq.result-package.v3'
    or envelope ->> 'payload_type' <> 'aiq.calibration-run.v3'
    or envelope ->> 'claimed_trust' <> 'untrusted'
    or envelope ->> 'idempotency_key' !~ '^run_[0-9a-f]{64}$'
    or not aiq_private.dto_sha256_is_valid(envelope -> 'content_hash')
    or envelope ->> 'signature' !~ '^[0-9a-f]{128}$'
    or envelope ->> 'signature' = repeat('0',128)
    or jsonb_typeof(envelope -> 'signer') <> 'object'
    or not aiq_private.has_exact_jsonb_keys(envelope -> 'signer',array['node_id','public_key']::text[])
    or aiq_private.node_public_key_matches_id(
      envelope #>> '{signer,node_id}',envelope #>> '{signer,public_key}'
    ) is not true
  then return false; end if;
  payload := envelope -> 'payload';
  if jsonb_typeof(payload) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(payload,array[
      'capability_validation','classification','evaluator_results_artifact',
      'execution_concurrency','finished_unix_ms','models','official_eligible','provenance','results',
      'run_id','schedule_slot','schema_version','scoring_version','started_unix_ms',
      'task_ids','task_set_hash'
    ]::text[])
    or payload ->> 'schema_version' <> 'aiq.calibration-run.v3'
    or payload -> 'official_eligible' <> 'false'::jsonb
    or payload ->> 'classification' <> 'local_calibration_non_official'
    or payload ->> 'run_id' is distinct from envelope ->> 'idempotency_key'
    or payload ->> 'scoring_version' <> '1.0.5'
    or not aiq_private.dto_uint_is_valid(payload -> 'execution_concurrency',32)
    or (payload->>'execution_concurrency')::integer not between 1 and 32
    or not aiq_private.dto_schedule_is_valid(payload -> 'schedule_slot')
    or not aiq_private.dto_sha256_is_valid(payload -> 'task_set_hash')
    or not aiq_private.dto_uint_is_valid(payload -> 'started_unix_ms',9007199254740991)
    or not aiq_private.dto_uint_is_valid(payload -> 'finished_unix_ms',9007199254740991)
    or (payload ->> 'finished_unix_ms')::numeric < (payload ->> 'started_unix_ms')::numeric
    or jsonb_typeof(payload -> 'models') <> 'array'
    or jsonb_array_length(payload -> 'models') not between 1 and 17
    or jsonb_typeof(payload -> 'task_ids') <> 'array'
    or jsonb_array_length(payload -> 'task_ids') not between 1 and 72
    or jsonb_typeof(payload -> 'results') <> 'array'
    or jsonb_array_length(payload -> 'results') <> jsonb_array_length(payload -> 'models') * jsonb_array_length(payload -> 'task_ids')
    or aiq_private.jcs_sha256(payload) is distinct from envelope ->> 'content_hash'
    or not aiq_private.dto_artifact_is_valid(
      payload -> 'evaluator_results_artifact',array['evaluator-results.json'],3948544
    )
  then return false; end if;
  for model in select value from jsonb_array_elements(payload -> 'models') loop
    if aiq_private.calibration_model_is_valid(model) is not true then return false; end if;
  end loop;
  if (select count(distinct value) from jsonb_array_elements(payload -> 'models'))
       <> jsonb_array_length(payload -> 'models')
  then return false; end if;
  for candidate_task_id in select value from jsonb_array_elements(payload -> 'task_ids') loop
    if not aiq_private.dto_identifier_is_valid(candidate_task_id,64)
      or not exists (
        select 1 from aiq_private.aiq_task_catalog catalog
        where catalog.task_id = candidate_task_id #>> '{}'
      )
    then return false; end if;
  end loop;
  if (select count(distinct value) from jsonb_array_elements(payload -> 'task_ids'))
       <> jsonb_array_length(payload -> 'task_ids')
  then return false; end if;
  preflight := payload -> 'capability_validation';
  if jsonb_typeof(preflight) <> 'object'
    or preflight ->> 'schema_version' <> 'aiq.capability-validation.v2'
    or preflight ->> 'node_id' is distinct from envelope #>> '{signer,node_id}'
    or jsonb_typeof(preflight -> 'models') <> 'array'
    or (select jsonb_agg(value -> 'model' order by ordinality)
        from jsonb_array_elements(preflight -> 'models') with ordinality entry(value,ordinality))
       is distinct from payload -> 'models'
  then return false; end if;
  provenance := payload -> 'provenance';
  if aiq_private.run_provenance_v2_is_valid(provenance) is not true
    or provenance ->> 'run_class' <> 'calibration'
    or aiq_private.production_execution_identities_are_authorized(
      envelope #>> '{signer,node_id}',null
    ) is not true
  then return false; end if;
  for result in select value from jsonb_array_elements(payload -> 'results') loop
    if aiq_private.dto_result_is_valid(result,payload ->> 'run_id',false,preflight) is not true
      or not (payload -> 'models') @> jsonb_build_array(result -> 'model')
      or not (payload -> 'task_ids') @> jsonb_build_array(result -> 'task_id')
      or not exists (
        select 1
        from aiq_private.aiq_task_catalog catalog
        where catalog.task_id = result ->> 'task_id'
          and catalog.task_version = result ->> 'task_version'
          and catalog.fixture_commitment is not null
          and result ->> 'task_hash' = 'sha256:' || catalog.fixture_commitment
      )
    then return false; end if;
  end loop;
  if (select count(distinct (value ->> 'task_id',value -> 'model'))
      from jsonb_array_elements(payload -> 'results')) <> jsonb_array_length(payload -> 'results')
    or exists(
      select 1
      from jsonb_array_elements(payload->'results') left_result
      join jsonb_array_elements(payload->'results') right_result
        on left_result->>'task_id'=right_result->>'task_id'
      where left_result->>'task_version'<>right_result->>'task_version'
        or left_result->>'task_hash'<>right_result->>'task_hash'
  )
  then return false; end if;
  select aiq_private.jcs_sha256(jsonb_agg(task_hash order by task_hash collate "C"))
  into expected_task_set_hash
  from (
    select distinct result_entry.value->>'task_hash' as task_hash
    from jsonb_array_elements(payload->'results') result_entry(value)
  ) hashes;
  if expected_task_set_hash is distinct from payload->>'task_set_hash'
  then return false; end if;
  expected_run_id := 'run_' || substr(aiq_private.jcs_sha256(jsonb_build_object(
    'schema_version','aiq.run-identity.v3','run_class','calibration',
    'slot',payload -> 'schedule_slot','task_set_hash',payload -> 'task_set_hash',
    'corpus_commitment_sha256',provenance -> 'corpus_commitment_sha256',
    'models',payload -> 'models','scoring_version',payload -> 'scoring_version'
  )),8);
  return payload ->> 'run_id' = expected_run_id;
exception when others then return false;
end;
$$;

create table aiq_private.efficiency_pricing_methods (
  pricing_digest text primary key,
  method text not null,
  version text not null,
  as_of date not null,
  source text not null,
  currency text not null,
  processing_tier text not null,
  rates jsonb not null,
  formula text not null,
  limitations text[] not null,
  pricing_record jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint efficiency_pricing_methods_digest check (pricing_digest ~ '^sha256:[0-9a-f]{64}$'),
  constraint efficiency_pricing_methods_currency check (currency = 'USD'),
  constraint efficiency_pricing_methods_processing_tier check (processing_tier = 'standard'),
  constraint efficiency_pricing_methods_shape check (
    aiq_private.efficiency_pricing_v1_is_valid(pricing_record)
    and pricing_digest=aiq_private.jcs_sha256(pricing_record)
    and method=pricing_record->>'method'
    and version=pricing_record->>'version'
    and as_of::text=pricing_record->>'as_of'
    and source=pricing_record->>'source'
    and currency=pricing_record->>'currency'
    and processing_tier=pricing_record->>'processing_tier'
    and rates=pricing_record->'rates'
    and formula=pricing_record->>'formula'
    and limitations=array[pricing_record->>'limitation']
  )
);

comment on table aiq_private.efficiency_pricing_methods IS 'Immutable pricing-method evidence. Historical estimates bind this digest and never use a mutable current-price lookup.';

create table aiq_private.efficiency_official_models (
  run_id text primary key references aiq_private.aiq_runs(run_id),
  result_count integer not null,
  attempted_result_count integer not null,
  execution_concurrency integer not null,
  invoked_result_count integer not null,
  adapter_elapsed_observed_result_count integer not null,
  observed_total_wall_ms bigint,
  observed_median_wall_ms bigint,
  observed_p95_wall_ms bigint,
  input_tokens bigint,
  cached_input_tokens bigint,
  cache_write_input_tokens bigint,
  output_tokens bigint,
  reasoning_output_tokens bigint,
  total_tokens bigint,
  token_observed_result_count integer not null,
  input_token_observed_result_count integer not null,
  cached_input_token_observed_result_count integer not null,
  cache_write_input_token_observed_result_count integer not null,
  output_token_observed_result_count integer not null,
  reasoning_token_observed_result_count integer not null,
  total_token_observed_result_count integer not null,
  priced_result_count integer not null,
  standard_api_equivalent_usd_nanos bigint,
  cost_estimator_status text not null,
  cost_evidence_level text,
  pricing_digest text not null references aiq_private.efficiency_pricing_methods(pricing_digest),
  efficiency_record jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint efficiency_official_models_counts check (
    result_count = 72 and attempted_result_count between 0 and result_count
    and execution_concurrency between 1 and 32
    and invoked_result_count between 0 and attempted_result_count
    and adapter_elapsed_observed_result_count between 0 and invoked_result_count
    and token_observed_result_count between 0 and result_count
    and input_token_observed_result_count between 0 and result_count
    and cached_input_token_observed_result_count between 0 and result_count
    and cache_write_input_token_observed_result_count between 0 and result_count
    and output_token_observed_result_count between 0 and result_count
    and reasoning_token_observed_result_count between 0 and result_count
    and total_token_observed_result_count between 0 and result_count
    and priced_result_count between 0 and result_count
  ),
  constraint efficiency_official_models_elapsed check (
    ((adapter_elapsed_observed_result_count=0)=(observed_total_wall_ms is null))
    and ((adapter_elapsed_observed_result_count=0)=(observed_median_wall_ms is null))
    and ((adapter_elapsed_observed_result_count=0)=(observed_p95_wall_ms is null))
    and observed_total_wall_ms>=0 and observed_median_wall_ms>=0 and observed_p95_wall_ms>=0
  ),
  constraint efficiency_official_models_tokens check (
    input_tokens>=0 and cached_input_tokens>=0 and cache_write_input_tokens>=0
    and output_tokens>=0 and reasoning_output_tokens>=0 and total_tokens>=0
    and ((token_observed_result_count=0)=(input_tokens is null
      and cached_input_tokens is null and cache_write_input_tokens is null
      and output_tokens is null and reasoning_output_tokens is null and total_tokens is null))
    and (cached_input_tokens is null or input_tokens is null or cached_input_tokens<=input_tokens)
    and (reasoning_output_tokens is null or output_tokens is null
      or reasoning_output_tokens<=output_tokens)
  ),
  constraint efficiency_official_models_cost check (
    cost_estimator_status in (
      'estimated','unavailable_missing_usage','unavailable_invalid_usage',
      'unavailable_context_band'
    )
    and ((cost_estimator_status='estimated')=(standard_api_equivalent_usd_nanos is not null))
    and (cost_estimator_status<>'estimated' or priced_result_count=result_count)
    and (standard_api_equivalent_usd_nanos is null
      or standard_api_equivalent_usd_nanos between 0 and 9007199254740991)
    and (cost_evidence_level is null or cost_evidence_level='verifier_recomputed')
    and ((standard_api_equivalent_usd_nanos is null)=(cost_evidence_level is null))
  ),
  constraint efficiency_official_models_record check (
    aiq_private.efficiency_aggregate_v1_is_valid(efficiency_record)
    and result_count::text=efficiency_record->>'selected_tasks'
    and adapter_elapsed_observed_result_count::text=
      efficiency_record->>'observed_wall_tasks'
    and observed_total_wall_ms::text is not distinct from
      efficiency_record->>'total_observed_wall_ms'
    and observed_median_wall_ms::text is not distinct from
      efficiency_record->>'median_observed_wall_ms'
    and observed_p95_wall_ms::text is not distinct from
      efficiency_record->>'p95_observed_wall_ms'
    and input_tokens::text is not distinct from
      efficiency_record#>>'{provider_token_totals,input}'
    and cached_input_tokens::text is not distinct from
      efficiency_record#>>'{provider_token_totals,cached_input}'
    and cache_write_input_tokens::text is not distinct from
      efficiency_record#>>'{provider_token_totals,cache_write_input}'
    and output_tokens::text is not distinct from
      efficiency_record#>>'{provider_token_totals,output}'
    and reasoning_output_tokens::text is not distinct from
      efficiency_record#>>'{provider_token_totals,reasoning}'
    and total_tokens::text is not distinct from
      efficiency_record#>>'{provider_token_totals,total}'
    and input_token_observed_result_count::text=
      efficiency_record#>>'{provider_token_coverage,input_tasks}'
    and cached_input_token_observed_result_count::text=
      efficiency_record#>>'{provider_token_coverage,cached_input_tasks}'
    and cache_write_input_token_observed_result_count::text=
      efficiency_record#>>'{provider_token_coverage,cache_write_input_tasks}'
    and output_token_observed_result_count::text=
      efficiency_record#>>'{provider_token_coverage,output_tasks}'
    and reasoning_token_observed_result_count::text=
      efficiency_record#>>'{provider_token_coverage,reasoning_tasks}'
    and total_token_observed_result_count::text=
      efficiency_record#>>'{provider_token_coverage,total_tasks}'
    and priced_result_count::text=efficiency_record->>'estimated_cost_tasks'
    and standard_api_equivalent_usd_nanos::text is not distinct from
      efficiency_record->>'standard_api_equivalent_usd_nanos'
  )
);

comment on table aiq_private.efficiency_official_models IS
  'Immutable verifier-recomputed Official efficiency aggregates. These values do not affect AIQ ranking.';
comment on column aiq_private.efficiency_official_models.attempted_result_count IS
  'Selected cells that passed capability admission and entered task preparation.';
comment on column aiq_private.efficiency_official_models.invoked_result_count IS
  'Attempted cells that reached the Codex adapter after workspace preparation.';
comment on column aiq_private.efficiency_official_models.observed_total_wall_ms IS
  'Sum of observed Codex adapter invocation elapsed milliseconds.';
comment on column aiq_private.efficiency_official_models.observed_median_wall_ms IS
  'Rust aggregate median of observed Codex adapter invocation elapsed milliseconds.';
comment on column aiq_private.efficiency_official_models.observed_p95_wall_ms IS
  'Rust aggregate nearest-rank p95 of observed Codex adapter invocation elapsed milliseconds.';

alter table aiq_private.aiq_task_results
  add constraint aiq_task_results_pricing_method_fk
  foreign key (pricing_digest) references aiq_private.efficiency_pricing_methods(pricing_digest);

create table aiq_private.calibration_verification_stages (
  run_id text primary key,
  inbox_id uuid not null unique references aiq_private.aiq_submission_inbox(inbox_id),
  package_sha256 text not null unique,
  stage_digest text not null unique,
  runner_node_id text not null references aiq_private.aiq_nodes(node_id),
  stage jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint calibration_verification_stages_run check (run_id ~ '^run_[0-9a-f]{64}$'),
  constraint calibration_verification_stages_package check (package_sha256 ~ '^[0-9a-f]{64}$'),
  constraint calibration_verification_stages_digest check (stage_digest ~ '^sha256:[0-9a-f]{64}$')
);

create table aiq_private.calibration_runs (
  run_id text primary key,
  inbox_id uuid not null unique references aiq_private.aiq_submission_inbox(inbox_id),
  package_sha256 text not null unique,
  content_hash text not null,
  normalization_digest text not null unique,
  runner_node_id text not null references aiq_private.aiq_nodes(node_id),
  verifier_node_id text not null references aiq_private.aiq_nodes(node_id),
  task_set_id text not null,
  task_set_version text not null,
  task_set_hash text not null,
  scoring_version text not null,
  classification text not null default 'local_calibration_non_official',
  replay_status text not null,
  official_eligible boolean not null default false,
  ranking_eligible boolean not null default false,
  selected_task_count integer not null,
  selected_model_count integer not null,
  result_count integer not null,
  execution_concurrency integer not null,
  attempted_result_count integer not null,
  invoked_result_count integer not null,
  observed_duration_total_ms bigint,
  observed_duration_median_ms bigint,
  observed_duration_p95_ms bigint,
  duration_evidence_level text,
  duration_coverage_count integer not null default 0,
  standard_api_equivalent_usd_nanos bigint,
  estimated_cost_coverage_count integer not null default 0,
  token_usage_coverage_count integer not null default 0,
  cost_estimator_status text not null default 'unavailable_missing_usage',
  cost_evidence_level text,
  cost_estimator_limitations text[] not null default array['per_request_long_context_unknown']::text[],
  cost_method text not null default 'standard_api_equivalent_text_token_estimate',
  cost_version text not null default 'aiq.standard-api-equivalent-usd.v1',
  cost_as_of date not null default date '2026-08-02',
  cost_source text not null default 'https://developers.openai.com/api/docs/pricing',
  started_at timestamptz not null,
  completed_at timestamptz not null,
  verified_at timestamptz not null default clock_timestamp(),
  verification_record jsonb not null,
  verifier_attestation jsonb not null,
  pricing_digest text not null references aiq_private.efficiency_pricing_methods(pricing_digest),
  unique (run_id,task_set_id,task_set_version),
  unique (run_id,package_sha256),
  foreign key (task_set_id,task_set_version)
    references aiq_private.aiq_task_sets(task_set_id,task_set_version),
  constraint calibration_runs_identity check (run_id ~ '^run_[0-9a-f]{64}$'),
  constraint calibration_runs_package_digest check (package_sha256 ~ '^[0-9a-f]{64}$'),
  constraint calibration_runs_content_digest check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint calibration_runs_normalization_digest check (normalization_digest ~ '^sha256:[0-9a-f]{64}$'),
  constraint calibration_runs_task_set_digest check (task_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint calibration_runs_classification check (
    classification = 'local_calibration_non_official'
    and replay_status = 'evaluator_replayed'
    and not official_eligible and not ranking_eligible
  ),
  constraint calibration_runs_identity_separation check (runner_node_id <> verifier_node_id),
  constraint calibration_runs_counts check (
    selected_task_count between 1 and 72
    and selected_model_count between 1 and 17
    and result_count=selected_task_count*selected_model_count
    and execution_concurrency between 1 and 32
    and attempted_result_count between 0 and result_count
    and invoked_result_count between 0 and attempted_result_count
  ),
  constraint calibration_runs_time check (completed_at >= started_at)
  ,constraint calibration_runs_efficiency_nonnegative check (
    observed_duration_total_ms >= 0 and observed_duration_median_ms >= 0
    and observed_duration_p95_ms >= 0 and standard_api_equivalent_usd_nanos >= 0
  )
  ,constraint calibration_runs_efficiency_coverage check (
    duration_coverage_count between 0 and invoked_result_count
    and estimated_cost_coverage_count between 0 and result_count
    and token_usage_coverage_count between 0 and result_count
    and ((duration_coverage_count = 0) = (observed_duration_total_ms is null))
    and ((duration_coverage_count = 0) = (observed_duration_median_ms is null))
    and ((duration_coverage_count = 0) = (observed_duration_p95_ms is null))
    and ((duration_coverage_count = 0) = (duration_evidence_level is null))
    and (cost_estimator_status = 'estimated') =
      (standard_api_equivalent_usd_nanos is not null)
  )
  ,constraint calibration_runs_evidence_levels check (
    (duration_evidence_level is null or duration_evidence_level = 'runner_observed')
    and (cost_evidence_level is null or cost_evidence_level = 'verifier_recomputed')
    and ((standard_api_equivalent_usd_nanos is null) = (cost_evidence_level is null))
  )
  ,constraint calibration_runs_cost_metadata check (
    cost_estimator_status in (
      'estimated','unavailable_missing_usage','unavailable_invalid_usage',
      'unavailable_context_band'
    )
    and cost_method is not null and cost_version is not null
    and cost_as_of is not null and cost_source is not null
    and (cost_estimator_status <> 'estimated'
      or estimated_cost_coverage_count = result_count)
  )
);

comment on table aiq_private.calibration_runs IS 'Append-only verifier-normalized local calibration evidence. It is untrusted, non-Official, and never ranking eligible.';
comment on column aiq_private.calibration_runs.attempted_result_count IS
  'Selected cells that passed capability admission and entered task preparation.';
comment on column aiq_private.calibration_runs.invoked_result_count IS
  'Attempted cells that reached the Codex adapter after workspace preparation.';
comment on column aiq_private.calibration_runs.observed_duration_total_ms IS
  'Sum of observed Codex adapter invocation elapsed milliseconds.';
comment on column aiq_private.calibration_runs.observed_duration_median_ms IS
  'Median of observed Codex adapter invocation elapsed milliseconds.';
comment on column aiq_private.calibration_runs.observed_duration_p95_ms IS
  'Nearest-rank p95 of observed Codex adapter invocation elapsed milliseconds.';

create table aiq_private.aiq_publication_storage_evidence (
  publication_class text not null,
  publication_id text not null,
  official_batch_id text,
  calibration_run_id text,
  package_sha256 text not null,
  object_id uuid not null,
  evidence_role text not null,
  artifact_kind text not null,
  content_sha256 text not null,
  reference_type text not null,
  reference_key text not null unique,
  bound_at timestamptz not null default clock_timestamp(),
  primary key(publication_class,publication_id,evidence_role,artifact_kind,content_sha256),
  foreign key (object_id,content_sha256)
    references aiq_private.aiq_storage_objects(object_id,content_sha256),
  foreign key (official_batch_id,package_sha256)
    references aiq_private.aiq_matrix_batches(matrix_batch_id,package_sha256),
  foreign key (calibration_run_id,package_sha256)
    references aiq_private.calibration_runs(run_id,package_sha256),
  constraint aiq_publication_storage_evidence_class check (
    (publication_class='official' and official_batch_id is not null
      and official_batch_id=publication_id
      and calibration_run_id is null)
    or (publication_class='calibration' and calibration_run_id is not null
      and calibration_run_id=publication_id
      and official_batch_id is null)
  ),
  constraint aiq_publication_storage_evidence_identity check (
    publication_id ~ '^run_[0-9a-f]{64}$'
    and package_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint aiq_publication_storage_evidence_role check (
    evidence_role in ('submitted_package','verified_artifact')
  ),
  constraint aiq_publication_storage_evidence_kind check (
    artifact_kind ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  constraint aiq_publication_storage_evidence_digest check (
    content_sha256~'^[0-9a-f]{64}$'
  ),
  constraint aiq_publication_storage_evidence_package_role check (
    (evidence_role='submitted_package' and artifact_kind='result-package.json'
      and content_sha256=package_sha256)
    or (evidence_role='verified_artifact' and artifact_kind<>'result-package.json')
  ),
  constraint aiq_publication_storage_evidence_reference check (
    reference_type=case publication_class
      when 'official' then 'official_publication' else 'calibration_run' end
    and reference_key=publication_class||'/'||publication_id||'/'||
      content_sha256||'/'||artifact_kind
  )
);

comment on table aiq_private.aiq_publication_storage_evidence IS
  'Append-only durable ownership map for each retained package and every claim-bound audit artifact required by an Official or calibration publication.';

create function aiq_private.reconcile_publication_storage_evidence(
  supplied_publication_class text,target_publication_id text,
  target_package_sha256 text,target_inbox_id uuid
) returns integer
    language plpgsql security definer
    SET search_path to ''
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
  payload jsonb;
  reference_kind text;
  retained_key text;
  package_object_id uuid;
  retained_artifact record;
  retained_count integer;
begin
  if supplied_publication_class not in ('official','calibration')
    or not coalesce(target_publication_id~'^run_[0-9a-f]{64}$',false)
    or not coalesce(target_package_sha256~'^[0-9a-f]{64}$',false)
  then raise exception 'invalid publication Storage ownership identity'
    using errcode='22023'; end if;
  select * into claimed
  from aiq_private.aiq_submission_inbox inbox
  where inbox.inbox_id=target_inbox_id
    and inbox.idempotency_key=target_publication_id
    and inbox.package_sha256=target_package_sha256
  for share;
  if claimed.inbox_id is null
    or (supplied_publication_class='official'
      and (claimed.envelope->>'payload_type'<>'aiq.run.v3'
        or not exists(select 1 from aiq_private.aiq_matrix_batches batch
          join aiq_private.aiq_result_packages package
            on package.matrix_batch_id=batch.matrix_batch_id
            and package.package_sha256=batch.package_sha256
          where batch.matrix_batch_id=target_publication_id
            and batch.package_sha256=target_package_sha256)
        or aiq_private.publication_is_complete(
          target_publication_id,target_package_sha256
        ) is not true))
    or (supplied_publication_class='calibration'
      and (claimed.envelope->>'payload_type'<>'aiq.calibration-run.v3'
        or not exists(select 1 from aiq_private.calibration_runs run
          where run.run_id=target_publication_id
            and run.package_sha256=target_package_sha256
            and run.inbox_id=target_inbox_id)
        or not exists(select 1 from aiq_private.calibration_verification_audit audit
          where audit.run_id=target_publication_id
            and audit.package_sha256=target_package_sha256
            and audit.inbox_id=target_inbox_id
            and audit.event_type='verifier_recorded')))
  then raise exception 'publication Storage ownership source is absent or conflicting'
    using errcode='55000'; end if;
  payload:=claimed.envelope->'payload';
  reference_kind:=case supplied_publication_class
    when 'official' then 'official_publication' else 'calibration_run' end;
  select object.object_id into strict package_object_id
  from aiq_private.aiq_storage_objects object
  where object.bucket_name=claimed.object_bucket
    and object.object_path=claimed.object_key
    and object.content_sha256=claimed.package_sha256
    and object.lifecycle_state<>'deleted';
  retained_key:=supplied_publication_class||'/'||target_publication_id||'/'||
    target_package_sha256||'/result-package.json';
  insert into aiq_private.aiq_publication_storage_evidence(
    publication_class,publication_id,official_batch_id,calibration_run_id,
    package_sha256,object_id,evidence_role,artifact_kind,content_sha256,
    reference_type,reference_key
  ) values(
    supplied_publication_class,target_publication_id,
    case when supplied_publication_class='official' then target_publication_id end,
    case when supplied_publication_class='calibration' then target_publication_id end,
    target_package_sha256,
    package_object_id,'submitted_package','result-package.json',
    target_package_sha256,reference_kind,retained_key
  ) on conflict do nothing;
  if not exists(select 1 from aiq_private.aiq_publication_storage_evidence evidence
    where evidence.reference_key=retained_key
      and evidence.publication_class=supplied_publication_class
      and evidence.publication_id=target_publication_id
      and evidence.package_sha256=target_package_sha256
      and evidence.object_id=package_object_id
      and evidence.reference_type=reference_kind)
  then raise exception 'conflicting publication package Storage ownership'
    using errcode='23505'; end if;
  perform aiq_private.attach_storage_reference(
    package_object_id,reference_kind,retained_key
  );
  if exists(
    with required(artifact_kind,content_sha256) as (
      select payload#>>'{evaluator_results_artifact,kind}',
        replace(payload#>>'{evaluator_results_artifact,content_hash}','sha256:','')
      union
      select artifact->>'kind',replace(artifact->>'content_hash','sha256:','')
      from jsonb_array_elements(payload->'results') result
      cross join lateral jsonb_array_elements(result->'artifacts') artifact
      union
      select result#>>'{workspace_manifest,kind}',
        replace(result#>>'{workspace_manifest,content_hash}','sha256:','')
      from jsonb_array_elements(payload->'results') result
      where jsonb_typeof(result->'workspace_manifest')='object'
      union
      select artifact->>'kind',replace(artifact->>'content_hash','sha256:','')
      from jsonb_array_elements(payload#>'{capability_validation,models}') model
      cross join lateral jsonb_array_elements(model#>'{probe,artifacts}') artifact
    )
    select 1 from required
    where not exists(select 1 from aiq_private.aiq_artifact_claim_bindings binding
      where binding.inbox_id=target_inbox_id
        and binding.artifact_kind=required.artifact_kind
        and binding.content_sha256=required.content_sha256)
  ) then raise exception 'publication audit artifact is not claim-bound'
    using errcode='55000'; end if;
  if exists(
    select 1
    from aiq_private.aiq_artifact_claim_bindings binding
    where binding.inbox_id=target_inbox_id
      and not exists(
        select 1
        from aiq_private.aiq_artifact_ingress_objects artifact
        join aiq_private.aiq_storage_objects storage
          on storage.bucket_name=artifact.bucket_name
          and storage.object_path=artifact.object_path
          and storage.content_sha256=artifact.content_sha256
          and storage.lifecycle_state<>'deleted'
        where artifact.artifact_kind=binding.artifact_kind
          and artifact.content_sha256=binding.content_sha256
      )
  ) then raise exception 'claim-bound publication artifact Storage is absent'
    using errcode='55000'; end if;
  for retained_artifact in
    select storage.object_id,binding.artifact_kind,binding.content_sha256
    from aiq_private.aiq_artifact_claim_bindings binding
    join aiq_private.aiq_artifact_ingress_objects artifact
      on artifact.artifact_kind=binding.artifact_kind
      and artifact.content_sha256=binding.content_sha256
    join aiq_private.aiq_storage_objects storage
      on storage.bucket_name=artifact.bucket_name
      and storage.object_path=artifact.object_path
      and storage.content_sha256=artifact.content_sha256
      and storage.lifecycle_state<>'deleted'
    where binding.inbox_id=target_inbox_id
  loop
    retained_key:=supplied_publication_class||'/'||target_publication_id||'/'||
      retained_artifact.content_sha256||'/'||retained_artifact.artifact_kind;
    insert into aiq_private.aiq_publication_storage_evidence(
      publication_class,publication_id,official_batch_id,calibration_run_id,
      package_sha256,object_id,evidence_role,artifact_kind,content_sha256,
      reference_type,reference_key
    ) values(
      supplied_publication_class,target_publication_id,
      case when supplied_publication_class='official' then target_publication_id end,
      case when supplied_publication_class='calibration' then target_publication_id end,
      target_package_sha256,
      retained_artifact.object_id,'verified_artifact',retained_artifact.artifact_kind,
      retained_artifact.content_sha256,reference_kind,retained_key
    ) on conflict do nothing;
    if not exists(select 1 from aiq_private.aiq_publication_storage_evidence evidence
      where evidence.reference_key=retained_key
        and evidence.publication_class=supplied_publication_class
        and evidence.publication_id=target_publication_id
        and evidence.package_sha256=target_package_sha256
        and evidence.object_id=retained_artifact.object_id
        and evidence.reference_type=reference_kind)
    then raise exception 'conflicting publication artifact Storage ownership'
      using errcode='23505'; end if;
    perform aiq_private.attach_storage_reference(
      retained_artifact.object_id,reference_kind,retained_key
    );
  end loop;
  if not exists(select 1 from aiq_private.aiq_publication_storage_evidence evidence
    where evidence.publication_class=supplied_publication_class
      and evidence.publication_id=target_publication_id
      and evidence.package_sha256=target_package_sha256
      and evidence.evidence_role='submitted_package')
    or not exists(select 1 from aiq_private.aiq_publication_storage_evidence evidence
      where evidence.publication_class=supplied_publication_class
        and evidence.publication_id=target_publication_id
        and evidence.package_sha256=target_package_sha256
        and evidence.evidence_role='verified_artifact'
        and evidence.artifact_kind='evaluator-results.json')
    or (select count(*) from aiq_private.aiq_artifact_claim_bindings binding
        where binding.inbox_id=target_inbox_id)<>
      (select count(*) from aiq_private.aiq_publication_storage_evidence evidence
        where evidence.publication_class=supplied_publication_class
          and evidence.publication_id=target_publication_id
          and evidence.package_sha256=target_package_sha256
          and evidence.evidence_role='verified_artifact')
  then raise exception 'publication Storage ownership is incomplete'
    using errcode='55000'; end if;
  select count(*)::integer into retained_count
  from aiq_private.aiq_publication_storage_evidence evidence
  where evidence.publication_class=supplied_publication_class
    and evidence.publication_id=target_publication_id
    and evidence.package_sha256=target_package_sha256;
  return retained_count;
end;
$$;

create table aiq_private.calibration_model_scores (
  run_id text not null references aiq_private.calibration_runs(run_id),
  model_family text not null,
  reasoning_effort text not null,
  descriptive_status text not null,
  score numeric(12,8),
  task_resampling_sensitivity_lower numeric(12,8),
  task_resampling_sensitivity_upper numeric(12,8),
  task_resampling_sensitivity_method text,
  result_count integer not null,
  scored_result_count integer not null,
  coverage_percent numeric(7,4) not null,
  observed_total_wall_ms bigint,
  observed_median_wall_ms bigint,
  observed_p95_wall_ms bigint,
  observed_time_sample_count integer not null default 0,
  attempted_result_count integer not null,
  invoked_result_count integer not null,
  observed_time_coverage_percent numeric(7,4) not null default 0,
  duration_evidence_level text,
  standard_api_equivalent_usd_nanos bigint,
  estimated_cost_sample_count integer not null default 0,
  input_tokens bigint,
  cached_input_tokens bigint,
  cache_write_input_tokens bigint,
  output_tokens bigint,
  reasoning_output_tokens bigint,
  total_tokens bigint,
  token_usage_sample_count integer not null default 0,
  token_usage_coverage_percent numeric(7,4) not null default 0,
  cost_estimator_status text not null default 'unavailable_missing_usage',
  cost_evidence_level text,
  cost_estimator_limitations text[] not null default array['per_request_long_context_unknown']::text[],
  pricing_source text not null default 'https://developers.openai.com/api/docs/pricing',
  pricing_as_of date not null default date '2026-08-02',
  pricing_version text not null default 'aiq.standard-api-equivalent-usd.v1',
  pricing_digest text not null references aiq_private.efficiency_pricing_methods(pricing_digest),
  primary key (run_id, model_family, reasoning_effort),
  constraint calibration_model_scores_score check (score is null or score between 0 and 100),
  constraint calibration_model_scores_interval check (
    (task_resampling_sensitivity_lower is null) =
      (task_resampling_sensitivity_upper is null)
    and (task_resampling_sensitivity_lower is null) =
      (task_resampling_sensitivity_method is null)
    and (task_resampling_sensitivity_lower is null or (
      task_resampling_sensitivity_lower between 0 and 100
      and task_resampling_sensitivity_upper between task_resampling_sensitivity_lower and 100
      and task_resampling_sensitivity_method ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    ))
  ),
  constraint calibration_model_scores_status check (
    descriptive_status in ('complete_fixture','conditional_observed','coverage_only','not_applicable')
  ),
  constraint calibration_model_scores_efficiency check (
    coverage_percent between 0 and 100
    and (observed_total_wall_ms is null or observed_total_wall_ms >= 0)
    and (observed_median_wall_ms is null or observed_median_wall_ms >= 0)
    and (observed_p95_wall_ms is null or observed_p95_wall_ms >= 0)
    and attempted_result_count between 0 and result_count
    and invoked_result_count between 0 and attempted_result_count
    and observed_time_sample_count between 0 and invoked_result_count
    and estimated_cost_sample_count between 0 and result_count
    and token_usage_sample_count between 0 and result_count
    and observed_time_coverage_percent between 0 and 100
    and (standard_api_equivalent_usd_nanos is null or standard_api_equivalent_usd_nanos >= 0)
    and (token_usage_coverage_percent is null or token_usage_coverage_percent between 0 and 100)
    and token_usage_coverage_percent = round(
      100 * token_usage_sample_count::numeric / result_count,4
    )
    and input_tokens >= 0 and cached_input_tokens >= 0 and cache_write_input_tokens >= 0
    and output_tokens >= 0 and reasoning_output_tokens >= 0 and total_tokens >= 0
    and ((token_usage_sample_count=0)=(input_tokens is null
      and cached_input_tokens is null and cache_write_input_tokens is null
      and output_tokens is null and reasoning_output_tokens is null and total_tokens is null))
    and (cached_input_tokens is null or input_tokens is null or cached_input_tokens <= input_tokens)
    and (reasoning_output_tokens is null or output_tokens is null
      or reasoning_output_tokens <= output_tokens)
    and (duration_evidence_level is null or duration_evidence_level = 'runner_observed')
    and (cost_evidence_level is null or cost_evidence_level = 'verifier_recomputed')
    and ((standard_api_equivalent_usd_nanos is null) = (cost_evidence_level is null))
    and ((observed_time_sample_count = 0) = (observed_total_wall_ms is null))
    and ((observed_time_sample_count = 0) = (observed_median_wall_ms is null))
    and ((observed_time_sample_count = 0) = (observed_p95_wall_ms is null))
    and ((observed_time_sample_count = 0) = (duration_evidence_level is null))
  ),
  constraint calibration_model_scores_pricing check (
    cost_estimator_status in (
      'estimated','unavailable_missing_usage','unavailable_invalid_usage',
      'unavailable_context_band'
    )
    and (cost_estimator_status = 'estimated') =
      (standard_api_equivalent_usd_nanos is not null)
    and (cost_estimator_status <> 'estimated'
      or estimated_cost_sample_count = result_count)
  ),
  constraint calibration_model_scores_counts check (
    result_count >= 1 and scored_result_count between 0 and result_count
    and coverage_percent = round(100 * scored_result_count::numeric / result_count, 4)
    and ((descriptive_status in ('coverage_only','not_applicable')) = (score is null))
  )
);

comment on column aiq_private.calibration_model_scores.attempted_result_count IS
  'Selected cells that passed capability admission and entered task preparation.';
comment on column aiq_private.calibration_model_scores.invoked_result_count IS
  'Attempted cells that reached the Codex adapter after workspace preparation.';
comment on column aiq_private.calibration_model_scores.observed_total_wall_ms IS
  'Sum of observed Codex adapter invocation elapsed milliseconds.';
comment on column aiq_private.calibration_model_scores.observed_median_wall_ms IS
  'Rust aggregate median of observed Codex adapter invocation elapsed milliseconds.';
comment on column aiq_private.calibration_model_scores.observed_p95_wall_ms IS
  'Rust aggregate nearest-rank p95 of observed Codex adapter invocation elapsed milliseconds.';

create table aiq_private.calibration_task_results (
  result_id text primary key,
  run_id text not null references aiq_private.calibration_runs(run_id),
  task_set_id text not null,
  task_set_version text not null,
  task_id text not null,
  task_version text not null,
  task_hash text not null,
  domain text not null,
  model_family text not null,
  reasoning_effort text not null,
  outcome aiq_private.result_outcome not null,
  task_score numeric(9,8),
  failure_code text,
  latency_ms bigint,
  latency_evidence_level text,
  input_tokens bigint,
  cached_input_tokens bigint,
  cache_write_input_tokens bigint,
  output_tokens bigint,
  reasoning_output_tokens bigint,
  total_tokens bigint,
  token_usage_source_level text,
  token_usage_evidence_level text,
  standard_api_equivalent_usd_nanos bigint,
  cost_estimator_status text not null default 'unavailable_missing_usage',
  cost_evidence_level text,
  cost_estimator_limitations text[] not null default array['per_request_long_context_unknown']::text[],
  cost_method text not null default 'standard_api_equivalent_text_token_estimate',
  cost_version text not null default 'aiq.standard-api-equivalent-usd.v1',
  cost_as_of date not null default date '2026-08-02',
  cost_source text not null default 'https://developers.openai.com/api/docs/pricing',
  pricing_digest text not null references aiq_private.efficiency_pricing_methods(pricing_digest),
  unique (run_id, task_id, task_version, model_family, reasoning_effort),
  foreign key (run_id,task_set_id,task_set_version)
    references aiq_private.calibration_runs(run_id,task_set_id,task_set_version),
  foreign key (task_set_id,task_set_version,task_id,task_version,task_hash)
    references aiq_private.aiq_task_catalog(
      task_set_id,task_set_version,task_id,task_version,task_hash
    ),
  constraint calibration_task_results_id check (result_id ~ '^result_[0-9a-f]{64}$'),
  constraint calibration_task_results_task_hash check (task_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint calibration_task_results_outcome_score check (
    (outcome='correct' and task_score is not null and task_score=1)
    or (outcome='partial' and task_score is not null and task_score>0 and task_score<1)
    or (outcome in (
      'incorrect','timeout','budget_exhausted','tool_failure','policy_failure','wrong_artifact'
    ) and task_score is not null and task_score=0)
    or (outcome in ('invalid','missing','not_applicable') and task_score is null)
  ),
  constraint calibration_task_results_failure_code check (
    failure_code is null or failure_code ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'
  ),
  constraint calibration_task_results_failure_binding check (
    (outcome in ('correct','partial','incorrect','missing') and failure_code is null)
    or (outcome='timeout' and failure_code is not null and failure_code='timeout')
    or (outcome='budget_exhausted' and failure_code is not null
      and failure_code='budget_exceeded')
    or (outcome='tool_failure' and failure_code is not null
      and failure_code in ('unsupported_model','non_zero_exit'))
    or (outcome='policy_failure' and failure_code is not null
      and failure_code='output_truncated')
    or (outcome='wrong_artifact' and failure_code is not null
      and failure_code='missing_response')
    or (outcome='invalid' and failure_code is not null and failure_code in (
      'evaluator_failure','workspace_unavailable','workspace_integrity','missing_evaluator','spawn',
      'authentication','subscription_limit','capability_validation_failed'
    ))
    or (outcome='not_applicable' and failure_code is not null
      and failure_code='capability_unavailable')
  )
  ,constraint calibration_task_results_efficiency_nonnegative check (
    latency_ms >= 0 and input_tokens >= 0 and cached_input_tokens >= 0
    and cache_write_input_tokens >= 0 and output_tokens >= 0 and reasoning_output_tokens >= 0
    and total_tokens >= 0 and standard_api_equivalent_usd_nanos >= 0
  )
  ,constraint calibration_task_results_cached_tokens check (
    cached_input_tokens is null or input_tokens is null or cached_input_tokens <= input_tokens
  )
  ,constraint calibration_task_results_reasoning_subset check (
    reasoning_output_tokens is null or output_tokens is null
    or reasoning_output_tokens <= output_tokens
  )
  ,constraint calibration_task_results_evidence_levels check (
    (latency_evidence_level is null or latency_evidence_level = 'runner_observed')
    and (token_usage_source_level is null or token_usage_source_level = 'provider_reported')
    and (token_usage_evidence_level is null or token_usage_evidence_level = 'verifier_recomputed')
    and (cost_evidence_level is null or cost_evidence_level = 'verifier_recomputed')
    and ((latency_ms is null) = (latency_evidence_level is null))
    and ((input_tokens is null and cached_input_tokens is null
      and cache_write_input_tokens is null and output_tokens is null
      and reasoning_output_tokens is null and total_tokens is null)
      = (token_usage_evidence_level is null))
    and ((token_usage_source_level is null) = (token_usage_evidence_level is null))
    and ((standard_api_equivalent_usd_nanos is null) = (cost_evidence_level is null))
  )
  ,constraint calibration_task_results_cost_metadata check (
    cost_estimator_status in (
      'estimated','unavailable_missing_usage','unavailable_invalid_usage',
      'unavailable_context_band'
    )
    and cost_method is not null and cost_version is not null
    and cost_as_of is not null and cost_source is not null
    and (cost_estimator_status <> 'estimated' or standard_api_equivalent_usd_nanos is not null)
    and (cost_estimator_status = 'estimated' or standard_api_equivalent_usd_nanos is null)
    and ((cost_estimator_status = 'unavailable_context_band') = coalesce((
      input_tokens > 272000 and cached_input_tokens is not null
      and cache_write_input_tokens is not null and output_tokens is not null
    ), false))
  )
);

comment on column aiq_private.calibration_task_results.latency_ms IS
  'Observed Codex adapter invocation elapsed milliseconds. It is NULL when the adapter was not invoked.';
comment on column aiq_private.calibration_task_results.outcome IS
  'Normalized result outcome derived from the signed source status, failure kind, and model score tier.';
comment on column aiq_private.calibration_task_results.failure_code IS
  'Bounded structured source failure kind. Public views never expose the raw failure message.';

create table aiq_private.calibration_verification_audit (
  audit_id uuid primary key default extensions.gen_random_uuid(),
  run_id text not null,
  inbox_id uuid not null references aiq_private.aiq_submission_inbox(inbox_id),
  package_sha256 text not null,
  event_type text not null,
  actor_node_id text not null references aiq_private.aiq_nodes(node_id),
  event_digest text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (run_id, event_type),
  foreign key (run_id,package_sha256)
    references aiq_private.calibration_runs(run_id,package_sha256),
  constraint calibration_verification_audit_event check (
    event_type in ('verifier_recorded','publisher_published')
  ),
  constraint calibration_verification_audit_package check (package_sha256 ~ '^[0-9a-f]{64}$'),
  constraint calibration_verification_audit_digest check (event_digest ~ '^sha256:[0-9a-f]{64}$')
);

create table aiq_private.calibration_publications (
  run_id text primary key,
  package_sha256 text not null unique,
  publisher_node_id text not null references aiq_private.aiq_nodes(node_id),
  classification text not null default 'local_calibration_non_official',
  official_eligible boolean not null default false,
  ranking_eligible boolean not null default false,
  published_at timestamptz not null default clock_timestamp(),
  foreign key (run_id,package_sha256)
    references aiq_private.calibration_runs(run_id,package_sha256),
  constraint calibration_publications_classification check (
    classification = 'local_calibration_non_official'
    and not official_eligible and not ranking_eligible
  )
);

create function aiq_private.reject_calibration_evidence_mutation() returns trigger
    language plpgsql
    SET search_path to ''
    as $$
begin
  raise exception 'publication and calibration evidence is append-only'
    using errcode = '55000';
end;
$$;

create trigger calibration_runs_append_only before update or delete on aiq_private.calibration_runs
  for each row execute function aiq_private.reject_calibration_evidence_mutation();
create trigger aiq_publication_storage_evidence_append_only before update or delete on aiq_private.aiq_publication_storage_evidence
  for each row execute function aiq_private.reject_calibration_evidence_mutation();
create trigger calibration_verification_stages_append_only before update or delete on aiq_private.calibration_verification_stages
  for each row execute function aiq_private.reject_calibration_evidence_mutation();
create trigger efficiency_pricing_methods_append_only before update or delete on aiq_private.efficiency_pricing_methods
  for each row execute function aiq_private.reject_calibration_evidence_mutation();
create trigger efficiency_official_models_append_only before update or delete on aiq_private.efficiency_official_models
  for each row execute function aiq_private.reject_calibration_evidence_mutation();
create trigger calibration_model_scores_append_only before update or delete on aiq_private.calibration_model_scores
  for each row execute function aiq_private.reject_calibration_evidence_mutation();
create trigger calibration_task_results_append_only before update or delete on aiq_private.calibration_task_results
  for each row execute function aiq_private.reject_calibration_evidence_mutation();
create trigger calibration_verification_audit_append_only before update or delete on aiq_private.calibration_verification_audit
  for each row execute function aiq_private.reject_calibration_evidence_mutation();
create trigger calibration_publications_append_only before update or delete on aiq_private.calibration_publications
  for each row execute function aiq_private.reject_calibration_evidence_mutation();

create function public.aiq_stage_calibration_verification(
  stage jsonb,target_inbox_id uuid,supplied_lease_token uuid,supplied_attempt integer
) returns text
    language plpgsql security definer
    SET search_path to ''
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
  existing_stage aiq_private.calibration_verification_stages%rowtype;
  payload jsonb;
  expected_stage_digest text;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  if jsonb_typeof(stage) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(stage,array[
      'benchmark_version','capability_validation_digest','classification','content_hash',
      'evaluator_results_artifact','execution_concurrency','finished_unix_ms','models','model_selection_digest',
      'official_eligible','package_sha256','pricing','prompt_set_digest','provenance','ranking_eligible',
      'region','result_efficiency','run_class','run_id','runner','runner_commit','scheduled_unix_ms',
      'schema_version','score_reports_digest','scores','scoring_version','stage_digest',
      'started_unix_ms','task_ids','task_selection_digest','task_set_hash','task_set_id',
      'task_set_version','telemetry_digest','trust'
    ]::text[])
    or stage ->> 'schema_version' <> 'aiq.calibration-verified-stage.v1'
    or stage ->> 'classification' <> 'local_calibration_non_official'
    or stage ->> 'run_class' <> 'calibration'
    or stage ->> 'trust' <> 'untrusted'
    or stage -> 'official_eligible' <> 'false'::jsonb
    or stage -> 'ranking_eligible' <> 'false'::jsonb
    or stage ->> 'run_id' !~ '^run_[0-9a-f]{64}$'
    or stage ->> 'package_sha256' !~ '^[0-9a-f]{64}$'
    or not aiq_private.dto_sha256_is_valid(stage -> 'content_hash')
    or not aiq_private.dto_sha256_is_valid(stage -> 'task_set_hash')
    or not aiq_private.dto_sha256_is_valid(stage -> 'task_selection_digest')
    or not aiq_private.dto_sha256_is_valid(stage -> 'model_selection_digest')
    or not aiq_private.dto_sha256_is_valid(stage -> 'score_reports_digest')
    or not aiq_private.dto_sha256_is_valid(stage -> 'telemetry_digest')
    or not aiq_private.dto_sha256_is_valid(stage -> 'capability_validation_digest')
    or not aiq_private.dto_sha256_is_valid(stage -> 'prompt_set_digest')
    or jsonb_typeof(stage -> 'runner') <> 'object'
    or not aiq_private.has_exact_jsonb_keys(stage -> 'runner',array['node_id','public_key']::text[])
    or aiq_private.node_public_key_matches_id(
      stage #>> '{runner,node_id}',stage #>> '{runner,public_key}'
    ) is not true
    or jsonb_typeof(stage -> 'task_ids') <> 'array'
    or jsonb_typeof(stage -> 'models') <> 'array'
    or jsonb_typeof(stage -> 'scores') <> 'array'
    or jsonb_typeof(stage -> 'result_efficiency') <> 'array'
    or aiq_private.efficiency_pricing_v1_is_valid(stage -> 'pricing') is not true
    or jsonb_array_length(stage->'scores')<>jsonb_array_length(stage->'models')
    or jsonb_array_length(stage->'result_efficiency')<>
      jsonb_array_length(stage->'models')*jsonb_array_length(stage->'task_ids')
    or exists(select 1 from jsonb_array_elements(stage->'scores') score
      where not aiq_private.has_exact_jsonb_keys(score,array['efficiency','model','score']::text[])
        or aiq_private.calibration_model_is_valid(score->'model') is not true
        or score->'model' is distinct from score#>'{score,model}'
        or score->'model' is distinct from score#>'{efficiency,model}'
        or score#>>'{efficiency,selected_tasks}' is distinct from
          jsonb_array_length(stage->'task_ids')::text
        or aiq_private.efficiency_aggregate_v1_is_valid(score->'efficiency') is not true
        or aiq_private.efficiency_aggregate_matches_results(
          score->'efficiency',stage->'result_efficiency'
        ) is not true)
    or (select count(distinct score->'model') from jsonb_array_elements(stage->'scores') score)
      <>jsonb_array_length(stage->'models')
    or exists(select 1 from jsonb_array_elements(stage->'scores') score
      where not ((stage->'models') @> jsonb_build_array(score->'model')))
    or exists(select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
      where aiq_private.result_efficiency_v1_is_valid(evidence) is not true
        or not ((stage->'models') @> jsonb_build_array(evidence->'model'))
        or not ((stage->'task_ids') @> jsonb_build_array(evidence->'task_id')))
    or (select count(distinct (evidence->'model',evidence->>'task_id'))
      from jsonb_array_elements(stage->'result_efficiency') evidence)
      <>jsonb_array_length(stage->'result_efficiency')
    or not aiq_private.dto_uint_is_valid(stage -> 'scheduled_unix_ms',9007199254740991)
    or not aiq_private.dto_uint_is_valid(stage -> 'started_unix_ms',9007199254740991)
    or not aiq_private.dto_uint_is_valid(stage -> 'finished_unix_ms',9007199254740991)
    or not aiq_private.dto_uint_is_valid(stage -> 'execution_concurrency',32)
    or (stage->>'execution_concurrency')::integer not between 1 and 32
  then raise exception 'invalid calibration verification stage' using errcode = '22023'; end if;
  expected_stage_digest := aiq_private.jcs_sha256(
    stage - 'stage_digest'
  );
  if stage ->> 'stage_digest' is distinct from expected_stage_digest
    or stage ->> 'task_selection_digest' is distinct from aiq_private.jcs_sha256(stage -> 'task_ids')
    or stage ->> 'model_selection_digest' is distinct from aiq_private.jcs_sha256(stage -> 'models')
    or stage ->> 'score_reports_digest' is distinct from aiq_private.jcs_sha256(stage -> 'scores')
    or stage ->> 'telemetry_digest' is distinct from aiq_private.jcs_sha256(stage -> 'result_efficiency')
  then raise exception 'calibration stage digest binding is invalid' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.calibration:'||(stage->>'run_id'),
    71783153620529
  ));
  select * into claimed from aiq_private.aiq_submission_inbox inbox
  where inbox.inbox_id=target_inbox_id for update;
  if claimed.inbox_id is null
    or claimed.idempotency_key is distinct from stage->>'run_id'
    or claimed.package_sha256 is distinct from stage->>'package_sha256'
    or claimed.claim_token is distinct from supplied_lease_token
    or claimed.claim_attempts is distinct from supplied_attempt
  then raise exception 'calibration stage claim identity is absent or superseded'
    using errcode='55000'; end if;
  select * into existing_stage
  from aiq_private.calibration_verification_stages saved
  where saved.run_id=$1->>'run_id'
  for update;
  if existing_stage.run_id is not null then
    if existing_stage.stage=$1
      and existing_stage.inbox_id=target_inbox_id
      and existing_stage.package_sha256=stage->>'package_sha256'
    then return 'duplicate'; end if;
    raise exception 'conflicting calibration stage' using errcode='23505';
  end if;
  claimed := aiq_private.require_verification_claim(
    target_inbox_id,supplied_lease_token,supplied_attempt,
    stage->>'run_id',stage->>'package_sha256',null
  );
  if aiq_private.calibration_package_v3_is_valid(claimed.envelope) is not true
  then raise exception 'claim is not an admitted calibration package' using errcode='22023'; end if;
  payload := claimed.envelope -> 'payload';
  if stage ->> 'content_hash' is distinct from claimed.envelope ->> 'content_hash'
    or stage -> 'runner' is distinct from claimed.envelope -> 'signer'
    or stage ->> 'task_set_hash' is distinct from payload ->> 'task_set_hash'
    or stage -> 'task_ids' is distinct from payload -> 'task_ids'
    or stage -> 'models' is distinct from payload -> 'models'
    or stage -> 'provenance' is distinct from payload -> 'provenance'
    or stage -> 'execution_concurrency' is distinct from payload -> 'execution_concurrency'
    or stage -> 'evaluator_results_artifact' is distinct from payload -> 'evaluator_results_artifact'
    or stage ->> 'scoring_version' is distinct from payload ->> 'scoring_version'
    or stage ->> 'started_unix_ms' is distinct from payload ->> 'started_unix_ms'
    or stage ->> 'finished_unix_ms' is distinct from payload ->> 'finished_unix_ms'
    or stage ->> 'capability_validation_digest' is distinct from aiq_private.jcs_sha256(payload -> 'capability_validation')
    or not exists(select 1 from aiq_private.aiq_task_sets task_set
      where task_set.task_set_id=stage->>'task_set_id'
        and task_set.task_set_version=stage->>'task_set_version'
        and task_set.task_count=72 and task_set.domain_count=10
        and not coalesce((task_set.metadata->>'synthetic')::boolean,true))
    or aiq_private.task_catalog_is_exact(
      stage->>'task_set_id',stage->>'task_set_version'
    ) is not true
    or (select count(*)
      from aiq_private.aiq_task_catalog catalog
      join jsonb_array_elements_text(stage->'task_ids') selected(task_id)
        on selected.task_id=catalog.task_id
      where catalog.task_set_id=stage->>'task_set_id'
        and catalog.task_set_version=stage->>'task_set_version'
        and catalog.fixture_commitment is not null)<>
      jsonb_array_length(stage->'task_ids')
    or stage->>'task_set_hash' is distinct from (
      select aiq_private.jcs_sha256(jsonb_agg(task_hash order by task_hash collate "C"))
      from (
        select distinct 'sha256:'||catalog.fixture_commitment as task_hash
        from aiq_private.aiq_task_catalog catalog
        join jsonb_array_elements_text(stage->'task_ids') selected(task_id)
          on selected.task_id=catalog.task_id
        where catalog.task_set_id=stage->>'task_set_id'
          and catalog.task_set_version=stage->>'task_set_version'
      ) selected_hashes
    )
    or exists(select 1 from jsonb_array_elements(payload->'results') source
      where not exists(select 1 from aiq_private.aiq_task_catalog catalog
        where catalog.task_set_id=stage->>'task_set_id'
          and catalog.task_set_version=stage->>'task_set_version'
          and catalog.task_id=source->>'task_id'
          and catalog.task_version=source->>'task_version'
          and catalog.fixture_commitment is not null
          and source->>'task_hash'='sha256:'||catalog.fixture_commitment))
    or exists(select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
      where not exists(select 1 from jsonb_array_elements(payload->'results') source
        where source->>'result_id'=evidence->>'source_result_id'
          and source->>'task_id'=evidence->>'task_id'
          and source->'model'=evidence->'model'))
    or exists(
      select 1
      from jsonb_array_elements(stage->'result_efficiency') evidence
      join jsonb_array_elements(payload->'results') source
        on source->>'result_id'=evidence->>'source_result_id'
        and source->>'task_id'=evidence->>'task_id'
        and source->'model'=evidence->'model'
      where source#>>'{failure,kind}' in (
        'capability_unavailable','capability_validation_failed','workspace_unavailable'
      ) and (
        evidence->'observed_wall_ms'<>'null'::jsonb
        or evidence->'provider_tokens'<>'{}'::jsonb
        or evidence->>'cost_status'<>'unavailable_missing_usage'
      )
    )
  then raise exception 'calibration stage does not bind admitted package' using errcode='22023'; end if;
  insert into aiq_private.calibration_verification_stages(
    run_id,inbox_id,package_sha256,stage_digest,runner_node_id,stage
  ) values(stage->>'run_id',target_inbox_id,stage->>'package_sha256',stage->>'stage_digest',
    stage#>>'{runner,node_id}',$1);
  return 'recorded';
end;
$$;

create function public.aiq_record_calibration_attestation(
  attestation jsonb,target_inbox_id uuid,supplied_lease_token uuid,supplied_attempt integer
) returns text
    language plpgsql security definer
    SET search_path to ''
    as $$
declare
  saved aiq_private.calibration_verification_stages%rowtype;
  existing_run aiq_private.calibration_runs%rowtype;
  claimed aiq_private.aiq_submission_inbox%rowtype;
  payload jsonb;
  stage jsonb;
  verifier_node_id text;
  score jsonb;
  score_report jsonb;
  score_efficiency jsonb;
  result jsonb;
  source_result jsonb;
  result_score_tier text;
  normalized_outcome text;
  provider_tokens jsonb;
  pricing jsonb;
  computed_pricing_digest text;
  attempted_count integer;
  invoked_count integer;
  inserted_rows integer;
  stored_result_count integer;
  duration_count integer;
  duration_total bigint;
  duration_median bigint;
  duration_p95 bigint;
begin
  perform aiq_private.require_request_role('aiq_verifier');
  if jsonb_typeof(attestation) <> 'object'
    or not aiq_private.has_exact_jsonb_keys(attestation,array[
      'capability_validation_digest','classification','content_hash','execution_concurrency',
      'model_selection_digest','observed_unix_ms','official_eligible','package_sha256','ranking_eligible',
      'replay_status','run_class','run_id','runner','schema_version','score_reports_digest',
      'scoring_version','signature','signature_algorithm','signature_version','stage_digest',
      'task_selection_digest','task_set_hash','telemetry_digest','trust','verifier'
    ]::text[])
    or attestation ->> 'schema_version' <> 'aiq.calibration-verifier-attestation.v1'
    or attestation ->> 'signature_algorithm' <> 'ed25519'
    or attestation ->> 'signature_version' <> 'aiq.ed25519-jcs.v1'
    or attestation ->> 'classification' <> 'local_calibration_non_official'
    or attestation ->> 'run_class' <> 'calibration'
    or attestation ->> 'trust' <> 'untrusted'
    or not coalesce(attestation->>'run_id'~'^run_[0-9a-f]{64}$',false)
    or not coalesce(attestation->>'package_sha256'~'^[0-9a-f]{64}$',false)
    or attestation -> 'official_eligible' <> 'false'::jsonb
    or attestation -> 'ranking_eligible' <> 'false'::jsonb
    or attestation ->> 'replay_status' <> 'evaluator_replayed'
    or not aiq_private.dto_uint_is_valid(attestation -> 'observed_unix_ms',9007199254740991)
    or attestation ->> 'signature' !~ '^[0-9a-f]{128}$'
    or attestation ->> 'signature' = repeat('0',128)
    or jsonb_typeof(attestation -> 'runner') <> 'object'
    or jsonb_typeof(attestation -> 'verifier') <> 'object'
    or not aiq_private.has_exact_jsonb_keys(attestation -> 'runner',array['node_id','public_key']::text[])
    or not aiq_private.has_exact_jsonb_keys(attestation -> 'verifier',array['node_id','public_key']::text[])
    or aiq_private.node_public_key_matches_id(
      attestation#>>'{verifier,node_id}',attestation#>>'{verifier,public_key}'
    ) is not true
  then raise exception 'invalid calibration verifier attestation' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.calibration:'||(attestation->>'run_id'),
    71783153620529
  ));
  select * into claimed from aiq_private.aiq_submission_inbox inbox
  where inbox.inbox_id=target_inbox_id for update;
  if claimed.inbox_id is null
    or claimed.idempotency_key is distinct from attestation->>'run_id'
    or claimed.package_sha256 is distinct from attestation->>'package_sha256'
    or claimed.claim_token is distinct from supplied_lease_token
    or claimed.claim_attempts is distinct from supplied_attempt
  then raise exception 'calibration attestation claim identity is absent or superseded'
    using errcode='55000'; end if;
  select * into saved from aiq_private.calibration_verification_stages candidate
  where candidate.run_id=attestation->>'run_id'
    and candidate.package_sha256=attestation->>'package_sha256'
  for update;
  if saved.run_id is null then raise exception 'calibration stage is absent' using errcode='55000'; end if;
  stage := saved.stage;
  select * into existing_run from aiq_private.calibration_runs run
  where run.run_id=saved.run_id for update;
  if existing_run.run_id is not null then
    if existing_run.verifier_attestation=attestation
      and existing_run.inbox_id=target_inbox_id
      and existing_run.package_sha256=attestation->>'package_sha256'
    then
      perform aiq_private.reconcile_publication_storage_evidence(
        'calibration',saved.run_id,saved.package_sha256,target_inbox_id
      );
      return 'duplicate';
    end if;
    raise exception 'conflicting calibration attestation' using errcode='23505';
  end if;
  if attestation ->> 'run_id' is distinct from stage ->> 'run_id'
    or attestation ->> 'package_sha256' is distinct from stage ->> 'package_sha256'
    or attestation ->> 'content_hash' is distinct from stage ->> 'content_hash'
    or attestation ->> 'stage_digest' is distinct from stage ->> 'stage_digest'
    or attestation -> 'runner' is distinct from stage -> 'runner'
    or attestation ->> 'classification' is distinct from stage ->> 'classification'
    or attestation ->> 'run_class' is distinct from stage ->> 'run_class'
    or attestation -> 'official_eligible' is distinct from stage -> 'official_eligible'
    or attestation -> 'ranking_eligible' is distinct from stage -> 'ranking_eligible'
    or attestation ->> 'trust' is distinct from stage ->> 'trust'
    or attestation ->> 'task_set_hash' is distinct from stage ->> 'task_set_hash'
    or attestation ->> 'task_selection_digest' is distinct from stage ->> 'task_selection_digest'
    or attestation ->> 'model_selection_digest' is distinct from stage ->> 'model_selection_digest'
    or attestation ->> 'score_reports_digest' is distinct from stage ->> 'score_reports_digest'
    or attestation ->> 'telemetry_digest' is distinct from stage ->> 'telemetry_digest'
    or attestation ->> 'capability_validation_digest' is distinct from stage ->> 'capability_validation_digest'
    or attestation ->> 'scoring_version' is distinct from stage ->> 'scoring_version'
    or attestation -> 'execution_concurrency' is distinct from stage -> 'execution_concurrency'
  then raise exception 'calibration attestation does not bind stage' using errcode='22023'; end if;
  verifier_node_id := attestation#>>'{verifier,node_id}';
  if aiq_private.production_execution_identities_are_authorized(saved.runner_node_id,verifier_node_id) is not true
  then raise exception 'calibration verifier identity is not authorized or distinct' using errcode='42501'; end if;
  claimed := aiq_private.require_verification_claim(
    target_inbox_id,supplied_lease_token,supplied_attempt,saved.run_id,saved.package_sha256,null
  );
  if saved.inbox_id <> target_inbox_id then raise exception 'calibration claim differs from stage' using errcode='55000'; end if;
  payload := claimed.envelope -> 'payload';
  pricing := stage -> 'pricing';
  if aiq_private.efficiency_pricing_v1_is_valid(pricing) is not true
  then raise exception 'invalid calibration pricing evidence' using errcode='22023'; end if;
  computed_pricing_digest := aiq_private.jcs_sha256(pricing);
  insert into aiq_private.efficiency_pricing_methods(
    pricing_digest,method,version,as_of,source,currency,processing_tier,
    rates,formula,limitations,pricing_record
  ) values(computed_pricing_digest,pricing->>'method',pricing->>'version',(pricing->>'as_of')::date,
    pricing->>'source',pricing->>'currency',pricing->>'processing_tier',
    pricing->'rates',pricing->>'formula',
    array[pricing->>'limitation'],pricing)
  on conflict on constraint efficiency_pricing_methods_pkey do nothing;
  if not exists(select 1 from aiq_private.efficiency_pricing_methods method
    where method.pricing_digest=computed_pricing_digest and method.pricing_record=pricing)
  then raise exception 'conflicting calibration pricing evidence' using errcode='23505'; end if;
  select count(*)::integer into attempted_count
  from jsonb_array_elements(payload->'results') source
  where coalesce(source#>>'{failure,kind}','') not in (
    'capability_unavailable','capability_validation_failed'
  );
  select count(*)::integer into invoked_count
  from jsonb_array_elements(payload->'results') source
  where coalesce(source#>>'{failure,kind}','') not in (
    'capability_unavailable','capability_validation_failed','workspace_unavailable'
  );
  with observed as (
    select (efficiency.value->>'observed_wall_ms')::numeric as wall_ms
    from jsonb_array_elements(stage -> 'result_efficiency') efficiency(value)
    where efficiency.value -> 'observed_wall_ms' <> 'null'::jsonb
      and not exists(
        select 1 from jsonb_array_elements(payload -> 'results') source
        where source ->> 'result_id'=efficiency.value ->> 'source_result_id'
          and source #>> '{failure,kind}' in (
            'capability_unavailable','capability_validation_failed','workspace_unavailable'
          )
      )
  ), duration_aggregate as (
    select count(*)::integer as sample_count,
      sum(wall_ms) as total_ms,
      array_agg(wall_ms order by wall_ms) as ordered_ms
    from observed
  )
  select sample_count,
    case when total_ms<=9007199254740991 then total_ms::bigint end,
    case when sample_count=0 then null
      when sample_count%2=0 then trunc(
        (ordered_ms[sample_count/2]+ordered_ms[sample_count/2+1])/2
      )::bigint
      else ordered_ms[(sample_count+1)/2]::bigint end,
    case when sample_count=0 then null
      else ordered_ms[(sample_count*95+99)/100]::bigint end
  into duration_count,duration_total,duration_median,duration_p95
  from duration_aggregate;
  if duration_count>0 and duration_total is null then
    raise exception 'calibration duration total exceeds the safe integer range'
      using errcode='22023';
  end if;
  insert into aiq_private.calibration_runs(
    run_id,inbox_id,package_sha256,content_hash,normalization_digest,runner_node_id,
    verifier_node_id,task_set_id,task_set_version,task_set_hash,scoring_version,
    replay_status,selected_task_count,
    selected_model_count,result_count,execution_concurrency,
    attempted_result_count,invoked_result_count,
    observed_duration_total_ms,observed_duration_median_ms,
    observed_duration_p95_ms,duration_evidence_level,duration_coverage_count,started_at,completed_at,
    standard_api_equivalent_usd_nanos,estimated_cost_coverage_count,token_usage_coverage_count,
    cost_estimator_status,cost_evidence_level,cost_estimator_limitations,cost_method,
    cost_version,cost_as_of,cost_source,verification_record,verifier_attestation,pricing_digest
  ) values(
    saved.run_id,saved.inbox_id,saved.package_sha256,stage->>'content_hash',saved.stage_digest,
    saved.runner_node_id,verifier_node_id,stage->>'task_set_id',stage->>'task_set_version',
    stage->>'task_set_hash',stage->>'scoring_version',
    'evaluator_replayed',jsonb_array_length(stage->'task_ids'),jsonb_array_length(stage->'models'),
    jsonb_array_length(payload->'results'),(stage->>'execution_concurrency')::integer,
    attempted_count,invoked_count,
    duration_total,duration_median,duration_p95,
    case when duration_count=0 then null else 'runner_observed' end,duration_count,
    to_timestamp((stage->>'started_unix_ms')::numeric/1000),
    to_timestamp((stage->>'finished_unix_ms')::numeric/1000),
    (select case when count(*)=count(value->>'standard_api_equivalent_usd_nanos')
        and sum((value->>'standard_api_equivalent_usd_nanos')::numeric)
          <= 9007199254740991
      then sum((value->>'standard_api_equivalent_usd_nanos')::numeric)::bigint end
      from jsonb_array_elements(stage->'result_efficiency')),
    (select count(*)::integer from jsonb_array_elements(stage->'result_efficiency')
      where value->'standard_api_equivalent_usd_nanos'<>'null'::jsonb),
    (select count(*)::integer from jsonb_array_elements(stage->'result_efficiency')
      where value->'provider_tokens'<>'{}'::jsonb),
    case when not exists(select 1 from jsonb_array_elements(stage->'result_efficiency') value
      where value->>'cost_status'<>'estimated')
      and (select sum((value->>'standard_api_equivalent_usd_nanos')::numeric)
        from jsonb_array_elements(stage->'result_efficiency')) <= 9007199254740991
      then 'estimated'
      when not exists(select 1 from jsonb_array_elements(stage->'result_efficiency') value
        where value->>'cost_status'<>'estimated') then 'unavailable_invalid_usage'
      when exists(select 1 from jsonb_array_elements(stage->'result_efficiency') value
      where value->>'cost_status'='unavailable_invalid_usage') then 'unavailable_invalid_usage'
      when exists(select 1 from jsonb_array_elements(stage->'result_efficiency') value
      where value->>'cost_status'='unavailable_context_band') then 'unavailable_context_band'
      else 'unavailable_missing_usage' end,
    case when not exists(select 1 from jsonb_array_elements(stage->'result_efficiency') value
      where value->>'cost_status'<>'estimated')
      and (select sum((value->>'standard_api_equivalent_usd_nanos')::numeric)
        from jsonb_array_elements(stage->'result_efficiency')) <= 9007199254740991
      then 'verifier_recomputed' end,
    array[pricing->>'limitation'],pricing->>'method',pricing->>'version',
    (pricing->>'as_of')::date,pricing->>'source',stage,attestation,computed_pricing_digest
  );
  for score in select value from jsonb_array_elements(stage -> 'scores') loop
    if jsonb_typeof(score) <> 'object'
      or not aiq_private.has_exact_jsonb_keys(score,array['efficiency','model','score']::text[])
      or aiq_private.calibration_model_is_valid(score->'model') is not true
      or score->'model' is distinct from score#>'{score,model}'
      or score->'model' is distinct from score#>'{efficiency,model}'
    then raise exception 'invalid calibration verified score wrapper' using errcode='22023'; end if;
    score_report := score -> 'score';
    score_efficiency := score -> 'efficiency';
    if jsonb_typeof(score_report) <> 'object'
      or not aiq_private.has_exact_jsonb_keys(score_report,array[
        'binary_micro_diagnostic','completion_bounds','conditional_observed_aiq','coverage',
        'descriptive_status','difficulty_coverage','domains','duplicate_results','fixed_fixture_aiq',
        'model','official_eligible','ranking_eligible','rule','run_class','schema_version',
        'scoring_version','task_resampling_sensitivity_interval'
      ]::text[])
      or score_report->>'schema_version' <> 'aiq.calibration-score-report.v1'
      or score_report->>'run_class' <> 'calibration'
      or score_report->'official_eligible' <> 'false'::jsonb
      or score_report->'ranking_eligible' <> 'false'::jsonb
      or score_report->>'scoring_version' is distinct from stage->>'scoring_version'
      or score_report->>'descriptive_status' not in ('complete_fixture','conditional_observed','coverage_only','not_applicable')
      or score_report#>>'{coverage,expected_tasks}' is distinct from
        jsonb_array_length(stage->'task_ids')::text
      or score_efficiency->>'selected_tasks' is distinct from
        jsonb_array_length(stage->'task_ids')::text
      or not aiq_private.has_exact_jsonb_keys(score_efficiency,array[
        'estimated_cost_tasks','median_observed_wall_ms','model','observed_wall_tasks',
        'p95_observed_wall_ms','provider_token_coverage',
        'provider_token_totals','schema_version','selected_tasks',
        'standard_api_equivalent_usd_nanos','total_observed_wall_ms'
      ]::text[])
      or score_efficiency->>'schema_version'<>'aiq.calibration-efficiency.v1'
      or jsonb_typeof(score_efficiency->'provider_token_totals')<>'object'
      or (select count(*) from jsonb_object_keys(score_efficiency->'provider_token_totals'))>6
      or exists(select 1 from jsonb_each(score_efficiency->'provider_token_totals') token
        where token.key not in ('input','cached_input','cache_write_input','output','reasoning','total')
          or not aiq_private.dto_uint_is_valid(token.value,9007199254740991))
      or not aiq_private.has_exact_jsonb_keys(score_efficiency->'provider_token_coverage',array[
        'cached_input_tasks','cache_write_input_tasks','input_tasks','output_tasks',
        'reasoning_tasks','selected_tasks','total_tasks'
      ]::text[])
      or exists(select 1 from jsonb_each(score_efficiency->'provider_token_coverage') coverage
        where not aiq_private.dto_uint_is_valid(coverage.value,1224))
      or score_efficiency#>>'{provider_token_coverage,selected_tasks}'
        is distinct from score_efficiency->>'selected_tasks'
    then raise exception 'invalid calibration score report' using errcode='22023'; end if;
    insert into aiq_private.calibration_model_scores(
      run_id,model_family,reasoning_effort,descriptive_status,score,
      task_resampling_sensitivity_lower,task_resampling_sensitivity_upper,
      task_resampling_sensitivity_method,result_count,
      scored_result_count,coverage_percent,observed_total_wall_ms,
      observed_median_wall_ms,observed_p95_wall_ms,observed_time_sample_count,
      attempted_result_count,invoked_result_count,
      observed_time_coverage_percent,duration_evidence_level,
      standard_api_equivalent_usd_nanos,
      estimated_cost_sample_count,input_tokens,cached_input_tokens,cache_write_input_tokens,
      output_tokens,reasoning_output_tokens,total_tokens,token_usage_sample_count,
      token_usage_coverage_percent,
      cost_estimator_status,cost_evidence_level,
      cost_estimator_limitations,pricing_source,pricing_as_of,pricing_version,pricing_digest
    ) select saved.run_id,score#>>'{model,family}',score#>>'{model,reasoning_effort}',
      score_report->>'descriptive_status',coalesce(
        (score_report->>'fixed_fixture_aiq')::numeric,
        (score_report->>'conditional_observed_aiq')::numeric
      ),(score_report#>>'{task_resampling_sensitivity_interval,lower}')::numeric,
      (score_report#>>'{task_resampling_sensitivity_interval,upper}')::numeric,
      score_report#>>'{task_resampling_sensitivity_interval,method}',
      (score_report#>>'{coverage,expected_tasks}')::integer,
      (score_report#>>'{coverage,valid_tasks}')::integer,
      round(100*(score_report#>>'{coverage,valid_tasks}')::numeric/
        nullif((score_report#>>'{coverage,expected_tasks}')::numeric,0),4),
      (score_efficiency->>'total_observed_wall_ms')::bigint,
      (score_efficiency->>'median_observed_wall_ms')::bigint,
      (score_efficiency->>'p95_observed_wall_ms')::bigint,
      (score_efficiency->>'observed_wall_tasks')::integer,
      (select count(*)::integer from jsonb_array_elements(payload->'results') source
        where source->'model'=score->'model'
          and coalesce(source#>>'{failure,kind}','') not in (
            'capability_unavailable','capability_validation_failed'
          )),
      (select count(*)::integer from jsonb_array_elements(payload->'results') source
        where source->'model'=score->'model'
          and coalesce(source#>>'{failure,kind}','') not in (
            'capability_unavailable','capability_validation_failed','workspace_unavailable'
          )),
      round(100*(score_efficiency->>'observed_wall_tasks')::numeric/
        nullif((score_efficiency->>'selected_tasks')::numeric,0),4),
      case when (score_efficiency->>'observed_wall_tasks')::integer=0 then null else 'runner_observed' end,
      case when (score_efficiency->>'estimated_cost_tasks')::integer=
        (score_efficiency->>'selected_tasks')::integer
        and score_efficiency->'standard_api_equivalent_usd_nanos'<>'null'::jsonb
        then (score_efficiency->>'standard_api_equivalent_usd_nanos')::bigint end,
      (score_efficiency->>'estimated_cost_tasks')::integer,
      (score_efficiency#>>'{provider_token_totals,input}')::bigint,
      (score_efficiency#>>'{provider_token_totals,cached_input}')::bigint,
      (score_efficiency#>>'{provider_token_totals,cache_write_input}')::bigint,
      (score_efficiency#>>'{provider_token_totals,output}')::bigint,
      (score_efficiency#>>'{provider_token_totals,reasoning}')::bigint,
      (score_efficiency#>>'{provider_token_totals,total}')::bigint,
      (select count(*)::integer from jsonb_array_elements(stage->'result_efficiency') evidence
        where evidence->'model'=score->'model' and evidence->'provider_tokens'<>'{}'::jsonb),
      round(100*(select count(*) from jsonb_array_elements(stage->'result_efficiency') evidence
        where evidence->'model'=score->'model' and evidence->'provider_tokens'<>'{}'::jsonb)::numeric/
        nullif((score_efficiency->>'selected_tasks')::numeric,0),4),
      case when (score_efficiency->>'estimated_cost_tasks')::integer=
        (score_efficiency->>'selected_tasks')::integer
        and score_efficiency->'standard_api_equivalent_usd_nanos'<>'null'::jsonb then 'estimated'
        when (score_efficiency->>'estimated_cost_tasks')::integer=
          (score_efficiency->>'selected_tasks')::integer then 'unavailable_invalid_usage'
        when exists(
          select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
          where evidence->'model'=score->'model'
            and evidence->>'cost_status'='unavailable_invalid_usage'
        ) then 'unavailable_invalid_usage'
        when exists(
          select 1 from jsonb_array_elements(stage->'result_efficiency') evidence
          where evidence->'model'=score->'model'
            and evidence->>'cost_status'='unavailable_context_band'
        ) then 'unavailable_context_band'
        else 'unavailable_missing_usage' end,
      case when score_efficiency->'standard_api_equivalent_usd_nanos'<>'null'::jsonb
        then 'verifier_recomputed' end,
      array[pricing->>'limitation'],pricing->>'source',
      (pricing->>'as_of')::date,pricing->>'version',computed_pricing_digest;
  end loop;
  for result in select value from jsonb_array_elements(stage -> 'result_efficiency') loop
    if not aiq_private.has_exact_jsonb_keys(result,array[
      'cost_evidence_level','cost_status','model','observed_wall_ms',
      'provider_tokens','provider_tokens_evidence_level',
      'provider_tokens_source','source_result_id','standard_api_equivalent_usd_nanos',
      'task_id','wall_time_evidence_level'
    ]::text[])
      or jsonb_typeof(result->'provider_tokens')<>'object'
      or (select count(*) from jsonb_object_keys(result->'provider_tokens'))>6
      or exists(select 1 from jsonb_each(result->'provider_tokens') token
        where token.key not in ('input','cached_input','cache_write_input','output','reasoning','total')
          or not aiq_private.dto_uint_is_valid(token.value,9007199254740991))
      or result->>'wall_time_evidence_level'<>'runner_observed'
      or result->>'provider_tokens_source'<>'provider_reported'
      or result->>'provider_tokens_evidence_level'<>'verifier_recomputed'
      or result->>'cost_evidence_level'<>'verifier_recomputed'
      or result->>'cost_status' not in (
        'estimated','unavailable_missing_usage','unavailable_invalid_usage',
        'unavailable_context_band'
      )
      or (result->>'cost_status'='estimated') is distinct from
        (result->'standard_api_equivalent_usd_nanos'<>'null'::jsonb)
      or (result->'provider_tokens'='{}'::jsonb) is distinct from
        (result->'provider_tokens_source'='null'::jsonb)
      or (result->'provider_tokens'='{}'::jsonb) is distinct from
        (result->'provider_tokens_evidence_level'='null'::jsonb)
      or (result->'observed_wall_ms'='null'::jsonb) is distinct from
        (result->'wall_time_evidence_level'='null'::jsonb)
      or (result->'standard_api_equivalent_usd_nanos'='null'::jsonb) is distinct from
        (result->'cost_evidence_level'='null'::jsonb)
    then raise exception 'invalid calibration result efficiency' using errcode='22023'; end if;
    select value into source_result from jsonb_array_elements(payload->'results') source
    where source->>'result_id'=result->>'source_result_id'
      and source->>'task_id'=result->>'task_id' and source->'model'=result->'model';
    if source_result is null then raise exception 'calibration efficiency source result is absent' using errcode='22023'; end if;
    select score_entry.value#>>'{score,descriptive_status}' into result_score_tier
    from jsonb_array_elements(stage->'scores') score_entry(value)
    where score_entry.value->'model'=result->'model';
    normalized_outcome:=aiq_private.normalized_outcome_from_source(
      source_result,result_score_tier
    );
    if result_score_tier is null or normalized_outcome is null then
      raise exception 'calibration result outcome is not normalized from its score tier'
        using errcode='22023';
    end if;
    provider_tokens := result -> 'provider_tokens';
    insert into aiq_private.calibration_task_results(
      result_id,run_id,task_set_id,task_set_version,task_id,task_version,task_hash,domain,
      model_family,reasoning_effort,
      outcome,task_score,failure_code,latency_ms,latency_evidence_level,input_tokens,
      cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,
      total_tokens,token_usage_source_level,token_usage_evidence_level,
      standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level,
      cost_estimator_limitations,cost_method,cost_version,cost_as_of,cost_source,pricing_digest
    ) select source_result->>'result_id',saved.run_id,stage->>'task_set_id',
      stage->>'task_set_version',source_result->>'task_id',
      source_result->>'task_version',source_result->>'task_hash',catalog.domain,
      result#>>'{model,family}',
      result#>>'{model,reasoning_effort}',
      normalized_outcome::aiq_private.result_outcome,
      (source_result->>'task_score')::numeric,source_result#>>'{failure,kind}',
      case when source_result #>> '{failure,kind}' in (
        'capability_unavailable','capability_validation_failed','workspace_unavailable'
      ) then null else (result->>'observed_wall_ms')::bigint end,
      case when result->'observed_wall_ms'='null'::jsonb
        or source_result #>> '{failure,kind}' in (
          'capability_unavailable','capability_validation_failed','workspace_unavailable'
        ) then null else 'runner_observed' end,
      (provider_tokens->>'input')::bigint,(provider_tokens->>'cached_input')::bigint,
      (provider_tokens->>'cache_write_input')::bigint,(provider_tokens->>'output')::bigint,
      (provider_tokens->>'reasoning')::bigint,(provider_tokens->>'total')::bigint,
      result->>'provider_tokens_source',result->>'provider_tokens_evidence_level',
      (result->>'standard_api_equivalent_usd_nanos')::bigint,
      result->>'cost_status',result->>'cost_evidence_level',array[pricing->>'limitation'],
      pricing->>'method',pricing->>'version',(pricing->>'as_of')::date,
      pricing->>'source',computed_pricing_digest
    from aiq_private.aiq_task_catalog catalog
    where catalog.task_set_id=stage->>'task_set_id'
      and catalog.task_set_version=stage->>'task_set_version'
      and catalog.task_id=source_result->>'task_id'
      and catalog.task_version=source_result->>'task_version'
      and catalog.fixture_commitment is not null
      and source_result->>'task_hash'='sha256:'||catalog.fixture_commitment;
    get diagnostics inserted_rows=row_count;
    if inserted_rows<>1 then
      raise exception 'calibration result did not bind exactly one catalog task'
        using errcode='23514';
    end if;
  end loop;
  select count(*)::integer into stored_result_count
  from aiq_private.calibration_task_results stored
  where stored.run_id=saved.run_id;
  if stored_result_count<>jsonb_array_length(payload->'results')
    or stored_result_count<>(select run.result_count
      from aiq_private.calibration_runs run where run.run_id=saved.run_id)
  then raise exception 'stored calibration result count differs from verified package'
    using errcode='23514'; end if;
  insert into aiq_private.calibration_verification_audit(
    run_id,inbox_id,package_sha256,event_type,actor_node_id,event_digest
  ) values(saved.run_id,saved.inbox_id,saved.package_sha256,'verifier_recorded',verifier_node_id,
    aiq_private.jcs_sha256(jsonb_build_array(stage,attestation)));
  perform aiq_private.reconcile_publication_storage_evidence(
    'calibration',saved.run_id,saved.package_sha256,target_inbox_id
  );
  return 'recorded';
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid calibration numeric field' using errcode='22023';
end;
$$;

create function public.aiq_publish_calibration_evidence(
  target_run_id text, target_package_sha256 text, target_inbox_id uuid,
  supplied_lease_token uuid, supplied_attempt integer
) returns text
    language plpgsql security definer
    SET search_path to ''
    as $$
declare
  claimed aiq_private.aiq_submission_inbox%rowtype;
  calibration aiq_private.calibration_runs%rowtype;
  publication aiq_private.calibration_publications%rowtype;
  publisher_node_id text;
begin
  perform aiq_private.require_request_role('aiq_publisher');
  if not coalesce(target_run_id~'^run_[0-9a-f]{64}$',false)
    or not coalesce(target_package_sha256~'^[0-9a-f]{64}$',false)
  then raise exception 'invalid calibration publication identity'
    using errcode='22023'; end if;
  publisher_node_id := aiq_private.request_publisher_node_id();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'aiq.calibration:'||target_run_id,
    71783153620529
  ));
  select * into claimed from aiq_private.aiq_submission_inbox inbox
  where inbox.inbox_id=target_inbox_id for update;
  if claimed.inbox_id is null
    or claimed.idempotency_key is distinct from target_run_id
    or claimed.package_sha256 is distinct from target_package_sha256
    or claimed.claim_token is distinct from supplied_lease_token
    or claimed.claim_attempts is distinct from supplied_attempt
  then raise exception 'calibration publication claim identity is absent or superseded'
    using errcode='55000'; end if;
  select * into calibration from aiq_private.calibration_runs run
  where run.run_id = target_run_id and run.package_sha256 = target_package_sha256
  for update;
  if calibration.run_id is null then
    raise exception 'verified calibration evidence is absent' using errcode = '55000';
  end if;
  select * into publication from aiq_private.calibration_publications existing
  where existing.run_id=target_run_id for update;
  if publication.run_id is not null then
    if publication.package_sha256=target_package_sha256
      and publication.publisher_node_id=publisher_node_id
      and calibration.inbox_id=target_inbox_id
    then
      perform aiq_private.reconcile_publication_storage_evidence(
        'calibration',target_run_id,target_package_sha256,target_inbox_id
      );
      return 'duplicate';
    end if;
    raise exception 'conflicting calibration publication' using errcode = '23505';
  end if;
  claimed := aiq_private.require_verification_claim(
    target_inbox_id,supplied_lease_token,supplied_attempt,
    target_run_id,target_package_sha256,null
  );
  if calibration.inbox_id <> target_inbox_id
    or aiq_private.production_publisher_identity_is_authorized(
      publisher_node_id,calibration.runner_node_id,calibration.verifier_node_id
    ) is not true
  then raise exception 'calibration publisher identity or claim is invalid' using errcode = '42501'; end if;
  perform aiq_private.reconcile_publication_storage_evidence(
    'calibration',target_run_id,target_package_sha256,target_inbox_id
  );
  insert into aiq_private.calibration_publications (
    run_id,package_sha256,publisher_node_id
  ) values (target_run_id,target_package_sha256,publisher_node_id);
  insert into aiq_private.calibration_verification_audit (
    run_id,inbox_id,package_sha256,event_type,actor_node_id,event_digest
  ) values (
    target_run_id,target_inbox_id,target_package_sha256,'publisher_published',publisher_node_id,
    aiq_private.jcs_sha256(jsonb_build_object(
      'schema_version','aiq.calibration-publication.v1','run_id',target_run_id,
      'package_sha256',target_package_sha256,'publisher_node_id',publisher_node_id,
      'classification','local_calibration_non_official',
      'official_eligible',false,'ranking_eligible',false
    ))
  );
  update aiq_private.aiq_submission_inbox inbox
  set verification_status = 'verified',state = 'processed',claim_ack = 'completed',
      claim_expires_at = null,expires_at = greatest(inbox.expires_at,clock_timestamp() + interval '1 year')
  where inbox.inbox_id = target_inbox_id
    and inbox.claim_token = supplied_lease_token
    and inbox.claim_attempts = supplied_attempt;
  perform aiq_private.retire_claim_artifact_references(
    target_inbox_id,supplied_lease_token,supplied_attempt,'completed'
  );
  return 'published';
end;
$$;

CREATE VIEW public.public_calibration_runs with (security_invoker=true) as
select run.run_id,
  run.classification,
  run.scoring_version,
  run.selected_task_count,
  run.selected_model_count,
  run.result_count,
  run.attempted_result_count,
  run.invoked_result_count,
  run.duration_coverage_count as adapter_elapsed_observed_result_count,
  run.token_usage_coverage_count as token_observed_result_count,
  run.estimated_cost_coverage_count as priced_result_count,
  run.execution_concurrency,
  run.observed_duration_total_ms,
  run.observed_duration_median_ms,
  run.observed_duration_p95_ms,
  run.duration_evidence_level,
  run.duration_coverage_count,
  run.standard_api_equivalent_usd_nanos,
  run.estimated_cost_coverage_count,
  run.token_usage_coverage_count,
  case when run.token_usage_coverage_count=0 then null else 'provider_reported' end
    as token_usage_source_level,
  case when run.token_usage_coverage_count=0 then null else 'verifier_recomputed' end
    as token_usage_evidence_level,
  run.cost_estimator_status,
  run.cost_evidence_level,
  run.cost_estimator_limitations,
  run.cost_method,
  run.cost_version,
  run.cost_as_of,
  run.cost_source,
  run.pricing_digest,
  pricing.currency as pricing_currency,
  pricing.processing_tier as pricing_processing_tier,
  pricing.rates as pricing_rates,
  pricing.formula as cost_formula,
  run.started_at,
  run.completed_at,
  run.verified_at,
  publication.published_at,
  run.replay_status,
  false as official,
  false as ranking_eligible
from aiq_private.calibration_runs run
join aiq_private.calibration_publications publication using (run_id)
join aiq_private.efficiency_pricing_methods pricing using (pricing_digest)
where not run.official_eligible and not run.ranking_eligible
  and not publication.official_eligible and not publication.ranking_eligible;

CREATE VIEW public.public_model_efficiency with (security_invoker=true) as
select efficiency.run_id,run.matrix_batch_id,model.model_family,model.reasoning_effort,
  floor(extract(epoch from (run.completed_at-run.started_at))*1000)::bigint
    as matrix_batch_elapsed_ms,
  efficiency.observed_total_wall_ms as summed_cell_adapter_elapsed_ms,
  efficiency.observed_median_wall_ms,
  efficiency.observed_p95_wall_ms,
  efficiency.adapter_elapsed_observed_result_count as observed_time_sample_count,
  round(100*efficiency.adapter_elapsed_observed_result_count::numeric/
    efficiency.result_count,4) as observed_time_coverage_percent,
  case when efficiency.adapter_elapsed_observed_result_count=0 then null else 'runner_observed' end
    as duration_evidence_level,
  efficiency.input_tokens,efficiency.cached_input_tokens,
  efficiency.cache_write_input_tokens,efficiency.output_tokens,
  efficiency.reasoning_output_tokens,efficiency.total_tokens,
  efficiency.token_observed_result_count as token_usage_sample_count,
  case when efficiency.token_observed_result_count=0 then null else
    round(100*efficiency.token_observed_result_count::numeric/efficiency.result_count,4) end
    as token_usage_coverage_percent,
  nullif(efficiency.input_token_observed_result_count,0) as input_token_coverage_count,
  case when efficiency.input_token_observed_result_count=0 then null else
    round(100*efficiency.input_token_observed_result_count::numeric/efficiency.result_count,4) end
    as input_token_coverage_percent,
  nullif(efficiency.cached_input_token_observed_result_count,0) as cached_input_token_coverage_count,
  case when efficiency.cached_input_token_observed_result_count=0 then null else
    round(100*efficiency.cached_input_token_observed_result_count::numeric/efficiency.result_count,4)
    end as cached_input_token_coverage_percent,
  nullif(efficiency.cache_write_input_token_observed_result_count,0)
    as cache_write_input_token_coverage_count,
  case when efficiency.cache_write_input_token_observed_result_count=0 then null else
    round(100*efficiency.cache_write_input_token_observed_result_count::numeric/
      efficiency.result_count,4) end as cache_write_input_token_coverage_percent,
  nullif(efficiency.output_token_observed_result_count,0) as output_token_coverage_count,
  case when efficiency.output_token_observed_result_count=0 then null else
    round(100*efficiency.output_token_observed_result_count::numeric/efficiency.result_count,4) end
    as output_token_coverage_percent,
  nullif(efficiency.reasoning_token_observed_result_count,0) as reasoning_token_coverage_count,
  case when efficiency.reasoning_token_observed_result_count=0 then null else
    round(100*efficiency.reasoning_token_observed_result_count::numeric/
      efficiency.result_count,4) end as reasoning_token_coverage_percent,
  nullif(efficiency.total_token_observed_result_count,0) as total_token_coverage_count,
  case when efficiency.total_token_observed_result_count=0 then null else
    round(100*efficiency.total_token_observed_result_count::numeric/efficiency.result_count,4) end
    as total_token_coverage_percent,
  case when efficiency.token_observed_result_count=0 then null else 'provider_reported' end
    as token_usage_source_level,
  case when efficiency.token_observed_result_count=0 then null else 'verifier_recomputed' end
    as token_usage_evidence_level,
  efficiency.result_count,efficiency.priced_result_count as estimated_cost_sample_count,
  efficiency.attempted_result_count,efficiency.invoked_result_count,
  efficiency.adapter_elapsed_observed_result_count,
  efficiency.token_observed_result_count,efficiency.priced_result_count,
  efficiency.standard_api_equivalent_usd_nanos,efficiency.cost_estimator_status,
  efficiency.cost_evidence_level,efficiency.execution_concurrency,
  pricing.method as cost_method,pricing.source as pricing_source,
  pricing.as_of as pricing_as_of,pricing.version as pricing_version,
  efficiency.pricing_digest,
  pricing.currency as pricing_currency,
  pricing.processing_tier as pricing_processing_tier,
  pricing.rates as pricing_rates,pricing.formula as cost_formula,
  pricing.limitations as cost_estimator_limitations
from aiq_private.efficiency_official_models efficiency
join aiq_private.aiq_runs run using(run_id)
join aiq_private.aiq_model_configs model using(model_config_id)
join aiq_private.efficiency_pricing_methods pricing using(pricing_digest)
where run.published and not run.synthetic
  and run.started_at is not null and run.completed_at is not null
  and exists(select 1 from aiq_private.aiq_score_snapshots score
    where score.run_id=run.run_id and score.published and score.score_status='official');

comment on column public.public_model_efficiency.matrix_batch_elapsed_ms is
  'Signed matrix-stage wall-clock elapsed time. All 17 child runs share this value; count it once.';
comment on column public.public_model_efficiency.summed_cell_adapter_elapsed_ms is
  'Sum of retained per-result Codex adapter elapsed times. Concurrent calls can overlap.';

CREATE VIEW public.public_calibration_results with (security_invoker=true) as
select result.result_id,
  result.run_id,
  result.task_id,
  result.task_version,
  result.domain,
  result.model_family,
  result.reasoning_effort,
  result.outcome::text as outcome,
  case
    when result.outcome in ('correct','partial','incorrect') then 'completed'
    when result.outcome in (
      'timeout','budget_exhausted','tool_failure','policy_failure','wrong_artifact'
    ) then 'runtime_issue'
    when result.outcome='invalid' then 'invalid'
    when result.outcome='missing' then 'missing'
    when result.outcome='not_applicable' then 'not_applicable'
  end as execution_status,
  result.task_score,
  result.failure_code,
  result.failure_code as explanation_code,
  case
    when result.outcome='timeout' then 'The task exceeded its time limit.'
    when result.outcome='budget_exhausted' then 'The task exceeded a resource budget.'
    when result.outcome='tool_failure' then 'A permitted execution tool failed.'
    when result.outcome='policy_failure' then 'The result violated a controlled-output policy.'
    when result.outcome='wrong_artifact' then 'The expected artifact was not produced.'
    when result.outcome='invalid' then
      'Benchmark infrastructure invalidated this result; an audited rerun is required.'
    when result.outcome='missing' then 'No task result was available.'
    when result.outcome='not_applicable' then
      'The complete model configuration was unavailable.'
    when result.outcome='incorrect' then 'The evaluator rejected the response.'
    else null
  end as explanation_summary,
  result.latency_ms,
  result.latency_evidence_level,
  result.input_tokens,
  result.cached_input_tokens,
  result.output_tokens,
  result.cache_write_input_tokens,
  result.reasoning_output_tokens,
  result.total_tokens,
  result.token_usage_source_level,
  result.token_usage_evidence_level,
  result.standard_api_equivalent_usd_nanos,
  result.cost_estimator_status,
  result.cost_evidence_level,
  result.cost_estimator_limitations,
  result.cost_method,
  result.cost_version,
  result.cost_as_of,
  result.cost_source,
  result.pricing_digest,
  pricing.currency as pricing_currency,
  pricing.processing_tier as pricing_processing_tier,
  pricing.rates as pricing_rates,
  pricing.formula as cost_formula
from aiq_private.calibration_task_results result
join aiq_private.calibration_publications publication using (run_id)
join aiq_private.efficiency_pricing_methods pricing using (pricing_digest)
where not publication.official_eligible and not publication.ranking_eligible;

CREATE VIEW public.public_calibration_scores with (security_invoker=true) as
select score.run_id,
  score.model_family,
  score.reasoning_effort,
  score.descriptive_status,
  score.score as aiq,
  score.task_resampling_sensitivity_lower,
  score.task_resampling_sensitivity_upper,
  score.task_resampling_sensitivity_method,
  score.result_count,
  score.attempted_result_count,
  score.invoked_result_count,
  score.observed_time_sample_count as adapter_elapsed_observed_result_count,
  score.token_usage_sample_count as token_observed_result_count,
  score.estimated_cost_sample_count as priced_result_count,
  score.scored_result_count as sample_size,
  score.coverage_percent,
  score.observed_total_wall_ms,
  score.observed_median_wall_ms,
  score.observed_p95_wall_ms,
  score.observed_time_sample_count,
  score.observed_time_coverage_percent,
  score.duration_evidence_level,
  score.standard_api_equivalent_usd_nanos,
  score.estimated_cost_sample_count,
  score.input_tokens,
  score.cached_input_tokens,
  score.cache_write_input_tokens,
  score.output_tokens,
  score.reasoning_output_tokens,
  score.total_tokens,
  score.token_usage_sample_count,
  score.token_usage_coverage_percent,
  case when score.token_usage_sample_count=0 then null else 'provider_reported' end
    as token_usage_source_level,
  case when score.token_usage_sample_count=0 then null else 'verifier_recomputed' end
    as token_usage_evidence_level,
  score.cost_estimator_status,
  score.cost_evidence_level,
  score.cost_estimator_limitations,
  score.pricing_source,
  score.pricing_as_of,
  score.pricing_version,
  score.pricing_digest,
  pricing.method as cost_method,
  pricing.currency as pricing_currency,
  pricing.processing_tier as pricing_processing_tier,
  pricing.rates as pricing_rates,
  pricing.formula as cost_formula
from aiq_private.calibration_model_scores score
join aiq_private.calibration_publications publication using (run_id)
join aiq_private.efficiency_pricing_methods pricing using (pricing_digest)
where not publication.official_eligible and not publication.ranking_eligible;

alter table aiq_private.calibration_runs enable row level security;
alter table aiq_private.aiq_publication_storage_evidence enable row level security;
alter table aiq_private.calibration_verification_stages enable row level security;
alter table aiq_private.efficiency_pricing_methods enable row level security;
alter table aiq_private.efficiency_official_models enable row level security;
alter table aiq_private.calibration_model_scores enable row level security;
alter table aiq_private.calibration_task_results enable row level security;
alter table aiq_private.calibration_verification_audit enable row level security;
alter table aiq_private.calibration_publications enable row level security;
ALTER TABLE aiq_private.calibration_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE aiq_private.aiq_publication_storage_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE aiq_private.calibration_verification_stages FORCE ROW LEVEL SECURITY;
ALTER TABLE aiq_private.efficiency_pricing_methods FORCE ROW LEVEL SECURITY;
ALTER TABLE aiq_private.efficiency_official_models FORCE ROW LEVEL SECURITY;
ALTER TABLE aiq_private.calibration_model_scores FORCE ROW LEVEL SECURITY;
ALTER TABLE aiq_private.calibration_task_results FORCE ROW LEVEL SECURITY;
ALTER TABLE aiq_private.calibration_verification_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE aiq_private.calibration_publications FORCE ROW LEVEL SECURITY;

create policy calibration_runs_public_read on aiq_private.calibration_runs
  for select to anon, authenticated using (exists (
    select 1 from aiq_private.calibration_publications publication
    where publication.run_id = calibration_runs.run_id
      and not publication.official_eligible and not publication.ranking_eligible
  ));
create policy calibration_task_results_public_read on aiq_private.calibration_task_results
  for select to anon, authenticated using (exists (
    select 1 from aiq_private.calibration_publications publication
    where publication.run_id = calibration_task_results.run_id
      and not publication.official_eligible and not publication.ranking_eligible
  ));
create policy calibration_model_scores_public_read on aiq_private.calibration_model_scores
  for select to anon, authenticated using (exists (
    select 1 from aiq_private.calibration_publications publication
    where publication.run_id = calibration_model_scores.run_id
      and not publication.official_eligible and not publication.ranking_eligible
  ));
create policy calibration_publications_public_read on aiq_private.calibration_publications
  for select to anon, authenticated using (
    not official_eligible and not ranking_eligible
  );
create policy efficiency_pricing_methods_public_read on aiq_private.efficiency_pricing_methods
  for select to anon, authenticated using (
    exists(select 1 from aiq_private.calibration_runs calibration
      join aiq_private.calibration_publications publication using(run_id)
      where calibration.pricing_digest=efficiency_pricing_methods.pricing_digest)
    or exists(select 1 from aiq_private.aiq_task_results result
      join aiq_private.aiq_runs run using(run_id)
      where result.pricing_digest=efficiency_pricing_methods.pricing_digest
        and run.published and not run.synthetic)
  );
create policy efficiency_official_models_public_read on aiq_private.efficiency_official_models
  for select to anon, authenticated using (
    exists(select 1 from aiq_private.aiq_runs run
      where run.run_id=efficiency_official_models.run_id
        and run.published and not run.synthetic
        and exists(select 1 from aiq_private.aiq_score_snapshots score
          where score.run_id=run.run_id and score.published and score.score_status='official'))
  );

revoke all on function aiq_private.calibration_model_is_valid(jsonb) from PUBLIC;
revoke all on function aiq_private.calibration_package_v3_is_valid(jsonb) from PUBLIC;
revoke all on function aiq_private.reconcile_publication_storage_evidence(text,text,text,uuid)
  from PUBLIC;
revoke all on function aiq_private.efficiency_pricing_v1_is_valid(jsonb) from PUBLIC;
revoke all on function aiq_private.provider_token_usage_is_valid(jsonb) from PUBLIC;
revoke all on function aiq_private.result_efficiency_v1_is_valid(jsonb) from PUBLIC;
revoke all on function aiq_private.efficiency_aggregate_v1_is_valid(jsonb) from PUBLIC;
revoke all on function aiq_private.efficiency_aggregate_matches_results(jsonb,jsonb)
  from PUBLIC;
revoke all on function aiq_private.reject_calibration_evidence_mutation() from PUBLIC;
revoke all on function public.aiq_stage_calibration_verification(jsonb,uuid,uuid,integer)
  from public,anon,authenticated,service_role,aiq_publisher;
grant execute on function public.aiq_stage_calibration_verification(jsonb,uuid,uuid,integer)
  to aiq_verifier;
revoke all on function public.aiq_record_calibration_attestation(jsonb,uuid,uuid,integer)
  from public,anon,authenticated,service_role,aiq_publisher;
grant execute on function public.aiq_record_calibration_attestation(jsonb,uuid,uuid,integer)
  to aiq_verifier;
revoke all on function public.aiq_publish_calibration_evidence(text,text,uuid,uuid,integer)
  from public, anon, authenticated, service_role, aiq_verifier;
grant execute on function public.aiq_publish_calibration_evidence(text,text,uuid,uuid,integer)
  to aiq_publisher;

revoke all on table public.public_calibration_runs, public.public_calibration_results,
  public.public_calibration_scores,public.public_model_efficiency
  from public, anon, authenticated;
grant select on table public.public_calibration_runs to anon, authenticated;
grant select on table public.public_calibration_results to anon, authenticated;
grant select on table public.public_calibration_scores to anon, authenticated;
grant select on table public.public_model_efficiency to anon, authenticated;
grant select(run_id,classification,scoring_version,selected_task_count,selected_model_count,
  result_count,execution_concurrency,attempted_result_count,invoked_result_count,
  observed_duration_total_ms,observed_duration_median_ms,
  observed_duration_p95_ms,duration_evidence_level,duration_coverage_count,
  standard_api_equivalent_usd_nanos,
  estimated_cost_coverage_count,token_usage_coverage_count,cost_estimator_status,cost_evidence_level,
  cost_estimator_limitations,cost_method,cost_version,
  cost_as_of,cost_source,started_at,completed_at,
  verified_at,replay_status,official_eligible,ranking_eligible,pricing_digest)
  on aiq_private.calibration_runs to anon, authenticated;
grant select(run_id,official_eligible,ranking_eligible,published_at)
  on aiq_private.calibration_publications to anon, authenticated;
grant select(result_id,run_id,task_id,task_version,domain,model_family,reasoning_effort,
  outcome,task_score,failure_code,latency_ms,latency_evidence_level,input_tokens,cached_input_tokens,
  cache_write_input_tokens,
  output_tokens,reasoning_output_tokens,total_tokens,token_usage_source_level,
  token_usage_evidence_level,
  standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level,
  cost_estimator_limitations,cost_method,cost_version,
  cost_as_of,cost_source,pricing_digest)
  on aiq_private.calibration_task_results to anon, authenticated;
grant select(run_id,model_family,reasoning_effort,descriptive_status,score,result_count,
  task_resampling_sensitivity_lower,task_resampling_sensitivity_upper,
  task_resampling_sensitivity_method,
  scored_result_count,coverage_percent,observed_total_wall_ms,observed_median_wall_ms,
  observed_p95_wall_ms,observed_time_sample_count,attempted_result_count,invoked_result_count,
  observed_time_coverage_percent,
  duration_evidence_level,
  standard_api_equivalent_usd_nanos,estimated_cost_sample_count,input_tokens,
  cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
  token_usage_sample_count,token_usage_coverage_percent,cost_estimator_status,cost_evidence_level,
  cost_estimator_limitations,
  pricing_source,pricing_as_of,pricing_version,pricing_digest)
  on aiq_private.calibration_model_scores to anon, authenticated;
grant select(latency_evidence_level,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,
  reasoning_output_tokens,total_tokens,token_usage_evidence_level,
  standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level,pricing_digest)
  on aiq_private.aiq_task_results to anon, authenticated;
grant select(pricing_digest,method,version,as_of,source,currency,processing_tier,rates,formula,limitations)
  on aiq_private.efficiency_pricing_methods to anon, authenticated;
grant select(run_id,result_count,attempted_result_count,execution_concurrency,
  invoked_result_count,adapter_elapsed_observed_result_count,observed_total_wall_ms,
  observed_median_wall_ms,observed_p95_wall_ms,input_tokens,cached_input_tokens,
  cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
  token_observed_result_count,input_token_observed_result_count,
  cached_input_token_observed_result_count,cache_write_input_token_observed_result_count,
  output_token_observed_result_count,reasoning_token_observed_result_count,
  total_token_observed_result_count,priced_result_count,standard_api_equivalent_usd_nanos,
  cost_estimator_status,cost_evidence_level,pricing_digest)
  on aiq_private.efficiency_official_models to anon, authenticated;

create index calibration_runs_package_idx on aiq_private.calibration_runs(package_sha256);
create index calibration_runs_pricing_idx on aiq_private.calibration_runs(pricing_digest);
create index aiq_publication_storage_evidence_object_idx
  on aiq_private.aiq_publication_storage_evidence(object_id,content_sha256);
create index aiq_publication_storage_evidence_official_fk_idx
  on aiq_private.aiq_publication_storage_evidence(official_batch_id,package_sha256)
  where official_batch_id is not null;
create index aiq_publication_storage_evidence_calibration_fk_idx
  on aiq_private.aiq_publication_storage_evidence(calibration_run_id,package_sha256)
  where calibration_run_id is not null;
create index efficiency_official_models_pricing_idx
  on aiq_private.efficiency_official_models(pricing_digest);
create index aiq_task_results_pricing_idx
  on aiq_private.aiq_task_results(pricing_digest)
  where pricing_digest is not null;
create index calibration_runs_register_cursor_idx
  on aiq_private.calibration_runs(started_at desc,run_id);
create index calibration_task_results_model_detail_idx
  on aiq_private.calibration_task_results(
    run_id,model_family,reasoning_effort,result_id
  );
create index calibration_runs_task_set_idx
  on aiq_private.calibration_runs(task_set_id,task_set_version);
create index calibration_task_results_catalog_idx
  on aiq_private.calibration_task_results(
    task_set_id,task_set_version,task_id,task_version,task_hash
  );
create index calibration_publications_published_idx on aiq_private.calibration_publications(published_at,run_id);


-- Foreign-key and RLS predicate indexes are explicit because PostgreSQL does
-- not create them automatically.
create index aiq_matrix_batches_task_set_fk_idx
  on aiq_private.aiq_matrix_batches (task_set_id, task_set_version);
create index aiq_matrix_batches_scoring_version_fk_idx
  on aiq_private.aiq_matrix_batches (scoring_version);
create index aiq_matrix_batches_source_scoring_version_fk_idx
  on aiq_private.aiq_matrix_batches (source_scoring_version);
create index aiq_matrix_batches_source_node_fk_idx
  on aiq_private.aiq_matrix_batches (source_node_id);
create index aiq_result_packages_node_fk_idx
  on aiq_private.aiq_result_packages (node_id);
create index aiq_artifact_claim_bindings_object_fk_idx
  on aiq_private.aiq_artifact_claim_bindings (
    artifact_kind, content_sha256
  );
create index aiq_artifact_ingress_claims_object_fk_idx
  on aiq_private.aiq_artifact_ingress_claims (
    artifact_kind, content_sha256
  );
create index aiq_claim_artifact_events_binding_fk_idx
  on aiq_private.aiq_claim_artifact_reference_events (
    inbox_id, artifact_kind, content_sha256
  );
create index aiq_distributed_aggregation_assignment_fk_idx
  on aiq_private.aiq_distributed_aggregation_inputs (
    run_id, assignment_id, lease_attempt, node_id, model_config_id, synthetic
  );
create index aiq_distributed_aggregation_observation_fk_idx
  on aiq_private.aiq_distributed_aggregation_inputs (
    observation_id, node_id, synthetic
  );
create index aiq_distributed_aggregation_receipt_fk_idx
  on aiq_private.aiq_distributed_aggregation_inputs (
    receipt_id, assignment_id, lease_attempt, node_id, receipt_hash,
    result_package_hash, synthetic
  );
create index aiq_distributed_aggregation_task_package_fk_idx
  on aiq_private.aiq_distributed_aggregation_inputs (
    task_package_id, package_version, synthetic
  );
create index aiq_distributed_assignment_models_assignment_fk_idx
  on aiq_private.aiq_distributed_assignment_models (
    run_id, assignment_id, lease_attempt, node_id, synthetic
  );
create index aiq_distributed_assignment_models_model_fk_idx
  on aiq_private.aiq_distributed_assignment_models (model_config_id);
create index aiq_distributed_assignments_coordinator_fk_idx
  on aiq_private.aiq_distributed_assignments (coordinator_node_id, synthetic);
create index aiq_distributed_assignments_node_fk_idx
  on aiq_private.aiq_distributed_assignments (node_id, synthetic);
create index aiq_distributed_assignments_task_package_fk_idx
  on aiq_private.aiq_distributed_assignments (
    task_package_id, package_version, package_hash, synthetic
  );
create index aiq_distributed_capabilities_node_fk_idx
  on aiq_private.aiq_distributed_capability_declarations (node_id, synthetic);
create index aiq_distributed_observations_declaration_fk_idx
  on aiq_private.aiq_distributed_node_observations (
    declaration_id, node_id, synthetic
  );
create index aiq_distributed_receipts_assignment_fk_idx
  on aiq_private.aiq_distributed_result_receipts (
    assignment_id, lease_attempt, node_id, synthetic
  );
create index aiq_distributed_receipts_node_fk_idx
  on aiq_private.aiq_distributed_result_receipts (node_id, synthetic);
create index aiq_distributed_receipts_receiver_fk_idx
  on aiq_private.aiq_distributed_result_receipts (receiver_node_id, synthetic);
create index aiq_distributed_task_packages_coordinator_fk_idx
  on aiq_private.aiq_distributed_task_packages (
    coordinator_node_id, synthetic
  );
create index aiq_distributed_task_packages_task_set_fk_idx
  on aiq_private.aiq_distributed_task_packages (
    task_set_id, task_set_version
  );
create index aiq_node_capability_snapshots_node_fk_idx
  on aiq_private.aiq_node_capability_snapshots (node_id);
create index aiq_package_runs_model_fk_idx
  on aiq_private.aiq_package_runs (model_config_id);
create index aiq_publication_actors_publisher_fk_idx
  on aiq_private.aiq_publication_actors (publisher_node_id);
create index aiq_runs_capability_fk_idx
  on aiq_private.aiq_runs (capability_sha256);
create index aiq_runs_scoring_version_fk_idx
  on aiq_private.aiq_runs (scoring_version);
create index aiq_runs_source_node_fk_idx
  on aiq_private.aiq_runs (source_node_id);
create index aiq_runs_task_set_fk_idx
  on aiq_private.aiq_runs (task_set_id, task_set_version);
create index aiq_score_snapshots_scoring_version_fk_idx
  on aiq_private.aiq_score_snapshots (scoring_version);
create index aiq_verification_audit_actor_fk_idx
  on aiq_private.aiq_verification_audit (actor_node_id);

create index aiq_model_configs_public_rls_idx
  on aiq_private.aiq_model_configs (model_config_id) where is_enabled;
create index aiq_nodes_public_rls_idx
  on aiq_private.aiq_nodes (node_id) where public_visible;
create index aiq_score_snapshots_public_rls_idx
  on aiq_private.aiq_score_snapshots (run_id) where published;
create index aiq_scoring_versions_public_rls_idx
  on aiq_private.aiq_scoring_versions (scoring_version) where is_published;
create index aiq_task_catalog_public_rls_idx
  on aiq_private.aiq_task_catalog (
    task_set_id, task_set_version, task_id, task_version
  ) where public_metadata;

-- Application access is through security-definer RPCs and narrow
-- security-invoker views. Force RLS so table-owner execution cannot
-- accidentally bypass the table policies.
alter table aiq_private.aiq_artifact_claim_bindings force row level security;
alter table aiq_private.aiq_artifact_ingress_claims force row level security;
alter table aiq_private.aiq_artifact_ingress_objects force row level security;
alter table aiq_private.aiq_claim_artifact_reference_events force row level security;
alter table aiq_private.aiq_distributed_aggregation_inputs force row level security;
alter table aiq_private.aiq_distributed_assignment_models force row level security;
alter table aiq_private.aiq_distributed_assignments force row level security;
alter table aiq_private.aiq_distributed_capability_declarations force row level security;
alter table aiq_private.aiq_distributed_node_observations force row level security;
alter table aiq_private.aiq_distributed_result_receipts force row level security;
alter table aiq_private.aiq_distributed_task_packages force row level security;
alter table aiq_private.aiq_matrix_batches force row level security;
alter table aiq_private.aiq_model_configs force row level security;
alter table aiq_private.aiq_node_capability_snapshots force row level security;
alter table aiq_private.aiq_nodes force row level security;
alter table aiq_private.aiq_package_runs force row level security;
alter table aiq_private.aiq_publication_actors force row level security;
alter table aiq_private.aiq_result_packages force row level security;
alter table aiq_private.aiq_runs force row level security;
alter table aiq_private.aiq_score_snapshots force row level security;
alter table aiq_private.aiq_scoring_versions force row level security;
alter table aiq_private.aiq_storage_legal_hold_events force row level security;
alter table aiq_private.aiq_storage_object_references force row level security;
alter table aiq_private.aiq_storage_objects force row level security;
alter table aiq_private.aiq_storage_reconciliation_events force row level security;
alter table aiq_private.aiq_submission_conflicts force row level security;
alter table aiq_private.aiq_submission_inbox force row level security;
alter table aiq_private.aiq_task_catalog force row level security;
alter table aiq_private.aiq_task_results force row level security;
alter table aiq_private.aiq_task_sets force row level security;
alter table aiq_private.aiq_verification_audit force row level security;

commit;
