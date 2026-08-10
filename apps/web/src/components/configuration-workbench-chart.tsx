'use client';

import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import { formatHumanDuration } from '../data/format-duration.ts';
import { presentScoreMetric } from '../data/leaderboard-presentation.ts';
import { configurationFrontierKeys } from './configuration-decision.ts';
import { EChartsChart } from './echarts-chart.tsx';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';

type Metric = 'cost' | 'duration';
type WorkbenchDatum = readonly [number, number, string, string, number, number, string, string];

function formatDurationAxis(value: number): string {
  const minutes = value / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return hours >= 10 ? `${hours.toFixed(0)}h` : `${hours.toFixed(1)}h`;
}

function metricValue(candidate: ExactEfficiencyRow, metric: Metric): number | null {
  if (metric === 'duration') return candidate.row.summedCellAdapterElapsedMs;
  return candidate.row.costEstimatorStatus === 'estimated' &&
    candidate.row.standardApiEquivalentUsdNanos !== null
    ? candidate.row.standardApiEquivalentUsdNanos / 1_000_000_000
    : null;
}

function readDatum(value: unknown): WorkbenchDatum | null {
  if (typeof value !== 'object' || value === null || !('data' in value)) return null;
  const candidate = value.data;
  const data =
    typeof candidate === 'object' &&
    candidate !== null &&
    'value' in candidate &&
    Array.isArray(candidate.value)
      ? candidate.value
      : candidate;
  if (
    !Array.isArray(data) ||
    typeof data[0] !== 'number' ||
    typeof data[1] !== 'number' ||
    typeof data[2] !== 'string' ||
    typeof data[3] !== 'string' ||
    typeof data[4] !== 'number' ||
    typeof data[5] !== 'number' ||
    typeof data[6] !== 'string' ||
    typeof data[7] !== 'string'
  ) {
    return null;
  }
  return [data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7]];
}

export function resolveWorkbenchPlotRows(
  rows: readonly ExactEfficiencyRow[],
  metric: Metric,
): ReadonlyArray<ExactEfficiencyRow & { x: number }> {
  return rows.flatMap((candidate) => {
    const x = metricValue(candidate, metric);
    return x === null ? [] : [{ ...candidate, x }];
  });
}

