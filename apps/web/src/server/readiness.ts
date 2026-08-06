import { createClient } from '@supabase/supabase-js';

import { AIQ_CORE_TASK_METADATA_IDENTITY } from '../aiq-core-contract.ts';
import { PUBLIC_VIEW_NAMES } from '../data/repository.ts';
import {
  inspectProductionConfiguration,
  type ValidatedProductionConfiguration,
} from './production-configuration.ts';
import { createSupabaseRoleTokenIssuer, type SupabaseGatewayRole } from './supabase-role-token.ts';
import { createBoundedSupabaseFetch, createSupabaseApiKeyFetch } from './supabase-http.ts';

export { inspectProductionConfiguration } from './production-configuration.ts';

export type ReadinessState =
  | 'local_synthetic'
  | 'local_dependencies_ready'
  | 'configuration_error'
  | 'bounded_dependency_probe_passed'
  | 'dependencies_unavailable';

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function isUnknownArray(candidate: unknown): candidate is unknown[] {
  return Array.isArray(candidate);
}

export type ProductionDependencyProbe = (
  configuration: ValidatedProductionConfiguration & {
    signal: AbortSignal;
    requireProductionReference: boolean;
  },
) => Promise<void>;

type DependencyName =
  | 'public_reads'
  | 'storage_buckets'
  | 'role_scoped_rpc_contract'
  | 'production_reference'
  | 'verifier_rpc'
  | 'publisher_rpc';

class DependencyProbeError extends Error {
  readonly dependency: DependencyName;

  constructor(dependency: DependencyName) {
    super(`${dependency} probe failed`);
    this.dependency = dependency;
  }
}

const ROLE_GRANTS = {
  publicRead: {
    anon: true,
    authenticated: true,
    service_role: false,
    aiq_verifier: false,
    aiq_publisher: false,
  },
  service: {
    anon: false,
    authenticated: false,
    service_role: true,
    aiq_verifier: false,
    aiq_publisher: false,
  },
  verifier: {
    anon: false,
    authenticated: false,
    service_role: false,
    aiq_verifier: true,
    aiq_publisher: false,
  },
  publisher: {
    anon: false,
    authenticated: false,
    service_role: false,
    aiq_verifier: false,
    aiq_publisher: true,
  },
  gatewayProbe: {
    anon: false,
    authenticated: false,
    service_role: false,
    aiq_verifier: true,
    aiq_publisher: true,
  },
} as const;

