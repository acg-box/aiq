import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog as buildPriorCatalog } from '../aiq-core-1.0.4/generate-benchmark-catalog.ts';

// Canonical public-surface generator for AIQ Core 1.0.5. The private prompt,
// fixture, evaluator, and expected-output sources remain outside Git.

const TASK_SET_VERSION = '1.0.5' as const;
const TASK_VERSION = '1.0.5' as const;
const SCORER_VERSION = '1.0.5' as const;
const GENERATOR_PATH = 'scripts/candidates/aiq-core-1.0.5/generate-benchmark-catalog.ts';

export const AIQ_CORE_1_0_5_TASK_METADATA_IDENTITY_SHA256 =
  'sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7';
export const AIQ_CORE_1_0_5_CATALOG_RELEASE_IDENTITY_SHA256 =
  'sha256:496b40f54dc7c3dc92d8880201373344c723001a0570a4debd28e539cfe4030d';

type JsonObject = Record<string, unknown>;
type PriorCatalog = ReturnType<typeof buildPriorCatalog>;
type PriorTask = PriorCatalog['tasks'][number];

interface RevisionSpec {
  readonly title?: string;
  readonly evaluatorKind?: string;
  readonly objective: string;
  readonly taskSpecificDelta: string;
  readonly summary: string;
  readonly inputKind: string;
  readonly passConditions: readonly [string, string, string, string];
  readonly tags?: readonly string[];
}

interface ScoringContract105 {
  readonly aggregation: 'configured_weighted_binary_check_fraction_with_hard_gates';
  readonly check_scoring: 'binary';
  readonly check_weighting: 'nonnegative_integer_weight_per_committed_check';
  readonly weight_source: 'private_content_addressed_evaluator_configuration';
  readonly formula: 'hard_gate_or_structural_failure ? 0 : sum(weight_i * passed_i) / sum(weight_i)';
  readonly denominator_requirement: 'sum_of_positive_check_weights_greater_than_zero';
  readonly hard_gate_definition: 'hard_gate_true_or_check_type_workspace_policy';
  readonly hard_gate_rule: 'any_failed_committed_hard_gate_or_structural_failure_sets_score_to_zero';
  readonly zero_weight_rule: 'only_committed_hard_gates_may_have_zero_weight';
  readonly positive_weight_gate_rule: 'positive_weight_hard_gate_also_participates_in_weighted_fraction_when_all_hard_gates_pass';
  readonly evaluator_error_policy: 'unscored_invalid_evidence';
  readonly attributable_runtime_failure_policy: 'score_zero_as_defined_by_public_runtime_failure_taxonomy';
  readonly outcome_rule: {
    readonly correct: 'score_equals_one';
    readonly partial: 'score_strictly_between_zero_and_one';
    readonly incorrect: 'score_equals_zero';
  };
  readonly rounding: 'no_evaluator_rounding_exact_replay';
  readonly score_range: readonly [0, 1];
  readonly maximum_checks_per_result: 16;
  readonly public_criteria_role: 'coverage_summary_not_weight_partition';
  readonly verification: 'committed_configuration_and_result_checks_are_content_addressed_and_replayed';
}

export type RevisionKind = 'calibration_retargeted' | 'carry_forward';

export interface CatalogTask105 extends Omit<
  PriorTask,
  | 'task_version'
  | 'design_revision'
  | 'input_contract'
  | 'budget'
  | 'evaluator'
  | 'tags'
  | 'provenance'
