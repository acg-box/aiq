import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog as buildPriorCatalog } from '../aiq-core-1.0.7/generate-benchmark-catalog.ts';
import {
  assertGeneratedResponseContract,
  assertSchemaOwnedResponseFieldTypes,
  parseTaskResponseSourceAuthority,
  RESPONSE_FIELD_TYPES,
  type TaskResponseSourceAuthority,
} from './private-authoring-validator.ts';

const TASK_SET_VERSION = '1.1.0' as const;
const TASK_SCORER_VERSION = '1.0.6' as const;
const GENERATOR_PATH = 'scripts/candidates/aiq-core-1.1.0/generate-benchmark-catalog.ts';
const DECISION_PATH = 'benchmarks/candidates/aiq-core-1.1.0/design-decisions.json';
const TASK_RESPONSE_AUTHORITY_PATH =
  'benchmarks/candidates/aiq-core-1.1.0/task-response-authority.json';
const CANDIDATE_ID = 'aiq-core/1.1.0-candidate.17' as const;
const PREDECESSOR_CANDIDATE_ID = 'aiq-core/1.1.0-candidate.16' as const;
const RESPONSE_SOURCE_PREDECESSOR_CANDIDATE_ID = 'aiq-core/1.1.0-candidate.11' as const;
const CANDIDATE_9_ID = 'aiq-core/1.1.0-candidate.9' as const;
const CANDIDATE_8_ID = 'aiq-core/1.1.0-candidate.8' as const;
const TASK_ISSUE_PREDECESSOR_CANDIDATE_ID = 'aiq-core/1.1.0-candidate.5' as const;
const PREDECESSOR_SOURCE_COMMIT = '0be3fad7611735ed327f901e7667344e47665c8b' as const;
const PREDECESSOR_SOURCE_TREE = '77d0b5da585dbdc66c26cde714c4a2de27de2458' as const;
const PREDECESSOR_TASK_METADATA_SHA256 =
  'sha256:c36bdd9246f5c56f8cf5df83c690618da1a32e3f5023aba29343c54594d10fd1' as const;
const PREDECESSOR_CATALOG_CANONICAL_SHA256 =
  'sha256:c0d2ec225ba50b1cbc7c95e8d98f94c59f13e27561a448f645779e1bea5085cb' as const;
const PREDECESSOR_TASK_FACING_SEMANTICS_SHA256 =
  'sha256:36633afa4103ddb893a6aef5df07653604c7410d4ac215baca4687db93fb5e54' as const;
const PREDECESSOR_CATALOG_ENTRY_BINDINGS_SHA256 =
  'sha256:d9c62b115ae44a7eb2765f4e1f6918518d6848741a1cc8af9b05194ba00ee689' as const;
const PREDECESSOR_PUBLIC_CONTRACT_PROJECTION_SHA256 =
  'sha256:0a374048519db653e99f3bef5eb691cc7a5c1923aa2c21640ebbcf70aa321df5' as const;
const PREDECESSOR_EVALUATOR_FIXTURE_TOOL_SHA256 =
  'sha256:77d35f389f664b960ac837d687a3e8b31e9b1f8efc3dd5712b2c1512e96f8837' as const;
const CANDIDATE_5_CATALOG_ENTRY_BINDINGS_SHA256 =
  'sha256:c37b87e8458209826164c48e74d0292c426be9b0c60dc18e664253a22bc7a95c' as const;
const BRIDGE_PREDECESSOR_CANDIDATE_ID = 'aiq-core/1.1.0-candidate.6' as const;
const BRIDGE_PREDECESSOR_COMMITMENT_SHA256 =
  'sha256:37291d7da5f2b5d5b112b54b8ce1b296c20f718ebead87c14118056769e47011' as const;
const QUALIFICATION_BRIDGE_DIAGNOSIS_TASK_IDENTITY =
  '01a04786-3f39-7852-a41b-fb57bd73dfad' as const;
const CANDIDATE_7_REJECTION_TASK_IDENTITY = '01a04b9e-903b-72d2-9819-8b0c2fde6336' as const;
const PACKAGE_INPUT_DIAGNOSIS_TASK_IDENTITY = '01a04786-3f39-7852-a41b-fb57bd73dfad' as const;
const NODE_RUNTIME_CORRECTION_TASK_IDENTITY = '01a04c55-70b2-7943-89e1-e18e78f0f9ed' as const;
const SOURCE_END_TO_END_PREDECESSOR_CANDIDATE_ID = 'aiq-core/1.1.0-candidate.7' as const;
const REQUIRED_COMMAND = 'node bin/task-tool.mjs' as const;
const REQUIRED_COMMAND_SHA256 =
  'sha256:6763cc80f8294b52c6494f1c9891e41a8e3cd1c466ca622377c59643a0466319' as const;
const RECEIPT_FIELDS = Object.freeze([
  'schema_version',
  'task_id',
  'tool_contract_id',
  'command_sha256',
  'input_sha256',
  'output_sha256',
  'invocation_count',
  'receipt_sha256',
] as const);
const PREDECESSOR_UNDISCLOSED_RECEIPT_FIELDS = Object.freeze([] as const);
const REVISED_TASK_IDS = Object.freeze([
  'tool-use-01',
  'tool-use-02',
  'tool-use-03',
  'tool-use-04',
  'tool-use-05',
  'tool-use-06',
  'tool-use-07',
] as const);
const CALIBRATION_REAUTHORED_TASK_IDS = Object.freeze([
  'data-processing-02',
  'data-processing-04',
  'data-processing-05',
  'data-processing-08',
  'documentation-communication-01',
  'documentation-communication-03',
  'documentation-communication-04',
  'documentation-communication-05',
  'documentation-communication-06',
  'documentation-communication-07',
  'instruction-following-03',
  'instruction-following-04',
  'planning-execution-01',
  'planning-execution-02',
  'planning-execution-03',
  'planning-execution-04',
  'planning-execution-05',
  'planning-execution-06',
  'planning-execution-07',
  'reliability-recovery-01',
  'reliability-recovery-02',
  'reliability-recovery-03',
  'reliability-recovery-05',
  'repository-understanding-01',
  'repository-understanding-02',
  'repository-understanding-03',
  'repository-understanding-04',
  'repository-understanding-05',
  'repository-understanding-06',
  'repository-understanding-07',
  'retrieval-verification-01',
  'retrieval-verification-02',
  'retrieval-verification-03',
  'retrieval-verification-04',
  'retrieval-verification-05',
  'retrieval-verification-07',
] as const);
const CALIBRATION_REVISED_TASK_IDS = Object.freeze([
  ...CALIBRATION_REAUTHORED_TASK_IDS,
  ...REVISED_TASK_IDS,
] as const);
const REJECTED_CALIBRATION_RUN_SHA256 =
  'sha256:c4d682eafe0a73bd7d869c38c59b126e07878b37661abf783f9fa011abfd24a9' as const;
const REJECTED_CALIBRATION_PACKAGE_SHA256 =
  'sha256:56b0e9b03968ffa2c1d91bb67c1861c384edd5e16ac8100524df78741085cc6b' as const;
const REQUIRED_TOOL_INVOCATIONS = Object.freeze({
  'tool-use-01': 1,
  'tool-use-02': 1,
  'tool-use-03': 1,
  'tool-use-04': 1,
  'tool-use-05': 1,
  'tool-use-06': 1,
  'tool-use-07': 1,
} satisfies Readonly<Record<(typeof REVISED_TASK_IDS)[number], number>>);

function isRevisedTaskId(value: string): value is (typeof REVISED_TASK_IDS)[number] {
  return REVISED_TASK_IDS.some((candidate) => candidate === value);
}

type JsonObject = Record<string, unknown>;
type Decision = 'retained' | 'revised';
type FixtureApplicability = 'required' | 'not_applicable';

interface PublicTaskRevision {
  readonly title: string;
  readonly summary: string;
  readonly input_contract_kind: string;
  readonly evaluator_kind: string;
  readonly pass_conditions: readonly string[];
  readonly allowed_tools: readonly string[];
  readonly tags: readonly string[];
}

interface CandidateReview {
  readonly verdict: 'approved' | 'rejected';
  readonly record_sha256: string;
  readonly task_definition_sha256: string;
  readonly catalog_entry_sha256: string;
  readonly issue_codes: readonly IssueCode[];
}

interface CandidateContract {
  readonly construct_id: string;
  readonly response_contract: ResponseContract;
  readonly receipt_contract: Readonly<JsonObject> | null;
  readonly fixture_applicability: TaskDecision['acceptance_fixture_applicability'];
  readonly mechanism_classes: readonly string[];
  readonly falsifiers: readonly string[];
  readonly coverage_claims: readonly string[];
}

interface CandidateFiveContract extends CandidateContract {
  readonly scenario_contract: Readonly<JsonObject> | null;
  readonly operation_contract: Readonly<JsonObject> | null;
  readonly semantic_result_contract: Readonly<JsonObject> | null;
}

interface TaskDecision {
  readonly task_id: string;
  readonly decision: 'retained';
  readonly predecessor_decision: Decision;
  readonly candidate_5_catalog_entry_sha256: string;
  readonly candidate_5_task_facing_semantics_sha256: string;
  readonly cluster_id: string;
  readonly acceptance_fixture_applicability: {
    readonly gold: FixtureApplicability;
    readonly alternate_correct: FixtureApplicability;
    readonly partial: FixtureApplicability;
    readonly adversarial_format: FixtureApplicability;
    readonly empty: FixtureApplicability;
    readonly timeout: FixtureApplicability;
  };
  readonly rationale: string;
  readonly public_task_revision: PublicTaskRevision | null;
  readonly candidate_2_review: CandidateReview;
  readonly candidate_3_contract: CandidateContract;
  readonly candidate_3_review: CandidateReview;
  readonly candidate_4_contract: CandidateContract;
  readonly candidate_4_review: CandidateReview;
  readonly candidate_5_contract: CandidateFiveContract;
}

interface PublicTaskResponseAuthority extends TaskResponseSourceAuthority {
  readonly task_id: string;
}

interface TaskResponseAuthorityManifest {
  readonly schema_version: 'aiq.public-task-response-authority.v1';
  readonly task_set_version: '1.1.0';
  readonly authority: 'independent_public_safe_task_source_projection';
  readonly tasks: readonly PublicTaskResponseAuthority[];
}

const ISSUE_CODES = Object.freeze([
  'ACCEPTANCE_SEMANTICS_INVALID',
  'BEHAVIORAL_COVERAGE_GAP',
  'CROSS_TASK_CONSTRUCT_DUPLICATION',
  'HIDDEN_OUTPUT_SCHEMA',
  'KEYWORD_ONLY_EVALUATOR',
  'PUBLIC_PRIVATE_CONSTRUCT_MISMATCH',
  'PUBLIC_SEMANTIC_CONTAMINATION',
  'TOOL_EVIDENCE_UNBOUND',
] as const);
type IssueCode = (typeof ISSUE_CODES)[number];
const EXPECTED_PREDECESSOR_REVIEW_ISSUE_COUNTS = Object.freeze({
  ACCEPTANCE_SEMANTICS_INVALID: 0,
  BEHAVIORAL_COVERAGE_GAP: 7,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 7,
  HIDDEN_OUTPUT_SCHEMA: 0,
  KEYWORD_ONLY_EVALUATOR: 0,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7,
  PUBLIC_SEMANTIC_CONTAMINATION: 0,
  TOOL_EVIDENCE_UNBOUND: 0,
} satisfies Readonly<Record<IssueCode, number>>);
const EXPECTED_CLOSURE_ISSUE_COUNTS = Object.freeze({
  ACCEPTANCE_SEMANTICS_INVALID: 0,
  BEHAVIORAL_COVERAGE_GAP: 7,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 7,
  HIDDEN_OUTPUT_SCHEMA: 7,
  KEYWORD_ONLY_EVALUATOR: 0,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 14,
  PUBLIC_SEMANTIC_CONTAMINATION: 0,
  TOOL_EVIDENCE_UNBOUND: 7,
} satisfies Readonly<Record<IssueCode, number>>);
const ISSUE_MECHANISMS = Object.freeze({
  ACCEPTANCE_SEMANTICS_INVALID: 'class_specific_semantic_replay',
  BEHAVIORAL_COVERAGE_GAP: 'executable_transition_and_invariant_coverage',
  CROSS_TASK_CONSTRUCT_DUPLICATION: 'unique_construct_redesign',
  HIDDEN_OUTPUT_SCHEMA: 'complete_receipt_contract_disclosure',
  KEYWORD_ONLY_EVALUATOR: 'structured_semantic_evaluation',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'public_private_receipt_contract_alignment',
  PUBLIC_SEMANTIC_CONTAMINATION: 'first_principles_private_regeneration',
  TOOL_EVIDENCE_UNBOUND: 'runner_event_and_content_receipt_binding',
} satisfies Readonly<Record<IssueCode, string>>);
const CANDIDATE_5_ISSUE_MECHANISMS = Object.freeze({
  BEHAVIORAL_COVERAGE_GAP: 'metamorphic_behavior_coverage',
  CROSS_TASK_CONSTRUCT_DUPLICATION: 'distinct_cross_task_behavior_signatures',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'public_private_scenario_operation_alignment',
} satisfies Readonly<
  Record<
    | 'BEHAVIORAL_COVERAGE_GAP'
    | 'CROSS_TASK_CONSTRUCT_DUPLICATION'
    | 'PUBLIC_PRIVATE_CONSTRUCT_MISMATCH',
    string
  >
>);
const CANDIDATE_5_ISSUE_FALSIFIERS = Object.freeze({
  BEHAVIORAL_COVERAGE_GAP: 'perturb_each_task_specific_scenario_field',
  CROSS_TASK_CONSTRUCT_DUPLICATION: 'substitute_each_cross_task_supplied_tool',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'substitute_same_shape_wrong_input',
} satisfies Readonly<
  Record<
    | 'BEHAVIORAL_COVERAGE_GAP'
    | 'CROSS_TASK_CONSTRUCT_DUPLICATION'
    | 'PUBLIC_PRIVATE_CONSTRUCT_MISMATCH',
    string
  >
>);
const ISSUE_FALSIFIERS = Object.freeze({
  ACCEPTANCE_SEMANTICS_INVALID: 'swap_or_collapse_acceptance_class_outcomes',
  BEHAVIORAL_COVERAGE_GAP: 'remove_one_claimed_transition_or_error_path',
  CROSS_TASK_CONSTRUCT_DUPLICATION: 'force_two_tasks_to_share_one_construct_id',
  HIDDEN_OUTPUT_SCHEMA: 'inject_receipt_field_schema_or_transport_mismatch',
  KEYWORD_ONLY_EVALUATOR: 'replace_semantic_checks_with_lexical_presence',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'change_private_receipt_contract_only',
  PUBLIC_SEMANTIC_CONTAMINATION: 'reinsert_a_rejected_identifier_hash',
  TOOL_EVIDENCE_UNBOUND: 'remove_runner_evidence_or_break_receipt_digest_binding',
} satisfies Readonly<Record<IssueCode, string>>);

interface ResponseContract {
  readonly shape_kind: string;
  readonly transport: string;
  readonly locations: readonly string[];
  readonly required_fields: readonly string[];
  readonly optional_fields: readonly string[];
  readonly field_types: Readonly<Record<string, string>>;
  readonly field_semantics: Readonly<Record<string, string>>;
}

function receiptContractMatchesTask(decision: TaskDecision): boolean {
  const receiptContract = decision.candidate_5_contract.receipt_contract;
  if (!isRevisedTaskId(decision.task_id)) return receiptContract === null;
  return (
    receiptContract !== null &&
    receiptContract.required_invocations === REQUIRED_TOOL_INVOCATIONS[decision.task_id]
  );
}

