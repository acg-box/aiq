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

async function predecessorCatalog(): Promise<JsonObject> {
  const value: unknown = JSON.parse(
    await readFile(
      new URL('../../../benchmarks/candidates/aiq-core-1.0.7/catalog.json', import.meta.url),
      'utf8',
    ),
  );
  return jsonObject(value, 'predecessor catalog');
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
  strictEqual(catalog.status, 'frozen_candidate');
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
    strictEqual(design.kind, 'frozen_candidate_authoring');
    strictEqual(
      design.decision_record,
      'benchmarks/candidates/aiq-core-1.1.0/design-decisions.json',
    );
  }
});

await test('retained and revised provenance is complete in every domain', async () => {
  const manifest = await decisions();
  const candidateTasks = objectArray(buildCatalog().tasks, 'candidate tasks');
  const predecessorTasks = objectArray((await predecessorCatalog()).tasks, 'predecessor tasks');
  const expected = {
    coding: { retained: 2, revised: 6 },
    debugging: { retained: 2, revised: 6 },
    repository_understanding: { retained: 0, revised: 7 },
    data_processing: { retained: 4, revised: 4 },
    retrieval_verification: { retained: 3, revised: 4 },
    documentation_communication: { retained: 1, revised: 6 },
    planning_execution: { retained: 0, revised: 7 },
    tool_use: { retained: 1, revised: 6 },
    instruction_following: { retained: 1, revised: 5 },
    reliability_recovery: { retained: 2, revised: 5 },
  } as const;
  const observed = Object.fromEntries(
    Object.keys(expected).map((domain) => [domain, { retained: 0, revised: 0 }]),
  );

  strictEqual(manifest.private_reconciliation_required, false);
  strictEqual(manifest.historical_evidence.semantic_complete_matrices, 2);
  strictEqual(manifest.historical_evidence.coverage_aware_diagnostic_runs, 5);
  deepStrictEqual(
    manifest.historical_evidence.numeric_semantic_cells,
    [1224, 1223, 1222, 1224, 1221, 1223, 1222],
  );
  strictEqual(manifest.historical_evidence.qualification_evidence, false);

  for (const [index, task] of candidateTasks.entries()) {
    const decision = requiredAt(manifest.decisions, index, 'task decision');
    const predecessor = requiredAt(predecessorTasks, index, 'predecessor task');
    const domain = String(task.domain);
    const counts = jsonObject(observed[domain], `${domain} counts`);
    counts[decision.decision] = Number(counts[decision.decision]) + 1;
    const provenance = jsonObject(task.provenance, 'candidate provenance');

    strictEqual(provenance.origin, 'evidence_selected_candidate_authoring');
    if (decision.decision === 'retained') {
      strictEqual(decision.public_task_revision, null);
      for (const field of ['title', 'summary', 'allowed_tools', 'tags']) {
        deepStrictEqual(task[field], predecessor[field]);
      }
      const input = jsonObject(task.input_contract, 'candidate input contract');
      const priorInput = jsonObject(predecessor.input_contract, 'predecessor input contract');
      const evaluator = jsonObject(task.evaluator, 'candidate evaluator');
      const priorEvaluator = jsonObject(predecessor.evaluator, 'predecessor evaluator');
      strictEqual(input.kind, priorInput.kind);
      strictEqual(evaluator.kind, priorEvaluator.kind);
      deepStrictEqual(evaluator.pass_conditions, priorEvaluator.pass_conditions);
    } else {
      strictEqual(decision.public_task_revision !== null, true);
      strictEqual(task.title === predecessor.title, false);
      strictEqual(task.summary === predecessor.summary, false);
      strictEqual(task.cluster_id === predecessor.cluster_id, false);
    }
  }

  deepStrictEqual(observed, expected);
});

await test('the candidate has 72 honest bounded within-domain clusters', () => {
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');
  const clusters = new Map<string, JsonObject[]>();
  for (const task of tasks) {
    const cluster = String(task.cluster_id);
    clusters.set(cluster, [...(clusters.get(cluster) ?? []), task]);
  }

  strictEqual(clusters.size, 72);
  strictEqual(clusters.size >= 60, true);
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
  const candidateState = jsonObject(catalog.candidate_state, 'candidate state');

  deepStrictEqual(candidateState.legacy_observed_fixture_counts, { empty: 57, timeout: 4 });
  strictEqual(candidateState.private_fixture_mapping_reconciled, true);
  strictEqual(candidateState.private_tasks_authored, true);
  strictEqual(candidateState.independent_review_status, 'pending');
  strictEqual(candidateState.seal_status, 'pending');
  strictEqual(candidateState.qualification_status, 'pending');
  strictEqual(candidateState.release_status, 'pending');
  strictEqual(candidateState.active, false);
  strictEqual(candidateState.production_publishable, false);
  for (const task of tasks) {
    const evaluator = jsonObject(task.evaluator, 'evaluator');
    const fixtures = jsonObject(evaluator.acceptance_fixture_commitments, 'fixture commitments');
    for (const fixtureClass of [
      'gold',
      'alternate_correct',
      'partial',
      'adversarial_format',
      'empty',
    ]) {
      strictEqual(jsonObject(fixtures[fixtureClass], fixtureClass).applicability, 'required');
    }
    const timeout = jsonObject(fixtures.timeout, 'timeout');
    strictEqual(timeout.applicability, 'not_applicable');
    strictEqual(timeout.handle, null);
  }
  strictEqual(JSON.stringify(catalog).includes('pending_private_reconciliation'), false);
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

await test('the frozen public candidate has no execution or evaluator deadlines', () => {
  const catalog = buildCatalog();
  const tasks = objectArray(catalog.tasks, 'candidate tasks');
  const forbiddenDeadlineFields = [
    'timeout_ms',
    'timeout_seconds',
    'deadline_ms',
    'deadline_seconds',
    'max_elapsed_ms',
    'max_duration_ms',
    'scenario_timeout_ms',
  ];

  for (const task of tasks) {
    deepStrictEqual(task.budget, {
      wall_seconds: null,
      max_steps: null,
      max_tool_calls: null,
    });
    const serialized = JSON.stringify(task);
    for (const field of forbiddenDeadlineFields) {
      strictEqual(serialized.includes(`"${field}"`), false);
    }
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
  deepStrictEqual(catalogProperties.status, { const: 'frozen_candidate' });
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
  strictEqual(JSON.stringify(catalogSchema).includes('pending_private_reconciliation'), false);
});
