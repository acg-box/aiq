import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript-compiler-api';

import type {
  BenchmarkRunSummary,
  PublicModelEfficiency,
  ScoredLeaderboardEntry,
} from '../data/types.ts';
import { resolveExactEfficiencyRowsWithAvailability } from './scientific-evidence-resolution.ts';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    };
  },
});

const { OfficialEfficiencyTable } = await import('./official-efficiency-table.tsx');

const entry: ScoredLeaderboardEntry = {
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
  scoringVersion: '1.0.8',
  scoreStatus: 'official',
  runId: 'run-exact',
  synthetic: false,
};

const run: BenchmarkRunSummary = {
  id: 'run-exact',
  entryId: 'sol-low',
  startedAt: '2026-08-04T00:00:00.000Z',
  completedAt: '2026-08-04T00:01:00.000Z',
  benchmarkVersion: 'aiq-core@1.1.0',
  scoringVersion: '1.0.8',
  promptSetDigest: 'sha256:test',
  runnerCommit: 'test',
  region: 'test',
  synthetic: false,
  corpusReleaseId: null,
  corpusCommitmentSha256: null,
  catalogDigest: null,
  taskSetDigest: null,
  preflightDigest: null,
  runtimeDigest: null,
  runClass: null,
  permissionEvidenceDigest: null,
  resultSummary: {
    resultCount: 72,
    observedCount: 72,
    coveragePercent: 100,
    coveredDomainCount: 10,
    provisionalDomainCount: 10,
    correctCount: 20,
    partialCount: 10,
    incorrectCount: 42,
    runtimeIssueCount: 0,
    invalidCount: 0,
    missingCount: 0,
    notApplicableCount: 0,
    completedCount: 72,
  },
};

function efficiency(overrides: Partial<PublicModelEfficiency> = {}): PublicModelEfficiency {
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

void describe('Official efficiency exact-evidence availability', () => {
  void it('retains exact rows and visibly counts a drifted exclusion without naming it', () => {
    const resolution = resolveExactEfficiencyRowsWithAvailability({
      runs: [run],
      entries: [entry],
      efficiencyRows: [efficiency(), efficiency({ runId: 'run-drift', modelFamily: 'terra' })],
      expectedRunIds: ['run-exact', 'run-drift'],
    });

    assert.equal(resolution.rows.length, 1);
    assert.equal(resolution.expectedCount, 2);
    assert.equal(resolution.unavailableCount, 1);
    const html = renderToStaticMarkup(
      createElement(OfficialEfficiencyTable, {
        rows: resolution.rows,
        expectedCount: resolution.expectedCount,
        unavailableCount: resolution.unavailableCount,
        rejectedCount: resolution.rejectedCount,
      }),
    );
    assert.match(html, /aria-label="Unavailable Official efficiency evidence"/);
    assert.match(html, /1 of 2 expected Official efficiency rows are Unavailable/);
    assert.match(html, /1 returned row was rejected/);
    assert.match(html, /Sol · low/);
    assert.doesNotMatch(html, /Terra/);
  });

  void it('keeps an all-excluded result explicitly unavailable', () => {
    const resolution = resolveExactEfficiencyRowsWithAvailability({
      runs: [run],
      entries: [entry],
      efficiencyRows: [efficiency({ runId: 'run-drift', modelFamily: 'terra' })],
      expectedRunIds: ['run-exact'],
    });
    const html = renderToStaticMarkup(
      createElement(OfficialEfficiencyTable, {
        rows: resolution.rows,
        expectedCount: resolution.expectedCount,
        unavailableCount: resolution.unavailableCount,
        rejectedCount: resolution.rejectedCount,
      }),
    );

    assert.match(html, /Official efficiency is unavailable/);
    assert.match(html, /1 of 1 expected Official efficiency row is Unavailable/);
    assert.match(html, /1 returned row was rejected/);
  });

  void it('counts a missing expected row without inventing a rejected transport row', () => {
    const resolution = resolveExactEfficiencyRowsWithAvailability({
      runs: [run],
      entries: [entry],
      efficiencyRows: [efficiency()],
      expectedRunIds: ['run-exact', 'run-missing'],
    });

    assert.equal(resolution.rows.length, 1);
    assert.equal(resolution.expectedCount, 2);
    assert.equal(resolution.unavailableCount, 1);
    assert.equal(resolution.rejectedCount, 0);
  });
});
