export interface ProductionExpectedIdentity {
  readonly benchmarkVersion: string;
  readonly scoringVersion: string;
  readonly matrixBatchId: string;
  readonly runnerCommit: string;
  readonly corpusReleaseId: string;
  readonly corpusCommitment: string;
  readonly catalogDigest: string;
  readonly taskSetDigest: string;
  readonly promptSetDigest: string;
  readonly estimatedCostResultCount: number;
  readonly unavailableContextBandResultCount: number;
  readonly unavailableMissingUsageResultCount: number;
  readonly pricedCostSubtotalUsdNanos: string;
}

const environmentKeys = {
  benchmarkVersion: 'AIQ_PRODUCTION_EXPECTED_BENCHMARK_VERSION',
  scoringVersion: 'AIQ_PRODUCTION_EXPECTED_SCORING_VERSION',
  matrixBatchId: 'AIQ_PRODUCTION_EXPECTED_MATRIX_BATCH_ID',
  runnerCommit: 'AIQ_PRODUCTION_EXPECTED_RUNNER_COMMIT',
  corpusReleaseId: 'AIQ_PRODUCTION_EXPECTED_CORPUS_RELEASE_ID',
  corpusCommitment: 'AIQ_PRODUCTION_EXPECTED_CORPUS_COMMITMENT',
  catalogDigest: 'AIQ_PRODUCTION_EXPECTED_CATALOG_DIGEST',
  taskSetDigest: 'AIQ_PRODUCTION_EXPECTED_TASK_SET_DIGEST',
  promptSetDigest: 'AIQ_PRODUCTION_EXPECTED_PROMPT_SET_DIGEST',
  estimatedCostResultCount: 'AIQ_PRODUCTION_EXPECTED_ESTIMATED_COST_RESULT_COUNT',
  unavailableContextBandResultCount:
    'AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_CONTEXT_BAND_RESULT_COUNT',
  unavailableMissingUsageResultCount:
    'AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_MISSING_USAGE_RESULT_COUNT',
  pricedCostSubtotalUsdNanos: 'AIQ_PRODUCTION_EXPECTED_PRICED_COST_SUBTOTAL_USD_NANOS',
} as const satisfies Readonly<Record<keyof ProductionExpectedIdentity, string>>;

