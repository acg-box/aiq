import assert, { rejects, strictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { initializePreviewDatabase, preparePreviewInitialization } from './preview-init.ts';

type JsonObject = Record<string, unknown>;
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '..');
const previewInitPath = resolve(repositoryRoot, 'databases/preview-init.ts');
const expectedPreviewStatus = {
  contract_version: 'aiq.preview-status.v1',
  profile_id: 'acgbox-aiq-preview-v1',
  task_count: 72,
  model_configuration_count: 17,
  synthetic_run_count: 17,
  synthetic_task_result_count: 1224,
  synthetic_score_snapshot_count: 17,
  synthetic_scoring_definition_count: 1,
  synthetic_radar_node_count: 3,
  published_run_count: 0,
  published_leaderboard_count: 0,
  published_trend_point_count: 0,
  calibration_run_count: 0,
  calibration_result_count: 0,
  calibration_score_count: 0,
  non_synthetic_evidence_count: 0,
  canonical_model_matrix: true,
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  assert.ok(isObject(value));
  return value;
}

async function fakePsql(
  root: string,
  exitCode = 0,
): Promise<{
  readonly command: string;
  readonly argumentsPath: string;
  readonly environmentPath: string;
  readonly stdinPath: string;
}> {
  const command = join(root, 'psql');
  const argumentsPath = join(root, 'arguments.json');
  const environmentPath = join(root, 'environment.json');
  const stdinPath = join(root, 'stdin.sql');
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(environmentPath)}, JSON.stringify({
  PGHOST: process.env.PGHOST,
  PGPORT: process.env.PGPORT,
  PGDATABASE: process.env.PGDATABASE,
  PGUSER: process.env.PGUSER,
  PGPASSWORD: process.env.PGPASSWORD,
  AIQ_DATABASE_URL: process.env.AIQ_DATABASE_URL,
}));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, input);
  process.stderr.write('postgresql://operator:leaked-by-psql@database.invalid/postgres\\n');
  process.exit(${String(exitCode)});
});
`,
  );
  await chmod(command, 0o700);
  return { command, argumentsPath, environmentPath, stdinPath };
}

void test('prepares schema and synthetic data in one greenfield transaction', async () => {
  const [schema, syntheticDemo] = await Promise.all([
    readFile(resolve(repositoryRoot, 'databases/schema.sql'), 'utf8'),
    readFile(resolve(repositoryRoot, 'databases/synthetic-demo.sql'), 'utf8'),
  ]);
  const sql = preparePreviewInitialization(schema, syntheticDemo);

  assert.deepEqual(
    sql
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line === 'begin;' || line === 'commit;'),
    ['begin;', 'commit;'],
  );
  assert.ok(sql.indexOf('$aiq_preview_preflight$') < sql.indexOf('create schema aiq_private;'));
  assert.ok(
    sql.indexOf('create schema aiq_private;') <
      sql.indexOf('insert into aiq_private.aiq_scoring_versions'),
  );
  assert.ok(
    sql.indexOf('insert into aiq_private.aiq_scoring_versions') <
      sql.indexOf('$aiq_preview_readiness$'),
  );
  assert.match(sql, /AIQ_PREVIEW_REUSE_REJECTED/);
  assert.match(sql, /from public\.aiq_preview_status_v1 status/);
  assert.match(sql, /status\.synthetic_task_result_count = 1224/);
  assert.match(sql, /status\.non_synthetic_evidence_count = 0/);
  assert.match(sql, /status\.calibration_run_count = 0/);
  assert.match(sql, /status\.calibration_result_count = 0/);
  assert.match(sql, /status\.calibration_score_count = 0/);
  assert.match(sql, /status\.canonical_model_matrix/);
});

void test('one CLI command keeps the connection URL out of arguments and output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-preview-init-'));
  const fake = await fakePsql(root);
  const secretUrl = 'postgresql://operator:secret-value@database.invalid:5432/postgres';
  const result = await execFileAsync(process.execPath, [previewInitPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AIQ_DATABASE_URL: secretUrl,
      PATH: `${root}:${process.env.PATH ?? ''}`,
    },
  });

  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-value|database\.invalid/);
  assert.doesNotMatch(await readFile(fake.argumentsPath, 'utf8'), /secret-value|database\.invalid/);
  const childEnvironment = object(JSON.parse(await readFile(fake.environmentPath, 'utf8')));
  strictEqual(childEnvironment.PGHOST, 'database.invalid');
  strictEqual(childEnvironment.PGPORT, '5432');
  strictEqual(childEnvironment.PGDATABASE, 'postgres');
  strictEqual(childEnvironment.PGUSER, 'operator');
  strictEqual(childEnvironment.PGPASSWORD, 'secret-value');
  strictEqual(childEnvironment.AIQ_DATABASE_URL, undefined);
  assert.match(await readFile(fake.stdinPath, 'utf8'), /create schema aiq_private;/);
});

void test('rejects an invalid URL before psql starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-preview-invalid-'));
  const fake = await fakePsql(root);

  await rejects(
    initializePreviewDatabase({
      environment: { AIQ_DATABASE_URL: 'https://database.invalid/postgres' },
      psqlCommand: fake.command,
      repositoryRoot,
    }),
    /one PostgreSQL connection URL/,
  );
  await rejects(readFile(fake.argumentsPath));
});

void test('psql failure is closed and does not disclose diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-preview-failure-'));
  const fake = await fakePsql(root, 7);
  const secretUrl = 'postgresql://operator:failure-secret@database.invalid/postgres';

  await rejects(
    initializePreviewDatabase({
      environment: { AIQ_DATABASE_URL: secretUrl },
      psqlCommand: fake.command,
      repositoryRoot,
    }),
    (error: unknown) =>
      error instanceof Error &&
      /Discard this database/.test(error.message) &&
      !error.message.includes(secretUrl) &&
      !error.message.includes('leaked-by-psql'),
  );
});

const integrationDatabaseUrl = process.env.AIQ_DATABASE_PREVIEW_TEST_URL;
const integrationPsql = process.env.AIQ_DATABASE_PREVIEW_TEST_PSQL;

function integrationEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
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

async function previewStatus(
  psqlCommand: string,
  databaseUrl: string,
  role: 'anon' | 'authenticated',
): Promise<JsonObject> {
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
      `set role ${role};
