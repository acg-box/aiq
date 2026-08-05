import { deepStrictEqual, notStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AIQ_CORE_1_0_4_CATALOG_RELEASE_IDENTITY_SHA256,
  AIQ_CORE_1_0_4_TASK_METADATA_IDENTITY_SHA256,
  REVISED_TASK_IDS,
  assertCatalogInvariants,
  buildCatalog,
  catalogReleaseIdentityDigest,
  taskMetadataIdentityDigest,
  type Catalog104,
} from './generate-benchmark-catalog.ts';

type JsonObject = Record<string, unknown>;

const candidateRoot = new URL('../../../benchmarks/candidates/aiq-core-1.0.4/', import.meta.url);
const catalogPath = fileURLToPath(new URL('catalog.json', candidateRoot));
const catalogSchemaPath = fileURLToPath(new URL('catalog.schema.json', candidateRoot));
const taskSchemaPath = fileURLToPath(new URL('task.schema.json', candidateRoot));

const EXPECTED_REVISED_TASK_IDS = [
  'coding-01',
  'coding-03',
  'coding-05',
  'coding-07',
  'data-processing-02',
  'debugging-01',
  'debugging-02',
  'debugging-03',
  'debugging-04',
  'debugging-05',
];

function jsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as JsonObject;
}

await test('the generated 1.0.4 catalog is deterministic and identity-frozen', async () => {
  const generated = buildCatalog();
  const committed: unknown = JSON.parse(await readFile(catalogPath, 'utf8'));

  assertCatalogInvariants(generated);
  deepStrictEqual(committed, generated);
  strictEqual(generated.task_set_version, '1.0.4');
  strictEqual(generated.scoring_version, '1.0.4');
  strictEqual(generated.tasks.length, 72);
  strictEqual(
    taskMetadataIdentityDigest(generated.tasks),
    AIQ_CORE_1_0_4_TASK_METADATA_IDENTITY_SHA256,
  );
  strictEqual(
    catalogReleaseIdentityDigest(generated.catalog_release_identity),
    AIQ_CORE_1_0_4_CATALOG_RELEASE_IDENTITY_SHA256,
  );
});

await test('nine ceiling tasks and one contract defect are revised while 62 carry forward', () => {
  const catalog = buildCatalog();
  const retargeted = catalog.tasks
    .filter(({ design_revision }) => design_revision.kind === 'ceiling_retargeted')
    .map(({ task_id }) => task_id)
    .toSorted();
  const carriedForward = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'carry_forward',
  );
  const repaired = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'contract_repaired',
  );

  deepStrictEqual(REVISED_TASK_IDS, EXPECTED_REVISED_TASK_IDS);
  deepStrictEqual(
    retargeted,
    EXPECTED_REVISED_TASK_IDS.filter((taskId) => taskId !== 'data-processing-02'),
  );
  deepStrictEqual(
    repaired.map(({ task_id }) => task_id),
    ['data-processing-02'],
  );
  strictEqual(carriedForward.length, 62);
  for (const task of catalog.tasks) {
    strictEqual(task.design_revision.supersedes_task_version, '1.0.3');
    strictEqual(task.provenance.predecessor_task_version, '1.0.3');
    strictEqual(
      task.provenance.origin,
      task.task_id === 'data-processing-02'
        ? 'contract_repair'
        : retargeted.includes(task.task_id)
          ? 'calibration_driven_revision'
          : 'release_carry_forward',
    );
  }
});

await test('revised tasks use new public contracts without publishing private content', () => {
  const catalog = buildCatalog();

  for (const task of catalog.tasks) {
    const retargeted = EXPECTED_REVISED_TASK_IDS.includes(task.task_id);
    strictEqual(task.visibility, 'hidden');
    strictEqual(task.input_contract.content_handle.includes('/1.0.4/'), true);
    strictEqual(task.evaluator.scorer_version, '1.0.4');
    strictEqual(task.leakage_review.notes.includes('outside Git'), true);
    for (const fixture of Object.values(task.evaluator.acceptance_fixture_commitments)) {
      strictEqual(fixture.handle.includes(retargeted ? '/v3/' : '/v2/'), true);
      strictEqual(fixture.status, 'required_in_controlled_source');
    }
  }
});

await test('the closed schemas bind the 1.0.4 release and revision provenance', async () => {
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
  const source = await readFile(taskSchemaPath, 'utf8');

  deepStrictEqual(designProperties.supersedes_task_version, { const: '1.0.3' });
  deepStrictEqual(designProperties.kind, {
    enum: ['ceiling_retargeted', 'contract_repaired', 'carry_forward'],
  });
  deepStrictEqual(provenanceProperties.origin, {
    enum: ['calibration_driven_revision', 'contract_repair', 'release_carry_forward'],
  });
  deepStrictEqual(provenanceProperties.predecessor_task_version, { const: '1.0.3' });
  deepStrictEqual(provenanceProperties.source, {
    const: 'scripts/candidates/aiq-core-1.0.4/generate-benchmark-catalog.ts',
  });
  strictEqual(source.includes('aiq-core/1\\\\.0\\\\.4/'), true);
  strictEqual(source.includes('aiq-core/1\\\\.0\\\\.3/'), false);
});

await test('catalog invariants reject revision and metadata drift', () => {
  const catalog = buildCatalog();
  const firstTask = catalog.tasks[0];
  if (firstTask === undefined) throw new RangeError('Expected a catalog task.');

  const changed = {
    ...catalog,
    tasks: [
      {
        ...firstTask,
        design_revision: { ...firstTask.design_revision, kind: 'carry_forward' as const },
      },
      ...catalog.tasks.slice(1),
    ],
  } as Catalog104;

  notStrictEqual(
    taskMetadataIdentityDigest(changed.tasks),
    AIQ_CORE_1_0_4_TASK_METADATA_IDENTITY_SHA256,
  );
  throws(() => assertCatalogInvariants(changed), /nine ceiling-retargeted|revision metadata/u);
});
