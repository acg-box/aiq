import { deepStrictEqual, notStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256,
  AIQ_CORE_V1_TASK_METADATA_IDENTITY_SHA256,
  assertCatalogInvariants,
  buildCatalog,
  catalogReleaseIdentityDigest,
  taskMetadataIdentityDigest,
  type Catalog,
  type CatalogReleaseIdentityInput,
} from './generate-benchmark-catalog.ts';

type JsonObject = Record<string, unknown>;

const catalogPath = fileURLToPath(
  new URL('../../../benchmarks/candidates/aiq-core-1.0.2/catalog.json', import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL('../../../benchmarks/candidates/aiq-core-1.0.2/catalog.schema.json', import.meta.url),
);

function jsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object.');
  }
  return Object.fromEntries(Object.entries(value));
}

function cloneCatalog(catalog: Catalog): Catalog {
  return structuredClone(catalog);
}

await test('the generated active catalog is deterministic and keeps all 72 task bytes', async () => {
  const catalog = buildCatalog();
  const committed: unknown = JSON.parse(await readFile(catalogPath, 'utf8'));

  assertCatalogInvariants(catalog);
  deepStrictEqual(committed, catalog);
  strictEqual(catalog.status, 'active');
  strictEqual(catalog.scoring_version, '1.0.2');
  strictEqual(catalog.catalog_release_identity.scoring_version, catalog.scoring_version);
  strictEqual(catalog.tasks.length, 72);
  strictEqual(taskMetadataIdentityDigest(catalog.tasks), AIQ_CORE_V1_TASK_METADATA_IDENTITY_SHA256);
  strictEqual(catalog.catalog_release_identity.digest, AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256);
});

await test('the active catalog has no retired release lifecycle fields', () => {
  const catalog = jsonObject(buildCatalog());
  const forbiddenFields = [
    'predecessor_catalog',
    'release_gate_policy',
    'candidate_status',
    'promotion_state',
    'cutover_state',
    'repeat_ids',
    'repeat_schedule',
  ];

  for (const field of forbiddenFields) {
    strictEqual(field in catalog, false, `unexpected active catalog field: ${field}`);
  }
});

await test('the release identity binds only the declared neutral inputs', () => {
  const catalog = buildCatalog();
  const identity = catalog.catalog_release_identity;
  const input: CatalogReleaseIdentityInput = {
    release_identity: identity.release_identity,
    scoring_version: identity.scoring_version,
    task_metadata_identity: identity.task_metadata_identity,
  };

  deepStrictEqual(identity, {
    ...input,
    algorithm: 'sha256',
    canonicalization: 'aiq.sorted-key-json.v1',
    digest: AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256,
    scope: 'release_identity_scoring_version_and_ordered_task_metadata_identity',
  });
  strictEqual(catalogReleaseIdentityDigest(input), identity.digest);
  notStrictEqual(
    catalogReleaseIdentityDigest({
      ...input,
      task_metadata_identity: {
        ...input.task_metadata_identity,
        digest: `sha256:${'f'.repeat(64)}`,
      },
    }),
    identity.digest,
  );
});

await test('catalog invariants reject task metadata drift', () => {
  const catalog = cloneCatalog(buildCatalog());
  const firstTask = catalog.tasks[0];
  if (firstTask === undefined) throw new RangeError('Expected a catalog task.');

  const changed: Catalog = {
    ...catalog,
    tasks: [{ ...firstTask, title: `${firstTask.title} changed` }, ...catalog.tasks.slice(1)],
  };

  notStrictEqual(
    taskMetadataIdentityDigest(changed.tasks),
    AIQ_CORE_V1_TASK_METADATA_IDENTITY_SHA256,
  );
  throws(() => assertCatalogInvariants(changed), /Task metadata identity/u);
});

await test('the active catalog schema closes the lifecycle-free release identity', async () => {
  const schema = jsonObject(JSON.parse(await readFile(schemaPath, 'utf8')));
  const properties = jsonObject(schema.properties);
  const releaseIdentity = jsonObject(properties.catalog_release_identity);
  const releaseProperties = jsonObject(releaseIdentity.properties);
  const definitions = jsonObject(schema.$defs);

  deepStrictEqual(properties.status, { const: 'active' });
  deepStrictEqual(properties.scoring_version, { const: '1.0.2' });
  strictEqual(properties.predecessor_catalog, undefined);
  strictEqual(properties.release_gate_policy, undefined);
  strictEqual(definitions.releaseGatePolicy, undefined);
  strictEqual(definitions.contrastDefinition, undefined);
  deepStrictEqual(releaseIdentity.required, [
    'release_identity',
    'scoring_version',
    'task_metadata_identity',
    'algorithm',
    'canonicalization',
    'digest',
    'scope',
  ]);
  deepStrictEqual(releaseProperties.release_identity, { const: 'aiq-core/1.0.2' });
  deepStrictEqual(releaseProperties.scoring_version, { const: '1.0.2' });
  deepStrictEqual(releaseProperties.canonicalization, { const: 'aiq.sorted-key-json.v1' });
  deepStrictEqual(releaseProperties.scope, {
    const: 'release_identity_scoring_version_and_ordered_task_metadata_identity',
  });
});
