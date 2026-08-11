'use client';

import type { EChartsCoreOption } from 'echarts/core';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useTransition } from 'react';

import { TREND_SERIES_STYLES } from '../data/trend-styles.ts';
import {
  presentScoreMetric,
  presentedScoreRange,
  sortByPresentedScore,
} from '../data/leaderboard-presentation.ts';
import type {
  BenchmarkRunSummary,
  LeaderboardEntry,
  ModelFamily,
  PublicModelEfficiency,
  TrendPoint,
  TrendRange,
} from '../data/types.ts';
import { formatHumanDuration } from '../data/format-duration.ts';
import {
  hrefWithParams,
  pushAnalyticalUrl,
  readBoundedIntegerParam,
  readEnumParam,
  useAnalyticalSearchParams,
} from './analytical-url-state.ts';
import { formatConfigurationCost, resolveConfigurationCost } from './configuration-cost.ts';
import { EChartsChart } from './echarts-chart.tsx';
import { ReadStateNote } from './read-state-note.tsx';
import {
  EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE,
  resolveExactScientificEvidence,
} from './scientific-evidence-resolution.ts';
import {
  TREND_BAR_MAX_WIDTH,
  trendIntervalData,
  trendIntervalLineShapes,
  trendIntervalXOffset,
  type TrendBarLayoutItem,
} from './trend-interval-layout.ts';

const ranges: ReadonlyArray<{ value: TrendRange; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: 'All history' },
];
type SeriesFilter = ModelFamily | 'All';
type ReasoningFilter = LeaderboardEntry['reasoningTier'] | 'All';
type TrendMetric = 'aiq' | 'duration' | 'cost';
const seriesFilters: readonly SeriesFilter[] = ['All', 'Sol', 'Terra', 'Luna'];
const reasoningFilters: readonly ReasoningFilter[] = [
  'All',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
const trendMetrics: ReadonlyArray<{ value: TrendMetric; label: string }> = [
  { value: 'aiq', label: 'AIQ' },
  { value: 'duration', label: 'Time' },
  { value: 'cost', label: 'Cost' },
];
const TREND_ZOOM_DATE_COUNT = 12;
const formatDate = (value: string) => value.slice(0, 10);
const pointProvenance = (point: TrendPoint) => (point.synthetic ? 'Synthetic' : 'Published');

export function scoreAxisTicks(minimum: number, maximum: number, count = 5): readonly number[] {
  if (count < 2 || maximum <= minimum) return [minimum];
  return Array.from(
    { length: count },
    (_, index) => minimum + ((maximum - minimum) * index) / (count - 1),
  );
}

export function dateAxisTicks(minimum: number, maximum: number): readonly number[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [];
  if (minimum === maximum) return [minimum];
  return [minimum, minimum + (maximum - minimum) / 2, maximum];
}

const formatAxisDate = (timestamp: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(timestamp),
  );

function seriesProvenance(points: readonly TrendPoint[]): string {
  if (points.length === 0) return 'No observations in selected range';
  if (points.every((point) => point.synthetic)) return 'synthetic';
  if (points.every((point) => !point.synthetic)) return 'published';
  return 'mixed provenance';
}

function readTrendTooltipItem(value: unknown): {
  seriesName: string;
  data: readonly (number | string | null)[];
} | null {
  const data =
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null &&
    'value' in value.data
      ? value.data.value
      : typeof value === 'object' && value !== null && 'data' in value
        ? value.data
        : null;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('seriesName' in value) ||
    typeof value.seriesName !== 'string' ||
    !Array.isArray(data) ||
    !data.every((item) => typeof item === 'number' || typeof item === 'string' || item === null)
  ) {
    return null;
  }
  return { seriesName: value.seriesName, data };
}

interface TrendRenderItemApi {
  value: (dimension: number) => number | string;
  coord: (value: readonly (number | string)[]) => readonly [number, number];
  barLayout: (options: {
    count: number;
    barMaxWidth: number;
    barGap: number;
  }) => readonly TrendBarLayoutItem[] | null | undefined;
}

interface TrendScientificContext {
  coverage: string;
  runtime: string;
  missing: string;
  duration: string;
  cost: string;
  exactJoinUnavailable: boolean;
  durationMs: number | null;
  costUsd: number | null;
}

const unavailableTrendContext: TrendScientificContext = {
  coverage: 'Unavailable',
  runtime: 'Unavailable',
  missing: 'Unavailable',
  duration: 'Unavailable',
  cost: 'Unavailable',
  exactJoinUnavailable: false,
  durationMs: null,
  costUsd: null,
};

