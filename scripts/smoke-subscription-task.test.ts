import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const makefileUrl = new URL('../Makefile.toml', import.meta.url);
const smokeSourceUrl = new URL(
  '../apps/aiq-runner/src/runner/subscription_smoke_tests.rs',
  import.meta.url,
);

void test('subscription smokes reject non-macOS platforms before Cargo', async () => {
  const makefile = await readFile(makefileUrl, 'utf8');
  const gate = makefile.match(
    /\[tasks\.require-subscription-smoke-platform\][\s\S]*?\[tasks\.smoke-subscription\]/,
  )?.[0];
  const smoke = makefile.match(
    /\[tasks\.smoke-subscription\][\s\S]*?(?=\[tasks\.smoke-controlled-subscription\])/,
  )?.[0];
  const controlled = makefile.match(
    /\[tasks\.smoke-controlled-subscription\][\s\S]*?(?=\n# Test)/,
  )?.[0];

  assert.ok(gate, 'subscription smoke platform gate is missing');
  assert.match(gate, /\[tasks\.require-subscription-smoke-platform\.windows\]/);
  assert.match(gate, /supported only on macOS/);
  assert.doesNotMatch(gate, /command\s*=\s*"cargo"/);

  assert.ok(smoke, 'subscription smoke task is missing');
  assert.match(smoke, /dependencies\s*=\s*\["require-subscription-smoke-platform"\]/);
  assert.match(smoke, /command\s*=\s*"cargo"/);

  assert.ok(controlled, 'controlled subscription smoke task is missing');
  assert.match(controlled, /dependencies\s*=\s*\["require-subscription-smoke-platform"\]/);
  assert.match(controlled, /command\s*=\s*"cargo"/);
  assert.match(
    controlled,
    /real_codex_controlled_subscription_smoke_executes_fixed_hidden_task_once/,
  );
});

void test('controlled subscription smoke keeps the fixed live boundary and evaluator wiring', async () => {
  const source = await readFile(smokeSourceUrl, 'utf8');

  for (const required of [
    'AIQ_ALLOW_PAID_CONTROLLED_SUBSCRIPTION_SMOKE',
    'AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_TASK_ROOT',
    'AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_BASELINE_ROOT',
    'AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EVALUATOR_ROOT',
    'AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EVALUATOR_RUNTIME',
    'AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_CORPUS_COMMITMENT',
    'AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EXECUTION_ROOT',
    'AIQ_REAL_CODEX_BINARY',
    'AIQ_REAL_CODEX_HOME',
    'AIQ_REAL_CODEX_TOOLCHAIN_ROOT',
    'AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_ARTIFACT_ROOT',
    'AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_OUTPUT',
    'documentation-communication-01',
    'LocalDirectoryWorkspaceProvider::new',
    'Some(&config.evaluator_root)',
    'Some(&runtime)',
    'create_new(true)',
    'Permissions::from_mode(0o700)',
    'mode(0o600)',
    'local_controlled_subscription_smoke_non_official',
    'validate_corpus_commitment',
    'corpus_release_id',
    'corpus_commitment_sha256',
    'controlled_smoke_denied_roots',
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(source, /MODEL_MATRIX\[0\]/);
  assert.match(source, /attempts != 1/);
  assert.match(
    source,
    /LocalDirectoryWorkspaceProvider::new\(\s*&config\.baseline_root,\s*execution,/,
  );
  assert.doesNotMatch(source, /retained\.join\("execution"\)/);
  assert.match(source, /EvaluationOutcome::Correct\s*=>\s*score\s*==\s*1\.0/);
  assert.match(
    source,
    /EvaluationOutcome::Partial\s*=>\s*score\s*>\s*0\.0\s*&&\s*score\s*<\s*1\.0/,
  );
  assert.match(source, /EvaluationOutcome::Incorrect\s*=>\s*score\s*==\s*0\.0/);

  const controlledTest = source.slice(
    source.indexOf('fn real_codex_controlled_subscription_smoke_executes_fixed_hidden_task_once()'),
  );
  const corpusValidation = controlledTest.indexOf('load_controlled_corpus(');
  const artifactCreation = controlledTest.indexOf('create_private_artifact_root(');

  assert.ok(corpusValidation >= 0, 'owning corpus validation is missing');
  assert.ok(
    corpusValidation < artifactCreation,
    'corpus validation must precede retained artifact creation',
  );
});
