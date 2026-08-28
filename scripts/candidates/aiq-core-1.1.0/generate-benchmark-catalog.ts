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
const CANDIDATE_ID = 'aiq-core/1.1.0-candidate.2' as const;
const PREDECESSOR_CANDIDATE_ID = 'aiq-core/1.1.0-candidate.1' as const;
const PREDECESSOR_REVIEW_SHA256 =
  'sha256:4420248576150192a516be9ffe9c43a25112a58baf7c4a5519b0db6bca1dac45' as const;

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
  readonly candidate_1_review: {
    readonly verdict: 'approved' | 'rejected';
    readonly record_sha256: string;
    readonly notes_sha256: string;
    readonly task_definition_sha256: string;
    readonly catalog_entry_sha256: string;
    readonly issue_codes: readonly IssueCode[];
  };
  readonly candidate_2_contract: {
    readonly construct_id: string;
    readonly response_contract: ResponseContract;
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
  ACCEPTANCE_SEMANTICS_INVALID: 4,
  BEHAVIORAL_COVERAGE_GAP: 5,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 4,
  HIDDEN_OUTPUT_SCHEMA: 36,
  KEYWORD_ONLY_EVALUATOR: 6,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 25,
  PUBLIC_SEMANTIC_CONTAMINATION: 3,
  TOOL_EVIDENCE_UNBOUND: 7,
} satisfies Readonly<Record<IssueCode, number>>);
const ISSUE_MECHANISMS = Object.freeze({
  ACCEPTANCE_SEMANTICS_INVALID: 'class_specific_semantic_replay',
  BEHAVIORAL_COVERAGE_GAP: 'executable_transition_and_invariant_coverage',
  CROSS_TASK_CONSTRUCT_DUPLICATION: 'unique_construct_redesign',
  HIDDEN_OUTPUT_SCHEMA: 'explicit_response_contract',
  KEYWORD_ONLY_EVALUATOR: 'structured_semantic_evaluation',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'single_construct_binding',
  PUBLIC_SEMANTIC_CONTAMINATION: 'first_principles_private_regeneration',
  TOOL_EVIDENCE_UNBOUND: 'runner_event_and_content_receipt_binding',
} satisfies Readonly<Record<IssueCode, string>>);
const ISSUE_FALSIFIERS = Object.freeze({
  ACCEPTANCE_SEMANTICS_INVALID: 'swap_or_collapse_acceptance_class_outcomes',
  BEHAVIORAL_COVERAGE_GAP: 'remove_one_claimed_transition_or_error_path',
  CROSS_TASK_CONSTRUCT_DUPLICATION: 'force_two_tasks_to_share_one_construct_id',
  HIDDEN_OUTPUT_SCHEMA: 'inject_an_unannounced_required_field',
  KEYWORD_ONLY_EVALUATOR: 'replace_semantic_checks_with_lexical_presence',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'change_private_construct_binding_only',
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

export interface CandidateDecisionManifest {
  readonly schema_version: 'aiq.candidate-design-decisions.v2';
  readonly candidate_id: typeof CANDIDATE_ID;
  readonly candidate_task_set_version: '1.1.0';
  readonly recorded_date: '2026-08-28';
  readonly authority: 'candidate_1_isolated_review_remediation';
  readonly predecessor_candidate: {
    readonly candidate_id: typeof PREDECESSOR_CANDIDATE_ID;
    readonly disposition: 'rejected_nonsealable_superseded_evidence';
    readonly merge_commit: 'c3358404e247be575929e65b8c557b8bfa831889';
    readonly change_commit: '1db9431ef3696c2f377ac741aad70094803d9987';
    readonly source_tree: 'ad6e528adfb3f22597eaa9f32b03bc71e57e34ad';
    readonly aggregate_review_sha256: typeof PREDECESSOR_REVIEW_SHA256;
    readonly catalog_sha256: string;
    readonly accepted_tasks: 20;
    readonly rejected_tasks: 52;
    readonly semantic_retention_rule: 'only_review_approved_tasks_may_retain_candidate_1_semantics';
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
  if (
    observed.length !== expected.length ||
    observed.some((key, index) => key !== expected[index])
  ) {
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
      'candidate_1_review',
      'candidate_2_contract',
      'cluster_id',
      'decision',
      'public_task_revision',
      'rationale',
      'task_id',
    ],
    `decision ${String(index)}`,
  );
  const label = `decision ${String(index)}`;
  const candidateOneReview = jsonObject(decision.candidate_1_review, `${label} candidate.1 review`);
  exactKeys(
    candidateOneReview,
    [
      'catalog_entry_sha256',
      'issue_codes',
      'notes_sha256',
      'record_sha256',
      'task_definition_sha256',
      'verdict',
    ],
    `${label} candidate.1 review`,
  );
  const candidateTwoContract = jsonObject(
    decision.candidate_2_contract,
    `${label} candidate.2 contract`,
  );
  exactKeys(
    candidateTwoContract,
    [
      'construct_id',
      'coverage_claims',
      'falsifiers',
      'fixture_applicability',
      'mechanism_classes',
      'response_contract',
    ],
    `${label} candidate.2 contract`,
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
    candidate_1_review: {
      verdict:
        candidateOneReview.verdict === 'approved'
          ? 'approved'
          : candidateOneReview.verdict === 'rejected'
            ? 'rejected'
            : (() => {
                throw new TypeError(`${label} candidate.1 review verdict is invalid.`);
              })(),
      record_sha256: digestValueInput(
        candidateOneReview.record_sha256,
        `${label} candidate.1 review record digest`,
      ),
      notes_sha256: digestValueInput(
        candidateOneReview.notes_sha256,
        `${label} candidate.1 review notes digest`,
      ),
      task_definition_sha256: digestValueInput(
        candidateOneReview.task_definition_sha256,
        `${label} candidate.1 task digest`,
      ),
      catalog_entry_sha256: digestValueInput(
        candidateOneReview.catalog_entry_sha256,
        `${label} candidate.1 catalog-entry digest`,
      ),
      issue_codes: issueCodeArray(
        candidateOneReview.issue_codes,
        `${label} candidate.1 issue codes`,
      ),
    },
    candidate_2_contract: {
      construct_id: stringValue(
        candidateTwoContract.construct_id,
        `${label} candidate.2 construct id`,
      ),
      response_contract: responseContract(
        candidateTwoContract.response_contract,
        `${label} candidate.2 response contract`,
      ),
      fixture_applicability: fixtureApplicabilityMap(
        candidateTwoContract.fixture_applicability,
        `${label} candidate.2 fixture applicability`,
      ),
      mechanism_classes: stringArray(
        candidateTwoContract.mechanism_classes,
        `${label} candidate.2 mechanism classes`,
      ),
      falsifiers: stringArray(candidateTwoContract.falsifiers, `${label} candidate.2 falsifiers`),
      coverage_claims: stringArray(
        candidateTwoContract.coverage_claims,
        `${label} candidate.2 coverage claims`,
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
      'issue_code_counts',
      'lifecycle',
      'predecessor_candidate',
      'recorded_date',
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
      'semantic_retention_rule',
      'source_tree',
    ],
    'predecessor candidate',
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
    manifest.schema_version !== 'aiq.candidate-design-decisions.v2' ||
    manifest.candidate_id !== CANDIDATE_ID ||
    manifest.candidate_task_set_version !== TASK_SET_VERSION ||
    manifest.recorded_date !== '2026-08-28' ||
    manifest.authority !== 'candidate_1_isolated_review_remediation' ||
    predecessor.candidate_id !== PREDECESSOR_CANDIDATE_ID ||
    predecessor.disposition !== 'rejected_nonsealable_superseded_evidence' ||
    predecessor.merge_commit !== 'c3358404e247be575929e65b8c557b8bfa831889' ||
    predecessor.change_commit !== '1db9431ef3696c2f377ac741aad70094803d9987' ||
    predecessor.source_tree !== 'ad6e528adfb3f22597eaa9f32b03bc71e57e34ad' ||
    predecessor.aggregate_review_sha256 !== PREDECESSOR_REVIEW_SHA256 ||
    predecessor.accepted_tasks !== 20 ||
    predecessor.rejected_tasks !== 52 ||
    predecessor.semantic_retention_rule !==
      'only_review_approved_tasks_may_retain_candidate_1_semantics' ||
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
    schema_version: 'aiq.candidate-design-decisions.v2',
    candidate_id: CANDIDATE_ID,
    candidate_task_set_version: TASK_SET_VERSION,
    recorded_date: '2026-08-28',
    authority: 'candidate_1_isolated_review_remediation',
    predecessor_candidate: {
      candidate_id: PREDECESSOR_CANDIDATE_ID,
      disposition: 'rejected_nonsealable_superseded_evidence',
      merge_commit: 'c3358404e247be575929e65b8c557b8bfa831889',
      change_commit: '1db9431ef3696c2f377ac741aad70094803d9987',
      source_tree: 'ad6e528adfb3f22597eaa9f32b03bc71e57e34ad',
      aggregate_review_sha256: PREDECESSOR_REVIEW_SHA256,
      catalog_sha256: digestValueInput(predecessor.catalog_sha256, 'predecessor catalog digest'),
      accepted_tasks: 20,
      rejected_tasks: 52,
      semantic_retention_rule: 'only_review_approved_tasks_may_retain_candidate_1_semantics',
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
    manifest.schema_version !== 'aiq.candidate-design-decisions.v2' ||
    manifest.candidate_id !== CANDIDATE_ID ||
    manifest.candidate_task_set_version !== TASK_SET_VERSION ||
    manifest.recorded_date !== '2026-08-28' ||
    manifest.authority !== 'candidate_1_isolated_review_remediation' ||
    manifest.predecessor_candidate.candidate_id !== PREDECESSOR_CANDIDATE_ID ||
    manifest.predecessor_candidate.disposition !== 'rejected_nonsealable_superseded_evidence' ||
    manifest.predecessor_candidate.aggregate_review_sha256 !== PREDECESSOR_REVIEW_SHA256 ||
    manifest.predecessor_candidate.accepted_tasks !== 20 ||
    manifest.predecessor_candidate.rejected_tasks !== 52 ||
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
    new Set(manifest.decisions.map((decision) => decision.candidate_2_contract.construct_id))
      .size !== 72 ||
    priorTaskIds.length !== 72 ||
    retained.length !== 20 ||
    revised.length !== 52 ||
    decisionIds.some((taskId, index) => taskId !== priorTaskIds[index]) ||
    ISSUE_CODES.some(
      (issueCode) =>
        manifest.decisions.filter((decision) =>
          decision.candidate_1_review.issue_codes.includes(issueCode),
        ).length !== EXPECTED_ISSUE_COUNTS[issueCode],
    ) ||
    manifest.decisions.some(
      (decision) =>
        !['retained', 'revised'].includes(decision.decision) ||
        decision.cluster_id.length === 0 ||
        decision.rationale.length < 160 ||
        (decision.decision === 'retained') !==
          (decision.candidate_1_review.verdict === 'approved') ||
        (decision.decision === 'retained') !==
          (decision.candidate_1_review.issue_codes.length === 0) ||
        decision.candidate_2_contract.construct_id.length < 12 ||
        decision.candidate_2_contract.response_contract.locations.length === 0 ||
        decision.candidate_2_contract.response_contract.required_fields.length === 0 ||
        decision.candidate_2_contract.response_contract.locations.some(
          (location) => location.startsWith('/') || location.split('/').includes('..'),
        ) ||
        [
          ...decision.candidate_2_contract.response_contract.required_fields,
          ...decision.candidate_2_contract.response_contract.optional_fields,
        ].some(
          (field) =>
            decision.candidate_2_contract.response_contract.field_semantics[field] === undefined ||
            decision.candidate_2_contract.response_contract.field_types[field] === undefined,
        ) ||
        decision.candidate_2_contract.mechanism_classes.length === 0 ||
        decision.candidate_2_contract.falsifiers.length === 0 ||
        decision.candidate_2_contract.coverage_claims.length === 0 ||
        decision.candidate_1_review.issue_codes.some(
          (issueCode) =>
            !decision.candidate_2_contract.mechanism_classes.includes(
              ISSUE_MECHANISMS[issueCode],
            ) || !decision.candidate_2_contract.falsifiers.includes(ISSUE_FALSIFIERS[issueCode]),
        ) ||
        JSON.stringify(decision.acceptance_fixture_applicability) !==
          JSON.stringify(decision.candidate_2_contract.fixture_applicability) ||
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
    handle: `aiq-acceptance://${taskId}/v5/${fixtureClass.replaceAll('_', '-')}`,
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
      supersedes_task_version: '1.0.7',
      supersedes_candidate_id: PREDECESSOR_CANDIDATE_ID,
      decision: decision.decision,
      decision_record: DECISION_PATH,
      kind: 'frozen_candidate_authoring',
      objective:
        'Freeze AIQ Core 1.1.0 candidate.2 after candidate.1 review remediation for a fresh independent review without changing the active production benchmark.',
      task_specific_delta: decision.rationale,
      candidate_1_review: decision.candidate_1_review,
      candidate_2_contract: decision.candidate_2_contract,
      controlled_corpus_requirements: CONTROLLED_CORPUS_REQUIREMENTS,
    },
    input_contract: {
      ...inputContract,
      kind: revision?.input_contract_kind ?? inputContract.kind,
      fixture_profile: `aiq-fixture://${decision.task_id}/v3`,
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
      origin: 'candidate_1_review_remediation_authoring',
      owner: 'AIQ benchmark maintainers',
      recorded_date: '2026-08-28',
      predecessor_task_version: '1.0.7',
      predecessor_candidate_id: PREDECESSOR_CANDIDATE_ID,
      source: GENERATOR_PATH,
      decision_record: DECISION_PATH,
    },
    leakage_review: {
      status: 'independent_private_review_v2_required',
      owner: 'AIQ benchmark maintainers',
      review_requirement: 'exactly_one_matching_aiq_leakage_review_v2_per_task',
      notes: `${decision.task_id} is candidate.2 source frozen for a fresh independent review. Candidate.1 records do not satisfy this identity, and sealing remains blocked until one new supplied review binds this exact task definition and catalog entry.`,
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
    title: 'AIQ Core 1.1.0 candidate.2 frozen for independent review',
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
        'Candidate.1 is rejected, permanently non-sealable evidence. Only its 20 review-approved task semantics may be retained; all 52 rejected tasks require candidate.2 remediation and fresh review.',
    },
    candidate_state: {
      identity_state: 'frozen_for_independent_review',
      predecessor_task_set_version: '1.0.7',
      predecessor_candidate: manifest.predecessor_candidate,
      decision_record: DECISION_PATH,
      semantic_decision_counts: { retained: 20, revised: 52 },
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
        'Seal the reviewed private corpus without changing this frozen candidate identity.',
        'Run three fresh, predeclared, complete non-synthetic 17-by-72 matrices and pass aiq.benchmark-qualification-policy.v1.',
        'Complete separate release adoption and production acceptance before any activation or publication.',
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
      predecessor_task_set_version: { const: '1.0.7' },
      predecessor_candidate: { const: decisionManifest.predecessor_candidate },
      decision_record: { const: DECISION_PATH },
      semantic_decision_counts: { const: { retained: 20, revised: 52 } },
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
          '^aiq-acceptance://[a-z0-9-]+-[0-9]{2}/v(?:2|3|4|5)/(?:gold|alternate-correct|partial|adversarial-format|empty|timeout)(?![\\s\\S])',
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
      'candidate_1_review',
      'candidate_2_contract',
      'controlled_corpus_requirements',
    ],
    properties: {
      supersedes_task_version: { const: '1.0.7' },
      supersedes_candidate_id: { const: PREDECESSOR_CANDIDATE_ID },
      decision: { enum: ['retained', 'revised'] },
      decision_record: { const: DECISION_PATH },
      kind: { const: 'frozen_candidate_authoring' },
      objective: { type: 'string', minLength: 80 },
      task_specific_delta: { type: 'string', minLength: 160 },
      candidate_1_review: {
        type: 'object',
        additionalProperties: false,
        required: [
          'verdict',
          'record_sha256',
          'notes_sha256',
          'task_definition_sha256',
          'catalog_entry_sha256',
          'issue_codes',
        ],
        properties: {
          verdict: { enum: ['approved', 'rejected'] },
          record_sha256: { pattern: '^sha256:[0-9a-f]{64}(?![\\s\\S])', type: 'string' },
          notes_sha256: { pattern: '^sha256:[0-9a-f]{64}(?![\\s\\S])', type: 'string' },
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
      candidate_2_contract: {
        type: 'object',
        additionalProperties: false,
        required: [
          'construct_id',
          'response_contract',
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
      origin: { const: 'candidate_1_review_remediation_authoring' },
      owner: { const: 'AIQ benchmark maintainers' },
      recorded_date: { const: '2026-08-28' },
      predecessor_task_version: { const: '1.0.7' },
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
    pattern: '^aiq-fixture://[a-z0-9-]+-[0-9]{2}/v3(?![\\s\\S])',
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