const exactKeys = [
  'benchmarkVersion',
  'scoringVersion',
  'matrixBatchId',
  'runnerCommit',
  'corpusReleaseId',
  'corpusCommitment',
  'catalogDigest',
  'taskSetDigest',
  'promptSetDigest',
  'estimatedCostResultCount',
  'unavailableContextBandResultCount',
  'unavailableMissingUsageResultCount',
  'pricedCostSubtotalUsdNanos',
] as const satisfies readonly (keyof ProductionExpectedIdentity)[];
const benchmarkPattern = /^aiq-core@\d+\.\d+\.\d+$/;
const scoringPattern = /^\d+\.\d+\.\d+$/;
const matrixBatchPattern = /^run_[0-9a-f]{64}$/;
const runnerCommitPattern = /^[0-9a-f]{7,40}$/;
const releasePattern = /^corpus_[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const digestPattern = /^sha256:(?!0{64}$)[0-9a-f]{64}$/;
const decimalPattern = /^(?:0|[1-9][0-9]*)$/;

function invalid(message: string): never {
  throw new Error(`Invalid production evidence identity: ${message}`);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateProductionExpectedIdentity(value: unknown): ProductionExpectedIdentity {
  if (!isUnknownRecord(value)) {
    return invalid('expected one object');
  }
  const actualKeys = Object.keys(value).toSorted();
  const expectedKeys = [...exactKeys].toSorted();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    return invalid('unexpected or missing fields');
  }

  const benchmarkVersion = value.benchmarkVersion;
  const scoringVersion = value.scoringVersion;
  const matrixBatchId = value.matrixBatchId;
  const runnerCommit = value.runnerCommit;
  const corpusReleaseId = value.corpusReleaseId;
  const corpusCommitment = value.corpusCommitment;
  const catalogDigest = value.catalogDigest;
  const taskSetDigest = value.taskSetDigest;
  const promptSetDigest = value.promptSetDigest;
  const estimatedCostResultCount = value.estimatedCostResultCount;
  const unavailableContextBandResultCount = value.unavailableContextBandResultCount;
  const unavailableMissingUsageResultCount = value.unavailableMissingUsageResultCount;
  const pricedCostSubtotalUsdNanos = value.pricedCostSubtotalUsdNanos;
  if (
    typeof benchmarkVersion !== 'string' ||
    typeof scoringVersion !== 'string' ||
    typeof matrixBatchId !== 'string' ||
    typeof runnerCommit !== 'string' ||
    typeof corpusReleaseId !== 'string' ||
    typeof corpusCommitment !== 'string' ||
    typeof catalogDigest !== 'string' ||
    typeof taskSetDigest !== 'string' ||
    typeof promptSetDigest !== 'string' ||
    typeof estimatedCostResultCount !== 'number' ||
    typeof unavailableContextBandResultCount !== 'number' ||
    typeof unavailableMissingUsageResultCount !== 'number' ||
    typeof pricedCostSubtotalUsdNanos !== 'string'
  ) {
    return invalid('identity fields have invalid types');
  }
  if (
    !benchmarkPattern.test(benchmarkVersion) ||
    !scoringPattern.test(scoringVersion) ||
    benchmarkVersion !== 'aiq-core@1.0.6' ||
    scoringVersion !== '1.0.7' ||
    !matrixBatchPattern.test(matrixBatchId) ||
    !runnerCommitPattern.test(runnerCommit) ||
    !releasePattern.test(corpusReleaseId) ||
    ![corpusCommitment, catalogDigest, taskSetDigest, promptSetDigest].every((digest) =>
      digestPattern.test(digest),
    )
  ) {
    return invalid('malformed or incoherent fields');
  }
  const costResultCounts = [
    estimatedCostResultCount,
    unavailableContextBandResultCount,
    unavailableMissingUsageResultCount,
  ];
  if (
    !costResultCounts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
    costResultCounts.reduce((sum, count) => sum + count, 0) !== 1_224 ||
    !decimalPattern.test(pricedCostSubtotalUsdNanos) ||
    (estimatedCostResultCount === 0) !== (pricedCostSubtotalUsdNanos === '0')
  ) {
    return invalid('cost evidence totals are malformed or incomplete');
  }

  return {
    benchmarkVersion,
    scoringVersion,
    matrixBatchId,
    runnerCommit,
    corpusReleaseId,
    corpusCommitment,
    catalogDigest,
    taskSetDigest,
    promptSetDigest,
    estimatedCostResultCount,
    unavailableContextBandResultCount,
    unavailableMissingUsageResultCount,
    pricedCostSubtotalUsdNanos,
  };
}

export function resolveProductionExpectedIdentity(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionExpectedIdentity {
  const missing = Object.values(environmentKeys).filter((key) => !environment[key]);
  if (missing.length > 0) {
    return invalid(`missing ${missing.join(', ')}`);
  }

  const numericCountFields = new Set<keyof ProductionExpectedIdentity>([
    'estimatedCostResultCount',
    'unavailableContextBandResultCount',
    'unavailableMissingUsageResultCount',
  ]);
  return validateProductionExpectedIdentity(
    Object.fromEntries(
      exactKeys.map((field) => {
        const rawValue = environment[environmentKeys[field]];
        if (numericCountFields.has(field)) {
          if (typeof rawValue !== 'string' || !decimalPattern.test(rawValue)) {
            return invalid(`${environmentKeys[field]} must be one canonical decimal integer`);
          }
          return [field, Number(rawValue)];
        }
        return [field, rawValue];
      }),
    ),
  );
}
