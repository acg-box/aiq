import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import type { InitializationReceipt, PreparedInitialization } from './init.ts';
import { canonicalSchemaNames, cleanupSql, inventorySql, resetDatabase } from './reset.ts';

const root = resolve(import.meta.dirname, '..');
const databaseUrl = 'postgresql://postgres:test@127.0.0.1:5432/postgres';
const environment = {
  PATH: process.env.PATH,
  NODE_ENV: 'test',
  AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET: 'true',
  AIQ_DATABASE_URL: databaseUrl,
  AIQ_SUPABASE_SERVICE_ROLE_KEY: 'test-token',
};

const initializationReceipt = {
  schema_version: 'aiq.production-initialization-receipt.v1',
  initialized: true,
  scoring_version: '1.0.7',
  measurement_version: '2.0.0',
  catalog_identity_sha256: 'sha256:test',
  catalog_release_identity_sha256: 'sha256:test',
  corpus_commitment_sha256: 'sha256:test',
  corpus_release_id: 'corpus_test',
  task_set_identity_sha256: 'sha256:test',
  evaluator_identity_sha256: 'sha256:test',
  task_count: 72,
  model_config_count: 17,
  public_node_count: 3,
  private_table_count: 40,
  forced_rls_table_count: 40,
  public_view_count: 12,
  security_invoker_view_count: 12,
  hardened_gateway_role_count: 2,
  node_ids: { runner: 'runner', verifier: 'verifier', publisher: 'publisher' },
} satisfies InitializationReceipt;

async function prepareFixture(): Promise<PreparedInitialization> {
  return {
    schema: await readFile(resolve(root, 'databases/schema.sql'), 'utf8'),
    sql: '-- validated test preparation',
    receipt: initializationReceipt,
  };
}

function storageCommitment(paths: readonly string[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(paths)).digest('hex')}`;
}

const occupiedInventory = {
  schema_exists: true,
  roles: ['aiq_publisher', 'aiq_verifier'],
  public_functions: ['aiq_enqueue_submission'],
  public_views: ['public_runs'],
  storage_buckets: [
    { id: 'aiq-runner-artifacts', name: 'aiq-runner-artifacts' },
    { id: 'aiq-submission-packages', name: 'aiq-submission-packages' },
  ],
  unexpected_namespaces: [],
  unexpected_external_dependencies: [],
  unexpected_public_functions: [],
  unexpected_public_relations: [],
  unexpected_public_view_name_collisions: [],
  unexpected_roles: [],
  unexpected_storage_buckets: [],
  unexpected_role_memberships: [],
  unexpected_role_dependencies: [],
};

const emptyInventory = {
  schema_exists: false,
  roles: [],
  public_functions: [],
  public_views: [],
  storage_buckets: [],
  unexpected_namespaces: [],
  unexpected_external_dependencies: [],
  unexpected_public_functions: [],
  unexpected_public_relations: [],
  unexpected_public_view_name_collisions: [],
  unexpected_roles: [],
  unexpected_storage_buckets: [],
  unexpected_role_memberships: [],
  unexpected_role_dependencies: [],
};

const storageClearedInventory = { ...occupiedInventory, storage_buckets: [] };

async function psqlFixture(inventories: readonly unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aiq-reset-test-'));
  const command = join(directory, 'psql');
  const state = join(directory, 'state');
  await writeFile(
    command,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
let sql = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { sql += chunk; });
process.stdin.on('end', () => {
  if (!sql.trimStart().startsWith('select json_build_object(')) process.exit(0);
  let index = 0;
  try { index = Number(readFileSync(${JSON.stringify(state)}, 'utf8')); } catch {}
  const values = ${JSON.stringify(inventories)};
  process.stdout.write(JSON.stringify(values[index]) + '\\n');
  writeFileSync(${JSON.stringify(state)}, String(index + 1));
});
`,
  );
  await chmod(command, 0o700);
  return command;
}

function storageFetch(calls: { url: string; method: string; body: unknown }[]): typeof fetch {
  const listed = new Map<string, number>();
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const method = init?.method ?? 'GET';
    if (init?.body !== undefined && typeof init.body !== 'string') {
      throw new Error('test expected a JSON string request body');
    }
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url.includes('/object/list/')) {
      const key = `${url}:${JSON.stringify(body)}`;
      const count = listed.get(key) ?? 0;
      listed.set(key, count + 1);
      if (count > 0) return Response.json([]);
      if (typeof body === 'object' && body !== null && 'prefix' in body && body.prefix !== '')
        return Response.json([{ name: 'nested.txt', id: 'object-id', metadata: {} }]);
      return Response.json([
        { name: 'root.txt', id: 'object-id', metadata: {} },
        { name: 'folder', id: null, metadata: null },
      ]);
    }
    return Response.json({}, { status: 200 });
  };
}