select to_jsonb(status)::text
from public.aiq_preview_status_v1 status;`,
    ],
    { env: integrationEnvironment(databaseUrl) },
  );
  return object(JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? 'null'));
}

async function previewStatusRowCountWithRolledBackProbe(
  psqlCommand: string,
  databaseUrl: string,
  mutation: string,
): Promise<number> {
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
      `begin;
${mutation}
set local role anon;
select count(*)
from public.aiq_preview_status_v1;
reset role;
rollback;`,
    ],
    { env: integrationEnvironment(databaseUrl) },
  );
  return Number(stdout.trim().split(/\r?\n/).at(-1));
}

void test(
  'initializes one real fresh PostgreSQL 17 preview and rejects reuse without drift',
  {
    skip:
      integrationDatabaseUrl === undefined ||
      integrationDatabaseUrl === '' ||
      integrationPsql === undefined ||
      integrationPsql === ''
        ? 'requires AIQ_DATABASE_PREVIEW_TEST_URL and AIQ_DATABASE_PREVIEW_TEST_PSQL'
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
    const environment = integrationEnvironment(integrationDatabaseUrl);
    const { stdout: version } = await execFileAsync(
      integrationPsql,
      ['-X', '--no-psqlrc', '--tuples-only', '--no-align', '--command', 'show server_version;'],
      { env: environment },
    );
    assert.match(version.trim(), /^17(?:\.|$)/);
    await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `create role authenticator login noinherit password 'aiq-preview-ci-local-only';
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant anon, authenticated to authenticator;
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;`,
      ],
      { env: environment },
    );

    await initializePreviewDatabase({
      repositoryRoot,
      psqlCommand: integrationPsql,
      environment: { ...process.env, AIQ_DATABASE_URL: integrationDatabaseUrl },
    });
    await execFileAsync(
      integrationPsql,
      [
        '-X',
        '--no-psqlrc',
        '--quiet',
        '--set',
        'ON_ERROR_STOP=1',
        '--file',
        resolve(repositoryRoot, 'databases/smoke.sql'),
      ],
      { env: environment },
    );
    assert.deepEqual(
      await previewStatus(integrationPsql, integrationDatabaseUrl, 'anon'),
      expectedPreviewStatus,
    );
    assert.deepEqual(
      await previewStatus(integrationPsql, integrationDatabaseUrl, 'authenticated'),
      expectedPreviewStatus,
    );
    strictEqual(
      await previewStatusRowCountWithRolledBackProbe(
        integrationPsql,
        integrationDatabaseUrl,
        'update aiq_private.aiq_scoring_versions set synthetic = false;',
      ),
      0,
    );
    strictEqual(
      await previewStatusRowCountWithRolledBackProbe(
        integrationPsql,
        integrationDatabaseUrl,
        `update aiq_private.aiq_scoring_versions
set formula = jsonb_set(formula, '{domain_weight}', '0.2'::jsonb);`,
      ),
      0,
    );
    strictEqual(
      await previewStatusRowCountWithRolledBackProbe(
        integrationPsql,
        integrationDatabaseUrl,
        `set local session_replication_role = replica;
update aiq_private.aiq_submission_inbox
set envelope = jsonb_set(envelope, '{payload,synthetic}', 'false'::jsonb);
set local session_replication_role = origin;`,
      ),
      0,
    );
    strictEqual(
      await previewStatusRowCountWithRolledBackProbe(
        integrationPsql,
        integrationDatabaseUrl,
        `set local session_replication_role = replica;
update aiq_private.aiq_result_packages
set envelope = jsonb_set(envelope, '{payload,synthetic}', 'false'::jsonb);
set local session_replication_role = origin;`,
      ),
      0,
    );
    strictEqual(
      await previewStatusRowCountWithRolledBackProbe(
        integrationPsql,
        integrationDatabaseUrl,
        `set local session_replication_role = replica;
update aiq_private.aiq_matrix_batches
set synthetic = false,
    capability_validation_digest = 'sha256:' || repeat('0', 64);
set local session_replication_role = origin;`,
      ),
      0,
    );
    strictEqual(
      await previewStatusRowCountWithRolledBackProbe(
        integrationPsql,
        integrationDatabaseUrl,
        "update aiq_private.aiq_model_configs set provider_model_id = 'unexpected-model' where model_config_id = 'sol-low';",
      ),
      0,
    );

    await rejects(
      initializePreviewDatabase({
        repositoryRoot,
        psqlCommand: integrationPsql,
        environment: { ...process.env, AIQ_DATABASE_URL: integrationDatabaseUrl },
      }),
      /Discard this database/,
    );
    assert.deepEqual(
      await previewStatus(integrationPsql, integrationDatabaseUrl, 'anon'),
      expectedPreviewStatus,
    );
  },
);
