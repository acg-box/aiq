'use client';

import { useMemo, useState, useTransition } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import { sortLeaderboardByPointEstimate } from '../data/format.ts';
import {
  isScoredLeaderboardEntry,
  type LeaderboardEntry,
  type ModelFamily,
} from '../data/types.ts';
import { EChartsChart } from './echarts-chart.tsx';

type ChartKind = 'bars' | 'dots' | 'ordered';
type FamilyFilter = 'All' | ModelFamily;

const families: readonly FamilyFilter[] = ['All', 'Sol', 'Terra', 'Luna'];

function shortLabel(entry: LeaderboardEntry): string {
  return `${entry.modelFamily.slice(0, 1)}·${entry.reasoningTier}`;
}

function familyColor(entry: LeaderboardEntry): string {
  if (entry.modelFamily === 'Sol') return 'var(--data-lime)';
  if (entry.modelFamily === 'Terra') return 'var(--data-cyan)';
  return 'var(--data-violet)';
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function readTooltipDataIndex(value: unknown): number | null {
  const item: unknown = isUnknownArray(value) ? value[0] : value;
  if (typeof item !== 'object' || item === null || !('dataIndex' in item)) return null;
  return typeof item.dataIndex === 'number' ? item.dataIndex : null;
}

export function ModelMatrixChart({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const [kind, setKind] = useState<ChartKind>('dots');
  const [family, setFamily] = useState<FamilyFilter>('All');
  const [isPending, startTransition] = useTransition();
  const scored = useMemo(
    () =>
      sortLeaderboardByPointEstimate(entries).filter(
        (entry) =>
          isScoredLeaderboardEntry(entry) && (family === 'All' || entry.modelFamily === family),
      ),
    [entries, family],
  );
  const option = useMemo<EChartsCoreOption>(() => {
    const labels = scored.map(shortLabel);
    const values = scored.map((entry) => ({
      value: entry.score ?? 0,
      itemStyle: { color: familyColor(entry) },
    }));
    const tooltip = {
      trigger: 'axis' as const,
      formatter: (value: unknown) => {
        const index = readTooltipDataIndex(value);
        if (index === null) return 'Configuration evidence unavailable';
        const entry = scored[index];
        if (!entry) return '';
        return `${entry.modelFamily} · ${entry.reasoningTier}<br/>AIQ ${entry.score?.toFixed(1)} · interval ${entry.ciLow?.toFixed(1)}–${entry.ciHigh?.toFixed(1)}<br/>n=${entry.sampleSize ?? '—'} · coverage ${entry.coveragePercent?.toFixed(1) ?? '—'}%<br/>runtime ${entry.runtimeIssues ?? '—'} · missing ${entry.missing ?? '—'}<br/>scoring ${entry.scoringVersion ?? '—'} · ${entry.synthetic ? 'synthetic' : 'published'}`;
      },
    };
    const aria = { enabled: true, decal: { show: true } };
    const verticalIntervalSeries = {
      type: 'custom',
      name: 'Task-sensitivity interval',
      silent: true,
      z: 4,
      data: scored.map((entry, index) => [index, entry.ciLow, entry.ciHigh]),
      renderItem: (
        _params: unknown,
        api: {
          value: (dimension: number) => number;
          coord: (value: readonly number[]) => readonly [number, number];
          style: (style: Record<string, unknown>) => Record<string, unknown>;
        },
      ) => {
        const index = api.value(0);
        const low = api.coord([index, api.value(1)]);
        const high = api.coord([index, api.value(2)]);
        return {
          type: 'group',
          children: [
            {
              type: 'line',
              shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] },
              style: api.style({ stroke: 'var(--interval)', lineWidth: 1.5 }),
            },
            {
              type: 'line',
              shape: { x1: low[0] - 4, y1: low[1], x2: low[0] + 4, y2: low[1] },
              style: api.style({ stroke: 'var(--interval)', lineWidth: 1.5 }),
            },
            {
              type: 'line',
              shape: { x1: high[0] - 4, y1: high[1], x2: high[0] + 4, y2: high[1] },
              style: api.style({ stroke: 'var(--interval)', lineWidth: 1.5 }),
            },
          ],
        };
      },
    };
    if (kind === 'ordered') {
      return {
        aria,
        grid: { left: 96, right: 30, top: 20, bottom: 50 },
        tooltip,
        xAxis: {
          type: 'value',
          min: 0,
          max: 100,
          name: 'AIQ index (0–100)',
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
          data: labels,
          name: 'Configuration',
          axisLabel: { color: 'var(--muted)', fontSize: 10 },
          nameTextStyle: { color: 'var(--muted)' },
          axisLine: { lineStyle: { color: 'var(--line-bright)' } },
        },
        series: [
          { type: 'bar', name: 'Point estimate', data: values, barMaxWidth: 18 },
          {
            type: 'custom',
            name: 'Task-sensitivity interval',
            silent: true,
            z: 4,
            data: scored.map((entry, index) => [entry.ciLow, index, entry.ciHigh]),
            renderItem: (
              _params: unknown,
              api: {
                value: (dimension: number) => number;
                coord: (value: readonly number[]) => readonly [number, number];
                style: (style: Record<string, unknown>) => Record<string, unknown>;
              },
            ) => {
              const index = api.value(1);
              const low = api.coord([api.value(0), index]);
              const high = api.coord([api.value(2), index]);
              return {
                type: 'group',
                children: [
                  {
                    type: 'line',
                    shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] },
                    style: api.style({ stroke: 'var(--interval)', lineWidth: 1.5 }),
                  },
                  {
                    type: 'line',
                    shape: { x1: low[0], y1: low[1] - 4, x2: low[0], y2: low[1] + 4 },
                    style: api.style({ stroke: 'var(--interval)', lineWidth: 1.5 }),
                  },
                  {
                    type: 'line',
                    shape: { x1: high[0], y1: high[1] - 4, x2: high[0], y2: high[1] + 4 },
                    style: api.style({ stroke: 'var(--interval)', lineWidth: 1.5 }),
                  },
                ],
              };
            },
          },
        ],
      };
    }
    const base = {
      aria,
      grid: { left: 48, right: 18, top: 20, bottom: 70 },
      tooltip,
      xAxis: {
        type: 'category' as const,
        data: labels,
        name: 'Model · reasoning configuration',
        nameLocation: 'middle' as const,
        nameGap: 52,
        axisLabel: { color: 'var(--muted)', rotate: 42, interval: 0, fontSize: 10 },
        nameTextStyle: { color: 'var(--muted)' },
        axisLine: { lineStyle: { color: 'var(--line-bright)' } },
      },
      yAxis: {
        type: 'value' as const,
        min: 0,
        max: 100,
        name: 'AIQ index (0–100)',
        nameLocation: 'middle' as const,
        nameGap: 34,
        axisLabel: { color: 'var(--muted)' },
        nameTextStyle: { color: 'var(--muted)' },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
    };
    return {
      ...base,
      series:
        kind === 'dots'
          ? [
              verticalIntervalSeries,
              { type: 'scatter', name: 'Point estimate', symbolSize: 11, data: values },
            ]
          : [
              { type: 'bar', name: 'Point estimate', data: values, barMaxWidth: 34 },
              verticalIntervalSeries,
            ],
    };
  }, [kind, scored]);

  return (
    <section
      className={`matrix-chart${isPending ? ' is-pending' : ''}`}
      aria-labelledby="matrix-chart-heading"
    >
      <header className="chart-header">
        <div>
          <span className="eyebrow">Current matrix</span>
          <h3 id="matrix-chart-heading">AIQ index by configuration</h3>
          <p>Point estimates and fixed-fixture task-sensitivity intervals stay visible together.</p>
        </div>
        <div className="chart-controls">
          <div className="chart-switch" role="group" aria-label="Model family">
            {families.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={family === candidate}
                onClick={() => startTransition(() => setFamily(candidate))}
              >
                {candidate}
              </button>
            ))}
          </div>
          <div className="chart-switch" role="group" aria-label="Chart type">
            {(['dots', 'bars', 'ordered'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={kind === candidate}
                onClick={() => startTransition(() => setKind(candidate))}
              >
                {candidate === 'bars'
                  ? 'Bars + interval'
                  : candidate === 'dots'
                    ? 'Dot + interval'
                    : 'Ordered + interval'}
              </button>
            ))}
          </div>
        </div>
      </header>
      <p className="sr-only" aria-live="polite">
        Showing {scored.length} {family === 'All' ? '' : family} configurations as {kind}.
      </p>
      {scored.length === 0 ? (
        <p className="empty-note">No scored configurations are available for this filter.</p>
      ) : (
        <div className="matrix-chart-frame">
          <EChartsChart
            className="matrix-chart-svg"
            option={option}
            label={`${kind === 'dots' ? 'Dots' : kind === 'bars' ? 'Zero-baseline bars' : 'Ordered horizontal bars'} with task-sensitivity intervals compare AIQ for ${scored.length} configurations; scoring versions ${[...new Set(scored.map((entry) => entry.scoringVersion))].join(', ') || 'unavailable'}.`}
          />
        </div>
      )}
      <details className="chart-data-disclosure">
        <summary>Read {scored.length} configuration values</summary>
        <div className="table-scroll" tabIndex={0}>
          <table>
            <caption>Descriptive AIQ index values, highest point estimate first.</caption>
            <thead>
              <tr>
                <th scope="col">Configuration</th>
                <th scope="col">AIQ index</th>
                <th scope="col">Task sensitivity</th>
                <th scope="col">n</th>
                <th scope="col">Coverage</th>
                <th scope="col">Runtime</th>
                <th scope="col">Missing</th>
                <th scope="col">Scoring</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {scored.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    {entry.modelFamily} · {entry.reasoningTier}
                  </th>
                  <td>{entry.score?.toFixed(1)}</td>
                  <td>
                    {entry.ciLow?.toFixed(1)}–{entry.ciHigh?.toFixed(1)}
                  </td>
                  <td>{entry.sampleSize ?? '—'}</td>
                  <td>{entry.coveragePercent?.toFixed(1)}%</td>
                  <td>{entry.runtimeIssues ?? '—'}</td>
                  <td>{entry.missing ?? '—'}</td>
                  <td>{entry.scoringVersion ?? '—'}</td>
                  <td>{entry.synthetic ? 'Synthetic' : 'Published'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