export function ConfigurationWorkbenchChart({
  allRows,
  rows,
  metric,
  focusId,
}: {
  allRows: readonly ExactEfficiencyRow[];
  rows: readonly ExactEfficiencyRow[];
  metric: Metric;
  focusId: string | null;
}) {
  const points = useMemo(() => resolveWorkbenchPlotRows(rows, metric), [metric, rows]);
  const scalePoints = useMemo(() => resolveWorkbenchPlotRows(allRows, metric), [allRows, metric]);
  const frontierKeys = useMemo(() => configurationFrontierKeys(allRows), [allRows]);
  const xMaximum = Math.max(...scalePoints.map(({ x }) => x), 1);
  const option = useMemo<EChartsCoreOption>(() => {
    const duration = metric === 'duration';
    return {
      aria: { enabled: true, decal: { show: true } },
      grid: { left: 62, right: 24, top: 44, bottom: 52 },
      legend: {
        top: 0,
        right: 8,
        selectedMode: false,
        textStyle: { color: 'var(--muted)' },
        data: ['Sol', 'Terra', 'Luna', 'Pareto frontier'],
      },
      tooltip: {
        trigger: 'item',
        confine: true,
        transitionDuration: 0,
        backgroundColor: 'var(--panel)',
        borderColor: 'var(--line-bright)',
        borderWidth: 1,
        padding: [10, 12],
        textStyle: { color: 'var(--ink)', fontSize: 12, lineHeight: 18 },
        extraCssText:
          'border-radius: var(--radius-small); box-shadow: var(--shadow-float); max-width: min(340px, calc(100vw - 32px)); white-space: normal;',
        formatter: (value: unknown) => {
          const datum = readDatum(value);
          if (!datum) return 'Comparison evidence unavailable';
          const x = duration ? formatHumanDuration(datum[0]) : `$${datum[0].toFixed(4)}`;
          return `${datum[2]}<br/>AIQ ${datum[1].toFixed(1)} · conditional 95% ${datum[4].toFixed(1)}–${datum[5].toFixed(1)}<br/>${duration ? 'Summed task time' : 'API-equivalent cost'} ${x}<br/>${datum[6]} · ${datum[7]}`;
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: xMaximum * 1.06,
        name: duration
          ? 'Summed task time · lower is better'
          : 'API-equivalent cost · lower is better',
        nameLocation: 'middle',
        nameGap: 36,
        axisLabel: {
          color: 'var(--muted)',
          formatter: duration
            ? (value: number) => formatDurationAxis(value)
            : (value: number) => `$${value.toFixed(value < 1 ? 2 : 0)}`,
        },
        nameTextStyle: { color: 'var(--muted)' },
        axisLine: { lineStyle: { color: 'var(--line-bright)' } },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        name: 'AIQ · higher is better',
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
          name: 'Conditional 95% interval',
          silent: true,
          z: 3,
          data: points.map(({ entry, x }) => [
            x,
            entry.scoreCiLow ?? entry.score,
            entry.scoreCiHigh ?? entry.score,
          ]),
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
                  style: { stroke: 'var(--interval)', lineWidth: 1.3 },
                },
                {
                  type: 'line',
                  shape: { x1: low[0] - 3, y1: low[1], x2: low[0] + 3, y2: low[1] },
                  style: { stroke: 'var(--interval)', lineWidth: 1.3 },
                },
                {
                  type: 'line',
                  shape: { x1: high[0] - 3, y1: high[1], x2: high[0] + 3, y2: high[1] },
                  style: { stroke: 'var(--interval)', lineWidth: 1.3 },
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
          emphasis: { disabled: true },
          itemStyle: {
            color:
              index === 0
                ? 'var(--data-lime)'
                : index === 1
                  ? 'var(--data-cyan)'
                  : 'var(--data-violet)',
            borderColor: 'var(--panel)',
            borderWidth: 1.5,
            opacity: 0.9,
          },
          data: points
            .filter(({ entry }) => entry.modelFamily === family)
            .map(({ entry, x }) => {
              const scoreMetric = presentScoreMetric(entry);
              return {
                value: [
                  x,
                  entry.score,
                  `${entry.modelFamily} · ${entry.reasoningTier}`,
                  entry.id,
                  scoreMetric.intervalLow ?? entry.score,
                  scoreMetric.intervalHigh ?? entry.score,
                  frontierKeys.has(entry.id) ? 'Pareto frontier' : 'Not on Pareto frontier',
                  `${entry.sampleSize} tasks · ${entry.coveragePercent.toFixed(0)}% coverage`,
                ],
                symbolSize: entry.id === focusId ? 19 : 13,
                label:
                  entry.id === focusId
                    ? {
                        show: true,
                        position: 'top' as const,
                        color: 'var(--ink)',
                        fontWeight: 700,
                        formatter: `${entry.modelFamily} · ${entry.reasoningTier}`,
                      }
                    : undefined,
              };
            }),
        })),
        {
          type: 'scatter',
          name: 'Pareto frontier',
          silent: true,
          z: 4,
          symbolSize: 21,
          itemStyle: { color: 'transparent', borderColor: 'var(--frontier)', borderWidth: 2.5 },
          data: points
            .filter(({ entry }) => frontierKeys.has(entry.id))
            .map(({ entry, x }) => [x, entry.score]),
        },
      ],
    };
  }, [focusId, frontierKeys, metric, points, xMaximum]);

  if (points.length === 0) {
    return (
      <p className="workbench-empty-chart">
        No filtered configurations have a complete {metric === 'cost' ? 'cost' : 'time'} value.
        Missing evidence is excluded, never shown as zero.
      </p>
    );
  }

  return (
    <div
      className="workbench-chart"
      role="region"
      aria-label={`AIQ against ${metric === 'cost' ? 'API-equivalent cost' : 'summed task time'}`}
      data-workbench-point-count={points.length}
    >
      <EChartsChart
        className="workbench-chart-canvas"
        option={option}
        label={`${points.length} filtered configurations plotted by AIQ and ${metric === 'cost' ? 'API-equivalent cost' : 'summed task time'}; AIQ is not calculated from the horizontal axis`}
      />
      <p className="workbench-chart-note">
        {points.length}/{rows.length} filtered configurations plotted · AIQ stays on its own axis;
        time and cost do not change it.
      </p>
    </div>
  );
}
