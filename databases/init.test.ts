import assert, { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  assertDatabaseTarget,
  canonicalJson,
  initializeDatabase,
  prepareInitialization,
  prepareInitializationFromFiles,
} from './init.ts';

type JsonObject = Record<string, unknown>;
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '..');
const catalogPath = resolve(repositoryRoot, 'benchmarks/candidates/aiq-core-1.1.0/catalog.json');
const corpusSchemaPath = resolve(
  repositoryRoot,
  'benchmarks/schema/corpus-commitment-v3.schema.json',
);
const schemaPath = resolve(repositoryRoot, 'databases/schema.sql');
const initPath = resolve(repositoryRoot, 'databases/init.ts');
const taskCommitmentsPath = resolve(
  repositoryRoot,
  'databases/aiq-core-1.1.0-task-commitments.json',
);
const taskSetIdentity = 'sha256:c7481e46c64dbf5ff9f50a85c83608d48390a03cbf9e94a1d89ab36aeb6df89a';
const evaluatorIdentity = 'sha256:748e0a6c07eb7e3407cc22d50b65eb6d055305cb6e1d719ca3cfd3a109bec809';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  if (!isObject(value)) {
    throw new Error('fixture value must be an object');
  }
  return value;
}

function mutableArray(value: JsonObject, key: string): unknown[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) throw new Error(`${key} fixture is invalid`);
  const result = Array.from(candidate, (item: unknown) => item);
  value[key] = result;
  return result;
}

function digest(index: number): string {
  return `sha256:${index.toString(16).padStart(64, '0')}`;
}

function capturedNames(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '').toSorted();
}

function publicNode(role: string, byte: number): JsonObject {
  const publicKey = byte.toString(16).padStart(2, '0').repeat(32);
  const fingerprint = `sha256:${createHash('sha256')
    .update(Buffer.from(publicKey, 'hex'))
    .digest('hex')}`;
  return {
    schema_version: 'aiq.public-node-identity.v1',
    role,
    node_id: `node_${fingerprint.slice(7)}`,
    display_name: `Approved ${role}`,
    key_fingerprint: fingerprint,
    signature_algorithm: 'ed25519',
    public_key: publicKey,
    status: 'active',
    trust_tier: role === 'verifier' ? 'independently_reproduced' : 'trusted_verified',
    operator_class: role === 'verifier' ? 'verifier' : 'official',
    capabilities: [role],
    source: 'controlled identity ceremony',
    signature_status: 'verified',
    provenance: 'approved production identity',
    synthetic: false,
    public_visible: true,
  };
}

async function catalogFixture(): Promise<JsonObject> {
  return object(JSON.parse(await readFile(catalogPath, 'utf8')));
}

async function corpusSchemaFixture(): Promise<JsonObject> {
  return object(JSON.parse(await readFile(corpusSchemaPath, 'utf8')));
}

async function taskCommitmentsFixture(): Promise<JsonObject> {
  return object(JSON.parse(await readFile(taskCommitmentsPath, 'utf8')));
}