export interface CandidateDecisionManifest {
  readonly schema_version: 'aiq.candidate-design-decisions.v17';
  readonly candidate_id: typeof CANDIDATE_ID;
  readonly candidate_task_set_version: '1.1.0';
  readonly recorded_date: '2026-08-30';
  readonly authority: 'candidate_16_independent_review_repair';
  readonly predecessor_candidate: {
    readonly candidate_id: typeof PREDECESSOR_CANDIDATE_ID;
    readonly disposition: 'rejected_independent_review_optional_field_and_delivery_drift';
    readonly source_commit: typeof PREDECESSOR_SOURCE_COMMIT;
    readonly source_tree: typeof PREDECESSOR_SOURCE_TREE;
    readonly catalog_canonical_sha256: typeof PREDECESSOR_CATALOG_CANONICAL_SHA256;
    readonly catalog_entry_bindings_sha256: typeof PREDECESSOR_CATALOG_ENTRY_BINDINGS_SHA256;
    readonly task_metadata_sha256: typeof PREDECESSOR_TASK_METADATA_SHA256;
    readonly public_contract_projection_sha256: typeof PREDECESSOR_PUBLIC_CONTRACT_PROJECTION_SHA256;
    readonly task_facing_semantics_sha256: typeof PREDECESSOR_TASK_FACING_SEMANTICS_SHA256;
    readonly task_semantics: 'public_contract_retained_private_optional_semantics_repaired_43';
    readonly task_issue_closure_entries: 42;
    readonly semantic_retention_rule: 'candidate_16_public_contract_retained_private_optional_semantics_repaired_43';
  };
  readonly immutable_rejected_predecessors: readonly [
    'aiq-core/1.1.0-candidate.1',
    'aiq-core/1.1.0-candidate.2',
    'aiq-core/1.1.0-candidate.3',
    'aiq-core/1.1.0-candidate.4',
    'aiq-core/1.1.0-candidate.5',
    'aiq-core/1.1.0-candidate.6',
    'aiq-core/1.1.0-candidate.7',
    'aiq-core/1.1.0-candidate.8',
    'aiq-core/1.1.0-candidate.9',
    'aiq-core/1.1.0-candidate.10',
    'aiq-core/1.1.0-candidate.11',
    'aiq-core/1.1.0-candidate.12',
    'aiq-core/1.1.0-candidate.13',
    'aiq-core/1.1.0-candidate.14',
    'aiq-core/1.1.0-candidate.15',
    'aiq-core/1.1.0-candidate.16',
  ];
  readonly calibration_policy_repair: {
    readonly schema_version: 'aiq.candidate-calibration-repair.v1';
    readonly predecessor_run_sha256: typeof REJECTED_CALIBRATION_RUN_SHA256;
    readonly predecessor_package_sha256: typeof REJECTED_CALIBRATION_PACKAGE_SHA256;
    readonly policy_version: 'aiq.official-calibration-policy.v2';
    readonly observed_informative_tasks: 18;
    readonly observed_non_uniform_tasks: 22;
    readonly observed_universal_semantic_zero_tasks: 10;
    readonly observed_universal_full_credit_tasks: 38;
    readonly reauthored_structured_task_ids: readonly string[];
    readonly repaired_tool_task_ids: readonly string[];
    readonly retained_task_count: 29;
    readonly revised_task_count: 43;
    readonly policy_change: false;
  };
  readonly retained_candidate_5_task_issue_closures: {
    readonly predecessor_candidate_id: typeof TASK_ISSUE_PREDECESSOR_CANDIDATE_ID;
    readonly successor_candidate_id: 'aiq-core/1.1.0-candidate.17';
    readonly disposition: 'preserved_unchanged_and_revalidated';
    readonly closure_entries: 42;
    readonly issue_code_counts: Readonly<Record<IssueCode, number>>;
  };
  readonly source_integrity_closure: {
    readonly issue_code: 'QUALIFICATION_EVIDENCE_BRIDGE_UNAUTHENTICATED';
    readonly scope: 'trusted_execution_and_evidence_bridge';
    readonly status: 'closed_in_candidate_7';
    readonly counts_toward_task_issue_closures: false;
    readonly diagnosis_task_identity: typeof QUALIFICATION_BRIDGE_DIAGNOSIS_TASK_IDENTITY;
    readonly predecessor_candidate_id: typeof BRIDGE_PREDECESSOR_CANDIDATE_ID;
    readonly predecessor_commitment_sha256: typeof BRIDGE_PREDECESSOR_COMMITMENT_SHA256;
    readonly runtime_authority: 'explicit_candidate_qualification_boundary';
    readonly regression: 'replay_verified_projection_and_candidate_route_substitution_suite';
  };
  readonly source_end_to_end_validation_closure: {
    readonly issue_code: 'CANDIDATE_VALIDATION_CONTEXT_DROPPED_AFTER_PREPARATION';
    readonly scope: 'completed_run_recovery_and_package_validation';
    readonly status: 'closed_in_candidate_8';
    readonly counts_toward_task_issue_closures: false;
    readonly diagnosis_task_identity: typeof CANDIDATE_7_REJECTION_TASK_IDENTITY;
    readonly predecessor_candidate_id: typeof SOURCE_END_TO_END_PREDECESSOR_CANDIDATE_ID;
    readonly failure_class: 'candidate_provenance_routed_to_active_validator_after_model_work';
    readonly repair: 'provenance_bound_in_process_validation_context';
    readonly regression: 'candidate_completed_recovery_package_and_active_rejection_suite';
  };
  readonly package_input_validation_closure: {
    readonly issue_code: 'CANDIDATE_PACKAGE_VALIDATION_AUTHORITY_DERIVED_FROM_SAVED_RUN';
    readonly scope: 'candidate_package_input_and_signed_payload_validation';
    readonly status: 'closed_in_candidate_9';
    readonly counts_toward_task_issue_closures: false;
    readonly diagnosis_task_identity: typeof PACKAGE_INPUT_DIAGNOSIS_TASK_IDENTITY;
    readonly predecessor_candidate_id: typeof CANDIDATE_8_ID;
    readonly failure_class: 'saved_calibration_selected_its_own_candidate_validation_context';
    readonly repair: 'independent_tasks_corpus_and_source_bound_through_package_serialization';
    readonly regression: 'candidate_package_input_mismatch_and_current_byte_identity_suite';
  };
  readonly node_runtime_correction_closure: {
    readonly issue_code: 'CANDIDATE_NODE_RUNTIME_IDENTITY_DRIFT';
    readonly scope: 'private_authoring_build_and_readback_runtime';
    readonly status: 'closed_in_candidate_9';
    readonly counts_toward_task_issue_closures: false;
    readonly diagnosis_task_identity: typeof NODE_RUNTIME_CORRECTION_TASK_IDENTITY;
    readonly predecessor_candidate_id: typeof CANDIDATE_8_ID;
    readonly expected_node_version: 'v24.18.0';
    readonly predecessor_observed_node_version: 'v24.19.0';
    readonly repair: 'checked_in_node_version_enforced_at_private_build_and_readback';
    readonly regression: 'candidate_private_build_and_readback_runtime_mismatch_suite';
  };
  readonly public_response_contract_validation_closure: {
    readonly issue_code: 'PUBLIC_RESPONSE_CONTRACT_SOURCE_OR_SCHEMA_DRIFT';
    readonly scope: 'catalog_response_locations_and_field_types';
    readonly status: 'closed_in_candidate_10';
    readonly counts_toward_task_issue_closures: false;
    readonly predecessor_candidate_id: typeof CANDIDATE_9_ID;
    readonly rejected_location: 'debugging-04:src/task.mjs';
    readonly corrected_location: 'debugging-04:src/task.ts';
    readonly rejected_field_type: 'instruction-following-05:calculation_note:undefined';
    readonly corrected_field_type: 'instruction-following-05:calculation_note:string';
    readonly repair: 'schema_owned_response_types_and_task_owned_source_locations';
    readonly regression: 'generic_catalog_mutation_and_private_source_counterexample_suite';
  };
  readonly response_source_authority_closure: {
    readonly issue_code: 'PRIVATE_RESPONSE_SOURCE_OWNER_MISIDENTIFIED';
    readonly scope: 'private_authoring_response_source_derivation';
    readonly status: 'closed_in_candidate_12';
    readonly counts_toward_task_issue_closures: false;
    readonly predecessor_candidate_id: typeof RESPONSE_SOURCE_PREDECESSOR_CANDIDATE_ID;
    readonly failure_class: 'protected_hashes_treated_as_outputs_and_final_mode_inferred_from_policy_absence';
    readonly repair: 'derive_response_mode_and_mutable_locations_from_existing_serialized_task_owner';
    readonly regression: 'production_shaped_private_derivation_and_real_72_task_integration';
  };
  readonly task_issue_code_counts: Readonly<Record<IssueCode, number>>;
  readonly lifecycle: {
    readonly identity_state: 'frozen_for_independent_review';
    readonly active: false;
    readonly production_publishable: false;
    readonly independent_review: 'pending';
    readonly seal: 'pending';
    readonly calibration: 'pending';
    readonly qualification: 'pending';
    readonly release: 'pending';
    readonly activation: 'pending';
    readonly deployment: 'pending';
    readonly production_acceptance: 'pending';
  };
  readonly decisions: readonly TaskDecision[];
}

