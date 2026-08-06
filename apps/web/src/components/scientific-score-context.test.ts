import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunScientificSummary,
  formatScientificScoreContextHtml,
  hasExactScientificIdentity,
  joinExactRunScientificEvidence,
} from './scientific-score-context.ts';
import {
  resolveExactEfficiencyRows,
  resolveExactScientificEvidence,
} from './scientific-evidence-resolution.ts';
import type { LeaderboardEntry, PublicModelEfficiency } from '../data/types.ts';

function scoredEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    id: 'sol-low',
    modelFamily: 'Sol',
    modelName: 'model',
    reasoningTier: 'low',
    score: 50,
    theta: 0.4,
    standardError: 0.2,
    thetaCiLow: 0.01,
    thetaCiHigh: 0.79,
    scoreCiLow: 40,
    scoreCiHigh: 60,
    information: 24,
    qualityScore: 50,
    strictPassRate: 0.5,
    strictPassLow: 0.39,
    strictPassHigh: 0.61,
    strictPassSampleSize: 72,
    strictPassSuccesses: 36,
    reliabilityStatus: 'single_matrix_information_only',
    calibrationStatus: 'calibrated',
    sensitivityLow: 40,
    sensitivityHigh: 60,
    sampleSize: 72,
    coveragePercent: 100,
    runtimeIssues: 0,
    missing: 0,
    scoringVersion: '1.0.5',
    scoreStatus: 'official',
    runId: 'run-exact',
    synthetic: false,
    ...overrides,
  };
}

function efficiencyIdentity(overrides: Partial<PublicModelEfficiency> = {}): PublicModelEfficiency {
  return {
    runId: 'run-exact',
    matrixBatchId: 'batch-exact',
    modelFamily: 'sol',
    reasoningEffort: 'low',
    matrixBatchElapsedMs: 1,
    summedCellAdapterElapsedMs: 1,
    observedMedianWallMs: 1,
    observedP95WallMs: 1,
    observedTimeSampleCount: 72,
    observedTimeCoveragePercent: 100,
    durationEvidenceLevel: 'runner_observed',
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    tokenUsageSampleCount: 0,
    tokenUsageSourceLevel: null,
    standardApiEquivalentUsdNanos: null,
    costEstimatorStatus: 'unavailable_missing_usage',
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
    costEvidenceLevel: null,
    costMethod: null,
    pricingSource: null,
    pricingAsOf: null,
    pricingVersion: null,
    pricingCurrency: null,
    pricingProcessingTier: null,
    resultCount: 72,
    attemptedResultCount: 72,
    invokedResultCount: 72,
    adapterElapsedObservedResultCount: 72,
    tokenObservedResultCount: 0,
    pricedResultCount: 0,
    executionConcurrency: 17,
    estimatedCostSampleCount: 0,
    costEstimatorLimitations: [],
    pricingRates: [],
    costFormula: null,
    ...overrides,
  };
}

