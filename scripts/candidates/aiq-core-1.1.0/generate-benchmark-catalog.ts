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
const CANDIDATE_ID = 'aiq-core/1.1.0-candidate.1' as const;

type JsonObject = Record<string, unknown>;
type Decision = 'retained' | 'revised';
type FixtureApplicability = 'required' | 'not_applicable' | 'pending_private_reconciliation';

interface TaskDecision {
  readonly task_id: string;
  readonly decision: Decision;
  readonly cluster_id: string;
  readonly acceptance_fixture_applicability: {
    readonly empty: FixtureApplicability;
    readonly timeout: FixtureApplicability;
  };
  readonly rationale: string;
}

export interface CandidateDecisionManifest {
  readonly schema_version: 'aiq.candidate-design-decisions.v1';
  readonly candidate_id: typeof CANDIDATE_ID;
  readonly predecessor_task_set_version: '1.0.7';
  readonly candidate_task_set_version: '1.1.0';
  readonly recorded_date: '2026-08-28';
  readonly authority: 'explicit_per_task_maintainer_decision';
  readonly legacy_observed_fixture_counts: {
    readonly empty: 57;
    readonly timeout: 4;
  };
  readonly private_reconciliation_required: true;
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
  if (!['required', 'not_applicable', 'pending_private_reconciliation'].includes(String(value))) {
    throw new TypeError(`${label} is invalid.`);
  }
  if (value === 'required' || value === 'not_applicable') return value;
  return 'pending_private_reconciliation';
}

function taskDecision(value: unknown, index: number): TaskDecision {
  const decision = jsonObject(value, `decision ${String(index)}`);
  exactKeys(
    decision,
    ['acceptance_fixture_applicability', 'cluster_id', 'decision', 'rationale', 'task_id'],
    `decision ${String(index)}`,
  );
  const fixture = jsonObject(
    decision.acceptance_fixture_applicability,
    `decision ${String(index)} fixture applicability`,
  );
  exactKeys(fixture, ['empty', 'timeout'], `decision ${String(index)} fixture applicability`);
  const selectedDecision = stringValue(decision.decision, `decision ${String(index)} kind`);
  if (selectedDecision !== 'retained' && selectedDecision !== 'revised') {
    throw new TypeError(`decision ${String(index)} kind is invalid.`);
  }

  return {
    task_id: stringValue(decision.task_id, `decision ${String(index)} task_id`),
    decision: selectedDecision,
    cluster_id: stringValue(decision.cluster_id, `decision ${String(index)} cluster_id`),
    acceptance_fixture_applicability: {
      empty: fixtureApplicability(fixture.empty, `decision ${String(index)} empty`),
      timeout: fixtureApplicability(fixture.timeout, `decision ${String(index)} timeout`),
    },
    rationale: stringValue(decision.rationale, `decision ${String(index)} rationale`),
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
      'legacy_observed_fixture_counts',
      'predecessor_task_set_version',
      'private_reconciliation_required',
      'recorded_date',
      'schema_version',
    ],
    'candidate decision manifest',
  );
  const legacyCounts = jsonObject(
    manifest.legacy_observed_fixture_counts,
    'legacy observed fixture counts',
  );
  exactKeys(legacyCounts, ['empty', 'timeout'], 'legacy observed fixture counts');
  if (
    manifest.schema_version !== 'aiq.candidate-design-decisions.v1' ||
    manifest.candidate_id !== CANDIDATE_ID ||
    manifest.predecessor_task_set_version !== '1.0.7' ||
    manifest.candidate_task_set_version !== TASK_SET_VERSION ||
    manifest.recorded_date !== '2026-08-28' ||
    manifest.authority !== 'explicit_per_task_maintainer_decision' ||
    legacyCounts.empty !== 57 ||
    legacyCounts.timeout !== 4 ||
    manifest.private_reconciliation_required !== true
  ) {
    throw new TypeError('Candidate decision manifest identity is invalid.');
  }
  const decisions = unknownArray(manifest.decisions, 'candidate decisions').map(taskDecision);

  return {
    schema_version: 'aiq.candidate-design-decisions.v1',
    candidate_id: CANDIDATE_ID,
    predecessor_task_set_version: '1.0.7',
    candidate_task_set_version: TASK_SET_VERSION,
    recorded_date: '2026-08-28',
    authority: 'explicit_per_task_maintainer_decision',
    legacy_observed_fixture_counts: { empty: 57, timeout: 4 },
    private_reconciliation_required: true,
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
    manifest.schema_version !== 'aiq.candidate-design-decisions.v1' ||
    manifest.candidate_id !== CANDIDATE_ID ||
    manifest.predecessor_task_set_version !== '1.0.7' ||
    manifest.candidate_task_set_version !== TASK_SET_VERSION ||
    manifest.recorded_date !== '2026-08-28' ||
    manifest.authority !== 'explicit_per_task_maintainer_decision' ||
    manifest.legacy_observed_fixture_counts.empty !== 57 ||
    manifest.legacy_observed_fixture_counts.timeout !== 4 ||
    !manifest.private_reconciliation_required ||
    manifest.decisions.length !== 72
  ) {
    throw new Error('AIQ Core 1.1.0 decision-manifest authority is invalid.');
  }
  const decisionIds = manifest.decisions.map((decision) => decision.task_id);
  if (
    new Set(decisionIds).size !== 72 ||
    priorTaskIds.length !== 72 ||
    decisionIds.some((taskId, index) => taskId !== priorTaskIds[index]) ||
    manifest.decisions.some(
      (decision) =>
        !['retained', 'revised'].includes(decision.decision) ||
        decision.cluster_id.length === 0 ||
        decision.rationale.length < 160 ||
        !OPTIONAL_FIXTURE_CLASSES.every((fixtureClass) =>
          ['required', 'not_applicable', 'pending_private_reconciliation'].includes(
            decision.acceptance_fixture_applicability[fixtureClass],
          ),
        ),
    )
  ) {
    throw new Error('Every predecessor task needs one ordered explicit retained/revised decision.');
  }
}