function resolveTrendScientificContext({
  point,
  entries,
  runSummaries,
  efficiency,
}: {
  point: TrendPoint;
  entries: readonly LeaderboardEntry[];
  runSummaries: readonly BenchmarkRunSummary[];
  efficiency: readonly PublicModelEfficiency[];
}): TrendScientificContext {
  if (point.runId === null) return unavailableTrendContext;
  const resolution = resolveExactScientificEvidence({
    candidate: {
      runId: point.runId,
      entryId: point.entryId,
      scoringVersion: point.scoringVersion,
      synthetic: point.synthetic,
    },
    runs: runSummaries,
    entries,
    efficiencyRows: efficiency,
  });
  if (resolution.state === 'unavailable') {
    return { ...unavailableTrendContext, exactJoinUnavailable: true };
  }
  const exactRun = resolution.run;
  const exactEfficiency = resolution.evidence.efficiency;
  const costEvidence = exactEfficiency ? resolveConfigurationCost(exactEfficiency) : null;
  return {
    coverage:
      exactRun.resultSummary.coveragePercent === null
        ? 'Unavailable'
        : `${exactRun.resultSummary.coveragePercent.toFixed(1)}%`,
    runtime: String(exactRun.resultSummary.runtimeIssueCount),
    missing: String(exactRun.resultSummary.missingCount),
    duration:
      exactEfficiency?.summedCellAdapterElapsedMs == null
        ? 'Unavailable'
        : formatHumanDuration(exactEfficiency.summedCellAdapterElapsedMs),
    cost: costEvidence ? formatConfigurationCost(costEvidence) : 'Unavailable',
    exactJoinUnavailable: false,
    durationMs: exactEfficiency?.summedCellAdapterElapsedMs ?? null,
    costUsd:
      costEvidence && costEvidence.kind !== 'unavailable'
        ? costEvidence.upperUsdNanos / 1_000_000_000
        : null,
  };
}

function trendMetricValue(
  metric: TrendMetric,
  point: TrendPoint,
  context: TrendScientificContext | undefined,
): number | null {
  if (metric === 'duration') {
    return context?.durationMs === null || context?.durationMs === undefined
      ? null
      : context.durationMs / 3_600_000;
  }
  if (metric === 'cost') return context?.costUsd ?? null;
  return presentScoreMetric(point).score;
}

function trendMetricLabel(metric: TrendMetric): string {
  if (metric === 'duration') return 'Summed adapter time (hours)';
  if (metric === 'cost') return 'API-equivalent cost ceiling (USD)';
  return 'AIQ (0–100)';
}