export const REQUIRED_RPC_CONTRACT = {
  public_trend_points: {
    arguments: 'supplied_range text',
    result:
      'TABLE(matrix_id text, run_id text, scoring_version text, recorded_at timestamp with time zone, bucket_started_at timestamp with time zone, bucket_ended_at timestamp with time zone, score numeric, theta numeric, standard_error numeric, theta_ci_low numeric, theta_ci_high numeric, score_ci_low numeric, score_ci_high numeric, information numeric, quality_score numeric, strict_pass_rate numeric, strict_pass_low numeric, strict_pass_high numeric, strict_pass_sample_size integer, strict_pass_successes integer, reliability_status text, calibration_status text, sensitivity_low numeric, sensitivity_high numeric, sample_size integer, represented_run_count bigint, resolution_seconds bigint, synthetic boolean)',
    defaultCount: 0,
    modes: ['i', ...Array<string>(13).fill('t')],
    grants: ROLE_GRANTS.publicRead,
  },
  aiq_gateway_role_probe: {
    arguments: '',
    result: 'text',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.gatewayProbe,
  },
  aiq_enqueue_submission: {
    arguments: 'envelope jsonb, request_context jsonb, object_identity jsonb',
    result: 'TABLE(inbox_id uuid, disposition text, object_recorded boolean)',
    defaultCount: 0,
    modes: ['i', 'i', 'i', 't', 't', 't'],
    grants: ROLE_GRANTS.service,
  },
  aiq_record_artifact_ingress: {
    arguments:
      'target_run_id text, supplied_kind text, supplied_sha256 text, supplied_byte_size bigint, object_identity jsonb',
    result: 'text',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.service,
  },
  aiq_register_storage_object: {
    arguments:
      'supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone',
    result: 'uuid',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.service,
  },
  aiq_production_reference_status: {
    arguments: 'expected_publisher_node_id text',
    result: 'jsonb',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.service,
  },
  aiq_claim_submission: {
    arguments: 'requested_lease_seconds integer DEFAULT 300',
    result:
      'TABLE(inbox_id uuid, idempotency_key text, package_sha256 text, body_bytes bigint, object_bucket text, object_key text, object_content_sha256 text, lease_token uuid, lease_expires_at timestamp with time zone, attempt integer)',
    defaultCount: 1,
    modes: ['i', ...Array<string>(10).fill('t')],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_renew_submission_claim: {
    arguments: 'target_inbox_id uuid, supplied_lease_token uuid, requested_lease_seconds integer',
    result:
      'TABLE(inbox_id uuid, lease_token uuid, lease_expires_at timestamp with time zone, attempt integer)',
    defaultCount: 0,
    modes: ['i', 'i', 'i', 't', 't', 't', 't'],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_ack_submission_claim: {
    arguments: 'target_inbox_id uuid, supplied_lease_token uuid, supplied_disposition text',
    result: 'text',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_resolve_claim_artifact: {
    arguments:
      'target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text',
    result:
      'TABLE(object_bucket text, object_key text, artifact_kind text, content_sha256 text, byte_size bigint, lease_expires_at timestamp with time zone)',
    defaultCount: 0,
    modes: ['i', 'i', 'i', 'i', 't', 't', 't', 't', 't', 't'],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_stage_verifier_result: {
    arguments:
      'stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
    result: 'text',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_record_verifier_attestation: {
    arguments:
      'target_run_id text, target_package_sha256 text, attestation jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
    result: 'void',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_record_verification_rejection: {
    arguments:
      'target_run_id text, target_package_sha256 text, rejection jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
    result: 'void',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_stage_calibration_verification: {
    arguments:
      'stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
    result: 'text',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_record_calibration_attestation: {
    arguments:
      'attestation jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
    result: 'text',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.verifier,
  },
  aiq_verify_and_publish: {
    arguments:
      'target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
    result: 'void',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.publisher,
  },
  aiq_publish_calibration_evidence: {
    arguments:
      'target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
    result: 'text',
    defaultCount: 0,
    modes: [],
    grants: ROLE_GRANTS.publisher,
  },
} as const;

type PublicViewProbe = {
  columns: string;
  isRow: (candidate: unknown) => boolean;
};

function isBoundedString(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.length <= 8_192;
}

function isFiniteNumber(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isFinite(candidate);
}

function isBoundedStringArray(candidate: unknown): candidate is string[] {
  return (
    Array.isArray(candidate) &&
    candidate.length <= 1_000 &&
    candidate.every((value) => isBoundedString(value))
  );
}

function isBoundedJson(candidate: unknown, depth = 0): boolean {
  if (candidate === null || typeof candidate === 'boolean' || isFiniteNumber(candidate)) {
    return true;
  }
  if (isBoundedString(candidate)) return true;
  if (depth >= 4) return false;
  if (Array.isArray(candidate)) {
    return candidate.length <= 1_000 && candidate.every((value) => isBoundedJson(value, depth + 1));
  }
  if (!isRecord(candidate)) return false;
  const entries = Object.entries(candidate);
  return (
    entries.length <= 1_000 &&
    entries.every(([key, value]) => key.length <= 256 && isBoundedJson(value, depth + 1))
  );
}

function hasPublicRowShape(
  candidate: unknown,
  columns: readonly string[],
  {
    booleans = [],
    json: jsonFields = [],
    nullable = [],
    numbers = [],
    stringArrays = [],
  }: {
    booleans?: readonly string[];
    json?: readonly string[];
    nullable?: readonly string[];
    numbers?: readonly string[];
    stringArrays?: readonly string[];
  } = {},
): boolean {
  if (!isRecord(candidate) || Object.keys(candidate).length !== columns.length) return false;
  const booleanFields = new Set(booleans);
  const boundedJsonFields = new Set(jsonFields);
  const nullableFields = new Set(nullable);
  const numberFields = new Set(numbers);
  const stringArrayFields = new Set(stringArrays);
  return columns.every((column) => {
    if (!Object.hasOwn(candidate, column)) return false;
    const value = candidate[column];
    if (value === null && nullableFields.has(column)) return true;
    if (booleanFields.has(column)) return typeof value === 'boolean';
    if (boundedJsonFields.has(column)) return isBoundedJson(value);
    if (numberFields.has(column)) return isFiniteNumber(value);
    if (stringArrayFields.has(column)) return isBoundedStringArray(value);
    return isBoundedString(value);
  });
}

function publicViewProbe(
  columns: readonly string[],
  shape?: Parameters<typeof hasPublicRowShape>[2],
): PublicViewProbe {
  return {
    columns: columns.join(','),
    isRow: (candidate) => hasPublicRowShape(candidate, columns, shape),
  };
}

const PUBLIC_VIEW_PROBES: Readonly<
  Record<(typeof PUBLIC_VIEW_NAMES)[keyof typeof PUBLIC_VIEW_NAMES], PublicViewProbe>
> = {
  public_model_matrix: publicViewProbe(['id', 'model_family', 'model_name', 'reasoning_tier']),
  public_leaderboard: publicViewProbe(
    [
      'matrix_id',
      'run_id',
      'score',
      'theta',
      'standard_error',
      'theta_ci_low',
      'theta_ci_high',
      'score_ci_low',
      'score_ci_high',
      'information',
      'quality_score',
      'strict_pass_rate',
      'strict_pass_low',
      'strict_pass_high',
      'strict_pass_sample_size',
      'strict_pass_successes',
      'reliability_status',
      'calibration_status',
      'sensitivity_low',
      'sensitivity_high',
      'sample_size',
      'coverage_percent',
      'runtime_issues',
      'missing',
      'scoring_version',
      'score_status',
      'synthetic',
    ],
    {
      booleans: ['synthetic'],
      nullable: [
        'run_id',
        'score',
        'theta',
        'standard_error',
        'theta_ci_low',
        'theta_ci_high',
        'score_ci_low',
        'score_ci_high',
        'information',
        'quality_score',
        'strict_pass_rate',
        'strict_pass_low',
        'strict_pass_high',
        'strict_pass_sample_size',
        'strict_pass_successes',
        'reliability_status',
        'calibration_status',
        'sensitivity_low',
        'sensitivity_high',
        'sample_size',
        'coverage_percent',
        'runtime_issues',
        'missing',
        'scoring_version',
        'score_status',
        'synthetic',
      ],
      numbers: [
        'score',
        'theta',
        'standard_error',
        'theta_ci_low',
        'theta_ci_high',
        'score_ci_low',
        'score_ci_high',
        'information',
        'quality_score',
        'strict_pass_rate',
        'strict_pass_low',
        'strict_pass_high',
        'strict_pass_sample_size',
        'strict_pass_successes',
        'sensitivity_low',
        'sensitivity_high',
        'sample_size',
        'coverage_percent',
        'runtime_issues',
        'missing',
      ],
    },
  ),
  public_runs: publicViewProbe(
    [
      'id',
      'matrix_id',
      'started_at',
      'completed_at',
      'benchmark_version',
      'scoring_version',
      'prompt_set_digest',
      'runner_commit',
      'region',
      'synthetic',
      'corpus_release_id',
      'corpus_commitment_sha256',
      'catalog_digest',
      'task_set_digest',
      'preflight_digest',
      'runtime_digest',
      'run_class',
      'permission_evidence_digest',
      'result_count',
      'correct_count',
      'partial_count',
      'incorrect_count',
      'runtime_issue_count',
      'invalid_count',
      'missing_count',
      'not_applicable_count',
      'completed_count',
      'observed_count',
      'coverage_percent',
      'covered_domain_count',
      'provisional_domain_count',
    ],
    {
      booleans: ['synthetic'],
      nullable: [
        'corpus_release_id',
        'corpus_commitment_sha256',
        'catalog_digest',
        'task_set_digest',
        'preflight_digest',
        'runtime_digest',
        'run_class',
        'permission_evidence_digest',
        'coverage_percent',
      ],
      numbers: [
        'result_count',
        'correct_count',
        'partial_count',
        'incorrect_count',
        'runtime_issue_count',
        'invalid_count',
        'missing_count',
        'not_applicable_count',
        'completed_count',
        'observed_count',
        'coverage_percent',
        'covered_domain_count',
        'provisional_domain_count',
      ],
    },
  ),
  public_run_results: publicViewProbe(
    [
      'run_id',
      'id',
      'task_id',
      'task',
      'domain',
      'outcome',
      'execution_status',
      'score',
      'explanation_code',
      'explanation_summary',
      'retryable',
      'tools',
      'latency_ms',
      'latency_evidence_level',
      'input_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
      'total_tokens',
      'token_usage_source_level',
      'token_usage_evidence_level',
      'standard_api_equivalent_usd_nanos',
      'cost_estimator_status',
      'cost_evidence_level',
      'pricing_digest',
    ],
    {
      booleans: ['retryable'],
      nullable: [
        'score',
        'explanation_code',
        'explanation_summary',
        'retryable',
        'latency_ms',
        'latency_evidence_level',
        'input_tokens',
        'cached_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
        'reasoning_output_tokens',
        'total_tokens',
        'token_usage_source_level',
        'token_usage_evidence_level',
        'standard_api_equivalent_usd_nanos',
        'cost_evidence_level',
      ],
      numbers: [
        'score',
        'latency_ms',
        'input_tokens',
        'cached_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
        'reasoning_output_tokens',
        'total_tokens',
        'standard_api_equivalent_usd_nanos',
      ],
      stringArrays: ['tools'],
    },
  ),
  public_nodes: publicViewProbe(
    [
      'id',
      'name',
      'operator',
      'public_key_fingerprint',
      'capabilities',
      'source',
      'trust',
      'status',
      'last_seen_at',
      'signature_status',
      'provenance',
      'synthetic',
    ],
    {
      booleans: ['synthetic'],
      json: ['capabilities', 'source', 'provenance'],
      nullable: ['last_seen_at'],
    },
  ),
  public_distributed_radar: publicViewProbe(
    [
      'node_id',
      'name',
      'operator',
      'public_key_fingerprint',
      'registry_trust',
      'registry_status',
      'last_seen_at',
      'synthetic',
      'latest_capability_schema_version',
      'latest_capability_hash',
      'latest_capability_status',
      'latest_capability_signature_status',
      'latest_capability_observed_at',
      'latest_observation_schema_version',
      'latest_observation_state',
      'latest_observation_sequence',
      'latest_observation_hash',
      'latest_observation_status',
      'latest_observation_signature_status',
      'latest_observation_observed_at',
      'latest_observation_provenance_hash',
      'assignment_total_count',
      'assignment_offered_count',
      'assignment_accepted_count',
      'assignment_running_count',
      'assignment_completed_count',
      'assignment_revoked_count',
      'assignment_expired_count',
      'receipt_total_count',
      'receipt_received_count',
      'receipt_accepted_count',
      'receipt_rejected_count',
      'receiver_verified_trusted_count',
      'signed_untrusted_count',
      'rejected_count',
      'missing_count',
      'aggregated_at',
    ],
    {
      booleans: ['synthetic'],
      nullable: [
        'last_seen_at',
        'latest_capability_schema_version',
        'latest_capability_hash',
        'latest_capability_status',
        'latest_capability_signature_status',
        'latest_capability_observed_at',
        'latest_observation_schema_version',
        'latest_observation_state',
        'latest_observation_sequence',
        'latest_observation_hash',
        'latest_observation_status',
        'latest_observation_signature_status',
        'latest_observation_observed_at',
        'latest_observation_provenance_hash',
        'aggregated_at',
      ],
      numbers: [
        'latest_observation_sequence',
        'assignment_total_count',
        'assignment_offered_count',
        'assignment_accepted_count',
        'assignment_running_count',
        'assignment_completed_count',
        'assignment_revoked_count',
        'assignment_expired_count',
        'receipt_total_count',
        'receipt_received_count',
        'receipt_accepted_count',
        'receipt_rejected_count',
        'receiver_verified_trusted_count',
        'signed_untrusted_count',
        'rejected_count',
        'missing_count',
      ],
    },
  ),
  public_scoring_versions: publicViewProbe(
    [
      'benchmark_version',
      'scoring_version',
      'published_at',
      'principles',
      'missing_policy',
      'failure_policy',
      'sensitivity_policy',
      'synthetic',
    ],
    { booleans: ['synthetic'], stringArrays: ['principles'] },
  ),
  public_task_coverage: publicViewProbe(['scoring_version', 'domain', 'weight', 'task_count'], {
    numbers: ['weight', 'task_count'],
  }),
  public_calibration_runs: publicViewProbe(
    [
      'run_id',
      'classification',
      'scoring_version',
      'selected_task_count',
      'selected_model_count',
      'result_count',
      'started_at',
      'completed_at',
      'verified_at',
      'published_at',
      'replay_status',
      'official',
      'ranking_eligible',
      'pricing_currency',
      'pricing_processing_tier',
    ],
    {
      booleans: ['official', 'ranking_eligible'],
      numbers: ['selected_task_count', 'selected_model_count', 'result_count'],
    },
  ),
  public_calibration_results: publicViewProbe(
    [
      'result_id',
      'run_id',
      'task_id',
      'task_version',
      'domain',
      'model_family',
      'reasoning_effort',
      'outcome',
      'execution_status',
      'failure_code',
      'explanation_code',
      'explanation_summary',
      'task_score',
      'latency_ms',
      'latency_evidence_level',
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'cache_write_input_tokens',
      'reasoning_output_tokens',
      'total_tokens',
      'token_usage_source_level',
      'token_usage_evidence_level',
      'standard_api_equivalent_usd_nanos',
      'cost_estimator_status',
      'cost_evidence_level',
      'cost_estimator_limitations',
      'cost_method',
      'cost_version',
      'cost_as_of',
      'cost_source',
      'pricing_currency',
      'pricing_processing_tier',
    ],
    {
      nullable: [
        'failure_code',
        'explanation_code',
        'explanation_summary',
        'task_score',
        'latency_ms',
        'latency_evidence_level',
        'input_tokens',
        'cached_input_tokens',
        'output_tokens',
        'cache_write_input_tokens',
        'reasoning_output_tokens',
        'total_tokens',
        'token_usage_source_level',
        'token_usage_evidence_level',
        'standard_api_equivalent_usd_nanos',
        'cost_evidence_level',
        'cost_method',
        'cost_version',
        'cost_as_of',
        'cost_source',
      ],
      numbers: [
        'task_score',
        'latency_ms',
        'input_tokens',
        'cached_input_tokens',
        'output_tokens',
        'cache_write_input_tokens',
        'reasoning_output_tokens',
        'total_tokens',
        'standard_api_equivalent_usd_nanos',
      ],
      stringArrays: ['cost_estimator_limitations'],
    },
  ),
  public_calibration_scores: publicViewProbe(
    [
      'run_id',
      'model_family',
      'reasoning_effort',
      'descriptive_status',
      'quality_score',
      'task_resampling_sensitivity_lower',
      'task_resampling_sensitivity_upper',
      'task_resampling_sensitivity_method',
      'result_count',
      'sample_size',
      'coverage_percent',
      'observed_total_wall_ms',
      'observed_median_wall_ms',
      'observed_p95_wall_ms',
      'observed_time_sample_count',
      'observed_time_coverage_percent',
      'duration_evidence_level',
      'input_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
      'total_tokens',
      'token_usage_sample_count',
      'token_usage_source_level',
      'token_usage_evidence_level',
      'standard_api_equivalent_usd_nanos',
      'estimated_cost_sample_count',
      'cost_estimator_status',
      'cost_evidence_level',
      'cost_estimator_limitations',
      'token_usage_coverage_percent',
      'pricing_source',
      'pricing_as_of',
      'pricing_version',
      'pricing_currency',
      'pricing_processing_tier',
      'attempted_result_count',
      'invoked_result_count',
      'adapter_elapsed_observed_result_count',
      'token_observed_result_count',
      'priced_result_count',
    ],
    {
      nullable: [
        'quality_score',
        'task_resampling_sensitivity_lower',
        'task_resampling_sensitivity_upper',
        'task_resampling_sensitivity_method',
        'cost_evidence_level',
        'observed_total_wall_ms',
        'observed_median_wall_ms',
        'observed_p95_wall_ms',
        'duration_evidence_level',
        'input_tokens',
        'cached_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
        'reasoning_output_tokens',
        'total_tokens',
        'token_usage_source_level',
        'token_usage_coverage_percent',
        'token_usage_evidence_level',
        'standard_api_equivalent_usd_nanos',
        'pricing_source',
        'pricing_as_of',
        'pricing_version',
      ],
      numbers: [
        'quality_score',
        'task_resampling_sensitivity_lower',
        'task_resampling_sensitivity_upper',
        'sample_size',
        'result_count',
        'coverage_percent',
        'observed_total_wall_ms',
        'observed_median_wall_ms',
        'observed_p95_wall_ms',
        'observed_time_sample_count',
        'observed_time_coverage_percent',
        'input_tokens',
        'cached_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
        'reasoning_output_tokens',
        'total_tokens',
        'token_usage_sample_count',
        'standard_api_equivalent_usd_nanos',
        'estimated_cost_sample_count',
        'token_usage_coverage_percent',
        'attempted_result_count',
        'invoked_result_count',
        'adapter_elapsed_observed_result_count',
        'token_observed_result_count',
        'priced_result_count',
      ],
      stringArrays: ['cost_estimator_limitations'],
    },
  ),
  public_model_efficiency: publicViewProbe(
    [
      'run_id',
      'matrix_batch_id',
      'model_family',
      'reasoning_effort',
      'matrix_batch_elapsed_ms',
      'summed_cell_adapter_elapsed_ms',
      'observed_median_wall_ms',
      'observed_p95_wall_ms',
      'observed_time_sample_count',
      'observed_time_coverage_percent',
      'duration_evidence_level',
      'input_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
      'total_tokens',
      'token_usage_sample_count',
      'token_usage_coverage_percent',
      'input_token_coverage_count',
      'input_token_coverage_percent',
      'cached_input_token_coverage_count',
      'cached_input_token_coverage_percent',
      'cache_write_input_token_coverage_count',
      'cache_write_input_token_coverage_percent',
      'output_token_coverage_count',
      'output_token_coverage_percent',
      'reasoning_token_coverage_count',
      'reasoning_token_coverage_percent',
      'total_token_coverage_count',
      'total_token_coverage_percent',
      'token_usage_source_level',
      'token_usage_evidence_level',
      'standard_api_equivalent_usd_nanos',
      'cost_estimator_status',
      'cost_evidence_level',
      'cost_method',
      'pricing_source',
      'pricing_as_of',
      'pricing_version',
      'pricing_currency',
      'pricing_processing_tier',
      'result_count',
      'attempted_result_count',
      'invoked_result_count',
      'adapter_elapsed_observed_result_count',
      'token_observed_result_count',
      'priced_result_count',
      'execution_concurrency',
      'estimated_cost_sample_count',
      'cost_estimator_limitations',
      'pricing_rates',
      'cost_formula',
    ],
    {
      nullable: [
        'summed_cell_adapter_elapsed_ms',
        'observed_median_wall_ms',
        'observed_p95_wall_ms',
        'duration_evidence_level',
        'input_tokens',
        'cached_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
        'reasoning_output_tokens',
        'total_tokens',
        'token_usage_coverage_percent',
        'input_token_coverage_count',
        'input_token_coverage_percent',
        'cached_input_token_coverage_count',
        'cached_input_token_coverage_percent',
        'cache_write_input_token_coverage_count',
        'cache_write_input_token_coverage_percent',
        'output_token_coverage_count',
        'output_token_coverage_percent',
        'reasoning_token_coverage_count',
        'reasoning_token_coverage_percent',
        'total_token_coverage_count',
        'total_token_coverage_percent',
        'token_usage_source_level',
        'token_usage_evidence_level',
        'standard_api_equivalent_usd_nanos',
        'cost_evidence_level',
        'cost_method',
        'pricing_source',
        'pricing_as_of',
        'pricing_version',
        'pricing_currency',
        'pricing_processing_tier',
        'cost_formula',
      ],
      numbers: [
        'matrix_batch_elapsed_ms',
        'summed_cell_adapter_elapsed_ms',
        'observed_median_wall_ms',
        'observed_p95_wall_ms',
        'observed_time_sample_count',
        'observed_time_coverage_percent',
        'input_tokens',
        'cached_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
        'reasoning_output_tokens',
        'total_tokens',
        'token_usage_sample_count',
        'token_usage_coverage_percent',
        'input_token_coverage_count',
        'input_token_coverage_percent',
        'cached_input_token_coverage_count',
        'cached_input_token_coverage_percent',
        'cache_write_input_token_coverage_count',
        'cache_write_input_token_coverage_percent',
        'output_token_coverage_count',
        'output_token_coverage_percent',
        'reasoning_token_coverage_count',
        'reasoning_token_coverage_percent',
        'total_token_coverage_count',
        'total_token_coverage_percent',
        'standard_api_equivalent_usd_nanos',
        'result_count',
        'attempted_result_count',
        'invoked_result_count',
        'adapter_elapsed_observed_result_count',
        'token_observed_result_count',
        'priced_result_count',
        'execution_concurrency',
        'estimated_cost_sample_count',
      ],
      stringArrays: ['cost_estimator_limitations'],
      json: ['pricing_rates'],
    },
  ),
};

export const PUBLIC_VIEW_SELECTS: Readonly<
  Record<(typeof PUBLIC_VIEW_NAMES)[keyof typeof PUBLIC_VIEW_NAMES], string>
> = {
  public_model_matrix: PUBLIC_VIEW_PROBES.public_model_matrix.columns,
  public_leaderboard: PUBLIC_VIEW_PROBES.public_leaderboard.columns,
  public_runs: PUBLIC_VIEW_PROBES.public_runs.columns,
  public_run_results: PUBLIC_VIEW_PROBES.public_run_results.columns,
  public_nodes: PUBLIC_VIEW_PROBES.public_nodes.columns,
  public_distributed_radar: PUBLIC_VIEW_PROBES.public_distributed_radar.columns,
  public_scoring_versions: PUBLIC_VIEW_PROBES.public_scoring_versions.columns,
  public_task_coverage: PUBLIC_VIEW_PROBES.public_task_coverage.columns,
  public_calibration_runs: PUBLIC_VIEW_PROBES.public_calibration_runs.columns,
  public_calibration_results: PUBLIC_VIEW_PROBES.public_calibration_results.columns,
  public_calibration_scores: PUBLIC_VIEW_PROBES.public_calibration_scores.columns,
  public_model_efficiency: PUBLIC_VIEW_PROBES.public_model_efficiency.columns,
};

async function fetchJson(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await createBoundedSupabaseFetch(signal)(url, {
    headers,
    method: 'GET',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('dependency request failed');
  return readBoundedJson(response, 2_000_000);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !/^(0|[1-9][0-9]*)(?![\s\S])/.test(contentLengthHeader) ||
      !Number.isSafeInteger(contentLength) ||
      contentLength > maxBytes
    ) {
      await response.body?.cancel();
      throw new Error('dependency response has an invalid byte bound');
    }
  }
  if (!response.body) throw new Error('dependency response body is unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = '';
  for (;;) {
    // A stream reader must finish one read before it can request the next chunk.
    // eslint-disable-next-line no-await-in-loop
    const result = await reader.read();
    if (result.done) break;
    byteCount += result.value.byteLength;
    if (byteCount > maxBytes) {
      // The cancellation must finish before the bound error leaves this operation.
      // eslint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw new Error('dependency response exceeded the bound');
    }
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

function isTrendPoint(candidate: unknown): boolean {
  return (
    isRecord(candidate) &&
    typeof candidate.matrix_id === 'string' &&
    typeof candidate.run_id === 'string' &&
    typeof candidate.scoring_version === 'string' &&
    typeof candidate.recorded_at === 'string' &&
    typeof candidate.bucket_started_at === 'string' &&
    typeof candidate.bucket_ended_at === 'string' &&
    typeof candidate.score === 'number' &&
    typeof candidate.sensitivity_low === 'number' &&
    typeof candidate.sensitivity_high === 'number' &&
    typeof candidate.sample_size === 'number' &&
    typeof candidate.represented_run_count === 'number' &&
    typeof candidate.resolution_seconds === 'number' &&
    typeof candidate.synthetic === 'boolean'
  );
}

async function probePublicTrendPoints(
  publicUrl: string,
  publicPublishableKey: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await createBoundedSupabaseFetch(signal)(
    `${publicUrl}/rest/v1/rpc/public_trend_points`,
    {
      method: 'POST',
      headers: {
        apikey: publicPublishableKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ supplied_range: 'day' }),
    },
  );
  if (!response.ok) throw new Error('public trend points are unavailable');
  const document: unknown = await readBoundedJson(response, 512_000);
  if (!Array.isArray(document) || document.length > 340 || !document.every(isTrendPoint)) {
    throw new Error('public trend points are unavailable');
  }
}

async function probeGatewayRole(
  serviceUrl: string,
  publishableKey: string,
  token: string,
  expectedRole: SupabaseGatewayRole,
  signal: AbortSignal,
): Promise<void> {
  const response = await createBoundedSupabaseFetch(signal)(
    `${serviceUrl}/rest/v1/rpc/aiq_gateway_role_probe`,
    {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    },
  );
  if (!response.ok) throw new Error('gateway role is unavailable');
  const document: unknown = await readBoundedJson(response, 1_024);
  if (document !== expectedRole) throw new Error('gateway role is unavailable');
}

async function probeRpcContract(
  serviceUrl: string,
  secretKey: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await createBoundedSupabaseFetch(signal)(
    `${serviceUrl}/rest/v1/rpc/aiq_describe_web_rpc_contract`,
    {
      method: 'POST',
      headers: {
        apikey: secretKey,
        'content-type': 'application/json',
      },
      body: '{}',
    },
  );
  if (!response.ok) throw new Error('RPC contract is unavailable');
  const document: unknown = await readBoundedJson(response, 64_000);
  if (!Array.isArray(document)) throw new Error('RPC contract is unavailable');
  const contracts = new Map(
    document.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.name === 'string'
        ? [[candidate.name, candidate] as const]
        : [],
    ),
  );
  if (contracts.size !== Object.keys(REQUIRED_RPC_CONTRACT).length) {
    throw new Error('required RPC contract is unavailable');
  }
  for (const [name, expected] of Object.entries(REQUIRED_RPC_CONTRACT)) {
    const actual = contracts.get(name);
    const actualRoles =
      actual && isRecord(actual.executable_roles) ? actual.executable_roles : undefined;
    if (
      !actual ||
      actual.arguments !== expected.arguments ||
      actual.result !== expected.result ||
      actual.default_count !== expected.defaultCount ||
      !isUnknownArray(actual.argument_modes) ||
      JSON.stringify(actual.argument_modes) !== JSON.stringify(expected.modes) ||
      !actualRoles ||
      Object.entries(expected.grants).some(([role, granted]) => actualRoles[role] !== granted) ||
      Object.keys(actualRoles).length !== Object.keys(expected.grants).length
    ) {
      throw new Error('required RPC contract is unavailable');
    }
  }
}

const EXPECTED_DOMAIN_COUNTS = {
  coding: 8,
  debugging: 8,
  repository_understanding: 7,
  data_processing: 8,
  retrieval_verification: 7,
  documentation_communication: 7,
  planning_execution: 7,
  tool_use: 7,
  instruction_following: 6,
  reliability_recovery: 7,
} as const;

const EXPECTED_CATALOG_IDENTITY = AIQ_CORE_TASK_METADATA_IDENTITY;

async function probeProductionReference(
  serviceUrl: string,
  secretKey: string,
  publisherNodeId: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await createBoundedSupabaseFetch(signal)(
    `${serviceUrl}/rest/v1/rpc/aiq_production_reference_status`,
    {
      method: 'POST',
      headers: {
        apikey: secretKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expected_publisher_node_id: publisherNodeId }),
    },
  );
  if (!response.ok) throw new Error('production reference status is unavailable');
  const document: unknown = await readBoundedJson(response, 64_000);
  const domainCounts =
    isRecord(document) && isRecord(document.domain_counts) ? document.domain_counts : undefined;
  if (
    !isRecord(document) ||
    Object.keys(document).length !== 20 ||
    document.initialized !== true ||
    document.model_config_count !== 17 ||
    document.model_config_mismatch_count !== 0 ||
    document.scoring_version_count !== 1 ||
    document.scoring_version_valid !== true ||
    document.task_count !== 72 ||
    document.distinct_task_count !== 72 ||
    !domainCounts ||
    Object.keys(domainCounts).length !== 10 ||
    Object.entries(EXPECTED_DOMAIN_COUNTS).some(
      ([domain, count]) => domainCounts[domain] !== count,
    ) ||
    document.catalog_identity_sha256 !== EXPECTED_CATALOG_IDENTITY ||
    document.frozen_catalog_valid !== true ||
    document.production_node_count !== 3 ||
    document.distinct_production_node_count !== 3 ||
    document.runner_count !== 1 ||
    document.verifier_count !== 1 ||
    document.publisher_count !== 1 ||
    document.private_table_count !== 40 ||
    document.forced_rls_table_count !== 40 ||
    document.public_view_count !== 12 ||
    document.security_invoker_view_count !== 12 ||
    document.hardened_gateway_role_count !== 2
  ) {
    throw new Error('production reference status is invalid');
  }
}

async function identifyDependency(
  dependency: DependencyName,
  operation: Promise<unknown>,
): Promise<void> {
  try {
    await operation;
  } catch {
    throw new DependencyProbeError(dependency);
  }
}

export const probeProductionDependencies: ProductionDependencyProbe = async ({
  publicUrl,
  publicPublishableKey,
  serviceUrl,
  secretKey,
  publishableKey,
  privateJwk,
  publisherNodeId,
  packageBucket,
  artifactBucket,
  requireProductionReference,
  signal,
}) => {
  const publicClient = createClient(publicUrl, publicPublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createSupabaseApiKeyFetch(publicPublishableKey, signal) },
  });
  const publicViews = Object.values(PUBLIC_VIEW_NAMES).map(async (view) => {
    const probe = PUBLIC_VIEW_PROBES[view];
    const result = await publicClient
      .from(view)
      .select(probe.columns)
      .limit(1)
      .abortSignal(signal)
      .overrideTypes<unknown[], { merge: false }>();
    if (
      result.error ||
      !Array.isArray(result.data) ||
      result.data.length > 1 ||
      (result.data[0] !== undefined && !probe.isRow(result.data[0]))
    ) {
      throw new Error('public view is unavailable');
    }
  });
  const issueRoleToken = createSupabaseRoleTokenIssuer(privateJwk);
  const publicReadProbe = Promise.all([
    ...publicViews,
    probePublicTrendPoints(publicUrl, publicPublishableKey, signal),
  ]);
  const verifierRoleProbe = probeGatewayRole(
    serviceUrl,
    publishableKey,
    issueRoleToken({ role: 'aiq_verifier' }),
    'aiq_verifier',
    signal,
  );
  const publisherRoleProbe = probeGatewayRole(
    serviceUrl,
    publishableKey,
    issueRoleToken({ role: 'aiq_publisher', publisherNodeId }),
    'aiq_publisher',
    signal,
  );

  const bucketProbe = (async () => {
    const candidate = await fetchJson(
      `${serviceUrl}/storage/v1/bucket`,
      { apikey: secretKey },
      signal,
    );
    if (!Array.isArray(candidate)) throw new Error('Storage bucket inventory is unavailable');
    const buckets = new Map(
      candidate.flatMap((bucket) =>
        isRecord(bucket) &&
        'name' in bucket &&
        typeof bucket.name === 'string' &&
        'public' in bucket &&
        typeof bucket.public === 'boolean'
          ? [[bucket.name, bucket.public] as const]
          : [],
      ),
    );
    if (buckets.get(packageBucket) !== false || buckets.get(artifactBucket) !== false) {
      throw new Error('required Storage bucket is unavailable');
    }
  })();

  await Promise.all([
    identifyDependency('public_reads', publicReadProbe),
    identifyDependency('storage_buckets', bucketProbe),
    identifyDependency('role_scoped_rpc_contract', probeRpcContract(serviceUrl, secretKey, signal)),
    identifyDependency('verifier_rpc', verifierRoleProbe),
    identifyDependency('publisher_rpc', publisherRoleProbe),
    ...(requireProductionReference
      ? [
          identifyDependency(
            'production_reference',
            probeProductionReference(serviceUrl, secretKey, publisherNodeId, signal),
          ),
        ]
      : []),
  ]);
};

const SCOPE = [
  'runtime_mode',
  'configuration_contract',
  'public_read_views',
  'public_trend_points_rpc',
  'private_storage_buckets',
  'role_scoped_rpc_contract',
  'gateway_role_credentials',
  'production_reference_initialization',
] as const;

function json(body: Readonly<Record<string, unknown>>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store, max-age=0' },
  });
}

function isLocalLoopbackConfiguration(configuration: ValidatedProductionConfiguration): boolean {
  const publicUrl = new URL(configuration.publicUrl);
  const serviceUrl = new URL(configuration.serviceUrl);
  return (
    publicUrl.protocol === 'http:' &&
    (publicUrl.hostname === 'localhost' || publicUrl.hostname === '127.0.0.1') &&
    publicUrl.origin === serviceUrl.origin
  );
}

export function createReadinessHandler({
  environment = process.env,
  probe = probeProductionDependencies,
  timeoutMs = 2_000,
}: {
  environment?: Readonly<Record<string, string | undefined>>;
  probe?: ProductionDependencyProbe;
  timeoutMs?: number;
} = {}): () => Promise<Response> {
  return async () => {
    const configuration = inspectProductionConfiguration(environment);
    const hasPublicConfiguration = Boolean(
      environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
      environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
    );
    if (configuration.mode === 'non_production' && !hasPublicConfiguration) {
      return json({
        state: 'local_synthetic' satisfies ReadinessState,
        scope_ready: true,
        mode: 'local_synthetic',
        checks: {
          runtime_mode: 'non_production',
          configuration: 'synthetic_not_applicable',
          dependencies: 'not_run',
        },
        scope: SCOPE,
      });
    }

    if (!configuration.values) {
      return json(
        {
          state: 'configuration_error' satisfies ReadinessState,
          scope_ready: false,
          mode: configuration.mode,
          checks: {
            runtime_mode: configuration.mode,
            configuration: 'invalid',
            dependencies: 'not_run',
          },
          issues: configuration.issues,
          scope: SCOPE,
        },
        503,
      );
    }

    if (
      configuration.mode === 'non_production' &&
      !isLocalLoopbackConfiguration(configuration.values)
    ) {
      return json(
        {
          state: 'configuration_error' satisfies ReadinessState,
          scope_ready: false,
          mode: configuration.mode,
          checks: {
            runtime_mode: configuration.mode,
            configuration: 'invalid',
            dependencies: 'not_run',
          },
          issues: [
            'Local dependency readiness requires one canonical loopback HTTP Supabase origin',
          ],
          scope: SCOPE,
        },
        503,
      );
    }

    const controller = new AbortController();
    let rejectTimeout: ((reason: Error) => void) | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout?.(new Error('readiness dependency probe timed out'));
    }, timeoutMs);
    try {
      await Promise.race([
        probe({
          ...configuration.values,
          signal: controller.signal,
          requireProductionReference: configuration.mode === 'production',
        }),
        timeoutFailure,
      ]);
      const state =
        configuration.mode === 'production'
          ? ('bounded_dependency_probe_passed' satisfies ReadinessState)
          : ('local_dependencies_ready' satisfies ReadinessState);
      return json({
        state,
        scope_ready: true,
        mode: configuration.mode,
        checks: {
          runtime_mode: configuration.mode,
          configuration: 'valid',
          dependencies: 'available',
        },
        scope: SCOPE,
      });
    } catch (error) {
      const failedDependency =
        error instanceof DependencyProbeError
          ? error.dependency
          : controller.signal.aborted
            ? 'timeout'
            : 'unknown';
      return json(
        {
          state: 'dependencies_unavailable' satisfies ReadinessState,
          scope_ready: false,
          mode: configuration.mode,
          checks: {
            runtime_mode: configuration.mode,
            configuration: 'valid',
            dependencies: 'unavailable',
          },
          failed_dependency: failedDependency,
          issues: ['A required Supabase dependency is unavailable or the probe timed out'],
          scope: SCOPE,
        },
        503,
      );
    } finally {
      controller.abort();
      clearTimeout(timeout);
    }
  };
}
