import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOMAINS = [
  'coding',
  'debugging',
  'repository_understanding',
  'data_processing',
  'retrieval_verification',
  'documentation_communication',
  'planning_execution',
  'tool_use',
  'instruction_following',
  'reliability_recovery',
] as const;

type Domain = (typeof DOMAINS)[number];
type Difficulty = 'easy' | 'medium' | 'hard';
type RevisionKind = 'replacement' | 'retargeted' | 'rebalanced';

interface TaskDraft {
  readonly domain: Domain;
  readonly title: string;
  readonly difficulty: Difficulty;
  readonly inputKind: string;
  readonly scorer: string;
  readonly summary: string;
  readonly checks: readonly string[];
  readonly tags: readonly string[];
}

interface DomainProfile {
  readonly allowedTools: readonly string[];
}

interface TaskBudget {
  readonly wall_seconds: number;
  readonly max_steps: number;
  readonly max_tool_calls: number;
}

export interface CatalogTask {
  readonly task_id: string;
  readonly task_version: string;
  readonly title: string;
  readonly domain: Domain;
  readonly difficulty: Difficulty;
  readonly summary: string;
  readonly design_revision: {
    readonly supersedes_task_version: '1.0.1';
    readonly kind: RevisionKind;
    readonly objective: string;
    readonly task_specific_delta: string;
    readonly controlled_corpus_requirements: readonly string[];
  };
  readonly input_contract: {
    readonly kind: string;
    readonly fixture_profile: string;
    readonly content_handle: string;
  };
  readonly cluster_id: string;
  readonly allowed_tools: readonly string[];
  readonly budget: {
    readonly wall_seconds: number;
    readonly max_steps: number;
    readonly max_tool_calls: number;
  };
  readonly evaluator: {
    readonly kind: string;
    readonly scorer_version: string;
    readonly execution_protocol: 'aiq.evaluator-protocol.v1';
    readonly binding_requirement: 'controlled_hidden_task_required';
    readonly deterministic: true;
    readonly partial_credit: true;
    readonly pass_conditions: readonly string[];
    readonly scoring_contract: {
      readonly aggregation: 'weighted_assertion_fraction';
      readonly assertion_scoring: 'binary_equal_weight_within_component';
      readonly missing_or_error_score: 0;
      readonly rounding: 'no_intermediate_rounding_final_six_decimals';
      readonly formula: 'sum(component_weight_basis_points / 10000 * passed_assertions / total_assertions)';
      readonly score_range: readonly [0, 1];
      readonly minimum_assertions_per_component: 3;
      readonly components: readonly {
        readonly component_id: string;
        readonly weight_basis_points: number;
        readonly criterion: string;
      }[];
    };
    readonly acceptance_fixture_commitments: Readonly<
      Record<AcceptanceFixtureClass, AcceptanceFixtureCommitment>
    >;
  };
  readonly tags: readonly string[];
  readonly visibility: 'hidden';
  readonly provenance: {
    readonly origin: 'calibration_driven_redesign';
    readonly owner: 'AIQ benchmark maintainers';
    readonly recorded_date: '2026-08-02';
    readonly predecessor_task_version: '1.0.1';
    readonly source: 'scripts/candidates/aiq-core-1.0.2/generate-benchmark-catalog.ts';
  };
  readonly leakage_review: {
    readonly status: 'public_design_versioned_private_content_required';
    readonly owner: 'AIQ benchmark maintainers';
    readonly review_requirement: 'private_corpus_tests_and_catalog_binding_required';
    readonly notes: string;
  };
}

type AcceptanceFixtureClass =
  | 'gold'
  | 'alternate_correct'
  | 'partial_low'
  | 'partial_high'
  | 'near_miss'
  | 'paired_contrast'
  // This combined class covers adversarial content and output-format attacks.
  | 'adversarial_format'
  | 'empty'
  | 'timeout';

interface AcceptanceFixtureCommitment {
  readonly handle: string;
  readonly status: 'required_in_controlled_source';
}

export const AIQ_CORE_V1_TASK_METADATA_IDENTITY_SHA256 =
  'sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937';
export const AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256 =
  'sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b';

const TASK_SET_VERSION = '1.0.2';
const TASK_VERSION = '1.0.2';
const SCORER_VERSION = '1.0.2';

export const COMMAND_EXECUTION_DISCLOSURE =
  'Runner/verifier telemetry records at least one command_execution event; this proves presence, not causality, while independently checked artifacts and, where present, receipts prove final-state correctness.';

export interface Catalog {
  readonly schema_version: 'aiq.catalog.v1';
  readonly task_set_id: 'aiq-core';
  readonly task_set_version: typeof TASK_SET_VERSION;
  readonly title: string;
  readonly status: 'candidate_requires_controlled_release_gate';
  readonly generated_from: string;
  readonly predecessor_catalog: {
    readonly task_set_version: '1.0.1';
    readonly task_identity_digest: 'sha256:b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc';
    readonly digest_scope: 'ordered_full_task_metadata';
    readonly source_commit: '4700e4c6e5e46ff9b3451d87b8761fb8da8365a0';
  };
  readonly task_metadata_identity: {
    readonly algorithm: 'sha256';
    readonly canonicalization: 'aiq.sorted-key-json.v1';
    readonly digest: string;
    readonly scope: 'ordered_full_task_metadata';
  };
  readonly catalog_release_identity: {
    readonly algorithm: 'sha256';
    readonly canonicalization: 'aiq.sorted-key-json.v1';
    readonly digest: string;
    readonly scope: 'task_metadata_identity_release_policy_and_predecessor';
  };
  readonly content_policy: {
    readonly public_repository: string;
    readonly controlled_source: string;
  };
  readonly distribution: {
    readonly total: number;
    readonly domains: Readonly<Record<Domain, number>>;
    readonly difficulties: Readonly<Record<Difficulty, number>>;
    readonly domain_difficulty: Readonly<Record<Domain, Readonly<Record<Difficulty, number>>>>;
    readonly difficulty_role: string;
  };
  readonly release_gate_policy: ReleaseGatePolicy;
  readonly tasks: readonly CatalogTask[];
}

export interface ReleaseGatePolicy {
  readonly policy_version: 'aiq.release-gate.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly state: 'preregistered_not_evaluated';
  readonly evidence_requirement: 'new_controlled_hidden_corpus';
  readonly trust_root_requirement: 'runtime_pinned_out_of_band_digest';
  readonly score_bands: {
    readonly floor_max: 0.1;
    readonly mid_min: 0.2;
    readonly mid_max: 0.8;
    readonly ceiling_min: 0.9;
    readonly invariant_range_max: 0.05;
  };
  readonly aggregate_thresholds: {
    readonly infrastructure_failures_max: 0;
    readonly evaluator_failures_max: 0;
    readonly floor_tasks_max: 7;
    readonly ceiling_tasks_max: 7;
    readonly mid_band_tasks_min: 43;
    readonly invariant_tasks_max: 14;
  };
  readonly domain_thresholds: {
    readonly mid_band_share_min: 0.5;
    readonly floor_share_max: 0.3;
    readonly ceiling_share_max: 0.3;
  };
  readonly paired_contrast_thresholds: {
    readonly predeclared_contrasts_min: 3;
    readonly directional_difference_aiq_min: 3;
    readonly adjusted_lower_bound_must_exclude_zero: true;
    readonly adjusted_lower_bound_method: 'model_clustered_one_sided_bonferroni_normal_approximation';
    readonly familywise_alpha: 0.05;
    readonly one_sided_critical_value: 2.128;
  };
  readonly predeclared_contrasts: readonly {
    readonly contrast_id: string;
    readonly expected_direction: 'reference_higher';
    readonly paired_factor: string;
    readonly controlled_pair_requirement: string;
  }[];
  readonly stability_thresholds: {
    readonly complete_repeats_min: 3;
    readonly aggregate_sd_aiq_max: 2;
    readonly median_cell_range_max: 0.1;
    readonly icc_min: 0.75;
  };
}

export interface ReleaseGateEvidence {
  readonly schema_version: 'aiq.release-gate-evidence.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly catalog_release_identity_digest: string;
  readonly task_metadata_identity_digest: string;
  readonly corpus_commitment_digest: string;
  readonly model_matrix_digest: string;
  readonly source_observations_digest: string;
  readonly authority_digest: string;
  readonly admission_digest: string;
  readonly execution_plan_digest: string;
  readonly model_id_mapping_digest: string;
  readonly collected_at: string;
  readonly repeat_ids: readonly string[];
  readonly raw_cells: readonly ReleaseGateRawCell[];
  readonly paired_contrasts: readonly {
    readonly contrast_id: string;
    readonly reference_variant_digest: string;
    readonly challenge_variant_digest: string;
    readonly pairs: readonly {
      readonly repeat_id: string;
      readonly model_id: string;
      readonly reference_score: number;
      readonly challenge_score: number;
      readonly reference_result_digest: string;
      readonly reference_result_package_digest: string;
      readonly reference_verifier_attestation_digest: string;
      readonly challenge_result_digest: string;
      readonly challenge_result_package_digest: string;
      readonly challenge_verifier_attestation_digest: string;
    }[];
  }[];
}

export interface ReleaseGateRawCell {
  readonly universe_slot: number;
  readonly repeat_id: string;
  readonly task_id: string;
  readonly domain: Domain;
  readonly model_id: string;
  readonly status: ReleaseGateRawCellStatus;
  readonly reported_score: number | null;
  readonly components: readonly ComponentEvidence[] | null;
  readonly evaluator_digest: string | null;
  readonly result_digest: string | null;
  readonly result_package_digest: string | null;
  readonly verification_digest: string | null;
  readonly cell_evidence_binding_digest: string | null;
  readonly verification_status: 'verified' | 'failed';
  readonly attempts: readonly ReleaseGateAttempt[];
}

export type ReleaseGateRawCellStatus =
  | 'completed'
  | 'infrastructure_failure'
  | 'model_failure'
  | 'evaluator_failure'
  | 'unsupported'
  | 'unevaluated';

export type ReleaseGateAttemptDisposition =
  | 'completed'
  | 'infrastructure_retryable'
  | 'infrastructure_terminal'
  | 'model_failure'
  | 'evaluator_failure'
  | 'unsupported'
  | 'unevaluated';

export interface ReleaseGateAttempt {
  readonly attempt_number: number;
  readonly scheduled_delay_seconds: 0 | 30 | 90;
  /** Logical attempt time fixed by the signed repeat schedule and retry policy. */
  readonly scheduled_for: string;
  /** Actual start of the unit-level execution attempt that contains this cell. Cells in one unit can share this value. */
  readonly started_at: string;
  /** Whether this cell crossed the model-execution boundary during the unit attempt. */
  readonly model_started: boolean;
  readonly disposition: ReleaseGateAttemptDisposition;
  readonly infrastructure_classification: 'pre_model_admission' | null;
  readonly result_digest: string | null;
  readonly result_package_digest: string | null;
  readonly verifier_attestation_digest: string | null;
}

export interface ComponentEvidence {
  readonly component_id: 'component_01' | 'component_02' | 'component_03' | 'component_04';
  readonly assertions: readonly {
    readonly assertion_id: string;
    readonly passed: boolean;
    readonly evidence_digest: string;
  }[];
  readonly weight_basis_points: 3000 | 2500 | 2000;
  readonly passed_assertions: number;
  readonly total_assertions: number;
}

export interface ModelMatrixConfiguration {
  readonly model_id: string;
  readonly family: 'sol' | 'terra' | 'luna';
  readonly reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  readonly execution_model_id: string;
}

export const FIXED_MODEL_MATRIX_IDENTITIES = [
  { model_id: 'sol-low', family: 'sol', reasoning_effort: 'low' },
  { model_id: 'sol-medium', family: 'sol', reasoning_effort: 'medium' },
  { model_id: 'sol-high', family: 'sol', reasoning_effort: 'high' },
  { model_id: 'sol-xhigh', family: 'sol', reasoning_effort: 'xhigh' },
  { model_id: 'sol-max', family: 'sol', reasoning_effort: 'max' },
  { model_id: 'sol-ultra', family: 'sol', reasoning_effort: 'ultra' },
  { model_id: 'terra-low', family: 'terra', reasoning_effort: 'low' },
  { model_id: 'terra-medium', family: 'terra', reasoning_effort: 'medium' },
  { model_id: 'terra-high', family: 'terra', reasoning_effort: 'high' },
  { model_id: 'terra-xhigh', family: 'terra', reasoning_effort: 'xhigh' },
  { model_id: 'terra-max', family: 'terra', reasoning_effort: 'max' },
  { model_id: 'terra-ultra', family: 'terra', reasoning_effort: 'ultra' },
  { model_id: 'luna-low', family: 'luna', reasoning_effort: 'low' },
  { model_id: 'luna-medium', family: 'luna', reasoning_effort: 'medium' },
  { model_id: 'luna-high', family: 'luna', reasoning_effort: 'high' },
  { model_id: 'luna-xhigh', family: 'luna', reasoning_effort: 'xhigh' },
  { model_id: 'luna-max', family: 'luna', reasoning_effort: 'max' },
] as const;

export const MODEL_EXECUTION_ID_MAPPING = FIXED_MODEL_MATRIX_IDENTITIES.map(
  ({ model_id: modelId }) => ({
    canonical_model_id: modelId,
    execution_model_id: `gpt-5.6-${modelId}`,
  }),
);

export interface ExecutionModelSelection {
  readonly base_model: 'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna';
  readonly reasoning_effort: ModelMatrixConfiguration['reasoning_effort'];
}

export function resolveExecutionModelId(executionModelId: string): ExecutionModelSelection {
  const mappingIndex = MODEL_EXECUTION_ID_MAPPING.findIndex(
    ({ execution_model_id: candidate }) => candidate === executionModelId,
  );
  const identity = FIXED_MODEL_MATRIX_IDENTITIES[mappingIndex];
  if (identity === undefined) {
    throw new Error(`Unknown candidate execution model ID: ${executionModelId}.`);
  }
  return {
    base_model: `gpt-5.6-${identity.family}`,
    reasoning_effort: identity.reasoning_effort,
  };
}

export interface ReleaseGateAdmission {
  readonly schema_version: 'aiq.release-gate-admission.v1';
  readonly signature_domain: 'aiq.release-gate-admission.v1';
  readonly signature_encoding: 'aiq.sorted-key-json.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly catalog_release_identity_digest: string;
  readonly task_metadata_identity_digest: string;
  readonly corpus_commitment_digest: string;
  readonly plan_id: string;
  readonly execution_plan_digest: string;
  readonly model_id_mapping_digest: string;
  readonly issued_at: string;
  readonly collection_not_before: string;
  readonly collection_not_after: string;
  readonly repeat_schedule: readonly {
    readonly repeat_id: string;
    readonly scheduled_at: string;
    readonly contrast_arm_order: readonly string[];
  }[];
  readonly observation_universe: {
    readonly task_ids: readonly string[];
    readonly model_ids: readonly string[];
    readonly raw_cell_count: number;
    readonly contrast_pair_count: number;
    readonly contrast_observation_count: number;
  };
  readonly infrastructure_retry_policy: {
    readonly max_attempts: 3;
    readonly backoff_seconds: readonly [0, 30, 90];
    readonly retryable_classifications: readonly ['pre_model_admission'];
    readonly model_or_evaluator_failures_retryable: false;
  };
  readonly model_matrix: {
    readonly digest: string;
    readonly configurations: readonly ModelMatrixConfiguration[];
  };
  readonly contrast_bindings: readonly {
    readonly contrast_id: string;
    readonly reference_variant_digest: string;
    readonly challenge_variant_digest: string;
  }[];
  readonly signer: {
    readonly key_id: string;
    readonly algorithm: 'ed25519';
  };
  readonly signature: string;
}