const REQUIRED_FIXTURE_CLASSES = Object.freeze([
  'gold',
  'alternate_correct',
  'partial',
  'adversarial_format',
] as const);
const OPTIONAL_FIXTURE_CLASSES = Object.freeze(['empty', 'timeout'] as const);
const CONTROLLED_CORPUS_REQUIREMENTS = Object.freeze([
  'Use this exact catalog entry as the sole expected acceptance-fixture applicability authority and require exact equality with observed controlled classes.',
  'Supply exactly one independently authored aiq.leakage-review.v2 record that binds the reviewer, source, task definition, catalog entry, method, scope, verdict, time, and notes.',
  'Keep the AIQ task scorer 1.0.6 configured weighted binary check fraction with hard gates unchanged and replay every applicable fixture deterministically.',
  'Do not qualify or publish this candidate until one predeclared complete non-synthetic 3-by-72 family-representative matrix passes aiq.benchmark-qualification-policy.v2.',
] as const);

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function unknownArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const observed = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (observed.length !== wanted.length || observed.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

function fixtureApplicability(value: unknown, label: string): FixtureApplicability {
  if (!['required', 'not_applicable'].includes(String(value))) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value === 'required' ? 'required' : 'not_applicable';
}

function stringArray(value: unknown, label: string): readonly string[] {
  return unknownArray(value, label).map((item, index) =>
    stringValue(item, `${label} ${String(index)}`),
  );
}

function parseTaskResponseAuthorityManifest(value: unknown): TaskResponseAuthorityManifest {
  const manifest = jsonObject(value, 'task response authority manifest');
  exactKeys(
    manifest,
    ['authority', 'schema_version', 'task_set_version', 'tasks'],
    'task response authority manifest',
  );
  if (
    manifest.schema_version !== 'aiq.public-task-response-authority.v1' ||
    manifest.task_set_version !== TASK_SET_VERSION ||
    manifest.authority !== 'independent_public_safe_task_source_projection'
  ) {
    throw new TypeError('Task response authority identity is invalid.');
  }
  const tasks = unknownArray(manifest.tasks, 'task response authorities').map((entry, index) => {
    const task = jsonObject(entry, `task response authority ${String(index)}`);
    exactKeys(
      task,
      ['response_locations', 'response_mode', 'task_id'],
      `task response authority ${String(index)}`,
    );
    const authority = parseTaskResponseSourceAuthority(
      task,
      `task response authority ${String(index)}`,
    );
    return {
      task_id: stringValue(task.task_id, `task response authority ${String(index)} task id`),
      response_mode: authority.response_mode,
      response_locations: authority.response_locations,
    };
  });
  return {
    schema_version: 'aiq.public-task-response-authority.v1',
    task_set_version: TASK_SET_VERSION,
    authority: 'independent_public_safe_task_source_projection',
    tasks,
  };
}

function digestValueInput(value: unknown, label: string): string {
  const digest = stringValue(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new TypeError(`${label} is invalid.`);
  return digest;
}

function fixtureApplicabilityMap(
  value: unknown,
  label: string,
): TaskDecision['acceptance_fixture_applicability'] {
  const fixture = jsonObject(value, label);
  exactKeys(
    fixture,
    ['adversarial_format', 'alternate_correct', 'empty', 'gold', 'partial', 'timeout'],
    label,
  );
  return {
    gold: fixtureApplicability(fixture.gold, `${label} gold`),
    alternate_correct: fixtureApplicability(
      fixture.alternate_correct,
      `${label} alternate_correct`,
    ),
    partial: fixtureApplicability(fixture.partial, `${label} partial`),
    adversarial_format: fixtureApplicability(
      fixture.adversarial_format,
      `${label} adversarial_format`,
    ),
    empty: fixtureApplicability(fixture.empty, `${label} empty`),
    timeout: fixtureApplicability(fixture.timeout, `${label} timeout`),
  };
}

function responseContract(value: unknown, label: string): ResponseContract {
  const contract = jsonObject(value, label);
  exactKeys(
    contract,
    [
      'field_semantics',
      'field_types',
      'locations',
      'optional_fields',
      'required_fields',
      'shape_kind',
      'transport',
    ],
    label,
  );
  const semantics = jsonObject(contract.field_semantics, `${label} field semantics`);
  const types = jsonObject(contract.field_types, `${label} field types`);
  const fieldSemantics = Object.fromEntries(
    Object.entries(semantics).map(([field, meaning]) => [
      field,
      stringValue(meaning, `${label} field ${field}`),
    ]),
  );
  const fieldTypes = Object.fromEntries(
    Object.entries(types).map(([field, type]) => [
      field,
      stringValue(type, `${label} field type ${field}`),
    ]),
  );
  const parsed = {
    shape_kind: stringValue(contract.shape_kind, `${label} shape kind`),
    transport: stringValue(contract.transport, `${label} transport`),
    locations: stringArray(contract.locations, `${label} locations`),
    required_fields: stringArray(contract.required_fields, `${label} required fields`),
    optional_fields: stringArray(contract.optional_fields, `${label} optional fields`),
    field_types: fieldTypes,
    field_semantics: fieldSemantics,
  };
  assertSchemaOwnedResponseFieldTypes(parsed, label);
  return parsed;
}

function historicalToolReceiptContract(value: unknown, label: string): Readonly<JsonObject> | null {
  return value === null ? null : jsonObject(value, label);
}

function toolReceiptContract(value: unknown, label: string): Readonly<JsonObject> | null {
  if (value === null) return null;
  const contract = jsonObject(value, label);
  exactKeys(
    contract,
    [
      'additional_fields',
      'canonicalization',
      'field_producers',
      'field_semantics',
      'field_types',
      'field_verification',
      'key_order',
      'location',
      'model_obligation',
      'optional_fields',
      'predecessor_undisclosed_fields',
      'producer',
      'required_command',
      'required_command_sha256',
      'required_fields',
      'required_invocations',
      'result_binding',
      'runner_binding',
      'schema_version',
      'tool_evidence_requirements',
      'transport',
    ],
    label,
  );
  const requiredFields = stringArray(contract.required_fields, `${label} required fields`);
  const optionalFields = stringArray(contract.optional_fields, `${label} optional fields`);
  const predecessorFields = stringArray(
    contract.predecessor_undisclosed_fields,
    `${label} predecessor undisclosed fields`,
  );
  const fieldTypes = jsonObject(contract.field_types, `${label} field types`);
  const fieldSemantics = jsonObject(contract.field_semantics, `${label} field semantics`);
  const fieldProducers = jsonObject(contract.field_producers, `${label} field producers`);
  const fieldVerification = jsonObject(contract.field_verification, `${label} field verification`);
  for (const [field, fields] of [
    ['field_types', fieldTypes],
    ['field_semantics', fieldSemantics],
    ['field_producers', fieldProducers],
    ['field_verification', fieldVerification],
  ] as const) {
    exactKeys(fields, RECEIPT_FIELDS, `${label} ${field}`);
  }
  const canonicalization = jsonObject(contract.canonicalization, `${label} canonicalization`);
  exactKeys(
    canonicalization,
    [
      'command_sha256',
      'digest_algorithm',
      'digest_prefix',
      'input_sha256',
      'json',
      'output_sha256',
      'receipt_sha256',
    ],
    `${label} canonicalization`,
  );
  const resultBinding = jsonObject(contract.result_binding, `${label} result binding`);
  exactKeys(resultBinding, ['location', 'receipt_digest_field'], `${label} result binding`);
  const runnerBinding = jsonObject(contract.runner_binding, `${label} runner binding`);
  exactKeys(
    runnerBinding,
    ['automatic_fields', 'producer', 'receipt_fields_automatic', 'relationship', 'transport'],
    `${label} runner binding`,
  );
  const toolEvidenceRequirements = jsonObject(
    contract.tool_evidence_requirements,
    `${label} tool evidence requirements`,
  );
  exactKeys(
    toolEvidenceRequirements,
    ['exact_calls_by_tool', 'exact_total_calls', 'required_completed_command_sha256'],
    `${label} tool evidence requirements`,
  );
  const exactCallsByTool = jsonObject(
    toolEvidenceRequirements.exact_calls_by_tool,
    `${label} exact calls by tool`,
  );
  const requiredCompletedCommandSha256 = jsonObject(
    toolEvidenceRequirements.required_completed_command_sha256,
    `${label} required completed command digests`,
  );
  exactKeys(exactCallsByTool, ['command_execution'], `${label} exact calls by tool`);
  exactKeys(
    requiredCompletedCommandSha256,
    [REQUIRED_COMMAND_SHA256],
    `${label} required completed command digests`,
  );
  if (
    contract.schema_version !== 'aiq.tool-receipt-contract.v2' ||
    contract.location !== 'receipt.json' ||
    contract.transport !== 'workspace_file' ||
    contract.producer !== 'supplied_local_tool' ||
    contract.additional_fields !== 'forbidden' ||
    contract.key_order !== 'not_significant' ||
    !Number.isSafeInteger(contract.required_invocations) ||
    Number(contract.required_invocations) !== 1 ||
    contract.required_command !== REQUIRED_COMMAND ||
    contract.required_command_sha256 !== REQUIRED_COMMAND_SHA256 ||
    JSON.stringify(requiredFields) !== JSON.stringify(RECEIPT_FIELDS) ||
    optionalFields.length !== 0 ||
    JSON.stringify(predecessorFields) !== JSON.stringify(PREDECESSOR_UNDISCLOSED_RECEIPT_FIELDS) ||
    RECEIPT_FIELDS.some(
      (field) =>
        !['string', 'integer'].includes(String(fieldTypes[field])) ||
        typeof fieldSemantics[field] !== 'string' ||
        fieldProducers[field] !== 'supplied_local_tool' ||
        typeof fieldVerification[field] !== 'string',
    ) ||
    fieldTypes.invocation_count !== 'integer' ||
    RECEIPT_FIELDS.filter((field) => field !== 'invocation_count').some(
      (field) => fieldTypes[field] !== 'string',
    ) ||
    canonicalization.digest_algorithm !== 'sha256' ||
    canonicalization.digest_prefix !== 'sha256:' ||
    canonicalization.json !== 'aiq.sorted-key-json.v1' ||
    canonicalization.command_sha256 !== 'raw_file_bytes' ||
    canonicalization.input_sha256 !== 'sorted_key_json_of_parsed_input' ||
    canonicalization.output_sha256 !== 'sorted_key_json_of_result_object' ||
    canonicalization.receipt_sha256 !== 'sorted_key_json_of_receipt_without_receipt_sha256' ||
    resultBinding.location !== 'result.json' ||
    resultBinding.receipt_digest_field !== 'receipt_sha256' ||
    runnerBinding.producer !== 'runner' ||
    runnerBinding.transport !== 'evaluator_input.tool_evidence' ||
    JSON.stringify(runnerBinding.automatic_fields) !==
      JSON.stringify([
        'steps',
        'total_calls',
        'by_tool.command_execution',
        'completed_command_sha256',
      ]) ||
    !Array.isArray(runnerBinding.receipt_fields_automatic) ||
    runnerBinding.receipt_fields_automatic.length !== 0 ||
    typeof runnerBinding.relationship !== 'string' ||
    toolEvidenceRequirements.exact_total_calls !== 1 ||
    exactCallsByTool.command_execution !== 1 ||
    requiredCompletedCommandSha256[REQUIRED_COMMAND_SHA256] !== 1 ||
    typeof contract.model_obligation !== 'string'
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return contract;
}

function issueCodeArray(value: unknown, label: string): readonly IssueCode[] {
  const values = stringArray(value, label);
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} is invalid.`);
  }
  const output: IssueCode[] = [];
  for (const code of values) {
    const issueCode = ISSUE_CODES.find((candidate) => candidate === code);
    if (issueCode === undefined) throw new TypeError(`${label} is invalid.`);
    output.push(issueCode);
  }
  return output;
}

function candidateReview(value: unknown, label: string): CandidateReview {
  const review = jsonObject(value, label);
  exactKeys(
    review,
    ['catalog_entry_sha256', 'issue_codes', 'record_sha256', 'task_definition_sha256', 'verdict'],
    label,
  );
  if (review.verdict !== 'approved' && review.verdict !== 'rejected') {
    throw new TypeError(`${label} verdict is invalid.`);
  }
  return {
    verdict: review.verdict,
    record_sha256: digestValueInput(review.record_sha256, `${label} record digest`),
    task_definition_sha256: digestValueInput(review.task_definition_sha256, `${label} task digest`),
    catalog_entry_sha256: digestValueInput(
      review.catalog_entry_sha256,
      `${label} catalog-entry digest`,
    ),
    issue_codes: issueCodeArray(review.issue_codes, `${label} issue codes`),
  };
}

function exactFieldContract(
  requiredValue: unknown,
  optionalValue: unknown,
  typesValue: unknown,
  semanticsValue: unknown,
  label: string,
): {
  readonly requiredFields: readonly string[];
  readonly optionalFields: readonly string[];
  readonly fieldTypes: Readonly<JsonObject>;
  readonly fieldSemantics: Readonly<JsonObject>;
} {
  const requiredFields = stringArray(requiredValue, `${label} required fields`);
  const optionalFields = stringArray(optionalValue, `${label} optional fields`);
  const fieldTypes = jsonObject(typesValue, `${label} field types`);
  const fieldSemantics = jsonObject(semanticsValue, `${label} field semantics`);
  const fields = [...requiredFields, ...optionalFields];
  if (
    requiredFields.length === 0 ||
    new Set(fields).size !== fields.length ||
    Object.keys(fieldTypes).length !== fields.length ||
    Object.keys(fieldSemantics).length !== fields.length ||
    fields.some(
      (field) =>
        typeof fieldTypes[field] !== 'string' ||
        typeof fieldSemantics[field] !== 'string' ||
        fieldSemantics[field].length < 20,
    )
  ) {
    throw new TypeError(`${label} fields are invalid.`);
  }
  exactKeys(fieldTypes, fields, `${label} field types`);
  exactKeys(fieldSemantics, fields, `${label} field semantics`);
  return { requiredFields, optionalFields, fieldTypes, fieldSemantics };
}

function scenarioContract(value: unknown, label: string): Readonly<JsonObject> | null {
  if (value === null) return null;
  const contract = jsonObject(value, label);
  exactKeys(
    contract,
    [
      'additional_fields',
      'field_semantics',
      'field_types',
      'identity_fields',
      'location',
      'optional_fields',
      'producer',
      'required_fields',
      'schema_version',
      'task_specific_fields',
      'transport',
    ],
    label,
  );
  const identityFields = stringArray(contract.identity_fields, `${label} identity fields`);
  const taskSpecificFields = stringArray(
    contract.task_specific_fields,
    `${label} task-specific fields`,
  );
  const fields = exactFieldContract(
    contract.required_fields,
    contract.optional_fields,
    contract.field_types,
    contract.field_semantics,
    label,
  );
  if (
    contract.schema_version !== 'aiq.tool-scenario-contract.v1' ||
    contract.location !== 'input.json' ||
    contract.transport !== 'workspace_file' ||
    contract.producer !== 'benchmark_author' ||
    contract.additional_fields !== 'forbidden' ||
    JSON.stringify(identityFields) !==
      JSON.stringify(['schema_version', 'task_id', 'construct_id', 'operation_id']) ||
    taskSpecificFields.length < 4 ||
    new Set(taskSpecificFields).size !== taskSpecificFields.length ||
    taskSpecificFields.some((field) => identityFields.includes(field)) ||
    JSON.stringify(fields.requiredFields) !==
      JSON.stringify([...identityFields, ...taskSpecificFields]) ||
    fields.optionalFields.length !== 0
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return contract;
}

function operationContract(value: unknown, label: string): Readonly<JsonObject> | null {
  if (value === null) return null;
  const contract = jsonObject(value, label);
  exactKeys(
    contract,
    ['behavior_signature', 'consumes', 'description', 'deterministic', 'operation_id', 'produces'],
    label,
  );
  const signature = jsonObject(contract.behavior_signature, `${label} behavior signature`);
  exactKeys(
    signature,
    ['error_paths', 'invariants', 'metamorphic_basis', 'state_model', 'transitions'],
    `${label} behavior signature`,
  );
  const consumes = stringArray(contract.consumes, `${label} consumes`);
  const produces = stringArray(contract.produces, `${label} produces`);
  const transitions = stringArray(signature.transitions, `${label} transitions`);
  const invariants = stringArray(signature.invariants, `${label} invariants`);
  const errorPaths = stringArray(signature.error_paths, `${label} error paths`);
  const metamorphicBasis = stringArray(signature.metamorphic_basis, `${label} metamorphic basis`);
  if (
    typeof contract.operation_id !== 'string' ||
    contract.operation_id.length < 12 ||
    contract.deterministic !== true ||
    typeof contract.description !== 'string' ||
    contract.description.length < 80 ||
    consumes.length < 4 ||
    produces.length < 5 ||
    transitions.length < 3 ||
    invariants.length < 2 ||
    errorPaths.length < 3 ||
    JSON.stringify(metamorphicBasis) !== JSON.stringify(consumes)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return contract;
}

function semanticResultContract(value: unknown, label: string): Readonly<JsonObject> | null {
  if (value === null) return null;
  const contract = jsonObject(value, label);
  exactKeys(
    contract,
    [
      'additional_fields',
      'field_semantics',
      'field_types',
      'location',
      'optional_fields',
      'required_fields',
      'transport',
    ],
    label,
  );
  const fields = exactFieldContract(
    contract.required_fields,
    contract.optional_fields,
    contract.field_types,
    contract.field_semantics,
    label,
  );
  if (
    contract.location !== 'result.json#/result' ||
    contract.transport !== 'workspace_json_pointer' ||
    contract.additional_fields !== 'forbidden' ||
    fields.requiredFields.length < 5 ||
    fields.optionalFields.length !== 0
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return contract;
}

function publicTaskRevision(value: unknown, label: string): PublicTaskRevision | null {
  if (value === null) return null;
  const revision = jsonObject(value, label);
  exactKeys(
    revision,
    [
      'allowed_tools',
      'evaluator_kind',
      'input_contract_kind',
      'pass_conditions',
      'summary',
      'tags',
      'title',
    ],
    label,
  );
  return {
    title: stringValue(revision.title, `${label} title`),
    summary: stringValue(revision.summary, `${label} summary`),
    input_contract_kind: stringValue(revision.input_contract_kind, `${label} input contract kind`),
    evaluator_kind: stringValue(revision.evaluator_kind, `${label} evaluator kind`),
    pass_conditions: stringArray(revision.pass_conditions, `${label} pass conditions`),
    allowed_tools: stringArray(revision.allowed_tools, `${label} allowed tools`),
    tags: stringArray(revision.tags, `${label} tags`),
  };
}

function taskDecision(value: unknown, index: number): TaskDecision {
  const decision = jsonObject(value, `decision ${String(index)}`);
  exactKeys(
    decision,
    [
      'acceptance_fixture_applicability',
      'candidate_5_catalog_entry_sha256',
      'candidate_5_task_facing_semantics_sha256',
      'candidate_2_review',
      'candidate_3_contract',
      'candidate_3_review',
      'candidate_4_contract',
      'candidate_4_review',
      'candidate_5_contract',
      'cluster_id',
      'decision',
      'predecessor_decision',
      'public_task_revision',
      'rationale',
      'task_id',
    ],
    `decision ${String(index)}`,
  );
  const label = `decision ${String(index)}`;
  const candidateTwoReview = jsonObject(decision.candidate_2_review, `${label} candidate.2 review`);
  exactKeys(
    candidateTwoReview,
    ['catalog_entry_sha256', 'issue_codes', 'record_sha256', 'task_definition_sha256', 'verdict'],
    `${label} candidate.2 review`,
  );
  const candidateThreeContract = jsonObject(
    decision.candidate_3_contract,
    `${label} candidate.3 contract`,
  );
  exactKeys(
    candidateThreeContract,
    [
      'construct_id',
      'coverage_claims',
      'falsifiers',
      'fixture_applicability',
      'mechanism_classes',
      'receipt_contract',
      'response_contract',
    ],
    `${label} candidate.3 contract`,
  );
  const candidateThreeReview = jsonObject(
    decision.candidate_3_review,
    `${label} candidate.3 review`,
  );
  exactKeys(
    candidateThreeReview,
    ['catalog_entry_sha256', 'issue_codes', 'record_sha256', 'task_definition_sha256', 'verdict'],
    `${label} candidate.3 review`,
  );
  const candidateFourContract = jsonObject(
    decision.candidate_4_contract,
    `${label} candidate.4 contract`,
  );
  const candidateFiveContract = jsonObject(
    decision.candidate_5_contract,
    `${label} candidate.5 contract`,
  );
  exactKeys(
    candidateFiveContract,
    [
      'construct_id',
      'coverage_claims',
      'falsifiers',
      'fixture_applicability',
      'mechanism_classes',
      'operation_contract',
      'receipt_contract',
      'response_contract',
      'scenario_contract',
      'semantic_result_contract',
    ],
    `${label} candidate.5 contract`,
  );
  exactKeys(
    candidateFourContract,
    [
      'construct_id',
      'coverage_claims',
      'falsifiers',
      'fixture_applicability',
      'mechanism_classes',
      'receipt_contract',
      'response_contract',
    ],
    `${label} candidate.4 contract`,
  );
  const selectedDecision = stringValue(decision.decision, `decision ${String(index)} kind`);
  if (selectedDecision !== 'retained') {
    throw new TypeError(`decision ${String(index)} kind is invalid.`);
  }
  const predecessorDecision = stringValue(
    decision.predecessor_decision,
    `decision ${String(index)} predecessor kind`,
  );
  if (predecessorDecision !== 'retained' && predecessorDecision !== 'revised') {
    throw new TypeError(`decision ${String(index)} predecessor kind is invalid.`);
  }

  return {
    task_id: stringValue(decision.task_id, `decision ${String(index)} task_id`),
    decision: 'retained',
    predecessor_decision: predecessorDecision,
    candidate_5_catalog_entry_sha256: digestValueInput(
      decision.candidate_5_catalog_entry_sha256,
      `${label} candidate.5 catalog entry digest`,
    ),
    candidate_5_task_facing_semantics_sha256: digestValueInput(
      decision.candidate_5_task_facing_semantics_sha256,
      `${label} candidate.5 task-facing semantics digest`,
    ),
    cluster_id: stringValue(decision.cluster_id, `decision ${String(index)} cluster_id`),
    acceptance_fixture_applicability: fixtureApplicabilityMap(
      decision.acceptance_fixture_applicability,
      `${label} fixture applicability`,
    ),
    rationale: stringValue(decision.rationale, `decision ${String(index)} rationale`),
    public_task_revision: publicTaskRevision(
      decision.public_task_revision,
      `decision ${String(index)} public task revision`,
    ),
    candidate_2_review: candidateReview(candidateTwoReview, `${label} candidate.2 review`),
    candidate_3_contract: {
      construct_id: stringValue(
        candidateThreeContract.construct_id,
        `${label} candidate.3 construct id`,
      ),
      response_contract: responseContract(
        candidateThreeContract.response_contract,
        `${label} candidate.3 response contract`,
      ),
      receipt_contract: historicalToolReceiptContract(
        candidateThreeContract.receipt_contract,
        `${label} candidate.3 receipt contract`,
      ),
      fixture_applicability: fixtureApplicabilityMap(
        candidateThreeContract.fixture_applicability,
        `${label} candidate.3 fixture applicability`,
      ),
      mechanism_classes: stringArray(
        candidateThreeContract.mechanism_classes,
        `${label} candidate.3 mechanism classes`,
      ),
      falsifiers: stringArray(candidateThreeContract.falsifiers, `${label} candidate.3 falsifiers`),
      coverage_claims: stringArray(
        candidateThreeContract.coverage_claims,
        `${label} candidate.3 coverage claims`,
      ),
    },
    candidate_3_review: candidateReview(candidateThreeReview, `${label} candidate.3 review`),
    candidate_4_contract: {
      construct_id: stringValue(
        candidateFourContract.construct_id,
        `${label} candidate.4 construct id`,
      ),
      response_contract: responseContract(
        candidateFourContract.response_contract,
        `${label} candidate.4 response contract`,
      ),
      receipt_contract: toolReceiptContract(
        candidateFourContract.receipt_contract,
        `${label} candidate.4 receipt contract`,
      ),
      fixture_applicability: fixtureApplicabilityMap(
        candidateFourContract.fixture_applicability,
        `${label} candidate.4 fixture applicability`,
      ),
      mechanism_classes: stringArray(
        candidateFourContract.mechanism_classes,
        `${label} candidate.4 mechanism classes`,
      ),
      falsifiers: stringArray(candidateFourContract.falsifiers, `${label} candidate.4 falsifiers`),
      coverage_claims: stringArray(
        candidateFourContract.coverage_claims,
        `${label} candidate.4 coverage claims`,
      ),
    },
    candidate_4_review: candidateReview(decision.candidate_4_review, `${label} candidate.4 review`),
    candidate_5_contract: {
      construct_id: stringValue(
        candidateFiveContract.construct_id,
        `${label} candidate.5 construct id`,
      ),
      response_contract: responseContract(
        candidateFiveContract.response_contract,
        `${label} candidate.5 response contract`,
      ),
      receipt_contract: toolReceiptContract(
        candidateFiveContract.receipt_contract,
        `${label} candidate.5 receipt contract`,
      ),
      scenario_contract: scenarioContract(
        candidateFiveContract.scenario_contract,
        `${label} candidate.5 scenario contract`,
      ),
      operation_contract: operationContract(
        candidateFiveContract.operation_contract,
        `${label} candidate.5 operation contract`,
      ),
      semantic_result_contract: semanticResultContract(
        candidateFiveContract.semantic_result_contract,
        `${label} candidate.5 semantic result contract`,
      ),
      fixture_applicability: fixtureApplicabilityMap(
        candidateFiveContract.fixture_applicability,
        `${label} candidate.5 fixture applicability`,
      ),
      mechanism_classes: stringArray(
        candidateFiveContract.mechanism_classes,
        `${label} candidate.5 mechanism classes`,
      ),
      falsifiers: stringArray(candidateFiveContract.falsifiers, `${label} candidate.5 falsifiers`),
      coverage_claims: stringArray(
        candidateFiveContract.coverage_claims,
        `${label} candidate.5 coverage claims`,
      ),
    },
  };
}

export function parseDecisionManifest(value: unknown): CandidateDecisionManifest {
  const manifest = jsonObject(value, 'candidate decision manifest');
  exactKeys(
    manifest,
    [
      'authority',
      'calibration_policy_repair',
      'candidate_id',
      'candidate_task_set_version',
      'decisions',
      'immutable_rejected_predecessors',
      'lifecycle',
      'node_runtime_correction_closure',
      'package_input_validation_closure',
      'predecessor_candidate',
      'public_response_contract_validation_closure',
      'recorded_date',
      'response_source_authority_closure',
      'retained_candidate_5_task_issue_closures',
      'schema_version',
      'source_end_to_end_validation_closure',
      'source_integrity_closure',
      'task_issue_code_counts',
    ],
    'candidate decision manifest',
  );
  const predecessor = jsonObject(manifest.predecessor_candidate, 'predecessor candidate');
  exactKeys(
    predecessor,
    [
      'candidate_id',
      'catalog_canonical_sha256',
      'catalog_entry_bindings_sha256',
      'disposition',
      'public_contract_projection_sha256',
      'semantic_retention_rule',
      'source_commit',
      'source_tree',
      'task_facing_semantics_sha256',
      'task_issue_closure_entries',
      'task_metadata_sha256',
      'task_semantics',
    ],
    'predecessor candidate',
  );
  const calibrationPolicyRepair = jsonObject(
    manifest.calibration_policy_repair,
    'calibration policy repair',
  );
  exactKeys(
    calibrationPolicyRepair,
    [
      'observed_informative_tasks',
      'observed_non_uniform_tasks',
      'observed_universal_full_credit_tasks',
      'observed_universal_semantic_zero_tasks',
      'policy_change',
      'policy_version',
      'predecessor_package_sha256',
      'predecessor_run_sha256',
      'reauthored_structured_task_ids',
      'repaired_tool_task_ids',
      'retained_task_count',
      'revised_task_count',
      'schema_version',
    ],
    'calibration policy repair',
  );
  const reauthoredStructuredTaskIds = stringArray(
    calibrationPolicyRepair.reauthored_structured_task_ids,
    'calibration reauthored structured task IDs',
  );
  const repairedToolTaskIds = stringArray(
    calibrationPolicyRepair.repaired_tool_task_ids,
    'calibration repaired tool task IDs',
  );
  const immutableRejectedPredecessors = stringArray(
    manifest.immutable_rejected_predecessors,
    'immutable rejected predecessors',
  );
  const retainedTaskClosures = jsonObject(
    manifest.retained_candidate_5_task_issue_closures,
    'retained candidate.5 task issue closures',
  );
  exactKeys(
    retainedTaskClosures,
    [
      'closure_entries',
      'disposition',
      'issue_code_counts',
      'predecessor_candidate_id',
      'successor_candidate_id',
    ],
    'retained candidate.5 task issue closures',
  );
  const retainedTaskIssueCounts = jsonObject(
    retainedTaskClosures.issue_code_counts,
    'retained candidate.5 task issue-code counts',
  );
  exactKeys(retainedTaskIssueCounts, ISSUE_CODES, 'retained task issue-code counts');
  const sourceIntegrityClosure = jsonObject(
    manifest.source_integrity_closure,
    'source integrity closure',
  );
  exactKeys(
    sourceIntegrityClosure,
    [
      'counts_toward_task_issue_closures',
      'diagnosis_task_identity',
      'issue_code',
      'predecessor_candidate_id',
      'predecessor_commitment_sha256',
      'regression',
      'runtime_authority',
      'scope',
      'status',
    ],
    'source integrity closure',
  );
  const sourceEndToEndValidationClosure = jsonObject(
    manifest.source_end_to_end_validation_closure,
    'source end-to-end validation closure',
  );
  const packageInputValidationClosure = jsonObject(
    manifest.package_input_validation_closure,
    'package input validation closure',
  );
  exactKeys(
    packageInputValidationClosure,
    [
      'counts_toward_task_issue_closures',
      'diagnosis_task_identity',
      'failure_class',
      'issue_code',
      'predecessor_candidate_id',
      'regression',
      'repair',
      'scope',
      'status',
    ],
    'package input validation closure',
  );
  const nodeRuntimeCorrectionClosure = jsonObject(
    manifest.node_runtime_correction_closure,
    'Node runtime correction closure',
  );
  exactKeys(
    nodeRuntimeCorrectionClosure,
    [
      'counts_toward_task_issue_closures',
      'diagnosis_task_identity',
      'expected_node_version',
      'issue_code',
      'predecessor_candidate_id',
      'predecessor_observed_node_version',
      'regression',
      'repair',
      'scope',
      'status',
    ],
    'Node runtime correction closure',
  );
  exactKeys(
    sourceEndToEndValidationClosure,
    [
      'counts_toward_task_issue_closures',
      'diagnosis_task_identity',
      'failure_class',
      'issue_code',
      'predecessor_candidate_id',
      'regression',
      'repair',
      'scope',
      'status',
    ],
    'source end-to-end validation closure',
  );
  const publicResponseContractValidationClosure = jsonObject(
    manifest.public_response_contract_validation_closure,
    'public response-contract validation closure',
  );
  const responseSourceAuthorityClosure = jsonObject(
    manifest.response_source_authority_closure,
    'response source-authority closure',
  );
  exactKeys(
    responseSourceAuthorityClosure,
    [
      'counts_toward_task_issue_closures',
      'failure_class',
      'issue_code',
      'predecessor_candidate_id',
      'regression',
      'repair',
      'scope',
      'status',
    ],
    'response source-authority closure',
  );
  exactKeys(
    publicResponseContractValidationClosure,
    [
      'corrected_field_type',
      'corrected_location',
      'counts_toward_task_issue_closures',
      'issue_code',
      'predecessor_candidate_id',
      'regression',
      'rejected_field_type',
      'rejected_location',
      'repair',
      'scope',
      'status',
    ],
    'public response-contract validation closure',
  );
  const counts = jsonObject(manifest.task_issue_code_counts, 'task issue closure counts');
  exactKeys(counts, ISSUE_CODES, 'issue-code counts');
  const taskIssueCodeCounts: Record<IssueCode, number> = {
    ...EXPECTED_CLOSURE_ISSUE_COUNTS,
  };
  for (const code of ISSUE_CODES) {
    const count = counts[code];
    if (!Number.isInteger(count) || Number(count) < 0) {
      throw new TypeError(`issue-code count ${code} is invalid.`);
    }
    taskIssueCodeCounts[code] = Number(count);
  }
  const lifecycle = jsonObject(manifest.lifecycle, 'candidate lifecycle');
  exactKeys(
    lifecycle,
    [
      'activation',
      'active',
      'calibration',
      'deployment',
      'identity_state',
      'independent_review',
      'production_acceptance',
      'production_publishable',
      'qualification',
      'release',
      'seal',
    ],
    'candidate lifecycle',
  );
  if (
    manifest.schema_version !== 'aiq.candidate-design-decisions.v17' ||
    manifest.candidate_id !== CANDIDATE_ID ||
    manifest.candidate_task_set_version !== TASK_SET_VERSION ||
    manifest.recorded_date !== '2026-08-30' ||
    manifest.authority !== 'candidate_16_independent_review_repair' ||
    predecessor.candidate_id !== PREDECESSOR_CANDIDATE_ID ||
    predecessor.disposition !== 'rejected_independent_review_optional_field_and_delivery_drift' ||
    predecessor.source_commit !== PREDECESSOR_SOURCE_COMMIT ||
    predecessor.source_tree !== PREDECESSOR_SOURCE_TREE ||
    predecessor.catalog_canonical_sha256 !== PREDECESSOR_CATALOG_CANONICAL_SHA256 ||
    predecessor.catalog_entry_bindings_sha256 !== PREDECESSOR_CATALOG_ENTRY_BINDINGS_SHA256 ||
    predecessor.task_metadata_sha256 !== PREDECESSOR_TASK_METADATA_SHA256 ||
    predecessor.public_contract_projection_sha256 !==
      PREDECESSOR_PUBLIC_CONTRACT_PROJECTION_SHA256 ||
    predecessor.task_facing_semantics_sha256 !== PREDECESSOR_TASK_FACING_SEMANTICS_SHA256 ||
    predecessor.task_semantics !==
      'public_contract_retained_private_optional_semantics_repaired_43' ||
    predecessor.task_issue_closure_entries !== 42 ||
    predecessor.semantic_retention_rule !==
      'candidate_16_public_contract_retained_private_optional_semantics_repaired_43' ||
    calibrationPolicyRepair.schema_version !== 'aiq.candidate-calibration-repair.v1' ||
    calibrationPolicyRepair.predecessor_run_sha256 !== REJECTED_CALIBRATION_RUN_SHA256 ||
    calibrationPolicyRepair.predecessor_package_sha256 !== REJECTED_CALIBRATION_PACKAGE_SHA256 ||
    calibrationPolicyRepair.policy_version !== 'aiq.official-calibration-policy.v2' ||
    calibrationPolicyRepair.observed_informative_tasks !== 18 ||
    calibrationPolicyRepair.observed_non_uniform_tasks !== 22 ||
    calibrationPolicyRepair.observed_universal_semantic_zero_tasks !== 10 ||
    calibrationPolicyRepair.observed_universal_full_credit_tasks !== 38 ||
    JSON.stringify(reauthoredStructuredTaskIds) !==
      JSON.stringify(CALIBRATION_REAUTHORED_TASK_IDS) ||
    JSON.stringify(repairedToolTaskIds) !== JSON.stringify(REVISED_TASK_IDS) ||
    calibrationPolicyRepair.retained_task_count !== 29 ||
    calibrationPolicyRepair.revised_task_count !== 43 ||
    calibrationPolicyRepair.policy_change !== false ||
    JSON.stringify(immutableRejectedPredecessors) !==
      JSON.stringify([
        'aiq-core/1.1.0-candidate.1',
        'aiq-core/1.1.0-candidate.2',
        'aiq-core/1.1.0-candidate.3',
        'aiq-core/1.1.0-candidate.4',
        'aiq-core/1.1.0-candidate.5',
        'aiq-core/1.1.0-candidate.6',
        'aiq-core/1.1.0-candidate.7',
        'aiq-core/1.1.0-candidate.8',
        'aiq-core/1.1.0-candidate.9',
        'aiq-core/1.1.0-candidate.10',
        'aiq-core/1.1.0-candidate.11',
        'aiq-core/1.1.0-candidate.12',
        'aiq-core/1.1.0-candidate.13',
        'aiq-core/1.1.0-candidate.14',
        'aiq-core/1.1.0-candidate.15',
        'aiq-core/1.1.0-candidate.16',
      ]) ||
    retainedTaskClosures.predecessor_candidate_id !== TASK_ISSUE_PREDECESSOR_CANDIDATE_ID ||
    retainedTaskClosures.successor_candidate_id !== CANDIDATE_ID ||
    retainedTaskClosures.disposition !== 'preserved_unchanged_and_revalidated' ||
    retainedTaskClosures.closure_entries !== 42 ||
    ISSUE_CODES.some(
      (code) => retainedTaskIssueCounts[code] !== EXPECTED_CLOSURE_ISSUE_COUNTS[code],
    ) ||
    sourceIntegrityClosure.issue_code !== 'QUALIFICATION_EVIDENCE_BRIDGE_UNAUTHENTICATED' ||
    sourceIntegrityClosure.scope !== 'trusted_execution_and_evidence_bridge' ||
    sourceIntegrityClosure.status !== 'closed_in_candidate_7' ||
    sourceIntegrityClosure.counts_toward_task_issue_closures !== false ||
    sourceIntegrityClosure.diagnosis_task_identity !==
      QUALIFICATION_BRIDGE_DIAGNOSIS_TASK_IDENTITY ||
    sourceIntegrityClosure.predecessor_candidate_id !== BRIDGE_PREDECESSOR_CANDIDATE_ID ||
    sourceIntegrityClosure.predecessor_commitment_sha256 !== BRIDGE_PREDECESSOR_COMMITMENT_SHA256 ||
    sourceIntegrityClosure.runtime_authority !== 'explicit_candidate_qualification_boundary' ||
    sourceIntegrityClosure.regression !==
      'replay_verified_projection_and_candidate_route_substitution_suite' ||
    sourceEndToEndValidationClosure.issue_code !==
      'CANDIDATE_VALIDATION_CONTEXT_DROPPED_AFTER_PREPARATION' ||
    sourceEndToEndValidationClosure.scope !== 'completed_run_recovery_and_package_validation' ||
    sourceEndToEndValidationClosure.status !== 'closed_in_candidate_8' ||
    sourceEndToEndValidationClosure.counts_toward_task_issue_closures !== false ||
    sourceEndToEndValidationClosure.diagnosis_task_identity !==
      CANDIDATE_7_REJECTION_TASK_IDENTITY ||
    sourceEndToEndValidationClosure.predecessor_candidate_id !==
      SOURCE_END_TO_END_PREDECESSOR_CANDIDATE_ID ||
    sourceEndToEndValidationClosure.failure_class !==
      'candidate_provenance_routed_to_active_validator_after_model_work' ||
    sourceEndToEndValidationClosure.repair !== 'provenance_bound_in_process_validation_context' ||
    sourceEndToEndValidationClosure.regression !==
      'candidate_completed_recovery_package_and_active_rejection_suite' ||
    packageInputValidationClosure.issue_code !==
      'CANDIDATE_PACKAGE_VALIDATION_AUTHORITY_DERIVED_FROM_SAVED_RUN' ||
    packageInputValidationClosure.scope !==
      'candidate_package_input_and_signed_payload_validation' ||
    packageInputValidationClosure.status !== 'closed_in_candidate_9' ||
    packageInputValidationClosure.counts_toward_task_issue_closures !== false ||
    packageInputValidationClosure.diagnosis_task_identity !==
      PACKAGE_INPUT_DIAGNOSIS_TASK_IDENTITY ||
    packageInputValidationClosure.predecessor_candidate_id !== CANDIDATE_8_ID ||
    packageInputValidationClosure.failure_class !==
      'saved_calibration_selected_its_own_candidate_validation_context' ||
    packageInputValidationClosure.repair !==
      'independent_tasks_corpus_and_source_bound_through_package_serialization' ||
    packageInputValidationClosure.regression !==
      'candidate_package_input_mismatch_and_current_byte_identity_suite' ||
    nodeRuntimeCorrectionClosure.issue_code !== 'CANDIDATE_NODE_RUNTIME_IDENTITY_DRIFT' ||
    nodeRuntimeCorrectionClosure.scope !== 'private_authoring_build_and_readback_runtime' ||
    nodeRuntimeCorrectionClosure.status !== 'closed_in_candidate_9' ||
    nodeRuntimeCorrectionClosure.counts_toward_task_issue_closures !== false ||
    nodeRuntimeCorrectionClosure.diagnosis_task_identity !==
      NODE_RUNTIME_CORRECTION_TASK_IDENTITY ||
    nodeRuntimeCorrectionClosure.predecessor_candidate_id !== CANDIDATE_8_ID ||
    nodeRuntimeCorrectionClosure.expected_node_version !== 'v24.18.0' ||
    nodeRuntimeCorrectionClosure.predecessor_observed_node_version !== 'v24.19.0' ||
    nodeRuntimeCorrectionClosure.repair !==
      'checked_in_node_version_enforced_at_private_build_and_readback' ||
    nodeRuntimeCorrectionClosure.regression !==
      'candidate_private_build_and_readback_runtime_mismatch_suite' ||
    publicResponseContractValidationClosure.issue_code !==
      'PUBLIC_RESPONSE_CONTRACT_SOURCE_OR_SCHEMA_DRIFT' ||
    publicResponseContractValidationClosure.scope !==
      'catalog_response_locations_and_field_types' ||
    publicResponseContractValidationClosure.status !== 'closed_in_candidate_10' ||
    publicResponseContractValidationClosure.counts_toward_task_issue_closures !== false ||
    publicResponseContractValidationClosure.predecessor_candidate_id !== CANDIDATE_9_ID ||
    publicResponseContractValidationClosure.rejected_location !== 'debugging-04:src/task.mjs' ||
    publicResponseContractValidationClosure.corrected_location !== 'debugging-04:src/task.ts' ||
    publicResponseContractValidationClosure.rejected_field_type !==
      'instruction-following-05:calculation_note:undefined' ||
    publicResponseContractValidationClosure.corrected_field_type !==
      'instruction-following-05:calculation_note:string' ||
    publicResponseContractValidationClosure.repair !==
      'schema_owned_response_types_and_task_owned_source_locations' ||
    publicResponseContractValidationClosure.regression !==
      'generic_catalog_mutation_and_private_source_counterexample_suite' ||
    responseSourceAuthorityClosure.issue_code !== 'PRIVATE_RESPONSE_SOURCE_OWNER_MISIDENTIFIED' ||
    responseSourceAuthorityClosure.scope !== 'private_authoring_response_source_derivation' ||
    responseSourceAuthorityClosure.status !== 'closed_in_candidate_12' ||
    responseSourceAuthorityClosure.counts_toward_task_issue_closures !== false ||
    responseSourceAuthorityClosure.predecessor_candidate_id !==
      RESPONSE_SOURCE_PREDECESSOR_CANDIDATE_ID ||
    responseSourceAuthorityClosure.failure_class !==
      'protected_hashes_treated_as_outputs_and_final_mode_inferred_from_policy_absence' ||
    responseSourceAuthorityClosure.repair !==
      'derive_response_mode_and_mutable_locations_from_existing_serialized_task_owner' ||
    responseSourceAuthorityClosure.regression !==
      'production_shaped_private_derivation_and_real_72_task_integration' ||
    ISSUE_CODES.some((code) => taskIssueCodeCounts[code] !== EXPECTED_CLOSURE_ISSUE_COUNTS[code]) ||
    lifecycle.identity_state !== 'frozen_for_independent_review' ||
    lifecycle.active !== false ||
    lifecycle.production_publishable !== false ||
    [
      lifecycle.independent_review,
      lifecycle.seal,
      lifecycle.calibration,
      lifecycle.qualification,
      lifecycle.release,
      lifecycle.activation,
      lifecycle.deployment,
      lifecycle.production_acceptance,
    ].some((state) => state !== 'pending')
  ) {
    throw new TypeError('Candidate decision manifest identity is invalid.');
  }
  const decisions = unknownArray(manifest.decisions, 'candidate decisions').map(taskDecision);
  if (taskResponseAuthorityManifest.tasks.length !== decisions.length) {
    throw new TypeError('Task response authority count is invalid.');
  }
  for (const [index, decision] of decisions.entries()) {
    const sourceAuthority = taskResponseAuthorityManifest.tasks[index];
    if (sourceAuthority === undefined || sourceAuthority.task_id !== decision.task_id) {
      throw new TypeError(`${decision.task_id} task response authority is missing or unordered.`);
    }
    for (const [owner, contract] of [
      ['candidate.3', decision.candidate_3_contract.response_contract],
      ['candidate.4', decision.candidate_4_contract.response_contract],
      ['candidate.5', decision.candidate_5_contract.response_contract],
    ] as const) {
      assertGeneratedResponseContract(contract, sourceAuthority, `${decision.task_id} ${owner}`);
    }
  }

  return {
    schema_version: 'aiq.candidate-design-decisions.v17',
    candidate_id: CANDIDATE_ID,
    candidate_task_set_version: TASK_SET_VERSION,
    recorded_date: '2026-08-30',
    authority: 'candidate_16_independent_review_repair',
    predecessor_candidate: {
      candidate_id: PREDECESSOR_CANDIDATE_ID,
      disposition: 'rejected_independent_review_optional_field_and_delivery_drift',
      source_commit: PREDECESSOR_SOURCE_COMMIT,
      source_tree: PREDECESSOR_SOURCE_TREE,
      catalog_canonical_sha256: PREDECESSOR_CATALOG_CANONICAL_SHA256,
      catalog_entry_bindings_sha256: PREDECESSOR_CATALOG_ENTRY_BINDINGS_SHA256,
      task_metadata_sha256: PREDECESSOR_TASK_METADATA_SHA256,
      public_contract_projection_sha256: PREDECESSOR_PUBLIC_CONTRACT_PROJECTION_SHA256,
      task_facing_semantics_sha256: PREDECESSOR_TASK_FACING_SEMANTICS_SHA256,
      task_semantics: 'public_contract_retained_private_optional_semantics_repaired_43',
      task_issue_closure_entries: 42,
      semantic_retention_rule:
        'candidate_16_public_contract_retained_private_optional_semantics_repaired_43',
    },
    immutable_rejected_predecessors: [
      'aiq-core/1.1.0-candidate.1',
      'aiq-core/1.1.0-candidate.2',
      'aiq-core/1.1.0-candidate.3',
      'aiq-core/1.1.0-candidate.4',
      'aiq-core/1.1.0-candidate.5',
      'aiq-core/1.1.0-candidate.6',
      'aiq-core/1.1.0-candidate.7',
      'aiq-core/1.1.0-candidate.8',
      'aiq-core/1.1.0-candidate.9',
      'aiq-core/1.1.0-candidate.10',
      'aiq-core/1.1.0-candidate.11',
      'aiq-core/1.1.0-candidate.12',
      'aiq-core/1.1.0-candidate.13',
      'aiq-core/1.1.0-candidate.14',
      'aiq-core/1.1.0-candidate.15',
      'aiq-core/1.1.0-candidate.16',
    ],
    calibration_policy_repair: {
      schema_version: 'aiq.candidate-calibration-repair.v1',
      predecessor_run_sha256: REJECTED_CALIBRATION_RUN_SHA256,
      predecessor_package_sha256: REJECTED_CALIBRATION_PACKAGE_SHA256,
      policy_version: 'aiq.official-calibration-policy.v2',
      observed_informative_tasks: 18,
      observed_non_uniform_tasks: 22,
      observed_universal_semantic_zero_tasks: 10,
      observed_universal_full_credit_tasks: 38,
      reauthored_structured_task_ids: CALIBRATION_REAUTHORED_TASK_IDS,
      repaired_tool_task_ids: REVISED_TASK_IDS,
      retained_task_count: 29,
      revised_task_count: 43,
      policy_change: false,
    },
    retained_candidate_5_task_issue_closures: {
      predecessor_candidate_id: TASK_ISSUE_PREDECESSOR_CANDIDATE_ID,
      successor_candidate_id: CANDIDATE_ID,
      disposition: 'preserved_unchanged_and_revalidated',
      closure_entries: 42,
      issue_code_counts: taskIssueCodeCounts,
    },
    source_integrity_closure: {
      issue_code: 'QUALIFICATION_EVIDENCE_BRIDGE_UNAUTHENTICATED',
      scope: 'trusted_execution_and_evidence_bridge',
      status: 'closed_in_candidate_7',
      counts_toward_task_issue_closures: false,
      diagnosis_task_identity: QUALIFICATION_BRIDGE_DIAGNOSIS_TASK_IDENTITY,
      predecessor_candidate_id: BRIDGE_PREDECESSOR_CANDIDATE_ID,
      predecessor_commitment_sha256: BRIDGE_PREDECESSOR_COMMITMENT_SHA256,
      runtime_authority: 'explicit_candidate_qualification_boundary',
      regression: 'replay_verified_projection_and_candidate_route_substitution_suite',
    },
    source_end_to_end_validation_closure: {
      issue_code: 'CANDIDATE_VALIDATION_CONTEXT_DROPPED_AFTER_PREPARATION',
      scope: 'completed_run_recovery_and_package_validation',
      status: 'closed_in_candidate_8',
      counts_toward_task_issue_closures: false,
      diagnosis_task_identity: CANDIDATE_7_REJECTION_TASK_IDENTITY,
      predecessor_candidate_id: SOURCE_END_TO_END_PREDECESSOR_CANDIDATE_ID,
      failure_class: 'candidate_provenance_routed_to_active_validator_after_model_work',
      repair: 'provenance_bound_in_process_validation_context',
      regression: 'candidate_completed_recovery_package_and_active_rejection_suite',
    },
    package_input_validation_closure: {
      issue_code: 'CANDIDATE_PACKAGE_VALIDATION_AUTHORITY_DERIVED_FROM_SAVED_RUN',
      scope: 'candidate_package_input_and_signed_payload_validation',
      status: 'closed_in_candidate_9',
      counts_toward_task_issue_closures: false,
      diagnosis_task_identity: PACKAGE_INPUT_DIAGNOSIS_TASK_IDENTITY,
      predecessor_candidate_id: CANDIDATE_8_ID,
      failure_class: 'saved_calibration_selected_its_own_candidate_validation_context',
      repair: 'independent_tasks_corpus_and_source_bound_through_package_serialization',
      regression: 'candidate_package_input_mismatch_and_current_byte_identity_suite',
    },
    node_runtime_correction_closure: {
      issue_code: 'CANDIDATE_NODE_RUNTIME_IDENTITY_DRIFT',
      scope: 'private_authoring_build_and_readback_runtime',
      status: 'closed_in_candidate_9',
      counts_toward_task_issue_closures: false,
      diagnosis_task_identity: NODE_RUNTIME_CORRECTION_TASK_IDENTITY,
      predecessor_candidate_id: CANDIDATE_8_ID,
      expected_node_version: 'v24.18.0',
      predecessor_observed_node_version: 'v24.19.0',
      repair: 'checked_in_node_version_enforced_at_private_build_and_readback',
      regression: 'candidate_private_build_and_readback_runtime_mismatch_suite',
    },
    public_response_contract_validation_closure: {
      issue_code: 'PUBLIC_RESPONSE_CONTRACT_SOURCE_OR_SCHEMA_DRIFT',
      scope: 'catalog_response_locations_and_field_types',
      status: 'closed_in_candidate_10',
      counts_toward_task_issue_closures: false,
      predecessor_candidate_id: CANDIDATE_9_ID,
      rejected_location: 'debugging-04:src/task.mjs',
      corrected_location: 'debugging-04:src/task.ts',
      rejected_field_type: 'instruction-following-05:calculation_note:undefined',
      corrected_field_type: 'instruction-following-05:calculation_note:string',
      repair: 'schema_owned_response_types_and_task_owned_source_locations',
      regression: 'generic_catalog_mutation_and_private_source_counterexample_suite',
    },
    response_source_authority_closure: {
      issue_code: 'PRIVATE_RESPONSE_SOURCE_OWNER_MISIDENTIFIED',
      scope: 'private_authoring_response_source_derivation',
      status: 'closed_in_candidate_12',
      counts_toward_task_issue_closures: false,
      predecessor_candidate_id: RESPONSE_SOURCE_PREDECESSOR_CANDIDATE_ID,
      failure_class:
        'protected_hashes_treated_as_outputs_and_final_mode_inferred_from_policy_absence',
      repair: 'derive_response_mode_and_mutable_locations_from_existing_serialized_task_owner',
      regression: 'production_shaped_private_derivation_and_real_72_task_integration',
    },
    task_issue_code_counts: taskIssueCodeCounts,
    lifecycle: {
      identity_state: 'frozen_for_independent_review',
      active: false,
      production_publishable: false,
      independent_review: 'pending',
      seal: 'pending',
      calibration: 'pending',
      qualification: 'pending',
      release: 'pending',
      activation: 'pending',
      deployment: 'pending',
      production_acceptance: 'pending',
    },
    decisions,
  };
}

const rawTaskResponseAuthorityManifest: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../../benchmarks/candidates/aiq-core-1.1.0/task-response-authority.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const taskResponseAuthorityManifest = parseTaskResponseAuthorityManifest(
  rawTaskResponseAuthorityManifest,
);
const rawDecisionManifest: unknown = JSON.parse(
  readFileSync(
    new URL('../../../benchmarks/candidates/aiq-core-1.1.0/design-decisions.json', import.meta.url),
    'utf8',
  ),
);
const decisionManifest = parseDecisionManifest(rawDecisionManifest);

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

function taskFacingSemantics(value: unknown): JsonObject {
  const task = jsonObject(value, 'task-facing semantics');
  return {
    task_id: task.task_id,
    task_version: task.task_version,
    title: task.title,
    summary: task.summary,
    input_contract: task.input_contract,
    cluster_id: task.cluster_id,
    allowed_tools: task.allowed_tools,
    budget: task.budget,
    evaluator: task.evaluator,
    tags: task.tags,
  };
}

function reviseSchemaStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('aiq-core-1.0.7', 'aiq-core-1.1.0')
      .replaceAll('aiq-core@1.0.7', 'aiq-core@1.1.0')
      .replaceAll('aiq-core/1.0.7', 'aiq-core/1.1.0')
      .replaceAll('aiq-core/1\\.0\\.7', 'aiq-core/1\\.1\\.0');
  }
  if (Array.isArray(value)) return value.map(reviseSchemaStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, reviseSchemaStrings(child)]),
    );
  }
  return value;
}

export function assertDecisionManifest(
  manifest: CandidateDecisionManifest,
  priorTaskIds: readonly string[],
): void {
  const candidateThreeIssueCounts = {
    ACCEPTANCE_SEMANTICS_INVALID: 0,
    BEHAVIORAL_COVERAGE_GAP: 7,
    CROSS_TASK_CONSTRUCT_DUPLICATION: 0,
    HIDDEN_OUTPUT_SCHEMA: 0,
    KEYWORD_ONLY_EVALUATOR: 0,
    PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7,
    PUBLIC_SEMANTIC_CONTAMINATION: 0,
    TOOL_EVIDENCE_UNBOUND: 7,
  } satisfies Readonly<Record<IssueCode, number>>;
  for (const [index, decision] of manifest.decisions.entries()) {
    const sourceAuthority = taskResponseAuthorityManifest.tasks[index];
    if (sourceAuthority === undefined || sourceAuthority.task_id !== decision.task_id) {
      throw new Error(`${decision.task_id} task response authority is missing or unordered.`);
    }
    assertGeneratedResponseContract(
      decision.candidate_4_contract.response_contract,
      sourceAuthority,
      `${decision.task_id} candidate.4`,
    );
    assertGeneratedResponseContract(
      decision.candidate_5_contract.response_contract,
      sourceAuthority,
      `${decision.task_id} candidate.5`,
    );
  }
  if (
    manifest.schema_version !== 'aiq.candidate-design-decisions.v17' ||
    manifest.candidate_id !== CANDIDATE_ID ||
    manifest.candidate_task_set_version !== TASK_SET_VERSION ||
    manifest.recorded_date !== '2026-08-30' ||
    manifest.authority !== 'candidate_16_independent_review_repair' ||
    manifest.predecessor_candidate.candidate_id !== PREDECESSOR_CANDIDATE_ID ||
    manifest.predecessor_candidate.disposition !==
      'rejected_independent_review_optional_field_and_delivery_drift' ||
    manifest.predecessor_candidate.source_commit !== PREDECESSOR_SOURCE_COMMIT ||
    manifest.predecessor_candidate.source_tree !== PREDECESSOR_SOURCE_TREE ||
    manifest.predecessor_candidate.task_metadata_sha256 !== PREDECESSOR_TASK_METADATA_SHA256 ||
    manifest.predecessor_candidate.catalog_entry_bindings_sha256 !==
      PREDECESSOR_CATALOG_ENTRY_BINDINGS_SHA256 ||
    manifest.predecessor_candidate.public_contract_projection_sha256 !==
      PREDECESSOR_PUBLIC_CONTRACT_PROJECTION_SHA256 ||
    manifest.predecessor_candidate.task_facing_semantics_sha256 !==
      PREDECESSOR_TASK_FACING_SEMANTICS_SHA256 ||
    JSON.stringify(manifest.calibration_policy_repair.reauthored_structured_task_ids) !==
      JSON.stringify(CALIBRATION_REAUTHORED_TASK_IDS) ||
    JSON.stringify(manifest.calibration_policy_repair.repaired_tool_task_ids) !==
      JSON.stringify(REVISED_TASK_IDS) ||
    manifest.calibration_policy_repair.policy_change ||
    manifest.retained_candidate_5_task_issue_closures.closure_entries !== 42 ||
    manifest.source_integrity_closure.counts_toward_task_issue_closures ||
    manifest.source_end_to_end_validation_closure.counts_toward_task_issue_closures ||
    manifest.package_input_validation_closure.counts_toward_task_issue_closures ||
    manifest.node_runtime_correction_closure.counts_toward_task_issue_closures ||
    manifest.public_response_contract_validation_closure.counts_toward_task_issue_closures ||
    manifest.response_source_authority_closure.counts_toward_task_issue_closures ||
    ISSUE_CODES.some(
      (issueCode) =>
        manifest.task_issue_code_counts[issueCode] !== EXPECTED_CLOSURE_ISSUE_COUNTS[issueCode] ||
        manifest.retained_candidate_5_task_issue_closures.issue_code_counts[issueCode] !==
          EXPECTED_CLOSURE_ISSUE_COUNTS[issueCode],
    ) ||
    manifest.decisions.length !== 72
  ) {
    throw new Error('AIQ Core 1.1.0 decision-manifest authority is invalid.');
  }
  const decisionIds = manifest.decisions.map((decision) => decision.task_id);
  const predecessorRetained = manifest.decisions.filter(
    (decision) => decision.predecessor_decision === 'retained',
  );
  const predecessorRevised = manifest.decisions.filter(
    (decision) => decision.predecessor_decision === 'revised',
  );
  const revisedScenarioContracts = predecessorRevised.map(
    (decision) => decision.candidate_5_contract,
  );
  if (
    new Set(decisionIds).size !== 72 ||
    new Set(manifest.decisions.map((decision) => decision.cluster_id)).size !== 72 ||
    new Set(manifest.decisions.map((decision) => decision.candidate_5_contract.construct_id))
      .size !== 72 ||
    new Set(manifest.decisions.map((decision) => decision.candidate_5_catalog_entry_sha256))
      .size !== 72 ||
    priorTaskIds.length !== 72 ||
    predecessorRetained.length !== 65 ||
    predecessorRevised.length !== 7 ||
    manifest.decisions.some((decision) => decision.decision !== 'retained') ||
    JSON.stringify(predecessorRevised.map((decision) => decision.task_id).toSorted()) !==
      JSON.stringify([...REVISED_TASK_IDS].toSorted()) ||
    decisionIds.some((taskId, index) => taskId !== priorTaskIds[index]) ||
    ISSUE_CODES.some(
      (issueCode) =>
        manifest.decisions.filter((decision) =>
          decision.candidate_4_review.issue_codes.includes(issueCode),
        ).length !== EXPECTED_PREDECESSOR_REVIEW_ISSUE_COUNTS[issueCode],
    ) ||
    ISSUE_CODES.some(
      (issueCode) =>
        manifest.decisions.filter((decision) =>
          decision.candidate_3_review.issue_codes.includes(issueCode),
        ).length !== candidateThreeIssueCounts[issueCode],
    ) ||
    manifest.decisions.filter((decision) =>
      decision.candidate_2_review.issue_codes.includes('HIDDEN_OUTPUT_SCHEMA'),
    ).length !== 7 ||
    manifest.decisions.filter((decision) =>
      decision.candidate_2_review.issue_codes.includes('PUBLIC_PRIVATE_CONSTRUCT_MISMATCH'),
    ).length !== 7 ||
    manifest.decisions.some(
      (decision) =>
        !['retained', 'revised'].includes(decision.decision) ||
        !['retained', 'revised'].includes(decision.predecessor_decision) ||
        decision.cluster_id.length === 0 ||
        decision.rationale.length < 160 ||
        (decision.predecessor_decision === 'retained') !==
          (decision.candidate_4_review.verdict === 'approved') ||
        (decision.predecessor_decision === 'retained') !==
          (decision.candidate_4_review.issue_codes.length === 0) ||
        decision.candidate_3_contract.construct_id.length < 12 ||
        decision.candidate_2_review.issue_codes.some(
          (issueCode) =>
            !decision.candidate_3_contract.mechanism_classes.includes(
              ISSUE_MECHANISMS[issueCode],
            ) || !decision.candidate_3_contract.falsifiers.includes(ISSUE_FALSIFIERS[issueCode]),
        ) ||
        decision.candidate_3_review.issue_codes.some(
          (issueCode) =>
            !decision.candidate_4_contract.mechanism_classes.includes(
              ISSUE_MECHANISMS[issueCode],
            ) || !decision.candidate_4_contract.falsifiers.includes(ISSUE_FALSIFIERS[issueCode]),
        ) ||
        decision.candidate_5_contract.construct_id.length < 12 ||
        decision.candidate_5_contract.construct_id.length > 128 ||
        decision.candidate_5_contract.response_contract.locations.length === 0 ||
        decision.candidate_5_contract.response_contract.required_fields.length === 0 ||
        decision.candidate_5_contract.response_contract.locations.some(
          (location) => location.startsWith('/') || location.split('/').includes('..'),
        ) ||
        [
          ...decision.candidate_5_contract.response_contract.required_fields,
          ...decision.candidate_5_contract.response_contract.optional_fields,
        ].some(
          (field) =>
            decision.candidate_5_contract.response_contract.field_semantics[field] === undefined ||
            decision.candidate_5_contract.response_contract.field_types[field] === undefined,
        ) ||
        decision.candidate_5_contract.mechanism_classes.length === 0 ||
        decision.candidate_5_contract.falsifiers.length === 0 ||
        decision.candidate_5_contract.coverage_claims.length === 0 ||
        decision.candidate_4_review.issue_codes.some((issueCode) => {
          if (
            issueCode !== 'BEHAVIORAL_COVERAGE_GAP' &&
            issueCode !== 'CROSS_TASK_CONSTRUCT_DUPLICATION' &&
            issueCode !== 'PUBLIC_PRIVATE_CONSTRUCT_MISMATCH'
          ) {
            return true;
          }
          return (
            !decision.candidate_5_contract.mechanism_classes.includes(
              CANDIDATE_5_ISSUE_MECHANISMS[issueCode],
            ) ||
            !decision.candidate_5_contract.falsifiers.includes(
              CANDIDATE_5_ISSUE_FALSIFIERS[issueCode],
            )
          );
        }) ||
        JSON.stringify(decision.acceptance_fixture_applicability) !==
          JSON.stringify(decision.candidate_5_contract.fixture_applicability) ||
        !receiptContractMatchesTask(decision) ||
        REQUIRED_FIXTURE_CLASSES.some(
          (fixtureClass) => decision.acceptance_fixture_applicability[fixtureClass] !== 'required',
        ) ||
        decision.acceptance_fixture_applicability.empty !== 'required' ||
        decision.acceptance_fixture_applicability.timeout !== 'not_applicable' ||
        !OPTIONAL_FIXTURE_CLASSES.every((fixtureClass) =>
          ['required', 'not_applicable'].includes(
            decision.acceptance_fixture_applicability[fixtureClass],
          ),
        ) ||
        (decision.predecessor_decision === 'revised' && decision.public_task_revision === null) ||
        (decision.public_task_revision !== null &&
          (decision.public_task_revision.title.length < 8 ||
            decision.public_task_revision.summary.length < 80 ||
            decision.public_task_revision.input_contract_kind.length < 8 ||
            decision.public_task_revision.evaluator_kind.length < 8 ||
            decision.public_task_revision.pass_conditions.length < 3 ||
            decision.public_task_revision.allowed_tools.length === 0 ||
            decision.public_task_revision.tags.length < 2)),
    ) ||
    revisedScenarioContracts.some((contract) => {
      if (
        contract.scenario_contract === null ||
        contract.operation_contract === null ||
        contract.semantic_result_contract === null
      ) {
        return true;
      }
      const taskSpecificFields = contract.scenario_contract.task_specific_fields;
      const consumes = contract.operation_contract.consumes;
      const produces = contract.operation_contract.produces;
      const semanticFields = contract.semantic_result_contract.required_fields;
      return (
        JSON.stringify(taskSpecificFields) !== JSON.stringify(consumes) ||
        JSON.stringify(produces) !== JSON.stringify(semanticFields)
      );
    }) ||
    predecessorRetained.some(
      (decision) =>
        decision.candidate_5_contract.scenario_contract !== null ||
        decision.candidate_5_contract.operation_contract !== null ||
        decision.candidate_5_contract.semantic_result_contract !== null ||
        canonicalJson(decision.candidate_5_contract.response_contract) !==
          canonicalJson(decision.candidate_4_contract.response_contract) ||
        canonicalJson(decision.candidate_5_contract.receipt_contract) !==
          canonicalJson(decision.candidate_4_contract.receipt_contract) ||
        canonicalJson(decision.candidate_5_contract.fixture_applicability) !==
          canonicalJson(decision.candidate_4_contract.fixture_applicability),
    ) ||
    new Set(
      revisedScenarioContracts.map((contract) =>
        canonicalJson(contract.operation_contract?.behavior_signature),
      ),
    ).size !== 7 ||
    new Set(
      revisedScenarioContracts.map((contract) =>
        canonicalJson(contract.scenario_contract?.task_specific_fields),
      ),
    ).size !== 7 ||
    new Set(
      revisedScenarioContracts.map((contract) =>
        canonicalJson(contract.semantic_result_contract?.required_fields),
      ),
    ).size !== 7 ||
    new Set(
      revisedScenarioContracts.map((contract) => String(contract.operation_contract?.operation_id)),
    ).size !== 7 ||
    new Set(
      predecessorRevised.map((decision) =>
        String(decision.public_task_revision?.input_contract_kind),
      ),
    ).size !== 7 ||
    new Set(
      predecessorRevised.map((decision) => String(decision.public_task_revision?.evaluator_kind)),
    ).size !== 7
  ) {
    throw new Error('Every predecessor task needs one ordered explicit retained/revised decision.');
  }
}

function fixtureDeclaration(
  taskId: string,
  fixtureClass: string,
  applicability: FixtureApplicability,
): JsonObject {
  if (applicability !== 'required') return { applicability, handle: null };
  return {
    applicability,
    handle: `aiq-acceptance://${taskId}/v7/${fixtureClass.replaceAll('_', '-')}`,
  };
}

function reviseTask(
  priorValue: unknown,
  decision: TaskDecision,
  responseAuthority: PublicTaskResponseAuthority,
): JsonObject {
  const prior = jsonObject(structuredClone(priorValue), `predecessor task ${decision.task_id}`);
  if (prior.task_id !== decision.task_id) {
    throw new Error(`Decision ${decision.task_id} is not aligned with its predecessor task.`);
  }
  const inputContract = jsonObject(prior.input_contract, `${decision.task_id} input contract`);
  const evaluator = jsonObject(prior.evaluator, `${decision.task_id} evaluator`);
  const revision = decision.public_task_revision;
  const applicability = decision.acceptance_fixture_applicability;
  const acceptanceFixtureCommitments: JsonObject = {};
  for (const fixtureClass of REQUIRED_FIXTURE_CLASSES) {
    acceptanceFixtureCommitments[fixtureClass] = fixtureDeclaration(
      decision.task_id,
      fixtureClass,
      'required',
    );
  }
  for (const fixtureClass of OPTIONAL_FIXTURE_CLASSES) {
    acceptanceFixtureCommitments[fixtureClass] = fixtureDeclaration(
      decision.task_id,
      fixtureClass,
      applicability[fixtureClass],
    );
  }

  return {
    ...prior,
    task_version: TASK_SET_VERSION,
    title: revision?.title ?? prior.title,
    summary: revision?.summary ?? prior.summary,
    design_revision: {
      supersedes_task_version: '1.1.0',
      supersedes_candidate_id: PREDECESSOR_CANDIDATE_ID,
      decision: 'retained',
      predecessor_decision: decision.predecessor_decision,
      decision_record: DECISION_PATH,
      kind: 'frozen_candidate_authoring',
      objective:
        'Repair candidate.16 public-optional-field evaluator parity and active delivery documentation while preserving the public task contract and Official calibration policy.',
      task_specific_delta: CALIBRATION_REVISED_TASK_IDS.some(
        (taskId) => taskId === decision.task_id,
      )
        ? `${decision.task_id} requires candidate.17 private optional-field parity repair under the retained public contract.`
        : `${decision.task_id} retains exact candidate.16 private semantics after independent review.`,
      candidate_4_review: decision.candidate_4_review,
      candidate_5_contract: decision.candidate_5_contract,
      task_response_authority: {
        schema_version: taskResponseAuthorityManifest.schema_version,
        source: TASK_RESPONSE_AUTHORITY_PATH,
        response_mode: responseAuthority.response_mode,
        response_locations: responseAuthority.response_locations,
      },
      controlled_corpus_requirements: CONTROLLED_CORPUS_REQUIREMENTS,
    },
    input_contract: {
      ...inputContract,
      kind: revision?.input_contract_kind ?? inputContract.kind,
      fixture_profile: `aiq-fixture://${decision.task_id}/v5`,
      content_handle: stringValue(
        inputContract.content_handle,
        `${decision.task_id} content handle`,
      ).replace('aiq-core/1.0.7', 'aiq-core/1.1.0'),
    },
    cluster_id: decision.cluster_id,
    allowed_tools: revision?.allowed_tools ?? prior.allowed_tools,
    evaluator: {
      ...evaluator,
      kind: revision?.evaluator_kind ?? evaluator.kind,
      pass_conditions: revision?.pass_conditions ?? evaluator.pass_conditions,
      acceptance_fixture_commitments: acceptanceFixtureCommitments,
    },
    tags: revision?.tags ?? prior.tags,
    provenance: {
      origin: 'candidate_16_independent_review_repair_authoring',
      owner: 'AIQ benchmark maintainers',
      recorded_date: '2026-08-30',
      predecessor_task_version: '1.1.0',
      predecessor_candidate_id: PREDECESSOR_CANDIDATE_ID,
      source: GENERATOR_PATH,
      decision_record: DECISION_PATH,
      task_response_authority: TASK_RESPONSE_AUTHORITY_PATH,
    },
    leakage_review: {
      status: 'independent_private_review_v2_required',
      owner: 'AIQ benchmark maintainers',
      review_requirement: 'exactly_one_matching_aiq_leakage_review_v2_per_task',
      notes: `${decision.task_id} is candidate.17 source frozen for fresh independent review. Candidate.16 review evidence is immutable and not transferable to this identity.`,
    },
  };
}

export function buildCatalogFrom(manifest: CandidateDecisionManifest): JsonObject {
  const prior = jsonObject(buildPriorCatalog(), 'AIQ Core 1.0.7 catalog');
  const priorTasks = unknownArray(prior.tasks, 'AIQ Core 1.0.7 tasks');
  const priorTaskIds = priorTasks.map((task, index) =>
    stringValue(jsonObject(task, `predecessor task ${String(index)}`).task_id, 'task id'),
  );
  assertDecisionManifest(manifest, priorTaskIds);
  const tasks = priorTasks.map((task, index) => {
    const decision = manifest.decisions[index];
    const responseAuthority = taskResponseAuthorityManifest.tasks[index];
    if (decision === undefined) throw new Error(`Decision ${String(index)} is missing.`);
    if (responseAuthority === undefined || responseAuthority.task_id !== decision.task_id) {
      throw new Error(`Task response authority ${String(index)} is missing or unordered.`);
    }
    return reviseTask(task, decision, responseAuthority);
  });
  for (const [index, taskValue] of tasks.entries()) {
    const task = jsonObject(taskValue, `generated task ${String(index)}`);
    const taskId = stringValue(task.task_id, `generated task ${String(index)} id`);
    const design = jsonObject(task.design_revision, `${taskId} generated design`);
    const currentContract = jsonObject(
      jsonObject(design.candidate_5_contract, `${taskId} generated candidate.5 contract`)
        .response_contract,
      `${taskId} generated response contract`,
    );
    const decision = manifest.decisions[index];
    const responseAuthority = taskResponseAuthorityManifest.tasks[index];
    if (decision === undefined) throw new Error(`Decision ${String(index)} is missing.`);
    if (responseAuthority === undefined) {
      throw new Error(`Task response authority ${String(index)} is missing.`);
    }
    assertGeneratedResponseContract(
      currentContract,
      responseAuthority,
      `${decision.task_id} generated catalog entry`,
    );
  }
  const taskFacingProjections = tasks.map(taskFacingSemantics);
  for (const [index, projection] of taskFacingProjections.entries()) {
    const decision = manifest.decisions[index];
    if (
      decision === undefined ||
      digestValue(projection) !== decision.candidate_5_task_facing_semantics_sha256
    ) {
      throw new Error('Candidate.17 public task semantics drift from candidate.16.');
    }
  }
  const publicContractProjection = tasks.map((task, index) => ({
    task_facing: taskFacingProjections[index],
    response_contract: jsonObject(
      jsonObject(
        jsonObject(task, `task ${String(index)}`).design_revision,
        `task ${String(index)} design revision`,
      ).candidate_5_contract,
      `task ${String(index)} candidate.5 contract`,
    ).response_contract,
  }));
  const evaluatorFixtureToolProjection = tasks.map((taskValue, index) => {
    const task = jsonObject(taskValue, `task ${String(index)}`);
    return {
      task_id: task.task_id,
      allowed_tools: task.allowed_tools,
      evaluator: task.evaluator,
      fixture_profile: jsonObject(task.input_contract, `task ${String(index)} input contract`)
        .fixture_profile,
      candidate_5_contract: jsonObject(
        jsonObject(task.design_revision, `task ${String(index)} design revision`)
          .candidate_5_contract,
        `task ${String(index)} candidate.5 contract`,
      ),
    };
  });
  if (
    digestValue(taskFacingProjections) !== PREDECESSOR_TASK_FACING_SEMANTICS_SHA256 ||
    digestValue(publicContractProjection) !== PREDECESSOR_PUBLIC_CONTRACT_PROJECTION_SHA256 ||
    digestValue(evaluatorFixtureToolProjection) !== PREDECESSOR_EVALUATOR_FIXTURE_TOOL_SHA256 ||
    digestValue(
      manifest.decisions.map((decision) => ({
        task_id: decision.task_id,
        catalog_entry_sha256: decision.candidate_5_catalog_entry_sha256,
      })),
    ) !== CANDIDATE_5_CATALOG_ENTRY_BINDINGS_SHA256
  ) {
    throw new Error(
      'Candidate.17 public task, response, evaluator, fixture, or tool semantics drifted.',
    );
  }
  const taskMetadataIdentity = {
    algorithm: 'sha256',
    canonicalization: 'aiq.sorted-key-json.v1',
    digest: digestValue(tasks),
    scope: 'ordered_full_task_metadata',
  };
  const releaseIdentityInput = {
    release_identity: CANDIDATE_ID,
    scoring_version: TASK_SCORER_VERSION,
    task_metadata_identity: taskMetadataIdentity,
  };

  return {
    ...prior,
    schema_version: 'aiq.catalog.v2',
    task_set_version: TASK_SET_VERSION,
    title: 'AIQ Core 1.1.0 candidate.17 independent-review repair',
    status: 'frozen_candidate',
    generated_from: GENERATOR_PATH,
    candidate_identity: {
      candidate_id: CANDIDATE_ID,
      task_metadata_digest: taskMetadataIdentity.digest,
    },
    task_response_authority: {
      schema_version: taskResponseAuthorityManifest.schema_version,
      authority: taskResponseAuthorityManifest.authority,
      source: TASK_RESPONSE_AUTHORITY_PATH,
      digest: digestValue(taskResponseAuthorityManifest),
      scope: 'ordered_task_response_modes_and_locations',
    },
    task_metadata_identity: taskMetadataIdentity,
    catalog_release_identity: {
      ...releaseIdentityInput,
      algorithm: 'sha256',
      canonicalization: 'aiq.sorted-key-json.v1',
      digest: digestValue(releaseIdentityInput),
      scope: 'candidate_identity_scoring_version_and_ordered_task_metadata_identity',
    },
    content_policy: {
      public_repository:
        'Metadata, schemas, explicit design decisions, public examples, and synthetic contract fixtures only.',
      controlled_source:
        'The catalog is the sole expected acceptance-fixture applicability authority. Observed controlled classes must equal each task declaration exactly. Private tasks, fixtures, evaluator content, review requests, leakage reviews, and signing material stay outside Git.',
      predecessor_relation:
        'Candidates.1 through .16 are immutable predecessor evidence. Candidate.17 preserves candidate.16 public contracts and measured bank repair while correcting optional-field evaluator parity for 36 structured and seven ToolUse tasks without changing policy v2.',
    },
    candidate_state: {
      identity_state: 'frozen_for_independent_review',
      predecessor_task_set_version: '1.1.0',
      predecessor_candidate: manifest.predecessor_candidate,
      immutable_rejected_predecessors: manifest.immutable_rejected_predecessors,
      retained_candidate_5_task_issue_closures: manifest.retained_candidate_5_task_issue_closures,
      source_integrity_closure: manifest.source_integrity_closure,
      source_end_to_end_validation_closure: manifest.source_end_to_end_validation_closure,
      package_input_validation_closure: manifest.package_input_validation_closure,
      node_runtime_correction_closure: manifest.node_runtime_correction_closure,
      public_response_contract_validation_closure:
        manifest.public_response_contract_validation_closure,
      response_source_authority_closure: manifest.response_source_authority_closure,
      calibration_policy_repair: manifest.calibration_policy_repair,
      task_response_authority: {
        source: TASK_RESPONSE_AUTHORITY_PATH,
        digest: digestValue(taskResponseAuthorityManifest),
      },
      decision_record: DECISION_PATH,
      semantic_decision_counts: { retained: 72, revised: 0 },
      predecessor_design_decision_counts: { retained: 65, revised: 7 },
      task_issue_closure_counts: manifest.task_issue_code_counts,
      private_fixture_mapping_reconciled: true,
      private_tasks_authored: true,
      predecessor_review_status: 'not_completed_source_rejected',
      independent_review_status: 'pending',
      seal_status: 'pending',
      calibration_status: 'pending',
      qualification_status: 'pending',
      release_status: 'pending',
      activation_status: 'pending',
      deployment_status: 'pending',
      production_acceptance_status: 'pending',
      active: false,
      production_publishable: false,
      next_required_actions: [
        'Complete one new independent aiq.leakage-review.v2 record for every exact candidate.17 task and catalog-entry digest; candidate.16 evidence is not transferable.',
        'Seal the reviewed private corpus twice without changing this frozen candidate identity.',
        'Run a bounded family screen, then one fresh complete non-synthetic 17-by-72 calibration and pass aiq.official-calibration-policy.v2.',
        'Complete qualification, release adoption, and production acceptance before cutover, activation, or publication.',
      ],
    },
    tasks,
  };
}

export function buildCatalog(): JsonObject {
  return buildCatalogFrom(decisionManifest);
}

function reviseCatalogSchema(priorValue: unknown): JsonObject {
  const schema = jsonObject(reviseSchemaStrings(priorValue), 'catalog schema');
  const properties = jsonObject(schema.properties, 'catalog properties');
  const required =
    schema.required === undefined
      ? []
      : unknownArray(schema.required, 'catalog required fields').map((field, index) =>
          stringValue(field, `catalog required field ${String(index)}`),
        );
  for (const field of ['candidate_identity', 'candidate_state', 'task_response_authority']) {
    if (!required.includes(field)) required.push(field);
  }
  schema.required = required;
  properties.schema_version = { const: 'aiq.catalog.v2' };
  properties.task_set_version = { const: TASK_SET_VERSION };
  properties.status = { const: 'frozen_candidate' };
  properties.generated_from = { const: GENERATOR_PATH };
  properties.candidate_identity = {
    type: 'object',
    additionalProperties: false,
    required: ['candidate_id', 'task_metadata_digest'],
    properties: {
      candidate_id: { const: CANDIDATE_ID },
      task_metadata_digest: { pattern: '^sha256:[0-9a-f]{64}(?![\\s\\S])', type: 'string' },
    },
  };
  properties.task_response_authority = {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'authority', 'source', 'digest', 'scope'],
    properties: {
      schema_version: { const: taskResponseAuthorityManifest.schema_version },
      authority: { const: taskResponseAuthorityManifest.authority },
      source: { const: TASK_RESPONSE_AUTHORITY_PATH },
      digest: { const: digestValue(taskResponseAuthorityManifest) },
      scope: { const: 'ordered_task_response_modes_and_locations' },
    },
  };
  properties.candidate_state = {
    type: 'object',
    additionalProperties: false,
    required: [
      'identity_state',
      'predecessor_task_set_version',
      'predecessor_candidate',
      'immutable_rejected_predecessors',
      'retained_candidate_5_task_issue_closures',
      'source_integrity_closure',
      'source_end_to_end_validation_closure',
      'package_input_validation_closure',
      'node_runtime_correction_closure',
      'public_response_contract_validation_closure',
      'response_source_authority_closure',
      'task_response_authority',
      'decision_record',
      'semantic_decision_counts',
      'predecessor_design_decision_counts',
      'task_issue_closure_counts',
      'private_fixture_mapping_reconciled',
      'private_tasks_authored',
      'predecessor_review_status',
      'independent_review_status',
      'seal_status',
      'calibration_status',
      'qualification_status',
      'release_status',
      'activation_status',
      'deployment_status',
      'production_acceptance_status',
      'active',
      'production_publishable',
      'next_required_actions',
    ],
    properties: {
      identity_state: { const: 'frozen_for_independent_review' },
      predecessor_task_set_version: { const: '1.1.0' },
      predecessor_candidate: { const: decisionManifest.predecessor_candidate },
      immutable_rejected_predecessors: {
        const: decisionManifest.immutable_rejected_predecessors,
      },
      retained_candidate_5_task_issue_closures: {
        const: decisionManifest.retained_candidate_5_task_issue_closures,
      },
      source_integrity_closure: {
        const: decisionManifest.source_integrity_closure,
      },
      source_end_to_end_validation_closure: {
        const: decisionManifest.source_end_to_end_validation_closure,
      },
      package_input_validation_closure: {
        const: decisionManifest.package_input_validation_closure,
      },
      node_runtime_correction_closure: {
        const: decisionManifest.node_runtime_correction_closure,
      },
      public_response_contract_validation_closure: {
        const: decisionManifest.public_response_contract_validation_closure,
      },
      response_source_authority_closure: {
        const: decisionManifest.response_source_authority_closure,
      },
      task_response_authority: {
        const: {
          source: TASK_RESPONSE_AUTHORITY_PATH,
          digest: digestValue(taskResponseAuthorityManifest),
        },
      },
      decision_record: { const: DECISION_PATH },
      semantic_decision_counts: { const: { retained: 72, revised: 0 } },
      predecessor_design_decision_counts: {
        const: { retained: 65, revised: 7 },
      },
      task_issue_closure_counts: { const: decisionManifest.task_issue_code_counts },
      private_fixture_mapping_reconciled: { const: true },
      private_tasks_authored: { const: true },
      predecessor_review_status: { const: 'not_completed_source_rejected' },
      independent_review_status: { const: 'pending' },
      seal_status: { const: 'pending' },
      calibration_status: { const: 'pending' },
      qualification_status: { const: 'pending' },
      release_status: { const: 'pending' },
      activation_status: { const: 'pending' },
      deployment_status: { const: 'pending' },
      production_acceptance_status: { const: 'pending' },
      active: { const: false },
      production_publishable: { const: false },
      next_required_actions: {
        type: 'array',
        minItems: 4,
        uniqueItems: true,
        items: { type: 'string', minLength: 40 },
      },
    },
  };

  const definitions = jsonObject(schema.$defs, 'catalog definitions');
  const handleCondition: JsonObject = {
    if: { properties: { applicability: { const: 'required' } } },
    else: { properties: { handle: { type: 'null' } } },
  };
  Reflect.set(handleCondition, 'then', { properties: { handle: { type: 'string' } } });
  definitions.acceptanceFixtureCommitment = {
    type: 'object',
    additionalProperties: false,
    required: ['applicability', 'handle'],
    properties: {
      applicability: {
        enum: ['required', 'not_applicable'],
      },
      handle: {
        type: ['string', 'null'],
        pattern:
          '^aiq-acceptance://[a-z0-9-]+-[0-9]{2}/v(?:2|3|4|5|6|7)/(?:gold|alternate-correct|partial|adversarial-format|empty|timeout)(?![\\s\\S])',
      },
    },
    allOf: [handleCondition],
  };
  const task = jsonObject(definitions.task, 'catalog task');
  const taskProperties = jsonObject(task.properties, 'catalog task properties');
  taskProperties.task_version = { const: TASK_SET_VERSION };
  const candidateContractCondition = (
    decision: Decision,
    contractType: 'null' | 'object',
  ): JsonObject => {
    const condition: JsonObject = {
      if: { properties: { predecessor_decision: { const: decision } } },
    };
    Reflect.set(condition, 'then', {
      properties: {
        candidate_5_contract: {
          properties: {
            scenario_contract: { type: contractType },
            operation_contract: { type: contractType },
            semantic_result_contract: { type: contractType },
          },
        },
      },
    });
    return condition;
  };
  const responseAuthorityModeCondition: JsonObject = {
    if: { properties: { response_mode: { const: 'final_response' } } },
    else: {
      properties: {
        response_locations: {
          not: { contains: { const: 'final_response' } },
        },
      },
    },
  };
  Reflect.set(responseAuthorityModeCondition, 'then', {
    properties: { response_locations: { const: ['final_response'] } },
  });
  taskProperties.design_revision = {
    type: 'object',
    additionalProperties: false,
    required: [
      'supersedes_task_version',
      'supersedes_candidate_id',
      'decision',
      'predecessor_decision',
      'decision_record',
      'kind',
      'objective',
      'task_specific_delta',
      'candidate_4_review',
      'candidate_5_contract',
      'task_response_authority',
      'controlled_corpus_requirements',
    ],
    properties: {
      supersedes_task_version: { const: '1.1.0' },
      supersedes_candidate_id: { const: PREDECESSOR_CANDIDATE_ID },
      decision: { const: 'retained' },
      predecessor_decision: { enum: ['retained', 'revised'] },
      decision_record: { const: DECISION_PATH },
      kind: { const: 'frozen_candidate_authoring' },
      objective: { type: 'string', minLength: 80 },
      task_specific_delta: { type: 'string', minLength: 160 },
      candidate_4_review: {
        type: 'object',
        additionalProperties: false,
        required: [
          'verdict',
          'record_sha256',
          'task_definition_sha256',
          'catalog_entry_sha256',
          'issue_codes',
        ],
        properties: {
          verdict: { enum: ['approved', 'rejected'] },
          record_sha256: { pattern: '^sha256:[0-9a-f]{64}(?![\\s\\S])', type: 'string' },
          task_definition_sha256: {
            pattern: '^sha256:[0-9a-f]{64}(?![\\s\\S])',
            type: 'string',
          },
          catalog_entry_sha256: {
            pattern: '^sha256:[0-9a-f]{64}(?![\\s\\S])',
            type: 'string',
          },
          issue_codes: {
            type: 'array',
            uniqueItems: true,
            items: { enum: ISSUE_CODES },
          },
        },
      },
      task_response_authority: {
        type: 'object',
        additionalProperties: false,
        required: ['schema_version', 'source', 'response_mode', 'response_locations'],
        properties: {
          schema_version: { const: taskResponseAuthorityManifest.schema_version },
          source: { const: TASK_RESPONSE_AUTHORITY_PATH },
          response_mode: { enum: ['final_response', 'workspace'] },
          response_locations: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', pattern: '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$)).+$' },
          },
        },
        allOf: [responseAuthorityModeCondition],
      },
      candidate_5_contract: {
        type: 'object',
        additionalProperties: false,
        required: [
          'construct_id',
          'response_contract',
          'receipt_contract',
          'scenario_contract',
          'operation_contract',
          'semantic_result_contract',
          'fixture_applicability',
          'mechanism_classes',
          'falsifiers',
          'coverage_claims',
        ],
        properties: {
          construct_id: { type: 'string', minLength: 12, maxLength: 128 },
          response_contract: {
            type: 'object',
            additionalProperties: false,
            required: [
              'shape_kind',
              'transport',
              'locations',
              'required_fields',
              'optional_fields',
              'field_types',
              'field_semantics',
            ],
            properties: {
              shape_kind: { type: 'string', minLength: 4 },
              transport: { enum: ['final_response', 'workspace'] },
              locations: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { type: 'string', pattern: '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$)).+$' },
              },
              required_fields: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { type: 'string', minLength: 1 },
              },
              optional_fields: {
                type: 'array',
                uniqueItems: true,
                items: { type: 'string', minLength: 1 },
              },
              field_types: {
                type: 'object',
                minProperties: 1,
                additionalProperties: {
                  enum: RESPONSE_FIELD_TYPES,
                },
              },
              field_semantics: {
                type: 'object',
                minProperties: 1,
                additionalProperties: { type: 'string', minLength: 20 },
              },
            },
          },
          receipt_contract: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: [
                  'schema_version',
                  'location',
                  'transport',
                  'producer',
                  'required_command',
                  'required_command_sha256',
                  'required_fields',
                  'optional_fields',
                  'field_types',
                  'field_semantics',
                  'field_producers',
                  'field_verification',
                  'canonicalization',
                  'runner_binding',
                  'result_binding',
                  'model_obligation',
                  'additional_fields',
                  'key_order',
                  'predecessor_undisclosed_fields',
                  'required_invocations',
                  'tool_evidence_requirements',
                ],
                properties: {
                  schema_version: { const: 'aiq.tool-receipt-contract.v2' },
                  location: { const: 'receipt.json' },
                  transport: { const: 'workspace_file' },
                  producer: { const: 'supplied_local_tool' },
                  required_command: { const: REQUIRED_COMMAND },
                  required_command_sha256: { const: REQUIRED_COMMAND_SHA256 },
                  required_fields: { const: RECEIPT_FIELDS },
                  optional_fields: { const: [] },
                  field_types: {
                    const: Object.fromEntries(
                      RECEIPT_FIELDS.map((field) => [
                        field,
                        field === 'invocation_count' ? 'integer' : 'string',
                      ]),
                    ),
                  },
                  field_semantics: {
                    type: 'object',
                    additionalProperties: false,
                    required: RECEIPT_FIELDS,
                    properties: Object.fromEntries(
                      RECEIPT_FIELDS.map((field) => [field, { type: 'string', minLength: 20 }]),
                    ),
                  },
                  field_producers: {
                    const: Object.fromEntries(
                      RECEIPT_FIELDS.map((field) => [field, 'supplied_local_tool']),
                    ),
                  },
                  field_verification: {
                    type: 'object',
                    additionalProperties: false,
                    required: RECEIPT_FIELDS,
                    properties: Object.fromEntries(
                      RECEIPT_FIELDS.map((field) => [field, { type: 'string', minLength: 20 }]),
                    ),
                  },
                  canonicalization: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'digest_algorithm',
                      'digest_prefix',
                      'json',
                      'command_sha256',
                      'input_sha256',
                      'output_sha256',
                      'receipt_sha256',
                    ],
                    properties: {
                      digest_algorithm: { const: 'sha256' },
                      digest_prefix: { const: 'sha256:' },
                      json: { const: 'aiq.sorted-key-json.v1' },
                      command_sha256: { const: 'raw_file_bytes' },
                      input_sha256: { const: 'sorted_key_json_of_parsed_input' },
                      output_sha256: { const: 'sorted_key_json_of_result_object' },
                      receipt_sha256: {
                        const: 'sorted_key_json_of_receipt_without_receipt_sha256',
                      },
                    },
                  },
                  runner_binding: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'producer',
                      'transport',
                      'automatic_fields',
                      'receipt_fields_automatic',
                      'relationship',
                    ],
                    properties: {
                      producer: { const: 'runner' },
                      transport: { const: 'evaluator_input.tool_evidence' },
                      automatic_fields: {
                        const: [
                          'steps',
                          'total_calls',
                          'by_tool.command_execution',
                          'completed_command_sha256',
                        ],
                      },
                      receipt_fields_automatic: { const: [] },
                      relationship: { type: 'string', minLength: 40 },
                    },
                  },
                  result_binding: {
                    const: {
                      location: 'result.json',
                      receipt_digest_field: 'receipt_sha256',
                    },
                  },
                  model_obligation: { type: 'string', minLength: 60 },
                  tool_evidence_requirements: {
                    const: {
                      exact_total_calls: 1,
                      exact_calls_by_tool: { command_execution: 1 },
                      required_completed_command_sha256: {
                        [REQUIRED_COMMAND_SHA256]: 1,
                      },
                    },
                  },
                  additional_fields: { const: 'forbidden' },
                  key_order: { const: 'not_significant' },
                  predecessor_undisclosed_fields: {
                    const: PREDECESSOR_UNDISCLOSED_RECEIPT_FIELDS,
                  },
                  required_invocations: { const: 1 },
                },
              },
            ],
          },
          scenario_contract: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: [
                  'schema_version',
                  'location',
                  'transport',
                  'producer',
                  'identity_fields',
                  'task_specific_fields',
                  'required_fields',
                  'optional_fields',
                  'field_types',
                  'field_semantics',
                  'additional_fields',
                ],
                properties: {
                  schema_version: { const: 'aiq.tool-scenario-contract.v1' },
                  location: { const: 'input.json' },
                  transport: { const: 'workspace_file' },
                  producer: { const: 'benchmark_author' },
                  identity_fields: {
                    const: ['schema_version', 'task_id', 'construct_id', 'operation_id'],
                  },
                  task_specific_fields: {
                    type: 'array',
                    minItems: 4,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 2 },
                  },
                  required_fields: {
                    type: 'array',
                    minItems: 8,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 2 },
                  },
                  optional_fields: { const: [] },
                  field_types: {
                    type: 'object',
                    minProperties: 8,
                    additionalProperties: {
                      enum: ['array', 'boolean', 'number', 'object', 'string'],
                    },
                  },
                  field_semantics: {
                    type: 'object',
                    minProperties: 8,
                    additionalProperties: { type: 'string', minLength: 20 },
                  },
                  additional_fields: { const: 'forbidden' },
                },
              },
            ],
          },
          operation_contract: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: [
                  'operation_id',
                  'deterministic',
                  'description',
                  'consumes',
                  'produces',
                  'behavior_signature',
                ],
                properties: {
                  operation_id: { type: 'string', minLength: 12 },
                  deterministic: { const: true },
                  description: { type: 'string', minLength: 80 },
                  consumes: {
                    type: 'array',
                    minItems: 4,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 2 },
                  },
                  produces: {
                    type: 'array',
                    minItems: 5,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 2 },
                  },
                  behavior_signature: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'state_model',
                      'transitions',
                      'invariants',
                      'error_paths',
                      'metamorphic_basis',
                    ],
                    properties: {
                      state_model: { type: 'string', minLength: 20 },
                      transitions: {
                        type: 'array',
                        minItems: 3,
                        uniqueItems: true,
                        items: { type: 'string', minLength: 8 },
                      },
                      invariants: {
                        type: 'array',
                        minItems: 2,
                        uniqueItems: true,
                        items: { type: 'string', minLength: 8 },
                      },
                      error_paths: {
                        type: 'array',
                        minItems: 3,
                        uniqueItems: true,
                        items: { type: 'string', minLength: 8 },
                      },
                      metamorphic_basis: {
                        type: 'array',
                        minItems: 4,
                        uniqueItems: true,
                        items: { type: 'string', minLength: 2 },
                      },
                    },
                  },
                },
              },
            ],
          },
          semantic_result_contract: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: [
                  'location',
                  'transport',
                  'required_fields',
                  'optional_fields',
                  'field_types',
                  'field_semantics',
                  'additional_fields',
                ],
                properties: {
                  location: { const: 'result.json#/result' },
                  transport: { const: 'workspace_json_pointer' },
                  required_fields: {
                    type: 'array',
                    minItems: 5,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 2 },
                  },
                  optional_fields: { const: [] },
                  field_types: {
                    type: 'object',
                    minProperties: 5,
                    additionalProperties: {
                      enum: ['array', 'boolean', 'number', 'object', 'string'],
                    },
                  },
                  field_semantics: {
                    type: 'object',
                    minProperties: 5,
                    additionalProperties: { type: 'string', minLength: 20 },
                  },
                  additional_fields: { const: 'forbidden' },
                },
              },
            ],
          },
          fixture_applicability: {
            const: {
              gold: 'required',
              alternate_correct: 'required',
              partial: 'required',
              adversarial_format: 'required',
              empty: 'required',
              timeout: 'not_applicable',
            },
          },
          mechanism_classes: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', minLength: 8 },
          },
          falsifiers: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', minLength: 8 },
          },
          coverage_claims: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', minLength: 20 },
          },
        },
      },
      controlled_corpus_requirements: {
        type: 'array',
        minItems: 4,
        uniqueItems: true,
        items: { type: 'string', minLength: 40 },
      },
    },
    allOf: [
      candidateContractCondition('retained', 'null'),
      candidateContractCondition('revised', 'object'),
    ],
  };
  taskProperties.provenance = {
    type: 'object',
    additionalProperties: false,
    required: [
      'origin',
      'owner',
      'recorded_date',
      'predecessor_task_version',
      'predecessor_candidate_id',
      'source',
      'decision_record',
      'task_response_authority',
    ],
    properties: {
      origin: { const: 'candidate_16_independent_review_repair_authoring' },
      owner: { const: 'AIQ benchmark maintainers' },
      recorded_date: { const: '2026-08-30' },
      predecessor_task_version: { const: '1.1.0' },
      predecessor_candidate_id: { const: PREDECESSOR_CANDIDATE_ID },
      source: { const: GENERATOR_PATH },
      decision_record: { const: DECISION_PATH },
      task_response_authority: { const: TASK_RESPONSE_AUTHORITY_PATH },
    },
  };
  const inputContract = jsonObject(taskProperties.input_contract, 'task input contract');
  const inputContractProperties = jsonObject(
    inputContract.properties,
    'task input contract properties',
  );
  inputContractProperties.fixture_profile = {
    type: 'string',
    pattern: '^aiq-fixture://[a-z0-9-]+-[0-9]{2}/v5(?![\\s\\S])',
  };
  const release = jsonObject(properties.catalog_release_identity, 'release identity');
  const releaseProperties = jsonObject(release.properties, 'release properties');
  releaseProperties.release_identity = { const: CANDIDATE_ID };
  releaseProperties.scoring_version = { const: TASK_SCORER_VERSION };
  releaseProperties.scope = {
    const: 'candidate_identity_scoring_version_and_ordered_task_metadata_identity',
  };

  return schema;
}

