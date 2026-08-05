import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

import type {
  BenchmarkRunSummary,
  LeaderboardEntry,
  ModelFamily,
  PublicModelEfficiency,
  ReasoningTier,
} from '../data/types.ts';

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

const { EfficiencyPlot, resolveEfficiencyPlotEvidence } = await import('./efficiency-plot.tsx');

const configurations = [
  ['Sol', 'low'],
  ['Sol', 'medium'],
  ['Sol', 'high'],
  ['Sol', 'xhigh'],
  ['Sol', 'max'],
  ['Sol', 'ultra'],
  ['Terra', 'low'],
  ['Terra', 'medium'],
  ['Terra', 'high'],
  ['Terra', 'xhigh'],
  ['Terra', 'max'],
  ['Terra', 'ultra'],
  ['Luna', 'low'],
  ['Luna', 'medium'],
  ['Luna', 'high'],
  ['Luna', 'xhigh'],
  ['Luna', 'max'],
] as const satisfies ReadonlyArray<readonly [ModelFamily, ReasoningTier]>;

function configurationId(family: ModelFamily, tier: ReasoningTier): string {
  return `${family.toLowerCase()}-${tier}`;
}

function entry(family: ModelFamily, tier: ReasoningTier, index: number): LeaderboardEntry {
  const id = configurationId(family, tier);
  return {
    id,
    modelFamily: family,
    modelName: `model-${family.toLowerCase()}`,
    reasoningTier: tier,
    score: 40 + index,
    sensitivityLow: 39 + index,
    sensitivityHigh: 41 + index,
    sampleSize: 72,
    coveragePercent: 100,
    runtimeIssues: 0,
    missing: 0,
    scoringVersion: '1.0.5',
    scoreStatus: 'official',
    runId: `run-${id}`,
    synthetic: false,
  };
}

function run(family: ModelFamily, tier: ReasoningTier): BenchmarkRunSummary {
  const id = configurationId(family, tier);
  return {
    id: `run-${id}`,
    entryId: id,
    startedAt: '2026-08-04T00:00:00.000Z',
    completedAt: '2026-08-04T00:01:00.000Z',
    benchmarkVersion: 'aiq-core@1.0.5',
    scoringVersion: '1.0.5',
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
    runClass: 'official',
    permissionEvidenceDigest: null,
    resultSummary: {
      resultCount: 72,
      observedCount: 72,
      coveragePercent: 100,
      coveredDomainCount: 10,
      provisionalDomainCount: 0,
      correctCount: 72,
      partialCount: 0,
      incorrectCount: 0,
      runtimeIssueCount: 0,
      invalidCount: 0,
      missingCount: 0,
      notApplicableCount: 0,
      completedCount: 72,
    },
  };
}

function efficiency(family: ModelFamily, tier: ReasoningTier): PublicModelEfficiency {
  const id = configurationId(family, tier);
  const unavailableCoverage = { count: null, percent: null };
  const modelFamily = family === 'Sol' ? 'sol' : family === 'Terra' ? 'terra' : 'luna';
  return {
    runId: `run-${id}`,
    matrixBatchId: 'batch-test',
    modelFamily,
    reasoningEffort: tier,
    matrixBatchElapsedMs: 60_000,
    summedCellAdapterElapsedMs: 1_000,
    observedMedianWallMs: 10,
    observedP95WallMs: 20,
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
      input: unavailableCoverage,
      cachedInput: unavailableCoverage,
      cacheWriteInput: unavailableCoverage,
      output: unavailableCoverage,
      reasoning: unavailableCoverage,
      total: unavailableCoverage,
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
  };
}

const entries = configurations.map(([family, tier], index) => entry(family, tier, index));
const runs = configurations.map(([family, tier]) => run(family, tier));
const efficiencyRows = configurations.map(([family, tier]) => efficiency(family, tier));

function qualifiedRows(metric: 'cost' | 'duration'): readonly PublicModelEfficiency[] {
  return efficiencyRows.map((row) =>
    metric === 'cost'
      ? {
          ...row,
          standardApiEquivalentUsdNanos: 1_000_000_000,
          costEstimatorStatus: 'estimated',
          tokenUsageCoveragePercent: 100,
          estimatedCostSampleCount: 72,
        }
      : row,
  );
}

