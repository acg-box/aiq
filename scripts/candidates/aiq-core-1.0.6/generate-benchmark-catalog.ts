import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog as buildPriorCatalog } from '../aiq-core-1.0.5/generate-benchmark-catalog.ts';

// Canonical public-surface generator for AIQ Core 1.0.6. The private prompt,
// fixture, evaluator, and expected-output sources remain outside Git.

const TASK_SET_VERSION = '1.0.6' as const;
const TASK_VERSION = '1.0.6' as const;
const SCORER_VERSION = '1.0.6' as const;
const GENERATOR_PATH = 'scripts/candidates/aiq-core-1.0.6/generate-benchmark-catalog.ts';

export const AIQ_CORE_1_0_6_TASK_METADATA_IDENTITY_SHA256 =
  'sha256:6dc43022b04333de889abc08de118d63652aeab6ee2c3b8610905a2faa91e460';
export const AIQ_CORE_1_0_6_CATALOG_RELEASE_IDENTITY_SHA256 =
  'sha256:fb2a1e088def5e88434ef383e92e0201b406d556c261e294c9ae86ea9bf3ae78';

type JsonObject = Record<string, unknown>;
type PriorCatalog = ReturnType<typeof buildPriorCatalog>;
type PriorTask = PriorCatalog['tasks'][number];

interface ScoringContract106 {
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
  readonly attributable_runtime_failure_policy: 'task_score_null_excluded_from_semantic_scoring';
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

export type RevisionKind = 'runtime_budget_revision' | 'carry_forward';

export interface CatalogTask106 extends Omit<
  PriorTask,
  | 'task_version'
  | 'design_revision'
  | 'input_contract'
  | 'budget'
  | 'evaluator'
  | 'tags'
  | 'provenance'
> {
  readonly task_version: '1.0.6';
  readonly design_revision: {
    readonly supersedes_task_version: '1.0.5';
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
    readonly scorer_version: '1.0.6';
    readonly pass_conditions: readonly string[];
    readonly scoring_contract: ScoringContract106;
  };
  readonly tags: readonly string[];
  readonly provenance: {
    readonly origin: 'runtime_budget_revision' | 'release_carry_forward';
    readonly owner: 'AIQ benchmark maintainers';
    readonly recorded_date: '2026-08-08';
    readonly predecessor_task_version: '1.0.5';
    readonly source: typeof GENERATOR_PATH;
  };
}

export interface Catalog106 extends Omit<
  PriorCatalog,
  'task_set_version' | 'scoring_version' | 'generated_from' | 'catalog_release_identity' | 'tasks'
> {
  readonly task_set_version: '1.0.6';
  readonly scoring_version: '1.0.6';
  readonly generated_from: typeof GENERATOR_PATH;
  readonly catalog_release_identity: Omit<
    PriorCatalog['catalog_release_identity'],
    'release_identity' | 'scoring_version' | 'task_metadata_identity' | 'digest'
  > & {
    readonly release_identity: 'aiq-core/1.0.6';
    readonly scoring_version: '1.0.6';
    readonly task_metadata_identity: Catalog106['task_metadata_identity'];
    readonly digest: string;
  };
  readonly tasks: readonly CatalogTask106[];
}

const RUNTIME_BUDGET_TASK_IDS = Object.freeze([
  'coding-06',
  'coding-07',
  'debugging-01',
  'debugging-02',
  'debugging-04',
] as const);

type TaskBudget = CatalogTask106['budget'];

const CODING_07_RUNTIME_BUDGET = Object.freeze({
  wall_seconds: 600,
  max_steps: 32,
  max_tool_calls: 21,
} satisfies TaskBudget);

const DEBUGGING_02_RUNTIME_BUDGET = Object.freeze({
  wall_seconds: 1800,
  max_steps: 64,
  max_tool_calls: 56,
} satisfies TaskBudget);

function runtimeBudgetFor(task: PriorTask): TaskBudget {
  if (task.task_id === 'coding-07') return CODING_07_RUNTIME_BUDGET;
  if (task.task_id === 'debugging-02') return DEBUGGING_02_RUNTIME_BUDGET;
  return { wall_seconds: 1500, max_steps: 48, max_tool_calls: 40 };
}

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
  attributable_runtime_failure_policy: 'task_score_null_excluded_from_semantic_scoring',
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
} as const satisfies ScoringContract106);

