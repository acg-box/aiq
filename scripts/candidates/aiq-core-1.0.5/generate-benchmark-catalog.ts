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
  'sha256:050ab6937b4e84aad0fc72a3d4489bd2d8dfe70d2bc35d196bd47b5a2cc80d4a';
export const AIQ_CORE_1_0_5_CATALOG_RELEASE_IDENTITY_SHA256 =
  'sha256:6991fb8e25d18d3ac89e946483c87c9cb24af7f59acdef2bed21f8b8090c4037';

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
    title: 'Repair a keyed async executor',
    evaluatorKind: 'async_executor_contract_tests',
    objective:
      'Retarget conditional HTTP fetching to a compact keyed async executor repair with bounded global concurrency, per-key FIFO serialization, work-conserving scheduling, failure recovery, and an explicit idle lifecycle.',
    taskSpecificDelta:
      'Repair one existing executor module. Same-key operations serialize in submission order while eligible work for other keys uses available global capacity without head-of-line blocking. Fulfillment, rejection, and synchronous throws release scheduler state. Strict validation, exact result identity, independent instances, and idle epochs remain observable.',
    summary:
      'Repair a keyed async executor with global concurrency, same-key FIFO, eligible-work scheduling, failure recovery, and a correct idle lifecycle.',
    inputKind: 'single_module_keyed_async_executor_repository',
    passConditions: [
      'Operations for one key execute one at a time in submission order, while operations for different keys can overlap within the configured global limit.',
      'Scheduling starts the earliest eligible queued operation without allowing an active-key entry to block independent work behind it.',
      'Fulfillment, rejection, and synchronous throws preserve exact caller outcomes, release key and capacity state, and allow queued work to continue.',
      'Strict validation, independent executor instances, and idle waiters remain correct across repeated busy and idle epochs.',
    ],
    tags: ['concurrency', 'scheduling'],
  },
  'debugging-01': {
    objective:
      'Retarget UTF-16 ingestion around independent raw-input, decoded-field, and field-count resource boundaries while preserving deterministic decoding behavior.',
    taskSpecificDelta:
      'Require a raw UTF-16 input bound before unbounded processing, decoded limits for each field, and an explicit maximum field count. The controlled evaluator must exercise each resource boundary independently and preserve valid boundary and empty-input behavior without publishing private thresholds.',
    summary:
      'Repair UTF-16 ingestion with bounded raw input, decoded per-field limits, an explicit field-count limit, and preserved valid boundary behavior.',
    inputKind: 'bounded_utf16_record_repository',
    passConditions: [
      'The raw UTF-16 input bound is enforced before unbounded processing.',
      'Every decoded field is subject to the declared per-field resource bound.',
      'The declared field-count limit is enforced independently of byte and decoded-field limits.',
      'Valid boundary, empty, and malformed-input behavior remains deterministic.',
    ],
  },
  'debugging-02': {
    objective:
      'Retarget layered configuration precedence around prototype-safe own-property lookup, null-prototype compatibility, and explicit empty and undefined value semantics.',
    taskSpecificDelta:
      'Require every layer to use own-property membership without inherited-key influence, including objects with null prototypes. Own empty and own undefined values must follow their declared precedence semantics instead of collapsing into absence, while fallback and error attribution remain deterministic.',
    summary:
      'Repair layered configuration precedence with prototype-safe own-property lookup, null-prototype support, and explicit empty and undefined semantics.',
    inputKind: 'prototype_safe_layered_configuration_repository',
    passConditions: [
      'Inherited properties cannot affect layered precedence or selected values.',
      'Ordinary and null-prototype configuration objects follow the same own-property contract.',
      'Own empty, own undefined, and absent properties retain distinct declared semantics.',
      'Fallback, parsing, and source-labelled error behavior remains deterministic.',
    ],
  },
  'debugging-04': {
    objective:
      'Retarget text truncation around grapheme-safe content and ellipsis handling, configurable placement, and deterministic accounting against one display budget.',
    taskSpecificDelta:
      'Require both content and a possibly multi-grapheme ellipsis to preserve grapheme clusters. Support start, middle, and end placement, charge every retained content and ellipsis unit to the declared budget, and define deterministic behavior when the ellipsis alone exceeds that budget.',
    summary:
      'Repair text truncation with grapheme-safe multi-grapheme ellipses, start, middle, and end placement, and deterministic display-budget accounting.',
    inputKind: 'grapheme_budgeted_truncation_repository',
    passConditions: [
      'Retained content and the complete ellipsis preserve declared grapheme clusters.',
      'Start, middle, and end ellipsis placement follows the public contract.',
      'Content and ellipsis units are charged deterministically to one display budget.',
      'Zero, exact-fit, and ellipsis-over-budget cases preserve deterministic behavior.',
    ],
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
    handle: revised ? fixture.handle.replace(/\/v[23]\//u, '/v4/') : fixture.handle,
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
    budget: revised ? { wall_seconds: 600, max_steps: 40, max_tool_calls: 28 } : priorTask.budget,
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
        canonicalJson({ wall_seconds: 600, max_steps: 40, max_tool_calls: 28 })
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
        isRevised ? !handle.includes('/v4/') : handle.includes('/v4/'),
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