function reviseTaskSchema(priorValue: unknown): JsonObject {
  const schema = jsonObject(reviseSchemaStrings(priorValue), 'task schema');
  const properties = jsonObject(schema.properties, 'task properties');
  properties.task_version = { const: TASK_SET_VERSION };
  properties.scorer_version = { const: TASK_SCORER_VERSION };
  return schema;
}

async function readPriorCandidate(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(`../../../benchmarks/candidates/aiq-core-1.0.7/${name}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;
}

export async function writeCandidate(outputDirectory: string): Promise<void> {
  const catalog = buildCatalog();
  const catalogSchema = reviseCatalogSchema(await readPriorCandidate('catalog.schema.json'));
  const taskSchema = reviseTaskSchema(await readPriorCandidate('task.schema.json'));
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(`${outputDirectory}/catalog.json`, `${JSON.stringify(catalog, undefined, 2)}\n`),
    writeFile(
      `${outputDirectory}/catalog.schema.json`,
      `${JSON.stringify(catalogSchema, undefined, 2)}\n`,
    ),
    writeFile(
      `${outputDirectory}/task.schema.json`,
      `${JSON.stringify(taskSchema, undefined, 2)}\n`,
    ),
  ]);
}

if (import.meta.main) {
  const outputDirectory = dirname(
    fileURLToPath(
      new URL('../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json', import.meta.url),
    ),
  );
  await writeCandidate(outputDirectory);
  const catalog = buildCatalog();
  const candidateIdentity = jsonObject(catalog.candidate_identity, 'candidate identity');
  const releaseIdentity = jsonObject(catalog.catalog_release_identity, 'release identity');
  process.stdout.write(
    `${JSON.stringify({
      candidate_id: CANDIDATE_ID,
      candidate_catalog_sha256: digestValue(catalog),
      candidate_release_identity_sha256: releaseIdentity.digest,
      task_metadata_identity_sha256: candidateIdentity.task_metadata_digest,
    })}\n`,
  );
}