void test('canonical names come from schema.sql and include all overload names once', async () => {
  const names = canonicalSchemaNames(await readFile(resolve(root, 'databases/schema.sql'), 'utf8'));
  strictEqual(names.views.length, 12);
  strictEqual(names.policies.length, 19);
  strictEqual(
    names.policies.every(({ schema }) => schema === 'aiq_private'),
    true,
  );
  strictEqual(names.functions.includes('aiq_enqueue_submission'), true);
  strictEqual(names.functions.includes('public_trend_points'), true);
  strictEqual(new Set(names.functions).size, names.functions.length);
  const inventory = inventorySql(names);
  const cleanup = cleanupSql(names);
  strictEqual(inventory.includes("'unexpected_role_memberships'"), true);
  strictEqual(cleanup.includes('pg_catalog.pg_auth_members'), true);
  strictEqual(cleanup.includes('$aiq_reset_boundary_guard$'), true);
  strictEqual(cleanup.includes('-- AIQ_RESET_BOUNDARY_LOCKED'), true);
});

void test('destructive reset fails before inventory without the exact confirmation', async () => {
  await rejects(
    resetDatabase({
      dryRun: false,
      referencePath: '/controlled/reference.json',
      environment,
      dependencies: { psqlCommand: '/not/invoked' },
    }),
    /--confirm xxnszykaeapolqdnhalx:aiq_private/,
  );
});

void test('missing, malformed, and invalid references have zero reset side effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aiq-reset-reference-preflight-'));
  const malformedPath = join(directory, 'malformed.json');
  const invalidPath = join(directory, 'invalid.json');
  await writeFile(malformedPath, '{not-json');
  await writeFile(invalidPath, '{}');
  await Promise.all(
    [undefined, malformedPath, invalidPath].map(async (referencePath) => {
      let fetchCount = 0;
      let initializationCount = 0;
      const fetchImplementation: typeof fetch = async () => {
        fetchCount += 1;
        return Response.json([]);
      };
      await rejects(
        resetDatabase({
          dryRun: false,
          confirmation: 'xxnszykaeapolqdnhalx:aiq_private',
          ...(referencePath === undefined ? {} : { referencePath }),
          repositoryRoot: root,
          environment,
          dependencies: {
            psqlCommand: '/must-not-run',
            fetch: fetchImplementation,
            initialize: async () => {
              initializationCount += 1;
              return initializationReceipt;
            },
          },
        }),
        /reference/,
      );
      strictEqual(fetchCount, 0);
      strictEqual(initializationCount, 0);
    }),
  );
});

void test('dry run inventories database and recursively inventories both private buckets', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const result = await resetDatabase({
    dryRun: true,
    environment,
    dependencies: {
      psqlCommand: await psqlFixture([occupiedInventory]),
      fetch: storageFetch(calls),
    },
  });
  if (!('storage' in result)) throw new Error('expected dry-run inventory');
  const privatePaths = ['folder/nested.txt', 'root.txt'];
  deepStrictEqual(result.storage['aiq-runner-artifacts'], {
    object_count: 2,
    object_paths_sha256: storageCommitment(privatePaths),
  });
  deepStrictEqual(result.storage['aiq-submission-packages'], {
    object_count: 2,
    object_paths_sha256: storageCommitment(privatePaths),
  });
  strictEqual(JSON.stringify(result).includes('nested.txt'), false);
  strictEqual(JSON.stringify(result).includes('root.txt'), false);
  strictEqual(
    calls.some(({ method }) => method === 'DELETE'),
    false,
  );
});

void test('reset removes Storage objects before buckets, reads back database cleanup, and delegates initialization', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let initializationCount = 0;
  const result = await resetDatabase({
    dryRun: false,
    confirmation: 'xxnszykaeapolqdnhalx:aiq_private',
    referencePath: '/controlled/reference.json',
    environment,
    dependencies: {
      psqlCommand: await psqlFixture([occupiedInventory, storageClearedInventory, emptyInventory]),
      fetch: storageFetch(calls),
      prepare: prepareFixture,
      initialize: async (options) => {
        initializationCount += 1;
        strictEqual(options.referencePath, '/controlled/reference.json');
        strictEqual(options.preparedInitialization?.receipt, initializationReceipt);
        return initializationReceipt;
      },
    },
  });
  strictEqual(initializationCount, 1);
  strictEqual('reset' in result && result.reset, true);
  for (const bucket of ['aiq-runner-artifacts', 'aiq-submission-packages']) {
    const bucketDelete = calls.findIndex(({ url }) => url.endsWith(`/bucket/${bucket}`));
    const objectDeleteForBucket = calls.findIndex(
      ({ url, method }) => url.endsWith(`/object/${bucket}`) && method === 'DELETE',
    );
    strictEqual(bucketDelete > objectDeleteForBucket, true);
  }
  strictEqual(
    calls.findIndex(({ url }) => url.endsWith('/bucket/aiq-runner-artifacts')) <
      calls.findIndex(({ url }) => url.endsWith('/bucket/aiq-submission-packages')),
    true,
  );
  const objectDelete = calls.find(
    ({ method, url }) => method === 'DELETE' && url.includes('/object/'),
  );
  deepStrictEqual(objectDelete?.body, { prefixes: ['folder/nested.txt', 'root.txt'] });
  strictEqual(JSON.stringify(result).includes('nested.txt'), false);
  strictEqual(JSON.stringify(result).includes('root.txt'), false);
});

