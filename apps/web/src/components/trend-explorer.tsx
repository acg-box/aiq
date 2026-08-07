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
type SeriesFilter = ModelFamily;
const seriesFilters: readonly SeriesFilter[] = ['Sol', 'Terra', 'Luna'];
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
  if (
    typeof value !== 'object' ||
    value === null ||
    !('seriesName' in value) ||
    typeof value.seriesName !== 'string' ||
    !('data' in value) ||
    !Array.isArray(value.data) ||
    !value.data.every(
      (item) => typeof item === 'number' || typeof item === 'string' || item === null,
    )
  ) {
    return null;
  }
  return { seriesName: value.seriesName, data: value.data };
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
}

const unavailableTrendContext: TrendScientificContext = {
  coverage: 'Unavailable',
  runtime: 'Unavailable',
  missing: 'Unavailable',
  duration: 'Unavailable',
  cost: 'Unavailable',
  exactJoinUnavailable: false,
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
    cost:
      exactEfficiency?.costEstimatorStatus === 'estimated' &&
      exactEfficiency.standardApiEquivalentUsdNanos !== null
        ? `$${(exactEfficiency.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`
        : 'Unavailable',
    exactJoinUnavailable: false,
  };
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
  const seriesFilter = readEnumParam(searchParams, 'trendFamily', seriesFilters, 'Sol');
  const [isPending, startTransition] = useTransition();
  const selectedEntries = useMemo(
    () => entries.filter((entry) => entry.modelFamily === seriesFilter),
    [entries, seriesFilter],
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
  const visibleMetricExample = zoomWindowPoints[0] ? presentScoreMetric(zoomWindowPoints[0]) : null;
  const intervalPoints = useMemo(
    () =>
      zoomWindowPoints.flatMap((point) => {
        const metric = presentScoreMetric(point);
        return metric.intervalLow === null || metric.intervalHigh === null
          ? []
          : [
              {
                entryId: point.entryId,
                recordedAt: point.recordedAt,
                intervalLow: metric.intervalLow,
                intervalHigh: metric.intervalHigh,
              },
            ];
      }),
    [zoomWindowPoints],
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
  const chartOption = useMemo<EChartsCoreOption>(() => {
    const series = selectedEntries.map((entry, index) => {
      const byTime = new Map(
        zoomWindowPoints
          .filter((point) => point.entryId === entry.id)
          .map((point) => [new Date(point.recordedAt).getTime(), point]),
      );
      return {
        type: mode,
        id: `trend-value-${entry.id}`,
        name: `${entry.modelFamily} · ${entry.reasoningTier}`,
        connectNulls: false,
        smooth: false,
        barMaxWidth: TREND_BAR_MAX_WIDTH,
        barGap: 0,
        showSymbol: mode === 'line',
        symbol: ['circle', 'rect', 'triangle', 'diamond', 'roundRect'][index % 5],
        symbolSize: 7,
        lineStyle: {
          width: 1.8,
          type: index % 3 === 1 ? 'dashed' : index % 3 === 2 ? 'dotted' : 'solid',
        },
        itemStyle: { color: TREND_SERIES_STYLES[index]?.color },
        data: zoomWindowTimes.map((time) => {
          const point = byTime.get(time);
          const context = point ? scientificContexts.get(point) : undefined;
          const metric = point ? presentScoreMetric(point) : null;
          const strictPass =
            !point || point.strictPassRate === null || point.strictPassSampleSize === null
              ? 'Unavailable'
              : `${(point.strictPassRate * 100).toFixed(1)}% (n=${point.strictPassSampleSize})`;
          return point
            ? [
                mode === 'bar' ? String(time) : time,
                metric?.score ?? point.score,
                metric?.intervalLow ?? point.score,
                metric?.intervalHigh ?? point.score,
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
                metric?.scoreLabel ?? 'Primary score',
                metric?.intervalLabel ?? 'Primary interval',
                strictPass,
              ]
            : [mode === 'bar' ? String(time) : time, null];
        }),
      };
    });
    const intervalSeries = selectedEntries.map((entry, seriesIndex) => {
      const color = TREND_SERIES_STYLES[seriesIndex]?.color ?? '#83909c';
      return {
        type: 'custom',
        id: `trend-interval-${entry.id}`,
        name: `${entry.modelFamily} · ${entry.reasoningTier} primary interval`,
        silent: true,
        z: 4,
        encode: { x: 0, y: [1, 2] },
        data: trendIntervalData(intervalPoints, entry.id).map(([time, low, high]) => [
          mode === 'bar' ? String(time) : time,
          low,
          high,
        ]),
        renderItem: (_params: unknown, api: TrendRenderItemApi) => {
          const layout =
            mode === 'bar'
              ? api.barLayout({
                  count: selectedEntries.length,
                  barMaxWidth: TREND_BAR_MAX_WIDTH,
                  barGap: 0,
                })
              : undefined;
          const xOffset = trendIntervalXOffset(mode, seriesIndex, layout);
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
    });
    const xAxis =
      mode === 'bar'
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
          return `${item.seriesName}<br/>${formatAxisDate(Number(data[0]))}<br/>${data[14]} ${Number(data[1]).toFixed(1)} · ${String(data[15]).toLowerCase()} ${Number(data[2]).toFixed(1)}–${Number(data[3]).toFixed(1)}<br/>strict pass ${data[16]}<br/>n=${data[4]} tasks · coverage ${data[9]}<br/>runtime issues ${data[10]} · missing ${data[11]}<br/>summed adapter duration ${data[12]} · API-equivalent cost ${data[13]}<br/>latest of ${data[5]} run(s) · scoring ${data[7]} · ${data[6]}<br/>run ${data[8] ?? 'Unavailable'}`;
        },
      },
      xAxis,
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        name: `${visibleMetricExample?.scoreLabel ?? 'Primary score'} (0–100)`,
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
    mode,
    scientificContexts,
    selectedEntries,
    visibleMetricExample?.scoreLabel,
    zoomWindowPoints,
    zoomWindowTimes,
  ]);

  return (
    <>
      <div className="trend-mode-control" aria-label="Trend controls">
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
      <div className={`trend-layout${isPending ? ' is-pending' : ''}`}>
        <div className="chart-frame">
          {zoomWindowPoints.length > 0 ? (
            <EChartsChart
              className="trend-chart-echarts"
              option={chartOption}
              label={
                mode === 'bar'
                  ? `${visibleMetricExample?.scoreLabel ?? 'Score'} history. Grouped bars with provenance-matched intervals.`
                  : `${visibleMetricExample?.scoreLabel ?? 'Score'} history. Lines with provenance-matched intervals.`
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
              <li key={entry.id}>
                <i
                  className={`series-symbol series-symbol-${index + 1}`}
                  style={{ background: TREND_SERIES_STYLES[index]?.color }}
                  aria-hidden="true"
                />
                <strong>
                  {entry.modelFamily} · {entry.reasoningTier}
                </strong>
                <small>
                  {seriesProvenance(series)} · scoring {scoringVersions.join(', ') || '—'}
                  {mode === 'line' ? ' · connected observations; no interpolation' : ''}
                </small>
              </li>
            );
          })}
        </ul>
      </div>
      {latestVisiblePoint &&
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
      ) : null}
      <details className="data-disclosure">
        <summary>Evidence notes and visible values</summary>
        <p className="trend-resolution" role="note">
          Showing all {selectedEntries.length} {seriesFilter} configurations in canonical matrix
          order. The family is an explicit filter, not a point-estimate cutoff. Published buckets
          retain the latest exact Official run; synthetic fixture buckets expose no run detail.
          Lines connect observations for continuity only; they do not interpolate or estimate values
          between dates. Absent buckets remain gaps, bars use a zero baseline, and the server
          returns at most 20 buckets per configuration. Each point requires matching run,
          configuration, scoring version, and provenance identity. Scoring versions:{' '}
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
                  const metric = presentScoreMetric(point);
                  return (
                    <tr key={`${point.entryId}-${point.recordedAt}`}>
                      <td>{formatDate(point.recordedAt)}</td>
                      <th scope="row">{point.entryId}</th>
                      <td>
                        {metric.scoreText} · {metric.scoreLabel}
                      </td>
                      <td>
                        {metric.interval} · {metric.intervalLabel}
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
