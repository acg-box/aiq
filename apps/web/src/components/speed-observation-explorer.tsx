'use client';

import type { EChartsCoreOption } from 'echarts/core';
import { useMemo, useState } from 'react';

import type {
  ModelFamily,
  PublicSpeedObservation,
  ReasoningTier,
  SpeedMode,
  SpeedTrendPoint,
} from '../data/types.ts';
import { formatHumanDuration } from '../data/format-duration.ts';
import { TREND_SERIES_STYLES } from '../data/trend-styles.ts';
import { EChartsChart } from './echarts-chart.tsx';
import { pairedSpeedupRows } from './speed-observation-analysis.ts';

type SpeedMetric = 'completion' | 'duration' | 'throughput' | 'credits';
type SpeedScope = ModelFamily | 'All';
type ReasoningScope = ReasoningTier | 'All';
type SpeedView = 'latest' | 'history';

const families: readonly SpeedScope[] = ['All', 'Sol', 'Terra', 'Luna'];
const reasoningLevels: readonly ReasoningScope[] = [
  'All',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
const modeColor: Record<SpeedMode, string> = {
  normal: '#7d8995',
  fast: '#8ed6bd',
};

function metricValue(
  row: PublicSpeedObservation | SpeedTrendPoint,
  metric: SpeedMetric,
): number | null {
  if (metric === 'completion') {
    return row.attemptedTrials === 0 ? null : (row.completedTrials / row.attemptedTrials) * 100;
  }
  if (metric === 'duration') {
    return row.medianElapsedMs === null ? null : row.medianElapsedMs / 1_000;
  }
  if (metric === 'throughput') return row.medianAggregateOutputTps;
  return row.estimatedCredits;
}

function metricLabel(metric: SpeedMetric): string {
  if (metric === 'completion') return 'Fixed-task completion rate';
  if (metric === 'duration') return 'Median elapsed time (seconds)';
  if (metric === 'throughput') return 'Aggregate output tokens/s';
  return 'Estimated ChatGPT credits';
}

function formatMetric(metric: SpeedMetric, value: number | null): string {
  if (value === null) return 'Unavailable';
  if (metric === 'completion') return `${value.toFixed(1)}%`;
  if (metric === 'duration') return formatHumanDuration(value * 1_000);
  if (metric === 'throughput') return `${value.toFixed(1)} tok/s`;
  return `${value.toFixed(3)} credits`;
}

function filterConfiguration(
  row: Pick<PublicSpeedObservation, 'modelFamily' | 'reasoningTier'>,
  family: SpeedScope,
  reasoning: ReasoningScope,
): boolean {
  return (
    (family === 'All' || row.modelFamily === family) &&
    (reasoning === 'All' || row.reasoningTier === reasoning)
  );
}

function readTooltipItem(value: unknown): {
  seriesName: string;
  data: readonly (number | string | null)[];
} | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('seriesName' in value) ||
    typeof value.seriesName !== 'string' ||
    !('data' in value) ||
    !Array.isArray(value.data) ||
    !value.data.every(
      (item: unknown) => item === null || typeof item === 'number' || typeof item === 'string',
    )
  ) {
    return null;
  }
  return { seriesName: value.seriesName, data: value.data };
}