const CONTROLLED_CORPUS_REQUIREMENTS = Object.freeze([
  'Bind every scored check identifier, nonnegative integer weight, type, and hard-gate status in the content-addressed private evaluator configuration.',
  'Exercise correct, alternate-correct, partial, adversarial-format, empty, and timeout fixtures under deterministic exact replay.',
  'Prove that hard-gate and structural failures force zero while other failed checks reduce the score by the committed positive-weight fraction.',
  'Cover the public pass conditions with private checks without treating those criteria as mathematical weight partitions.',
] as const);

export const REVISED_TASK_IDS = RUNTIME_BUDGET_TASK_IDS;

function isRuntimeBudgetTaskId(taskId: string): boolean {
  return REVISED_TASK_IDS.some((revisedTaskId) => revisedTaskId === taskId);
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

function replaceReleaseStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('1\\.0\\.5', '1\\.0\\.6')
      .replaceAll('aiq-core-1.0.5', 'aiq-core-1.0.6')
      .replaceAll('aiq-core@1.0.5', 'aiq-core@1.0.6')
      .replaceAll('aiq-core/1.0.5', 'aiq-core/1.0.6')
      .replaceAll('1.0.5', '1.0.6');
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
  return `${taskId} carries forward the accepted AIQ Core 1.0.5 task, fixture, evaluator, tool, and runtime-budget contract. AIQ Core 1.0.6 advances only the release, scorer, controlled-reference, provenance, and commitment bindings for this task.`;
}

function runtimeBudgetDelta(task: PriorTask, budget: TaskBudget): string {
  const unchangedLimits =
    task.budget.max_steps === budget.max_steps &&
    task.budget.max_tool_calls === budget.max_tool_calls;
  const limitChange = unchangedLimits
    ? `Its common per-task runtime envelope changes from ${task.budget.wall_seconds} wall seconds to ${budget.wall_seconds} wall seconds while retaining ${budget.max_steps} steps and ${budget.max_tool_calls} tool calls.`
    : `Its common per-task runtime envelope changes from ${task.budget.wall_seconds} wall seconds, ${task.budget.max_steps} steps, and ${task.budget.max_tool_calls} tool calls to ${budget.wall_seconds} wall seconds, ${budget.max_steps} steps, and ${budget.max_tool_calls} tool calls.`;
  const evidence =
    task.task_id === 'coding-07'
      ? 'Two independent Sol ultra attempts at the prior 420-second wall limit timed out, including a jobs=1 attempt; the other 16 configurations completed at or below 363.664 seconds. The 600-second limit is one common task budget for all configurations, not a model-specific exception.'
      : task.task_id === 'debugging-02'
        ? 'The r11 five-task pilot stopped on a debugging-02 runtime failure after 1,060.042 seconds at 47/48 steps and 41/40 tool calls. The new 1,800-second, 64-step, 56-call envelope gives bounded headroom in every observed dimension: 20% wall, 33% steps, and 40% calls, uniformly for all 17 configurations. coding-06 reached 93.2% of its wall ceiling and debugging-01 reached 91.7% of its step and 95% of its call ceilings without a runtime failure; those envelopes remain unchanged and must be falsified by the complete next 17-by-5 pilot.'
      : 'The prior 17-by-4 pilot observed seven timeouts and three tool-budget failures at the old bounds.';
  return `${task.task_id} preserves the accepted AIQ Core 1.0.5 prompt, fixture, evaluator, tools, and semantic scoring contract. ${limitChange} ${evidence}`;
}

