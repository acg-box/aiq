'use client';

import { useMemo, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import {
  isScoredLeaderboardEntry,
  type LeaderboardEntry,
  type PublicModelEfficiency,
} from '../data/types.ts';
import { EChartsChart } from './echarts-chart.tsx';
import { paretoEfficientKeys } from './efficiency-analysis.ts';
import { formatScientificScoreContextHtml } from './scientific-score-context.ts';

type Metric = 'cost' | 'duration';
type EfficiencyDatum = readonly [
  number,
  number,
  string,
  number,
  string,
  number,
  number,
  string,
  string,
  number,
  number,
  number,
  string,
];

function readEfficiencyDatum(value: unknown): EfficiencyDatum | null {
  if (typeof value !== 'object' || value === null || !('data' in value)) return null;
  const data = value.data;
  if (
    !Array.isArray(data) ||
    typeof data[0] !== 'number' ||
    typeof data[1] !== 'number' ||
    typeof data[2] !== 'string' ||
    typeof data[3] !== 'number' ||
    typeof data[4] !== 'string' ||
    typeof data[5] !== 'number' ||
    typeof data[6] !== 'number' ||
    typeof data[7] !== 'string' ||
    typeof data[8] !== 'string' ||
    typeof data[9] !== 'number' ||
    typeof data[10] !== 'number' ||
    typeof data[11] !== 'number' ||
    typeof data[12] !== 'string'
  ) {
    return null;
  }
  return [
    data[0],
    data[1],
    data[2],
    data[3],
    data[4],
    data[5],
    data[6],
    data[7],
    data[8],
    data[9],
    data[10],
    data[11],
    data[12],
  ];
}

function efficiencyComparisonGroup(
  entry: LeaderboardEntry,
  row: PublicModelEfficiency,
  metric: Metric,
): string {
  const common = [
    row.matrixBatchId,
    entry.scoringVersion ?? 'scoring-unavailable',
    `concurrency-${row.executionConcurrency}`,
    metric,
  ];
  if (metric === 'duration') {
    return [...common, row.durationEvidenceLevel ?? 'duration-evidence-unavailable'].join('|');
  }
  return [
    ...common,
    row.costMethod ?? 'cost-method-unavailable',
    row.costEvidenceLevel ?? 'cost-evidence-unavailable',
    row.tokenUsageSourceLevel ?? 'token-source-unavailable',
    row.tokenUsageEvidenceLevel ?? 'token-evidence-unavailable',
    row.pricingVersion ?? 'pricing-version-unavailable',
    row.pricingAsOf ?? 'pricing-date-unavailable',
    row.pricingSource ?? 'pricing-source-unavailable',
    row.pricingCurrency ?? 'currency-unavailable',
    row.pricingProcessingTier ?? 'tier-unavailable',
  ].join('|');
}

export function EfficiencyPlot({
  entries,
  rows,
}: {
  entries: readonly LeaderboardEntry[];
  rows: readonly PublicModelEfficiency[];
}) {
  const [metric, setMetric] = useState<Metric>('cost');
  const points = useMemo(() => {
    const entriesByRun = new Map(entries.map((entry) => [entry.runId, entry]));
    return rows.flatMap((row) => {
      const entry = entriesByRun.get(row.runId);
      const x =
        metric === 'cost'
          ? row.costEstimatorStatus === 'estimated' &&
            row.tokenUsageCoveragePercent === 100 &&
            row.standardApiEquivalentUsdNanos !== null
            ? row.standardApiEquivalentUsdNanos / 1_000_000_000
            : null
          : row.observedTimeCoveragePercent === 100
            ? row.summedCellAdapterElapsedMs
            : null;
      return !entry || !isScoredLeaderboardEntry(entry) || x === null
        ? []
        : [{ row, entry, x, y: entry.score }];
    });
  }, [entries, metric, rows]);
  const unavailable = rows.length - points.length;
  const frontierRunIds = useMemo(() => {
    const comparisonGroups = new Map<string, number>();
    for (const point of points) {
      const group = efficiencyComparisonGroup(point.entry, point.row, metric);
      comparisonGroups.set(group, (comparisonGroups.get(group) ?? 0) + 1);
    }
    const frontierKeys = paretoEfficientKeys(
      points.map(({ entry, row, x, y }) => ({
        key: row.runId,
        comparisonGroup: efficiencyComparisonGroup(entry, row, metric),
        x,
        y,
      })),
    );
    return new Set(
      points.flatMap(({ entry, row }) =>
        frontierKeys.has(row.runId) &&
        (comparisonGroups.get(efficiencyComparisonGroup(entry, row, metric)) ?? 0) > 1
          ? [row.runId]
          : [],
      ),
    );
  }, [metric, points]);
  const option = useMemo<EChartsCoreOption>(() => {
    const duration = metric === 'duration';
    return {
      aria: { enabled: true, decal: { show: true } },
      grid: { left: 62, right: 28, top: 24, bottom: 54 },
      legend: {
        top: 0,
        right: 12,
        textStyle: { color: 'var(--muted)' },
        data: ['Sol', 'Terra', 'Luna'],
      },
      tooltip: {
        trigger: 'item',
        formatter: (value: unknown) => {
          const datum = readEfficiencyDatum(value);
          if (!datum) return 'Efficiency evidence unavailable';
          const x = duration ? `${(datum[0] / 60_000).toFixed(2)} min` : `$${datum[0].toFixed(4)}`;
          const scientificContext = formatScientificScoreContextHtml({
            sampleSize: datum[9],
            coverage: datum[4],
            runtime: `${datum[10]} issues`,
            missing: String(datum[11]),
            status: datum[12],
            scoringVersion: datum[7],
            provenance: datum[8],
          });
          return `${datum[2]}<br/>AIQ: ${datum[1].toFixed(1)} (interval ${datum[5].toFixed(1)}–${datum[6].toFixed(1)})<br/>${duration ? 'Summed cell adapter time' : 'Standard API-equivalent estimate'}: ${x} · metric evidence n=${datum[3]}<br/>${scientificContext}`;
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        name: duration ? 'Summed cell adapter time (ms)' : 'Standard API-equivalent estimate (USD)',
        nameLocation: 'middle',
        nameGap: 36,
        axisLabel: { color: 'var(--muted)' },
        nameTextStyle: { color: 'var(--muted)' },
        axisLine: { lineStyle: { color: 'var(--line-bright)' } },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        name: 'AIQ index (0–100)',
        nameLocation: 'middle',
        nameGap: 43,
        axisLabel: { color: 'var(--muted)' },
        nameTextStyle: { color: 'var(--muted)' },
        axisLine: { lineStyle: { color: 'var(--line-bright)' } },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      series: [
        {
          type: 'custom',
          name: 'Task-sensitivity interval',
          silent: true,
          z: 4,
          data: points.map(({ entry, x, y }) => [x, entry.ciLow ?? y, entry.ciHigh ?? y]),
          renderItem: (
            _params: unknown,
            api: {
              value: (dimension: number) => number;
              coord: (value: readonly number[]) => readonly [number, number];
            },
          ) => {
            const x = api.value(0);
            const low = api.coord([x, api.value(1)]);
            const high = api.coord([x, api.value(2)]);
            return {
              type: 'group',
              children: [
                {
                  type: 'line',
                  shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] },
                  style: { stroke: 'var(--interval)', lineWidth: 1.5 },
                },
                {
                  type: 'line',
                  shape: { x1: low[0] - 4, y1: low[1], x2: low[0] + 4, y2: low[1] },
                  style: { stroke: 'var(--interval)', lineWidth: 1.5 },
                },
                {
                  type: 'line',
                  shape: { x1: high[0] - 4, y1: high[1], x2: high[0] + 4, y2: high[1] },
                  style: { stroke: 'var(--interval)', lineWidth: 1.5 },
                },
              ],
            };
          },
        },
        ...(['Sol', 'Terra', 'Luna'] as const).map((family, index) => ({
          type: 'scatter',
          name: family,
          symbol: ['circle', 'diamond', 'triangle'][index],
          symbolSize: 13,
          emphasis: { focus: 'series', scale: 1.35 },
          itemStyle: {
            color:
              index === 0
                ? 'var(--data-lime)'
                : index === 1
                  ? 'var(--data-cyan)'
                  : 'var(--data-violet)',
            borderColor: 'var(--panel)',
            borderWidth: 1.5,
            opacity: 0.88,
          },
          data: points
            .filter(({ entry }) => entry.modelFamily === family)
            .map(({ entry, row, x, y }) => [
              x,
              y,
              `${entry.modelFamily} · ${entry.reasoningTier}`,
              metric === 'duration' ? row.observedTimeSampleCount : row.estimatedCostSampleCount,
              `${entry.coveragePercent?.toFixed(1) ?? '—'}%`,
              entry.ciLow ?? y,
              entry.ciHigh ?? y,
              entry.scoringVersion ?? 'unavailable',
              entry.synthetic ? 'synthetic' : 'published',
              entry.sampleSize,
              entry.runtimeIssues,
              entry.missing,
              entry.scoreStatus.replaceAll('_', ' '),
            ]),
        })),
        {
          type: 'scatter',
          name: 'Descriptive Pareto frontier',
          silent: true,
          z: 5,
          symbolSize: 21,
          itemStyle: {
            color: 'transparent',
            borderColor: 'var(--frontier)',
            borderWidth: 3,
          },
          data: points.filter(({ row }) => frontierRunIds.has(row.runId)).map(({ x, y }) => [x, y]),
        },
      ],
    };
  }, [frontierRunIds, metric, points]);

  return (
    <section className="efficiency-plot" aria-labelledby="efficiency-plot-heading">
      <header className="chart-header">
        <div>
          <span className="eyebrow">Descriptive efficiency frontier</span>
          <h3 id="efficiency-plot-heading">
            AIQ versus {metric === 'cost' ? 'estimated cost' : 'duration'}
          </h3>
          <p>
            Upper-left is better. Rings mark nondominated points only inside matching matrix batch,
            scoring, concurrency, evidence-method, and pricing bindings; they do not create a
            combined rank.
          </p>
        </div>
        <div className="chart-switch" role="group" aria-label="Efficiency metric">
          <button type="button" aria-pressed={metric === 'cost'} onClick={() => setMetric('cost')}>
            Cost
          </button>
          <button
            type="button"
            aria-pressed={metric === 'duration'}
            onClick={() => setMetric('duration')}
          >
            Duration
          </button>
        </div>
      </header>
      {points.length === 0 ? (
        <p className="empty-note">
          No coverage-qualified {metric} observations are available. Missing values are not zero.
        </p>
      ) : (
        <EChartsChart
          className="efficiency-chart"
          option={option}
          label={`Scatter plot of AIQ against ${metric} for ${points.length} configurations, with visible task-sensitivity intervals and descriptive Pareto frontier rings; upper-left is better`}
        />
      )}
      <p className="efficiency-coverage">
        {points.length}/{rows.length} configurations plotted · {unavailable} unavailable for the
        selected metric · missing values are excluded, never encoded as zero
      </p>
      <details className="chart-data-disclosure">
        <summary>Read efficiency values</summary>
        <div
          className="table-scroll"
          role="region"
          aria-label="Efficiency evidence values"
          tabIndex={0}
        >
          <table>
            <caption>
              AIQ is unchanged by the selected efficiency metric. Cost is a Standard API-equivalent
              estimate, not billed subscription cost; duration is summed cell adapter time, not
              wall-clock time.
            </caption>
            <thead>
              <tr>
                <th scope="col">Configuration</th>
                <th scope="col">AIQ (task-sensitivity interval)</th>
                <th scope="col">{metric === 'cost' ? 'Estimate (USD)' : 'Adapter time'}</th>
                <th scope="col">n</th>
                <th scope="col">Coverage</th>
                <th scope="col">Runtime / missing</th>
                <th scope="col">Frontier</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {points.map(({ entry, row, x, y }) => (
                <tr key={row.runId}>
                  <th scope="row">
                    {entry.modelFamily} · {entry.reasoningTier}
                  </th>
                  <td>
                    {y.toFixed(1)} ({entry.ciLow?.toFixed(1)}–{entry.ciHigh?.toFixed(1)})
                  </td>
                  <td>
                    {metric === 'cost' ? `$${x.toFixed(4)}` : `${(x / 60_000).toFixed(2)} min`}
                  </td>
                  <td>
                    {metric === 'cost' ? row.estimatedCostSampleCount : row.observedTimeSampleCount}
                  </td>
                  <td>{entry.coveragePercent?.toFixed(1) ?? '—'}%</td>
                  <td>
                    {entry.runtimeIssues ?? '—'} / {entry.missing ?? '—'}
                  </td>
                  <td>{frontierRunIds.has(row.runId) ? 'Descriptive frontier' : '—'}</td>
                  <td>
                    {entry.synthetic ? 'Synthetic' : 'Published'} · scoring{' '}
                    {entry.scoringVersion ?? '—'} · batch {row.matrixBatchId.slice(0, 16)}… ·
                    concurrency {row.executionConcurrency} ·{' '}
                    {metric === 'cost'
                      ? `pricing ${row.pricingVersion ?? 'unavailable'}`
                      : `duration ${row.durationEvidenceLevel ?? 'unavailable'}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