> {
  readonly task_version: '1.0.5';
  readonly design_revision: {
    readonly supersedes_task_version: '1.0.4';
    readonly kind: RevisionKind;
    readonly objective: string;
    readonly task_specific_delta: string;
    readonly controlled_corpus_requirements: readonly string[];
  };
  readonly input_contract: Omit<PriorTask['input_contract'], 'kind' | 'content_handle'> & {
    readonly kind: string;
    readonly content_handle: string;
  };
  readonly budget: {
    readonly wall_seconds: number;
    readonly max_steps: number;
    readonly max_tool_calls: number;
  };
  readonly evaluator: Omit<
    PriorTask['evaluator'],
    'kind' | 'scorer_version' | 'pass_conditions' | 'scoring_contract'
  > & {
    readonly kind: string;
    readonly scorer_version: '1.0.5';
    readonly pass_conditions: readonly string[];
    readonly scoring_contract: ScoringContract105;
  };
  readonly tags: readonly string[];
  readonly provenance: {
    readonly origin: 'calibration_driven_revision' | 'release_carry_forward';
    readonly owner: 'AIQ benchmark maintainers';
    readonly recorded_date: '2026-08-05';
    readonly predecessor_task_version: '1.0.4';
    readonly source: typeof GENERATOR_PATH;
  };
}

export interface Catalog105 extends Omit<
  PriorCatalog,
  'task_set_version' | 'scoring_version' | 'generated_from' | 'catalog_release_identity' | 'tasks'
> {
  readonly task_set_version: '1.0.5';
  readonly scoring_version: '1.0.5';
  readonly generated_from: typeof GENERATOR_PATH;
  readonly catalog_release_identity: Omit<
    PriorCatalog['catalog_release_identity'],
    'release_identity' | 'scoring_version' | 'task_metadata_identity' | 'digest'
  > & {
    readonly release_identity: 'aiq-core/1.0.5';
    readonly scoring_version: '1.0.5';
    readonly task_metadata_identity: Catalog105['task_metadata_identity'];
    readonly digest: string;
  };
  readonly tasks: readonly CatalogTask105[];
}

