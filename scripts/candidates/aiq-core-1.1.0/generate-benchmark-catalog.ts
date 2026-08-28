import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog as buildPriorCatalog } from '../aiq-core-1.0.7/generate-benchmark-catalog.ts';

const TASK_SET_VERSION = '1.1.0' as const;
const TASK_SCORER_VERSION = '1.0.6' as const;
const GENERATOR_PATH = 'scripts/candidates/aiq-core-1.1.0/generate-benchmark-catalog.ts';
const DECISION_PATH = 'benchmarks/candidates/aiq-core-1.1.0/design-decisions.json';
const CANDIDATE_ID = 'aiq-core/1.1.0-candidate.4' as const;
const PREDECESSOR_CANDIDATE_ID = 'aiq-core/1.1.0-candidate.3' as const;
const PREDECESSOR_REVIEW_SHA256 =
  'sha256:1fcb289cd97d17ce8bed1cb9ec14c2fa3167c56159c180d293b62593dec02bd2' as const;
const PREDECESSOR_REVIEW_RECEIPT_RAW_SHA256 =
  'sha256:000c7d54e67eef9145d3032edb71d80f90a496ba93f98f0d549e451b52a34974' as const;
const PREDECESSOR_COUNTEREXAMPLE_SHA256 =
  'sha256:7d6cc76b149529e2aab7f1c751d84815aa3b044ef4c5ddbab760c7d5c236f903' as const;
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