async function referenceFixture(): Promise<JsonObject> {
  const [catalog, taskCommitments] = await Promise.all([
    catalogFixture(),
    taskCommitmentsFixture(),
  ]);
  const tasks = catalog.tasks;
  const reviewedTasks = taskCommitments.tasks;
  if (!Array.isArray(tasks)) throw new Error('catalog tasks are missing');
  if (!Array.isArray(reviewedTasks) || reviewedTasks.length !== tasks.length) {
    throw new Error('reviewed task commitments are missing');
  }
  const reviewedByTaskId = new Map(
    reviewedTasks.map((value) => {
      const reviewed = object(value);
      return [String(reviewed.task_id), reviewed] as const;
    }),
  );
  const nodeDigest = digest(90_007);
  const evaluatorDigest = evaluatorIdentity;
  const runnerDigest = digest(90_009);
  const sourceManifest = {
    schema_version: 'aiq.runner-source-manifest.v1',
    package: 'aiq-runner',
    scope: 'cargo_build_and_test_inputs',
    path_base: 'repository_root',
    entries: [
      {
        path: 'apps/aiq-runner/src/runner.rs',
        sha256: runnerDigest,
      },
    ],
  };
  const modelToolchain = {
    schema_version: 'aiq.execution-tool-policy.v1',
    platform: 'linux',
    architecture: 'x64',
    platform_minimal_path: 'linux_v1',
    inherit_path: false,
    use_shell_profile: false,
    commands: [
      {
        name: 'node',
        executable_ref: 'node',
        executable_sha256: nodeDigest,
        version: 'v24.18.0',
      },
      {
        name: 'rg',
        executable_ref: 'rg',
        executable_sha256: digest(90_010),
        version: 'ripgrep 15.1.0',
      },
    ],
  };
  const runtimeProvenance = {
    schema_version: 'aiq.execution-provenance.v1',
    operating_system: {
      platform: 'linux',
      architecture: 'x64',
      type: 'Linux',
      release: '6.8.0',
    },
    locale_and_timezone: {
      environment: {
        LANG: 'C.UTF-8',
        LC_ALL: null,
        OPENSSL_CONF: '/dev/null',
        TZ: 'Etc/UTC',
      },
      resolved_locale: 'en-US',
      resolved_time_zone: 'Etc/UTC',
    },
    node_runtime: {
      executable_sha256: nodeDigest,
      version: 'v24.18.0',
      release: {
        name: 'node',
        source_url: 'https://nodejs.org/download/release/v24.18.0/node-v24.18.0.tar.gz',
        headers_url: 'https://nodejs.org/download/release/v24.18.0/node-v24.18.0-headers.tar.gz',
      },
      components: {
        icu: '77.1',
        tz: '2025b',
        unicode: '16.0',
        v8: '13.6',
        modules: '137',
        openssl: '3.5.4',
        zlib: '1.3.1',
        acorn: '8.15.0',
        nghttp3: '',
      },
    },
    model_toolchain: modelToolchain,
    evaluator: {
      executable_sha256: evaluatorDigest,
      dependency_model: 'node_builtin_modules_only',
      acceptance_invocation: {
        executable: 'committed_node_runtime',
        arguments: ['<committed-evaluator-script>'],
        cwd: 'repository_root',
        environment: 'empty',
      },
      scenario_invocation: {
        executable: 'committed_node_runtime',
        arguments: [
          '--no-warnings',
          '--abort-on-uncaught-exception',
          '--unhandled-rejections=strict',
          '--disable-sigusr1',
          '--experimental-vm-modules',
          '--max-old-space-size=128',
          '--permission',
          '--allow-fs-read=<candidate-workspace>',
          '<scenario-launcher-in-disposable-workspace>',
        ],
        hidden_source_transport:
          'inherited descriptor 3 consumed by the launcher before candidate import',
        authentication_transport:
          'random HMAC key and nonce on inherited descriptor 4 consumed before candidate import',
        trusted_completion_transport: 'HMAC-SHA-256 completion record on inherited descriptor 5',
        optional_write_argument: '--allow-fs-write=<candidate-workspace>',
        environment: 'empty',
      },
    },
    runner: {
      identity_kind: 'source_only',
      source_manifest: sourceManifest,
      source_manifest_sha256: `sha256:${createHash('sha256')
        .update(canonicalJson(sourceManifest))
        .digest('hex')}`,
      built_binary_sha256: null,
    },
    codex: {
      invoked: false,
      binary_sha256: null,
      version: null,
    },
  };
  const toolPolicyDigest = `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        protocol: 'aiq.tool-policy.v1',
        evidence_class: 'declared_policy_commitment',
        catalog: tasks.map((taskValue) => {
          const task = object(taskValue);
          return {
            task_id: task.task_id,
            allowed_tools: task.allowed_tools,
          };
        }),
        model_toolchain: modelToolchain,
      }),
    )
    .digest('hex')}`;
  const networkPolicyDigest = `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        protocol: 'aiq.network-policy.v1',
        evidence_class: 'declared_policy_commitment',
        codex_web_search: 'disabled_for_controlled_corpus',
        codex_mcp: 'disabled',
        evaluator_node_scenario: 'network_denied_by_node_permission_model',
      }),
    )
    .digest('hex')}`;
  return {
    schema_version: 'aiq.production-reference.v1',
    published_at: '2026-08-03T12:00:00.000Z',
    corpus_commitment: {
      schema_version: 'aiq.corpus-commitment.v3',
      release_id: 'corpus_initial_greenfield',
      controlled: true,
      synthetic: false,
      catalog: {
        schema_version: 'aiq.catalog.v2',
        task_set_id: 'aiq-core',
        task_set_version: '1.1.0',
        identity_sha256: object(catalog.task_metadata_identity).digest,
        identity_scope: 'ordered_full_task_metadata',
      },
      execution: {
        harness_sha256: digest(90_002),
        runner_prompt_source_sha256: runnerDigest,
        declared_tool_policy_sha256: toolPolicyDigest,
        declared_network_policy_sha256: networkPolicyDigest,
        environment_sha256: `sha256:${createHash('sha256')
          .update(canonicalJson(runtimeProvenance))
          .digest('hex')}`,
        runtime_provenance: runtimeProvenance,
      },
      tasks: tasks.map((taskValue, index) => {
        const task = object(taskValue);
        const reviewed = reviewedByTaskId.get(String(task.task_id));
        if (reviewed === undefined) throw new Error('reviewed task commitment is missing');
        return {
          task_id: task.task_id,
          task_version: task.task_version,
          task_definition_sha256: reviewed.task_definition_sha256,
          catalog_entry_sha256: `sha256:${createHash('sha256')
            .update(canonicalJson(task))
            .digest('hex')}`,
          baseline_workspace_tree_sha256: digest(92_000 + index),
          fixture_bundle_sha256: reviewed.fixture_bundle_sha256,
          evaluator_executable_sha256: evaluatorDigest,
          evaluator_runtime_kind: 'node',
          evaluator_runtime_executable_sha256: nodeDigest,
          evaluator_configuration_sha256: digest(96_000 + index),
          acceptance_suite_sha256: digest(97_000 + index),
          leakage_review_sha256: digest(98_000 + index),
        };
      }),
    },
    nodes: [publicNode('runner', 1), publicNode('verifier', 3), publicNode('publisher', 4)],
  };
}

function embeddedRowGroups(sql: string): unknown[][] {
  return [...sql.matchAll(/jsonb?_to_recordset\('((?:''|[^'])*)'::jsonb?\)/g)].map((match) => {
    const encoded = match[1];
    if (encoded === undefined) throw new Error('embedded row group is missing');
    const parsed: unknown = JSON.parse(encoded.replaceAll("''", "'"));
    if (!Array.isArray(parsed)) throw new Error('embedded row group must be an array');
    return Array.from(parsed, (item: unknown) => item);
  });
}

async function preparedFixture(): Promise<ReturnType<typeof prepareInitialization>> {
  const [schema, catalog, reference, corpusSchema, taskCommitments] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    catalogFixture(),
    referenceFixture(),
    corpusSchemaFixture(),
    taskCommitmentsFixture(),
  ]);
  return prepareInitialization(schema, catalog, reference, corpusSchema, taskCommitments);
}

