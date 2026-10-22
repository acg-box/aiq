import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const command = join(import.meta.dirname, 'psql.ts');
const pooler = 'aws-0-ca-central-1.pooler.supabase.com';

void test('SQL commands pass Session Pooler credentials only in the psql environment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-psql-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const psql = join(root, 'psql');
  await writeFile(
    psql,
    `#!${process.execPath}
console.log(JSON.stringify({
  args: process.argv.slice(2),
  host: process.env.PGHOST, port: process.env.PGPORT,
  database: process.env.PGDATABASE, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, sslmode: process.env.PGSSLMODE,
  databaseUrl: process.env.AIQ_DATABASE_URL,
  unrelatedToken: process.env.AIQ_TEST_UNRELATED_TOKEN,
}));
`,
  );
  await chmod(psql, 0o700);
  const { stdout } = await execFileAsync(process.execPath, [command, 'fixture.sql'], {
    env: {
      PATH: `${root}:${process.env.PATH ?? ''}`,
      AIQ_DATABASE_URL: `postgresql://postgres.xxnszykaeapolqdnhalx:fixture-password@${pooler}:5432/postgres?sslmode=require`,
      AIQ_TEST_UNRELATED_TOKEN: 'unrelated-secret',
    },
  });
  assert.deepEqual(JSON.parse(stdout), {
    args: ['-X', '--no-password', '--set', 'ON_ERROR_STOP=1', '--file', 'fixture.sql'],
    host: pooler,
    port: '5432',
    database: 'postgres',
    user: 'postgres.xxnszykaeapolqdnhalx',
    password: 'fixture-password',
    sslmode: 'require',
  });
});

void test('SQL commands reject the old direct host before psql starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aiq-psql-rejected-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'invoked');
  const psql = join(root, 'psql');
  await writeFile(
    psql,
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked');
`,
  );
  await chmod(psql, 0o700);
  await assert.rejects(
    execFileAsync(process.execPath, [command, 'fixture.sql'], {
      env: {
        PATH: `${root}:${process.env.PATH ?? ''}`,
        AIQ_DATABASE_URL:
          'postgresql://postgres:fixture-password@db.xxnszykaeapolqdnhalx.supabase.co:5432/postgres',
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Session Pooler on port 5432/);
      assert.doesNotMatch(error.message, /fixture-password/);
      return true;
    },
  );
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
