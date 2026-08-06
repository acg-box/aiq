'use client';

import { useMemo } from 'react';

import { formatSensitivityInterval } from '../data/format.ts';
import { formatHumanDuration } from '../data/format-duration.ts';
import {
  type BenchmarkRunSummary,
  isScoredLeaderboardEntry,
  type LeaderboardEntry,
  type PublicModelEfficiency,
} from '../data/types.ts';
import { ReadStateNote } from './read-state-note.tsx';
import { ScoreReadout } from './score-readout.tsx';
import {
  pushAnalyticalUrl,
  readDistinctIdPair,
  useAnalyticalSearchParams,
} from './analytical-url-state.ts';
import {
  EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE,
  resolveExactScientificEvidence,
} from './scientific-evidence-resolution.ts';
import { UNAVAILABLE } from './scientific-score-context.ts';

function efficiencyValue(
  row: PublicModelEfficiency | undefined,
  field: 'summedCellAdapterElapsedMs' | 'matrixBatchElapsedMs',
): string {
  return row?.[field] == null ? UNAVAILABLE : formatHumanDuration(row[field]);
}

function costValue(row: PublicModelEfficiency | undefined): string {
  return row?.costEstimatorStatus === 'estimated' && row.standardApiEquivalentUsdNanos !== null
    ? `$${(row.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`
    : UNAVAILABLE;
}

function durationCoverage(row: PublicModelEfficiency | undefined): string {
  return row
    ? `${row.observedTimeSampleCount}/${row.resultCount} (${row.observedTimeCoveragePercent.toFixed(1)}%)`
    : UNAVAILABLE;
}

function costCoverage(row: PublicModelEfficiency | undefined): string {
  return row ? `${row.pricedResultCount}/${row.resultCount}` : UNAVAILABLE;
}

