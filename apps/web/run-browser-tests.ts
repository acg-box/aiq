import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const browserSuites = [
  'test:browser:synthetic',
  'test:browser:invalid-config',
  'test:browser:malformed-config',
  'test:browser:missing-config',
  'test:browser:live-empty',
  'test:browser:live-published',
  'test:browser:production-contract',
] as const;

const cliArguments = process.argv.slice(2);
if (cliArguments.some((argument) => argument !== '--prebuilt') || cliArguments.length > 1) {
  throw new Error('Usage: node run-browser-tests.ts [--prebuilt]');
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const prebuilt = cliArguments[0] === '--prebuilt';

function runScript(script: string, environment = process.env): number {
  const result = spawnSync(npm, ['run', script], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

let exitCode = 0;
if (!prebuilt) exitCode = runScript('build');
if (exitCode === 0 && !existsSync(join(process.cwd(), '.next', 'BUILD_ID'))) {
  throw new Error('The browser suites require one completed Next.js production build.');
}

const prebuiltEnvironment = { ...process.env, AIQ_PLAYWRIGHT_PREBUILT: '1' };
for (const suite of browserSuites) {
  if (exitCode !== 0) break;
  exitCode = runScript(suite, prebuiltEnvironment);
}
process.exitCode = exitCode;