async function fakePsql(root: string): Promise<{
  readonly command: string;
  readonly countPath: string;
  readonly argumentsPath: string;
  readonly environmentPath: string;
  readonly stdinPath: string;
}> {
  const command = join(root, 'psql');
  const countPath = join(root, 'count.txt');
  const argumentsPath = join(root, 'arguments.json');
  const environmentPath = join(root, 'environment.json');
  const stdinPath = join(root, 'stdin.sql');
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(countPath)}, '1\\n');
fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(environmentPath)}, JSON.stringify({
  PGHOST: process.env.PGHOST,
  PGPORT: process.env.PGPORT,
  PGDATABASE: process.env.PGDATABASE,
  PGUSER: process.env.PGUSER,
  PGPASSWORD: process.env.PGPASSWORD,
  AIQ_DATABASE_URL: process.env.AIQ_DATABASE_URL,
  AIQ_PRODUCTION_REFERENCE: process.env.AIQ_PRODUCTION_REFERENCE,
}));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, input);
  process.stdout.write('{"initialized":true,"task_set_identity_sha256":"${taskSetIdentity}","task_set_identity_valid":true,"evaluator_identity_sha256":"${evaluatorIdentity}","evaluator_identity_valid":true,"task_count":72,"model_config_count":17,"public_node_count":3}\\n');
});
`,
  );
  await chmod(command, 0o700);
  return { command, countPath, argumentsPath, environmentPath, stdinPath };
}

void test('prepares one greenfield SQL stream with exact 72/17/3 reference shape', async () => {
  const prepared = await preparedFixture();
  const reference = await referenceFixture();
  const groups = embeddedRowGroups(prepared.sql);

  deepStrictEqual(
    groups.map((group) => group.length),
    [2, 1, 72, 17, 3],
  );
  deepStrictEqual(
    prepared.sql
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line === 'begin;' || line === 'commit;'),
    ['begin;', 'commit;'],
  );
  assert.ok(
    prepared.sql.indexOf('$aiq_greenfield_preflight$') <
      prepared.sql.indexOf('create schema aiq_private;'),
  );
  assert.ok(
    prepared.sql.indexOf('create schema aiq_private;') <
      prepared.sql.indexOf('insert into aiq_private.aiq_scoring_versions'),
  );
  assert.match(prepared.sql, /from json_to_recordset\('[\s\S]*?'::json\) as row\(/);
  assert.match(prepared.sql, /catalog_ordinal smallint, full_public_metadata json,/);
  assert.match(prepared.sql, /pg_catalog\.pg_namespace where nspname = 'aiq_private'/);
  assert.match(
    prepared.sql,
    /relation\.relname in \([\s\S]*?'public_distributed_radar'[\s\S]*?'public_calibration_scores'/,
  );
  assert.match(
    prepared.sql,
    /procedure\.proname in \([\s\S]*?'aiq_register_storage_object'[\s\S]*?'public_trend_points'/,
  );
  assert.doesNotMatch(prepared.sql, /relation\.relname like|procedure\.proname like/);
  assert.match(prepared.sql, /rolname in \('aiq_verifier', 'aiq_publisher'\)/);
  assert.match(
    prepared.sql,
    /select 1 from storage\.buckets[\s\S]{0,160}id in \('aiq-submission-packages', 'aiq-runner-artifacts'\)[\s\S]{0,160}name in \('aiq-submission-packages', 'aiq-runner-artifacts'\)/,
  );
  assert.match(prepared.sql, /insert into storage\.buckets \(id, name, public\)/);
  assert.match(
    prepared.sql,
    /id in \('aiq-submission-packages', 'aiq-runner-artifacts'\)[\s\S]{0,80}public is false/,
  );
  assert.match(
    prepared.sql,
    /frozen_catalog_identity_is_valid\('aiq-core', '1\.1\.0', '1\.0\.8'\)/,
  );
  assert.match(prepared.sql, /aiq_production_reference_status\('node_[0-9a-f]{64}'\)/);
  const referencePhase = prepared.sql.slice(
    prepared.sql.indexOf('insert into aiq_private.aiq_scoring_versions'),
  );
  const referenceStatements = referencePhase.replaceAll(/'(?:''|[^'])*'/g, "''");
  assert.doesNotMatch(
    referenceStatements,
    /\bon conflict\b|inspection_only|replay_policy|existing-row|backfill|migration|upgrade/i,
  );
  deepStrictEqual(
    {
      task_count: prepared.receipt.task_count,
      model_config_count: prepared.receipt.model_config_count,
      public_node_count: prepared.receipt.public_node_count,
      private_table_count: prepared.receipt.private_table_count,
      forced_rls_table_count: prepared.receipt.forced_rls_table_count,
      public_view_count: prepared.receipt.public_view_count,
      security_invoker_view_count: prepared.receipt.security_invoker_view_count,
      hardened_gateway_role_count: prepared.receipt.hardened_gateway_role_count,
    },
    {
      task_count: 72,
      model_config_count: 17,
      public_node_count: 3,
      private_table_count: 42,
      forced_rls_table_count: 42,
      public_view_count: 13,
      security_invoker_view_count: 13,
      hardened_gateway_role_count: 2,
    },
  );
  strictEqual(
    prepared.receipt.corpus_commitment_sha256,
    `sha256:${createHash('sha256')
      .update(canonicalJson(object(reference.corpus_commitment)))
      .digest('hex')}`,
  );
  strictEqual(prepared.receipt.scoring_version, '1.0.8');
  strictEqual(prepared.receipt.measurement_version, '2.0.0');
  strictEqual(
    prepared.receipt.catalog_identity_sha256,
    'sha256:459e1608a51d2a35286d6480df83e69cb4395d6e1a1062aa4410c2e0fdb92105',
  );
  strictEqual(
    prepared.receipt.catalog_release_identity_sha256,
    'sha256:fb69438f9317e79515e99886d072c7540371ffd4a0732c4ab1286b36752597a6',
  );
  strictEqual(prepared.receipt.task_set_identity_sha256, taskSetIdentity);
  strictEqual(prepared.receipt.evaluator_identity_sha256, evaluatorIdentity);
  strictEqual(object(groups[1]?.[0]).metadata !== undefined, true);
  strictEqual(object(object(groups[1]?.[0]).metadata).evaluator_identity_sha256, evaluatorIdentity);
  const taskGroup = groups[2];
  if (taskGroup === undefined) throw new Error('task row group is missing');
  const reviewedTasks = mutableArray(await taskCommitmentsFixture(), 'tasks');
  deepStrictEqual(
    taskGroup
      .map((row) => ({
        task_id: object(row).task_id,
        task_definition_sha256: `sha256:${String(object(row).fixture_commitment)}`,
      }))
      .toSorted((left, right) => String(left.task_id).localeCompare(String(right.task_id))),
    reviewedTasks
      .map((value) => {
        const reviewed = object(value);
        return {
          task_id: reviewed.task_id,
          task_definition_sha256: reviewed.task_definition_sha256,
        };
      })
      .toSorted((left, right) => String(left.task_id).localeCompare(String(right.task_id))),
  );
  strictEqual(
    `sha256:${createHash('sha256')
      .update(
        canonicalJson(
          taskGroup.map((row) => `sha256:${String(object(row).fixture_commitment)}`).toSorted(),
        ),
      )
      .digest('hex')}`,
    taskSetIdentity,
  );
  strictEqual(
    `sha256:${createHash('sha256')
      .update(canonicalJson(taskGroup.map((row) => object(object(row).full_public_metadata))))
      .digest('hex')}`,
    object(object(await catalogFixture()).task_metadata_identity).digest,
  );
});

void test('normalizes commitment bindings by task identity before building rows', async () => {
  const [schema, catalog, reference, corpusSchema, taskCommitments] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    catalogFixture(),
    referenceFixture(),
    corpusSchemaFixture(),
    taskCommitmentsFixture(),
  ]);
  const bindings = mutableArray(object(reference.corpus_commitment), 'tasks');
  bindings.reverse();
  const expectedByTaskId = new Map(
    bindings.map((value) => {
      const binding = object(value);
      return [String(binding.task_id), binding.task_definition_sha256] as const;
    }),
  );

  const prepared = prepareInitialization(schema, catalog, reference, corpusSchema, taskCommitments);
  const taskRows = embeddedRowGroups(prepared.sql)[2];
  const catalogTasks = mutableArray(catalog, 'tasks');
  if (taskRows === undefined) throw new Error('task row group is missing');

  deepStrictEqual(
    taskRows.map((row) => object(row).task_id),
    catalogTasks.map((task) => object(task).task_id),
  );
  taskRows.forEach((row) => {
    const taskRow = object(row);
    strictEqual(
      `sha256:${String(taskRow.fixture_commitment)}`,
      expectedByTaskId.get(String(taskRow.task_id)),
    );
  });
});

void test('rejects a schema stream without one standalone transaction wrapper', async () => {
  const [schema, catalog, reference, corpusSchema, taskCommitments] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    catalogFixture(),
    referenceFixture(),
    corpusSchemaFixture(),
    taskCommitmentsFixture(),
  ]);

  assert.throws(
    () =>
      prepareInitialization(
        schema.replace(
          'create schema if not exists extensions;',
          'begin;\ncreate schema if not exists extensions;',
        ),
        catalog,
        reference,
        corpusSchema,
        taskCommitments,
      ),
    /one standalone begin\/commit transaction wrapper/,
  );
});

void test('one CLI command invokes fake psql once without disclosing its URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-'));
  const fake = await fakePsql(root);
  const referencePath = join(root, 'reference.json');
  await writeFile(referencePath, JSON.stringify(await referenceFixture()));
  const secretUrl =
    'postgresql://postgres:secret-value@db.xxnszykaeapolqdnhalx.supabase.co:5432/postgres';
  const environment = {
    ...process.env,
    AIQ_DATABASE_URL: secretUrl,
    PATH: `${root}:${process.env.PATH ?? ''}`,
  };

  const result = await execFileAsync(process.execPath, [initPath, '--reference', referencePath], {
    cwd: repositoryRoot,
    env: environment,
  });
  const receipt: unknown = JSON.parse(result.stdout);
  const receiptObject = object(receipt);
  strictEqual(receiptObject.schema_version, 'aiq.production-initialization-receipt.v1');
  strictEqual(receiptObject.initialized, true);
  strictEqual((await readFile(fake.countPath, 'utf8')).trim(), '1');
  const invokedArguments: unknown = JSON.parse(await readFile(fake.argumentsPath, 'utf8'));
  assert.equal(Array.isArray(invokedArguments), true);
  assert.doesNotMatch(JSON.stringify(invokedArguments), /operator|secret-value|database\.invalid/);
  const childEnvironment = object(JSON.parse(await readFile(fake.environmentPath, 'utf8')));
  strictEqual(childEnvironment.PGHOST, 'db.xxnszykaeapolqdnhalx.supabase.co');
  strictEqual(childEnvironment.PGPORT, '5432');
  strictEqual(childEnvironment.PGDATABASE, 'postgres');
  strictEqual(childEnvironment.PGUSER, 'postgres');
  strictEqual(childEnvironment.PGPASSWORD, 'secret-value');
  strictEqual(childEnvironment.AIQ_DATABASE_URL, undefined);
  strictEqual(childEnvironment.AIQ_PRODUCTION_REFERENCE, undefined);
  assert.match(await readFile(fake.stdinPath, 'utf8'), /create schema aiq_private;/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretUrl));
  assert.doesNotMatch(
    result.stdout,
    /secret-value|public_key|prompt|fixture|expected_output|reference\.json/i,
  );
});

void test('initializer parses readiness from a fake psql executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-api-'));
  const fake = await fakePsql(root);
  const referencePath = join(root, 'reference.json');
  await writeFile(referencePath, JSON.stringify(await referenceFixture()));
  const receipt = await initializeDatabase({
    referencePath,
    repositoryRoot,
    psqlCommand: fake.command,
    environment: {
      ...process.env,
      AIQ_DATABASE_URL:
        'postgresql://postgres:private@db.xxnszykaeapolqdnhalx.supabase.co/postgres',
    },
  });

  strictEqual(receipt.initialized, true);
  strictEqual(receipt.task_count, 72);
  strictEqual(receipt.model_config_count, 17);
  strictEqual(receipt.public_node_count, 3);
  strictEqual(receipt.private_table_count, 42);
  strictEqual(receipt.forced_rls_table_count, 42);
  strictEqual(receipt.public_view_count, 13);
  strictEqual(receipt.security_invoker_view_count, 13);
  strictEqual(receipt.hardened_gateway_role_count, 2);
  strictEqual(receipt.task_set_identity_sha256, taskSetIdentity);
  strictEqual(receipt.evaluator_identity_sha256, evaluatorIdentity);
  strictEqual(Object.keys(receipt.node_ids).length, 3);
});

void test('database target guard binds the exact direct or session-pooler tuple', () => {
  const productionEnvironment = { NODE_ENV: 'production' };
  assert.doesNotThrow(() =>
    assertDatabaseTarget(
      'postgresql://postgres:private@db.xxnszykaeapolqdnhalx.supabase.co:5432/postgres',
      productionEnvironment,
    ),
  );
  assert.doesNotThrow(() =>
    assertDatabaseTarget(
      'postgresql://postgres.xxnszykaeapolqdnhalx:private@aws-0-ca-central-1.pooler.supabase.com:5432/postgres',
      productionEnvironment,
    ),
  );
  for (const target of [
    'postgresql://postgres:private@db.otherproject.supabase.co/postgres',
    'postgresql://postgres:private@db.xxnszykaeapolqdnhalx.supabase.co/other_database',
    'postgresql://postgres:private@db.xxnszykaeapolqdnhalx.supabase.co:6543/postgres',
    'postgresql://operator:private@db.xxnszykaeapolqdnhalx.supabase.co/postgres',
    'postgresql://postgres.otherproject:private@aws-0-ca-central-1.pooler.supabase.com:5432/postgres',
    'postgresql://postgres.xxnszykaeapolqdnhalx:private@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    'postgresql://postgres.xxnszykaeapolqdnhalx:private@aws-0-ca-central-1.pooler.supabase.com:6543/postgres',
  ]) {
    assert.throws(
      () => assertDatabaseTarget(target, productionEnvironment),
      /must target Supabase project xxnszykaeapolqdnhalx/,
    );
  }
  assert.throws(
    () =>
      assertDatabaseTarget('postgresql://postgres:private@127.0.0.1:54322/postgres', {
        NODE_ENV: 'production',
        AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET: 'true',
      }),
    /must target Supabase project xxnszykaeapolqdnhalx/,
  );
  assert.doesNotThrow(() =>
    assertDatabaseTarget('postgresql://operator:private@127.0.0.1:54322/aiq_reset_fixture', {
      NODE_ENV: 'test',
      AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET: 'true',
    }),
  );
});

void test('greenfield preflight enumerates every AIQ public view and RPC name exactly', async () => {
  const [initializer, desiredSchema] = await Promise.all([
    readFile(initPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ]);
  const preflight = initializer.slice(
    initializer.indexOf('const preflight = `do $aiq_greenfield_preflight$'),
    initializer.indexOf('const nodeIds:', initializer.indexOf('const preflight = `')),
  );
  const expectedViews = capturedNames(desiredSchema, /create view public\.([a-z0-9_]+)/gi);
  const expectedRpcs = capturedNames(desiredSchema, /create function public\.([a-z0-9_]+)/gi);
  assert.equal(expectedViews.length, 13);
  assert.equal(expectedRpcs.length, 35);
  for (const name of [...expectedViews, ...expectedRpcs]) {
    assert.match(preflight, new RegExp(`'${name}'`));
  }
  assert.doesNotMatch(preflight, /relname\s+(?:like|~)|proname\s+(?:like|~)/i);
});