export function CompareExplorer({
  entries,
  runSummaries,
  efficiency,
}: {
  entries: readonly LeaderboardEntry[];
  runSummaries: readonly BenchmarkRunSummary[];
  efficiency: readonly PublicModelEfficiency[];
}) {
  const comparableEntries = useMemo(() => entries.filter(isScoredLeaderboardEntry), [entries]);
  const searchParams = useAnalyticalSearchParams();
  const comparableIds = useMemo(
    () => comparableEntries.map((entry) => entry.id),
    [comparableEntries],
  );
  const [leftId, rightId] = readDistinctIdPair(
    searchParams,
    'compareFirst',
    'compareSecond',
    comparableIds,
    comparableIds[0] ?? '',
    comparableIds[6] ?? comparableIds[1] ?? '',
  );
  const left = useMemo(
    () => comparableEntries.find((entry) => entry.id === leftId),
    [comparableEntries, leftId],
  );
  const right = useMemo(
    () => comparableEntries.find((entry) => entry.id === rightId),
    [comparableEntries, rightId],
  );

  if (!left || !right) {
    return <p>No comparable entries are available.</p>;
  }

  const sameSampleSize = left.sampleSize === right.sampleSize;
  const sameCoverage = left.coveragePercent === right.coveragePercent;
  const sameScoringVersion = left.scoringVersion === right.scoringVersion;
  const difference = Math.abs(left.score - right.score).toFixed(1);
  const leftResolution = resolveExactScientificEvidence({
    candidate: {
      runId: left.runId,
      entryId: left.id,
      scoringVersion: left.scoringVersion,
      synthetic: left.synthetic,
    },
    runs: runSummaries,
    entries,
    efficiencyRows: efficiency,
  });
  const rightResolution = resolveExactScientificEvidence({
    candidate: {
      runId: right.runId,
      entryId: right.id,
      scoringVersion: right.scoringVersion,
      synthetic: right.synthetic,
    },
    runs: runSummaries,
    entries,
    efficiencyRows: efficiency,
  });
  const leftEfficiency =
    leftResolution.state === 'exact' ? leftResolution.evidence.efficiency : undefined;
  const rightEfficiency =
    rightResolution.state === 'exact' ? rightResolution.evidence.efficiency : undefined;
  const exactJoinUnavailable =
    leftResolution.state === 'unavailable' || rightResolution.state === 'unavailable';
  const primaryMetrics = [
    ['AIQ score', left.score.toFixed(1), right.score.toFixed(1)],
    ['Task sensitivity', formatSensitivityInterval(left), formatSensitivityInterval(right)],
    ['Coverage', `${left.coveragePercent.toFixed(1)}%`, `${right.coveragePercent.toFixed(1)}%`],
    ['Runtime issues', String(left.runtimeIssues), String(right.runtimeIssues)],
    [
      'Total adapter time',
      efficiencyValue(leftEfficiency, 'summedCellAdapterElapsedMs'),
      efficiencyValue(rightEfficiency, 'summedCellAdapterElapsedMs'),
    ],
    ['API-equivalent cost', costValue(leftEfficiency), costValue(rightEfficiency)],
  ] as const;
  const evidenceMetrics = [
    ['Samples', String(left.sampleSize), String(right.sampleSize)],
    ['Scoring version', left.scoringVersion, right.scoringVersion],
    ['Missing', String(left.missing), String(right.missing)],
    [
      'Batch wall-clock',
      efficiencyValue(leftEfficiency, 'matrixBatchElapsedMs'),
      efficiencyValue(rightEfficiency, 'matrixBatchElapsedMs'),
    ],
    ['Duration coverage', durationCoverage(leftEfficiency), durationCoverage(rightEfficiency)],
    ['Cost coverage', costCoverage(leftEfficiency), costCoverage(rightEfficiency)],
    [
      'Evidence',
      left.synthetic ? 'Synthetic' : 'Published',
      right.synthetic ? 'Synthetic' : 'Published',
    ],
  ] as const;

  return (
    <>
      <div className="compare-controls">
        <label>
          First configuration
          <select
            value={leftId}
            onChange={(event) =>
              pushAnalyticalUrl({ compareFirst: event.target.value, compareSecond: rightId })
            }
          >
            {comparableEntries.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={entry.id === rightId}>
                {entry.modelFamily} · {entry.reasoningTier} ({entry.modelName})
              </option>
            ))}
          </select>
        </label>
        <span aria-hidden="true">vs</span>
        <label>
          Second configuration
          <select
            value={rightId}
            onChange={(event) =>
              pushAnalyticalUrl({ compareFirst: leftId, compareSecond: event.target.value })
            }
          >
            {comparableEntries.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={entry.id === leftId}>
                {entry.modelFamily} · {entry.reasoningTier} ({entry.modelName})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="compare-stage">
        {[left, right].map((entry) => (
          <article className="compare-model" key={entry.id}>
            <ScoreReadout
              score={entry.score}
              label={`${entry.modelFamily} ${entry.reasoningTier}`}
            />
            <div>
              <span className="eyebrow">{entry.modelFamily}</span>
              <h2>{entry.reasoningTier} reasoning</h2>
              <p>{entry.modelName}</p>
            </div>
          </article>
        ))}
      </div>
      {exactJoinUnavailable ? (
        <ReadStateNote
          result={{
            state: 'unavailable',
            detail: EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE,
          }}
          subject="Selected run context"
        />
      ) : null}
      <section className="comparison-interpretation" aria-labelledby="comparison-reading">
        <div>
          <span className="eyebrow">Observed difference</span>
          <h2 id="comparison-reading">{difference} AIQ points apart</h2>
          <p>
            This is a descriptive difference on the fixed task set. It does not by itself show that
            either configuration is generally better.
          </p>
        </div>
        <dl className="compatibility-list" aria-label="Comparison compatibility checks">
          <div>
            <dt>Samples</dt>
            <dd>{sameSampleSize ? `Matched · ${left.sampleSize}` : 'Different'}</dd>
          </div>
          <div>
            <dt>Coverage</dt>
            <dd>{sameCoverage ? `Matched · ${left.coveragePercent.toFixed(1)}%` : 'Different'}</dd>
          </div>
          <div>
            <dt>Scoring</dt>
            <dd>{sameScoringVersion ? 'Matched' : 'Different'}</dd>
          </div>
        </dl>
        <p className="comparison-caution" role="note">
          A supported winner claim requires complete paired-task evidence from the same benchmark
          release. Aggregate rows are not enough.
        </p>
      </section>
      <div className="comparison-grid" role="table" aria-label="Selected comparison">
        <div className="comparison-row comparison-head" role="row">
          <span role="columnheader">Metric</span>
          <strong role="columnheader">{left.modelFamily}</strong>
          <strong role="columnheader">{right.modelFamily}</strong>
        </div>
        {primaryMetrics.map(([label, leftValue, rightValue]) => (
          <div className="comparison-row" role="row" key={label}>
            <span role="rowheader">{label}</span>
            <strong role="cell">{leftValue}</strong>
            <strong role="cell">{rightValue}</strong>
          </div>
        ))}
      </div>
      <details className="data-disclosure comparison-evidence-table">
        <summary>Exact run, provenance, and metric coverage</summary>
        <div className="comparison-grid" role="table" aria-label="Comparison evidence details">
          <div className="comparison-row comparison-head" role="row">
            <span role="columnheader">Metric</span>
            <strong role="columnheader">{left.modelFamily}</strong>
            <strong role="columnheader">{right.modelFamily}</strong>
          </div>
          {evidenceMetrics.map(([label, leftValue, rightValue]) => (
            <div className="comparison-row" role="row" key={label}>
              <span role="rowheader">{label}</span>
              <strong role="cell">{leftValue}</strong>
              <strong role="cell">{rightValue}</strong>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