void describe('scientific score context', () => {
  void it('keeps sample, coverage, execution state, scoring, and provenance together', () => {
    assert.equal(
      formatScientificScoreContextHtml({
        sampleSize: 72,
        coverage: '98.6%',
        runtime: '2 issues',
        missing: '1',
        status: 'official',
        scoringVersion: '1.0.5',
        provenance: 'published',
      }),
      'score n=72 · coverage 98.6%<br/>runtime 2 issues · missing 1<br/>status official · scoring 1.0.5 · published',
    );
  });

  void it('states unavailable aggregate execution evidence instead of inventing zero', () => {
    const context = formatScientificScoreContextHtml({
      sampleSize: 1,
      coverage: '100.0%',
      runtime: 'adapter invoked 0/0 attempted',
      missing: 'unavailable in aggregate',
      status: 'conditional observed',
      scoringVersion: '1.0.5',
      provenance: 'synthetic',
    });

    assert.match(context, /missing unavailable in aggregate/);
    assert.doesNotMatch(context, /missing 0/);
  });

  void it('joins score and efficiency only through the exact run identity', () => {
    const summary = buildRunScientificSummary({
      run: {
        id: 'run-exact',
        entryId: 'sol-low',
        scoringVersion: '1.0.5',
        synthetic: false,
      },
      resultSummary: {
        resultCount: 72,
        observedCount: 70,
        coveragePercent: 97.2,
        coveredDomainCount: 10,
        provisionalDomainCount: 10,
        correctCount: 20,
        partialCount: 10,
        incorrectCount: 38,
        runtimeIssueCount: 2,
        invalidCount: 0,
        missingCount: 2,
        notApplicableCount: 0,
        completedCount: 68,
      },
      leaderboardEntry: {
        id: 'sol-low',
        modelFamily: 'Sol',
        modelName: 'model',
        reasoningTier: 'low',
        score: 50,
        theta: 0.4,
        standardError: 0.2,
        thetaCiLow: 0.01,
        thetaCiHigh: 0.79,
        scoreCiLow: 40,
        scoreCiHigh: 60,
        information: 24,
        qualityScore: 50,
        strictPassRate: 0.5,
        strictPassLow: 0.39,
        strictPassHigh: 0.61,
        strictPassSampleSize: 72,
        strictPassSuccesses: 36,
        reliabilityStatus: 'single_matrix_information_only',
        calibrationStatus: 'calibrated',
        sensitivityLow: 40,
        sensitivityHigh: 60,
        sampleSize: 72,
        coveragePercent: 100,
        runtimeIssues: 0,
        missing: 0,
        scoringVersion: '1.0.5',
        scoreStatus: 'official',
        runId: 'run-other',
        synthetic: false,
      },
    });

    assert.equal(summary.score, 'Unavailable');
    assert.equal(summary.interval, 'Unavailable');
    assert.equal(summary.sampleSize, 'Unavailable');
    assert.equal(summary.coverage, '97.2%');
    assert.equal(summary.runtime, '2');
    assert.equal(summary.missing, '2');
    assert.equal(summary.adapterDuration, 'Unavailable');
    assert.equal(summary.cost, 'Unavailable');
  });

  void it('renders joined evidence drift as unavailable without throwing', () => {
    const summary = buildRunScientificSummary({
      run: {
        id: 'run-exact',
        entryId: 'sol-low',
        scoringVersion: '1.0.5',
        synthetic: false,
      },
      resultSummary: {
        resultCount: 72,
        observedCount: 72,
        coveragePercent: 100,
        coveredDomainCount: 10,
        provisionalDomainCount: 10,
        correctCount: 24,
        partialCount: 12,
        incorrectCount: 36,
        runtimeIssueCount: 0,
        invalidCount: 0,
        missingCount: 0,
        notApplicableCount: 0,
        completedCount: 72,
      },
      leaderboardEntry: scoredEntry({ modelFamily: 'Terra' }),
      efficiency: efficiencyIdentity({ modelFamily: 'terra' }),
    });

    assert.equal(summary.score, 'Unavailable');
    assert.equal(summary.interval, 'Unavailable');
    assert.equal(summary.sampleSize, 'Unavailable');
    assert.equal(summary.adapterDuration, 'Unavailable');
    assert.equal(summary.batchWallClock, 'Unavailable');
    assert.equal(summary.cost, 'Unavailable');
    assert.equal(summary.metricCoverage, 'Unavailable');
    assert.equal(summary.coverage, '100.0%');
  });

  void it('binds run, configuration, scoring, and provenance as one identity', () => {
    const run = {
      id: 'run-exact',
      entryId: 'sol-low',
      scoringVersion: '1.0.5',
      synthetic: false,
    };
    assert.equal(
      hasExactScientificIdentity(run, {
        runId: 'run-exact',
        entryId: 'sol-low',
        scoringVersion: '1.0.5',
        synthetic: false,
      }),
      true,
    );
    for (const candidate of [
      { runId: 'run-other', entryId: 'sol-low', scoringVersion: '1.0.5', synthetic: false },
      { runId: 'run-exact', entryId: 'terra-low', scoringVersion: '1.0.5', synthetic: false },
      { runId: 'run-exact', entryId: 'sol-low', scoringVersion: '1.0.2', synthetic: false },
      { runId: 'run-exact', entryId: 'sol-low', scoringVersion: '1.0.5', synthetic: true },
    ]) {
      assert.equal(hasExactScientificIdentity(run, candidate), false);
    }
  });

  void it('rejects mismatched and ambiguous score evidence', () => {
    const run = {
      id: 'run-exact',
      entryId: 'sol-low',
      scoringVersion: '1.0.5',
      synthetic: false,
    };
    for (const entry of [
      scoredEntry({ id: 'terra-low', modelFamily: 'Terra' }),
      scoredEntry({ modelFamily: 'Terra' }),
      scoredEntry({ scoringVersion: '1.0.2' }),
      scoredEntry({ scoreStatus: 'synthetic_complete', synthetic: true }),
    ]) {
      assert.throws(
        () => joinExactRunScientificEvidence({ run, entries: [entry], efficiencyRows: [] }),
        /Mismatched leaderboard evidence/,
      );
    }
    assert.throws(
      () =>
        joinExactRunScientificEvidence({
          run,
          entries: [scoredEntry(), scoredEntry({ id: 'terra-low', modelFamily: 'Terra' })],
          efficiencyRows: [],
        }),
      /Ambiguous leaderboard evidence/,
    );
  });

  void it('rejects mismatched, synthetic, and ambiguous efficiency evidence', () => {
    const run = {
      id: 'run-exact',
      entryId: 'sol-low',
      scoringVersion: '1.0.5',
      synthetic: false,
    };
    const exact = joinExactRunScientificEvidence({
      run,
      entries: [scoredEntry()],
      efficiencyRows: [efficiencyIdentity()],
    });
    assert.equal(exact.score?.id, 'sol-low');
    assert.equal(exact.efficiency?.runId, 'run-exact');
    assert.throws(
      () =>
        joinExactRunScientificEvidence({
          run,
          entries: [scoredEntry()],
          efficiencyRows: [efficiencyIdentity({ modelFamily: 'terra' })],
        }),
      /Mismatched efficiency evidence/,
    );
    assert.throws(
      () =>
        joinExactRunScientificEvidence({
          run: { ...run, synthetic: true },
          entries: [],
          efficiencyRows: [efficiencyIdentity()],
        }),
      /Mismatched efficiency evidence/,
    );
    assert.throws(
      () =>
        joinExactRunScientificEvidence({
          run,
          entries: [],
          efficiencyRows: [efficiencyIdentity(), efficiencyIdentity({ reasoningEffort: 'high' })],
        }),
      /Ambiguous efficiency evidence/,
    );
    assert.throws(
      () =>
        joinExactRunScientificEvidence({
          run,
          entries: [scoredEntry({ runId: 'run-old-1' }), scoredEntry({ runId: 'run-old-2' })],
          efficiencyRows: [efficiencyIdentity()],
        }),
      /Ambiguous configuration evidence/,
    );
  });

  void it('resolves UI evidence only through exact run, configuration, scoring, and provenance', () => {
    const run = {
      id: 'run-exact',
      entryId: 'sol-low',
      scoringVersion: '1.0.5',
      synthetic: false,
    };
    const candidate = {
      runId: 'run-exact',
      entryId: 'sol-low',
      scoringVersion: '1.0.5',
      synthetic: false,
    };
    const exact = resolveExactScientificEvidence({
      candidate,
      runs: [run],
      entries: [scoredEntry()],
      efficiencyRows: [efficiencyIdentity()],
    });
    assert.equal(exact.state, 'exact');
    if (exact.state === 'exact') {
      assert.equal(exact.evidence.score?.id, 'sol-low');
      assert.equal(exact.evidence.efficiency?.runId, 'run-exact');
    }

    for (const driftedRun of [
      { ...run, entryId: 'terra-low' },
      { ...run, scoringVersion: '1.0.2' },
      { ...run, synthetic: true },
    ]) {
      assert.deepEqual(
        resolveExactScientificEvidence({
          candidate,
          runs: [driftedRun],
          entries: [scoredEntry()],
          efficiencyRows: [efficiencyIdentity()],
        }),
        { state: 'unavailable' },
      );
    }
  });

  void it('converts exact-join errors to unavailable and excludes drifted efficiency points', () => {
    const run = {
      id: 'run-exact',
      entryId: 'sol-low',
      scoringVersion: '1.0.5',
      synthetic: false,
    };
    const candidate = {
      runId: 'run-exact',
      entryId: 'sol-low',
      scoringVersion: '1.0.5',
      synthetic: false,
    };
    const wrongConfiguration = efficiencyIdentity({ modelFamily: 'terra' });
    assert.deepEqual(
      resolveExactScientificEvidence({
        candidate,
        runs: [run],
        entries: [scoredEntry()],
        efficiencyRows: [wrongConfiguration],
      }),
      { state: 'unavailable' },
    );
    assert.equal(
      resolveExactEfficiencyRows({
        runs: [run],
        entries: [scoredEntry()],
        efficiencyRows: [efficiencyIdentity()],
      }).length,
      1,
    );
    assert.deepEqual(
      resolveExactEfficiencyRows({
        runs: [run],
        entries: [scoredEntry()],
        efficiencyRows: [wrongConfiguration],
      }),
      [],
    );
    assert.deepEqual(
      resolveExactEfficiencyRows({
        runs: [{ ...run, scoringVersion: '1.0.2' }],
        entries: [scoredEntry()],
        efficiencyRows: [efficiencyIdentity()],
      }),
      [],
    );
    assert.deepEqual(
      resolveExactEfficiencyRows({
        runs: [run],
        entries: [scoredEntry(), scoredEntry()],
        efficiencyRows: [efficiencyIdentity()],
      }),
      [],
    );
    assert.deepEqual(
      resolveExactEfficiencyRows({
        runs: [run],
        entries: [scoredEntry()],
        efficiencyRows: [efficiencyIdentity(), efficiencyIdentity()],
      }),
      [],
    );
  });
});
