import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCatalog as buildPriorCatalog,
  type Catalog106 as PriorCatalog,
} from '../aiq-core-1.0.6/generate-benchmark-catalog.ts';

const TASK_SET_VERSION = '1.0.7' as const;
const TASK_VERSION = '1.0.7' as const;
const TASK_SCORER_VERSION = '1.0.6' as const;
const GENERATOR_PATH = 'scripts/candidates/aiq-core-1.0.7/generate-benchmark-catalog.ts';

export const AIQ_CORE_1_0_7_TASK_METADATA_IDENTITY_SHA256 =
  'sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1';
export const AIQ_CORE_1_0_7_CATALOG_RELEASE_IDENTITY_SHA256 =
  'sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae';
export const AIQ_CORE_1_0_7_CONTRAST_IDENTITY_SHA256 =
  'sha256:09d3b4532f3dcd7a6b07c31bc4c59e25d432889ee8cce0b75d15285a42d3e077';

type JsonObject = Record<string, unknown>;
type PriorTask = PriorCatalog['tasks'][number];

export interface CatalogTask107 extends Omit<
  PriorTask,
  'task_version' | 'design_revision' | 'input_contract' | 'budget' | 'provenance' | 'leakage_review'
> {
  readonly task_version: '1.0.7';
  readonly design_revision: {
    readonly supersedes_task_version: '1.0.6';
    readonly kind: 'unbounded_usage_measurement_revision';
    readonly objective: string;
    readonly task_specific_delta: string;
    readonly controlled_corpus_requirements: readonly string[];
  };
  readonly input_contract: PriorTask['input_contract'];
  readonly budget: {
    readonly wall_seconds: null;
    readonly max_steps: null;
    readonly max_tool_calls: null;
  };
  readonly provenance: {
    readonly origin: 'unbounded_usage_measurement_revision';
    readonly owner: 'AIQ benchmark maintainers';
    readonly recorded_date: '2026-08-08';
    readonly predecessor_task_version: '1.0.6';
    readonly source: typeof GENERATOR_PATH;
  };
  readonly leakage_review: PriorTask['leakage_review'];
}

export interface Catalog107 extends Omit<
  PriorCatalog,
  | 'task_set_version'
  | 'title'
  | 'generated_from'
  | 'task_metadata_identity'
  | 'catalog_release_identity'
  | 'tasks'
> {
  readonly task_set_version: '1.0.7';
  readonly scoring_version: '1.0.6';
  readonly title: 'AIQ Core 1.0.7';
  readonly generated_from: typeof GENERATOR_PATH;
  readonly task_metadata_identity: PriorCatalog['task_metadata_identity'];
  readonly catalog_release_identity: Omit<
    PriorCatalog['catalog_release_identity'],
    'release_identity' | 'scoring_version' | 'task_metadata_identity' | 'digest'
  > & {
    readonly release_identity: 'aiq-core/1.0.7';
    readonly scoring_version: '1.0.6';
    readonly task_metadata_identity: Catalog107['task_metadata_identity'];
    readonly digest: string;
  };
  readonly tasks: readonly CatalogTask107[];
}

interface ContrastTask107 {
  readonly allowed_tools: readonly string[];
  readonly budget: {
    readonly wall_seconds: null;
    readonly max_steps: null;
    readonly max_tool_calls: null;
  };
  readonly contrast_boundary: string;
  readonly contrast_pair: string;
  readonly contrast_role: string;
  readonly difficulty: string;
  readonly domain: string;
  readonly summary: string;
  readonly task_id: string;
  readonly task_version: '1.0.7';
  readonly visibility: 'hidden';
}

export interface ContrastCatalog107 {
  readonly schema_version: 'aiq.contrast-corpus.v1';
  readonly task_set_id: 'aiq-core-contrast';
  readonly task_set_version: '1.0.7';
  readonly scoring_version: '1.0.6';
  readonly calibration_only: true;
  readonly task_count: 6;
  readonly identity_sha256: string;
  readonly identity_scope: 'ordered_full_task_metadata';
  readonly tasks: readonly ContrastTask107[];
}