void test('rejects malformed corpus provenance before psql starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-invalid-corpus-'));
  const fake = await fakePsql(root);
  const referencePath = join(root, 'reference.json');
  const reference = await referenceFixture();

  object(object(reference.corpus_commitment).execution).runtime_provenance = {
    schema_version: 'aiq.execution-provenance.v1',
  };

  await writeFile(referencePath, JSON.stringify(reference));
  await rejects(
    initializeDatabase({
      referencePath,
      repositoryRoot,
      psqlCommand: fake.command,
      environment: {
        AIQ_DATABASE_URL:
          'postgresql://postgres:private@db.xxnszykaeapolqdnhalx.supabase.co/postgres',
      },
    }),
    /corpus/,
  );
  await rejects(readFile(fake.countPath));
});

void test('file preparation rejects missing, malformed, and invalid references before psql', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-reference-preflight-'));
  const fake = await fakePsql(root);
  const malformedPath = join(root, 'malformed.json');
  const invalidPath = join(root, 'invalid.json');
  await writeFile(malformedPath, '{not-json');
  await writeFile(invalidPath, '{}');
  const options = {
    repositoryRoot,
    psqlCommand: fake.command,
    environment: {
      ...process.env,
      AIQ_DATABASE_URL:
        'postgresql://postgres:private@db.xxnszykaeapolqdnhalx.supabase.co/postgres',
    },
  };
  await rejects(
    initializeDatabase({ ...options, referencePath: join(root, 'missing.json') }),
    /production reference file could not be read/,
  );
  await rejects(
    initializeDatabase({ ...options, referencePath: malformedPath }),
    /production reference file is not valid JSON/,
  );
  await rejects(initializeDatabase({ ...options, referencePath: invalidPath }), /reference/);
  await rejects(readFile(fake.countPath));
});

