import { deepStrictEqual, notStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AIQ_CORE_1_0_5_CATALOG_RELEASE_IDENTITY_SHA256,
  AIQ_CORE_1_0_5_TASK_METADATA_IDENTITY_SHA256,
  REVISED_TASK_IDS,
  assertCatalogInvariants,
  buildCatalog,
  catalogReleaseIdentityDigest,
  taskMetadataIdentityDigest,
  type Catalog105,
} from './generate-benchmark-catalog.ts';
import { buildCatalog as buildPriorCatalog } from '../aiq-core-1.0.4/generate-benchmark-catalog.ts';

type JsonObject = Record<string, unknown>;

const candidateRoot = new URL('../../../benchmarks/candidates/aiq-core-1.0.5/', import.meta.url);
const catalogPath = fileURLToPath(new URL('catalog.json', candidateRoot));
const catalogSchemaPath = fileURLToPath(new URL('catalog.schema.json', candidateRoot));
const taskSchemaPath = fileURLToPath(new URL('task.schema.json', candidateRoot));
const activeTaskSchemaPath = fileURLToPath(
  new URL('../../../benchmarks/schema/task.schema.json', import.meta.url),
);
const priorCandidateRoot = new URL(
  '../../../benchmarks/candidates/aiq-core-1.0.4/',
  import.meta.url,
);

const EXPECTED_REVISED_TASK_IDS = ['coding-06', 'debugging-01', 'debugging-02', 'debugging-04'];

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

await test('the generated 1.0.5 catalog is deterministic and identity-frozen', async () => {
  const generated = buildCatalog();
  const regenerated = buildCatalog();
  const committedSource = await readFile(catalogPath, 'utf8');
  const committed: unknown = JSON.parse(committedSource);

  assertCatalogInvariants(generated);
  deepStrictEqual(regenerated, generated);
  deepStrictEqual(committed, generated);
  strictEqual(committedSource, `${JSON.stringify(generated, undefined, 2)}\n`);
  strictEqual(generated.task_set_version, '1.0.5');
  strictEqual(generated.scoring_version, '1.0.5');
  strictEqual(generated.tasks.length, 72);
  strictEqual(
    taskMetadataIdentityDigest(generated.tasks),
    AIQ_CORE_1_0_5_TASK_METADATA_IDENTITY_SHA256,
  );
  strictEqual(
    catalogReleaseIdentityDigest(generated.catalog_release_identity),
    AIQ_CORE_1_0_5_CATALOG_RELEASE_IDENTITY_SHA256,
  );
});

await test('only four calibration tasks are revised while 68 explicitly carry forward', () => {
  const catalog = buildCatalog();
  const prior = buildPriorCatalog();
  const retargeted = catalog.tasks
    .filter(({ design_revision }) => design_revision.kind === 'calibration_retargeted')
    .map(({ task_id }) => task_id)
    .toSorted();
  const carriedForward = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'carry_forward',
  );

  deepStrictEqual(REVISED_TASK_IDS, EXPECTED_REVISED_TASK_IDS);
  deepStrictEqual(retargeted, EXPECTED_REVISED_TASK_IDS);
  strictEqual(carriedForward.length, 68);
  for (const task of catalog.tasks) {
    strictEqual(task.design_revision.supersedes_task_version, '1.0.4');
    strictEqual(task.provenance.predecessor_task_version, '1.0.4');
    strictEqual(
      task.provenance.origin,
      retargeted.includes(task.task_id) ? 'calibration_driven_revision' : 'release_carry_forward',
    );
    if (!retargeted.includes(task.task_id)) {
      const priorTask = prior.tasks.find(({ task_id }) => task_id === task.task_id);
      if (priorTask === undefined) throw new RangeError(`Missing prior task ${task.task_id}.`);
      strictEqual(
        task.design_revision.task_specific_delta.includes('explicitly carries forward'),
        true,
      );
      deepStrictEqual(
        {
          title: task.title,
          domain: task.domain,
          difficulty: task.difficulty,
          summary: task.summary,
          inputKind: task.input_contract.kind,
          fixtureProfile: task.input_contract.fixture_profile,
          clusterId: task.cluster_id,
          allowedTools: task.allowed_tools,
          budget: task.budget,
          evaluatorKind: task.evaluator.kind,
          executionProtocol: task.evaluator.execution_protocol,
          bindingRequirement: task.evaluator.binding_requirement,
          deterministic: task.evaluator.deterministic,
          partialCredit: task.evaluator.partial_credit,
          passConditions: task.evaluator.pass_conditions,
          scoringContract: task.evaluator.scoring_contract,
          acceptanceFixtures: task.evaluator.acceptance_fixture_commitments,
          tags: task.tags,
          visibility: task.visibility,
        },
        {
          title: priorTask.title,
          domain: priorTask.domain,
          difficulty: priorTask.difficulty,
          summary: priorTask.summary,
          inputKind: priorTask.input_contract.kind,
          fixtureProfile: priorTask.input_contract.fixture_profile,
          clusterId: priorTask.cluster_id,
          allowedTools: priorTask.allowed_tools,
          budget: priorTask.budget,
          evaluatorKind: priorTask.evaluator.kind,
          executionProtocol: priorTask.evaluator.execution_protocol,
          bindingRequirement: priorTask.evaluator.binding_requirement,
          deterministic: priorTask.evaluator.deterministic,
          partialCredit: priorTask.evaluator.partial_credit,
          passConditions: priorTask.evaluator.pass_conditions,
          scoringContract: priorTask.evaluator.scoring_contract,
          acceptanceFixtures: priorTask.evaluator.acceptance_fixture_commitments,
          tags: priorTask.tags,
          visibility: priorTask.visibility,
        },
      );
    }
  }
});