function fixtureDeclaration(
  priorCommitments: JsonObject,
  fixtureClass: string,
  applicability: FixtureApplicability,
): JsonObject {
  if (applicability !== 'required') return { applicability, handle: null };
  const prior = jsonObject(priorCommitments[fixtureClass], `${fixtureClass} predecessor fixture`);
  return {
    applicability,
    handle: stringValue(prior.handle, `${fixtureClass} predecessor fixture handle`),
  };
}

function reviseTask(priorValue: unknown, decision: TaskDecision): JsonObject {
  const prior = jsonObject(structuredClone(priorValue), `predecessor task ${decision.task_id}`);
  if (prior.task_id !== decision.task_id) {
    throw new Error(`Decision ${decision.task_id} is not aligned with its predecessor task.`);
  }
  const inputContract = jsonObject(prior.input_contract, `${decision.task_id} input contract`);
  const evaluator = jsonObject(prior.evaluator, `${decision.task_id} evaluator`);
  const priorCommitments = jsonObject(
    evaluator.acceptance_fixture_commitments,
    `${decision.task_id} fixture commitments`,
  );
  const applicability = decision.acceptance_fixture_applicability;
  const acceptanceFixtureCommitments: JsonObject = {};
  for (const fixtureClass of REQUIRED_FIXTURE_CLASSES) {
    acceptanceFixtureCommitments[fixtureClass] = fixtureDeclaration(
      priorCommitments,
      fixtureClass,
      'required',
    );
  }
  for (const fixtureClass of OPTIONAL_FIXTURE_CLASSES) {
    acceptanceFixtureCommitments[fixtureClass] = fixtureDeclaration(
      priorCommitments,
      fixtureClass,
      applicability[fixtureClass],
    );
  }

  return {
    ...prior,
    task_version: TASK_SET_VERSION,
    design_revision: {
      supersedes_task_version: '1.0.7',
      decision: decision.decision,
      decision_record: DECISION_PATH,
      kind: 'qualification_source_foundation',
      objective:
        'Create an explicit AIQ Core 1.1.0 candidate identity whose authoring and three-run qualification contracts fail closed without private evidence.',
      task_specific_delta: decision.rationale,
      controlled_corpus_requirements: CONTROLLED_CORPUS_REQUIREMENTS,
    },
    input_contract: {
      ...inputContract,
      content_handle: stringValue(
        inputContract.content_handle,
        `${decision.task_id} content handle`,
      ).replace('aiq-core/1.0.7', 'aiq-core/1.1.0'),
    },
    cluster_id: decision.cluster_id,
    evaluator: { ...evaluator, acceptance_fixture_commitments: acceptanceFixtureCommitments },
    provenance: {
      origin: 'explicit_candidate_design_decision',
      owner: 'AIQ benchmark maintainers',
      recorded_date: '2026-08-28',
      predecessor_task_version: '1.0.7',
      source: GENERATOR_PATH,
      decision_record: DECISION_PATH,
    },
    leakage_review: {
      status: 'independent_private_review_v2_required',
      owner: 'AIQ benchmark maintainers',
      review_requirement: 'exactly_one_matching_aiq_leakage_review_v2_per_task',
      notes: `${decision.task_id} cannot be sealed until a supplied independent review binds this exact task definition and catalog entry. Recorded process separation is evidence, not cryptographic proof of human independence.`,
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
    title: 'AIQ Core 1.1.0 candidate source foundation',
    status: 'draft_source_foundation',
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
        'The catalog is the sole expected acceptance-fixture applicability authority. Observed controlled classes must equal each task declaration exactly. Private tasks, fixtures, evaluator content, leakage reviews, and signing material stay outside Git.',
    },
    source_foundation: {
      predecessor_task_set_version: '1.0.7',
      decision_record: DECISION_PATH,
      legacy_observed_fixture_counts: manifest.legacy_observed_fixture_counts,
      private_fixture_mapping_reconciled: false,
      private_tasks_authored: false,
      leakage_reviews_complete: false,
      sealing_allowed: false,
      qualification_allowed: false,
      release_allowed: false,
      blockers: [
        'Reconcile the retained private harness into explicit required or not_applicable empty and timeout declarations for all 72 tasks.',
        'Author or retain each private 1.1.0 task and supply one exact matching aiq.leakage-review.v2 record per task.',
        'Seal the final candidate and pass three-matrix benchmark qualification under a new exact candidate identity.',
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
  for (const field of ['candidate_identity', 'source_foundation']) {
    if (!required.includes(field)) required.push(field);
  }
  schema.required = required;
  properties.schema_version = { const: 'aiq.catalog.v2' };
  properties.task_set_version = { const: TASK_SET_VERSION };
  properties.status = {
    enum: ['draft_source_foundation', 'qualification_ready', 'failed'],
  };
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
  properties.source_foundation = {
    type: 'object',
    additionalProperties: false,
    required: [
      'predecessor_task_set_version',
      'decision_record',
      'legacy_observed_fixture_counts',
      'private_fixture_mapping_reconciled',
      'private_tasks_authored',
      'leakage_reviews_complete',
      'sealing_allowed',
      'qualification_allowed',
      'release_allowed',
      'blockers',
    ],
    properties: {
      predecessor_task_set_version: { const: '1.0.7' },
      decision_record: { const: DECISION_PATH },
      legacy_observed_fixture_counts: {
        const: { empty: 57, timeout: 4 },
      },
      private_fixture_mapping_reconciled: { type: 'boolean' },
      private_tasks_authored: { type: 'boolean' },
      leakage_reviews_complete: { type: 'boolean' },
      sealing_allowed: { type: 'boolean' },
      qualification_allowed: { type: 'boolean' },
      release_allowed: { type: 'boolean' },
      blockers: { type: 'array', minItems: 0, uniqueItems: true, items: { type: 'string' } },
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
        enum: ['required', 'not_applicable', 'pending_private_reconciliation'],
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
      'decision',
      'decision_record',
      'kind',
      'objective',
      'task_specific_delta',
      'controlled_corpus_requirements',
    ],
    properties: {
      supersedes_task_version: { const: '1.0.7' },
      decision: { enum: ['retained', 'revised'] },
      decision_record: { const: DECISION_PATH },
      kind: { const: 'qualification_source_foundation' },
      objective: { type: 'string', minLength: 80 },
      task_specific_delta: { type: 'string', minLength: 160 },
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
      'source',
      'decision_record',
    ],
    properties: {
      origin: { const: 'explicit_candidate_design_decision' },
      owner: { const: 'AIQ benchmark maintainers' },
      recorded_date: { const: '2026-08-28' },
      predecessor_task_version: { const: '1.0.7' },
      source: { const: GENERATOR_PATH },
      decision_record: { const: DECISION_PATH },
    },
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