export interface ReleaseGateAuthority {
  readonly schema_version: 'aiq.release-gate-authority.v1';
  readonly signature_domain: 'aiq.release-gate-authority.v1';
  readonly signature_encoding: 'aiq.sorted-key-json.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly catalog_release_identity_digest: string;
  readonly task_metadata_identity_digest: string;
  readonly admission_digest: string;
  readonly execution_plan_digest: string;
  readonly model_id_mapping_digest: string;
  readonly admission: ReleaseGateAdmission;
  readonly source_observations_digest: string;
  readonly signer: {
    readonly key_id: string;
    readonly algorithm: 'ed25519';
  };
  readonly signature: string;
}

export interface ReleaseGateTrustPolicy {
  readonly schema_version: 'aiq.release-gate-trust.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly authority_signers: readonly TrustedSigner[];
  readonly promotion_signers: readonly TrustedSigner[];
}

export interface ReleaseGateTrustRoot {
  readonly schema_version: 'aiq.release-gate-trust-root.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly trust_policy_digest: string;
}

export const RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT = 'AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256';
export const CANDIDATE_MODEL_MATRIX_SHA256 =
  'sha256:c385d79e02d233b4594800a66199c2da59e8f6fd623fb808812a669ccba29757';

interface TrustedSigner {
  readonly key_id: string;
  readonly algorithm: 'ed25519';
  readonly public_key_spki_base64: string;
  readonly public_key_fingerprint: string;
}

export interface PromotionReceipt {
  readonly schema_version: 'aiq.promotion-receipt.v1';
  readonly signature_domain: 'aiq.promotion-receipt.v1';
  readonly signature_encoding: 'aiq.sorted-key-json.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly candidate_catalog_release_identity_digest: string;
  readonly task_metadata_identity_digest: string;
  readonly authority_digest: string;
  readonly evidence_digest: string;
  readonly gate_result_digest: string;
  readonly promotion_state: 'released';
  readonly issued_at: string;
  readonly signer: {
    readonly key_id: string;
    readonly algorithm: 'ed25519';
  };
  readonly signature: string;
}

export interface ReleaseGateResult {
  readonly schema_version: 'aiq.release-gate-result.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly candidate_status: 'candidate_requires_controlled_release_gate';
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly authority_digest: string;
  readonly evidence_digest: string;
  readonly plan_id: string;
}

const PROFILES: Readonly<Record<Domain, DomainProfile>> = {
  coding: { allowedTools: ['filesystem_read', 'filesystem_write'] },
  debugging: { allowedTools: ['filesystem_read', 'filesystem_write'] },
  repository_understanding: { allowedTools: ['filesystem_read'] },
  data_processing: { allowedTools: ['filesystem_read', 'filesystem_write'] },
  retrieval_verification: { allowedTools: ['filesystem_read', 'filesystem_write'] },
  documentation_communication: { allowedTools: ['filesystem_read', 'filesystem_write'] },
  planning_execution: { allowedTools: ['filesystem_read', 'filesystem_write'] },
  tool_use: {
    allowedTools: ['filesystem_read', 'filesystem_write', 'command_execution'],
  },
  instruction_following: { allowedTools: ['filesystem_read', 'filesystem_write'] },
  reliability_recovery: { allowedTools: ['filesystem_read', 'filesystem_write'] },
};

const PRIOR_FLOOR_TASKS = new Set([
  'data-processing-02',
  'debugging-02',
  'debugging-05',
  'documentation-communication-03',
  'documentation-communication-04',
  'documentation-communication-05',
  'documentation-communication-06',
  'documentation-communication-07',
  'instruction-following-03',
  'instruction-following-04',
  'reliability-recovery-04',
  'reliability-recovery-06',
  'repository-understanding-01',
  'repository-understanding-05',
  'repository-understanding-06',
  'repository-understanding-07',
  'retrieval-verification-02',
  'retrieval-verification-05',
  'tool-use-01',
  'tool-use-07',
]);

const PRIOR_CEILING_TASKS = new Set([
  'planning-execution-05',
  'data-processing-05',
  'repository-understanding-03',
  'coding-03',
  'data-processing-04',
  'instruction-following-06',
  'planning-execution-07',
  'tool-use-03',
  'tool-use-05',
  'debugging-08',
  'instruction-following-05',
  'reliability-recovery-05',
  'coding-01',
  'coding-02',
  'coding-05',
  'coding-06',
  'coding-07',
  'debugging-01',
  'debugging-03',
  'debugging-04',
  'instruction-following-01',
  'instruction-following-02',
  'planning-execution-01',
  'planning-execution-03',
  'planning-execution-06',
  'reliability-recovery-01',
  'reliability-recovery-03',
]);

const DISCRIMINATION_CHECK: Readonly<Record<Domain, string>> = {
  coding:
    'Seeded near-miss implementations separate core correctness, boundary behavior, and regression preservation.',
  debugging:
    'Seeded plausible fixes separate symptom suppression, root-cause repair, and preservation of adjacent behavior.',
  repository_understanding:
    'Seeded partial inventories separate locally plausible answers from complete, source-linked ownership traces.',
  data_processing:
    'Seeded partial outputs separate row-level correctness, reconciliation, and policy-compliant edge handling.',
  retrieval_verification:
    'Seeded claim variants separate source selection, exact support, scope preservation, and calibrated uncertainty.',
  documentation_communication:
    'Seeded drafts separate factual completeness, audience fit, operational usability, and unsupported claims.',
  planning_execution:
    'Seeded plans separate feasibility, dependency safety, rollback preservation, and executable evidence.',
  tool_use:
    'Seeded traces separate tool invocation from correct selection, bounded execution, and artifact-backed results.',
  instruction_following:
    'Seeded outputs separate primary-task success, constraint coverage, precedence handling, and prohibited actions.',
  reliability_recovery:
    'Seeded states separate safe continuation, identity preservation, reconciliation, and replay correctness.',
};

export const RELEASE_GATE_POLICY: ReleaseGatePolicy = {
  policy_version: 'aiq.release-gate.v1',
  release_identity: 'aiq-core/1.0.2',
  state: 'preregistered_not_evaluated',
  evidence_requirement: 'new_controlled_hidden_corpus',
  trust_root_requirement: 'runtime_pinned_out_of_band_digest',
  score_bands: {
    floor_max: 0.1,
    mid_min: 0.2,
    mid_max: 0.8,
    ceiling_min: 0.9,
    invariant_range_max: 0.05,
  },
  aggregate_thresholds: {
    infrastructure_failures_max: 0,
    evaluator_failures_max: 0,
    floor_tasks_max: 7,
    ceiling_tasks_max: 7,
    mid_band_tasks_min: 43,
    invariant_tasks_max: 14,
  },
  domain_thresholds: {
    mid_band_share_min: 0.5,
    floor_share_max: 0.3,
    ceiling_share_max: 0.3,
  },
  paired_contrast_thresholds: {
    predeclared_contrasts_min: 3,
    directional_difference_aiq_min: 3,
    adjusted_lower_bound_must_exclude_zero: true,
    adjusted_lower_bound_method: 'model_clustered_one_sided_bonferroni_normal_approximation',
    familywise_alpha: 0.05,
    one_sided_critical_value: 2.128,
  },
  predeclared_contrasts: [
    {
      contrast_id: 'coupled_constraints',
      expected_direction: 'reference_higher',
      paired_factor:
        'One controlled pair adds interacting constraints while keeping the core work and scoring scale fixed.',
      controlled_pair_requirement:
        'Bind matched task variants, use the preregistered deterministic counterbalanced arm order, and compute the paired AIQ difference across the fixed model matrix.',
    },
    {
      contrast_id: 'ambiguous_recovery_state',
      expected_direction: 'reference_higher',
      paired_factor:
        'One controlled pair changes a complete checkpoint into an ambiguous but recoverable state.',
      controlled_pair_requirement:
        'Use the preregistered deterministic counterbalanced arm order, keep the intended final state fixed, and score safe state reconciliation separately from core task completion.',
    },
    {
      contrast_id: 'plausible_incomplete_evidence',
      expected_direction: 'reference_higher',
      paired_factor:
        'One controlled pair replaces complete evidence with a plausible but materially incomplete evidence set.',
      controlled_pair_requirement:
        'Use the preregistered deterministic counterbalanced arm order, keep requested claims fixed, and score unsupported inference separately from citation and artifact format.',
    },
  ],
  stability_thresholds: {
    complete_repeats_min: 3,
    aggregate_sd_aiq_max: 2,
    median_cell_range_max: 0.1,
    icc_min: 0.75,
  },
};

export const PREDECESSOR_CATALOG: Catalog['predecessor_catalog'] = {
  task_set_version: '1.0.1',
  task_identity_digest: 'sha256:b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc',
  digest_scope: 'ordered_full_task_metadata',
  source_commit: '4700e4c6e5e46ff9b3451d87b8761fb8da8365a0',
};

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  );
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function validUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function absoluteAgreementIcc(rows: readonly (readonly number[])[]): number {
  const targetCount = rows.length;
  const repeatCount = rows[0]?.length ?? 0;
  if (targetCount < 2 || repeatCount < 2 || rows.some((row) => row.length !== repeatCount)) {
    return Number.NaN;
  }
  const rowMeans = rows.map(mean);
  const columnMeans = Array.from({ length: repeatCount }, (_, column) =>
    mean(rows.map((row) => row[column] ?? 0)),
  );
  const grandMean = mean(rowMeans);
  const rowMeanSquare =
    (repeatCount * rowMeans.reduce((sum, value) => sum + (value - grandMean) ** 2, 0)) /
    (targetCount - 1);
  const columnMeanSquare =
    (targetCount * columnMeans.reduce((sum, value) => sum + (value - grandMean) ** 2, 0)) /
    (repeatCount - 1);
  const errorMeanSquare =
    rows.reduce(
      (sum, row, rowIndex) =>
        sum +
        row.reduce(
          (rowSum, value, columnIndex) =>
            rowSum +
            (value - (rowMeans[rowIndex] ?? 0) - (columnMeans[columnIndex] ?? 0) + grandMean) ** 2,
          0,
        ),
      0,
    ) /
    ((targetCount - 1) * (repeatCount - 1));
  const denominator =
    rowMeanSquare +
    (repeatCount - 1) * errorMeanSquare +
    (repeatCount * (columnMeanSquare - errorMeanSquare)) / targetCount;
  return denominator === 0 ? Number.NaN : (rowMeanSquare - errorMeanSquare) / denominator;
}

export function releaseEvidenceSourceDigest(
  rawCells: ReleaseGateEvidence['raw_cells'],
  pairedContrasts: ReleaseGateEvidence['paired_contrasts'],
): string {
  return digestValue({ raw_cells: rawCells, paired_contrasts: pairedContrasts });
}

export function releaseEvidenceModelMatrixDigest(
  configurations: readonly ModelMatrixConfiguration[],
): string {
  return digestValue(
    configurations.toSorted((left, right) =>
      left.model_id < right.model_id ? -1 : left.model_id > right.model_id ? 1 : 0,
    ),
  );
}

export function releaseModelIdMappingDigest(): string {
  return digestValue(MODEL_EXECUTION_ID_MAPPING);
}