void test('file preparation is transitively immutable and can be reused by initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-prepared-'));
  const fake = await fakePsql(root);
  const referencePath = join(root, 'reference.json');
  await writeFile(referencePath, JSON.stringify(await referenceFixture()));
  const preparedInitialization = await prepareInitializationFromFiles({
    referencePath,
    repositoryRoot,
  });
  const preparedSnapshot = structuredClone(preparedInitialization);
  const reachableObjects: readonly object[] = [
    preparedInitialization,
    preparedInitialization.receipt,
    preparedInitialization.receipt.node_ids,
  ];
  for (const target of reachableObjects) {
    strictEqual(Object.isFrozen(target), true);
    for (const key of Object.keys(target)) {
      strictEqual(Reflect.set(target, key, 'tampered'), false);
      strictEqual(Reflect.deleteProperty(target, key), false);
    }
    strictEqual(Reflect.set(target, 'unexpected', 'tampered'), false);
  }
  deepStrictEqual(preparedInitialization, preparedSnapshot);
  await writeFile(referencePath, '{changed-after-preparation');
  const receipt = await initializeDatabase({
    referencePath,
    repositoryRoot,
    preparedInitialization,
    psqlCommand: fake.command,
    environment: {
      ...process.env,
      AIQ_DATABASE_URL:
        'postgresql://postgres:private@db.xxnszykaeapolqdnhalx.supabase.co/postgres',
    },
  });
  deepStrictEqual(receipt, preparedSnapshot.receipt);
  deepStrictEqual(preparedInitialization, preparedSnapshot);
  strictEqual(await readFile(fake.stdinPath, 'utf8'), preparedSnapshot.sql);
  strictEqual((await readFile(fake.countPath, 'utf8')).trim(), '1');
});