export function TrendExplorer({
  entries,
  points,
  runSummaries,
  efficiency,
  range,
}: {
  entries: readonly LeaderboardEntry[];
  points: readonly TrendPoint[];
  runSummaries: readonly BenchmarkRunSummary[];
  efficiency: readonly PublicModelEfficiency[];
  range: TrendRange;
}) {
  const searchParams = useAnalyticalSearchParams();
  const pathname = usePathname();
  const mode = readEnumParam(searchParams, 'trendEncoding', ['line', 'bar'], 'line');
  const seriesFilter = readEnumParam(searchParams, 'trendFamily', seriesFilters, 'All');
  const reasoningFilter = readEnumParam(searchParams, 'trendReasoning', reasoningFilters, 'All');
  const metric = readEnumParam(searchParams, 'trendMetric', ['aiq', 'duration', 'cost'], 'aiq');
  const [isPending, startTransition] = useTransition();
  const selectedEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (seriesFilter === 'All' || entry.modelFamily === seriesFilter) &&
          (reasoningFilter === 'All' || entry.reasoningTier === reasoningFilter),
      ),
    [entries, reasoningFilter, seriesFilter],
  );
  const selectedIds = useMemo(() => selectedEntries.map((entry) => entry.id), [selectedEntries]);
  const familyPoints = useMemo(() => {
    const candidates = points.filter((point) => selectedIds.includes(point.entryId));
    const official = candidates.filter((point) => presentScoreMetric(point).official);
    return official.length > 0 ? official : candidates;
  }, [points, selectedIds]);
  const allTimes = useMemo(
    () =>
      [...new Set(familyPoints.map((point) => new Date(point.recordedAt).getTime()))].toSorted(
        (left, right) => left - right,
      ),
    [familyPoints],
  );
  const isSingleObservationDate = allTimes.length === 1;
  const chartMode = isSingleObservationDate ? 'bar' : mode;
  const maximumZoomStart = Math.max(0, allTimes.length - TREND_ZOOM_DATE_COUNT);
  const zoomStart =
    allTimes.length > TREND_ZOOM_DATE_COUNT
      ? readBoundedIntegerParam(searchParams, 'trendZoom', 0, maximumZoomStart)
      : null;
  const zoomEnd =
    zoomStart === null
      ? allTimes.length - 1
      : Math.min(allTimes.length - 1, zoomStart + TREND_ZOOM_DATE_COUNT - 1);
  const zoomWindowTimes = useMemo(
    () => (zoomStart === null ? allTimes : allTimes.slice(zoomStart, zoomEnd + 1)),
    [allTimes, zoomEnd, zoomStart],
  );
  const zoomWindowTimeSet = useMemo(() => new Set(zoomWindowTimes), [zoomWindowTimes]);
  const zoomWindowPoints = useMemo(
    () =>
      familyPoints.filter((point) => zoomWindowTimeSet.has(new Date(point.recordedAt).getTime())),
    [familyPoints, zoomWindowTimeSet],
  );
  const latestVisibleTime = zoomWindowTimes.at(-1);
  const latestVisiblePoints = zoomWindowPoints.filter(
    (point) => new Date(point.recordedAt).getTime() === latestVisibleTime,
  );
  const latestVisiblePoint = sortByPresentedScore(latestVisiblePoints)[0];
  const latestVisibleRange = presentedScoreRange(latestVisiblePoints);
  const intervalPoints = useMemo(
    () =>
      metric === 'aiq'
        ? zoomWindowPoints.flatMap((point) => {
            const scoreMetric = presentScoreMetric(point);
            return scoreMetric.intervalLow === null || scoreMetric.intervalHigh === null
              ? []
              : [
                  {
                    entryId: point.entryId,
                    recordedAt: point.recordedAt,
                    intervalLow: scoreMetric.intervalLow,
                    intervalHigh: scoreMetric.intervalHigh,
                  },
                ];
          })
        : [],
    [metric, zoomWindowPoints],
  );
  const scientificContexts = useMemo(
    () =>
      new Map(
        zoomWindowPoints.map((point) => [
          point,
          resolveTrendScientificContext({ point, entries, runSummaries, efficiency }),
        ]),
      ),
    [efficiency, entries, runSummaries, zoomWindowPoints],
  );
  const latestScientificContext = latestVisiblePoint
    ? (scientificContexts.get(latestVisiblePoint) ?? unavailableTrendContext)
    : null;
  const latestVisibleMetric = latestVisiblePoint ? presentScoreMetric(latestVisiblePoint) : null;
  const exactJoinUnavailable = [...scientificContexts.values()].some(
    (context) => context.exactJoinUnavailable,
  );
  const latestMetricValues = latestVisiblePoints.flatMap((point) => {
    const value = trendMetricValue(metric, point, scientificContexts.get(point));
    return value === null ? [] : [{ point, value }];
  });
  const latestMetricBest = latestMetricValues.toSorted((left, right) =>
    metric === 'aiq' ? right.value - left.value : left.value - right.value,
  )[0];
  const chartOption = useMemo<EChartsCoreOption>(() => {
    if (isSingleObservationDate) {
      const visibleTime = zoomWindowTimes[0];
      const snapshotRows = selectedEntries
        .flatMap((entry, styleIndex) => {
          const point = zoomWindowPoints.find(
            (candidate) =>
              candidate.entryId === entry.id &&
              new Date(candidate.recordedAt).getTime() === visibleTime,
          );
          if (!point) return [];
          const context = scientificContexts.get(point);
          const value = trendMetricValue(metric, point, context);
          if (value === null) return [];
          const scoreMetric = presentScoreMetric(point);
          const strictPass =
            point.strictPassRate === null || point.strictPassSampleSize === null
              ? 'Unavailable'
              : `${(point.strictPassRate * 100).toFixed(1)}% (n=${point.strictPassSampleSize})`;
          return [
            {
              name: `${entry.modelFamily} · ${entry.reasoningTier}`,
              point,
              context,
              value,
              scoreMetric,
              strictPass,
              color: TREND_SERIES_STYLES[styleIndex]?.color ?? '#83909c',
            },
          ];
        })
        .toSorted((left, right) =>
          metric === 'aiq' ? right.value - left.value : left.value - right.value,
        );
      const snapshotData = snapshotRows.map(
        ({ name, point, context, value, scoreMetric, strictPass, color }) => ({
          value: [
            name,
            value,
            metric === 'aiq' ? (scoreMetric.intervalLow ?? point.score) : value,
            metric === 'aiq' ? (scoreMetric.intervalHigh ?? point.score) : value,
            point.sampleSize,
            point.representedRunCount,
            point.synthetic ? 'synthetic' : 'published',
            point.scoringVersion,
            point.runId,
            context?.coverage ?? 'Unavailable',
            context?.runtime ?? 'Unavailable',
            context?.missing ?? 'Unavailable',
            context?.duration ?? 'Unavailable',
            context?.cost ?? 'Unavailable',
            metric === 'aiq' ? scoreMetric.scoreLabel : trendMetricLabel(metric),
            metric === 'aiq' ? scoreMetric.intervalLabel : 'none',
            strictPass,
            new Date(point.recordedAt).getTime(),
          ],
          itemStyle: { color },
        }),
      );
      const snapshotIntervals =
        metric === 'aiq'
          ? snapshotRows.map(({ name, scoreMetric, point, color }) => [
              name,
              scoreMetric.intervalLow ?? point.score,
              scoreMetric.intervalHigh ?? point.score,
              color,
            ])
          : [];
      return {
        aria: { enabled: true, decal: { show: true } },
        grid: { left: 112, right: 28, top: 12, bottom: 50 },
        tooltip: {
          trigger: 'item',
          formatter: (value: unknown) => {
            const item = readTrendTooltipItem(value);
            if (!item) return 'Snapshot evidence unavailable';
            const data = item.data;
            const primary =
              metric === 'aiq'
                ? `${data[14]} ${Number(data[1]).toFixed(1)} · ${String(data[15]).toLowerCase()} ${Number(data[2]).toFixed(1)}–${Number(data[3]).toFixed(1)}`
                : metric === 'cost'
                  ? `${data[14]} ${data[13]}`
                  : `${data[14]} ${Number(data[1]).toFixed(2)}`;
            return `${data[0]}<br/>${formatAxisDate(Number(data[17]))}<br/>${primary}<br/>strict pass ${data[16]}<br/>n=${data[4]} tasks · coverage ${data[9]}<br/>runtime issues ${data[10]} · missing ${data[11]}<br/>summed adapter duration ${data[12]} · API-equivalent cost ${data[13]}<br/>latest of ${data[5]} run(s) · scoring ${data[7]} · ${data[6]}<br/>run ${data[8] ?? 'Unavailable'}`;
          },
        },
        xAxis: {
          type: 'value',
          min: 0,
          max: metric === 'aiq' ? 100 : undefined,
          name: trendMetricLabel(metric),
          nameLocation: 'middle',
          nameGap: 34,
          axisLabel: { color: 'var(--muted)' },
          nameTextStyle: { color: 'var(--muted)' },
          axisLine: { lineStyle: { color: 'var(--line-bright)' } },
          splitLine: { lineStyle: { color: 'var(--line)' } },
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: snapshotRows.map((row) => row.name),
          axisLabel: { color: 'var(--muted)', fontSize: 11 },
          axisTick: { show: false },
          axisLine: { lineStyle: { color: 'var(--line-bright)' } },
        },
        series: [
          {
            type: 'bar',
            id: `trend-snapshot-${metric}`,
            name: 'Published observation',
            encode: { y: 0, x: 1 },
            barMaxWidth: 20,
            emphasis: { focus: 'self', scale: false },
            data: snapshotData,
          },
          ...(metric === 'aiq'
            ? [
                {
                  type: 'custom',
                  id: 'trend-snapshot-intervals',
                  name: 'Primary interval',
                  silent: true,
                  z: 4,
                  encode: { y: 0, x: [1, 2] },
                  data: snapshotIntervals,
                  renderItem: (_params: unknown, api: TrendRenderItemApi) => {
                    const category = api.value(0);
                    const low = api.coord([api.value(1), category]);
                    const high = api.coord([api.value(2), category]);
                    const cap = 4;
                    const stroke = String(api.value(3));
                    return {
                      type: 'group',
                      children: [
                        {
                          type: 'line',
                          shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] },
                          style: { stroke, lineWidth: 1.2, opacity: 0.9 },
                        },
                        {
                          type: 'line',
                          shape: {
                            x1: low[0],
                            y1: low[1] - cap,
                            x2: low[0],
                            y2: low[1] + cap,
                          },
                          style: { stroke, lineWidth: 1.2, opacity: 0.9 },
                        },
                        {
                          type: 'line',
                          shape: {
                            x1: high[0],
                            y1: high[1] - cap,
                            x2: high[0],
                            y2: high[1] + cap,
                          },
                          style: { stroke, lineWidth: 1.2, opacity: 0.9 },
                        },
                      ],
                    };
                  },
                },
              ]
            : []),
        ],
      };
    }
    const series = selectedEntries.map((entry, index) => {
      const byTime = new Map(
        zoomWindowPoints
          .filter((point) => point.entryId === entry.id)
          .map((point) => [new Date(point.recordedAt).getTime(), point]),
      );
      return {
        type: chartMode,
        id: `trend-value-${metric}-${entry.id}`,
        name: `${entry.modelFamily} · ${entry.reasoningTier}`,
        connectNulls: false,
        smooth: false,
        barMaxWidth: TREND_BAR_MAX_WIDTH,
        barGap: 0,
        showSymbol: false,
        symbol: ['circle', 'rect', 'triangle', 'diamond', 'roundRect'][index % 5],
        symbolSize: 7,
        lineStyle: {
          width: 1.8,
          type: index % 3 === 1 ? 'dashed' : index % 3 === 2 ? 'dotted' : 'solid',
        },
        itemStyle: { color: TREND_SERIES_STYLES[index]?.color },
        emphasis: { focus: 'series', scale: false, lineStyle: { width: 2.4 } },
        data: zoomWindowTimes.map((time) => {
          const point = byTime.get(time);
          const context = point ? scientificContexts.get(point) : undefined;
          const scoreMetric = point ? presentScoreMetric(point) : null;
          const value = point ? trendMetricValue(metric, point, context) : null;
          const strictPass =
            !point || point.strictPassRate === null || point.strictPassSampleSize === null
              ? 'Unavailable'
              : `${(point.strictPassRate * 100).toFixed(1)}% (n=${point.strictPassSampleSize})`;
          return point
            ? [
                chartMode === 'bar' ? String(time) : time,
                value,
                metric === 'aiq' ? (scoreMetric?.intervalLow ?? point.score) : value,
                metric === 'aiq' ? (scoreMetric?.intervalHigh ?? point.score) : value,
                point.sampleSize,
                point.representedRunCount,
                point.synthetic ? 'synthetic' : 'published',
                point.scoringVersion,
                point.runId,
                context?.coverage ?? 'Unavailable',
                context?.runtime ?? 'Unavailable',
                context?.missing ?? 'Unavailable',
                context?.duration ?? 'Unavailable',
                context?.cost ?? 'Unavailable',
                metric === 'aiq' ? (scoreMetric?.scoreLabel ?? 'AIQ') : trendMetricLabel(metric),
                metric === 'aiq' ? (scoreMetric?.intervalLabel ?? 'Primary interval') : 'none',
                strictPass,
              ]
            : [chartMode === 'bar' ? String(time) : time, null];
        }),
      };
    });
    const intervalSeries =
      metric === 'aiq'
        ? selectedEntries.map((entry, seriesIndex) => {
            const color = TREND_SERIES_STYLES[seriesIndex]?.color ?? '#83909c';
            return {
              type: 'custom',
              id: `trend-interval-${entry.id}`,
              name: `${entry.modelFamily} · ${entry.reasoningTier} primary interval`,
              silent: true,
              z: 4,
              encode: { x: 0, y: [1, 2] },
              data: trendIntervalData(intervalPoints, entry.id).map(([time, low, high]) => [
                chartMode === 'bar' ? String(time) : time,
                low,
                high,
              ]),
              renderItem: (_params: unknown, api: TrendRenderItemApi) => {
                const layout =
                  chartMode === 'bar'
                    ? api.barLayout({
                        count: selectedEntries.length,
                        barMaxWidth: TREND_BAR_MAX_WIDTH,
                        barGap: 0,
                      })
                    : undefined;
                const xOffset = trendIntervalXOffset(chartMode, seriesIndex, layout);
                if (xOffset === null) return null;
                const time = api.value(0);
                const low = api.coord([time, Number(api.value(1))]);
                const high = api.coord([time, Number(api.value(2))]);
                return {
                  type: 'group',
                  children: trendIntervalLineShapes(low, high, xOffset).map((shape) => ({
                    type: 'line',
                    shape,
                    style: { stroke: color, lineWidth: 1.2, opacity: 0.9 },
                  })),
                };
              },
            };
          })
        : [];
    const xAxis =
      chartMode === 'bar'
        ? {
            type: 'category',
            data: zoomWindowTimes.map(String),
            name: 'Observation date (UTC)',
            nameLocation: 'middle',
            nameGap: 38,
            axisLabel: {
              color: 'var(--muted)',
              formatter: (value: string | number) => formatAxisDate(Number(value)),
            },
            axisTick: { alignWithLabel: true },
            nameTextStyle: { color: 'var(--muted)' },
            axisLine: { lineStyle: { color: 'var(--line-bright)' } },
          }
        : {
            type: 'time',
            name: 'Observation date (UTC)',
            nameLocation: 'middle',
            nameGap: 38,
            axisLabel: { color: 'var(--muted)' },
            nameTextStyle: { color: 'var(--muted)' },
            axisLine: { lineStyle: { color: 'var(--line-bright)' } },
          };
    return {
      aria: { enabled: true, decal: { show: true } },
      grid: { left: 58, right: 24, top: 24, bottom: 62 },
      tooltip: {
        trigger: 'item',
        formatter: (value: unknown) => {
          const item = readTrendTooltipItem(value);
          if (!item) return 'Trend evidence unavailable';
          const data = item.data;
          if (item.seriesName.endsWith('primary interval')) {
            return item.seriesName;
          }
          if (data[1] === null) return `${item.seriesName}<br/>No observation in this bucket`;
          const primary =
            metric === 'aiq'
              ? `${data[14]} ${Number(data[1]).toFixed(1)} · ${String(data[15]).toLowerCase()} ${Number(data[2]).toFixed(1)}–${Number(data[3]).toFixed(1)}`
              : metric === 'cost'
                ? `${data[14]} ${data[13]}`
                : `${data[14]} ${Number(data[1]).toFixed(2)}`;
          return `${item.seriesName}<br/>${formatAxisDate(Number(data[0]))}<br/>${primary}<br/>strict pass ${data[16]}<br/>n=${data[4]} tasks · coverage ${data[9]}<br/>runtime issues ${data[10]} · missing ${data[11]}<br/>summed adapter duration ${data[12]} · API-equivalent cost ${data[13]}<br/>latest of ${data[5]} run(s) · scoring ${data[7]} · ${data[6]}<br/>run ${data[8] ?? 'Unavailable'}`;
        },
      },
      xAxis,
      yAxis: {
        type: 'value',
        min: 0,
        max: metric === 'aiq' ? 100 : undefined,
        name: trendMetricLabel(metric),
        nameLocation: 'middle',
        nameGap: 40,
        axisLabel: { color: 'var(--muted)' },
        nameTextStyle: { color: 'var(--muted)' },
        axisLine: { lineStyle: { color: 'var(--line-bright)' } },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      series: [...series, ...intervalSeries],
    };
  }, [
    intervalPoints,
    metric,
    chartMode,
    isSingleObservationDate,
    scientificContexts,
    selectedEntries,
    zoomWindowPoints,
    zoomWindowTimes,
  ]);
  const visibleScoringVersions = [
    ...new Set(zoomWindowPoints.map((point) => point.scoringVersion)),
  ];
  const visibleSeriesProvenance = seriesProvenance(zoomWindowPoints);

  return (
    <>
      <div className="trend-mode-control" aria-label="Trend controls">
        <div className="chart-control">
          <span>Measure</span>
          <div className="chart-switch" role="group" aria-label="Trend measure">
            {trendMetrics.map((candidate) => (
              <button
                key={candidate.value}
                type="button"
                aria-pressed={metric === candidate.value}
                onClick={() =>
                  startTransition(() =>
                    pushAnalyticalUrl(
                      { trendMetric: candidate.value },
                      { hasSemanticChange: candidate.value !== metric },
                    ),
                  )
                }
              >
                {candidate.label}
              </button>
            ))}
          </div>
        </div>
        <div className="chart-control">
          <span>Period</span>
          <nav className="range-tabs" aria-label="Trend time range">
            {ranges.map((candidate) => (
              <Link
                key={candidate.value}
                aria-current={range === candidate.value ? 'page' : undefined}
                href={`${hrefWithParams(pathname === '/' ? '/' : '/trends', searchParams, {
                  range: candidate.value,
                  trendZoom: null,
                })}${pathname === '/' ? '#trends' : ''}`}
              >
                {candidate.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="chart-control">
          <span>Family</span>
          <div className="chart-switch" role="group" aria-label="Trend series filter">
            {seriesFilters.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={seriesFilter === candidate}
                onClick={() =>
                  startTransition(() =>
                    pushAnalyticalUrl(
                      { trendFamily: candidate, trendZoom: null },
                      { hasSemanticChange: candidate !== seriesFilter },
                    ),
                  )
                }
              >
                {candidate}
              </button>
            ))}
          </div>
        </div>
        <div className="chart-control">
          <label htmlFor="trend-reasoning-filter">Reasoning</label>
          <select
            id="trend-reasoning-filter"
            className="chart-select"
            value={reasoningFilter}
            onChange={(event) =>
              startTransition(() =>
                pushAnalyticalUrl(
                  { trendReasoning: event.target.value, trendZoom: null },
                  { hasSemanticChange: event.target.value !== reasoningFilter },
                ),
              )
            }
          >
            {reasoningFilters.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate === 'All' ? 'All levels' : candidate}
              </option>
            ))}
          </select>
        </div>
        {!isSingleObservationDate ? (
          <div className="chart-control">
            <span>View</span>
            <div className="chart-switch" role="group" aria-label="Trend chart mode">
              {(['line', 'bar'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={mode === candidate}
                  onClick={() =>
                    startTransition(() =>
                      pushAnalyticalUrl(
                        { trendEncoding: candidate },
                        { hasSemanticChange: candidate !== mode },
                      ),
                    )
                  }
                >
                  {candidate === 'line' ? 'Line' : 'Bar'}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chart-control trend-snapshot-control">
            <span>View</span>
            <strong>Snapshot</strong>
          </div>
        )}
      </div>
      {allTimes.length > TREND_ZOOM_DATE_COUNT ? (
        <div className="trend-window-control" aria-label="Visible trend date range">
          <span>
            {zoomStart === null
              ? `All ${allTimes.length} dates`
              : `Dates ${zoomStart + 1}–${zoomEnd + 1} of ${allTimes.length}`}
          </span>
          <div className="chart-switch" role="group" aria-label="Trend date window">
            <button
              type="button"
              onClick={() =>
                pushAnalyticalUrl(
                  { trendZoom: String(maximumZoomStart) },
                  { hasSemanticChange: zoomStart !== maximumZoomStart },
                )
              }
            >
              Latest 12
            </button>
            <button
              type="button"
              disabled={zoomStart === null || zoomStart === 0}
              onClick={() =>
                pushAnalyticalUrl({
                  trendZoom: String(Math.max(0, (zoomStart ?? 0) - TREND_ZOOM_DATE_COUNT)),
                })
              }
            >
              Earlier 12
            </button>
            <button
              type="button"
              disabled={zoomStart === null || zoomStart === maximumZoomStart}
              onClick={() =>
                pushAnalyticalUrl({
                  trendZoom: String(
                    Math.min(maximumZoomStart, (zoomStart ?? 0) + TREND_ZOOM_DATE_COUNT),
                  ),
                })
              }
            >
              Later 12
            </button>
            <button
              type="button"
              disabled={zoomStart === null}
              onClick={() => pushAnalyticalUrl({ trendZoom: null })}
            >
              Reset: all dates
            </button>
          </div>
        </div>
      ) : null}
      {allTimes.length === 1 ? (
        <p className="trend-snapshot-note" role="status">
          <strong>First published observation.</strong> Compare the configurations in this snapshot;
          trend lines begin after the next published cycle.
        </p>
      ) : null}
      <div
        className={`trend-layout${allTimes.length === 1 ? ' trend-layout-snapshot' : ''}${isPending ? ' is-pending' : ''}`}
      >
        <div className="chart-frame">
          {zoomWindowPoints.length > 0 ? (
            <EChartsChart
              className="trend-chart-echarts"
              option={chartOption}
              label={
                allTimes.length === 1
                  ? `${trendMetricLabel(metric)} first-observation snapshot. Configurations ordered from best to worst${metric === 'aiq' ? ' with provenance-matched intervals' : ''}.`
                  : chartMode === 'bar'
                    ? `${trendMetricLabel(metric)} history. Grouped bars${metric === 'aiq' ? ' with provenance-matched intervals' : ''}.`
                    : `${trendMetricLabel(metric)} history. Lines${metric === 'aiq' ? ' with provenance-matched intervals' : ''}.`
              }
            />
          ) : (
            <p>No observations fall in this range.</p>
          )}
        </div>
        <ul className="chart-legend" aria-label="Visible trend series">
          {selectedEntries.map((entry, index) => {
            const series = zoomWindowPoints.filter((point) => point.entryId === entry.id);
            const scoringVersions = [...new Set(series.map((point) => point.scoringVersion))];
            return (
              <li
                key={entry.id}
                title={`${seriesProvenance(series)} · scoring ${scoringVersions.join(', ') || 'unavailable'}`}
              >
                <i
                  className={`series-symbol series-symbol-${index + 1}`}
                  style={{ background: TREND_SERIES_STYLES[index]?.color }}
                  aria-hidden="true"
                />
                <strong>
                  {entry.modelFamily} · {entry.reasoningTier}
                </strong>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="trend-legend-note">
        {selectedEntries.length} {visibleSeriesProvenance} series · scoring{' '}
        {visibleScoringVersions.join(', ') || 'unavailable'}
        {allTimes.length === 1
          ? ' · first observation; trend begins with the next published cycle'
          : chartMode === 'line'
            ? ' · connected observations; no interpolation'
            : ' · grouped bars'}
      </p>
      {metric === 'aiq' &&
      latestVisiblePoint &&
      latestVisibleRange &&
      latestScientificContext &&
      latestVisibleMetric ? (
        <p className="trend-resolution" aria-live="polite">
          Latest visible date: {formatDate(latestVisiblePoint.recordedAt)} UTC ·{' '}
          {latestVisiblePoints.length} observations · {latestVisibleMetric.scoreLabel.toLowerCase()}{' '}
          range {latestVisibleRange.minimum.toFixed(1)}–{latestVisibleRange.maximum.toFixed(1)}.
          Highest point estimate: {latestVisiblePoint.entryId} ·{' '}
          {latestVisibleMetric.intervalLabel.toLowerCase()} {latestVisibleMetric.interval} · strict
          pass{' '}
          {latestVisiblePoint.strictPassRate === null
            ? 'Unavailable'
            : `${(latestVisiblePoint.strictPassRate * 100).toFixed(1)}% (n=${latestVisiblePoint.strictPassSampleSize})`}{' '}
          · n={latestVisiblePoint.sampleSize} · coverage {latestScientificContext.coverage} ·
          scoring {latestVisiblePoint.scoringVersion} ·{' '}
          {pointProvenance(latestVisiblePoint).toLowerCase()}
        </p>
      ) : metric !== 'aiq' && latestMetricBest ? (
        <p className="trend-resolution" aria-live="polite">
          Latest visible date: {formatDate(latestMetricBest.point.recordedAt)} UTC ·{' '}
          {latestMetricValues.length} measured configurations · lowest {trendMetricLabel(metric)}:{' '}
          {latestMetricBest.point.entryId} ·{' '}
          {metric === 'duration'
            ? formatHumanDuration(latestMetricBest.value * 3_600_000)
            : `$${latestMetricBest.value.toFixed(4)}`}
          . AIQ ranking is unchanged by this measure.
        </p>
      ) : null}
      <details className="data-disclosure">
        <summary>Evidence notes and visible values</summary>
        <p className="trend-resolution" role="note">
          Showing {selectedEntries.length} configurations in canonical matrix order. Family and
          reasoning are explicit filters, not point-estimate cutoffs. Published buckets retain the
          latest exact Official run; synthetic fixture buckets expose no run detail. Lines connect
          observations for continuity only; they do not interpolate or estimate values between
          dates. Absent buckets remain gaps, bars use a zero baseline, and the server returns at
          most 20 buckets per configuration. Each point requires matching run, configuration,
          scoring version, and provenance identity. Scoring versions:{' '}
          {[...new Set(zoomWindowPoints.map((point) => point.scoringVersion))].join(', ') ||
            'unavailable'}
          .
        </p>
        {exactJoinUnavailable ? (
          <ReadStateNote
            result={{ state: 'unavailable', detail: EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE }}
            subject="Exact trend run context"
          />
        ) : null}
        <div className="table-scroll" role="region" aria-label="Visible trend values" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                <th scope="col">Series</th>
                <th scope="col">Primary metric</th>
                <th scope="col">Primary interval</th>
                <th scope="col">Strict pass</th>
                <th scope="col">n</th>
                <th scope="col">Run / bucket</th>
                <th scope="col">Coverage</th>
                <th scope="col">Runtime</th>
                <th scope="col">Missing</th>
                <th scope="col">Summed adapter duration</th>
                <th scope="col">API-equivalent cost</th>
                <th scope="col">Scoring</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {zoomWindowPoints
                .toSorted(
                  (left, right) =>
                    new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime(),
                )
                .map((point) => {
                  const context = scientificContexts.get(point) ?? unavailableTrendContext;
                  const scoreMetric = presentScoreMetric(point);
                  const selectedMetricValue = trendMetricValue(metric, point, context);
                  return (
                    <tr key={`${point.entryId}-${point.recordedAt}`}>
                      <td>{formatDate(point.recordedAt)}</td>
                      <th scope="row">{point.entryId}</th>
                      <td>
                        {selectedMetricValue === null
                          ? 'Unavailable'
                          : metric === 'aiq'
                            ? `${scoreMetric.scoreText} · ${scoreMetric.scoreLabel}`
                            : metric === 'duration'
                              ? formatHumanDuration(selectedMetricValue * 3_600_000)
                              : `$${selectedMetricValue.toFixed(4)}`}
                      </td>
                      <td>
                        {metric === 'aiq'
                          ? `${scoreMetric.interval} · ${scoreMetric.intervalLabel}`
                          : 'Not applicable to auxiliary measures'}
                      </td>
                      <td>
                        {point.strictPassRate === null
                          ? 'Unavailable'
                          : `${(point.strictPassRate * 100).toFixed(1)}% (n=${point.strictPassSampleSize})`}
                      </td>
                      <td>{point.sampleSize}</td>
                      <td>
                        {point.runId === null ? (
                          'Synthetic fixture · no run detail'
                        ) : (
                          <>
                            <Link href={`/runs/${point.runId}`}>{point.runId}</Link>
                            <br />
                            Latest of {point.representedRunCount} run
                            {point.representedRunCount === 1 ? '' : 's'}
                          </>
                        )}
                      </td>
                      <td>{context.coverage}</td>
                      <td>{context.runtime}</td>
                      <td>{context.missing}</td>
                      <td>{context.duration}</td>
                      <td>{context.cost}</td>
                      <td>{point.scoringVersion}</td>
                      <td>{pointProvenance(point)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