const CONTROLLED_CORPUS_REQUIREMENTS = Object.freeze([
  'Bind every scored check identifier, nonnegative integer weight, type, and hard-gate status in the content-addressed private evaluator configuration.',
  'Exercise correct, alternate-correct, partial, adversarial-format, empty, and timeout fixtures under deterministic exact replay.',
  'Prove that hard-gate and structural failures force zero while other failed checks reduce the score by the committed positive-weight fraction.',
  'Record elapsed time, agent steps, tool calls, provider tokens, and cost as auxiliary evidence that cannot change semantic task scores.',
] as const);

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

function replaceCoreReleaseStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('aiq-core-1.0.6', 'aiq-core-1.0.7')
      .replaceAll('aiq-core@1.0.6', 'aiq-core@1.0.7')
      .replaceAll('aiq-core/1.0.6', 'aiq-core/1.0.7')
      .replaceAll('aiq-core/1\\.0\\.6', 'aiq-core/1\\.0\\.7');
  }
  if (Array.isArray(value)) return value.map(replaceCoreReleaseStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceCoreReleaseStrings(child)]),
    );
  }
  return value;
}

function reviseTask(prior: PriorTask): CatalogTask107 {
  return {
    ...prior,
    task_version: TASK_VERSION,
    design_revision: {
      supersedes_task_version: '1.0.6',
      kind: 'unbounded_usage_measurement_revision',
      objective:
        'Preserve task and evaluator semantics while removing benchmark termination based on elapsed time, agent steps, or tool calls.',
      task_specific_delta: `${prior.task_id} preserves the accepted AIQ Core 1.0.6 prompt, fixture, evaluator, allowed tools, and semantic scoring contract. Formal execution has no wall-time, step, or tool-call limit. Elapsed time, agent steps, tool calls, tokens, and cost remain auxiliary measurements and cannot change AIQ.`,
      controlled_corpus_requirements: CONTROLLED_CORPUS_REQUIREMENTS,
    },
    input_contract: {
      ...prior.input_contract,
      content_handle: prior.input_contract.content_handle.replace(
        'aiq-core/1.0.6',
        'aiq-core/1.0.7',
      ),
    },
    budget: { wall_seconds: null, max_steps: null, max_tool_calls: null },
    provenance: {
      origin: 'unbounded_usage_measurement_revision',
      owner: 'AIQ benchmark maintainers',
      recorded_date: '2026-08-08',
      predecessor_task_version: '1.0.6',
      source: GENERATOR_PATH,
    },
    leakage_review: {
      ...prior.leakage_review,
      notes: `${prior.task_id} publishes only its versioned public design and scorer contract. Its private prompt, fixture, expected outputs, executable checks, and leakage evidence must bind this exact AIQ Core 1.0.7 catalog entry outside Git.`,
    },
  };
}

export function taskMetadataIdentityDigest(tasks: readonly unknown[]): string {
  return digestValue(tasks);
}