void test('CLI accepts the reference path environment fallback without disclosing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-environment-'));
  await fakePsql(root);
  const referencePath = join(root, 'private-reference-location.json');
  await writeFile(referencePath, JSON.stringify(await referenceFixture()));
  const result = await execFileAsync(process.execPath, [initPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AIQ_DATABASE_URL: 'postgresql://postgres:secret@db.xxnszykaeapolqdnhalx.supabase.co/postgres',
      AIQ_PRODUCTION_REFERENCE: referencePath,
      PATH: `${root}:${process.env.PATH ?? ''}`,
    },
  });

  strictEqual(object(JSON.parse(result.stdout)).initialized, true);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private-reference-location/);
});

void test('rejects malformed, incomplete, duplicate, and mismatched references', async () => {
  const [schema, catalog, corpusSchema, taskCommitments] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    catalogFixture(),
    corpusSchemaFixture(),
    taskCommitmentsFixture(),
  ]);
  const cases: Array<[string, (reference: JsonObject) => void]> = [
    [
      'uncontrolled',
      (reference) => {
        object(reference.corpus_commitment).controlled = false;
      },
    ],
    [
      'synthetic',
      (reference) => {
        object(reference.corpus_commitment).synthetic = true;
      },
    ],
    [
      'invalid publication timestamp',
      (reference) => {
        reference.published_at = 'not-a-timestamp';
      },
    ],
    [
      'non-canonical publication timestamp',
      (reference) => {
        reference.published_at = '2026-08-03T12:00:00Z';
      },
    ],
    [
      'wrong wire version',
      (reference) => {
        object(reference.corpus_commitment).schema_version = 'aiq.corpus-commitment.v1';
      },
    ],
    [
      'incomplete runtime provenance',
      (reference) => {
        object(object(reference.corpus_commitment).execution).runtime_provenance = {
          schema_version: 'aiq.execution-provenance.v1',
        };
      },
    ],
    [
      'missing controlled OpenSSL configuration',
      (reference) => {
        const execution = object(object(reference.corpus_commitment).execution);
        const runtime = object(execution.runtime_provenance);
        delete object(object(runtime.locale_and_timezone).environment).OPENSSL_CONF;
        execution.environment_sha256 = `sha256:${createHash('sha256')
          .update(canonicalJson(runtime))
          .digest('hex')}`;
      },
    ],
    [
      'OpenSSL null device does not match the committed platform',
      (reference) => {
        const execution = object(object(reference.corpus_commitment).execution);
        const runtime = object(execution.runtime_provenance);
        object(object(runtime.locale_and_timezone).environment).OPENSSL_CONF = 'NUL';
        execution.environment_sha256 = `sha256:${createHash('sha256')
          .update(canonicalJson(runtime))
          .digest('hex')}`;
      },
    ],
    [
      'operating-system platform does not match the model toolchain',
      (reference) => {
        const execution = object(object(reference.corpus_commitment).execution);
        const runtime = object(execution.runtime_provenance);
        object(runtime.operating_system).platform = 'win32';
        execution.environment_sha256 = `sha256:${createHash('sha256')
          .update(canonicalJson(runtime))
          .digest('hex')}`;
      },
    ],
    [
      'mismatched deterministic environment digest',
      (reference) => {
        object(object(reference.corpus_commitment).execution).environment_sha256 = digest(123_456);
      },
    ],
    [
      'unreviewed task definition identity',
      (reference) => {
        const tasks = mutableArray(object(reference.corpus_commitment), 'tasks');
        object(tasks[0]).task_definition_sha256 = digest(91_000);
      },
    ],
    [
      'unreviewed fixture bundle identity',
      (reference) => {
        const tasks = mutableArray(object(reference.corpus_commitment), 'tasks');
        object(tasks[0]).fixture_bundle_sha256 = digest(93_000);
      },
    ],
    [
      'unreviewed runtime evaluator identity',
      (reference) => {
        const execution = object(object(reference.corpus_commitment).execution);
        const runtime = object(execution.runtime_provenance);
        object(runtime.evaluator).executable_sha256 = digest(90_008);
        execution.environment_sha256 = `sha256:${createHash('sha256')
          .update(canonicalJson(runtime))
          .digest('hex')}`;
      },
    ],
    [
      'unreviewed task evaluator identity',
      (reference) => {
        const tasks = mutableArray(object(reference.corpus_commitment), 'tasks');
        object(tasks[0]).evaluator_executable_sha256 = digest(90_008);
      },
    ],
    [
      'incomplete nodes',
      (reference) => {
        mutableArray(reference, 'nodes').pop();
      },
    ],
    [
      'duplicate node',
      (reference) => {
        const nodes = mutableArray(reference, 'nodes');
        nodes[2] = structuredClone(nodes[0]);
      },
    ],
    [
      'mismatched node identity',
      (reference) => {
        const nodes = mutableArray(reference, 'nodes');
        object(nodes[0]).node_id = `node_${'f'.repeat(64)}`;
      },
    ],
    [
      'duplicate task binding',
      (reference) => {
        const tasks = mutableArray(object(reference.corpus_commitment), 'tasks');
        tasks[1] = structuredClone(tasks[0]);
      },
    ],
    [
      'unknown task binding',
      (reference) => {
        const tasks = mutableArray(object(reference.corpus_commitment), 'tasks');
        object(tasks[0]).task_id = 'unknown-task';
      },
    ],
    [
      'invalid Node component name',
      (reference) => {
        const execution = object(object(reference.corpus_commitment).execution);
        const runtime = object(execution.runtime_provenance);
        object(object(runtime.node_runtime).components)['Invalid Component'] = '1.0.0';
        execution.environment_sha256 = `sha256:${createHash('sha256')
          .update(canonicalJson(runtime))
          .digest('hex')}`;
      },
    ],
    [
      'empty required Node component',
      (reference) => {
        const execution = object(object(reference.corpus_commitment).execution);
        const runtime = object(execution.runtime_provenance);
        object(object(runtime.node_runtime).components).v8 = '';
        execution.environment_sha256 = `sha256:${createHash('sha256')
          .update(canonicalJson(runtime))
          .digest('hex')}`;
      },
    ],
    [
      'too many Node components',
      (reference) => {
        const execution = object(object(reference.corpus_commitment).execution);
        const runtime = object(execution.runtime_provenance);
        const components = object(object(runtime.node_runtime).components);
        for (let index = 0; index < 56; index += 1) components[`extra_${String(index)}`] = '1';
        execution.environment_sha256 = `sha256:${createHash('sha256')
          .update(canonicalJson(runtime))
          .digest('hex')}`;
      },
    ],
    [
      'extra public-unsafe field',
      (reference) => {
        reference.private_key = 'not allowed';
      },
    ],
    [
      'digest with trailing line terminator',
      (reference) => {
        object(object(reference.corpus_commitment).execution).harness_sha256 =
          `${digest(90_001)}\n`;
      },
    ],
  ];
  const references = await Promise.all(cases.map(() => referenceFixture()));
  cases.forEach(([label, mutate], index) => {
    const reference = references[index];
    if (reference === undefined) throw new Error('rejection fixture is missing');
    mutate(reference);
    assert.throws(
      () => prepareInitialization(schema, catalog, reference, corpusSchema, taskCommitments),
      label,
    );
  });
});

