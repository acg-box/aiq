import type { ModelFamily, ReasoningTier } from '../data/types.ts';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';

const publicFamily = {
  Sol: 'sol',
  Terra: 'terra',
  Luna: 'luna',
} as const;

export function configurationWorkbenchFixture({
  id,
  modelFamily = 'Sol',
  reasoningTier = 'low',
  score = 80,
  duration = 100,
  cost = null,
  boundedCost = false,
}: {
  id: string;
  modelFamily?: ModelFamily;
  reasoningTier?: ReasoningTier;
  score?: number;
  duration?: number | null;
  cost?: number | null;
  boundedCost?: boolean;
}): ExactEfficiencyRow {
  return {
    entry: {
      id,
      modelFamily,
      modelName: `gpt-5.6-${publicFamily[modelFamily]}`,
      reasoningTier,
      score,
      theta: 0,
      standardError: 0.2,
      thetaCiLow: -0.4,
      thetaCiHigh: 0.4,
      scoreCiLow: score - 2,
      scoreCiHigh: score + 2,
      information: 25,
      qualityScore: score,
      strictPassRate: 0.5,
      strictPassLow: 0.4,
      strictPassHigh: 0.6,
      strictPassSampleSize: 72,
      strictPassSuccesses: 36,
      reliabilityStatus: 'single_matrix_information_only',
      calibrationStatus: 'calibrated',
      sensitivityLow: score - 1,
      sensitivityHigh: score + 1,
      sampleSize: 72,
      coveragePercent: 100,
      runtimeIssues: 0,
      missing: 0,
      scoringVersion: '1.0.8',
      scoreStatus: 'official',
      runId: `run-${id}`,
      synthetic: false,
    },
    row: {
      runId: `run-${id}`,
      matrixBatchId: 'batch-1',
      modelFamily: publicFamily[modelFamily],
      reasoningEffort: reasoningTier,
      matrixBatchElapsedMs: 1,
      summedCellAdapterElapsedMs: duration,
      observedMedianWallMs: duration,
      observedP95WallMs: duration,
      observedTimeSampleCount: duration === null ? 0 : 72,
      observedTimeCoveragePercent: duration === null ? 0 : 100,
      durationEvidenceLevel: duration === null ? null : 'runner_observed',
      inputTokens: boundedCost ? 400_000 : null,
      cachedInputTokens: boundedCost ? 100_000 : null,
      cacheWriteInputTokens: boundedCost ? 20_000 : null,
      outputTokens: boundedCost ? 50_000 : null,
      reasoningOutputTokens: boundedCost ? 10_000 : null,
      totalTokens: boundedCost ? 450_000 : null,
      tokenUsageSampleCount: boundedCost ? 72 : 0,
      tokenUsageSourceLevel: boundedCost ? 'provider_reported' : null,
      standardApiEquivalentUsdNanos: cost,
      costEstimatorStatus: boundedCost
        ? 'unavailable_context_band'
        : cost === null
          ? 'unavailable_missing_usage'
          : 'estimated',
      tokenUsageCoveragePercent: boundedCost || cost !== null ? 100 : null,
      tokenCoverage: {
        input: { count: boundedCost ? 72 : null, percent: boundedCost ? 100 : null },
        cachedInput: { count: boundedCost ? 72 : null, percent: boundedCost ? 100 : null },
        cacheWriteInput: { count: boundedCost ? 72 : null, percent: boundedCost ? 100 : null },
        output: { count: boundedCost ? 72 : null, percent: boundedCost ? 100 : null },
        reasoning: { count: boundedCost ? 72 : null, percent: boundedCost ? 100 : null },
        total: { count: boundedCost ? 72 : null, percent: boundedCost ? 100 : null },
      },
      tokenUsageEvidenceLevel: boundedCost ? 'verifier_recomputed' : null,
      costEvidenceLevel: cost === null ? null : 'verifier_recomputed',
      costMethod: boundedCost ? 'standard_api_equivalent_text_token_estimate' : null,
      pricingSource: boundedCost ? 'https://developers.openai.com/api/docs/pricing' : null,
      pricingAsOf: boundedCost ? '2026-08-02' : null,
      pricingVersion: boundedCost ? 'aiq.standard-api-equivalent-usd.v1' : null,
      pricingCurrency: cost === null && !boundedCost ? null : 'USD',
      pricingProcessingTier: cost === null && !boundedCost ? null : 'standard',
      resultCount: 72,
      attemptedResultCount: 72,
      invokedResultCount: 72,
      adapterElapsedObservedResultCount: duration === null ? 0 : 72,
      tokenObservedResultCount: boundedCost ? 72 : 0,
      pricedResultCount: boundedCost ? 61 : cost === null ? 0 : 72,
      executionConcurrency: 17,
      estimatedCostSampleCount: boundedCost ? 61 : cost === null ? 0 : 72,
      costEstimatorLimitations: [],
      pricingRates: boundedCost
        ? [
            {
              model: `gpt-5.6-${publicFamily[modelFamily]}`,
              input_usd_nanos_per_token: 5_000,
              cached_input_usd_nanos_per_token: 500,
              cache_write_input_usd_nanos_per_token: 6_250,
              output_usd_nanos_per_token: 30_000,
            },
          ]
        : [],
      costFormula: boundedCost ? 'published rate formula' : null,
    },
  };
}
