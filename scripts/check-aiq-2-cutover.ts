import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseConnectionEnvironment } from '../databases/init.ts';

export const AIQ_2_CUTOVER_QUERY = `
with target_batches as (
  select matrix_batch_id
  from aiq_private.aiq_matrix_batches
  where scoring_version = '1.0.8'
    and not synthetic
    and published_at is not null
), target_runs as (
  select run.*
  from aiq_private.aiq_runs run
  join target_batches batch on batch.matrix_batch_id = run.matrix_batch_id
  where run.scoring_version = '1.0.8'
    and not run.synthetic
    and run.published
), target_scores as (
  select score.*, run.matrix_batch_id, run.synthetic
  from aiq_private.aiq_score_snapshots score
  join target_runs run on run.run_id = score.run_id
  where score.scoring_version = '1.0.8'
    and score.score_status = 'official'
    and score.published
)
select json_build_object(
  'measurement_version', (
    select formula ->> 'measurement_version'
    from aiq_private.aiq_scoring_versions
    where scoring_version = '1.0.8' and is_published
  ),
  'measurement_method', (
    select formula ->> 'measurement_method'
    from aiq_private.aiq_scoring_versions
    where scoring_version = '1.0.8' and is_published
  ),
  'published_batches', (select count(distinct matrix_batch_id) from target_batches),
  'published_runs', (select count(distinct run_id) from target_runs),
  'official_scores', (select count(*) from target_scores),
  'published_task_results', (
    select count(*)
    from aiq_private.aiq_task_results result
    join target_runs run on run.run_id = result.run_id
  ),
  'calibration_digests', (
    select count(distinct latent_ability ->> 'calibration_digest') from target_scores
  ),
  'synthetic_official_scores', (
    select count(*) from aiq_private.aiq_score_snapshots score
    join aiq_private.aiq_runs run on run.run_id = score.run_id
    where score.published and score.score_status = 'official' and run.synthetic
  ),
  'public_official_rows', (
    select count(*) from public.public_leaderboard where score_status = 'official'
  ),
  'public_synthetic_rows', (
    select count(*) from public.public_leaderboard where synthetic
  )
)::text;
`;

export interface Aiq2CutoverEvidence {
  readonly measurement_version: string | null;
  readonly measurement_method: string | null;
  readonly published_batches: number;
  readonly published_runs: number;
  readonly official_scores: number;
  readonly published_task_results: number;
  readonly calibration_digests: number;
  readonly synthetic_official_scores: number;
  readonly public_official_rows: number;
  readonly public_synthetic_rows: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`AIQ 2.0 cutover evidence field ${label} is not an integer`);
  }
  return value;
}

export function parseAiq2CutoverEvidence(value: unknown): Aiq2CutoverEvidence {
  if (!isObject(value)) throw new Error('AIQ 2.0 cutover evidence must be an object');
  const evidence: Aiq2CutoverEvidence = {
    measurement_version:
      typeof value.measurement_version === 'string' ? value.measurement_version : null,
    measurement_method:
      typeof value.measurement_method === 'string' ? value.measurement_method : null,
    published_batches: integer(value.published_batches, 'published_batches'),
    published_runs: integer(value.published_runs, 'published_runs'),
    official_scores: integer(value.official_scores, 'official_scores'),
    published_task_results: integer(value.published_task_results, 'published_task_results'),
    calibration_digests: integer(value.calibration_digests, 'calibration_digests'),
    synthetic_official_scores: integer(
      value.synthetic_official_scores,
      'synthetic_official_scores',
    ),
    public_official_rows: integer(value.public_official_rows, 'public_official_rows'),
    public_synthetic_rows: integer(value.public_synthetic_rows, 'public_synthetic_rows'),
  };
  if (
    evidence.measurement_version !== '2.0.0' ||
    evidence.measurement_method !== 'rasch_fractional_fixed_bank_map_v2' ||
    evidence.published_batches !== 1 ||
    evidence.published_runs !== 17 ||
    evidence.official_scores !== 17 ||
    evidence.published_task_results !== 1224 ||
    evidence.calibration_digests !== 1 ||
    evidence.synthetic_official_scores !== 0 ||
    evidence.public_official_rows !== 17 ||
    evidence.public_synthetic_rows !== 0
  ) {
    throw new Error(
      'AIQ 2.0 cutover is blocked: one new, non-synthetic, published 17×72 Official matrix with the joint Rasch bank is required',
    );
  }
  return evidence;
}

async function query(databaseUrl: string): Promise<unknown> {
  const environment = databaseConnectionEnvironment(databaseUrl);
  if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'psql',
      ['-X', '--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1'],
      { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(`AIQ 2.0 cutover query failed: ${Buffer.concat(stderr).toString('utf8')}`),
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(stdout).toString('utf8').trim()) as unknown);
      } catch {
        rejectPromise(new Error('AIQ 2.0 cutover query returned malformed JSON'));
      }
    });
    child.stdin.end(AIQ_2_CUTOVER_QUERY);
  });
}

const databaseUrl = process.env.AIQ_DATABASE_URL;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (databaseUrl === undefined || databaseUrl === '') {
    process.stderr.write('AIQ_DATABASE_URL is required for the AIQ 2.0 cutover gate\n');
    process.exitCode = 1;
  } else {
    try {
      const evidence = parseAiq2CutoverEvidence(await query(databaseUrl));
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'AIQ 2.0 cutover blocked'}\n`,
      );
      process.exitCode = 1;
    }
  }
}