const REVISION_SPECS: Readonly<Record<string, RevisionSpec>> = {
  'coding-06': {
    title: 'Repair a bounded keyed async executor',
    evaluatorKind: 'async_executor_contract_tests',
    objective:
      'Repair a bounded keyed async executor with dynamically adjustable global concurrency, per-key FIFO serialization, stable eligible-head priority scheduling, bounded waiting work, AbortSignal-aware queued cancellation, exact close behavior, failure recovery, and explicit idle epochs.',
    taskSpecificDelta:
      'Repair one existing executor module. Same-key operations serialize while priority orders only eligible key heads. Queue capacity, already-aborted and queued-aborted work, exact-key cancellation, and close must interact without preempting active work. Every terminal path must release scheduler state while preserving exact caller values and reasons, independent instances, and repeatable idle epochs.',
    summary:
      'Repair a bounded keyed async executor with per-key FIFO, stable eligible-head scheduling, dynamic concurrency, queue limits, abort and close semantics, failure recovery, and repeatable idle epochs.',
    inputKind: 'bounded_keyed_async_executor_repository',
    passConditions: [
      'Operations for one key execute one at a time in submission order, while operations for different keys can overlap within the configured global limit.',
      'Stable priority scheduling compares only eligible per-key heads, queue capacity is bounded, and runtime concurrency changes do not preempt active work.',
      'AbortSignal, exact-key cancellation, and close reject only the declared waiting work with exact reasons while active work remains non-preemptive.',
      'Strict validation, terminal-path recovery, exact caller outcomes, independent instances, and idle waiters remain correct across repeated epochs.',
    ],
    tags: ['concurrency', 'scheduling'],
  },
  'debugging-01': {
    title: 'Repair a bounded quoted-record parser',
    evaluatorKind: 'quoted_record_contract_tests',
    objective:
      'Repair a bounded quoted-record parser that combines raw and decoded UTF-16 resource limits with a deterministic pipe, quote, and backslash state machine and source-positioned syntax diagnostics.',
    taskSpecificDelta:
      'Require a raw UTF-16 input bound, decoded per-field and total bounds, and a field-count bound. Quoted delimiters, constrained escapes, empty fields, forbidden line breaks, and stable SyntaxError code and index properties must compose without collapsing one resource or parser state into another.',
    summary:
      'Repair a quoted pipe-record parser with independent UTF-16 resource limits, deterministic quote and escape states, empty-field preservation, and source-positioned syntax errors.',
    inputKind: 'bounded_quoted_utf16_record_repository',
    passConditions: [
      'Raw input, decoded per-field, decoded-total, and field-count UTF-16 bounds are enforced independently.',
      'Quoted delimiters and the constrained backslash grammar decode deterministically while leading, internal, and trailing empty fields remain observable.',
      'Invalid escapes, quote-state violations, unterminated quotes, and raw line breaks report stable syntax code and input index evidence.',
      'Valid boundaries, Unicode content, argument validation, and resource interactions remain deterministic without input mutation.',
    ],
  },
  'debugging-02': {
    title: 'Repair a layered service configuration loader',
    objective:
      'Repair a layered service configuration loader that resolves six independently typed values with prototype-safe precedence, explicit empty and undefined semantics, built-in and protocol-derived defaults, normalization, bounds, and exact source provenance.',
    taskSpecificDelta:
      'Require own-property lookup across environment, file, and default layers for host, protocol, port, base path, retries, and timeout. Each field keeps source-specific parsing and errors; built-ins and protocol-derived ports remain distinct. An atomic disable sentinel, null-prototype sources, normalization, immutable inputs, and complete provenance must compose.',
    summary:
      'Repair a six-field layered service configuration loader with own-property precedence, source-specific validation, built-ins, normalization, an atomic disable sentinel, and exact provenance.',
    inputKind: 'layered_service_configuration_repository',
    passConditions: [
      'Inherited properties cannot affect six-field precedence, and ordinary and null-prototype sources follow the same own-property contract.',
      'Own empty, own undefined, absent, built-in, and protocol-derived values retain distinct declared semantics and provenance.',
      'Text normalization, base-path rules, and source-specific integer syntax and bounds are enforced without fallback after selection.',
      'The atomic disable sentinel, complete returned provenance, source-labelled errors, and input immutability remain deterministic.',
    ],
  },
  'debugging-04': {
    title: 'Repair a bounded Unicode log preview',
    evaluatorKind: 'bounded_log_preview_tests',
    objective:
      'Repair a bounded log preview that composes line-ending normalization, head and tail line windows, Unicode grapheme-safe per-line limits, complete ellipsis accounting, and exact omission metadata.',
    taskSpecificDelta:
      'Require CRLF and lone-CR normalization before logical-line selection. Preserve empty logical lines, select a bounded head or tail window, and then truncate retained lines without splitting content or ellipsis graphemes. Distinguish omitted lines from truncated retained lines and define exact zero, fit, and over-budget behavior.',
    summary:
      'Repair a bounded head or tail log preview with normalized line endings, preserved empty lines, grapheme-safe per-line ellipses, and exact omission metadata.',
    inputKind: 'bounded_unicode_log_preview_repository',
    passConditions: [
      'CRLF and lone-CR inputs normalize before head or tail line selection, and empty logical lines remain observable.',
      'Retained content and complete ellipses preserve Unicode grapheme clusters within one declared per-line budget.',
      'Head and tail windows preserve their corresponding line edges while omitted and truncated line counts remain separate.',
      'Zero-line, zero-grapheme, exact-fit, trailing-line, and ellipsis-over-budget cases remain deterministic.',
    ],
    tags: ['unicode', 'logs'],
  },
};

const SCORING_CONTRACT = Object.freeze({
  aggregation: 'configured_weighted_binary_check_fraction_with_hard_gates',
  check_scoring: 'binary',
  check_weighting: 'nonnegative_integer_weight_per_committed_check',
  weight_source: 'private_content_addressed_evaluator_configuration',
  formula: 'hard_gate_or_structural_failure ? 0 : sum(weight_i * passed_i) / sum(weight_i)',
  denominator_requirement: 'sum_of_positive_check_weights_greater_than_zero',
  hard_gate_definition: 'hard_gate_true_or_check_type_workspace_policy',
  hard_gate_rule: 'any_failed_committed_hard_gate_or_structural_failure_sets_score_to_zero',
  zero_weight_rule: 'only_committed_hard_gates_may_have_zero_weight',
  positive_weight_gate_rule:
    'positive_weight_hard_gate_also_participates_in_weighted_fraction_when_all_hard_gates_pass',
  evaluator_error_policy: 'unscored_invalid_evidence',
  attributable_runtime_failure_policy: 'score_zero_as_defined_by_public_runtime_failure_taxonomy',
  outcome_rule: {
    correct: 'score_equals_one',
    partial: 'score_strictly_between_zero_and_one',
    incorrect: 'score_equals_zero',
  },
  rounding: 'no_evaluator_rounding_exact_replay',
  score_range: [0, 1],
  maximum_checks_per_result: 16,
  public_criteria_role: 'coverage_summary_not_weight_partition',
  verification: 'committed_configuration_and_result_checks_are_content_addressed_and_replayed',
} as const satisfies ScoringContract105);