void test('failed psql gives fail-closed greenfield retry guidance without URL disclosure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-failure-'));
  const command = join(root, 'psql');
  await writeFile(command, '#!/bin/sh\nexit 1\n');
  await chmod(command, 0o700);
  const referencePath = join(root, 'reference.json');
  await writeFile(referencePath, JSON.stringify(await referenceFixture()));
  const secretUrl =
    'postgresql://postgres:failure-secret@db.xxnszykaeapolqdnhalx.supabase.co/postgres';

  await rejects(
    initializeDatabase({
      referencePath,
      repositoryRoot,
      psqlCommand: command,
      environment: { AIQ_DATABASE_URL: secretUrl },
    }),
    (error: unknown) =>
      error instanceof Error &&
      /confirm that the transaction rolled back/.test(error.message) &&
      /AIQ namespace is empty/.test(error.message) &&
      !error.message.includes(secretUrl),
  );
});

void test('the controlled preflight marker reports rejected reuse without URL disclosure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-reuse-'));
  const command = join(root, 'psql');
  await writeFile(
    command,
    '#!/bin/sh\nprintf "%s\\n" "ERROR:  55000: AIQ_GREENFIELD_REUSE_REJECTED" >&2\nexit 3\n',
  );
  await chmod(command, 0o700);
  const referencePath = join(root, 'reference.json');
  await writeFile(referencePath, JSON.stringify(await referenceFixture()));
  const secretUrl =
    'postgresql://postgres:reuse-secret@db.xxnszykaeapolqdnhalx.supabase.co/postgres';

  await rejects(
    initializeDatabase({
      referencePath,
      repositoryRoot,
      psqlCommand: command,
      environment: { AIQ_DATABASE_URL: secretUrl },
    }),
    (error: unknown) =>
      error instanceof Error &&
      /AIQ objects already exist/.test(error.message) &&
      /rejected attempt made no changes/.test(error.message) &&
      !error.message.includes(secretUrl),
  );
});

void test('an incidental reuse marker in a connection error stays a generic failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-marker-collision-'));
  const command = join(root, 'psql');
  await writeFile(
    command,
    '#!/bin/sh\nprintf "%s\\n" "psql: database AIQ_GREENFIELD_REUSE_REJECTED does not exist" >&2\nexit 2\n',
  );
  await chmod(command, 0o700);
  const referencePath = join(root, 'reference.json');
  await writeFile(referencePath, JSON.stringify(await referenceFixture()));

  await rejects(
    initializeDatabase({
      referencePath,
      repositoryRoot,
      psqlCommand: command,
      environment: {
        AIQ_DATABASE_URL:
          'postgresql://postgres:collision-secret@db.xxnszykaeapolqdnhalx.supabase.co/postgres',
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      /confirm that the transaction rolled back/.test(error.message) &&
      /AIQ namespace is empty/.test(error.message) &&
      !/AIQ objects already exist/.test(error.message) &&
      !error.message.includes('collision-secret'),
  );
});

const integrationDatabaseUrl = process.env.AIQ_DATABASE_INIT_TEST_URL;
const integrationPsql = process.env.AIQ_DATABASE_INIT_TEST_PSQL;

function integrationDatabaseEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port,
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
  };
}

async function publicReferenceShape(
  psqlCommand: string,
  databaseUrl: string,
  role: 'anon' | 'authenticated',
): Promise<JsonObject> {
  const sql = `set role ${role};
select jsonb_build_object(
  'distributed_radar_count', (select count(*) from public.public_distributed_radar),
  'model_config_count', (select count(*) from public.public_model_matrix),
  'node_count', (select count(*) from public.public_nodes),
  'scoring_version_count', (select count(*) from public.public_scoring_versions),
  'domain_count', (select count(*) from public.public_task_coverage),
  'published_run_count', (select count(*) from public.public_runs),
  'trend_point_count', (select count(*) from public.public_trend_points('all'))
)::text;
`;
  const { stdout } = await execFileAsync(
    psqlCommand,
    [
      '-X',
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql,
    ],
    { env: integrationDatabaseEnvironment(databaseUrl) },
  );
  return object(JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? 'null'));
}

