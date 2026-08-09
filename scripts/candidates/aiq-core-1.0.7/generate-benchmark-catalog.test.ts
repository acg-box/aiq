import { deepStrictEqual, notStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  AIQ_CORE_1_0_7_CATALOG_RELEASE_IDENTITY_SHA256,
  AIQ_CORE_1_0_7_CONTRAST_IDENTITY_SHA256,
  AIQ_CORE_1_0_7_TASK_METADATA_IDENTITY_SHA256,
  assertCatalogInvariants,
  buildCatalog,
  buildContrastCatalog,
} from './generate-benchmark-catalog.ts';

type JsonObject = Record<string, unknown>;

const candidateRoot = new URL('../../../benchmarks/candidates/aiq-core-1.0.7/', import.meta.url);

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function objectProperty(value: JsonObject, key: string, label: string): JsonObject {
  return jsonObject(Reflect.get(value, key), label);
}

await test('the generated 1.0.7 catalogs are deterministic and identity-frozen', async () => {
  const catalog = buildCatalog();
  const contrast = buildContrastCatalog(
    JSON.parse(
      await readFile(
        new URL(
          '../../../benchmarks/candidates/aiq-core-1.0.6/contrast-catalog.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown,
  );
  assertCatalogInvariants(catalog, contrast);
  deepStrictEqual(
    JSON.parse(await readFile(new URL('catalog.json', candidateRoot), 'utf8')),
    catalog,
  );
  deepStrictEqual(
    JSON.parse(await readFile(new URL('contrast-catalog.json', candidateRoot), 'utf8')),
    contrast,
  );
  strictEqual(catalog.task_metadata_identity.digest, AIQ_CORE_1_0_7_TASK_METADATA_IDENTITY_SHA256);
  strictEqual(
    catalog.catalog_release_identity.digest,
    AIQ_CORE_1_0_7_CATALOG_RELEASE_IDENTITY_SHA256,
  );
  strictEqual(contrast.identity_sha256, AIQ_CORE_1_0_7_CONTRAST_IDENTITY_SHA256);
});

await test('all formal Core and Contrast tasks are unbounded but retain task scorer 1.0.6', async () => {
  const catalog = buildCatalog();
  const contrast = buildContrastCatalog(
    JSON.parse(
      await readFile(
        new URL(
          '../../../benchmarks/candidates/aiq-core-1.0.6/contrast-catalog.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown,
  );
  strictEqual(catalog.scoring_version, '1.0.6');
  strictEqual(contrast.scoring_version, '1.0.6');
  for (const task of catalog.tasks) {
    deepStrictEqual(task.budget, {
      wall_seconds: null,
      max_steps: null,
      max_tool_calls: null,
    });
    strictEqual(task.task_version, '1.0.7');
    strictEqual(task.evaluator.scorer_version, '1.0.6');
    strictEqual(task.design_revision.kind, 'unbounded_usage_measurement_revision');
  }
  for (const task of contrast.tasks) {
    deepStrictEqual(task.budget, {
      wall_seconds: null,
      max_steps: null,
      max_tool_calls: null,
    });
    strictEqual(task.task_version, '1.0.7');
  }
});

await test('the 1.0.7 candidate schemas require null formal execution limits', async () => {
  const taskSchema = jsonObject(
    JSON.parse(await readFile(new URL('task.schema.json', candidateRoot), 'utf8')) as unknown,
    'task schema',
  );
  const catalogSchema = jsonObject(
    JSON.parse(await readFile(new URL('catalog.schema.json', candidateRoot), 'utf8')) as unknown,
    'catalog schema',
  );
  const taskProperties = objectProperty(taskSchema, 'properties', 'task properties');
  const taskBudgets = objectProperty(taskProperties, 'budgets', 'task budgets');
  deepStrictEqual(objectProperty(taskBudgets, 'properties', 'task budget properties'), {
    wall_seconds: { type: 'null' },
    max_steps: { type: 'null' },
    max_tool_calls: { type: 'null' },
  });
  const definitions = objectProperty(catalogSchema, '$defs', 'catalog definitions');
  const catalogTask = objectProperty(definitions, 'task', 'catalog task');
  const catalogTaskProperties = objectProperty(
    catalogTask,
    'properties',
    'catalog task properties',
  );
  const catalogBudget = objectProperty(catalogTaskProperties, 'budget', 'catalog task budget');
  deepStrictEqual(objectProperty(catalogBudget, 'properties', 'catalog budget properties'), {
    wall_seconds: { type: 'null' },
    max_steps: { type: 'null' },
    max_tool_calls: { type: 'null' },
  });
  deepStrictEqual(taskProperties.task_version, { const: '1.0.7' });
  deepStrictEqual(taskProperties.scorer_version, { const: '1.0.6' });
});

await test('catalog invariants reject a numeric formal limit', async () => {
  const catalog = structuredClone(buildCatalog());
  const contrast = buildContrastCatalog(
    JSON.parse(
      await readFile(
        new URL(
          '../../../benchmarks/candidates/aiq-core-1.0.6/contrast-catalog.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown,
  );
  Reflect.set(catalog.tasks[0]?.budget ?? {}, 'max_tool_calls', 21);
  notStrictEqual(catalog.tasks[0]?.budget.max_tool_calls, null);
  throws(() => assertCatalogInvariants(catalog, contrast), /unbounded task contract/u);
});