export function catalogReleaseIdentityDigest(
  identity: Catalog107['catalog_release_identity'],
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

export function buildCatalog(): Catalog107 {
  const prior = buildPriorCatalog();
  const tasks = prior.tasks.map(reviseTask);
  const taskMetadataIdentity = {
    ...prior.task_metadata_identity,
    digest: taskMetadataIdentityDigest(tasks),
  };
  const releaseIdentityInput = {
    release_identity: 'aiq-core/1.0.7' as const,
    scoring_version: TASK_SCORER_VERSION,
    task_metadata_identity: taskMetadataIdentity,
  };

  return {
    ...prior,
    task_set_version: TASK_SET_VERSION,
    scoring_version: TASK_SCORER_VERSION,
    title: 'AIQ Core 1.0.7',
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

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return Array.from(value, (entry: unknown, index) =>
    stringValue(entry, `${label}[${String(index)}]`),
  );
}

function taskBudgetProperties(root: JsonObject, path: 'catalog' | 'task'): JsonObject {
  const properties = jsonObject(root.properties, `${path} properties`);
  if (path === 'task') {
    return jsonObject(jsonObject(properties.budgets, 'task budgets').properties, 'task budgets');
  }
  const definitions = jsonObject(root.$defs, 'catalog definitions');
  const task = jsonObject(definitions.task, 'catalog task');
  return jsonObject(
    jsonObject(jsonObject(task.properties, 'task properties').budget, 'budget').properties,
    'budget properties',
  );
}

function reviseTaskSchema(priorSchema: unknown): unknown {
  const schema = jsonObject(replaceCoreReleaseStrings(priorSchema), 'task schema');
  const properties = jsonObject(schema.properties, 'task properties');
  properties.task_version = { const: TASK_VERSION };
  properties.scorer_version = { const: TASK_SCORER_VERSION };
  const budgets = taskBudgetProperties(schema, 'task');
  budgets.wall_seconds = { type: 'null' };
  budgets.max_steps = { type: 'null' };
  budgets.max_tool_calls = { type: 'null' };
  return schema;
}

function reviseCatalogSchema(priorSchema: unknown): unknown {
  const schema = jsonObject(replaceCoreReleaseStrings(priorSchema), 'catalog schema');
  const properties = jsonObject(schema.properties, 'catalog properties');
  properties.task_set_version = { const: TASK_SET_VERSION };
  properties.scoring_version = { const: TASK_SCORER_VERSION };
  const release = jsonObject(properties.catalog_release_identity, 'release identity');
  const releaseProperties = jsonObject(release.properties, 'release identity properties');
  releaseProperties.release_identity = { const: 'aiq-core/1.0.7' };
  releaseProperties.scoring_version = { const: TASK_SCORER_VERSION };
  const definitions = jsonObject(schema.$defs, 'catalog definitions');
  const task = jsonObject(definitions.task, 'catalog task');
  const taskProperties = jsonObject(task.properties, 'catalog task properties');
  taskProperties.task_version = { const: TASK_VERSION };
  const evaluator = jsonObject(taskProperties.evaluator, 'task evaluator');
  jsonObject(evaluator.properties, 'evaluator properties').scorer_version = {
    const: TASK_SCORER_VERSION,
  };
  const design = jsonObject(taskProperties.design_revision, 'design revision');
  const designProperties = jsonObject(design.properties, 'design properties');
  designProperties.supersedes_task_version = { const: '1.0.6' };
  designProperties.kind = { enum: ['unbounded_usage_measurement_revision'] };
  const provenance = jsonObject(taskProperties.provenance, 'provenance');
  const provenanceProperties = jsonObject(provenance.properties, 'provenance properties');
  provenanceProperties.origin = { enum: ['unbounded_usage_measurement_revision'] };
  provenanceProperties.recorded_date = { const: '2026-08-08' };
  provenanceProperties.predecessor_task_version = { const: '1.0.6' };
  provenanceProperties.source = { const: GENERATOR_PATH };
  const budgets = taskBudgetProperties(schema, 'catalog');
  budgets.wall_seconds = { type: 'null' };
  budgets.max_steps = { type: 'null' };
  budgets.max_tool_calls = { type: 'null' };
  return schema;
}

export function buildContrastCatalog(prior: unknown): ContrastCatalog107 {
  const document = jsonObject(prior, 'prior contrast catalog');
  if (!Array.isArray(document.tasks) || document.tasks.length !== 6) {
    throw new TypeError('prior contrast catalog must contain six tasks');
  }
  const tasks = document.tasks.map((value) => {
    const task = jsonObject(value, 'prior contrast task');
    if (task.visibility !== 'hidden') {
      throw new TypeError('prior contrast task visibility must be hidden');
    }
    return {
      allowed_tools: stringArray(task.allowed_tools, 'prior contrast task allowed_tools'),
      task_version: TASK_VERSION,
      budget: { wall_seconds: null, max_steps: null, max_tool_calls: null },
      contrast_boundary: stringValue(
        task.contrast_boundary,
        'prior contrast task contrast_boundary',
      ),
      contrast_pair: stringValue(task.contrast_pair, 'prior contrast task contrast_pair'),
      contrast_role: stringValue(task.contrast_role, 'prior contrast task contrast_role'),
      difficulty: stringValue(task.difficulty, 'prior contrast task difficulty'),
      domain: stringValue(task.domain, 'prior contrast task domain'),
      summary: stringValue(task.summary, 'prior contrast task summary'),
      task_id: stringValue(task.task_id, 'prior contrast task task_id'),
      visibility: 'hidden' as const,
    };
  });
  return {
    schema_version: 'aiq.contrast-corpus.v1',
    task_set_id: 'aiq-core-contrast',
    task_set_version: TASK_SET_VERSION,
    scoring_version: TASK_SCORER_VERSION,
    calibration_only: true,
    task_count: 6,
    identity_sha256: taskMetadataIdentityDigest(tasks),
    identity_scope: 'ordered_full_task_metadata',
    tasks,
  };
}

export function assertCatalogInvariants(catalog: Catalog107, contrast: ContrastCatalog107): void {
  if (
    catalog.task_set_version !== TASK_SET_VERSION ||
    catalog.scoring_version !== TASK_SCORER_VERSION ||
    catalog.generated_from !== GENERATOR_PATH ||
    catalog.tasks.length !== 72 ||
    catalog.tasks.some(
      (task) =>
        task.task_version !== TASK_VERSION ||
        task.evaluator.scorer_version !== TASK_SCORER_VERSION ||
        task.budget.wall_seconds !== null ||
        task.budget.max_steps !== null ||
        task.budget.max_tool_calls !== null,
    )
  ) {
    throw new Error('AIQ Core 1.0.7 release identity or unbounded task contract is invalid.');
  }
  if (
    catalog.task_metadata_identity.digest !== AIQ_CORE_1_0_7_TASK_METADATA_IDENTITY_SHA256 ||
    catalog.catalog_release_identity.digest !== AIQ_CORE_1_0_7_CATALOG_RELEASE_IDENTITY_SHA256 ||
    contrast.identity_sha256 !== AIQ_CORE_1_0_7_CONTRAST_IDENTITY_SHA256 ||
    contrast.tasks.some(
      (task) =>
        task.task_version !== TASK_VERSION ||
        task.budget.wall_seconds !== null ||
        task.budget.max_steps !== null ||
        task.budget.max_tool_calls !== null,
    )
  ) {
    throw new Error('AIQ Core 1.0.7 frozen catalog identity changed.');
  }
}

async function readPriorCandidate(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(`../../../benchmarks/candidates/aiq-core-1.0.6/${name}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;
}

export async function writeCandidate(outputDirectory: string): Promise<void> {
  const catalog = buildCatalog();
  const contrast = buildContrastCatalog(await readPriorCandidate('contrast-catalog.json'));
  assertCatalogInvariants(catalog, contrast);
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
    writeFile(
      `${outputDirectory}/contrast-catalog.json`,
      `${JSON.stringify(contrast, undefined, 2)}\n`,
    ),
  ]);
}

if (import.meta.main) {
  const outputDirectory = dirname(
    fileURLToPath(
      new URL('../../../benchmarks/candidates/aiq-core-1.0.7/catalog.json', import.meta.url),
    ),
  );
  await writeCandidate(outputDirectory);
  const catalog = buildCatalog();
  const contrast = buildContrastCatalog(await readPriorCandidate('contrast-catalog.json'));
  process.stdout.write(
    `${JSON.stringify({
      catalog_release_identity_sha256: catalog.catalog_release_identity.digest,
      contrast_identity_sha256: contrast.identity_sha256,
      task_metadata_identity_sha256: catalog.task_metadata_identity.digest,
    })}\n`,
  );
}