const CONTROLLED_CORPUS_REQUIREMENTS = Object.freeze([
  'Bind every scored check identifier, nonnegative integer weight, type, and hard-gate status in the content-addressed private evaluator configuration.',
  'Exercise correct, alternate-correct, partial, adversarial-format, empty, and timeout fixtures under deterministic exact replay.',
  'Prove that hard-gate and structural failures force zero while other failed checks reduce the score by the committed positive-weight fraction.',
  'Cover the public pass conditions with private checks without treating those criteria as mathematical weight partitions.',
] as const);

export const REVISED_TASK_IDS = Object.freeze(Object.keys(REVISION_SPECS).toSorted());

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

function replaceReleaseStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('1\\.0\\.4', '1\\.0\\.5')
      .replaceAll('aiq-core-1.0.4', 'aiq-core-1.0.5')
      .replaceAll('aiq-core@1.0.4', 'aiq-core@1.0.5')
      .replaceAll('aiq-core/1.0.4', 'aiq-core/1.0.5')
      .replaceAll('1.0.4', '1.0.5');
  }
  if (Array.isArray(value)) return value.map(replaceReleaseStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceReleaseStrings(child)]),
    );
  }
  return value;
}

function carriedForwardDelta(taskId: string): string {
  return `${taskId} explicitly carries forward the accepted AIQ Core 1.0.4 public design and byte-equivalent private task, fixture, and evaluator contracts. AIQ Core 1.0.5 advances only the release, task, scorer, controlled-reference, provenance, and commitment bindings.`;
}

type AcceptanceFixtureCommitment = PriorTask['evaluator']['acceptance_fixture_commitments']['gold'];