function reviseTask(priorTask: PriorTask): CatalogTask106 {
  const revised = isRuntimeBudgetTaskId(priorTask.task_id);
  const budget = revised ? runtimeBudgetFor(priorTask) : priorTask.budget;

  return {
    task_id: priorTask.task_id,
    task_version: TASK_VERSION,
    title: priorTask.title,
    domain: priorTask.domain,
    difficulty: priorTask.difficulty,
    summary: priorTask.summary,
    design_revision: {
      supersedes_task_version: '1.0.5',
      kind: revised ? 'runtime_budget_revision' : 'carry_forward',
      objective: revised
        ? 'Preserve the accepted AIQ Core 1.0.5 task and evaluator semantics while giving every model configuration the same empirically increased runtime envelope.'
        : 'Carry forward the accepted AIQ Core 1.0.5 task, evaluator, and runtime-budget contract while advancing the complete release identity and controlled bindings to AIQ Core 1.0.6.',
      task_specific_delta: revised
        ? runtimeBudgetDelta(priorTask, budget)
        : carriedForwardDelta(priorTask.task_id),
      controlled_corpus_requirements: CONTROLLED_CORPUS_REQUIREMENTS,
    },
    input_contract: {
      ...priorTask.input_contract,
      kind: priorTask.input_contract.kind,
      content_handle: priorTask.input_contract.content_handle.replace(
        'aiq-core/1.0.5',
        'aiq-core/1.0.6',
      ),
    },
    cluster_id: priorTask.cluster_id,
    allowed_tools: priorTask.allowed_tools,
    budget,
    evaluator: {
      kind: priorTask.evaluator.kind,
      scorer_version: SCORER_VERSION,
      execution_protocol: priorTask.evaluator.execution_protocol,
      binding_requirement: priorTask.evaluator.binding_requirement,
      deterministic: priorTask.evaluator.deterministic,
      partial_credit: priorTask.evaluator.partial_credit,
      pass_conditions: priorTask.evaluator.pass_conditions,
      scoring_contract: SCORING_CONTRACT,
      acceptance_fixture_commitments: priorTask.evaluator.acceptance_fixture_commitments,
    },
    tags: priorTask.tags,
    visibility: priorTask.visibility,
    provenance: {
      origin: revised ? 'runtime_budget_revision' : 'release_carry_forward',
      owner: 'AIQ benchmark maintainers',
      recorded_date: '2026-08-08',
      predecessor_task_version: '1.0.5',
      source: GENERATOR_PATH,
    },
    leakage_review: {
      ...priorTask.leakage_review,
      notes: `${priorTask.task_id} publishes only its versioned public design and scorer contract. Its private prompt, fixture, expected outputs, executable checks, and leakage evidence must bind this exact AIQ Core 1.0.6 catalog entry outside Git.`,
    },
  };
}

export function taskMetadataIdentityDigest(tasks: readonly CatalogTask106[]): string {
  return digestValue(tasks);
}