void test('reset aborts on Storage identity drift before any Storage request', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  await rejects(
    resetDatabase({
      dryRun: true,
      environment,
      dependencies: {
        psqlCommand: await psqlFixture([
          {
            ...occupiedInventory,
            storage_buckets: [{ id: 'aiq-runner-artifacts', name: 'renamed' }],
          },
        ]),
        fetch: storageFetch(calls),
      },
    }),
    /bucket identity drift/,
  );
  deepStrictEqual(calls, []);
});

void test('reset rejects dependency, policy, and canonical relation drift before Storage', async () => {
  await Promise.all(
    [
      { unexpected_external_dependencies: ['rule _RETURN on view public.consumer_view'] },
      { unexpected_public_view_name_collisions: ['public_runs'] },
      { unexpected_role_memberships: ['reset_unrelated_user is a member of aiq_verifier'] },
      { unexpected_role_dependencies: ['policy reset_external_aiq_role on reset_unrelated'] },
    ].map(async (drift) => {
      const calls: { url: string; method: string; body: unknown }[] = [];
      await rejects(
        resetDatabase({
          dryRun: false,
          confirmation: 'xxnszykaeapolqdnhalx:aiq_private',
          referencePath: '/controlled/reference.json',
          environment,
          dependencies: {
            psqlCommand: await psqlFixture([{ ...occupiedInventory, ...drift }]),
            fetch: storageFetch(calls),
            prepare: prepareFixture,
          },
        }),
        /namespace drift/,
      );
      deepStrictEqual(calls, []);
    }),
  );
});

void test('Storage request failure waits for readback, reports partial state, and remains retry-safe', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let listCount = 0;
  let deleteCount = 0;
  let slowDeleteCompleted = false;
  let readbackStartedBeforeWorkersSettled = false;
  let initialized = false;
  const fetchImplementation: typeof fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/object/list/aiq-runner-artifacts')) {
      listCount += 1;
      if (deleteCount > 0) {
        readbackStartedBeforeWorkersSettled = !slowDeleteCompleted;
        return Response.json([{ name: 'remaining.txt', id: 'object-id', metadata: {} }]);
      }
      if (isListBody(body) && body.offset === 0) {
        return Response.json(
          Array.from({ length: 100 }, (_, index) => ({
            name: `object-${String(index).padStart(3, '0')}.txt`,
            id: `object-${index}`,
            metadata: {},
          })),
        );
      }
      if (isListBody(body) && body.offset === 100) {
        return Response.json([{ name: 'object-100.txt', id: 'object-100', metadata: {} }]);
      }
      return Response.json([{ name: 'remaining.txt', id: 'object-id', metadata: {} }]);
    }
    if (url.endsWith('/object/aiq-runner-artifacts') && method === 'DELETE') {
      deleteCount += 1;
      if (isDeleteBody(body) && body.prefixes.includes('object-000.txt')) {
        return Response.json({}, { status: 500 });
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(() => {
          slowDeleteCompleted = true;
          resolvePromise();
        }, 5);
      });
      return Response.json({});
    }
    return Response.json([]);
  };
  await rejects(
    resetDatabase({
      dryRun: false,
      confirmation: 'xxnszykaeapolqdnhalx:aiq_private',
      referencePath: '/controlled/reference.json',
      environment,
      dependencies: {
        psqlCommand: await psqlFixture([
          {
            ...occupiedInventory,
            storage_buckets: [{ id: 'aiq-runner-artifacts', name: 'aiq-runner-artifacts' }],
          },
        ]),
        fetch: fetchImplementation,
        prepare: prepareFixture,
        initialize: async () => {
          initialized = true;
          throw new Error('initialization must not run');
        },
      },
    }),
    /deletion for aiq-runner-artifacts was partial; 1 objects remain; rerun the reset/,
  );
  strictEqual(listCount, 3);
  strictEqual(deleteCount, 2);
  strictEqual(readbackStartedBeforeWorkersSettled, false);
  strictEqual(initialized, false);
  strictEqual(
    calls.some(({ url }) => url.endsWith('/bucket/aiq-runner-artifacts')),
    false,
  );
  strictEqual(
    calls.some(({ url, method }) => url.includes('aiq-submission-packages') && method === 'DELETE'),
    false,
  );
});

function isListBody(value: unknown): value is { offset: number } {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'offset') === 'number'
  );
}

function isDeleteBody(value: unknown): value is { prefixes: string[] } {
  const prefixes: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'prefixes') : null;
  return Array.isArray(prefixes) && prefixes.every((item: unknown) => typeof item === 'string');
}
