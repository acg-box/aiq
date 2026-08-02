import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { databaseConnectionEnvironment } from './init.ts';

const MAX_PSQL_OUTPUT_BYTES = 65_536;
const DATABASE_URL_PATTERN = /^postgres(?:ql)?:\/\/[^\s]{1,2048}(?![\s\S])/;

function transactionBody(sql: string, label: string): string {
  const lines = sql
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .split('\n');
  const statements = lines
    .map((line, index) => ({ line: line.trim().toLowerCase(), index }))
    .filter(({ line }) => line !== '' && !line.startsWith('--'));
  const first = statements[0];
  const last = statements.at(-1);

  if (
    first?.line !== 'begin;' ||
    last?.line !== 'commit;' ||
    statements
      .slice(1, -1)
      .some(({ line }) => line === 'begin;' || line === 'commit;' || line === 'rollback;')
  ) {
    throw new Error(`${label} must have one standalone begin/commit transaction wrapper`);
  }

  return lines
    .slice(first.index + 1, last.index)
    .join('\n')
    .trim();
}

export function preparePreviewInitialization(schema: string, syntheticDemo: string): string {
  return `\\set ON_ERROR_STOP on
\\set VERBOSITY verbose
begin;
do $aiq_preview_preflight$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'aiq_private')
    or exists (
      select 1 from pg_catalog.pg_roles
      where rolname in ('aiq_verifier', 'aiq_publisher')
    )
  then
    raise exception 'AIQ_PREVIEW_REUSE_REJECTED'
      using errcode = '55000';
  end if;
end
$aiq_preview_preflight$;
${transactionBody(schema, 'schema.sql')}
${transactionBody(syntheticDemo, 'synthetic-demo.sql')}
do $aiq_preview_readiness$
begin
  if not exists (
    select 1
    from public.aiq_preview_status_v1 status
    where status.contract_version = 'aiq.preview-status.v1'
      and status.profile_id = 'acgbox-aiq-preview-v1'
      and status.task_count = 72
      and status.model_configuration_count = 17
      and status.synthetic_run_count = 17
      and status.synthetic_task_result_count = 1224
      and status.synthetic_score_snapshot_count = 17
      and status.synthetic_scoring_definition_count = 1
      and status.synthetic_radar_node_count = 3
      and status.published_run_count = 0
      and status.published_leaderboard_count = 0
      and status.published_trend_point_count = 0
      and status.non_synthetic_evidence_count = 0
      and status.canonical_model_matrix
  )
  then
    raise exception 'AIQ synthetic preview readiness did not validate'
      using errcode = '23514';
  end if;
end
$aiq_preview_readiness$;
commit;
`;
}

async function runPsql(
  command: string,
  databaseUrl: string,
  sql: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const childEnvironment = databaseConnectionEnvironment(databaseUrl);
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']) {
      if (environment[key] !== undefined) childEnvironment[key] = environment[key];
    }
    const child = spawn(command, ['-X', '--no-psqlrc', '--quiet', '--set', 'ON_ERROR_STOP=1'], {
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let outputBytes = 0;
    const countOutput = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PSQL_OUTPUT_BYTES) child.kill();
    };
    child.stdout.on('data', countOutput);
    child.stderr.on('data', countOutput);
    child.on('error', () => rejectPromise(new Error('psql could not start')));
    child.on('close', (code) => {
      if (outputBytes > MAX_PSQL_OUTPUT_BYTES || code !== 0) {
        rejectPromise(
          new Error(
            'Synthetic preview initialization failed. Discard this database and use a new disposable target.',
          ),
        );
        return;
      }
      resolvePromise();
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(sql);
  });
}

export async function initializePreviewDatabase(
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly psqlCommand?: string;
    readonly repositoryRoot?: string;
  } = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const databaseUrl = environment.AIQ_DATABASE_URL;
  if (databaseUrl === undefined || !DATABASE_URL_PATTERN.test(databaseUrl)) {
    throw new Error('AIQ_DATABASE_URL must contain one PostgreSQL connection URL');
  }
  const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dirname, '..');
  const [schema, syntheticDemo] = await Promise.all([
    readFile(resolve(repositoryRoot, 'databases/schema.sql'), 'utf8'),
    readFile(resolve(repositoryRoot, 'databases/synthetic-demo.sql'), 'utf8'),
  ]);
  const sql = preparePreviewInitialization(schema, syntheticDemo);
  await runPsql(options.psqlCommand ?? 'psql', databaseUrl, sql, environment);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    if (process.argv.length !== 2) {
      throw new Error('Usage: node databases/preview-init.ts');
    }
    await initializePreviewDatabase();
    process.stdout.write('Synthetic preview database initialized. Do not use it for production.\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview initialization failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