void describe('efficiency plot evidence coverage', () => {
  for (const metric of ['cost', 'duration'] as const) {
    void it(`counts an absent ${metric} endpoint row separately in the canonical matrix`, () => {
      const evidence = resolveEfficiencyPlotEvidence({
        entries,
        runSummaries: runs,
        rows: qualifiedRows(metric).slice(0, 16),
        metric,
      });

      assert.equal(evidence.points.length, 16);
      assert.equal(evidence.configurationCount, 17);
      assert.equal(evidence.metricUnavailable, 0);
      assert.equal(evidence.identityOrScoreRejected, 0);
      assert.equal(evidence.absent, 1);
    });

    void it(`rejects ${metric} scoring drift without treating it as a missing metric`, () => {
      const driftedRuns = runs.map((candidate, index) =>
        index === 16 ? { ...candidate, scoringVersion: '1.0.2' } : candidate,
      );
      const evidence = resolveEfficiencyPlotEvidence({
        entries,
        runSummaries: driftedRuns,
        rows: qualifiedRows(metric),
        metric,
      });

      assert.equal(evidence.points.length, 16);
      assert.equal(evidence.metricUnavailable, 0);
      assert.equal(evidence.identityOrScoreRejected, 1);
      assert.equal(evidence.absent, 0);
      assert.equal(
        evidence.points.some(({ row }) => row.runId === 'run-luna-max'),
        false,
      );
    });

    void it(`rejects duplicate ${metric} rows without plotting either duplicate`, () => {
      const metricRows = qualifiedRows(metric);
      const duplicate = metricRows.at(-1);
      assert.ok(duplicate);
      const evidence = resolveEfficiencyPlotEvidence({
        entries,
        runSummaries: runs,
        rows: [...metricRows, duplicate],
        metric,
      });

      assert.equal(evidence.points.length, 16);
      assert.equal(evidence.metricUnavailable, 0);
      assert.equal(evidence.identityOrScoreRejected, 1);
      assert.equal(evidence.absent, 0);
      assert.equal(
        evidence.points.some(({ row }) => row.runId === 'run-luna-max'),
        false,
      );
    });

    void it(`rejects an unscored ${metric} leaderboard entry`, () => {
      const unscoredEntries = entries.map(
        (candidate, index): LeaderboardEntry =>
          index === 16
            ? {
                ...candidate,
                score: null,
                sensitivityLow: null,
                sensitivityHigh: null,
                sampleSize: null,
                coveragePercent: null,
                runtimeIssues: null,
                missing: null,
                scoreStatus: 'missing',
              }
            : candidate,
      );
      const evidence = resolveEfficiencyPlotEvidence({
        entries: unscoredEntries,
        runSummaries: runs,
        rows: qualifiedRows(metric),
        metric,
      });

      assert.equal(evidence.points.length, 16);
      assert.equal(evidence.metricUnavailable, 0);
      assert.equal(evidence.identityOrScoreRejected, 1);
      assert.equal(evidence.absent, 0);
    });

    void it(`excludes an exact Luna ultra ${metric} row without exceeding 17`, () => {
      const extraEntry = entry('Luna', 'ultra', 17);
      const extraRow = efficiency('Luna', 'ultra');
      const qualifiedExtraRow =
        metric === 'cost'
          ? {
              ...extraRow,
              standardApiEquivalentUsdNanos: 1_000_000_000,
              costEstimatorStatus: 'estimated' as const,
              tokenUsageCoveragePercent: 100,
              estimatedCostSampleCount: 72,
            }
          : extraRow;
      const evidence = resolveEfficiencyPlotEvidence({
        entries: [...entries, extraEntry],
        runSummaries: [...runs, run('Luna', 'ultra')],
        rows: [...qualifiedRows(metric), qualifiedExtraRow],
        metric,
      });

      assert.equal(evidence.points.length, 17);
      assert.equal(evidence.configurationCount, 17);
      assert.equal(evidence.metricUnavailable, 0);
      assert.equal(evidence.identityOrScoreRejected, 0);
      assert.equal(evidence.absent, 0);
      assert.equal(
        evidence.points.some(({ entry: candidate }) => candidate.id === 'luna-ultra'),
        false,
      );
    });
  }

  void it('separates exact metric unavailability from rejected and absent evidence', () => {
    const durationRows = qualifiedRows('duration').map((row, index) =>
      index === 16 ? Object.assign({}, row, { observedTimeCoveragePercent: 0 }) : row,
    );
    const durationEvidence = resolveEfficiencyPlotEvidence({
      entries,
      runSummaries: runs,
      rows: durationRows,
      metric: 'duration',
    });
    assert.equal(durationEvidence.points.length, 16);
    assert.equal(durationEvidence.metricUnavailable, 1);
    assert.equal(durationEvidence.identityOrScoreRejected, 0);
    assert.equal(durationEvidence.absent, 0);

    const costEvidence = resolveEfficiencyPlotEvidence({
      entries,
      runSummaries: runs,
      rows: efficiencyRows,
      metric: 'cost',
    });
    assert.equal(costEvidence.points.length, 0);
    assert.equal(costEvidence.metricUnavailable, 17);
    assert.equal(costEvidence.identityOrScoreRejected, 0);
    assert.equal(costEvidence.absent, 0);
  });

  void it('renders canonical counts and explains the plotted-only evidence table', () => {
    const metricRows = qualifiedRows('cost');
    const duplicate = metricRows.at(-1);
    assert.ok(duplicate);
    const html = renderToStaticMarkup(
      createElement(EfficiencyPlot, {
        entries,
        runSummaries: runs,
        rows: [...metricRows, duplicate],
      }),
    );

    assert.match(html, /16\/17 configurations plotted in the canonical matrix/);
    assert.match(html, /0 metric unavailable/);
    assert.match(html, /1 rejected because exact identity or score evidence could not be verified/);
    assert.match(html, /0 absent from efficiency evidence/);
    assert.match(
      html,
      /Only exact canonical configurations with coverage-qualified values appear below\./,
    );
    assert.doesNotMatch(html, /Luna · max/);
    assert.equal(html.match(/<tr>/g)?.length, 17);
  });
});
