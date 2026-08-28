import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assertDecisionManifest,
  buildCatalog,
  buildCatalogFrom,
  parseDecisionManifest,
  type CandidateDecisionManifest,
} from './generate-benchmark-catalog.ts';

type JsonObject = Record<string, unknown>;

const candidateRoot = new URL('../../../benchmarks/candidates/aiq-core-1.1.0/', import.meta.url);

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((entry, index) => jsonObject(entry, `${label}[${String(index)}]`));
}

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new TypeError(`${label} is missing.`);
  return value;
}

async function decisions(): Promise<CandidateDecisionManifest> {
  const value: unknown = JSON.parse(
    await readFile(new URL('design-decisions.json', candidateRoot), 'utf8'),
  );
  return parseDecisionManifest(value);
}

await test('the generated 1.1.0 source foundation is deterministic', async () => {
  const catalog = buildCatalog();

  deepStrictEqual(
    JSON.parse(await readFile(new URL('catalog.json', candidateRoot), 'utf8')),
    catalog,
  );
  strictEqual(catalog.schema_version, 'aiq.catalog.v2');
  strictEqual(catalog.task_set_version, '1.1.0');
  strictEqual(catalog.scoring_version, '1.0.6');
  strictEqual(catalog.status, 'draft_source_foundation');
});

await test('all 72 predecessor tasks have one explicit ordered design decision', async () => {
  const manifest = await decisions();
  const catalog = buildCatalog();
  const tasks = objectArray(catalog.tasks, 'candidate tasks');
  const taskIds = tasks.map((task) => String(task.task_id));

  assertDecisionManifest(manifest, taskIds);
  strictEqual(manifest.decisions.length, 72);
  strictEqual(new Set(manifest.decisions.map((decision) => decision.task_id)).size, 72);
  for (const [index, task] of tasks.entries()) {
    const design = jsonObject(task.design_revision, 'design revision');
    const decision = requiredAt(manifest.decisions, index, 'task decision');

    strictEqual(task.task_id, decision.task_id);
    strictEqual(design.decision, decision.decision);
    strictEqual(design.task_specific_delta, decision.rationale);
    strictEqual(
      design.decision_record,
      'benchmarks/candidates/aiq-core-1.1.0/design-decisions.json',
    );
  }
});

await test('the candidate has exactly 60 bounded within-domain clusters', () => {
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');
  const clusters = new Map<string, JsonObject[]>();
  for (const task of tasks) {
    const cluster = String(task.cluster_id);
    clusters.set(cluster, [...(clusters.get(cluster) ?? []), task]);
  }

  strictEqual(clusters.size, 60);
  for (const members of clusters.values()) {
    strictEqual(members.length <= 2, true);
    if (members.length > 1) {
      strictEqual(new Set(members.map((task) => task.domain)).size, 1);
    }
  }
});

await test('catalog fixture declarations are the only expected-class authority', async () => {
  const catalog = buildCatalog();
  const tasks = objectArray(catalog.tasks, 'candidate tasks');
  const sourceFoundation = jsonObject(catalog.source_foundation, 'source foundation');

  deepStrictEqual(sourceFoundation.legacy_observed_fixture_counts, { empty: 57, timeout: 4 });
  strictEqual(sourceFoundation.private_fixture_mapping_reconciled, false);
  strictEqual(sourceFoundation.sealing_allowed, false);
  for (const task of tasks) {
    const evaluator = jsonObject(task.evaluator, 'evaluator');
    const fixtures = jsonObject(evaluator.acceptance_fixture_commitments, 'fixture commitments');
    for (const fixtureClass of ['gold', 'alternate_correct', 'partial', 'adversarial_format']) {
      strictEqual(jsonObject(fixtures[fixtureClass], fixtureClass).applicability, 'required');
    }
    for (const fixtureClass of ['empty', 'timeout']) {
      const fixture = jsonObject(fixtures[fixtureClass], fixtureClass);
      strictEqual(fixture.applicability, 'pending_private_reconciliation');
      strictEqual(fixture.handle, null);
    }
  }
});