await test('revised tasks use new public contracts without publishing private content', () => {
  const catalog = buildCatalog();

  for (const task of catalog.tasks) {
    const retargeted = EXPECTED_REVISED_TASK_IDS.includes(task.task_id);
    strictEqual(task.task_version, '1.0.5');
    strictEqual(task.visibility, 'hidden');
    strictEqual(task.input_contract.content_handle.includes('/1.0.5/'), true);
    strictEqual(task.evaluator.scorer_version, '1.0.5');
    strictEqual(task.leakage_review.notes.includes('outside Git'), true);
    strictEqual(
      task.design_revision.controlled_corpus_requirements.some((requirement) =>
        /component|0\.20|at least three deterministic assertions/iu.test(requirement),
      ),
      false,
    );
    strictEqual(
      task.design_revision.controlled_corpus_requirements.some((requirement) =>
        requirement.includes('hard-gate and structural failures'),
      ),
      true,
    );
    strictEqual(task.design_revision.controlled_corpus_requirements.length, 4);
    deepStrictEqual(task.evaluator.scoring_contract, {
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
      attributable_runtime_failure_policy:
        'score_zero_as_defined_by_public_runtime_failure_taxonomy',
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
    });
    for (const fixture of Object.values(task.evaluator.acceptance_fixture_commitments)) {
      strictEqual(fixture.handle.includes('/v4/'), retargeted);
      strictEqual(fixture.status, 'required_in_controlled_source');
    }
  }
});

await test('the four public calibration revisions state every requested non-secret contract', () => {
  const revisions = new Map(
    buildCatalog()
      .tasks.filter(({ task_id }) => EXPECTED_REVISED_TASK_IDS.includes(task_id))
      .map((task) => [task.task_id, JSON.stringify(task)]),
  );

  for (const term of ['raw UTF-16 input bound', 'decoded per-field', 'field-count limit']) {
    strictEqual(revisions.get('debugging-01')?.includes(term), true);
  }
  for (const term of ['own-property', 'null-prototype', 'Own empty', 'own undefined']) {
    strictEqual(revisions.get('debugging-02')?.includes(term), true);
  }
  for (const term of ['multi-grapheme', 'Start, middle, and end', 'display budget']) {
    strictEqual(revisions.get('debugging-04')?.includes(term), true);
  }
  for (const term of [
    'keyed async executor',
    'same-key FIFO',
    'work-conserving',
    'idle lifecycle',
  ]) {
    strictEqual(revisions.get('coding-06')?.includes(term), true);
  }
});

await test('the closed schemas bind the 1.0.5 release and revision provenance', async () => {
  const catalogSchema = jsonObject(
    JSON.parse(await readFile(catalogSchemaPath, 'utf8')) as unknown,
    'catalog schema',
  );
  const definitions = jsonObject(catalogSchema.$defs, 'catalog definitions');
  const task = jsonObject(definitions.task, 'task definition');
  const taskProperties = jsonObject(task.properties, 'task properties');
  const designRevision = jsonObject(taskProperties.design_revision, 'design revision');
  const designProperties = jsonObject(designRevision.properties, 'design properties');
  const provenance = jsonObject(taskProperties.provenance, 'provenance');
  const provenanceProperties = jsonObject(provenance.properties, 'provenance properties');
  const evaluator = jsonObject(taskProperties.evaluator, 'evaluator');
  const evaluatorProperties = jsonObject(evaluator.properties, 'evaluator properties');
  const scoringContract = jsonObject(
    evaluatorProperties.scoring_contract,
    'scoring contract schema',
  );
  const scoringProperties = jsonObject(scoringContract.properties, 'scoring properties');
  const acceptanceFixtureCommitment = jsonObject(
    definitions.acceptanceFixtureCommitment,
    'acceptance fixture commitment',
  );
  const acceptanceFixtureProperties = jsonObject(
    acceptanceFixtureCommitment.properties,
    'acceptance fixture properties',
  );
  const acceptanceHandle = jsonObject(acceptanceFixtureProperties.handle, 'acceptance handle');
  const source = await readFile(taskSchemaPath, 'utf8');

  deepStrictEqual(designProperties.supersedes_task_version, { const: '1.0.4' });
  deepStrictEqual(designProperties.kind, {
    enum: ['calibration_retargeted', 'carry_forward'],
  });
  deepStrictEqual(provenanceProperties.origin, {
    enum: ['calibration_driven_revision', 'release_carry_forward'],
  });
  deepStrictEqual(provenanceProperties.predecessor_task_version, { const: '1.0.4' });
  deepStrictEqual(provenanceProperties.source, {
    const: 'scripts/candidates/aiq-core-1.0.5/generate-benchmark-catalog.ts',
  });
  deepStrictEqual(scoringProperties.aggregation, {
    const: 'configured_weighted_binary_check_fraction_with_hard_gates',
  });
  deepStrictEqual(scoringProperties.public_criteria_role, {
    const: 'coverage_summary_not_weight_partition',
  });
  strictEqual('components' in scoringProperties, false);
  strictEqual('minimum_assertions_per_component' in scoringProperties, false);
  strictEqual(
    acceptanceHandle.pattern,
    '^aiq-acceptance://[a-z0-9-]+-[0-9]{2}/v(?:2|3|4)/(?:gold|alternate-correct|partial|adversarial-format|empty|timeout)(?![\\s\\S])',
  );
  strictEqual(source.includes('aiq-core/1\\\\.0\\\\.5/'), true);
  strictEqual(source.includes('aiq-core/1\\\\.0\\\\.4/'), false);
});

