import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Canonical generator for the active AIQ Core 1.0.3 catalog.

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
    readonly source: 'scripts/candidates/aiq-core-1.0.3/generate-benchmark-catalog.ts';
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
  | 'partial'
  // This combined class covers adversarial content and output-format attacks.
  | 'adversarial_format'
  | 'empty'
  | 'timeout';

interface AcceptanceFixtureCommitment {
  readonly handle: string;
  readonly status: 'required_in_controlled_source';
}

export const AIQ_CORE_V1_TASK_METADATA_IDENTITY_SHA256 =
  'sha256:0e315fe2bbcf0efe59ddcd69173addf89ef0fb281ec3ef523234bdc01b3d66a1';
export const AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256 =
  'sha256:0dd4f11c49a1e295a75e6ca1e3b7b4f9c38e0160b9eda75ca75a47703e47f80d';

const TASK_SET_VERSION = '1.0.3';
const TASK_VERSION = '1.0.3';
const SCORER_VERSION = '1.0.3';

export const COMMAND_EXECUTION_DISCLOSURE =
  'Runner/verifier telemetry records at least one command_execution event; this proves presence, not causality, while independently checked artifacts and, where present, receipts prove final-state correctness.';

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

export interface Catalog {
  readonly schema_version: 'aiq.catalog.v1';
  readonly task_set_id: 'aiq-core';
  readonly task_set_version: typeof TASK_SET_VERSION;
  readonly scoring_version: typeof SCORER_VERSION;
  readonly title: string;
  readonly status: 'active';
  readonly generated_from: string;
  readonly task_metadata_identity: {
    readonly algorithm: 'sha256';
    readonly canonicalization: 'aiq.sorted-key-json.v1';
    readonly digest: string;
    readonly scope: 'ordered_full_task_metadata';
  };
  readonly catalog_release_identity: {
    readonly release_identity: 'aiq-core/1.0.3';
    readonly scoring_version: '1.0.3';
    readonly task_metadata_identity: Catalog['task_metadata_identity'];
    readonly algorithm: 'sha256';
    readonly canonicalization: 'aiq.sorted-key-json.v1';
    readonly digest: string;
    readonly scope: 'release_identity_scoring_version_and_ordered_task_metadata_identity';
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
  readonly tasks: readonly CatalogTask[];
}

export interface CatalogReleaseIdentityInput {
  readonly release_identity: 'aiq-core/1.0.3';
  readonly scoring_version: '1.0.3';
  readonly task_metadata_identity: Catalog['task_metadata_identity'];
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
    'Seeded partial implementations separate core correctness, boundary behavior, and regression preservation.',
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
    partial: commitment('partial'),
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
              ? 'Retarget the predecessor ceiling behavior with coupled constraints, a controlled partial candidate, and independently measurable checks.'
              : 'Rebalance the predecessor design around staged partial outcomes and a deterministic middle-discrimination rubric.',
        task_specific_delta:
          revisionKind === 'replacement'
            ? `Replace the prior controlled scenario with two independently attainable stages: first "${draft.checks[0]}", then "${draft.checks[1]}"; reserve full credit for also satisfying "${draft.checks[2]}" and the domain discrimination check.`
            : revisionKind === 'retargeted'
              ? `Retain a deterministic partial candidate where "${draft.checks[0]}" holds while at least one of "${draft.checks[1]}" or "${draft.checks[2]}" fails; score the observed outcome independently before the domain discrimination check.`
              : `Split the controlled scenario into task-specific evidence for "${draft.checks[0]}", "${draft.checks[1]}", and "${draft.checks[2]}" before applying the domain discrimination check.`,
        controlled_corpus_requirements: [
          'Provide at least three deterministic assertions for each published scoring component.',
          'Include exactly one gold, alternate-correct, partial, adversarial-format, empty, and timeout case.',
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
        source: 'scripts/candidates/aiq-core-1.0.3/generate-benchmark-catalog.ts',
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

  const taskMetadataIdentity: Catalog['task_metadata_identity'] = {
    algorithm: 'sha256',
    canonicalization: 'aiq.sorted-key-json.v1',
    digest: taskMetadataIdentityDigest(tasks),
    scope: 'ordered_full_task_metadata',
  };
  const releaseIdentityInput: CatalogReleaseIdentityInput = {
    release_identity: 'aiq-core/1.0.3',
    scoring_version: SCORER_VERSION,
    task_metadata_identity: taskMetadataIdentity,
  };

  return {
    schema_version: 'aiq.catalog.v1',
    task_set_id: 'aiq-core',
    task_set_version: TASK_SET_VERSION,
    scoring_version: SCORER_VERSION,
    title: 'AIQ Core Daily Work Benchmark',
    status: 'active',
    generated_from: 'scripts/candidates/aiq-core-1.0.3/generate-benchmark-catalog.ts',
    task_metadata_identity: taskMetadataIdentity,
    catalog_release_identity: {
      ...releaseIdentityInput,
      algorithm: 'sha256',
      canonicalization: 'aiq.sorted-key-json.v1',
      digest: catalogReleaseIdentityDigest(releaseIdentityInput),
      scope: 'release_identity_scoring_version_and_ordered_task_metadata_identity',
    },
    content_policy: {
      public_repository: 'Metadata, schemas, public examples, and synthetic scoring fixtures only.',
      controlled_source:
        'Current benchmark prompts, expected outputs, executable hidden fixtures, and secrets must be loaded from private Supabase Storage or a runner-local controlled directory. Core per-task acceptance binds exactly gold, alternate-correct, partial, adversarial-format, empty, and timeout. Near-miss and paired-contrast calibration belongs to the separate AIQ Core Contrast suite and is not a 72-task Core fixture commitment.',
    },
    distribution: {
      total: TASKS.length,
      domains: DOMAIN_QUOTAS,
      difficulties: DIFFICULTY_QUOTAS,
      domain_difficulty: DOMAIN_DIFFICULTY_QUOTAS,
      difficulty_role:
        'Difficulty is a non-ordinal coverage label. It is not an empirical rank and does not set score weight.',
    },
    tasks,
  };
}

export function assertCatalogInvariants(catalog: ReturnType<typeof buildCatalog>): void {
  if (catalog.distribution.total !== 72 || catalog.tasks.length !== 72) {
    throw new Error(`The catalog must contain 72 tasks; found ${String(catalog.tasks.length)}.`);
  }
  if (
    catalog.task_set_version !== TASK_SET_VERSION ||
    catalog.scoring_version !== SCORER_VERSION ||
    catalog.catalog_release_identity.scoring_version !== catalog.scoring_version ||
    catalog.tasks.some(
      (catalogTask) =>
        catalogTask.task_version !== TASK_VERSION ||
        catalogTask.evaluator.scorer_version !== SCORER_VERSION ||
        catalogTask.input_contract.content_handle !==
          `aiq-controlled-task://aiq-core/${TASK_VERSION}/${catalogTask.task_id}`,
    )
  ) {
    throw new Error(
      'The current AIQ Core catalog requires task-set, task, content-handle, and scorer version 1.0.3.',
    );
  }

  const identifiers = new Set(catalog.tasks.map(({ task_id: taskId }) => taskId));
  if (identifiers.size !== catalog.tasks.length) {
    throw new Error('Every benchmark task ID must be unique.');
  }
  if (catalog.status !== 'active') {
    throw new Error('AIQ Core 1.0.3 must be active.');
  }
  for (const domain of DOMAINS) {
    const count = catalog.tasks.filter((catalogTask) => catalogTask.domain === domain).length;
    if (count !== DOMAIN_QUOTAS[domain]) {
      throw new Error(`Domain ${domain} must contain ${String(DOMAIN_QUOTAS[domain])} tasks.`);
    }
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const domainDifficultyCount = catalog.tasks.filter(
        (catalogTask) => catalogTask.domain === domain && catalogTask.difficulty === difficulty,
      ).length;
      if (domainDifficultyCount !== DOMAIN_DIFFICULTY_QUOTAS[domain][difficulty]) {
        throw new Error(
          `${domain}/${difficulty} must contain ${String(DOMAIN_DIFFICULTY_QUOTAS[domain][difficulty])} tasks.`,
        );
      }
    }
  }

  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const count = catalog.tasks.filter(
      (catalogTask) => catalogTask.difficulty === difficulty,
    ).length;
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
    'partial',
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
      throw new Error(`Task ${catalogTask.task_id} does not have the required 1.0.3 redesign.`);
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
    throw new Error('Every AIQ Core 1.0.3 task requires a distinct task-specific design delta.');
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
      `AIQ Core 1.0.3 task metadata identity changed without a versioned commitment update: ${observedTaskIdentity}.`,
    );
  }
  const observedReleaseIdentity = catalogReleaseIdentityDigest({
    release_identity: catalog.catalog_release_identity.release_identity,
    scoring_version: catalog.catalog_release_identity.scoring_version,
    task_metadata_identity: catalog.catalog_release_identity.task_metadata_identity,
  });
  if (catalog.catalog_release_identity.digest !== observedReleaseIdentity) {
    throw new Error(
      `Catalog release identity does not match its task identity and policy: ${observedReleaseIdentity}.`,
    );
  }
  if (observedReleaseIdentity !== AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256) {
    throw new Error(
      `AIQ Core 1.0.3 catalog release identity changed without a versioned commitment update: ${observedReleaseIdentity}.`,
    );
  }
}

export function taskMetadataIdentityDigest(tasks: readonly CatalogTask[]): string {
  return digestValue(tasks);
}

export function catalogReleaseIdentityDigest(identity: CatalogReleaseIdentityInput): string {
  return digestValue(identity);
}

export async function writeCatalog(outputPath: string): Promise<void> {
  const catalog = buildCatalog();
  assertCatalogInvariants(catalog);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(catalog, undefined, 2)}\n`, 'utf8');
}

if (import.meta.main) {
  const outputPath = fileURLToPath(
    new URL('../../../benchmarks/candidates/aiq-core-1.0.3/catalog.json', import.meta.url),
  );
  await writeCatalog(outputPath);
}