await test('the weighted binary task scorer formula is unchanged', async () => {
  const predecessorValue: unknown = JSON.parse(
    await readFile(
      new URL('../../../benchmarks/candidates/aiq-core-1.0.7/catalog.json', import.meta.url),
      'utf8',
    ),
  );
  const predecessor = jsonObject(predecessorValue, 'predecessor catalog');
  const predecessorTasks = objectArray(predecessor.tasks, 'predecessor tasks');
  const candidateTasks = objectArray(buildCatalog().tasks, 'candidate tasks');

  for (const [index, task] of candidateTasks.entries()) {
    const candidateEvaluator = jsonObject(task.evaluator, 'candidate evaluator');
    const predecessorEvaluator = jsonObject(
      requiredAt(predecessorTasks, index, 'predecessor task').evaluator,
      'predecessor evaluator',
    );
    deepStrictEqual(candidateEvaluator.scoring_contract, predecessorEvaluator.scoring_contract);
    strictEqual(candidateEvaluator.scorer_version, '1.0.6');
  }
});

await test('missing, duplicate, or reordered decision records fail closed', async () => {
  const manifest = await decisions();
  const taskIds = objectArray(buildCatalog().tasks, 'candidate tasks').map((task) =>
    String(task.task_id),
  );

  const missing: CandidateDecisionManifest = {
    ...manifest,
    decisions: manifest.decisions.filter((_, index) => index !== 1),
  };
  throws(
    () => assertDecisionManifest(missing, taskIds),
    /decision-manifest authority|Every predecessor task/u,
  );

  const first = requiredAt(manifest.decisions, 0, 'first decision');
  const duplicated: CandidateDecisionManifest = {
    ...manifest,
    decisions: manifest.decisions.map((decision, index) => (index === 1 ? first : decision)),
  };
  throws(() => buildCatalogFrom(duplicated), /Every predecessor task/u);

  const second = requiredAt(manifest.decisions, 1, 'second decision');
  const reordered: CandidateDecisionManifest = {
    ...manifest,
    decisions: [second, first, ...manifest.decisions.slice(2)],
  };
  throws(() => buildCatalogFrom(reordered), /Every predecessor task/u);
});

await test('candidate schemas version fixture applicability without changing task scorer', async () => {
  const catalogSchemaValue: unknown = JSON.parse(
    await readFile(new URL('catalog.schema.json', candidateRoot), 'utf8'),
  );
  const taskSchemaValue: unknown = JSON.parse(
    await readFile(new URL('task.schema.json', candidateRoot), 'utf8'),
  );
  const catalogSchema = jsonObject(catalogSchemaValue, 'catalog schema');
  const taskSchema = jsonObject(taskSchemaValue, 'task schema');
  const catalogProperties = jsonObject(catalogSchema.properties, 'catalog properties');
  const taskProperties = jsonObject(taskSchema.properties, 'task properties');
  const definitions = jsonObject(catalogSchema.$defs, 'catalog definitions');
  const fixtureCommitment = jsonObject(
    definitions.acceptanceFixtureCommitment,
    'fixture commitment schema',
  );
  const fixtureProperties = jsonObject(fixtureCommitment.properties, 'fixture properties');
  const handleSchema = jsonObject(fixtureProperties.handle, 'fixture handle schema');
  const handlePattern = new RegExp(String(handleSchema.pattern));

  deepStrictEqual(catalogProperties.schema_version, { const: 'aiq.catalog.v2' });
  deepStrictEqual(catalogProperties.task_set_version, { const: '1.1.0' });
  deepStrictEqual(taskProperties.task_version, { const: '1.1.0' });
  deepStrictEqual(taskProperties.scorer_version, { const: '1.0.6' });
  for (const task of objectArray(buildCatalog().tasks, 'candidate tasks')) {
    const evaluator = jsonObject(task.evaluator, 'candidate evaluator');
    const fixtures = jsonObject(evaluator.acceptance_fixture_commitments, 'fixture commitments');
    for (const fixture of Object.values(fixtures).map((value) =>
      jsonObject(value, 'fixture commitment'),
    )) {
      if (fixture.handle === null) continue;
      strictEqual(typeof fixture.handle, 'string');
      if (typeof fixture.handle !== 'string')
        throw new TypeError('Fixture handle must be a string.');
      strictEqual(handlePattern.test(fixture.handle), true);
    }
  }
});