export function catalogReleaseIdentityDigest(
  identity: Catalog106['catalog_release_identity'],
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

export function buildCatalog(): Catalog106 {
  const prior = buildPriorCatalog();
  const tasks = prior.tasks.map(reviseTask);
  const taskMetadataIdentity = {
    ...prior.task_metadata_identity,
    digest: taskMetadataIdentityDigest(tasks),
  };
  const releaseIdentityInput = {
    release_identity: 'aiq-core/1.0.6' as const,
    scoring_version: SCORER_VERSION,
    task_metadata_identity: taskMetadataIdentity,
  };

  return {
    ...prior,
    task_set_version: TASK_SET_VERSION,
    scoring_version: SCORER_VERSION,
    title: 'AIQ Core 1.0.6',
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
  designProperties.supersedes_task_version = { const: '1.0.5' };
  designProperties.kind = {
    enum: ['runtime_budget_revision', 'carry_forward'],
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
    enum: ['runtime_budget_revision', 'release_carry_forward'],
  };
  provenanceProperties.recorded_date = { const: '2026-08-08' };
  provenanceProperties.predecessor_task_version = { const: '1.0.5' };
  provenanceProperties.source = { const: GENERATOR_PATH };
  acceptanceFixtureProperties.handle = {
    type: 'string',
    pattern:
      '^aiq-acceptance://[a-z0-9-]+-[0-9]{2}/v(?:2|3|4|5)/(?:gold|alternate-correct|partial|adversarial-format|empty|timeout)(?![\\s\\S])',
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

export function assertCatalogInvariants(catalog: Catalog106): void {
  if (
    catalog.task_set_version !== TASK_SET_VERSION ||
    catalog.scoring_version !== SCORER_VERSION ||
    catalog.generated_from !== GENERATOR_PATH ||
    catalog.tasks.length !== 72
  ) {
    throw new Error('AIQ Core 1.0.6 release identity or cardinality is invalid.');
  }
  const taskIds = new Set(catalog.tasks.map(({ task_id }) => task_id));
  if (taskIds.size !== 72 || REVISED_TASK_IDS.some((taskId) => !taskIds.has(taskId))) {
    throw new Error('AIQ Core 1.0.6 task identity is incomplete.');
  }
  const budgetRevised = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'runtime_budget_revision',
  );
  const carriedForward = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'carry_forward',
  );
  if (budgetRevised.length !== 5 || carriedForward.length !== 67) {
    throw new Error(
      'AIQ Core 1.0.6 must contain five runtime-budget revisions and 67 carry-forward tasks.',
    );
  }
  for (const task of catalog.tasks) {
    const isRevised = isRuntimeBudgetTaskId(task.task_id);
    const expectedKind = isRevised ? 'runtime_budget_revision' : 'carry_forward';
    const expectedOrigin = isRevised ? 'runtime_budget_revision' : 'release_carry_forward';
    if (
      task.task_version !== TASK_VERSION ||
      task.evaluator.scorer_version !== SCORER_VERSION ||
      task.design_revision.supersedes_task_version !== '1.0.5' ||
      task.provenance.predecessor_task_version !== '1.0.5' ||
      task.provenance.source !== GENERATOR_PATH ||
      task.design_revision.kind !== expectedKind ||
      task.provenance.origin !== expectedOrigin
    ) {
      throw new Error(`Task ${task.task_id} has inconsistent revision metadata.`);
    }
    if (
      !task.input_contract.content_handle.includes('/1.0.6/') ||
      task.evaluator.pass_conditions.length < 4 ||
      task.evaluator.scoring_contract.aggregation !== SCORING_CONTRACT.aggregation ||
      task.evaluator.scoring_contract.formula !== SCORING_CONTRACT.formula ||
      task.evaluator.scoring_contract.attributable_runtime_failure_policy !==
        SCORING_CONTRACT.attributable_runtime_failure_policy ||
      task.evaluator.scoring_contract.public_criteria_role !==
        'coverage_summary_not_weight_partition' ||
      task.design_revision.controlled_corpus_requirements.join('\n') !==
        CONTROLLED_CORPUS_REQUIREMENTS.join('\n')
    ) {
      throw new Error(`Task ${task.task_id} has inconsistent public scoring metadata.`);
    }
    if (isRevised && canonicalJson(task.budget) !== canonicalJson(runtimeBudgetFor(task))) {
      throw new Error(`Task ${task.task_id} has an inconsistent calibration budget.`);
    }
  }

  const observedTaskIdentity = taskMetadataIdentityDigest(catalog.tasks);
  if (catalog.task_metadata_identity.digest !== observedTaskIdentity) {
    throw new Error('AIQ Core 1.0.6 task metadata identity is stale.');
  }
  const observedReleaseIdentity = catalogReleaseIdentityDigest(catalog.catalog_release_identity);
  if (catalog.catalog_release_identity.digest !== observedReleaseIdentity) {
    throw new Error('AIQ Core 1.0.6 release identity is stale.');
  }
  if (observedTaskIdentity !== AIQ_CORE_1_0_6_TASK_METADATA_IDENTITY_SHA256) {
    throw new Error(`AIQ Core 1.0.6 task metadata identity changed: ${observedTaskIdentity}.`);
  }
  if (observedReleaseIdentity !== AIQ_CORE_1_0_6_CATALOG_RELEASE_IDENTITY_SHA256) {
    throw new Error(`AIQ Core 1.0.6 release identity changed: ${observedReleaseIdentity}.`);
  }
}

async function readPriorSchema(name: string): Promise<unknown> {
  const path = fileURLToPath(
    new URL(`../../../benchmarks/candidates/aiq-core-1.0.5/${name}`, import.meta.url),
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
      new URL('../../../benchmarks/candidates/aiq-core-1.0.6/catalog.json', import.meta.url),
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
