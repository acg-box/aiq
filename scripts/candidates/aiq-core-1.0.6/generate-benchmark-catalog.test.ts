import { deepStrictEqual, notStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AIQ_CORE_1_0_6_CATALOG_RELEASE_IDENTITY_SHA256,
  AIQ_CORE_1_0_6_TASK_METADATA_IDENTITY_SHA256,
  REVISED_TASK_IDS,
  assertCatalogInvariants,
  buildCatalog,
  catalogReleaseIdentityDigest,
  taskMetadataIdentityDigest,
  type Catalog106,
} from './generate-benchmark-catalog.ts';
import { buildCatalog as buildPriorCatalog } from '../aiq-core-1.0.5/generate-benchmark-catalog.ts';

type JsonObject = Record<string, unknown>;

const candidateRoot = new URL('../../../benchmarks/candidates/aiq-core-1.0.6/', import.meta.url);
const catalogPath = fileURLToPath(new URL('catalog.json', candidateRoot));
const catalogSchemaPath = fileURLToPath(new URL('catalog.schema.json', candidateRoot));
const taskSchemaPath = fileURLToPath(new URL('task.schema.json', candidateRoot));
const activeTaskSchemaPath = fileURLToPath(
  new URL('../../../benchmarks/schema/task.schema.json', import.meta.url),
);
const priorCandidateRoot = new URL(
  '../../../benchmarks/candidates/aiq-core-1.0.5/',
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

await test('the generated 1.0.6 catalog is deterministic and identity-frozen', async () => {
  const generated = buildCatalog();
  const regenerated = buildCatalog();
  const committedSource = await readFile(catalogPath, 'utf8');
  const committed: unknown = JSON.parse(committedSource);

  assertCatalogInvariants(generated);
  deepStrictEqual(regenerated, generated);
  deepStrictEqual(committed, generated);
  strictEqual(committedSource, `${JSON.stringify(generated, undefined, 2)}\n`);
  strictEqual(generated.task_set_version, '1.0.6');
  strictEqual(generated.scoring_version, '1.0.6');
  strictEqual(generated.tasks.length, 72);
  strictEqual(
    taskMetadataIdentityDigest(generated.tasks),
    AIQ_CORE_1_0_6_TASK_METADATA_IDENTITY_SHA256,
  );
  strictEqual(
    catalogReleaseIdentityDigest(generated.catalog_release_identity),
    AIQ_CORE_1_0_6_CATALOG_RELEASE_IDENTITY_SHA256,
  );
});

await test('only four task budgets are revised while 68 tasks explicitly carry forward', () => {
  const catalog = buildCatalog();
  const prior = buildPriorCatalog();
  const budgetRevised = catalog.tasks
    .filter(({ design_revision }) => design_revision.kind === 'runtime_budget_revision')
    .map(({ task_id }) => task_id)
    .toSorted();
  const carriedForward = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'carry_forward',
  );

  deepStrictEqual(REVISED_TASK_IDS, EXPECTED_REVISED_TASK_IDS);
  deepStrictEqual(budgetRevised, EXPECTED_REVISED_TASK_IDS);
  strictEqual(carriedForward.length, 68);
  for (const task of catalog.tasks) {
    strictEqual(task.design_revision.supersedes_task_version, '1.0.5');
    strictEqual(task.provenance.predecessor_task_version, '1.0.5');
    strictEqual(
      task.provenance.origin,
      budgetRevised.includes(task.task_id) ? 'runtime_budget_revision' : 'release_carry_forward',
    );
    const priorTask = prior.tasks.find(({ task_id }) => task_id === task.task_id);
    if (priorTask === undefined) throw new RangeError(`Missing prior task ${task.task_id}.`);
    if (!budgetRevised.includes(task.task_id)) {
      strictEqual(task.design_revision.task_specific_delta.includes('carries forward'), true);
      deepStrictEqual(task.budget, priorTask.budget);
    } else {
      deepStrictEqual(task.budget, {
        wall_seconds: 1500,
        max_steps: 48,
        max_tool_calls: 40,
      });
      strictEqual(task.design_revision.task_specific_delta.includes('seven timeouts'), true);
      strictEqual(task.design_revision.task_specific_delta.includes('three tool-budget'), true);
    }
    deepStrictEqual(task.title, priorTask.title);
    deepStrictEqual(task.summary, priorTask.summary);
    deepStrictEqual(task.allowed_tools, priorTask.allowed_tools);
    deepStrictEqual(task.evaluator.kind, priorTask.evaluator.kind);
    deepStrictEqual(task.evaluator.pass_conditions, priorTask.evaluator.pass_conditions);
    deepStrictEqual(
      task.evaluator.acceptance_fixture_commitments,
      priorTask.evaluator.acceptance_fixture_commitments,
    );
    deepStrictEqual(task.tags, priorTask.tags);
  }
});