interface TaskDecision {
  readonly task_id: string;
  readonly decision: Decision;
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
  readonly candidate_2_review: {
    readonly verdict: 'approved' | 'rejected';
    readonly record_sha256: string;
    readonly task_definition_sha256: string;
    readonly catalog_entry_sha256: string;
    readonly issue_codes: readonly IssueCode[];
  };
  readonly candidate_3_contract: {
    readonly construct_id: string;
    readonly response_contract: ResponseContract;
    readonly receipt_contract: Readonly<JsonObject> | null;
    readonly fixture_applicability: TaskDecision['acceptance_fixture_applicability'];
    readonly mechanism_classes: readonly string[];
    readonly falsifiers: readonly string[];
    readonly coverage_claims: readonly string[];
  };
  readonly candidate_3_review: {
    readonly verdict: 'approved' | 'rejected';
    readonly record_sha256: string;
    readonly task_definition_sha256: string;
    readonly catalog_entry_sha256: string;
    readonly issue_codes: readonly IssueCode[];
  };
  readonly candidate_4_contract: {
    readonly construct_id: string;
    readonly response_contract: ResponseContract;
    readonly receipt_contract: Readonly<JsonObject> | null;
    readonly fixture_applicability: TaskDecision['acceptance_fixture_applicability'];
    readonly mechanism_classes: readonly string[];
    readonly falsifiers: readonly string[];
    readonly coverage_claims: readonly string[];
  };
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
const EXPECTED_ISSUE_COUNTS = Object.freeze({
  ACCEPTANCE_SEMANTICS_INVALID: 0,
  BEHAVIORAL_COVERAGE_GAP: 7,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 0,
  HIDDEN_OUTPUT_SCHEMA: 0,
  KEYWORD_ONLY_EVALUATOR: 0,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7,
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
  const receiptContract = decision.candidate_4_contract.receipt_contract;
  if (!isRevisedTaskId(decision.task_id)) return receiptContract === null;
  return (
    receiptContract !== null &&
    receiptContract.required_invocations === REQUIRED_TOOL_INVOCATIONS[decision.task_id]
  );
}

export interface CandidateDecisionManifest {
  readonly schema_version: 'aiq.candidate-design-decisions.v4';
  readonly candidate_id: typeof CANDIDATE_ID;
  readonly candidate_task_set_version: '1.1.0';
  readonly recorded_date: '2026-08-28';
  readonly authority: 'candidate_3_isolated_review_remediation';
  readonly predecessor_candidate: {
    readonly candidate_id: typeof PREDECESSOR_CANDIDATE_ID;
    readonly disposition: 'rejected_nonsealable_predecessor_evidence';
    readonly merge_commit: '613a0eb896a83fb46fa94bcca61d41228126c632';
    readonly change_commit: '4f5c09be7aeb7e1e9e74e3417f943649af2265e2';
    readonly source_tree: 'f16cb16b499fbf942ad0b62344d6146a366fa4bf';
    readonly aggregate_review_sha256: typeof PREDECESSOR_REVIEW_SHA256;
    readonly review_receipt_raw_sha256: typeof PREDECESSOR_REVIEW_RECEIPT_RAW_SHA256;
    readonly skeptical_counterexample_sha256: typeof PREDECESSOR_COUNTEREXAMPLE_SHA256;
    readonly catalog_sha256: string;
    readonly accepted_tasks: 65;
    readonly rejected_tasks: 7;
    readonly semantic_retention_rule: 'only_review_approved_tasks_may_retain_candidate_3_semantics';
  };
  readonly immutable_rejected_predecessors: readonly [
    'aiq-core/1.1.0-candidate.1',
    'aiq-core/1.1.0-candidate.2',
    'aiq-core/1.1.0-candidate.3',
  ];
  readonly retained_candidate_2_issue_closures: {
    readonly candidate_id: 'aiq-core/1.1.0-candidate.2';
    readonly successor_candidate_id: 'aiq-core/1.1.0-candidate.3';
    readonly disposition: 'valid_immutable_predecessor_closures';
    readonly closure_entries: 14;
    readonly issue_code_counts: {
      readonly HIDDEN_OUTPUT_SCHEMA: 7;
      readonly PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7;
    };
  };
  readonly issue_code_counts: Readonly<Record<IssueCode, number>>;
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
  'Do not qualify or publish this candidate until three predeclared complete non-synthetic 17-by-72 matrices pass aiq.benchmark-qualification-policy.v1.',
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
  return {
    shape_kind: stringValue(contract.shape_kind, `${label} shape kind`),
    transport: stringValue(contract.transport, `${label} transport`),
    locations: stringArray(contract.locations, `${label} locations`),
    required_fields: stringArray(contract.required_fields, `${label} required fields`),
    optional_fields: stringArray(contract.optional_fields, `${label} optional fields`),
    field_types: fieldTypes,
    field_semantics: fieldSemantics,
  };
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
      'candidate_2_review',
      'candidate_3_contract',
      'candidate_3_review',
      'candidate_4_contract',
      'cluster_id',
      'decision',
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
  if (selectedDecision !== 'retained' && selectedDecision !== 'revised') {
    throw new TypeError(`decision ${String(index)} kind is invalid.`);
  }

  return {
    task_id: stringValue(decision.task_id, `decision ${String(index)} task_id`),
    decision: selectedDecision,
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
    candidate_2_review: {
      verdict:
        candidateTwoReview.verdict === 'approved'
          ? 'approved'
          : candidateTwoReview.verdict === 'rejected'
            ? 'rejected'
            : (() => {
                throw new TypeError(`${label} candidate.2 review verdict is invalid.`);
              })(),
      record_sha256: digestValueInput(
        candidateTwoReview.record_sha256,
        `${label} candidate.2 review record digest`,
      ),
      task_definition_sha256: digestValueInput(
        candidateTwoReview.task_definition_sha256,
        `${label} candidate.2 task digest`,
      ),
      catalog_entry_sha256: digestValueInput(
        candidateTwoReview.catalog_entry_sha256,
        `${label} candidate.2 catalog-entry digest`,
      ),
      issue_codes: issueCodeArray(
        candidateTwoReview.issue_codes,
        `${label} candidate.2 issue codes`,
      ),
    },
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
    candidate_3_review: {
      verdict:
        candidateThreeReview.verdict === 'approved'
          ? 'approved'
          : candidateThreeReview.verdict === 'rejected'
            ? 'rejected'
            : (() => {
                throw new TypeError(`${label} candidate.3 review verdict is invalid.`);
              })(),
      record_sha256: digestValueInput(
        candidateThreeReview.record_sha256,
        `${label} candidate.3 review record digest`,
      ),
      task_definition_sha256: digestValueInput(
        candidateThreeReview.task_definition_sha256,
        `${label} candidate.3 task digest`,
      ),
      catalog_entry_sha256: digestValueInput(
        candidateThreeReview.catalog_entry_sha256,
        `${label} candidate.3 catalog-entry digest`,
      ),
      issue_codes: issueCodeArray(
        candidateThreeReview.issue_codes,
        `${label} candidate.3 issue codes`,
      ),
    },
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
  };
}

export function parseDecisionManifest(value: unknown): CandidateDecisionManifest {
  const manifest = jsonObject(value, 'candidate decision manifest');
  exactKeys(
    manifest,
    [
      'authority',
      'candidate_id',
      'candidate_task_set_version',
      'decisions',
      'immutable_rejected_predecessors',
      'issue_code_counts',
      'lifecycle',
      'predecessor_candidate',
      'recorded_date',
      'retained_candidate_2_issue_closures',
      'schema_version',
    ],
    'candidate decision manifest',
  );
  const predecessor = jsonObject(manifest.predecessor_candidate, 'predecessor candidate');
  exactKeys(
    predecessor,
    [
      'accepted_tasks',
      'aggregate_review_sha256',
      'candidate_id',
      'catalog_sha256',
      'change_commit',
      'disposition',
      'merge_commit',
      'rejected_tasks',
      'review_receipt_raw_sha256',
      'skeptical_counterexample_sha256',
      'semantic_retention_rule',
      'source_tree',
    ],
    'predecessor candidate',
  );
  const immutableRejectedPredecessors = stringArray(
    manifest.immutable_rejected_predecessors,
    'immutable rejected predecessors',
  );
  const retainedCandidateTwoClosures = jsonObject(
    manifest.retained_candidate_2_issue_closures,
    'retained candidate.2 issue closures',
  );
  exactKeys(
    retainedCandidateTwoClosures,
    [
      'candidate_id',
      'closure_entries',
      'disposition',
      'issue_code_counts',
      'successor_candidate_id',
    ],
    'retained candidate.2 issue closures',
  );
  const retainedCandidateTwoIssueCounts = jsonObject(
    retainedCandidateTwoClosures.issue_code_counts,
    'retained candidate.2 issue-code counts',
  );
  exactKeys(
    retainedCandidateTwoIssueCounts,
    ['HIDDEN_OUTPUT_SCHEMA', 'PUBLIC_PRIVATE_CONSTRUCT_MISMATCH'],
    'retained candidate.2 issue-code counts',
  );
  const counts = jsonObject(manifest.issue_code_counts, 'issue-code counts');
  exactKeys(counts, ISSUE_CODES, 'issue-code counts');
  const issueCodeCounts: Record<IssueCode, number> = {
    ...EXPECTED_ISSUE_COUNTS,
  };
  for (const code of ISSUE_CODES) {
    const count = counts[code];
    if (!Number.isInteger(count) || Number(count) < 0) {
      throw new TypeError(`issue-code count ${code} is invalid.`);
    }
    issueCodeCounts[code] = Number(count);
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
    manifest.schema_version !== 'aiq.candidate-design-decisions.v4' ||
    manifest.candidate_id !== CANDIDATE_ID ||
    manifest.candidate_task_set_version !== TASK_SET_VERSION ||
    manifest.recorded_date !== '2026-08-28' ||
    manifest.authority !== 'candidate_3_isolated_review_remediation' ||
    predecessor.candidate_id !== PREDECESSOR_CANDIDATE_ID ||
    predecessor.disposition !== 'rejected_nonsealable_predecessor_evidence' ||
    predecessor.merge_commit !== '613a0eb896a83fb46fa94bcca61d41228126c632' ||
    predecessor.change_commit !== '4f5c09be7aeb7e1e9e74e3417f943649af2265e2' ||
    predecessor.source_tree !== 'f16cb16b499fbf942ad0b62344d6146a366fa4bf' ||
    predecessor.aggregate_review_sha256 !== PREDECESSOR_REVIEW_SHA256 ||
    predecessor.review_receipt_raw_sha256 !== PREDECESSOR_REVIEW_RECEIPT_RAW_SHA256 ||
    predecessor.skeptical_counterexample_sha256 !== PREDECESSOR_COUNTEREXAMPLE_SHA256 ||
    predecessor.accepted_tasks !== 65 ||
    predecessor.rejected_tasks !== 7 ||
    predecessor.semantic_retention_rule !==
      'only_review_approved_tasks_may_retain_candidate_3_semantics' ||
    JSON.stringify(immutableRejectedPredecessors) !==
      JSON.stringify([
        'aiq-core/1.1.0-candidate.1',
        'aiq-core/1.1.0-candidate.2',
        'aiq-core/1.1.0-candidate.3',
      ]) ||
    retainedCandidateTwoClosures.candidate_id !== 'aiq-core/1.1.0-candidate.2' ||
    retainedCandidateTwoClosures.successor_candidate_id !== 'aiq-core/1.1.0-candidate.3' ||
    retainedCandidateTwoClosures.disposition !== 'valid_immutable_predecessor_closures' ||
    retainedCandidateTwoClosures.closure_entries !== 14 ||
    retainedCandidateTwoIssueCounts.HIDDEN_OUTPUT_SCHEMA !== 7 ||
    retainedCandidateTwoIssueCounts.PUBLIC_PRIVATE_CONSTRUCT_MISMATCH !== 7 ||
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

  return {
    schema_version: 'aiq.candidate-design-decisions.v4',
    candidate_id: CANDIDATE_ID,
    candidate_task_set_version: TASK_SET_VERSION,
    recorded_date: '2026-08-28',
    authority: 'candidate_3_isolated_review_remediation',
    predecessor_candidate: {
      candidate_id: PREDECESSOR_CANDIDATE_ID,
      disposition: 'rejected_nonsealable_predecessor_evidence',
      merge_commit: '613a0eb896a83fb46fa94bcca61d41228126c632',
      change_commit: '4f5c09be7aeb7e1e9e74e3417f943649af2265e2',
      source_tree: 'f16cb16b499fbf942ad0b62344d6146a366fa4bf',
      aggregate_review_sha256: PREDECESSOR_REVIEW_SHA256,
      review_receipt_raw_sha256: PREDECESSOR_REVIEW_RECEIPT_RAW_SHA256,
      skeptical_counterexample_sha256: PREDECESSOR_COUNTEREXAMPLE_SHA256,
      catalog_sha256: digestValueInput(predecessor.catalog_sha256, 'predecessor catalog digest'),
      accepted_tasks: 65,
      rejected_tasks: 7,
      semantic_retention_rule: 'only_review_approved_tasks_may_retain_candidate_3_semantics',
    },
    immutable_rejected_predecessors: [
      'aiq-core/1.1.0-candidate.1',
      'aiq-core/1.1.0-candidate.2',
      'aiq-core/1.1.0-candidate.3',
    ],
    retained_candidate_2_issue_closures: {
      candidate_id: 'aiq-core/1.1.0-candidate.2',
      successor_candidate_id: 'aiq-core/1.1.0-candidate.3',
      disposition: 'valid_immutable_predecessor_closures',
      closure_entries: 14,
      issue_code_counts: {
        HIDDEN_OUTPUT_SCHEMA: 7,
        PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7,
      },
    },
    issue_code_counts: issueCodeCounts,
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
  if (
    manifest.schema_version !== 'aiq.candidate-design-decisions.v4' ||
    manifest.candidate_id !== CANDIDATE_ID ||
    manifest.candidate_task_set_version !== TASK_SET_VERSION ||
    manifest.recorded_date !== '2026-08-28' ||
    manifest.authority !== 'candidate_3_isolated_review_remediation' ||
    manifest.predecessor_candidate.candidate_id !== PREDECESSOR_CANDIDATE_ID ||
    manifest.predecessor_candidate.disposition !== 'rejected_nonsealable_predecessor_evidence' ||
    manifest.predecessor_candidate.aggregate_review_sha256 !== PREDECESSOR_REVIEW_SHA256 ||
    manifest.predecessor_candidate.review_receipt_raw_sha256 !==
      PREDECESSOR_REVIEW_RECEIPT_RAW_SHA256 ||
    manifest.predecessor_candidate.skeptical_counterexample_sha256 !==
      PREDECESSOR_COUNTEREXAMPLE_SHA256 ||
    manifest.retained_candidate_2_issue_closures.closure_entries !== 14 ||
    manifest.predecessor_candidate.accepted_tasks !== 65 ||
    manifest.predecessor_candidate.rejected_tasks !== 7 ||
    ISSUE_CODES.some(
      (issueCode) => manifest.issue_code_counts[issueCode] !== EXPECTED_ISSUE_COUNTS[issueCode],
    ) ||
    manifest.decisions.length !== 72
  ) {
    throw new Error('AIQ Core 1.1.0 decision-manifest authority is invalid.');
  }
  const decisionIds = manifest.decisions.map((decision) => decision.task_id);
  const retained = manifest.decisions.filter((decision) => decision.decision === 'retained');
  const revised = manifest.decisions.filter((decision) => decision.decision === 'revised');
  if (
    new Set(decisionIds).size !== 72 ||
    new Set(manifest.decisions.map((decision) => decision.cluster_id)).size !== 72 ||
    new Set(manifest.decisions.map((decision) => decision.candidate_4_contract.construct_id))
      .size !== 72 ||
    priorTaskIds.length !== 72 ||
    retained.length !== 65 ||
    revised.length !== 7 ||
    JSON.stringify(revised.map((decision) => decision.task_id).toSorted()) !==
      JSON.stringify([...REVISED_TASK_IDS].toSorted()) ||
    decisionIds.some((taskId, index) => taskId !== priorTaskIds[index]) ||
    ISSUE_CODES.some(
      (issueCode) =>
        manifest.decisions.filter((decision) =>
          decision.candidate_3_review.issue_codes.includes(issueCode),
        ).length !== EXPECTED_ISSUE_COUNTS[issueCode],
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
        decision.cluster_id.length === 0 ||
        decision.rationale.length < 160 ||
        (decision.decision === 'retained') !==
          (decision.candidate_3_review.verdict === 'approved') ||
        (decision.decision === 'retained') !==
          (decision.candidate_3_review.issue_codes.length === 0) ||
        (decision.decision === 'retained') !==
          (decision.candidate_2_review.verdict === 'approved') ||
        decision.candidate_3_contract.construct_id.length < 12 ||
        decision.candidate_2_review.issue_codes.some(
          (issueCode) =>
            !decision.candidate_3_contract.mechanism_classes.includes(
              ISSUE_MECHANISMS[issueCode],
            ) || !decision.candidate_3_contract.falsifiers.includes(ISSUE_FALSIFIERS[issueCode]),
        ) ||
        decision.candidate_4_contract.construct_id.length < 12 ||
        decision.candidate_4_contract.response_contract.locations.length === 0 ||
        decision.candidate_4_contract.response_contract.required_fields.length === 0 ||
        decision.candidate_4_contract.response_contract.locations.some(
          (location) => location.startsWith('/') || location.split('/').includes('..'),
        ) ||
        [
          ...decision.candidate_4_contract.response_contract.required_fields,
          ...decision.candidate_4_contract.response_contract.optional_fields,
        ].some(
          (field) =>
            decision.candidate_4_contract.response_contract.field_semantics[field] === undefined ||
            decision.candidate_4_contract.response_contract.field_types[field] === undefined,
        ) ||
        decision.candidate_4_contract.mechanism_classes.length === 0 ||
        decision.candidate_4_contract.falsifiers.length === 0 ||
        decision.candidate_4_contract.coverage_claims.length === 0 ||
        decision.candidate_3_review.issue_codes.some(
          (issueCode) =>
            !decision.candidate_4_contract.mechanism_classes.includes(
              ISSUE_MECHANISMS[issueCode],
            ) || !decision.candidate_4_contract.falsifiers.includes(ISSUE_FALSIFIERS[issueCode]),
        ) ||
        JSON.stringify(decision.acceptance_fixture_applicability) !==
          JSON.stringify(decision.candidate_4_contract.fixture_applicability) ||
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
        (decision.public_task_revision !== null &&
          (decision.public_task_revision.title.length < 8 ||
            decision.public_task_revision.summary.length < 80 ||
            decision.public_task_revision.input_contract_kind.length < 8 ||
            decision.public_task_revision.evaluator_kind.length < 8 ||
            decision.public_task_revision.pass_conditions.length < 3 ||
            decision.public_task_revision.allowed_tools.length === 0 ||
            decision.public_task_revision.tags.length < 2)),
    )
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
    handle: `aiq-acceptance://${taskId}/v6/${fixtureClass.replaceAll('_', '-')}`,
  };
}

function reviseTask(priorValue: unknown, decision: TaskDecision): JsonObject {
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
      decision: decision.decision,
      decision_record: DECISION_PATH,
      kind: 'frozen_candidate_authoring',
      objective:
        'Freeze AIQ Core 1.1.0 candidate.4 after the exact seven candidate.3 tool-use review failures are repaired without changing the active production benchmark.',
      task_specific_delta: decision.rationale,
      candidate_3_review: decision.candidate_3_review,
      candidate_4_contract: decision.candidate_4_contract,
      controlled_corpus_requirements: CONTROLLED_CORPUS_REQUIREMENTS,
    },
    input_contract: {
      ...inputContract,
      kind: revision?.input_contract_kind ?? inputContract.kind,
      fixture_profile: `aiq-fixture://${decision.task_id}/v4`,
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
      origin: 'candidate_3_review_remediation_authoring',
      owner: 'AIQ benchmark maintainers',
      recorded_date: '2026-08-28',
      predecessor_task_version: '1.1.0',
      predecessor_candidate_id: PREDECESSOR_CANDIDATE_ID,
      source: GENERATOR_PATH,
      decision_record: DECISION_PATH,
    },
    leakage_review: {
      status: 'independent_private_review_v2_required',
      owner: 'AIQ benchmark maintainers',
      review_requirement: 'exactly_one_matching_aiq_leakage_review_v2_per_task',
      notes: `${decision.task_id} is candidate.4 source frozen for a fresh independent review. Candidate.3 records are rejected predecessor evidence and do not satisfy this identity; sealing remains blocked until one new supplied review binds this exact task definition and catalog entry.`,
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
    if (decision === undefined) throw new Error(`Decision ${String(index)} is missing.`);
    return reviseTask(task, decision);
  });
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
    title: 'AIQ Core 1.1.0 candidate.4 frozen for independent review',
    status: 'frozen_candidate',
    generated_from: GENERATOR_PATH,
    candidate_identity: {
      candidate_id: CANDIDATE_ID,
      task_metadata_digest: taskMetadataIdentity.digest,
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
        'Candidates.1, .2, and .3 are immutable rejected, permanently non-sealable predecessor evidence. Candidate.4 retains the 65 candidate.3 review-approved task semantics, revises only the seven rejected tool-evidence bindings, and requires a fresh isolated review.',
    },
    candidate_state: {
      identity_state: 'frozen_for_independent_review',
      predecessor_task_set_version: '1.1.0',
      predecessor_candidate: manifest.predecessor_candidate,
      immutable_rejected_predecessors: manifest.immutable_rejected_predecessors,
      retained_candidate_2_issue_closures: manifest.retained_candidate_2_issue_closures,
      decision_record: DECISION_PATH,
      semantic_decision_counts: { retained: 65, revised: 7 },
      issue_closure_counts: manifest.issue_code_counts,
      private_fixture_mapping_reconciled: true,
      private_tasks_authored: true,
      predecessor_review_status: 'complete_rejected_nonsealable',
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
        'Complete one independent aiq.leakage-review.v2 record for every exact task and catalog-entry digest.',
        'Seal the reviewed private corpus twice without changing this frozen candidate identity.',
        'Run three fresh, predeclared, complete non-synthetic 17-by-72 matrices and pass aiq.benchmark-qualification-policy.v1.',
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
  for (const field of ['candidate_identity', 'candidate_state']) {
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
  properties.candidate_state = {
    type: 'object',
    additionalProperties: false,
    required: [
      'identity_state',
      'predecessor_task_set_version',
      'predecessor_candidate',
      'immutable_rejected_predecessors',
      'retained_candidate_2_issue_closures',
      'decision_record',
      'semantic_decision_counts',
      'issue_closure_counts',
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
      retained_candidate_2_issue_closures: {
        const: decisionManifest.retained_candidate_2_issue_closures,
      },
      decision_record: { const: DECISION_PATH },
      semantic_decision_counts: { const: { retained: 65, revised: 7 } },
      issue_closure_counts: { const: decisionManifest.issue_code_counts },
      private_fixture_mapping_reconciled: { const: true },
      private_tasks_authored: { const: true },
      predecessor_review_status: { const: 'complete_rejected_nonsealable' },
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
          '^aiq-acceptance://[a-z0-9-]+-[0-9]{2}/v(?:2|3|4|5|6)/(?:gold|alternate-correct|partial|adversarial-format|empty|timeout)(?![\\s\\S])',
      },
    },
    allOf: [handleCondition],
  };
  const task = jsonObject(definitions.task, 'catalog task');
  const taskProperties = jsonObject(task.properties, 'catalog task properties');
  taskProperties.task_version = { const: TASK_SET_VERSION };
  taskProperties.design_revision = {
    type: 'object',
    additionalProperties: false,
    required: [
      'supersedes_task_version',
      'supersedes_candidate_id',
      'decision',
      'decision_record',
      'kind',
      'objective',
      'task_specific_delta',
      'candidate_3_review',
      'candidate_4_contract',
      'controlled_corpus_requirements',
    ],
    properties: {
      supersedes_task_version: { const: '1.1.0' },
      supersedes_candidate_id: { const: PREDECESSOR_CANDIDATE_ID },
      decision: { enum: ['retained', 'revised'] },
      decision_record: { const: DECISION_PATH },
      kind: { const: 'frozen_candidate_authoring' },
      objective: { type: 'string', minLength: 80 },
      task_specific_delta: { type: 'string', minLength: 160 },
      candidate_3_review: {
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
      candidate_4_contract: {
        type: 'object',
        additionalProperties: false,
        required: [
          'construct_id',
          'response_contract',
          'receipt_contract',
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
                  enum: [
                    'array',
                    'artifact',
                    'boolean',
                    'module',
                    'null',
                    'number',
                    'object',
                    'string',
                  ],
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
    ],
    properties: {
      origin: { const: 'candidate_3_review_remediation_authoring' },
      owner: { const: 'AIQ benchmark maintainers' },
      recorded_date: { const: '2026-08-28' },
      predecessor_task_version: { const: '1.1.0' },
      predecessor_candidate_id: { const: PREDECESSOR_CANDIDATE_ID },
      source: { const: GENERATOR_PATH },
      decision_record: { const: DECISION_PATH },
    },
  };
  const inputContract = jsonObject(taskProperties.input_contract, 'task input contract');
  const inputContractProperties = jsonObject(
    inputContract.properties,
    'task input contract properties',
  );
  inputContractProperties.fixture_profile = {
    type: 'string',
    pattern: '^aiq-fixture://[a-z0-9-]+-[0-9]{2}/v4(?![\\s\\S])',
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