function reviseAcceptanceFixtureCommitment(
  fixture: AcceptanceFixtureCommitment,
  revised: boolean,
): AcceptanceFixtureCommitment {
  return {
    ...fixture,
    handle: revised ? fixture.handle.replace(/\/v[234]\//u, '/v5/') : fixture.handle,
  };
}

function reviseTask(priorTask: PriorTask): CatalogTask105 {
  const spec = REVISION_SPECS[priorTask.task_id];
  const revised = spec !== undefined;
  const passConditions = spec?.passConditions ?? priorTask.evaluator.pass_conditions;
  const priorCommitments = priorTask.evaluator.acceptance_fixture_commitments;
  const acceptanceFixtureCommitments = {
    gold: reviseAcceptanceFixtureCommitment(priorCommitments.gold, revised),
    alternate_correct: reviseAcceptanceFixtureCommitment(
      priorCommitments.alternate_correct,
      revised,
    ),
    partial: reviseAcceptanceFixtureCommitment(priorCommitments.partial, revised),
    adversarial_format: reviseAcceptanceFixtureCommitment(
      priorCommitments.adversarial_format,
      revised,
    ),
    empty: reviseAcceptanceFixtureCommitment(priorCommitments.empty, revised),
    timeout: reviseAcceptanceFixtureCommitment(priorCommitments.timeout, revised),
  } satisfies CatalogTask105['evaluator']['acceptance_fixture_commitments'];

  return {
    task_id: priorTask.task_id,
    task_version: TASK_VERSION,
    title: spec?.title ?? priorTask.title,
    domain: priorTask.domain,
    difficulty: priorTask.difficulty,
    summary: spec?.summary ?? priorTask.summary,
    design_revision: {
      supersedes_task_version: '1.0.4',
      kind: spec === undefined ? 'carry_forward' : 'calibration_retargeted',
      objective:
        spec?.objective ??
        'Explicitly carry forward the accepted AIQ Core 1.0.4 public design and byte-equivalent private task, fixture, and evaluator contracts while advancing the complete release identity and controlled bindings to AIQ Core 1.0.5.',
      task_specific_delta: spec?.taskSpecificDelta ?? carriedForwardDelta(priorTask.task_id),
      controlled_corpus_requirements: CONTROLLED_CORPUS_REQUIREMENTS,
    },
    input_contract: {
      ...priorTask.input_contract,
      kind: spec?.inputKind ?? priorTask.input_contract.kind,
      content_handle: priorTask.input_contract.content_handle.replace(
        'aiq-core/1.0.4',
        'aiq-core/1.0.5',
      ),
    },
    cluster_id: priorTask.cluster_id,
    allowed_tools: priorTask.allowed_tools,
    budget: revised ? { wall_seconds: 900, max_steps: 40, max_tool_calls: 28 } : priorTask.budget,
    evaluator: {
      kind: spec?.evaluatorKind ?? priorTask.evaluator.kind,
      scorer_version: SCORER_VERSION,
      execution_protocol: priorTask.evaluator.execution_protocol,
      binding_requirement: priorTask.evaluator.binding_requirement,
      deterministic: priorTask.evaluator.deterministic,
      partial_credit: priorTask.evaluator.partial_credit,
      pass_conditions: passConditions,
      scoring_contract: SCORING_CONTRACT,
      acceptance_fixture_commitments: acceptanceFixtureCommitments,
    },
    tags: spec?.tags ?? priorTask.tags,
    visibility: priorTask.visibility,
    provenance: {
      origin: spec === undefined ? 'release_carry_forward' : 'calibration_driven_revision',
      owner: 'AIQ benchmark maintainers',
      recorded_date: '2026-08-05',
      predecessor_task_version: '1.0.4',
      source: GENERATOR_PATH,
    },
    leakage_review: {
      ...priorTask.leakage_review,
      notes: `${priorTask.task_id} publishes only its versioned public design and scorer contract. Its private prompt, fixture, expected outputs, executable checks, and leakage evidence must bind this exact AIQ Core 1.0.5 catalog entry outside Git.`,
    },
  };
}

export function taskMetadataIdentityDigest(tasks: readonly CatalogTask105[]): string {
  return digestValue(tasks);
}

export function catalogReleaseIdentityDigest(
  identity: Catalog105['catalog_release_identity'],
): string {
  const {
    algorithm: _algorithm,
    canonicalization: _canonicalization,
    digest: _digest,
    scope: _scope,
    ...input
  } = identity;
  return digestValue(input);
}

export function buildCatalog(): Catalog105 {
  const prior = buildPriorCatalog();
  const tasks = prior.tasks.map(reviseTask);
  const taskMetadataIdentity = {
    ...prior.task_metadata_identity,
    digest: taskMetadataIdentityDigest(tasks),
  };
  const releaseIdentityInput = {
    release_identity: 'aiq-core/1.0.5' as const,
    scoring_version: SCORER_VERSION,
    task_metadata_identity: taskMetadataIdentity,
  };

  return {
    ...prior,
    task_set_version: TASK_SET_VERSION,
    scoring_version: SCORER_VERSION,
    title: 'AIQ Core 1.0.5',
    generated_from: GENERATOR_PATH,
    task_metadata_identity: taskMetadataIdentity,
    catalog_release_identity: {
      ...releaseIdentityInput,
      algorithm: 'sha256',
      canonicalization: 'aiq.sorted-key-json.v1',
      digest: digestValue(releaseIdentityInput),
      scope: 'release_identity_scoring_version_and_ordered_task_metadata_identity',
    },
    tasks,
  };
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reviseCatalogSchema(priorSchema: unknown): unknown {
  const schema = replaceReleaseStrings(priorSchema);
  const root = jsonObject(schema, 'catalog schema');
  const definitions = jsonObject(root.$defs, 'catalog schema definitions');
  const task = jsonObject(definitions.task, 'catalog task definition');
  const taskProperties = jsonObject(task.properties, 'catalog task properties');
  const designRevision = jsonObject(taskProperties.design_revision, 'design revision');
  const designProperties = jsonObject(designRevision.properties, 'design revision properties');
  designProperties.supersedes_task_version = { const: '1.0.4' };
  designProperties.kind = {
    enum: ['calibration_retargeted', 'carry_forward'],
  };
  const provenance = jsonObject(taskProperties.provenance, 'provenance');
  const provenanceProperties = jsonObject(provenance.properties, 'provenance properties');
  const evaluator = jsonObject(taskProperties.evaluator, 'evaluator');
  const evaluatorProperties = jsonObject(evaluator.properties, 'evaluator properties');
  const acceptanceFixtureCommitment = jsonObject(
    definitions.acceptanceFixtureCommitment,
    'acceptance fixture commitment',
  );
  const acceptanceFixtureProperties = jsonObject(
    acceptanceFixtureCommitment.properties,
    'acceptance fixture commitment properties',
  );
  provenanceProperties.origin = {
    enum: ['calibration_driven_revision', 'release_carry_forward'],
  };
  provenanceProperties.recorded_date = { const: '2026-08-05' };
  provenanceProperties.predecessor_task_version = { const: '1.0.4' };
  provenanceProperties.source = { const: GENERATOR_PATH };
  acceptanceFixtureProperties.handle = {
    type: 'string',
    pattern:
      '^aiq-acceptance://[a-z0-9-]+-[0-9]{2}/v(?:2|3|4)/(?:gold|alternate-correct|partial|adversarial-format|empty|timeout)(?![\\s\\S])',
  };
  evaluatorProperties.scoring_contract = {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(SCORING_CONTRACT),
    properties: Object.fromEntries(
      Object.entries(SCORING_CONTRACT).map(([key, value]) => [
        key,
        Array.isArray(value)
          ? {
              type: 'array',
              prefixItems: value.map((item: unknown) => ({ const: item })),
              minItems: value.length,
              maxItems: value.length,
            }
          : { const: value },
      ]),
    ),
  };
  return schema;
}

export function assertCatalogInvariants(catalog: Catalog105): void {
  if (
    catalog.task_set_version !== TASK_SET_VERSION ||
    catalog.scoring_version !== SCORER_VERSION ||
    catalog.generated_from !== GENERATOR_PATH ||
    catalog.tasks.length !== 72
  ) {
    throw new Error('AIQ Core 1.0.5 release identity or cardinality is invalid.');
  }
  const taskIds = new Set(catalog.tasks.map(({ task_id }) => task_id));
  if (taskIds.size !== 72 || REVISED_TASK_IDS.some((taskId) => !taskIds.has(taskId))) {
    throw new Error('AIQ Core 1.0.5 task identity is incomplete.');
  }
  const retargeted = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'calibration_retargeted',
  );
  const carriedForward = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'carry_forward',
  );
  if (retargeted.length !== 4 || carriedForward.length !== 68) {
    throw new Error(
      'AIQ Core 1.0.5 must contain four calibration-retargeted and 68 carry-forward tasks.',
    );
  }
  for (const task of catalog.tasks) {
    const isRevised = REVISED_TASK_IDS.includes(task.task_id);
    const expectedKind = isRevised ? 'calibration_retargeted' : 'carry_forward';
    const expectedOrigin = isRevised ? 'calibration_driven_revision' : 'release_carry_forward';
    if (
      task.task_version !== TASK_VERSION ||
      task.evaluator.scorer_version !== SCORER_VERSION ||
      task.design_revision.supersedes_task_version !== '1.0.4' ||
      task.provenance.predecessor_task_version !== '1.0.4' ||
      task.provenance.source !== GENERATOR_PATH ||
      task.design_revision.kind !== expectedKind ||
      task.provenance.origin !== expectedOrigin
    ) {
      throw new Error(`Task ${task.task_id} has inconsistent revision metadata.`);
    }
    if (
      !task.input_contract.content_handle.includes('/1.0.5/') ||
      task.evaluator.pass_conditions.length < 4 ||
      task.evaluator.scoring_contract.aggregation !== SCORING_CONTRACT.aggregation ||
      task.evaluator.scoring_contract.formula !== SCORING_CONTRACT.formula ||
      task.evaluator.scoring_contract.public_criteria_role !==
        'coverage_summary_not_weight_partition' ||
      task.design_revision.controlled_corpus_requirements.join('\n') !==
        CONTROLLED_CORPUS_REQUIREMENTS.join('\n')
    ) {
      throw new Error(`Task ${task.task_id} has inconsistent public scoring metadata.`);
    }
    if (
      isRevised &&
      canonicalJson(task.budget) !==
        canonicalJson({ wall_seconds: 900, max_steps: 40, max_tool_calls: 28 })
    ) {
      throw new Error(`Task ${task.task_id} has an inconsistent calibration budget.`);
    }
    if (
      task.task_id === 'coding-06' &&
      (task.evaluator.kind !== 'async_executor_contract_tests' ||
        canonicalJson(task.tags) !== canonicalJson(['concurrency', 'scheduling']))
    ) {
      throw new Error('Task coding-06 has stale evaluator or taxonomy metadata.');
    }
    const acceptanceHandles = Object.values(task.evaluator.acceptance_fixture_commitments).map(
      ({ handle }) => handle,
    );
    if (
      acceptanceHandles.some((handle) =>
        isRevised ? !handle.includes('/v5/') : handle.includes('/v5/'),
      )
    ) {
      throw new Error(`Task ${task.task_id} has inconsistent acceptance handles.`);
    }
  }

  const observedTaskIdentity = taskMetadataIdentityDigest(catalog.tasks);
  if (catalog.task_metadata_identity.digest !== observedTaskIdentity) {
    throw new Error('AIQ Core 1.0.5 task metadata identity is stale.');
  }
  const observedReleaseIdentity = catalogReleaseIdentityDigest(catalog.catalog_release_identity);
  if (catalog.catalog_release_identity.digest !== observedReleaseIdentity) {
    throw new Error('AIQ Core 1.0.5 release identity is stale.');
  }
  if (observedTaskIdentity !== AIQ_CORE_1_0_5_TASK_METADATA_IDENTITY_SHA256) {
    throw new Error(`AIQ Core 1.0.5 task metadata identity changed: ${observedTaskIdentity}.`);
  }
  if (observedReleaseIdentity !== AIQ_CORE_1_0_5_CATALOG_RELEASE_IDENTITY_SHA256) {
    throw new Error(`AIQ Core 1.0.5 release identity changed: ${observedReleaseIdentity}.`);
  }
}

async function readPriorSchema(name: string): Promise<unknown> {
  const path = fileURLToPath(
    new URL(`../../../benchmarks/candidates/aiq-core-1.0.4/${name}`, import.meta.url),
  );
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function writeCandidate(outputDirectory: string): Promise<void> {
  const catalog = buildCatalog();
  assertCatalogInvariants(catalog);
  const catalogSchema = reviseCatalogSchema(await readPriorSchema('catalog.schema.json'));
  const taskSchema = replaceReleaseStrings(await readPriorSchema('task.schema.json'));
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
      new URL('../../../benchmarks/candidates/aiq-core-1.0.5/catalog.json', import.meta.url),
    ),
  );
  const catalog = buildCatalog();
  await writeCandidate(outputDirectory);
  process.stdout.write(
    `${JSON.stringify({
      catalog_release_identity_sha256: catalog.catalog_release_identity.digest,
      task_metadata_identity_sha256: catalog.task_metadata_identity.digest,
    })}\n`,
  );
}
