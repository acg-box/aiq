import { spawn } from 'node:child_process';

import { assertDatabaseTarget, databaseConnectionEnvironment } from './init.ts';

try {
  const sqlPath = process.argv[2];
  if (!sqlPath || process.argv.length !== 3) {
    throw new Error('Usage: node databases/psql.ts <sql-file>');
  }
  const databaseUrl = process.env.AIQ_DATABASE_URL;
  if (!databaseUrl) throw new Error('AIQ_DATABASE_URL is required');
  assertDatabaseTarget(databaseUrl, process.env);
  const environment = databaseConnectionEnvironment(databaseUrl);
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const child = spawn(
    'psql',
    ['-X', '--no-password', '--set', 'ON_ERROR_STOP=1', '--file', sqlPath],
    { env: environment, stdio: 'inherit' },
  );
  child.on('error', () => {
    process.stderr.write('Could not start psql. Check the host-managed PostgreSQL tools.\n');
    process.exitCode = 1;
  });
  child.on('close', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Database connection failed'}\n`,
  );
  process.exitCode = 1;
}