export function releaseCellEvidenceBindingDigest(cell: unknown): string {
  return digestValue({
    schema_version: 'aiq.release-cell-evidence-binding.v1',
    release_identity: 'aiq-core/1.0.2',
    cell,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(',')}}`;
  }
  throw new TypeError('Canonical JSON does not support this value.');
}

function digestValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function unsignedAuthority(
  authority: ReleaseGateAuthority,
): Omit<ReleaseGateAuthority, 'signature'> {
  const { signature: _signature, ...unsigned } = authority;
  return unsigned;
}

function unsignedAdmission(
  admission: ReleaseGateAdmission,
): Omit<ReleaseGateAdmission, 'signature'> {
  const { signature: _signature, ...unsigned } = admission;
  return unsigned;
}

function unsignedPromotionReceipt(receipt: PromotionReceipt): Omit<PromotionReceipt, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

export function releaseAuthoritySigningBytes(authority: ReleaseGateAuthority): Buffer {
  return Buffer.from(canonicalJson(unsignedAuthority(authority)), 'utf8');
}

export function releaseAdmissionSigningBytes(admission: ReleaseGateAdmission): Buffer {
  return Buffer.from(canonicalJson(unsignedAdmission(admission)), 'utf8');
}

export function releaseAdmissionDigest(admission: ReleaseGateAdmission): string {
  return digestValue(admission);
}

export function promotionReceiptSigningBytes(receipt: PromotionReceipt): Buffer {
  return Buffer.from(canonicalJson(unsignedPromotionReceipt(receipt)), 'utf8');
}

export function releaseAuthorityDigest(authority: ReleaseGateAuthority): string {
  return digestValue(authority);
}

export function releaseEvidenceDigest(evidence: ReleaseGateEvidence): string {
  return digestValue(evidence);
}

export function releaseGateResultDigest(result: ReleaseGateResult): string {
  return digestValue(result);
}

export function releaseGateTrustPolicyDigest(policy: ReleaseGateTrustPolicy): string {
  return digestValue(policy);
}

export function runtimePinnedReleaseGateTrustRoot(
  trustPolicy: ReleaseGateTrustPolicy,
): ReleaseGateTrustRoot {
  const pinnedDigest = process.env[RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT];
  if (pinnedDigest === undefined) {
    throw new Error(
      `Missing protected runtime trust anchor ${RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT}.`,
    );
  }
  if (!/^sha256:(?!0{64}$)[a-f0-9]{64}$/u.test(pinnedDigest)) {
    throw new Error(
      `${RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT} must contain one canonical nonzero SHA-256 digest.`,
    );
  }
  if (releaseGateTrustPolicyDigest(trustPolicy) !== pinnedDigest) {
    throw new Error('The trust policy does not match the independently pinned runtime anchor.');
  }
  return {
    schema_version: 'aiq.release-gate-trust-root.v1',
    release_identity: 'aiq-core/1.0.2',
    trust_policy_digest: pinnedDigest,
  };
}

function trustedSigner(
  signers: readonly TrustedSigner[],
  keyId: string,
): TrustedSigner | undefined {
  if (new Set(signers.map(({ key_id: candidate }) => candidate)).size !== signers.length) {
    return undefined;
  }
  return signers.find(({ key_id: candidate }) => candidate === keyId);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(expected.toSorted());
}

function signerShapeIsClosed(signer: ReleaseGateAuthority['signer'] | TrustedSigner): boolean {
  const expected =
    'public_key_spki_base64' in signer
      ? ['algorithm', 'key_id', 'public_key_fingerprint', 'public_key_spki_base64']
      : ['algorithm', 'key_id'];
  return hasExactKeys(signer, expected);
}

function trustedSignerFingerprint(signer: TrustedSigner): string | null {
  try {
    const der = Buffer.from(signer.public_key_spki_base64, 'base64');
    if (
      signer.algorithm !== 'ed25519' ||
      !/^[a-z0-9][a-z0-9._-]*$/u.test(signer.key_id) ||
      der.toString('base64') !== signer.public_key_spki_base64
    )
      return null;
    const publicKey = createPublicKey({
      key: der,
      format: 'der',
      type: 'spki',
    });
    if (publicKey.asymmetricKeyType !== 'ed25519') return null;
    const observed = `sha256:${createHash('sha256')
      .update(publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex')}`;
    return signer.public_key_fingerprint === observed ? observed : null;
  } catch {
    return null;
  }
}

function authorityShapeIsClosed(authority: ReleaseGateAuthority): boolean {
  return (
    hasExactKeys(authority, [
      'admission',
      'admission_digest',
      'catalog_release_identity_digest',
      'execution_plan_digest',
      'model_id_mapping_digest',
      'release_identity',
      'schema_version',
      'signature',
      'signature_domain',
      'signature_encoding',
      'signer',
      'source_observations_digest',
      'task_metadata_identity_digest',
    ]) &&
    admissionShapeIsClosed(authority.admission) &&
    signerShapeIsClosed(authority.signer)
  );
}

function admissionShapeIsClosed(admission: ReleaseGateAdmission): boolean {
  return (
    hasExactKeys(admission, [
      'catalog_release_identity_digest',
      'collection_not_after',
      'collection_not_before',
      'contrast_bindings',
      'corpus_commitment_digest',
      'issued_at',
      'infrastructure_retry_policy',
      'execution_plan_digest',
      'model_matrix',
      'model_id_mapping_digest',
      'observation_universe',
      'plan_id',
      'release_identity',
      'repeat_schedule',
      'schema_version',
      'signature',
      'signature_domain',
      'signature_encoding',
      'signer',
      'task_metadata_identity_digest',
    ]) &&
    hasExactKeys(admission.observation_universe, [
      'contrast_pair_count',
      'contrast_observation_count',
      'model_ids',
      'raw_cell_count',
      'task_ids',
    ]) &&
    hasExactKeys(admission.infrastructure_retry_policy, [
      'backoff_seconds',
      'max_attempts',
      'model_or_evaluator_failures_retryable',
      'retryable_classifications',
    ]) &&
    admission.repeat_schedule.every((entry) =>
      hasExactKeys(entry, ['contrast_arm_order', 'repeat_id', 'scheduled_at']),
    ) &&
    hasExactKeys(admission.model_matrix, ['configurations', 'digest']) &&
    admission.model_matrix.configurations.every((configuration) =>
      hasExactKeys(configuration, ['family', 'execution_model_id', 'model_id', 'reasoning_effort']),
    ) &&
    admission.contrast_bindings.every((binding) =>
      hasExactKeys(binding, [
        'challenge_variant_digest',
        'contrast_id',
        'reference_variant_digest',
      ]),
    ) &&
    signerShapeIsClosed(admission.signer)
  );
}

function verifyEd25519(
  bytes: Buffer,
  signature: string,
  signer: TrustedSigner | undefined,
): boolean {
  if (signer === undefined || signer.algorithm !== 'ed25519') return false;
  try {
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) {
      return false;
    }
    const publicKey = createPublicKey({
      key: Buffer.from(signer.public_key_spki_base64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return (
      publicKey.asymmetricKeyType === 'ed25519' && verify(null, bytes, publicKey, signatureBytes)
    );
  } catch {
    return false;
  }
}

function authorityIsTrusted(
  authority: ReleaseGateAuthority,
  trustPolicy: ReleaseGateTrustPolicy,
): boolean {
  const authorityKeyIds = new Set(trustPolicy.authority_signers.map(({ key_id: keyId }) => keyId));
  const authorityFingerprints = trustPolicy.authority_signers.map(trustedSignerFingerprint);
  const promotionFingerprints = trustPolicy.promotion_signers.map(trustedSignerFingerprint);
  const allKeyIds = [...trustPolicy.authority_signers, ...trustPolicy.promotion_signers].map(
    ({ key_id: keyId }) => keyId,
  );
  return (
    authorityShapeIsClosed(authority) &&
    trustPolicy.schema_version === 'aiq.release-gate-trust.v1' &&
    trustPolicy.release_identity === authority.release_identity &&
    hasExactKeys(trustPolicy, [
      'authority_signers',
      'promotion_signers',
      'release_identity',
      'schema_version',
    ]) &&
    trustPolicy.authority_signers.length > 0 &&
    trustPolicy.promotion_signers.length > 0 &&
    new Set(allKeyIds).size === allKeyIds.length &&
    [...trustPolicy.authority_signers, ...trustPolicy.promotion_signers].every(
      signerShapeIsClosed,
    ) &&
    trustPolicy.promotion_signers.every(({ key_id: keyId }) => !authorityKeyIds.has(keyId)) &&
    authorityFingerprints.every((fingerprint) => fingerprint !== null) &&
    promotionFingerprints.every((fingerprint) => fingerprint !== null) &&
    new Set(authorityFingerprints).size === authorityFingerprints.length &&
    new Set(promotionFingerprints).size === promotionFingerprints.length &&
    promotionFingerprints.every((fingerprint) => !authorityFingerprints.includes(fingerprint)) &&
    authority.schema_version === 'aiq.release-gate-authority.v1' &&
    authority.signature_domain === authority.schema_version &&
    authority.signature_encoding === 'aiq.sorted-key-json.v1' &&
    authority.admission.schema_version === 'aiq.release-gate-admission.v1' &&
    authority.admission.signature_domain === authority.admission.schema_version &&
    authority.admission.signature_encoding === 'aiq.sorted-key-json.v1' &&
    authority.admission_digest === releaseAdmissionDigest(authority.admission) &&
    verifyEd25519(
      releaseAdmissionSigningBytes(authority.admission),
      authority.admission.signature,
      trustedSigner(trustPolicy.authority_signers, authority.admission.signer.key_id),
    ) &&
    authority.signer.algorithm === 'ed25519' &&
    verifyEd25519(
      releaseAuthoritySigningBytes(authority),
      authority.signature,
      trustedSigner(trustPolicy.authority_signers, authority.signer.key_id),
    )
  );
}

function trustRootIsValid(
  trustPolicy: ReleaseGateTrustPolicy,
  runtimePinnedTrustRoot: ReleaseGateTrustRoot,
): boolean {
  return (
    hasExactKeys(runtimePinnedTrustRoot, [
      'release_identity',
      'schema_version',
      'trust_policy_digest',
    ]) &&
    runtimePinnedTrustRoot.schema_version === 'aiq.release-gate-trust-root.v1' &&
    runtimePinnedTrustRoot.release_identity === trustPolicy.release_identity &&
    validDigest(runtimePinnedTrustRoot.trust_policy_digest) &&
    runtimePinnedTrustRoot.trust_policy_digest === releaseGateTrustPolicyDigest(trustPolicy)
  );
}

const COMPONENT_WEIGHTS = new Map([
  ['component_01', 3000],
  ['component_02', 2500],
  ['component_03', 2500],
  ['component_04', 2000],
] as const);

function derivedTaskScore(components: readonly ComponentEvidence[] | null): number | null {
  if (
    components === null ||
    components.length !== COMPONENT_WEIGHTS.size ||
    components.some(
      ({ component_id: componentId }, index) =>
        componentId !== [...COMPONENT_WEIGHTS.keys()][index],
    )
  ) {
    return null;
  }
  let score = 0;
  for (const component of components) {
    if (
      !hasExactKeys(component, [
        'assertions',
        'component_id',
        'passed_assertions',
        'total_assertions',
        'weight_basis_points',
      ])
    )
      return null;
    const assertionIds = component.assertions.map(({ assertion_id: assertionId }) => assertionId);
    if (
      component.assertions.length < 3 ||
      component.weight_basis_points !== COMPONENT_WEIGHTS.get(component.component_id) ||
      component.total_assertions !== component.assertions.length ||
      component.passed_assertions !==
        component.assertions.filter(({ passed: didPass }) => didPass).length ||
      new Set(assertionIds).size !== assertionIds.length ||
      assertionIds.some((assertionId, index) => assertionId !== publicAssertionId(index)) ||
      component.assertions.some(
        (assertion) =>
          !hasExactKeys(assertion, ['assertion_id', 'evidence_digest', 'passed']) ||
          typeof assertion.passed !== 'boolean' ||
          !validDigest(assertion.evidence_digest),
      )
    ) {
      return null;
    }
    const passed = component.assertions.filter(({ passed: didPass }) => didPass).length;
    score +=
      ((COMPONENT_WEIGHTS.get(component.component_id) ?? 0) / 10_000) *
      (passed / component.assertions.length);
  }
  return Math.round((score + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function publicAssertionId(index: number): string {
  return `assertion_${String(index + 1).padStart(3, '0')}`;
}

function validDigest(value: string): boolean {
  return /^sha256:(?!0{64}$)[a-f0-9]{64}$/u.test(value);
}

function validIdentifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function validCanonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function promotionReceiptIssuedAtIsCausal(
  issuedAt: string,
  evidenceCollectedAt: string,
): boolean {
  return (
    validCanonicalTimestamp(issuedAt) &&
    validCanonicalTimestamp(evidenceCollectedAt) &&
    Date.parse(issuedAt) >= Date.parse(evidenceCollectedAt)
  );
}

function isReleaseAttemptArray(value: unknown): value is ReleaseGateRawCell['attempts'] {
  return Array.isArray(value);
}

function releaseAttemptHasNoProvenance(attempt: ReleaseGateAttempt): boolean {
  return (
    attempt.result_digest === null &&
    attempt.result_package_digest === null &&
    attempt.verifier_attestation_digest === null
  );
}

function releaseAttemptTimingIsValid(
  attempt: ReleaseGateAttempt,
  expectedDelaySeconds: number | undefined,
  repeatScheduledAt: string | undefined,
  nextRepeatScheduledAt: string | undefined,
  collectionNotBefore: string,
  collectionNotAfter: string,
  previousStartedAt: string | undefined,
): boolean {
  if (
    expectedDelaySeconds === undefined ||
    repeatScheduledAt === undefined ||
    !validCanonicalTimestamp(repeatScheduledAt) ||
    (nextRepeatScheduledAt !== undefined && !validCanonicalTimestamp(nextRepeatScheduledAt)) ||
    !validCanonicalTimestamp(collectionNotBefore) ||
    !validCanonicalTimestamp(collectionNotAfter) ||
    !validCanonicalTimestamp(attempt.scheduled_for) ||
    !validCanonicalTimestamp(attempt.started_at) ||
    (previousStartedAt !== undefined && !validCanonicalTimestamp(previousStartedAt))
  ) {
    return false;
  }

  const scheduledFor = Date.parse(attempt.scheduled_for);
  const startedAt = Date.parse(attempt.started_at);
  const repeatStart = Date.parse(repeatScheduledAt);
  const collectionStart = Date.parse(collectionNotBefore);
  const collectionEnd = Date.parse(collectionNotAfter);
  return (
    attempt.scheduled_delay_seconds === expectedDelaySeconds &&
    scheduledFor === repeatStart + expectedDelaySeconds * 1000 &&
    startedAt >= scheduledFor &&
    startedAt >= repeatStart &&
    startedAt >= collectionStart &&
    startedAt <= collectionEnd &&
    (nextRepeatScheduledAt === undefined || startedAt < Date.parse(nextRepeatScheduledAt)) &&
    (previousStartedAt === undefined || startedAt > Date.parse(previousStartedAt))
  );
}

function releaseTerminalAttemptMatchesStatus(
  status: string,
  attempt: ReleaseGateAttempt,
  resultDigest: string | null,
  resultPackageDigest: string | null,
  verificationDigest: string | null,
  retryableInfrastructureClassifications: readonly string[],
): boolean {
  switch (status) {
    case 'completed':
      return (
        attempt.disposition === 'completed' &&
        attempt.model_started &&
        attempt.infrastructure_classification === null &&
        attempt.result_digest === resultDigest &&
        attempt.result_package_digest === resultPackageDigest &&
        attempt.verifier_attestation_digest === verificationDigest
      );
    case 'infrastructure_failure':
      return (
        attempt.disposition === 'infrastructure_terminal' &&
        !attempt.model_started &&
        attempt.infrastructure_classification !== null &&
        retryableInfrastructureClassifications.includes(attempt.infrastructure_classification) &&
        releaseAttemptHasNoProvenance(attempt)
      );
    case 'model_failure':
      return (
        attempt.disposition === 'model_failure' &&
        attempt.infrastructure_classification === null &&
        releaseAttemptHasNoProvenance(attempt)
      );
    case 'evaluator_failure':
      return (
        attempt.disposition === 'evaluator_failure' &&
        attempt.model_started &&
        attempt.infrastructure_classification === null &&
        releaseAttemptHasNoProvenance(attempt)
      );
    case 'unsupported':
      return (
        attempt.disposition === 'unsupported' &&
        !attempt.model_started &&
        attempt.infrastructure_classification === null &&
        releaseAttemptHasNoProvenance(attempt)
      );
    case 'unevaluated':
      return (
        attempt.disposition === 'unevaluated' &&
        attempt.infrastructure_classification === null &&
        releaseAttemptHasNoProvenance(attempt)
      );
    default:
      return false;
  }
}

function expectedContrastArmOrder(repeatIndex: number): readonly string[] {
  return RELEASE_GATE_POLICY.predeclared_contrasts.flatMap(({ contrast_id: contrastId }) =>
    repeatIndex % 2 === 0
      ? [`${contrastId}:reference`, `${contrastId}:challenge`]
      : [`${contrastId}:challenge`, `${contrastId}:reference`],
  );
}

export function evaluateReleaseGate(
  evidence: ReleaseGateEvidence,
  authority: ReleaseGateAuthority,
  trustPolicy: ReleaseGateTrustPolicy,
  runtimePinnedTrustRoot: ReleaseGateTrustRoot,
): ReleaseGateResult {
  const failures: string[] = [];
  const policy = RELEASE_GATE_POLICY;
  const scoreEpsilon = 1e-12;
  const isFloor = (score: number): boolean => score <= policy.score_bands.floor_max + scoreEpsilon;
  const isCeiling = (score: number): boolean =>
    score >= policy.score_bands.ceiling_min - scoreEpsilon;
  const isMid = (score: number): boolean =>
    score >= policy.score_bands.mid_min - scoreEpsilon &&
    score <= policy.score_bands.mid_max + scoreEpsilon;
  const catalog = buildCatalog();
  const admission = authority.admission;
  const expectedTasks = new Map(
    catalog.tasks.map(({ task_id: taskId, domain }) => [taskId, domain]),
  );
  const repeatIds = new Set(evidence.repeat_ids);
  const plannedRepeatIds = admission.repeat_schedule.map(({ repeat_id: repeatId }) => repeatId);
  const authorityModelIds = admission.model_matrix.configurations.map(
    ({ model_id: modelId }) => modelId,
  );
  const modelIds = new Set(authorityModelIds);
  const authorityContrastBindings = new Map(
    admission.contrast_bindings.map((binding) => [binding.contrast_id, binding]),
  );
  const boundVariantDigests = admission.contrast_bindings.flatMap(
    ({ reference_variant_digest: reference, challenge_variant_digest: challenge }) => [
      reference,
      challenge,
    ],
  );
  const cellKeys = evidence.raw_cells.map(
    ({ repeat_id: repeatId, task_id: taskId, model_id: modelId }) =>
      `${repeatId}\u0000${taskId}\u0000${modelId}`,
  );
  const expectedCellCount = 72 * 17 * 3;
  const expectedCellKeys = plannedRepeatIds.flatMap((repeatId) =>
    admission.observation_universe.task_ids.flatMap((taskId) =>
      authorityModelIds.map((modelId) => `${repeatId}\u0000${taskId}\u0000${modelId}`),
    ),
  );
  const invalidRawCell = evidence.raw_cells.some((cell, cellIndex) => {
    const {
      universe_slot: universeSlot,
      repeat_id: repeatId,
      task_id: taskId,
      domain,
      model_id: modelId,
      status,
      reported_score: reportedScore,
      components,
      evaluator_digest: evaluatorDigest,
      result_digest: resultDigest,
      result_package_digest: resultPackageDigest,
      verification_digest: verificationDigest,
      cell_evidence_binding_digest: cellEvidenceBindingDigest,
      verification_status: verificationStatus,
      attempts,
      ...unrecognizedCellFields
    } = cell;
    const { cell_evidence_binding_digest: _bindingDigest, ...unsignedCell } = cell;
    const repeatIndex = admission.repeat_schedule.findIndex(
      ({ repeat_id: scheduledRepeat }) => scheduledRepeat === repeatId,
    );
    const scheduledRepeatAt = admission.repeat_schedule[repeatIndex]?.scheduled_at;
    const nextScheduledRepeatAt = admission.repeat_schedule[repeatIndex + 1]?.scheduled_at;
    return (
      Object.keys(unrecognizedCellFields).length !== 0 ||
      universeSlot !== cellIndex + 1 ||
      !isReleaseAttemptArray(attempts) ||
      attempts.length < 1 ||
      attempts.length > admission.infrastructure_retry_policy.max_attempts ||
      attempts.some(
        (attempt, index) =>
          !hasExactKeys(attempt, [
            'attempt_number',
            'disposition',
            'infrastructure_classification',
            'result_digest',
            'result_package_digest',
            'scheduled_delay_seconds',
            'scheduled_for',
            'started_at',
            'model_started',
            'verifier_attestation_digest',
          ]) ||
          attempt.attempt_number !== index + 1 ||
          !releaseAttemptTimingIsValid(
            attempt,
            admission.infrastructure_retry_policy.backoff_seconds[index],
            scheduledRepeatAt,
            nextScheduledRepeatAt,
            admission.collection_not_before,
            admission.collection_not_after,
            attempts[index - 1]?.started_at,
          ) ||
          (index < attempts.length - 1
            ? attempt.disposition !== 'infrastructure_retryable' ||
              attempt.model_started ||
              attempt.infrastructure_classification === null ||
              !admission.infrastructure_retry_policy.retryable_classifications.includes(
                attempt.infrastructure_classification,
              ) ||
              attempt.result_digest !== null ||
              attempt.result_package_digest !== null ||
              attempt.verifier_attestation_digest !== null
            : !releaseTerminalAttemptMatchesStatus(
                status,
                attempt,
                resultDigest,
                resultPackageDigest,
                verificationDigest,
                admission.infrastructure_retry_policy.retryable_classifications,
              )),
      ) ||
      !repeatIds.has(repeatId) ||
      expectedTasks.get(taskId) !== domain ||
      !modelIds.has(modelId) ||
      (status === 'completed'
        ? reportedScore === null ||
          !validUnitInterval(reportedScore) ||
          derivedTaskScore(components) !== reportedScore ||
          evaluatorDigest === null ||
          !validDigest(evaluatorDigest) ||
          resultDigest === null ||
          !validDigest(resultDigest) ||
          resultPackageDigest === null ||
          !validDigest(resultPackageDigest) ||
          verificationDigest === null ||
          !validDigest(verificationDigest) ||
          cellEvidenceBindingDigest === null ||
          !validDigest(cellEvidenceBindingDigest) ||
          cellEvidenceBindingDigest !== releaseCellEvidenceBindingDigest(unsignedCell) ||
          verificationStatus !== 'verified'
        : reportedScore !== null ||
          components !== null ||
          evaluatorDigest !== null ||
          resultDigest !== null ||
          resultPackageDigest !== null ||
          verificationDigest !== null ||
          cellEvidenceBindingDigest !== null ||
          verificationStatus !== 'failed')
    );
  });
  const completedCellBoundDigests = evidence.raw_cells.flatMap((cell) =>
    cell.status === 'completed'
      ? [
          cell.result_digest,
          cell.result_package_digest,
          cell.verification_digest,
          cell.cell_evidence_binding_digest,
        ].filter((digest): digest is string => digest !== null)
      : [],
  );
  const contrastCellBoundDigests = evidence.paired_contrasts.flatMap(({ pairs }) =>
    pairs.flatMap((pair) => [
      pair.reference_result_digest,
      pair.reference_result_package_digest,
      pair.reference_verifier_attestation_digest,
      pair.challenge_result_digest,
      pair.challenge_result_package_digest,
      pair.challenge_verifier_attestation_digest,
    ]),
  );
  const cellBoundEvidenceDigests = [...completedCellBoundDigests, ...contrastCellBoundDigests];
  if (
    !authorityIsTrusted(authority, trustPolicy) ||
    !trustRootIsValid(trustPolicy, runtimePinnedTrustRoot)
  ) {
    failures.push('invalid_authority');
  }
  if (
    evidence.schema_version !== 'aiq.release-gate-evidence.v1' ||
    authority.release_identity !== policy.release_identity ||
    authority.catalog_release_identity_digest !== catalog.catalog_release_identity.digest ||
    authority.task_metadata_identity_digest !== catalog.task_metadata_identity.digest ||
    evidence.admission_digest !== authority.admission_digest ||
    evidence.execution_plan_digest !== admission.execution_plan_digest ||
    authority.execution_plan_digest !== admission.execution_plan_digest ||
    !validDigest(admission.execution_plan_digest) ||
    evidence.model_id_mapping_digest !== admission.model_id_mapping_digest ||
    authority.model_id_mapping_digest !== admission.model_id_mapping_digest ||
    admission.model_id_mapping_digest !== releaseModelIdMappingDigest() ||
    authority.source_observations_digest !== evidence.source_observations_digest ||
    !validIdentifier(admission.plan_id) ||
    !validCanonicalTimestamp(admission.issued_at) ||
    !validCanonicalTimestamp(admission.collection_not_before) ||
    !validCanonicalTimestamp(admission.collection_not_after) ||
    Date.parse(admission.issued_at) >= Date.parse(admission.collection_not_before) ||
    Date.parse(admission.collection_not_before) >= Date.parse(admission.collection_not_after) ||
    admission.repeat_schedule.length !== 3 ||
    new Set(plannedRepeatIds).size !== plannedRepeatIds.length ||
    admission.repeat_schedule.some(
      ({ repeat_id: repeatId, scheduled_at: scheduledAt, contrast_arm_order: armOrder }, index) =>
        !validIdentifier(repeatId) ||
        !validCanonicalTimestamp(scheduledAt) ||
        Date.parse(scheduledAt) < Date.parse(admission.collection_not_before) ||
        Date.parse(scheduledAt) > Date.parse(admission.collection_not_after) ||
        (index > 0 &&
          Date.parse(scheduledAt) <=
            Date.parse(admission.repeat_schedule[index - 1]?.scheduled_at ?? '')) ||
        JSON.stringify(armOrder) !== JSON.stringify(expectedContrastArmOrder(index)),
    ) ||
    JSON.stringify(evidence.repeat_ids) !== JSON.stringify(plannedRepeatIds) ||
    !validCanonicalTimestamp(evidence.collected_at) ||
    Date.parse(evidence.collected_at) < Date.parse(admission.collection_not_before) ||
    Date.parse(evidence.collected_at) > Date.parse(admission.collection_not_after) ||
    evidence.authority_digest !== releaseAuthorityDigest(authority) ||
    evidence.release_identity !== authority.release_identity ||
    evidence.catalog_release_identity_digest !== authority.catalog_release_identity_digest ||
    evidence.task_metadata_identity_digest !== authority.task_metadata_identity_digest ||
    !validDigest(admission.corpus_commitment_digest) ||
    evidence.corpus_commitment_digest !== admission.corpus_commitment_digest ||
    admission.model_matrix.digest !== CANDIDATE_MODEL_MATRIX_SHA256 ||
    evidence.model_matrix_digest !== admission.model_matrix.digest ||
    admission.model_matrix.digest !==
      releaseEvidenceModelMatrixDigest(admission.model_matrix.configurations) ||
    admission.model_matrix.configurations.length !== FIXED_MODEL_MATRIX_IDENTITIES.length ||
    modelIds.size !== 17 ||
    admission.model_matrix.configurations.some(
      (
        {
          model_id: modelId,
          execution_model_id: executionModelId,
          family,
          reasoning_effort: effort,
        },
        index,
      ) =>
        !validIdentifier(modelId) ||
        executionModelId !== MODEL_EXECUTION_ID_MAPPING[index]?.execution_model_id ||
        modelId !== FIXED_MODEL_MATRIX_IDENTITIES[index]?.model_id ||
        family !== FIXED_MODEL_MATRIX_IDENTITIES[index]?.family ||
        effort !== FIXED_MODEL_MATRIX_IDENTITIES[index]?.reasoning_effort,
    ) ||
    JSON.stringify(admission.observation_universe.task_ids) !==
      JSON.stringify([...expectedTasks.keys()]) ||
    JSON.stringify(admission.observation_universe.model_ids) !==
      JSON.stringify(authorityModelIds) ||
    admission.observation_universe.raw_cell_count !== 72 * 17 * 3 ||
    admission.observation_universe.contrast_pair_count !== 3 * 17 * 3 ||
    admission.observation_universe.contrast_observation_count !== 3 * 2 * 17 * 3 ||
    admission.infrastructure_retry_policy.max_attempts !== 3 ||
    JSON.stringify(admission.infrastructure_retry_policy.backoff_seconds) !==
      JSON.stringify([0, 30, 90]) ||
    JSON.stringify(admission.infrastructure_retry_policy.retryable_classifications) !==
      JSON.stringify(['pre_model_admission']) ||
    admission.infrastructure_retry_policy.model_or_evaluator_failures_retryable ||
    admission.contrast_bindings.length !== policy.predeclared_contrasts.length ||
    authorityContrastBindings.size !== policy.predeclared_contrasts.length ||
    new Set(boundVariantDigests).size !== policy.predeclared_contrasts.length * 2 ||
    boundVariantDigests.some((digest) => !validDigest(digest)) ||
    evidence.source_observations_digest !==
      releaseEvidenceSourceDigest(evidence.raw_cells, evidence.paired_contrasts) ||
    evidence.repeat_ids.length !== 3 ||
    repeatIds.size !== evidence.repeat_ids.length ||
    evidence.raw_cells.length !== expectedCellCount ||
    JSON.stringify(cellKeys) !== JSON.stringify(expectedCellKeys) ||
    new Set(cellKeys).size !== expectedCellCount ||
    cellBoundEvidenceDigests.some((digest) => !validDigest(digest)) ||
    new Set(cellBoundEvidenceDigests).size !== cellBoundEvidenceDigests.length ||
    invalidRawCell
  ) {
    failures.push('invalid_evidence');
  }

  const infrastructureFailures = evidence.raw_cells.filter(
    ({ status }) => status === 'infrastructure_failure',
  ).length;
  const evaluatorFailures = evidence.raw_cells.filter(
    ({ status }) => status === 'evaluator_failure',
  ).length;
  const incompleteCells = evidence.raw_cells.filter(({ status }) => status !== 'completed').length;
  const taskStatistics = catalog.tasks.map(({ task_id: taskId, domain }) => {
    const scores = evidence.raw_cells
      .filter((cell) => cell.task_id === taskId && cell.status === 'completed')
      .flatMap(({ components }) => {
        const score = derivedTaskScore(components);
        return score === null ? [] : [score];
      });
    return {
      task_id: taskId,
      domain,
      mean_score: scores.length === 0 ? Number.NaN : mean(scores),
      score_range: scores.length === 0 ? Number.NaN : Math.max(...scores) - Math.min(...scores),
    };
  });
  const floorTasks = taskStatistics.filter(({ mean_score: meanScore }) => isFloor(meanScore));
  const ceilingTasks = taskStatistics.filter(({ mean_score: meanScore }) => isCeiling(meanScore));
  const midTasks = taskStatistics.filter(({ mean_score: meanScore }) => isMid(meanScore));
  const invariantTasks = taskStatistics.filter(
    ({ score_range: scoreRange }) =>
      scoreRange <= policy.score_bands.invariant_range_max + scoreEpsilon,
  );

  if (infrastructureFailures > policy.aggregate_thresholds.infrastructure_failures_max) {
    failures.push('infrastructure_failures');
  }
  if (evaluatorFailures > policy.aggregate_thresholds.evaluator_failures_max) {
    failures.push('evaluator_failures');
  }
  if (incompleteCells > 0) failures.push('incomplete_cells');
  if (floorTasks.length > policy.aggregate_thresholds.floor_tasks_max) failures.push('floor_tasks');
  if (ceilingTasks.length > policy.aggregate_thresholds.ceiling_tasks_max) {
    failures.push('ceiling_tasks');
  }
  if (midTasks.length < policy.aggregate_thresholds.mid_band_tasks_min) {
    failures.push('mid_band_tasks');
  }
  if (invariantTasks.length > policy.aggregate_thresholds.invariant_tasks_max) {
    failures.push('invariant_tasks');
  }

  for (const domain of DOMAINS) {
    const domainTasks = taskStatistics.filter((taskStatistic) => taskStatistic.domain === domain);
    const share = (predicate: (candidate: (typeof domainTasks)[number]) => boolean): number =>
      domainTasks.filter(predicate).length / domainTasks.length;
    if (
      share(({ mean_score: meanScore }) => isMid(meanScore)) <
      policy.domain_thresholds.mid_band_share_min
    ) {
      failures.push(`domain_mid_band:${domain}`);
    }
    if (
      share(({ mean_score: meanScore }) => isFloor(meanScore)) >
      policy.domain_thresholds.floor_share_max
    ) {
      failures.push(`domain_floor:${domain}`);
    }
    if (
      share(({ mean_score: meanScore }) => isCeiling(meanScore)) >
      policy.domain_thresholds.ceiling_share_max
    ) {
      failures.push(`domain_ceiling:${domain}`);
    }
  }

  const expectedPairCount = 3 * 17;
  const expectedPairKeys = plannedRepeatIds.flatMap((repeatId) =>
    authorityModelIds.map((modelId) => `${repeatId}\u0000${modelId}`),
  );
  const requiredContrastIds = policy.predeclared_contrasts.map(
    ({ contrast_id: contrastId }) => contrastId,
  );
  const passingContrasts = evidence.paired_contrasts.filter((contrast) => {
    const authorityBinding = authorityContrastBindings.get(contrast.contrast_id);
    const pairKeys = contrast.pairs.map(
      ({ repeat_id: repeatId, model_id: modelId }) => `${repeatId}\u0000${modelId}`,
    );
    const validPairs =
      contrast.pairs.length === expectedPairCount &&
      JSON.stringify(pairKeys) === JSON.stringify(expectedPairKeys) &&
      new Set(pairKeys).size === expectedPairCount &&
      contrast.pairs.every(
        ({
          repeat_id: repeatId,
          model_id: modelId,
          reference_score: reference,
          challenge_score: challenge,
          reference_result_digest: referenceResultDigest,
          reference_result_package_digest: referencePackageDigest,
          reference_verifier_attestation_digest: referenceAttestationDigest,
          challenge_result_digest: challengeResultDigest,
          challenge_result_package_digest: challengePackageDigest,
          challenge_verifier_attestation_digest: challengeAttestationDigest,
        }) =>
          repeatIds.has(repeatId) &&
          modelIds.has(modelId) &&
          validUnitInterval(reference) &&
          validUnitInterval(challenge) &&
          [
            referenceResultDigest,
            referencePackageDigest,
            referenceAttestationDigest,
            challengeResultDigest,
            challengePackageDigest,
            challengeAttestationDigest,
          ].every(validDigest),
      );
    if (!validPairs) return false;
    const modelClusterDifferences = authorityModelIds.map((modelId) =>
      mean(
        contrast.pairs
          .filter((pair) => pair.model_id === modelId)
          .map(
            ({ reference_score: reference, challenge_score: challenge }) =>
              (reference - challenge) * 100,
          ),
      ),
    );
    const directionalDifferenceAiQ = mean(modelClusterDifferences);
    const adjustedLowerBound =
      directionalDifferenceAiQ -
      (policy.paired_contrast_thresholds.one_sided_critical_value *
        sampleStandardDeviation(modelClusterDifferences)) /
        Math.sqrt(modelClusterDifferences.length);
    return (
      requiredContrastIds.includes(contrast.contrast_id) &&
      authorityBinding?.reference_variant_digest === contrast.reference_variant_digest &&
      authorityBinding.challenge_variant_digest === contrast.challenge_variant_digest &&
      directionalDifferenceAiQ >=
        policy.paired_contrast_thresholds.directional_difference_aiq_min - 1e-12 &&
      adjustedLowerBound > scoreEpsilon
    );
  });
  if (
    evidence.paired_contrasts.length !== requiredContrastIds.length ||
    new Set(evidence.paired_contrasts.map(({ contrast_id: contrastId }) => contrastId)).size !==
      requiredContrastIds.length ||
    passingContrasts.length !== requiredContrastIds.length
  ) {
    failures.push('paired_contrasts');
  }

  const completedCells = evidence.raw_cells.filter(
    (cell) => cell.status === 'completed' && derivedTaskScore(cell.components) !== null,
  );
  const repeatAggregatesAiQ = evidence.repeat_ids.map(
    (repeatId) =>
      mean(
        completedCells
          .filter((cell) => cell.repeat_id === repeatId)
          .map((cell) => derivedTaskScore(cell.components) ?? Number.NaN),
      ) * 100,
  );
  const targetRows = [...expectedTasks.keys()].flatMap((taskId) =>
    [...modelIds].map((modelId) =>
      evidence.repeat_ids.map((repeatId) => {
        const cell = completedCells.find(
          (candidate) =>
            candidate.task_id === taskId &&
            candidate.model_id === modelId &&
            candidate.repeat_id === repeatId,
        );
        return derivedTaskScore(cell?.components ?? null) ?? Number.NaN;
      }),
    ),
  );
  const aggregateSdAiQ = sampleStandardDeviation(repeatAggregatesAiQ);
  const medianCellRange = median(
    targetRows.map((scores) => Math.max(...scores) - Math.min(...scores)),
  );
  const icc = absoluteAgreementIcc(targetRows);
  if (evidence.repeat_ids.length !== 3) {
    failures.push('stability_repeats');
  }
  if (aggregateSdAiQ > policy.stability_thresholds.aggregate_sd_aiq_max + scoreEpsilon) {
    failures.push('stability_aggregate_sd');
  }
  if (medianCellRange > policy.stability_thresholds.median_cell_range_max + scoreEpsilon) {
    failures.push('stability_cell_range');
  }
  if (!Number.isFinite(icc) || icc < policy.stability_thresholds.icc_min - scoreEpsilon) {
    failures.push('stability_icc');
  }

  return {
    schema_version: 'aiq.release-gate-result.v1',
    release_identity: 'aiq-core/1.0.2',
    candidate_status: 'candidate_requires_controlled_release_gate',
    passed: failures.length === 0,
    failures,
    authority_digest: releaseAuthorityDigest(authority),
    evidence_digest: releaseEvidenceDigest(evidence),
    plan_id: admission.plan_id,
  };
}

export function verifyPromotionReceipt(
  receipt: PromotionReceipt,
  evidence: ReleaseGateEvidence,
  authority: ReleaseGateAuthority,
  trustPolicy: ReleaseGateTrustPolicy,
  runtimePinnedTrustRoot: ReleaseGateTrustRoot,
): boolean {
  const result = evaluateReleaseGate(evidence, authority, trustPolicy, runtimePinnedTrustRoot);
  const signer = trustedSigner(trustPolicy.promotion_signers, receipt.signer.key_id);
  return (
    result.passed &&
    hasExactKeys(receipt, [
      'authority_digest',
      'candidate_catalog_release_identity_digest',
      'evidence_digest',
      'gate_result_digest',
      'issued_at',
      'promotion_state',
      'release_identity',
      'schema_version',
      'signature',
      'signature_domain',
      'signature_encoding',
      'signer',
      'task_metadata_identity_digest',
    ]) &&
    signerShapeIsClosed(receipt.signer) &&
    receipt.schema_version === 'aiq.promotion-receipt.v1' &&
    receipt.signature_domain === receipt.schema_version &&
    receipt.signature_encoding === 'aiq.sorted-key-json.v1' &&
    receipt.release_identity === result.release_identity &&
    receipt.candidate_catalog_release_identity_digest ===
      buildCatalog().catalog_release_identity.digest &&
    receipt.task_metadata_identity_digest === buildCatalog().task_metadata_identity.digest &&
    receipt.authority_digest === result.authority_digest &&
    receipt.evidence_digest === result.evidence_digest &&
    receipt.gate_result_digest === releaseGateResultDigest(result) &&
    receipt.promotion_state === 'released' &&
    promotionReceiptIssuedAtIsCausal(receipt.issued_at, evidence.collected_at) &&
    receipt.signer.algorithm === 'ed25519' &&
    verifyEd25519(promotionReceiptSigningBytes(receipt), receipt.signature, signer)
  );
}

const BASE_TASK_BUDGET: TaskBudget = { wall_seconds: 360, max_steps: 28, max_tool_calls: 18 };

const COMPLEX_INPUT_PATTERN =
  /(?:architecture_change|claim_audit|concurrent|cross_platform|distributed|migration_design|multi_(?:document|file|tool)|service_repository|temporal|workflow_and_build)/u;
const COMPACT_INPUT_PATTERN =
  /(?:captured_limit|constrained_response|interrupted_capability|maintenance_scheduling|repository_question|structured_writing)/u;

function taskBudget(draft: TaskDraft, allowedTools: readonly string[]): TaskBudget {
  let wallSeconds = BASE_TASK_BUDGET.wall_seconds;
  let maxSteps = BASE_TASK_BUDGET.max_steps;
  let maxToolCalls = BASE_TASK_BUDGET.max_tool_calls;

  if (!allowedTools.includes('filesystem_write')) {
    wallSeconds -= 30;
    maxSteps -= 2;
  }
  if (draft.domain === 'coding' || draft.domain === 'debugging') {
    wallSeconds += 60;
    maxSteps += 4;
    maxToolCalls += 3;
  }
  if (draft.domain === 'tool_use') {
    wallSeconds += 30;
    maxSteps += 2;
    maxToolCalls += 4;
  }
  if (COMPLEX_INPUT_PATTERN.test(draft.inputKind)) {
    wallSeconds += 60;
    maxSteps += 4;
    maxToolCalls += 3;
  }
  if (COMPACT_INPUT_PATTERN.test(draft.inputKind)) {
    wallSeconds -= 30;
    maxSteps -= 2;
    maxToolCalls -= 2;
  }

  return {
    wall_seconds: wallSeconds,
    max_steps: maxSteps,
    max_tool_calls: maxToolCalls,
  };
}

function task(
  domain: Domain,
  title: string,
  difficulty: Difficulty,
  inputKind: string,
  scorer: string,
  summary: string,
  checks: readonly string[],
  tags: readonly string[],
): TaskDraft {
  return { domain, title, difficulty, inputKind, scorer, summary, checks, tags };
}

const TASKS: readonly TaskDraft[] = [
  task(
    'coding',
    'Add a validated configuration field',
    'easy',
    'small_repository_patch',
    'repository_test_suite',
    'Add one typed configuration field, validation rule, and user-facing error to a small application.',
    [
      'The focused tests pass.',
      'The invalid value is rejected.',
      'Unrelated public behavior is unchanged.',
    ],
    ['configuration', 'validation'],
  ),
  task(
    'coding',
    'Implement a stable pagination helper',
    'medium',
    'library_function_patch',
    'property_and_example_tests',
    'Implement cursor pagination that preserves stable ordering across duplicate sort keys.',
    [
      'Example vectors pass.',
      'The cursor round-trips.',
      'Duplicate keys do not skip or repeat rows.',
    ],
    ['pagination', 'api'],
  ),
  task(
    'coding',
    'Complete a bounded retry utility',
    'medium',
    'library_function_patch',
    'deterministic_clock_tests',
    'Complete a retry helper with capped exponential backoff, deterministic jitter injection, and cancellation.',
    ['Backoff vectors pass.', 'Cancellation stops new attempts.', 'The maximum delay is enforced.'],
    ['retry', 'concurrency'],
  ),
  task(
    'coding',
    'Implement an atomic owned-file update helper',
    'medium',
    'library_function_patch',
    'filesystem_integration_tests',
    'Implement a library helper that validates content and atomically replaces one owned file without losing permissions.',
    [
      'The success fixture is updated atomically.',
      'Invalid input leaves the original file intact.',
      'Mode bits are preserved.',
    ],
    ['atomic_write', 'filesystem'],
  ),
  task(
    'coding',
    'Implement deterministic record deduplication',
    'medium',
    'data_library_patch',
    'golden_and_property_tests',
    'Deduplicate records by a normalized composite key while preserving the documented winner and output order.',
    [
      'Golden output matches.',
      'Permutation properties hold.',
      'Normalization collisions follow policy.',
    ],
    ['collections', 'normalization'],
  ),
  task(
    'coding',
    'Extend an API client with conditional requests',
    'medium',
    'http_client_patch',
    'mock_server_contract_tests',
    'Add ETag-based conditional reads and typed handling for not-modified responses to a small API client.',
    [
      'Request headers match.',
      '304 does not parse a body.',
      'Existing success and error paths remain valid.',
    ],
    ['http', 'caching'],
  ),
  task(
    'coding',
    'Implement a streaming event parser',
    'hard',
    'stream_parser_patch',
    'chunk_boundary_property_tests',
    'Implement an incremental parser for framed events with split UTF-8 input, size limits, and typed parse errors.',
    [
      'All chunk partitions produce the same events.',
      'Oversized frames fail early.',
      'Invalid UTF-8 has a stable error.',
    ],
    ['parser', 'streaming'],
  ),
  task(
    'coding',
    'Add a resumable batch processor',
    'hard',
    'service_repository_patch',
    'crash_replay_integration_tests',
    'Implement a batch processor that checkpoints committed items and resumes without duplicate side effects.',
    [
      'Crash fixtures resume at the correct item.',
      'Committed effects are not repeated.',
      'Failed effects do not advance the checkpoint.',
    ],
    ['batch', 'idempotency'],
  ),

  task(
    'debugging',
    'Fix a boundary-condition regression',
    'easy',
    'failing_unit_test_repository',
    'regression_test_suite',
    'Find and repair an off-by-one error in a bounded parser while preserving valid empty input behavior.',
    [
      'The provided regression passes.',
      'Adjacent boundary cases pass.',
      'The patch is limited to the fault surface.',
    ],
    ['boundary', 'parser'],
  ),
  task(
    'debugging',
    'Diagnose an environment precedence defect',
    'medium',
    'configuration_repository',
    'configuration_matrix_tests',
    'Repair configuration precedence where an empty environment value incorrectly overrides a valid file value.',
    [
      'The precedence matrix passes.',
      'Explicit empty values follow the stated policy.',
      'Errors name the source.',
    ],
    ['configuration', 'environment'],
  ),
  task(
    'debugging',
    'Repair a stale-cache race',
    'medium',
    'concurrent_service_repository',
    'deterministic_concurrency_tests',
    'Find and repair a cache invalidation race that can publish a value older than the committed source record.',
    [
      'The deterministic race test passes.',
      'No global serialization is introduced.',
      'Cache hits remain correct.',
    ],
    ['cache', 'concurrency'],
  ),
  task(
    'debugging',
    'Fix malformed Unicode truncation',
    'medium',
    'text_utility_repository',
    'unicode_vector_tests',
    'Repair byte-based truncation so output is valid Unicode and respects a display-unit budget.',
    [
      'Unicode vectors pass.',
      'ASCII behavior is unchanged.',
      'The result never exceeds the budget.',
    ],
    ['unicode', 'text'],
  ),
  task(
    'debugging',
    'Resolve duplicate event delivery',
    'medium',
    'event_worker_repository',
    'replay_integration_tests',
    'Trace and fix duplicate side effects after a worker restarts between event handling and acknowledgement.',
    [
      'Replay produces one effect.',
      'Acknowledgement ordering is correct.',
      'Transient failures remain retryable.',
    ],
    ['events', 'idempotency'],
  ),
  task(
    'debugging',
    'Correct an incorrect timezone window',
    'medium',
    'scheduling_repository',
    'timezone_transition_tests',
    'Fix a reporting window that uses UTC dates where the contract requires a configured IANA timezone.',
    [
      'Normal-day vectors pass.',
      'DST transition vectors pass.',
      'Invalid timezone input is rejected.',
    ],
    ['time', 'scheduling'],
  ),
  task(
    'debugging',
    'Find a connection-pool starvation path',
    'hard',
    'async_service_repository',
    'bounded_load_and_leak_tests',
    'Diagnose and repair a leaked database permit on one cancellation path under bounded concurrency.',
    [
      'Cancellation releases capacity.',
      'Load completes within the bound.',
      'The fix preserves transaction cleanup.',
    ],
    ['database', 'async'],
  ),
  task(
    'debugging',
    'Repair cross-platform archive extraction',
    'hard',
    'cross_platform_repository',
    'platform_path_security_tests',
    'Fix extraction failures on Windows-style paths while retaining traversal and symlink protections.',
    [
      'Windows and Unix fixtures pass.',
      'Traversal fixtures remain blocked.',
      'Symlink policy is unchanged.',
    ],
    ['archive', 'cross_platform', 'security'],
  ),

  task(
    'repository_understanding',
    'Locate the owner of a CLI flag',
    'easy',
    'repository_question',
    'evidence_pointer_assertions',
    'Identify the source, tests, configuration, and documentation that jointly own one CLI flag.',
    [
      'All required owner paths are named.',
      'Each claim cites an exact symbol or section.',
      'No unrelated owner is asserted.',
    ],
    ['navigation', 'ownership'],
  ),
  task(
    'repository_understanding',
    'Trace a request through three layers',
    'medium',
    'repository_question',
    'call_graph_fact_checks',
    'Trace a request from its entrypoint through validation and persistence, including the principal error branches.',
    [
      'The ordered call path matches source.',
      'Validation and persistence owners are distinguished.',
      'Error exits are cited.',
    ],
    ['call_graph', 'architecture'],
  ),
  task(
    'repository_understanding',
    'Explain a generated-code boundary',
    'medium',
    'repository_question',
    'source_and_build_rule_checks',
    'Determine which files are generated, what source owns them, and the supported regeneration command.',
    [
      'Generated and authored files are separated.',
      'The exact generator is identified.',
      'Direct-edit policy matches source.',
    ],
    ['generated_code', 'build'],
  ),
  task(
    'repository_understanding',
    'Assess the impact of a schema rename',
    'medium',
    'change_impact_question',
    'dependency_surface_assertions',
    'Enumerate the runtime, tests, migrations, API types, and documentation affected by a named schema field rename.',
    [
      'All seeded consumers are found.',
      'Generated consumers are classified.',
      'The migration compatibility boundary is stated.',
    ],
    ['impact_analysis', 'schema'],
  ),
  task(
    'repository_understanding',
    'Reconstruct a failed release path',
    'medium',
    'workflow_question',
    'workflow_dependency_checks',
    'Explain which release jobs can run after a specified job failure and which artifacts or publications can still occur.',
    [
      'Job dependencies match workflow YAML.',
      'Independent paths are not treated as blocked.',
      'Artifact scope is accurate.',
    ],
    ['ci', 'release'],
  ),
  task(
    'repository_understanding',
    'Find an implicit configuration contract',
    'medium',
    'repository_question',
    'cross_source_contract_checks',
    'Recover a configuration contract spread across parser code, startup code, example files, and tests.',
    [
      'Precedence and defaults match code.',
      'Invalid cases match tests.',
      'Every source claim has a pointer.',
    ],
    ['configuration', 'contract'],
  ),
  task(
    'repository_understanding',
    'Map a workspace boundary change',
    'hard',
    'architecture_change_question',
    'complete_consumer_inventory',
    'Determine the minimal atomic edits needed to move a package while preserving build, release, and local commands.',
    [
      'Every path-sensitive consumer is listed.',
      'Generated artifacts are not hand-edited.',
      'Validation commands match the repository.',
    ],
    ['workspace', 'migration'],
  ),

  task(
    'data_processing',
    'Normalize a small CSV export',
    'easy',
    'tabular_file_transform',
    'golden_file_comparison',
    'Normalize headers, dates, missing values, and row ordering in a small CSV export.',
    [
      'The golden CSV matches.',
      'Malformed rows are reported.',
      'Input row provenance is retained.',
    ],
    ['csv', 'normalization'],
  ),
  task(
    'data_processing',
    'Join two keyed datasets safely',
    'easy',
    'multi_file_transform',
    'relational_invariant_checks',
    'Join account and event files while reporting unmatched keys and preventing accidental many-to-many expansion.',
    [
      'Matched output is correct.',
      'Unmatched keys are reported.',
      'Duplicate-key policy is enforced.',
    ],
    ['join', 'quality'],
  ),
  task(
    'data_processing',
    'Compute a cohort retention table',
    'medium',
    'event_table_analysis',
    'golden_metrics_with_tolerance',
    'Build weekly cohort retention from signup and activity events with explicit timezone and denominator rules.',
    [
      'Cohort membership is correct.',
      'Week boundaries match policy.',
      'Rates and denominators match fixtures.',
    ],
    ['cohort', 'metrics'],
  ),
  task(
    'data_processing',
    'Reconcile a ledger extract',
    'medium',
    'financial_table_analysis',
    'accounting_invariant_checks',
    'Reconcile debits, credits, reversals, and duplicate references into a discrepancy report.',
    [
      'Balanced groups close to zero.',
      'Duplicates and reversals are classified.',
      'Currency precision is preserved.',
    ],
    ['ledger', 'reconciliation'],
  ),
  task(
    'data_processing',
    'Summarize nested event JSON',
    'medium',
    'jsonl_transform',
    'schema_and_golden_checks',
    'Flatten selected nested fields, classify malformed events, and aggregate counts without dropping valid unknown fields.',
    [
      'The output schema matches.',
      'Malformed records are quarantined.',
      'Counts reconcile to input rows.',
    ],
    ['jsonl', 'aggregation'],
  ),
  task(
    'data_processing',
    'Detect a metric discontinuity',
    'medium',
    'time_series_analysis',
    'known_change_point_checks',
    'Identify a seeded reporting discontinuity while distinguishing missing intervals from true zero values.',
    [
      'The seeded change point is found.',
      'Missing and zero are distinct.',
      'The explanation uses supplied metadata.',
    ],
    ['time_series', 'diagnostics'],
  ),
  task(
    'data_processing',
    'Build a stratified sample',
    'medium',
    'dataset_sampling',
    'distribution_and_seed_checks',
    'Produce a deterministic stratified sample that satisfies minimum group coverage and a fixed row budget.',
    ['Repeated runs match.', 'Group minima are met.', 'Selection bias metadata is emitted.'],
    ['sampling', 'reproducibility'],
  ),
  task(
    'data_processing',
    'Repair a slowly changing dimension snapshot',
    'hard',
    'temporal_table_transform',
    'temporal_invariant_checks',
    'Construct non-overlapping validity intervals from out-of-order entity updates and late corrections.',
    [
      'Intervals do not overlap.',
      'Late corrections supersede correctly.',
      'As-of query fixtures match.',
    ],
    ['temporal', 'warehouse'],
  ),

  task(
    'retrieval_verification',
    'Decide whether a request plan fits a captured limit',
    'easy',
    'captured_limit_decision',
    'operational_judgment_checks',
    'Apply a dated numeric product limit to a concrete request plan and preserve its exact scope and capture identity.',
    [
      'The fit decision and arithmetic are correct.',
      'Authentication, data, counter, and window scope are preserved.',
      'Capture date and source revision are stated.',
    ],
    ['official_docs', 'fact_check'],
  ),
  task(
    'retrieval_verification',
    'Reconstruct a feature-default timeline',
    'medium',
    'captured_release_timeline',
    'timeline_and_disposition_checks',
    'Reconstruct initial feature availability and a later default change from two captured releases.',
    [
      'Both controlling events are present.',
      'Flag requirements and experimental status are preserved.',
      'The broad release-line claim is classified.',
    ],
    ['release', 'conflict'],
  ),
  task(
    'retrieval_verification',
    'Issue a standards interpretation note',
    'medium',
    'captured_standard_interpretation',
    'authority_scope_and_boundary_checks',
    'Interpret a standards assertion from a captured normative source, including authority strength and negative evidence.',
    [
      'The assertion disposition is correct.',
      'The controlling section and statement strength are identified.',
      'Applicability and the extract boundary are explicit.',
    ],
    ['standard', 'compliance'],
  ),
  task(
    'retrieval_verification',
    'Confirm a dependency compatibility claim',
    'medium',
    'captured_compatibility_snapshot',
    'primary_compatibility_checks',
    'Verify a dependency compatibility claim from a captured first-party migration source and preserve its exact conditions.',
    [
      'Official compatibility evidence is cited.',
      'The exact versions are named.',
      'Known conditions are not omitted.',
    ],
    ['dependency', 'compatibility'],
  ),
  task(
    'retrieval_verification',
    'Reconstruct a dated policy change',
    'medium',
    'captured_policy_timeline',
    'timeline_fact_checks',
    'Reconstruct a dated policy timeline from captured first-party evidence, including amendments and superseded text.',
    [
      'All seeded events are ordered.',
      'Dates have direct citations.',
      'Superseded text is not presented as current.',
    ],
    ['policy', 'timeline'],
  ),
  task(
    'retrieval_verification',
    'Validate a quoted statistic',
    'medium',
    'captured_dataset_provenance',
    'calculation_and_provenance_checks',
    'Validate a quoted statistic from captured first-party dataset rows and reproduce its numerator, denominator, and limitation.',
    [
      'The source dataset is authoritative.',
      'The calculation reproduces the value.',
      'Limitations and denominator are stated.',
    ],
    ['statistics', 'provenance'],
  ),
  task(
    'retrieval_verification',
    'Audit a multi-claim technical brief',
    'hard',
    'captured_claim_audit',
    'claim_evidence_matrix',
    'Audit a short technical brief against bounded captured first-party sources and classify each material claim.',
    [
      'Every material claim is classified.',
      'Evidence lineage is explicit.',
      'Unsupported claims are not repaired by inference.',
    ],
    ['audit', 'evidence'],
  ),

  task(
    'documentation_communication',
    'Write a concise operator notice',
    'easy',
    'structured_writing',
    'required_fact_and_style_checks',
    'Convert a small incident fact set into a concise operator notice with impact, status, and next update time.',
    [
      'All required facts are present.',
      'No unsupported cause is asserted.',
      'Length and terminology limits pass.',
    ],
    ['incident', 'operations'],
  ),
  task(
    'documentation_communication',
    'Rewrite setup steps for direct use',
    'easy',
    'documentation_edit',
    'command_and_link_checks',
    'Rewrite incomplete setup notes into ordered, executable steps with prerequisites and verification.',
    ['Commands match fixtures.', 'Prerequisites precede use.', 'Every relative link resolves.'],
    ['setup', 'runbook'],
  ),
  task(
    'documentation_communication',
    'Produce a migration handoff',
    'medium',
    'structured_writing',
    'handoff_contract_checks',
    'Create a handoff that names completed work, remaining environment inputs, rollback, and verification commands.',
    [
      'Required sections are complete.',
      'Commands and variable names match source.',
      'No secret value is included.',
    ],
    ['handoff', 'migration'],
  ),
  task(
    'documentation_communication',
    'Explain a scoring method to two audiences',
    'medium',
    'dual_audience_writing',
    'fact_consistency_checks',
    'Write a short public explanation and a precise technical appendix from one scoring specification.',
    [
      'Both sections agree numerically.',
      'The public section avoids false certainty.',
      'The appendix preserves formulas.',
    ],
    ['methodology', 'audience'],
  ),
  task(
    'documentation_communication',
    'Repair a misleading changelog entry',
    'medium',
    'documentation_edit',
    'source_alignment_checks',
    'Correct a changelog entry that overstates scope and omits a compatibility condition.',
    [
      'Scope matches the diff.',
      'The compatibility condition is present.',
      'Unrelated history is unchanged.',
    ],
    ['changelog', 'accuracy'],
  ),
  task(
    'documentation_communication',
    'Draft a decision record',
    'medium',
    'structured_writing',
    'decision_record_checks',
    'Turn supplied evidence into a decision record with constraints, alternatives, consequences, and replacement triggers.',
    [
      'The selected option follows evidence.',
      'Rejected alternatives retain tradeoffs.',
      'Replacement triggers are testable.',
    ],
    ['decision', 'architecture'],
  ),
  task(
    'documentation_communication',
    'Consolidate conflicting runbooks',
    'hard',
    'multi_document_edit',
    'single_authority_and_command_checks',
    'Consolidate two drifting runbooks into one owner and replace duplicate instructions with accurate links.',
    [
      'One canonical procedure remains.',
      'All commands match source.',
      'Old routes point to the owner.',
    ],
    ['runbook', 'drift'],
  ),

  task(
    'planning_execution',
    'Schedule a constrained maintenance window',
    'easy',
    'maintenance_scheduling',
    'interval_dependency_checks',
    'Build a feasible maintenance schedule from dependencies, durations, exclusive capacity, and a validation reserve.',
    [
      'The schedule fits the window.',
      'Dependencies and exclusive capacity are respected.',
      'The validation reserve is retained.',
    ],
    ['maintenance', 'scheduling'],
  ),
  task(
    'planning_execution',
    'Execute a deployable contract migration',
    'medium',
    'repository_migration',
    'phase_invariant_tests',
    'Execute compatibility checkpoints while each state remains deployable and the last rollback boundary stays explicit.',
    ['Phase order is safe.', 'All callers migrate.', 'The obsolete contract is removed.'],
    ['migration', 'compatibility'],
  ),
  task(
    'planning_execution',
    'Staff a coverage plan without double booking',
    'medium',
    'staffing_allocation',
    'coverage_collision_and_continuity_checks',
    'Allocate qualified available people to interval demand without double booking and preserve useful continuity.',
    [
      'Every demanded role is covered.',
      'No person is double booked.',
      'Availability, skills, and continuity are respected.',
    ],
    ['staffing', 'allocation'],
  ),
  task(
    'planning_execution',
    'Stop a staged rollout at the correct gate',
    'medium',
    'staged_rollout_state',
    'gate_decision_and_evidence_checks',
    'Execute eligible rollout stages, stop before the first ineligible stage, and retain the controlling evidence.',
    [
      'Eligible stages complete in order.',
      'The ineligible stage is not entered.',
      'The blocker, observations, and next action are recorded.',
    ],
    ['rollout', 'gating'],
  ),
  task(
    'planning_execution',
    'Prove a reversible local data change',
    'medium',
    'migration_design_and_patch',
    'forward_and_rollback_tests',
    'Implement a bounded schema/data change with a dry-run, invariant checks, and an explicit rollback path.',
    ['Forward fixtures pass.', 'Rollback restores the baseline.', 'Dry-run performs no writes.'],
    ['data_migration', 'rollback'],
  ),
  task(
    'planning_execution',
    'Close a local dependency update lane',
    'medium',
    'dependency_repository_change',
    'graph_and_behavior_checks',
    'Update one direct dependency, migrate supported API changes, regenerate the lock, and report graph delta.',
    [
      'The direct declaration and lock agree.',
      'Behavior tests pass.',
      'New transitives are inventoried.',
    ],
    ['dependency', 'supply_chain'],
  ),
  task(
    'planning_execution',
    'Repair a cross-platform packaging matrix',
    'hard',
    'workflow_and_build_change',
    'workflow_static_and_artifact_checks',
    'Repair package paths across a build matrix while preserving pinned actions and platform-specific archive formats.',
    [
      'All matrix paths resolve.',
      'Artifact names are consistent.',
      'External actions remain SHA-pinned.',
    ],
    ['ci', 'packaging'],
  ),

  task(
    'tool_use',
    'Find and edit the exact owned file',
    'easy',
    'repository_ownership_task',
    'filesystem_state_and_receipt_checks',
    'Find the source-owned setting, change it without editing generated output, and record recomputable evidence.',
    [
      'The correct owner changes.',
      'Generated files are untouched.',
      'The evidence names all occurrences and binds the preserved generated file.',
    ],
    ['ownership', 'editing', 'receipt'],
  ),
  task(
    'tool_use',
    'Run a bounded local document extractor',
    'medium',
    'task_local_document_cli',
    'semantic_output_and_receipt_checks',
    'Invoke an immutable local Node document extractor and retain its digest-bound output receipt.',
    [
      'Extracted facts and rows match.',
      'The run receipt binds input and output.',
      'The source and tool are unchanged.',
    ],
    ['document', 'local_cli', 'extraction'],
  ),
  task(
    'tool_use',
    'Repair configuration with a local validator',
    'medium',
    'multi_tool_validation_task',
    'validator_state_and_receipt_checks',
    'Use an immutable local validator to diagnose invalid configuration, repair it, validate it again, and retain digest-bound receipts.',
    [
      'The initial validation identifies every policy violation.',
      'The repaired configuration and final validation comply with policy.',
      'Both validator receipts and the repair record bind exact inputs and outputs.',
    ],
    ['configuration', 'validation', 'remediation'],
  ),
  task(
    'tool_use',
    'Verify linked local evidence',
    'medium',
    'linked_local_evidence_task',
    'source_evidence_and_receipt_checks',
    'Verify a bounded captured local site and record the selected release, source anchors, rejected draft evidence, and source receipts.',
    [
      'The selected link belongs to the captured local first-party site.',
      'The latest non-draft version is selected.',
      'The runtime claim and source digests match the captured pages.',
    ],
    ['local_navigation', 'verification'],
  ),
  task(
    'tool_use',
    'Apply a structured patch and validate it',
    'medium',
    'shell_and_patch_task',
    'diff_scope_and_gate_checks',
    'Apply a bounded multi-file patch and make the focused validation artifact reject behavioral regressions.',
    [
      'The intended files match.',
      'The focused tests reject seeded behavioral mutants.',
      'The final module export surface remains narrow.',
    ],
    ['patch', 'validation'],
  ),
  task(
    'tool_use',
    'Compose two local command outputs',
    'medium',
    'shell_data_task',
    'output_and_trace_checks',
    'Combine two frozen, versioned local-command outputs into a deterministic report without exposing diagnostic or environment fields.',
    [
      'The report matches fixtures.',
      'Secret-shaped environment data is absent.',
      'The lineage artifact binds both exact frozen inputs.',
    ],
    ['command_output', 'json'],
  ),
  task(
    'tool_use',
    'Coordinate a tool failure fallback',
    'hard',
    'multi_tool_failure_task',
    'failure_state_and_source_receipt_checks',
    'Complete a repository lookup after a preferred indexing tool fails, using bounded source evidence and recomputable receipts.',
    [
      'The failure record matches the frozen fixture.',
      'The bounded source set and its digests are complete.',
      'The corroborated result matches the source evidence.',
    ],
    ['fallback', 'coordination'],
  ),

  task(
    'instruction_following',
    'Honor an exact output schema',
    'easy',
    'constrained_response',
    'json_schema_validation',
    'Return supplied facts in an exact JSON schema with no extra keys or prose.',
    ['The JSON schema validates.', 'Every value is grounded.', 'No surrounding text is emitted.'],
    ['schema', 'output'],
  ),
  task(
    'instruction_following',
    'Preserve an explicit file boundary',
    'medium',
    'bounded_repository_change',
    'allowed_path_diff_check',
    'Implement a change while modifying only the explicitly allowed files and preserving all forbidden paths.',
    [
      'The feature checks pass.',
      'The diff contains only allowed paths.',
      'No generated file is hand-edited.',
    ],
    ['scope', 'files'],
  ),
  task(
    'instruction_following',
    'Apply precedence among nested requirements',
    'medium',
    'constraint_resolution',
    'constraint_outcome_matrix',
    'Produce an artifact that satisfies a hierarchy of format, safety, terminology, and length constraints.',
    [
      'Higher-priority constraints hold.',
      'Compatible lower-priority constraints hold.',
      'Conflicts are reported only when required.',
    ],
    ['constraints', 'precedence'],
  ),
  task(
    'instruction_following',
    'Avoid a prohibited external action',
    'medium',
    'local_implementation_task',
    'side_effect_and_artifact_checks',
    'Prepare deployable configuration and code without creating the prohibited cloud resource or sending a message.',
    [
      'Local artifacts are complete.',
      'No external mutation occurs.',
      'Required future inputs are listed.',
    ],
    ['safety_boundary', 'deployment'],
  ),
  task(
    'instruction_following',
    'Keep synthetic and measured data separate',
    'medium',
    'data_and_ui_change',
    'provenance_label_checks',
    'Add demo data while ensuring every public surface identifies it as synthetic and no measured claim is implied.',
    [
      'Every seeded record is labeled.',
      'Aggregates retain the label.',
      'No production timestamp is fabricated.',
    ],
    ['synthetic', 'provenance'],
  ),
  task(
    'instruction_following',
    'Complete a dense multi-constraint edit',
    'hard',
    'multi_file_constrained_change',
    'constraint_coverage_suite',
    'Apply a change with exact naming, compatibility, validation, documentation, and no-secret requirements.',
    [
      'All named constraints have evidence.',
      'Compatibility fixtures pass.',
      'No placeholder or secret enters the diff.',
    ],
    ['multi_constraint', 'compliance'],
  ),

  task(
    'reliability_recovery',
    'Recover an interrupted run from capability evidence',
    'easy',
    'interrupted_capability_state',
    'disposition_resume_and_evidence_checks',
    'Classify an interrupted item from frozen capability evidence and preserve prior completed evidence without inventing a result.',
    [
      'The disposition follows the capability record.',
      'Completed evidence is preserved.',
      'Captured preflight evidence controls the resume decision.',
    ],
    ['capability', 'interruption', 'recovery'],
  ),
  task(
    'reliability_recovery',
    'Resume an interrupted local run',
    'medium',
    'checkpoint_recovery_scenario',
    'idempotent_replay_checks',
    'Resume after interruption using a checkpoint and avoid re-running completed side effects.',
    [
      'Completed work is not repeated.',
      'Pending work resumes.',
      'The run identity remains stable.',
    ],
    ['resume', 'idempotency'],
  ),
  task(
    'reliability_recovery',
    'Resolve a partial attachment integrity incident',
    'medium',
    'integrity_failure_scenario',
    'hash_and_quarantine_checks',
    'Apply the supplied integrity policy to a partial attachment and preserve auditable byte and digest evidence.',
    [
      'Both digests are recorded.',
      'The resulting byte disposition follows policy.',
      'The next action is supported by the captured evidence.',
    ],
    ['integrity', 'artifact'],
  ),
  task(
    'reliability_recovery',
    'Recover from a partial submission',
    'medium',
    'captured_submission_recovery',
    'idempotent_submission_checks',
    'Recover an ambiguous submission from frozen state, lookup evidence, and idempotency policy.',
    [
      'State identity follows policy.',
      'The recorded package and run counts reconcile.',
      'The recovery log is supported by lookup evidence.',
    ],
    ['network', 'submission'],
  ),
  task(
    'reliability_recovery',
    'Resume after an output-checkpoint interruption',
    'medium',
    'partial_operational_state',
    'resume_cleanup_and_idempotency_checks',
    'Recover when output is ahead of the durable checkpoint, avoid repeated work, promote final output, and retire temporary state.',
    [
      'Prior durable sequences are skipped.',
      'The final checkpoint and output agree.',
      'Temporary state is removed and replay is safe.',
    ],
    ['resume', 'checkpoint', 'idempotency'],
  ),
  task(
    'reliability_recovery',
    'Continue after one malformed task',
    'medium',
    'batch_isolation_scenario',
    'isolation_and_summary_checks',
    'Reject one malformed task definition while continuing independent valid tasks and reporting the batch summary.',
    [
      'The invalid task does not run.',
      'Valid tasks complete.',
      'Counts reconcile to the input set.',
    ],
    ['validation', 'isolation'],
  ),
  task(
    'reliability_recovery',
    'Reconcile two signed result claims',
    'hard',
    'distributed_conflict_scenario',
    'signature_and_trust_checks',
    'Reconcile signed claims from deterministic verification evidence while preserving unresolved trust boundaries.',
    [
      'Every claim is checked.',
      'Conflict handling follows policy.',
      'Trusted aggregation includes only eligible evidence.',
    ],
    ['distributed', 'conflict', 'signature'],
  ),
];

const DOMAIN_QUOTAS: Readonly<Record<Domain, number>> = {
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
};

const DIFFICULTY_QUOTAS: Readonly<Record<Difficulty, number>> = {
  easy: 12,
  medium: 48,
  hard: 12,
};

const DOMAIN_DIFFICULTY_QUOTAS: Readonly<Record<Domain, Readonly<Record<Difficulty, number>>>> = {
  coding: { easy: 1, medium: 5, hard: 2 },
  debugging: { easy: 1, medium: 5, hard: 2 },
  repository_understanding: { easy: 1, medium: 5, hard: 1 },
  data_processing: { easy: 2, medium: 5, hard: 1 },
  retrieval_verification: { easy: 1, medium: 5, hard: 1 },
  documentation_communication: { easy: 2, medium: 4, hard: 1 },
  planning_execution: { easy: 1, medium: 5, hard: 1 },
  tool_use: { easy: 1, medium: 5, hard: 1 },
  instruction_following: { easy: 1, medium: 4, hard: 1 },
  reliability_recovery: { easy: 1, medium: 5, hard: 1 },
};

function slugSequence(index: number): string {
  return String(index + 1).padStart(2, '0');
}

function acceptanceFixtureCommitments(
  taskId: string,
): Readonly<Record<AcceptanceFixtureClass, AcceptanceFixtureCommitment>> {
  const commitment = (fixtureClass: AcceptanceFixtureClass): AcceptanceFixtureCommitment => ({
    handle: `aiq-acceptance://${taskId}/v2/${fixtureClass.replaceAll('_', '-')}`,
    status: 'required_in_controlled_source',
  });

  return {
    gold: commitment('gold'),
    alternate_correct: commitment('alternate_correct'),
    partial_low: commitment('partial_low'),
    partial_high: commitment('partial_high'),
    near_miss: commitment('near_miss'),
    paired_contrast: commitment('paired_contrast'),
    adversarial_format: commitment('adversarial_format'),
    empty: commitment('empty'),
    timeout: commitment('timeout'),
  };
}

const CLUSTER_OVERRIDES: Readonly<Record<string, string>> = {
  'coding-01': 'coding_validation_mutation-cluster-01',
  'coding-02': 'coding_api_state-cluster-02',
  'coding-03': 'stateful_progress-cluster-01',
  'coding-04': 'coding_validation_mutation-cluster-01',
  'coding-05': 'coding_data_transform-cluster-03',
  'coding-06': 'coding_api_state-cluster-02',
  'coding-07': 'coding_data_transform-cluster-03',
  'coding-08': 'stateful_progress-cluster-01',
  'instruction-following-02': 'constraint_boundary-cluster-01',
  'instruction-following-06': 'constraint_boundary-cluster-01',
  'retrieval-verification-01': 'factual_source_family-cluster-01',
  'retrieval-verification-02': 'factual_source_family-cluster-01',
  'retrieval-verification-03': 'factual_source_family-cluster-01',
  'retrieval-verification-04': 'factual_source_family-cluster-01',
  'retrieval-verification-05': 'retrieval_policy_timeline-cluster-02',
  'retrieval-verification-06': 'retrieval_statistics-cluster-03',
  'retrieval-verification-07': 'factual_source_family-cluster-01',
  'planning-execution-01': 'planning_capacity-cluster-01',
  'planning-execution-02': 'planning_reversible_change-cluster-02',
  'planning-execution-03': 'planning_capacity-cluster-01',
  'planning-execution-04': 'planning_rollout_gate-cluster-03',
  'planning-execution-05': 'planning_reversible_change-cluster-02',
  'planning-execution-06': 'planning_build_supply_chain-cluster-04',
  'planning-execution-07': 'planning_build_supply_chain-cluster-04',
  'tool-use-01': 'constraint_boundary-cluster-01',
  'tool-use-02': 'local_tool_execution-cluster-04',
  'tool-use-03': 'local_tool_execution-cluster-04',
  'tool-use-04': 'local_evidence-cluster-02',
  'tool-use-05': 'constraint_boundary-cluster-01',
  'tool-use-06': 'local_evidence-cluster-02',
  'tool-use-07': 'tool_failure_recovery-cluster-03',
  'reliability-recovery-01': 'reliability_capability_isolation-cluster-01',
  'reliability-recovery-02': 'stateful_progress-cluster-01',
  'reliability-recovery-03': 'reliability_artifact_delivery-cluster-02',
  'reliability-recovery-04': 'reliability_artifact_delivery-cluster-02',
  'reliability-recovery-05': 'stateful_progress-cluster-01',
  'reliability-recovery-06': 'reliability_capability_isolation-cluster-01',
  'reliability-recovery-07': 'reliability_claim_conflict-cluster-03',
};

export function buildCatalog(): Catalog {
  const counters = new Map<Domain, number>();
  const tasks: CatalogTask[] = TASKS.map((draft) => {
    const index = counters.get(draft.domain) ?? 0;
    counters.set(draft.domain, index + 1);
    const taskId = `${draft.domain.replaceAll('_', '-')}-${slugSequence(index)}`;
    const profile = PROFILES[draft.domain];
    const allowedTools = profile.allowedTools;
    const budget = taskBudget(draft, allowedTools);
    const revisionKind: RevisionKind = PRIOR_FLOOR_TASKS.has(taskId)
      ? 'replacement'
      : PRIOR_CEILING_TASKS.has(taskId)
        ? 'retargeted'
        : 'rebalanced';
    const rubricCriteria = [...draft.checks, DISCRIMINATION_CHECK[draft.domain]];
    const rubricWeights = [3000, 2500, 2500, 2000] as const;

    return {
      task_id: taskId,
      task_version: TASK_VERSION,
      title: draft.title,
      domain: draft.domain,
      difficulty: draft.difficulty,
      summary: `${draft.summary} Score the core result, edge handling, preservation, and evidence separately so plausible partial work receives deterministic partial credit.`,
      design_revision: {
        supersedes_task_version: '1.0.1',
        kind: revisionKind,
        objective:
          revisionKind === 'replacement'
            ? 'Replace the predecessor floor behavior with bounded entry points, staged partial outcomes, and independently measurable checks.'
            : revisionKind === 'retargeted'
              ? 'Retarget the predecessor ceiling behavior with coupled constraints, seeded near misses, and independently measurable checks.'
              : 'Rebalance the predecessor design around staged partial outcomes and a deterministic middle-discrimination rubric.',
        task_specific_delta:
          revisionKind === 'replacement'
            ? `Replace the prior controlled scenario with two independently attainable stages: first "${draft.checks[0]}", then "${draft.checks[1]}"; reserve full credit for also satisfying "${draft.checks[2]}" and the domain discrimination check.`
            : revisionKind === 'retargeted'
              ? `Add matched near-miss variants where "${draft.checks[0]}" holds while either "${draft.checks[1]}" or "${draft.checks[2]}" fails; score each outcome independently before the domain discrimination check.`
              : `Split the controlled scenario into task-specific evidence for "${draft.checks[0]}", "${draft.checks[1]}", and "${draft.checks[2]}" before applying the domain discrimination check.`,
        controlled_corpus_requirements: [
          'Provide at least three deterministic assertions for each published scoring component.',
          'Include low-partial, high-partial, near-miss, alternate-correct, empty, timeout, and paired-contrast cases.',
          'Ensure no single assertion or output-format check contributes more than 0.20 to the task score.',
          'Document exact expected score vectors for every acceptance case before model execution.',
        ],
      },
      input_contract: {
        kind: draft.inputKind,
        fixture_profile: `aiq-fixture://${taskId}/v1`,
        content_handle: `aiq-controlled-task://aiq-core/${TASK_VERSION}/${taskId}`,
      },
      cluster_id:
        CLUSTER_OVERRIDES[taskId] ??
        `${draft.domain}-cluster-${String(Math.floor(index / 2) + 1).padStart(2, '0')}`,
      allowed_tools: allowedTools,
      budget,
      evaluator: {
        kind: draft.scorer,
        scorer_version: SCORER_VERSION,
        execution_protocol: 'aiq.evaluator-protocol.v1',
        binding_requirement: 'controlled_hidden_task_required',
        deterministic: true,
        partial_credit: true,
        pass_conditions:
          draft.domain === 'tool_use'
            ? [...rubricCriteria, COMMAND_EXECUTION_DISCLOSURE]
            : rubricCriteria,
        scoring_contract: {
          aggregation: 'weighted_assertion_fraction',
          assertion_scoring: 'binary_equal_weight_within_component',
          missing_or_error_score: 0,
          rounding: 'no_intermediate_rounding_final_six_decimals',
          formula:
            'sum(component_weight_basis_points / 10000 * passed_assertions / total_assertions)',
          score_range: [0, 1],
          minimum_assertions_per_component: 3,
          components: rubricCriteria.map((criterion, componentIndex) => ({
            component_id: `component_${String(componentIndex + 1).padStart(2, '0')}`,
            weight_basis_points: rubricWeights[componentIndex] ?? 0,
            criterion,
          })),
        },
        acceptance_fixture_commitments: acceptanceFixtureCommitments(taskId),
      },
      tags: draft.tags,
      visibility: 'hidden',
      provenance: {
        origin: 'calibration_driven_redesign',
        owner: 'AIQ benchmark maintainers',
        recorded_date: '2026-08-02',
        predecessor_task_version: '1.0.1',
        source: 'scripts/candidates/aiq-core-1.0.2/generate-benchmark-catalog.ts',
      },
      leakage_review: {
        status: 'public_design_versioned_private_content_required',
        owner: 'AIQ benchmark maintainers',
        review_requirement: 'private_corpus_tests_and_catalog_binding_required',
        notes:
          draft.domain === 'retrieval_verification' || (draft.domain === 'tool_use' && index === 3)
            ? `${taskId} publishes a versioned frozen-source verification/synthesis design and scorer contract only. It does not measure live source discovery. Its private prompt, captured fixture, expected outputs, executable checks, and leakage note must bind this exact catalog entry and pass the deterministic corpus tests before a real run.`
            : `${taskId} publishes the versioned ${draft.inputKind} design and scorer contract only. Its private prompt, fixture, expected outputs, executable checks, and leakage note must bind this exact catalog entry and pass the deterministic corpus tests before a real run.`,
      },
    };
  });

  return {
    schema_version: 'aiq.catalog.v1',
    task_set_id: 'aiq-core',
    task_set_version: TASK_SET_VERSION,
    title: 'AIQ Core Daily Work Benchmark',
    status: 'candidate_requires_controlled_release_gate',
    generated_from: 'scripts/candidates/aiq-core-1.0.2/generate-benchmark-catalog.ts',
    predecessor_catalog: PREDECESSOR_CATALOG,
    task_metadata_identity: {
      algorithm: 'sha256',
      canonicalization: 'aiq.sorted-key-json.v1',
      digest: taskMetadataIdentityDigest(tasks),
      scope: 'ordered_full_task_metadata',
    },
    catalog_release_identity: {
      algorithm: 'sha256',
      canonicalization: 'aiq.sorted-key-json.v1',
      digest: catalogReleaseIdentityDigest(
        taskMetadataIdentityDigest(tasks),
        RELEASE_GATE_POLICY,
        PREDECESSOR_CATALOG,
      ),
      scope: 'task_metadata_identity_release_policy_and_predecessor',
    },
    content_policy: {
      public_repository: 'Metadata, schemas, public examples, and synthetic scoring fixtures only.',
      controlled_source:
        'Current benchmark prompts, expected outputs, executable hidden fixtures, and secrets must be loaded from private Supabase Storage or a runner-local controlled directory.',
    },
    distribution: {
      total: TASKS.length,
      domains: DOMAIN_QUOTAS,
      difficulties: DIFFICULTY_QUOTAS,
      domain_difficulty: DOMAIN_DIFFICULTY_QUOTAS,
      difficulty_role:
        'Difficulty is a provisional, non-ordinal coverage label. It is not an empirical rank, does not set score weight, and must not be interpreted as calibrated until the 1.0.2 controlled release gate passes.',
    },
    release_gate_policy: RELEASE_GATE_POLICY,
    tasks,
  };
}

export function assertCatalogInvariants(catalog: ReturnType<typeof buildCatalog>): void {
  if (catalog.distribution.total !== 72 || catalog.tasks.length !== 72) {
    throw new Error(`The catalog must contain 72 tasks; found ${String(catalog.tasks.length)}.`);
  }
  if (
    catalog.task_set_version !== TASK_SET_VERSION ||
    catalog.tasks.some(
      (catalogTask) =>
        catalogTask.task_version !== TASK_VERSION ||
        catalogTask.evaluator.scorer_version !== SCORER_VERSION ||
        catalogTask.input_contract.content_handle !==
          `aiq-controlled-task://aiq-core/${TASK_VERSION}/${catalogTask.task_id}`,
    )
  ) {
    throw new Error(
      'The current AIQ Core catalog requires task-set, task, content-handle, and scorer version 1.0.2.',
    );
  }

  const identifiers = new Set(catalog.tasks.map(({ task_id: taskId }) => taskId));
  if (identifiers.size !== catalog.tasks.length) {
    throw new Error('Every benchmark task ID must be unique.');
  }
  if (
    JSON.stringify(catalog.release_gate_policy) !== JSON.stringify(RELEASE_GATE_POLICY) ||
    JSON.stringify(catalog.predecessor_catalog) !== JSON.stringify(PREDECESSOR_CATALOG) ||
    catalog.status !== 'candidate_requires_controlled_release_gate'
  ) {
    throw new Error('AIQ Core 1.0.2 requires the preregistered controlled release gate.');
  }
  for (const domain of DOMAINS) {
    const count = catalog.tasks.filter((candidate) => candidate.domain === domain).length;
    if (count !== DOMAIN_QUOTAS[domain]) {
      throw new Error(`Domain ${domain} must contain ${String(DOMAIN_QUOTAS[domain])} tasks.`);
    }
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const domainDifficultyCount = catalog.tasks.filter(
        (candidate) => candidate.domain === domain && candidate.difficulty === difficulty,
      ).length;
      if (domainDifficultyCount !== DOMAIN_DIFFICULTY_QUOTAS[domain][difficulty]) {
        throw new Error(
          `${domain}/${difficulty} must contain ${String(DOMAIN_DIFFICULTY_QUOTAS[domain][difficulty])} tasks.`,
        );
      }
    }
  }

  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const count = catalog.tasks.filter((candidate) => candidate.difficulty === difficulty).length;
    if (count !== DIFFICULTY_QUOTAS[difficulty]) {
      throw new Error(
        `Difficulty ${difficulty} must contain ${String(DIFFICULTY_QUOTAS[difficulty])} tasks.`,
      );
    }
  }

  const unsafeTask = catalog.tasks.find(
    ({ input_contract: inputContract, visibility }) =>
      visibility !== 'hidden' ||
      !inputContract.content_handle.startsWith('aiq-controlled-task://') ||
      inputContract.content_handle.includes('supabase'),
  );
  if (unsafeTask !== undefined) {
    throw new Error(
      `Task ${unsafeTask.task_id} does not use the controlled hidden-content boundary.`,
    );
  }

  const acceptanceClasses: readonly AcceptanceFixtureClass[] = [
    'gold',
    'alternate_correct',
    'partial_low',
    'partial_high',
    'near_miss',
    'paired_contrast',
    'adversarial_format',
    'empty',
    'timeout',
  ];
  const taskSpecificDeltas = new Set<string>();
  for (const catalogTask of catalog.tasks) {
    if (
      JSON.stringify(Object.keys(catalogTask.evaluator.acceptance_fixture_commitments)) !==
      JSON.stringify(acceptanceClasses)
    ) {
      throw new Error(
        `Task ${catalogTask.task_id} does not commit every acceptance-fixture class.`,
      );
    }
    if (!/^[a-z_]+-cluster-[0-9]{2}$/u.test(catalogTask.cluster_id)) {
      throw new Error(`Task ${catalogTask.task_id} has an invalid cluster identity.`);
    }
    if (
      catalogTask.design_revision.supersedes_task_version !== '1.0.1' ||
      !catalogTask.design_revision.task_specific_delta.includes(
        catalogTask.evaluator.pass_conditions[0] ?? '',
      ) ||
      catalogTask.design_revision.controlled_corpus_requirements.length !== 4 ||
      catalogTask.evaluator.scoring_contract.components.length !== 4 ||
      catalogTask.evaluator.scoring_contract.components.reduce(
        (sum, component) => sum + component.weight_basis_points,
        0,
      ) !== 10_000
    ) {
      throw new Error(`Task ${catalogTask.task_id} does not have the required 1.0.2 redesign.`);
    }
    taskSpecificDeltas.add(catalogTask.design_revision.task_specific_delta);
    const allowedToolTokens = new Set([
      'none',
      'filesystem_read',
      'filesystem_write',
      'command_execution',
    ]);
    if (
      catalogTask.allowed_tools.some((tool) => !allowedToolTokens.has(tool)) ||
      (catalogTask.allowed_tools.includes('none') && catalogTask.allowed_tools.length !== 1) ||
      JSON.stringify(catalogTask.allowed_tools) !==
        JSON.stringify(PROFILES[catalogTask.domain].allowedTools)
    ) {
      throw new Error(`Task ${catalogTask.task_id} has an invalid allowed-tools policy.`);
    }
    const disclosureCount = catalogTask.evaluator.pass_conditions.filter(
      (condition) => condition === COMMAND_EXECUTION_DISCLOSURE,
    ).length;
    if (
      (catalogTask.domain === 'tool_use' && disclosureCount !== 1) ||
      (catalogTask.domain !== 'tool_use' && disclosureCount !== 0)
    ) {
      throw new Error(
        `Task ${catalogTask.task_id} has an invalid command-execution evidence disclosure.`,
      );
    }
    const taskOrdinal = Number.parseInt(catalogTask.task_id.slice(-2), 10) - 1;
    const taskDraft = TASKS.filter(({ domain }) => domain === catalogTask.domain)[taskOrdinal];
    if (taskDraft === undefined) {
      throw new Error(`Task ${catalogTask.task_id} does not have a matching catalog draft.`);
    }
    const expectedBudget = taskBudget(taskDraft, catalogTask.allowed_tools);
    if (JSON.stringify(catalogTask.budget) !== JSON.stringify(expectedBudget)) {
      throw new Error(`Task ${catalogTask.task_id} has a stale calibrated budget.`);
    }
  }
  if (taskSpecificDeltas.size !== catalog.tasks.length) {
    throw new Error('Every AIQ Core 1.0.2 task requires a distinct task-specific design delta.');
  }

  const clusterCounts = DOMAINS.map((domain) => {
    const clusters = new Set(
      catalog.tasks
        .filter((catalogTask) => catalogTask.domain === domain)
        .map((catalogTask) => catalogTask.cluster_id),
    );
    return [domain, clusters.size] as const;
  });
  if (
    clusterCounts.some(([, count]) => count < 3 || count > 4) ||
    clusterCounts.reduce((sum, [, count]) => sum + count, 0) !== 39
  ) {
    throw new Error(
      `The frozen cluster method requires 39 per-domain clusters with 3-4 in each domain; observed ${JSON.stringify(Object.fromEntries(clusterCounts))}.`,
    );
  }

  const distinctBudgets = new Set(
    catalog.tasks.map((catalogTask) => JSON.stringify(catalogTask.budget)),
  );
  if (
    distinctBudgets.size < 9 ||
    catalog.tasks.some(
      ({ budget }) =>
        budget.wall_seconds < 150 ||
        budget.wall_seconds > 660 ||
        budget.max_steps < 10 ||
        budget.max_steps > 48 ||
        budget.max_tool_calls < 8 ||
        budget.max_tool_calls > 33,
    )
  ) {
    throw new Error(
      'Task budgets do not reflect enough input/tool scope variation or are outside the frozen bounds.',
    );
  }

  const observedTaskIdentity = taskMetadataIdentityDigest(catalog.tasks);
  if (catalog.task_metadata_identity.digest !== observedTaskIdentity) {
    throw new Error(
      `Task metadata identity does not match its ordered task metadata: ${observedTaskIdentity}.`,
    );
  }
  if (observedTaskIdentity !== AIQ_CORE_V1_TASK_METADATA_IDENTITY_SHA256) {
    throw new Error(
      `AIQ Core 1.0.2 task metadata identity changed without a versioned commitment update: ${observedTaskIdentity}.`,
    );
  }
  const observedReleaseIdentity = catalogReleaseIdentityDigest(
    observedTaskIdentity,
    catalog.release_gate_policy,
    catalog.predecessor_catalog,
  );
  if (catalog.catalog_release_identity.digest !== observedReleaseIdentity) {
    throw new Error(
      `Catalog release identity does not match its task identity and policy: ${observedReleaseIdentity}.`,
    );
  }
  if (observedReleaseIdentity !== AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256) {
    throw new Error(
      `AIQ Core 1.0.2 catalog release identity changed without a versioned commitment update: ${observedReleaseIdentity}.`,
    );
  }
}

export function taskMetadataIdentityDigest(tasks: readonly CatalogTask[]): string {
  return digestValue(tasks);
}

export function catalogReleaseIdentityDigest(
  taskMetadataIdentity: string,
  releaseGatePolicy: ReleaseGatePolicy,
  predecessorCatalog: Catalog['predecessor_catalog'],
): string {
  return digestValue({
    task_metadata_identity: taskMetadataIdentity,
    release_gate_policy: releaseGatePolicy,
    predecessor_catalog: predecessorCatalog,
  });
}

export async function writeCatalog(outputPath: string): Promise<void> {
  const catalog = buildCatalog();
  assertCatalogInvariants(catalog);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(catalog, undefined, 2)}\n`, 'utf8');
}

if (import.meta.main) {
  const outputPath = fileURLToPath(
    new URL('../../../benchmarks/candidates/aiq-core-1.0.2/catalog.json', import.meta.url),
  );
  await writeCatalog(outputPath);
}