await test('the new release keeps the public scoring contract and hides controlled content', () => {
  const catalog = buildCatalog();
  const prior = buildPriorCatalog();

  for (const task of catalog.tasks) {
    const priorTask = prior.tasks.find(({ task_id }) => task_id === task.task_id);
    if (priorTask === undefined) throw new RangeError(`Missing prior task ${task.task_id}.`);
    strictEqual(task.task_version, '1.0.6');
    strictEqual(task.visibility, 'hidden');
    strictEqual(task.input_contract.content_handle.includes('/1.0.6/'), true);
    strictEqual(task.evaluator.scorer_version, '1.0.6');
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
    });
    for (const fixture of Object.values(task.evaluator.acceptance_fixture_commitments)) {
      strictEqual(fixture.status, 'required_in_controlled_source');
    }
    deepStrictEqual(
      task.evaluator.acceptance_fixture_commitments,
      priorTask.evaluator.acceptance_fixture_commitments,
    );
  }
});

await test('the four runtime revisions use one common empirically justified budget', () => {
  const tasks = buildCatalog().tasks.filter(({ task_id }) =>
    EXPECTED_REVISED_TASK_IDS.includes(task_id),
  );
  for (const task of tasks) {
    deepStrictEqual(task.budget, { wall_seconds: 1500, max_steps: 48, max_tool_calls: 40 });
    strictEqual(task.design_revision.kind, 'runtime_budget_revision');
    strictEqual(task.design_revision.objective.includes('every model configuration'), true);
    strictEqual(task.design_revision.task_specific_delta.includes('900 wall seconds'), true);
  }
});

await test('the closed schemas bind the 1.0.6 release and revision provenance', async () => {
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

  deepStrictEqual(designProperties.supersedes_task_version, { const: '1.0.5' });
  deepStrictEqual(designProperties.kind, {
    enum: ['runtime_budget_revision', 'carry_forward'],
  });
  deepStrictEqual(provenanceProperties.origin, {
    enum: ['runtime_budget_revision', 'release_carry_forward'],
  });
  deepStrictEqual(provenanceProperties.predecessor_task_version, { const: '1.0.5' });
  deepStrictEqual(provenanceProperties.source, {
    const: 'scripts/candidates/aiq-core-1.0.6/generate-benchmark-catalog.ts',
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
    '^aiq-acceptance://[a-z0-9-]+-[0-9]{2}/v(?:2|3|4|5)/(?:gold|alternate-correct|partial|adversarial-format|empty|timeout)(?![\\s\\S])',
  );
  strictEqual(source.includes('aiq-core/1\\\\.0\\\\.6/'), true);
  strictEqual(source.includes('aiq-core/1\\\\.0\\\\.5/'), false);
});

await test('the active task schema accepts only AIQ Core 1.0.6 controlled references', async () => {
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

  deepStrictEqual(properties.task_version, { const: '1.0.6' });
  deepStrictEqual(properties.scorer_version, { const: '1.0.6' });
  strictEqual(controlledReference.test('aiq-controlled-fixture://aiq-core/1.0.6/coding-01'), true);
  strictEqual(
    controlledReference.test('aiq-controlled-acceptance://aiq-core/1.0.6/coding-01'),
    true,
  );
  strictEqual(controlledReference.test('aiq-controlled-fixture://aiq-core/1.0.5/coding-01'), false);
});

await test('the checked-in 1.0.5 generated artifacts remain unchanged', async () => {
  const expected = new Map([
    ['catalog.json', '01a675c52623a87c980e4bf251bd0864f4130a218876437ae08c84593a626570'],
    ['catalog.schema.json', '894cb1d8b91f91c512a5a8d051c57257a82860ae0a80996048f2febf8c2bc4d5'],
    ['task.schema.json', '36c9e139307592a21b9df9d3ab6a9330bbc7e5c0a95af301cf445cd0e69c4b49'],
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
    new URL('../aiq-core-1.0.5/generate-benchmark-catalog.ts', import.meta.url),
  );
  strictEqual(
    createHash('sha256').update(priorGenerator).digest('hex'),
    '21a39b5fb48fee27c23d231326d4933d0895a33a62f1008041e863cdb59e1b21',
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
  } as Catalog106;

  notStrictEqual(
    taskMetadataIdentityDigest(changed.tasks),
    AIQ_CORE_1_0_6_TASK_METADATA_IDENTITY_SHA256,
  );
  throws(
    () => assertCatalogInvariants(changed),
    /four runtime-budget revisions|revision metadata/u,
  );
});