void test(
  'initializes one real fresh PostgreSQL 17 database, reports readiness, and rejects reuse',
  {
    skip:
      integrationDatabaseUrl === undefined ||
      integrationDatabaseUrl === '' ||
      integrationPsql === undefined ||
      integrationPsql === ''
        ? 'requires AIQ_DATABASE_INIT_TEST_URL and AIQ_DATABASE_INIT_TEST_PSQL'
        : false,
  },
  async () => {
    if (
      integrationDatabaseUrl === undefined ||
      integrationDatabaseUrl === '' ||
      integrationPsql === undefined ||
      integrationPsql === ''
    ) {
      throw new Error('integration configuration disappeared after test selection');
    }

    const { stdout: versionOutput } = await execFileAsync(
      integrationPsql,
      ['-X', '--no-psqlrc', '--tuples-only', '--no-align', '--command', 'show server_version;'],
      {
        env: integrationDatabaseEnvironment(integrationDatabaseUrl),
      },
    );
    assert.match(versionOutput.trim(), /^17(?:\.|$)/);
    await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false
);
create role authenticator nologin;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;`,
      ],
      {
        env: integrationDatabaseEnvironment(integrationDatabaseUrl),
      },
    );

    const root = await mkdtemp(join(tmpdir(), 'aiq-database-init-postgres-'));
    const referencePath = join(root, 'reference.json');

    await writeFile(referencePath, JSON.stringify(await referenceFixture()));

    await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        "insert into storage.buckets (id, name, public) values ('aiq-submission-packages', 'aiq-submission-packages', false);",
      ],
      { env: integrationDatabaseEnvironment(integrationDatabaseUrl) },
    );
    await rejects(
      () =>
        initializeDatabase({
          referencePath,
          repositoryRoot,
          psqlCommand: integrationPsql,
          environment: {
            ...process.env,
            AIQ_DATABASE_URL: integrationDatabaseUrl,
            AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET: 'true',
            NODE_ENV: 'test',
          },
        }),
      /AIQ objects already exist/,
    );
    const { stdout: preexistingBucketOutput } = await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `select jsonb_build_object(
  'bucket_count', (select count(*) from storage.buckets),
  'schema_count', (select count(*) from pg_catalog.pg_namespace where nspname = 'aiq_private'),
  'role_count', (select count(*) from pg_catalog.pg_roles where rolname in ('aiq_verifier', 'aiq_publisher'))
)::text;`,
      ],
      { env: integrationDatabaseEnvironment(integrationDatabaseUrl) },
    );
    deepStrictEqual(JSON.parse(preexistingBucketOutput.trim()), {
      bucket_count: 1,
      role_count: 0,
      schema_count: 0,
    });
    await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        "delete from storage.buckets where id = 'aiq-submission-packages';",
      ],
      { env: integrationDatabaseEnvironment(integrationDatabaseUrl) },
    );

    const receipt = await initializeDatabase({
      referencePath,
      repositoryRoot,
      psqlCommand: integrationPsql,
      environment: {
        ...process.env,
        AIQ_DATABASE_URL: integrationDatabaseUrl,
        AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET: 'true',
        NODE_ENV: 'test',
      },
    });
    const readinessSql = `set role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.aiq_production_reference_status('${receipt.node_ids.publisher}')::text;
`;
    const { stdout } = await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        readinessSql,
      ],
      {
        env: integrationDatabaseEnvironment(integrationDatabaseUrl),
      },
    );
    const readiness = object(JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? 'null'));

    strictEqual(receipt.task_count, 72);
    strictEqual(receipt.model_config_count, 17);
    strictEqual(receipt.public_node_count, 3);
    strictEqual(receipt.private_table_count, 42);
    strictEqual(receipt.forced_rls_table_count, 42);
    strictEqual(receipt.public_view_count, 13);
    strictEqual(receipt.security_invoker_view_count, 13);
    strictEqual(receipt.hardened_gateway_role_count, 2);
    strictEqual(receipt.task_set_identity_sha256, taskSetIdentity);
    strictEqual(receipt.evaluator_identity_sha256, evaluatorIdentity);
    strictEqual(readiness.initialized, true);
    strictEqual(readiness.task_count, 72);
    strictEqual(readiness.model_config_count, 17);
    strictEqual(readiness.production_node_count, 3);
    strictEqual(readiness.private_table_count, 42);
    strictEqual(readiness.forced_rls_table_count, 42);
    strictEqual(readiness.public_view_count, 13);
    strictEqual(readiness.security_invoker_view_count, 13);
    strictEqual(readiness.hardened_gateway_role_count, 2);
    strictEqual(readiness.task_set_identity_sha256, taskSetIdentity);
    strictEqual(readiness.task_set_identity_valid, true);
    strictEqual(readiness.evaluator_identity_sha256, evaluatorIdentity);
    strictEqual(readiness.evaluator_identity_valid, true);

    const { stdout: bucketOutput } = await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `select jsonb_object_agg(id, public order by id)::text
from storage.buckets
where id in ('aiq-submission-packages', 'aiq-runner-artifacts');`,
      ],
      { env: integrationDatabaseEnvironment(integrationDatabaseUrl) },
    );
    deepStrictEqual(JSON.parse(bucketOutput.trim()), {
      'aiq-runner-artifacts': false,
      'aiq-submission-packages': false,
    });

    const { stdout: residueOutput } = await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `begin;
create view public.unrelated_product_status with (security_invoker = true)
as select true as ready;
grant select on table public.unrelated_product_status to anon, authenticated;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.aiq_production_reference_status('${receipt.node_ids.publisher}')::text;
rollback;`,
      ],
      { env: integrationDatabaseEnvironment(integrationDatabaseUrl) },
    );
    const residueReadiness = object(
      JSON.parse(
        residueOutput
          .trim()
          .split(/\r?\n/)
          .find((line) => line.startsWith('{')) ?? 'null',
      ),
    );
    strictEqual(residueReadiness.initialized, true);
    strictEqual(residueReadiness.public_view_count, 13);
    strictEqual(residueReadiness.security_invoker_view_count, 13);

    const expectedPublicShape = {
      distributed_radar_count: 3,
      model_config_count: 17,
      node_count: 3,
      scoring_version_count: 1,
      domain_count: 10,
      published_run_count: 0,
      trend_point_count: 0,
    };
    deepStrictEqual(
      await publicReferenceShape(integrationPsql, integrationDatabaseUrl, 'anon'),
      expectedPublicShape,
    );
    deepStrictEqual(
      await publicReferenceShape(integrationPsql, integrationDatabaseUrl, 'authenticated'),
      expectedPublicShape,
    );

    await rejects(
      () =>
        initializeDatabase({
          referencePath,
          repositoryRoot,
          psqlCommand: integrationPsql,
          environment: {
            ...process.env,
            AIQ_DATABASE_URL: integrationDatabaseUrl,
            AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET: 'true',
            NODE_ENV: 'test',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /AIQ objects already exist/);
        assert.match(error.message, /rejected attempt made no changes/);
        assert.ok(!error.message.includes(integrationDatabaseUrl));
        return true;
      },
    );

    const { stdout: readinessAfterReuseOutput } = await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        readinessSql,
      ],
      {
        env: integrationDatabaseEnvironment(integrationDatabaseUrl),
      },
    );
    const readinessAfterReuse = object(
      JSON.parse(readinessAfterReuseOutput.trim().split(/\r?\n/).at(-1) ?? 'null'),
    );
    deepStrictEqual(readinessAfterReuse, readiness);
  },
);
