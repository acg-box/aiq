import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveProductionExpectedIdentity,
  validateProductionExpectedIdentity,
} from '../playwright-production-identity.ts';

const identity = {
  benchmarkVersion: 'aiq-core@1.0.5',
  scoringVersion: '1.0.5',
  matrixBatchId: `run_${'5'.repeat(64)}`,
  runnerCommit: 'a79a6616128eb3161069e4fd50657df0b88e6760',
  corpusReleaseId: 'corpus_2026.08.04-aiq-core-1.0.5-final',
  corpusCommitment: `sha256:${'1'.repeat(64)}`,
  catalogDigest: 'sha256:c575726d933ee4c0b47f7855f9d1aa820188109910e2a3b0288f10a4026b8edb',
  taskSetDigest: `sha256:${'3'.repeat(64)}`,
  promptSetDigest: `sha256:${'4'.repeat(64)}`,
  estimatedCostResultCount: 1_208,
  unavailableContextBandResultCount: 10,
  unavailableMissingUsageResultCount: 6,
  pricedCostSubtotalUsdNanos: '125403257240',
} as const;

const environment = {
  AIQ_PRODUCTION_EXPECTED_BENCHMARK_VERSION: identity.benchmarkVersion,
  AIQ_PRODUCTION_EXPECTED_SCORING_VERSION: identity.scoringVersion,
  AIQ_PRODUCTION_EXPECTED_MATRIX_BATCH_ID: identity.matrixBatchId,
  AIQ_PRODUCTION_EXPECTED_RUNNER_COMMIT: identity.runnerCommit,
  AIQ_PRODUCTION_EXPECTED_CORPUS_RELEASE_ID: identity.corpusReleaseId,
  AIQ_PRODUCTION_EXPECTED_CORPUS_COMMITMENT: identity.corpusCommitment,
  AIQ_PRODUCTION_EXPECTED_CATALOG_DIGEST: identity.catalogDigest,
  AIQ_PRODUCTION_EXPECTED_TASK_SET_DIGEST: identity.taskSetDigest,
  AIQ_PRODUCTION_EXPECTED_PROMPT_SET_DIGEST: identity.promptSetDigest,
  AIQ_PRODUCTION_EXPECTED_ESTIMATED_COST_RESULT_COUNT: String(identity.estimatedCostResultCount),
  AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_CONTEXT_BAND_RESULT_COUNT: String(
    identity.unavailableContextBandResultCount,
  ),
  AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_MISSING_USAGE_RESULT_COUNT: String(
    identity.unavailableMissingUsageResultCount,
  ),
  AIQ_PRODUCTION_EXPECTED_PRICED_COST_SUBTOTAL_USD_NANOS: identity.pricedCostSubtotalUsdNanos,
};

void describe('production evidence identity', () => {
  void it('resolves one explicit, coherent expected publication identity', () => {
    assert.deepEqual(resolveProductionExpectedIdentity(environment), identity);
    assert.deepEqual(validateProductionExpectedIdentity(identity), identity);
  });

  void it('fails closed for missing, malformed, zero, extra, and version-drifted values', () => {
    const { AIQ_PRODUCTION_EXPECTED_PROMPT_SET_DIGEST: _omitted, ...missing } = environment;
    for (const value of [
      missing,
      { ...environment, AIQ_PRODUCTION_EXPECTED_CORPUS_COMMITMENT: `sha256:${'0'.repeat(64)}` },
      { ...environment, AIQ_PRODUCTION_EXPECTED_SCORING_VERSION: '1.0.2' },
      { ...environment, AIQ_PRODUCTION_EXPECTED_MATRIX_BATCH_ID: `run_${'0'.repeat(63)}` },
      { ...environment, AIQ_PRODUCTION_EXPECTED_RUNNER_COMMIT: 'not-a-commit' },
      { ...environment, AIQ_PRODUCTION_EXPECTED_CORPUS_RELEASE_ID: 'corpus invalid' },
      { ...environment, AIQ_PRODUCTION_EXPECTED_ESTIMATED_COST_RESULT_COUNT: '1207' },
      { ...environment, AIQ_PRODUCTION_EXPECTED_ESTIMATED_COST_RESULT_COUNT: '1208.0' },
      { ...environment, AIQ_PRODUCTION_EXPECTED_PRICED_COST_SUBTOTAL_USD_NANOS: '0' },
      { ...environment, AIQ_PRODUCTION_EXPECTED_PRICED_COST_SUBTOTAL_USD_NANOS: '0125' },
    ]) {
      assert.throws(
        () => resolveProductionExpectedIdentity(value),
        /Invalid production evidence identity/,
      );
    }
    assert.throws(
      () => validateProductionExpectedIdentity({ ...identity, unexpected: true }),
      /Invalid production evidence identity/,
    );
  });
});
