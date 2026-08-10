import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';
import {
  configurationFrontierKeys,
  orderConfigurationDecisions,
  summarizeConfigurationDecisions,
} from './configuration-decision.ts';

function candidate(
  id: string,
  score: number,
  duration: number | null,
  cost: number | null,
): ExactEfficiencyRow {
  return {
    entry: {
      id,
      modelFamily: 'Sol',
      modelName: 'gpt-5.6-sol',
      reasoningTier: 'low',
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
      modelFamily: 'sol',
      reasoningEffort: 'low',
      matrixBatchElapsedMs: 1,
      summedCellAdapterElapsedMs: duration,
      observedMedianWallMs: duration,
      observedP95WallMs: duration,
      observedTimeSampleCount: duration === null ? 0 : 72,
      observedTimeCoveragePercent: duration === null ? 0 : 100,
      durationEvidenceLevel: duration === null ? null : 'runner_observed',
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      tokenUsageSampleCount: 0,
      tokenUsageSourceLevel: null,
      standardApiEquivalentUsdNanos: cost,
      costEstimatorStatus: cost === null ? 'unavailable_missing_usage' : 'estimated',
      tokenUsageCoveragePercent: null,
      tokenCoverage: {
        input: { count: null, percent: null },
        cachedInput: { count: null, percent: null },
        cacheWriteInput: { count: null, percent: null },
        output: { count: null, percent: null },
        reasoning: { count: null, percent: null },
        total: { count: null, percent: null },
      },
      tokenUsageEvidenceLevel: null,
      costEvidenceLevel: cost === null ? null : 'verifier_recomputed',
      costMethod: null,
      pricingSource: null,
      pricingAsOf: null,
      pricingVersion: null,
      pricingCurrency: cost === null ? null : 'USD',
      pricingProcessingTier: cost === null ? null : 'standard',
      resultCount: 72,
      attemptedResultCount: 72,
      invokedResultCount: 72,
      adapterElapsedObservedResultCount: duration === null ? 0 : 72,
      tokenObservedResultCount: 0,
      pricedResultCount: cost === null ? 0 : 72,
      executionConcurrency: 17,
      estimatedCostSampleCount: cost === null ? 0 : 72,
      costEstimatorLimitations: [],
      pricingRates: [],
      costFormula: null,
    },
  };
}

const rows = [
  candidate('strong', 90, 300, 500),
  candidate('fast', 80, 100, 400),
  candidate('cheap', 70, 200, 100),
  candidate('dominated', 60, 400, 600),
  candidate('unknown-cost', 85, 250, null),
] as const;

void describe('configuration decision ordering', () => {
  void it('identifies each transparent decision shortcut without inventing a combined score', () => {
    const summary = summarizeConfigurationDecisions(rows);
    assert.equal(summary.highestAbility?.entry.id, 'strong');
    assert.equal(summary.shortestTime?.entry.id, 'fast');
    assert.equal(summary.lowestCost?.entry.id, 'cheap');
    assert.equal(summary.fullyMeasuredCount, 4);
  });

  void it('orders by the selected auxiliary metric and keeps unavailable values last', () => {
    assert.deepEqual(
      orderConfigurationDecisions(rows, 'time').map(({ entry }) => entry.id),
      ['fast', 'cheap', 'unknown-cost', 'strong', 'dominated'],
    );
    assert.deepEqual(
      orderConfigurationDecisions(rows, 'cost').map(({ entry }) => entry.id),
      ['cheap', 'fast', 'strong', 'dominated', 'unknown-cost'],
    );
  });

  void it('uses a three-measure Pareto frontier and excludes incomplete or dominated evidence', () => {
    assert.deepEqual([...configurationFrontierKeys(rows)].toSorted(), ['cheap', 'fast', 'strong']);
    assert.deepEqual(
      orderConfigurationDecisions(rows, 'frontier').map(({ entry }) => entry.id),
      ['strong', 'fast', 'cheap'],
    );
  });
});