await test('the active task schema accepts only AIQ Core 1.0.5 controlled references', async () => {
  const source = await readFile(activeTaskSchemaPath, 'utf8');
  const schema = jsonObject(JSON.parse(source) as unknown, 'active task schema');
  const properties = jsonObject(schema.properties, 'active task properties');
  const fixtureRefs = jsonObject(properties.fixture_refs, 'active fixture references');
  const items = jsonObject(fixtureRefs.items, 'active fixture reference items');

  if (!Array.isArray(items.oneOf)) throw new TypeError('active fixture references need oneOf');
  const controlledPattern = items.oneOf
    .map((candidate) => jsonObject(candidate, 'active fixture reference alternative').pattern)
    .find((pattern) => typeof pattern === 'string' && pattern.includes('aiq-controlled'));
  if (typeof controlledPattern !== 'string') {
    throw new TypeError('active controlled-reference pattern is missing');
  }
  const controlledReference = new RegExp(controlledPattern, 'u');

  deepStrictEqual(properties.task_version, { const: '1.0.5' });
  deepStrictEqual(properties.scorer_version, { const: '1.0.5' });
  strictEqual(controlledReference.test('aiq-controlled-fixture://aiq-core/1.0.5/coding-01'), true);
  strictEqual(
    controlledReference.test('aiq-controlled-acceptance://aiq-core/1.0.5/coding-01'),
    true,
  );
  strictEqual(controlledReference.test('aiq-controlled-fixture://aiq-core/1.0.4/coding-01'), false);
});

await test('the checked-in 1.0.4 generated artifacts remain unchanged', async () => {
  const expected = new Map([
    ['catalog.json', '7ccec2562379c0f93f0f3726a9a1d18e179110aa5c460b00e111f74775295713'],
    ['catalog.schema.json', 'ee857a9a46c63d4989cd6eb883af44f32adac51a658606f7de7fc48bdbf6ef2e'],
    ['task.schema.json', '0ff829205d8c26b5b6c05da8f12700753353c7c19f9ddc927a5ea3efa2cf04a9'],
  ]);
  await Promise.all(
    [...expected].map(async ([name, digest]) => {
      const bytes = await readFile(new URL(name, priorCandidateRoot));
      strictEqual(createHash('sha256').update(bytes).digest('hex'), digest);
    }),
  );
  const committed: unknown = JSON.parse(
    await readFile(new URL('catalog.json', priorCandidateRoot), 'utf8'),
  );
  deepStrictEqual(committed, buildPriorCatalog());
  const priorGenerator = await readFile(
    new URL('../aiq-core-1.0.4/generate-benchmark-catalog.ts', import.meta.url),
  );
  strictEqual(
    createHash('sha256').update(priorGenerator).digest('hex'),
    '7cefec3dfbaa77e2fe9a1fba5a887c0f039b40cee45222a0aaace22f73c49c86',
  );
});

await test('catalog invariants reject revision and metadata drift', () => {
  const catalog = buildCatalog();
  const revisedTask = catalog.tasks.find(({ task_id }) => task_id === 'coding-06');
  if (revisedTask === undefined) throw new RangeError('Expected coding-06.');

  const changed = {
    ...catalog,
    tasks: [
      {
        ...revisedTask,
        design_revision: { ...revisedTask.design_revision, kind: 'carry_forward' as const },
      },
      ...catalog.tasks.filter(({ task_id }) => task_id !== revisedTask.task_id),
    ],
  } as Catalog105;

  notStrictEqual(
    taskMetadataIdentityDigest(changed.tasks),
    AIQ_CORE_1_0_5_TASK_METADATA_IDENTITY_SHA256,
  );
  throws(() => assertCatalogInvariants(changed), /four calibration-retargeted|revision metadata/u);
});
