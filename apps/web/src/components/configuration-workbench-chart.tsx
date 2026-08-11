'use client';

import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import { formatHumanDuration } from '../data/format-duration.ts';
import { presentScoreMetric } from '../data/leaderboard-presentation.ts';
import {
  describeConfigurationCost,
  resolveConfigurationCost,
  type ConfigurationCostEvidence,
} from './configuration-cost.ts';
import { configurationFrontierKeys } from './configuration-decision.ts';
import { EChartsChart } from './echarts-chart.tsx';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';

type Metric = 'cost' | 'decision' | 'duration';
type WorkbenchDatum = readonly [
  number,
  number,
  string,
  string,
  number,
  number,
  string,
  string,
  number,
  number,
  number,
  ConfigurationCostEvidence['kind'],
  string,
];

export type WorkbenchPlotRow = ExactEfficiencyRow & {
  x: number;
  cost: ConfigurationCostEvidence;
};

function formatDurationAxis(value: number): string {
  const minutes = value / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return hours >= 10 ? `${hours.toFixed(0)}h` : `${hours.toFixed(1)}h`;
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
    typeof data[7] !== 'string' ||
    typeof data[8] !== 'number' ||
    typeof data[9] !== 'number' ||
    typeof data[10] !== 'number' ||
    (data[11] !== 'exact' && data[11] !== 'bounded' && data[11] !== 'unavailable') ||
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

function costDollars(cost: ConfigurationCostEvidence): readonly [number, number] {
  return cost.kind === 'unavailable'
    ? [-1, -1]
    : [cost.lowerUsdNanos / 1_000_000_000, cost.upperUsdNanos / 1_000_000_000];
}

export function resolveWorkbenchPlotRows(
  rows: readonly ExactEfficiencyRow[],
  metric: Metric,
): readonly WorkbenchPlotRow[] {
  return rows.flatMap((candidate) => {
    const cost = resolveConfigurationCost(candidate.row);
    const duration = candidate.row.summedCellAdapterElapsedMs;
    if (metric === 'cost') {
      return cost.kind === 'unavailable'
        ? []
        : [{ ...candidate, x: cost.upperUsdNanos / 1_000_000_000, cost }];
    }
    return duration === null ? [] : [{ ...candidate, x: duration, cost }];
  });
}

function bubbleSize(value: number, minimum: number, maximum: number): number {
  if (value < 0) return 11;
  if (maximum <= minimum) return 18;
  const normalized =
    (Math.sqrt(value) - Math.sqrt(minimum)) / (Math.sqrt(maximum) - Math.sqrt(minimum));
  return 12 + Math.max(0, Math.min(1, normalized)) * 20;
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
  const allCosts = scalePoints.flatMap(({ cost }) =>
    cost.kind === 'unavailable'
      ? []
      : [cost.lowerUsdNanos / 1_000_000_000, cost.upperUsdNanos / 1_000_000_000],
  );
  const costMinimum = Math.min(...allCosts, 0);
  const costMaximum = Math.max(...allCosts, 1);
  const exactCount = points.filter(({ cost }) => cost.kind === 'exact').length;
  const boundedCount = points.filter(({ cost }) => cost.kind === 'bounded').length;
  const option = useMemo<EChartsCoreOption>(() => {
    const duration = metric !== 'cost';
    const decision = metric === 'decision';
    const datumFor = ({ entry, row, x, cost }: WorkbenchPlotRow): WorkbenchDatum => {
      const scoreMetric = presentScoreMetric(entry);
      const [costLow, costHigh] = costDollars(cost);
      return [
        x,
        entry.score,
        `${entry.modelFamily} · ${entry.reasoningTier}`,
        entry.id,
        scoreMetric.intervalLow ?? entry.score,
        scoreMetric.intervalHigh ?? entry.score,
        frontierKeys.has(entry.id) ? 'Pareto frontier' : 'Not on Pareto frontier',
        `${entry.sampleSize} tasks · ${entry.coveragePercent.toFixed(0)}% coverage`,
        row.summedCellAdapterElapsedMs ?? -1,
        costLow,
        costHigh,
        cost.kind,
        describeConfigurationCost(cost),
      ];
    };
    return {
      aria: { enabled: true, decal: { show: true } },
      grid: { left: 62, right: 24, top: 48, bottom: 52 },
      legend: {
        top: 0,
        right: 8,
        selectedMode: false,
        textStyle: { color: 'var(--muted)' },
        data: decision
          ? ['Sol', 'Terra', 'Luna', 'Cost range', 'Pareto frontier']
          : ['Sol', 'Terra', 'Luna', 'Pareto frontier'],
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
          'border-radius: var(--radius-small); box-shadow: var(--shadow-float); max-width: min(360px, calc(100vw - 32px)); white-space: normal;',
        formatter: (value: unknown) => {
          const datum = readDatum(value);
          if (!datum) return 'Comparison evidence unavailable';
          const cost =
            datum[11] === 'unavailable'
              ? 'Unavailable'
              : datum[9] === datum[10]
                ? `$${datum[9].toFixed(datum[9] < 1 ? 4 : 2)}`
                : `$${datum[9].toFixed(datum[9] < 1 ? 4 : 2)}–$${datum[10].toFixed(datum[10] < 1 ? 4 : 2)}`;
          return `${datum[2]}<br/>AIQ ${datum[1].toFixed(1)} · conditional 95% ${datum[4].toFixed(1)}–${datum[5].toFixed(1)}<br/>Task time ${formatHumanDuration(datum[8])}<br/>API-equivalent cost ${cost}<br/>${datum[12]}<br/>${datum[6]} · ${datum[7]}`;
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: xMaximum * 1.06,
        name: duration
          ? 'Summed task time · lower is better'
          : 'API-equivalent cost upper bound · lower is better',
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
        ...(metric === 'cost'
          ? [
              {
                type: 'custom' as const,
                name: 'Published-rate cost range',
                silent: true,
                z: 2,
                data: points.flatMap(({ entry, cost }) =>
                  cost.kind === 'bounded'
                    ? [
                        [
                          cost.lowerUsdNanos / 1_000_000_000,
                          cost.upperUsdNanos / 1_000_000_000,
                          entry.score,
                        ],
                      ]
                    : [],
                ),
                renderItem: (
                  _params: unknown,
                  api: {
                    value: (dimension: number) => number;
                    coord: (value: readonly number[]) => readonly [number, number];
                  },
                ) => {
                  const low = api.coord([api.value(0), api.value(2)]);
                  const high = api.coord([api.value(1), api.value(2)]);
                  return {
                    type: 'group',
                    children: [
                      {
                        type: 'line',
                        shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] },
                        style: { stroke: 'var(--interval)', lineWidth: 3, opacity: 0.8 },
                      },
                      {
                        type: 'line',
                        shape: { x1: low[0], y1: low[1] - 4, x2: low[0], y2: low[1] + 4 },
                        style: { stroke: 'var(--interval)', lineWidth: 1.5 },
                      },
                    ],
                  };
                },
              },
            ]
          : []),
        ...(decision
          ? [
              {
                type: 'scatter' as const,
                name: 'Cost range',
                silent: true,
                z: 1,
                symbol: 'circle',
                itemStyle: {
                  color: 'transparent',
                  borderColor: 'var(--line-bright)',
                  borderWidth: 1.5,
                  opacity: 0.78,
                },
                data: points.flatMap(({ entry, x, cost }) => {
                  if (cost.kind !== 'bounded') return [];
                  const upper = cost.upperUsdNanos / 1_000_000_000;
                  return [
                    {
                      value: [x, entry.score],
                      symbolSize: bubbleSize(upper, costMinimum, costMaximum) + 5,
                    },
                  ];
                }),
              },
            ]
          : []),
        ...(['Sol', 'Terra', 'Luna'] as const).map((family, index) => ({
          type: 'scatter' as const,
          name: family,
          symbol: decision ? 'circle' : (['circle', 'diamond', 'triangle'][index] ?? 'circle'),
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
            .map((point) => {
              const [costLow] = costDollars(point.cost);
              const datum = datumFor(point);
              const normalSize = decision ? bubbleSize(costLow, costMinimum, costMaximum) : 13;
              return {
                value: datum,
                symbolSize: point.entry.id === focusId ? normalSize + 6 : normalSize,
                label:
                  point.entry.id === focusId
                    ? {
                        show: true,
                        position: 'top' as const,
                        color: 'var(--ink)',
                        fontWeight: 700,
                        formatter: `${point.entry.modelFamily} · ${point.entry.reasoningTier}`,
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
          symbolSize: 22,
          itemStyle: { color: 'transparent', borderColor: 'var(--frontier)', borderWidth: 2.5 },
          data: points
            .filter(({ entry }) => frontierKeys.has(entry.id))
            .map(({ entry, x }) => [x, entry.score]),
        },
      ],
    };
  }, [costMaximum, costMinimum, focusId, frontierKeys, metric, points, xMaximum]);

  if (points.length === 0) {
    return (
      <p className="workbench-empty-chart">
        No filtered configurations have comparable {metric === 'cost' ? 'cost' : 'time'} evidence.
        Missing evidence is excluded, never shown as zero.
      </p>
    );
  }

  const label =
    metric === 'decision'
      ? `${points.length} filtered configurations plotted on a three-metric decision map: AIQ by time, with API-equivalent cost encoded by bubble area and a range ring`
      : `${points.length} filtered configurations plotted by AIQ and ${metric === 'cost' ? 'API-equivalent cost range' : 'summed task time'}; AIQ is not calculated from the horizontal axis`;
  return (
    <div
      className="workbench-chart"
      role="region"
      aria-label={
        metric === 'decision'
          ? 'Three-metric decision map for AIQ, time, and API-equivalent cost'
          : `AIQ against ${metric === 'cost' ? 'API-equivalent cost range' : 'summed task time'}`
      }
      data-workbench-point-count={points.length}
    >
      <EChartsChart className="workbench-chart-canvas" option={option} label={label} />
      <p className="workbench-chart-note">
        {points.length}/{rows.length} filtered configurations plotted · {exactCount} exact cost ·{' '}
        {boundedCount} published-rate range · AIQ remains independent.
      </p>
    </div>
  );
}
