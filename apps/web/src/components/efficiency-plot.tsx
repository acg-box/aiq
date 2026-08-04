'use client';

import { useMemo, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import type { LeaderboardEntry, PublicModelEfficiency } from '../data/types.ts';
import { EChartsChart } from './echarts-chart.tsx';

type Metric = 'cost' | 'duration';
type EfficiencyDatum = readonly [number, number, string, number, string, number, number];

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
    typeof data[6] !== 'number'
  ) {
    return null;
  }
  return [data[0], data[1], data[2], data[3], data[4], data[5], data[6]];
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
          ? row.standardApiEquivalentUsdNanos === null
            ? null
            : row.standardApiEquivalentUsdNanos / 1_000_000_000
          : row.summedCellAdapterElapsedMs;
      return entry?.score == null || x === null ? [] : [{ row, entry, x, y: entry.score }];
    });
  }, [entries, metric, rows]);
  const unavailable = rows.length - points.length;
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
          return `${datum[2]}<br/>AIQ: ${datum[1].toFixed(1)} (interval ${datum[5].toFixed(1)}–${datum[6].toFixed(1)})<br/>${duration ? 'Summed cell adapter time' : 'Standard API-equivalent estimate'}: ${x}<br/>n=${datum[3]} · coverage ${datum[4]}`;
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
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      series: (['Sol', 'Terra', 'Luna'] as const).map((family, index) => ({
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
          ]),
      })),
    };
  }, [metric, points]);

  return (
    <section className="efficiency-plot" aria-labelledby="efficiency-plot-heading">
      <header className="chart-header">
        <div>
          <span className="eyebrow">Efficiency frontier</span>
          <h3 id="efficiency-plot-heading">
            AIQ versus {metric === 'cost' ? 'estimated cost' : 'duration'}
          </h3>
          <p>Upper-left is better. Efficiency is descriptive and does not change the AIQ rank.</p>
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
          label={`Scatter plot of AIQ against ${metric} for ${points.length} configurations; upper-left is better`}
        />
      )}
      <p className="efficiency-coverage">
        {points.length}/{rows.length} configurations plotted · {unavailable} unavailable for the
        selected metric · missing values are excluded, never encoded as zero
      </p>
      <details className="chart-data-disclosure">
        <summary>Read efficiency values</summary>
        <div className="table-scroll" tabIndex={0}>
          <table>
            <caption>
              AIQ is unchanged by the selected efficiency metric. Cost is a Standard API-equivalent
              estimate; duration is summed cell adapter time, not wall-clock time.
            </caption>
            <thead>
              <tr>
                <th scope="col">Configuration</th>
                <th scope="col">AIQ (task-sensitivity interval)</th>
                <th scope="col">{metric === 'cost' ? 'Estimate (USD)' : 'Adapter time'}</th>
                <th scope="col">n</th>
                <th scope="col">Coverage</th>
                <th scope="col">Runtime / missing</th>
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
                  <td>
                    {entry.synthetic ? 'Synthetic' : 'Published'} · scoring{' '}
                    {entry.scoringVersion ?? '—'}
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
