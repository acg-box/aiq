'use client';

import type { EChartsCoreOption } from 'echarts/core';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';

import { TREND_SERIES_STYLES } from '../data/trend-styles.ts';
import type {
  BenchmarkRunSummary,
  LeaderboardEntry,
  ModelFamily,
  PublicModelEfficiency,
  TrendPoint,
  TrendRange,
} from '../data/types.ts';
import { formatHumanDuration } from '../data/format-duration.ts';
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
  const [mode, setMode] = useState<'line' | 'bar'>('line');
  const [seriesFilter, setSeriesFilter] = useState<SeriesFilter>('Sol');
  const [isPending, startTransition] = useTransition();
  const selectedEntries = useMemo(
    () => entries.filter((entry) => entry.modelFamily === seriesFilter),
    [entries, seriesFilter],
  );
  const selectedIds = useMemo(() => selectedEntries.map((entry) => entry.id), [selectedEntries]);
  const visible = useMemo(
    () => points.filter((point) => selectedIds.includes(point.entryId)),
    [points, selectedIds],
  );
  const scientificContexts = useMemo(
    () =>
      new Map(
        visible.map((point) => [
          point,
          resolveTrendScientificContext({ point, entries, runSummaries, efficiency }),
        ]),
      ),
    [efficiency, entries, runSummaries, visible],
  );
  const exactJoinUnavailable = [...scientificContexts.values()].some(
    (context) => context.exactJoinUnavailable,
  );
  const chartOption = useMemo<EChartsCoreOption>(() => {
    const allTimes = [
      ...new Set(visible.map((point) => new Date(point.recordedAt).getTime())),
    ].toSorted((left, right) => left - right);
    const series = selectedEntries.map((entry, index) => {
      const byTime = new Map(
        visible
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
        data: allTimes.map((time) => {
          const point = byTime.get(time);
          const context = point ? scientificContexts.get(point) : undefined;
          return point
            ? [
                mode === 'bar' ? String(time) : time,
                point.score,
                point.sensitivityLow,
                point.sensitivityHigh,
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
        name: `${entry.modelFamily} · ${entry.reasoningTier} task-sensitivity interval`,
        silent: true,
        z: 4,
        encode: { x: 0, y: [1, 2] },
        data: trendIntervalData(visible, entry.id).map(([time, low, high]) => [
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
            data: allTimes.map(String),
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
          if (item.seriesName.endsWith('task-sensitivity interval')) {
            return item.seriesName;
          }
          if (data[1] === null) return `${item.seriesName}<br/>No observation in this bucket`;
          return `${item.seriesName}<br/>${formatAxisDate(Number(data[0]))}<br/>AIQ ${Number(data[1]).toFixed(1)} · interval ${Number(data[2]).toFixed(1)}–${Number(data[3]).toFixed(1)}<br/>n=${data[4]} tasks · coverage ${data[9]}<br/>runtime issues ${data[10]} · missing ${data[11]}<br/>summed adapter duration ${data[12]} · API-equivalent cost ${data[13]}<br/>latest of ${data[5]} run(s) · scoring ${data[7]} · ${data[6]}<br/>run ${data[8] ?? 'Unavailable'}`;
        },
      },
      dataZoom: allTimes.length > 12 ? [{ type: 'inside', xAxisIndex: 0 }] : undefined,
      xAxis,
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        name: 'AIQ index (0–100)',
        nameLocation: 'middle',
        nameGap: 40,
        axisLabel: { color: 'var(--muted)' },
        nameTextStyle: { color: 'var(--muted)' },
        axisLine: { lineStyle: { color: 'var(--line-bright)' } },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      series: [...series, ...intervalSeries],
    };
  }, [mode, scientificContexts, selectedEntries, visible]);

  return (
    <>
      <nav className="range-tabs" aria-label="Trend time range">
        {ranges.map((candidate) => (
          <Link
            key={candidate.value}
            aria-current={range === candidate.value ? 'page' : undefined}
            href={`/trends?range=${candidate.value}`}
          >
            {candidate.label}
          </Link>
        ))}
      </nav>
      <div className="trend-mode-control">
        <span>Series</span>
        <div className="chart-switch" role="group" aria-label="Trend series filter">
          {seriesFilters.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={seriesFilter === candidate}
              onClick={() => startTransition(() => setSeriesFilter(candidate))}
            >
              {candidate}
            </button>
          ))}
        </div>
        <span>Encoding</span>
        <div className="chart-switch" role="group" aria-label="Trend chart mode">
          {(['line', 'bar'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={mode === candidate}
              onClick={() => startTransition(() => setMode(candidate))}
            >
              {candidate === 'line' ? 'Line' : 'Bar'}
            </button>
          ))}
        </div>
      </div>
      <p className="trend-resolution" role="note">
        Showing all {selectedEntries.length} {seriesFilter} configurations in canonical matrix
        order. The family is an explicit filter, not a point-estimate cutoff. Lines connect ordered
        observations only; absent buckets remain gaps. Bars use a zero baseline. Each grouped bar
        and its task-sensitivity interval use the same per-series category offset. The server
        returns at most 20 buckets per configuration and uses the latest exact Official run, not an
        average. Point context requires matching run, configuration, scoring version, and provenance
        identity; absent evidence remains unavailable. Scoring versions:{' '}
        {[...new Set(visible.map((point) => point.scoringVersion))].join(', ') || 'unavailable'}.
      </p>
      {exactJoinUnavailable ? (
        <ReadStateNote
          result={{
            state: 'unavailable',
            detail: EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE,
          }}
          subject="Exact trend run context"
        />
      ) : null}
      <div className={`trend-layout${isPending ? ' is-pending' : ''}`}>
        <div className="chart-frame">
          {visible.length > 0 ? (
            <EChartsChart
              className="trend-chart-echarts"
              option={chartOption}
              label={
                mode === 'bar'
                  ? 'AIQ score history. Grouped bars with per-series aligned task-sensitivity intervals.'
                  : 'AIQ score history. Lines with task-sensitivity intervals.'
              }
            />
          ) : (
            <p>No observations fall in this range.</p>
          )}
        </div>
        <ul className="chart-legend" aria-label="Visible trend series">
          {selectedEntries.map((entry, index) => {
            const series = visible.filter((point) => point.entryId === entry.id);
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
                </small>
              </li>
            );
          })}
        </ul>
      </div>
      <details className="data-disclosure">
        <summary>Read visible trend values as a table</summary>
        <div className="table-scroll" role="region" aria-label="Visible trend values" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                <th scope="col">Series</th>
                <th scope="col">AIQ</th>
                <th scope="col">Task sensitivity</th>
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
              {visible
                .toSorted(
                  (left, right) =>
                    new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime(),
                )
                .map((point) => {
                  const context = scientificContexts.get(point) ?? unavailableTrendContext;
                  return (
                    <tr key={`${point.entryId}-${point.recordedAt}`}>
                      <td>{formatDate(point.recordedAt)}</td>
                      <th scope="row">{point.entryId}</th>
                      <td>{point.score.toFixed(1)}</td>
                      <td>
                        {point.sensitivityLow.toFixed(1)}–{point.sensitivityHigh.toFixed(1)}
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