export function SpeedObservationExplorer({
  observations,
  trendPoints,
}: {
  observations: readonly PublicSpeedObservation[];
  trendPoints: readonly SpeedTrendPoint[];
}) {
  const [metric, setMetric] = useState<SpeedMetric>('duration');
  const [family, setFamily] = useState<SpeedScope>('All');
  const [reasoning, setReasoning] = useState<ReasoningScope>('All');
  const [view, setView] = useState<SpeedView>('latest');
  const visibleObservations = useMemo(
    () => observations.filter((row) => filterConfiguration(row, family, reasoning)),
    [family, observations, reasoning],
  );
  const visibleTrends = useMemo(
    () => trendPoints.filter((row) => filterConfiguration(row, family, reasoning)),
    [family, reasoning, trendPoints],
  );
  const pairRows = useMemo(() => pairedSpeedupRows(visibleObservations), [visibleObservations]);
  const medianSpeedup =
    pairRows.length === 0
      ? null
      : (pairRows.map((row) => row.speedup).toSorted((left, right) => left - right)[
          Math.floor(pairRows.length / 2)
        ] ?? null);
  const fasterCount = pairRows.filter((row) => row.speedup > 1).length;
  const unavailableCount = visibleObservations.filter(
    (row) => row.availabilityStatus !== 'available',
  ).length;

  const latestOption = useMemo<EChartsCoreOption>(() => {
    const entryIds = [...new Set(visibleObservations.map((row) => row.entryId))];
    return {
      aria: { enabled: true, decal: { show: true } },
      animationDuration: 420,
      grid: { left: 64, right: 24, top: 24, bottom: 88 },
      legend: { top: 0, textStyle: { color: 'var(--muted)' } },
      tooltip: {
        trigger: 'item',
        formatter: (value: unknown) => {
          const item = readTooltipItem(value);
          if (!item || item.data[1] === null) return 'Measurement unavailable';
          return `${item.data[0]} · ${item.seriesName}<br/>${metricLabel(metric)} ${formatMetric(metric, Number(item.data[1]))}<br/>${item.data[2]} completed trial(s)`;
        },
      },
      xAxis: {
        type: 'category',
        data: entryIds,
        axisLabel: { color: 'var(--muted)', rotate: entryIds.length > 8 ? 36 : 0 },
        axisLine: { lineStyle: { color: 'var(--line-bright)' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: metric === 'completion' ? 100 : undefined,
        name: metricLabel(metric),
        nameLocation: 'middle',
        nameGap: 48,
        axisLabel: { color: 'var(--muted)' },
        nameTextStyle: { color: 'var(--muted)' },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      series: (['normal', 'fast'] as const).map((mode) => ({
        id: `speed-latest-${metric}-${mode}`,
        name: mode === 'normal' ? 'Normal' : 'Fast',
        type: 'bar',
        barMaxWidth: 18,
        itemStyle: { color: modeColor[mode], borderRadius: [3, 3, 0, 0] },
        data: entryIds.map((entryId) => {
          const row = visibleObservations.find(
            (candidate) => candidate.entryId === entryId && candidate.mode === mode,
          );
          return [entryId, row ? metricValue(row, metric) : null, row?.completedTrials ?? 0];
        }),
      })),
    };
  }, [metric, visibleObservations]);

  const historyOption = useMemo<EChartsCoreOption>(() => {
    const configurationIds = [...new Set(visibleTrends.map((row) => row.entryId))];
    const seriesIdentities = [
      ...new Map(
        visibleTrends.map((row) => [
          `${row.entryId}:${row.mode}`,
          { entryId: row.entryId, mode: row.mode },
        ]),
      ).values(),
    ];
    return {
      aria: { enabled: true, decal: { show: true } },
      animationDuration: 420,
      grid: { left: 64, right: 24, top: 24, bottom: 94 },
      legend: {
        type: 'scroll',
        bottom: 0,
        pageTextStyle: { color: 'var(--muted)' },
        textStyle: { color: 'var(--muted)' },
      },
      tooltip: {
        trigger: 'item',
        formatter: (value: unknown) => {
          const item = readTooltipItem(value);
          if (!item || item.data[1] === null) return 'Measurement unavailable';
          return `${item.seriesName}<br/>${String(item.data[2]).slice(0, 10)} UTC<br/>${metricLabel(metric)} ${formatMetric(metric, Number(item.data[1]))}<br/>${item.data[3]} completed trial(s) across ${item.data[4]} batch(es)`;
        },
      },
      xAxis: {
        type: 'time',
        axisLabel: { color: 'var(--muted)' },
        axisLine: { lineStyle: { color: 'var(--line-bright)' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: metric === 'completion' ? 100 : undefined,
        name: metricLabel(metric),
        nameLocation: 'middle',
        nameGap: 48,
        axisLabel: { color: 'var(--muted)' },
        nameTextStyle: { color: 'var(--muted)' },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      series: seriesIdentities.map(({ entryId, mode }, index) => {
        const configurationIndex = configurationIds.indexOf(entryId);
        const color = TREND_SERIES_STYLES[configurationIndex]?.color ?? '#83909c';
        return {
          id: `speed-history-${metric}-${entryId}-${mode}`,
          name: `${entryId} · ${mode === 'normal' ? 'Normal' : 'Fast'}`,
          type: 'line',
          connectNulls: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 6,
          lineStyle: {
            width: 1.5,
            type: mode === 'fast' ? 'solid' : 'dashed',
            opacity: 0.72 + (index % 3) * 0.08,
          },
          itemStyle: { color },
          emphasis: { focus: 'series', lineStyle: { width: 2.5 } },
          data: visibleTrends
            .filter((row) => row.entryId === entryId && row.mode === mode)
            .map((row) => [
              new Date(row.recordedAt).getTime(),
              metricValue(row, metric),
              row.recordedAt,
              row.completedTrials,
              row.representedBatchCount,
            ]),
        };
      }),
    };
  }, [metric, visibleTrends]);

  if (observations.length === 0) {
    return (
      <section className="speed-observation" aria-labelledby="speed-observation-title">
        <header className="speed-observation-heading">
          <div>
            <span className="eyebrow">Transport measurement</span>
            <h2 id="speed-observation-title">Normal vs Fast</h2>
          </div>
          <span className="status-inline">First observation scheduled</span>
        </header>
        <p className="speed-empty">
          No production Normal/Fast observation has been published yet. The first scheduled batch
          will report each configuration as available, unsupported, or unavailable without changing
          AIQ scores.
        </p>
      </section>
    );
  }

  return (
    <section className="speed-observation" aria-labelledby="speed-observation-title">
      <header className="speed-observation-heading">
        <div>
          <span className="eyebrow">Transport measurement · not scoring</span>
          <h2 id="speed-observation-title">Normal vs Fast</h2>
          <p>
            Same fixed response task, paired modes, {observations[0]?.trialsPerMode ?? 0} trials per
            mode. AIQ is not recomputed from speed, time, tokens, or credits.
          </p>
        </div>
        <time dateTime={observations[0]?.observedAt}>
          {observations[0]?.observedAt.slice(0, 10)} UTC
        </time>
      </header>

      <dl className="speed-summary">
        <div>
          <dt>Median Fast speedup</dt>
          <dd>{medianSpeedup === null ? 'Unavailable' : `${medianSpeedup.toFixed(2)}×`}</dd>
        </div>
        <div>
          <dt>Fast wins</dt>
          <dd>
            {fasterCount}/{pairRows.length || 0}
          </dd>
        </div>
        <div>
          <dt>Unavailable modes</dt>
          <dd>{unavailableCount}</dd>
        </div>
        <div>
          <dt>TTFT</dt>
          <dd>Not exposed by current CLI</dd>
        </div>
      </dl>

      <div className="trend-mode-control speed-controls" aria-label="Speed comparison controls">
        <div className="chart-control">
          <span>Measure</span>
          <div className="chart-switch" role="group" aria-label="Speed measure">
            {(['completion', 'duration', 'throughput', 'credits'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={metric === candidate}
                onClick={() => setMetric(candidate)}
              >
                {candidate === 'completion'
                  ? 'Completion'
                  : candidate === 'duration'
                    ? 'Time'
                    : candidate === 'throughput'
                      ? 'Output rate'
                      : 'Credits'}
              </button>
            ))}
          </div>
        </div>
        <div className="chart-control">
          <span>View</span>
          <div className="chart-switch" role="group" aria-label="Speed chart view">
            {(['latest', 'history'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={view === candidate}
                onClick={() => setView(candidate)}
              >
                {candidate === 'latest' ? 'Latest' : 'History'}
              </button>
            ))}
          </div>
        </div>
        <div className="chart-control">
          <label htmlFor="speed-family">Family</label>
          <select
            id="speed-family"
            className="chart-select"
            value={family}
            onChange={(event) => {
              const selected = families.find((candidate) => candidate === event.target.value);
              if (selected) setFamily(selected);
            }}
          >
            {families.map((candidate) => (
              <option key={candidate}>{candidate}</option>
            ))}
          </select>
        </div>
        <div className="chart-control">
          <label htmlFor="speed-reasoning">Reasoning</label>
          <select
            id="speed-reasoning"
            className="chart-select"
            value={reasoning}
            onChange={(event) => {
              const selected = reasoningLevels.find(
                (candidate) => candidate === event.target.value,
              );
              if (selected) setReasoning(selected);
            }}
          >
            {reasoningLevels.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate === 'All' ? 'All levels' : candidate}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="chart-frame speed-chart-frame">
        {(view === 'latest' ? visibleObservations : visibleTrends).length > 0 ? (
          <EChartsChart
            className="speed-chart-echarts"
            option={view === 'latest' ? latestOption : historyOption}
            label={`${metricLabel(metric)} for Normal and Fast across the selected configurations. AIQ is unaffected.`}
          />
        ) : (
          <p>No measured series matches these filters.</p>
        )}
      </div>

      <details className="data-disclosure">
        <summary>Exact paired measurements</summary>
        <div
          className="table-scroll"
          role="region"
          aria-label="Normal and Fast measurements"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Configuration</th>
                <th scope="col">Normal completion</th>
                <th scope="col">Fast completion</th>
                <th scope="col">Normal time</th>
                <th scope="col">Fast time</th>
                <th scope="col">Speedup</th>
                <th scope="col">Normal output</th>
                <th scope="col">Fast output</th>
                <th scope="col">Normal credits</th>
                <th scope="col">Fast credits</th>
              </tr>
            </thead>
            <tbody>
              {pairRows.map(({ entryId, normal, fast, speedup }) => (
                <tr key={entryId}>
                  <th scope="row">{entryId}</th>
                  <td>
                    {formatMetric(
                      'completion',
                      normal.attemptedTrials === 0
                        ? null
                        : (normal.completedTrials / normal.attemptedTrials) * 100,
                    )}
                  </td>
                  <td>
                    {formatMetric(
                      'completion',
                      fast.attemptedTrials === 0
                        ? null
                        : (fast.completedTrials / fast.attemptedTrials) * 100,
                    )}
                  </td>
                  <td>
                    {formatMetric(
                      'duration',
                      normal.medianElapsedMs === null ? null : normal.medianElapsedMs / 1_000,
                    )}
                  </td>
                  <td>
                    {formatMetric(
                      'duration',
                      fast.medianElapsedMs === null ? null : fast.medianElapsedMs / 1_000,
                    )}
                  </td>
                  <td>{speedup.toFixed(2)}×</td>
                  <td>{formatMetric('throughput', normal.medianAggregateOutputTps)}</td>
                  <td>{formatMetric('throughput', fast.medianAggregateOutputTps)}</td>
                  <td>{formatMetric('credits', normal.estimatedCredits)}</td>
                  <td>{formatMetric('credits', fast.estimatedCredits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine-print">
          Aggregate output rate uses total elapsed time because the current Codex event stream does
          not expose a trustworthy first-token timestamp. Fast credit estimates use the published
          2.5× ChatGPT credit multiplier. Neither measure changes AIQ, confidence intervals, or
          ranking.
        </p>
      </details>
    </section>
  );
}
