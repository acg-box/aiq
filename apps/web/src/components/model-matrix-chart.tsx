'use client';

import { useMemo, useState } from 'react';

import { sortLeaderboardByPointEstimate } from '../data/format.ts';
import type { LeaderboardEntry } from '../data/types.ts';

type ChartKind = 'bars' | 'line';

const chartWidth = 100;
const chartHeight = 56;
const plotLeft = 7;
const plotRight = 98;
const plotTop = 4;
const plotBottom = 44;

function xForIndex(index: number, count: number): number {
  if (count <= 1) return (plotLeft + plotRight) / 2;
  return plotLeft + (index / (count - 1)) * (plotRight - plotLeft);
}

function yForScore(score: number): number {
  return plotBottom - (Math.max(0, Math.min(100, score)) / 100) * (plotBottom - plotTop);
}

function shortLabel(entry: LeaderboardEntry): string {
  return `${entry.modelFamily.slice(0, 1)}·${entry.reasoningTier}`;
}

function familyColor(entry: LeaderboardEntry): string {
  if (entry.modelFamily === 'Sol') return 'var(--acid)';
  if (entry.modelFamily === 'Terra') return 'var(--coral)';
  return 'var(--blue)';
}

export function ModelMatrixChart({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const [kind, setKind] = useState<ChartKind>('bars');
  const scored = useMemo(
    () => sortLeaderboardByPointEstimate(entries).filter((entry) => entry.score !== null),
    [entries],
  );

  if (scored.length === 0) {
    return <p className="empty-note">No scored configurations are available in this range.</p>;
  }

  const line = scored
    .map((entry, index) => {
      const x = xForIndex(index, scored.length);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${yForScore(entry.score ?? 0).toFixed(2)}`;
    })
    .join(' ');

  return (
    <section className="matrix-chart" aria-labelledby="matrix-chart-heading">
      <header className="chart-header">
        <div>
          <span className="eyebrow">At a glance</span>
          <h3 id="matrix-chart-heading">AIQ index by configuration</h3>
          <p>Equal-weight domain index on a 0–100 scale. It is not an IQ estimate.</p>
        </div>
        <div className="chart-switch" role="group" aria-label="Chart type">
          {(['bars', 'line'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={kind === candidate}
              onClick={() => setKind(candidate)}
            >
              {candidate === 'bars' ? 'Bars' : 'Line'}
            </button>
          ))}
        </div>
      </header>
      <div className="matrix-chart-frame">
        <svg
          className="matrix-chart-svg"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="img"
          aria-labelledby="matrix-chart-title matrix-chart-description"
        >
          <title id="matrix-chart-title">AIQ index by model and reasoning configuration</title>
          <desc id="matrix-chart-description">
            {`${kind === 'bars' ? 'Bars' : 'A line'} compare the descriptive AIQ index for ${scored.length} published configurations. Higher values indicate more credit on this ${scored[0]?.scoringVersion ?? 'versioned'} fixed fixture.`}
          </desc>
          {[0, 25, 50, 75, 100].map((tick) => {
            const y = yForScore(tick);
            return (
              <g className="matrix-chart-axis" key={tick}>
                <line x1={plotLeft} x2={plotRight} y1={y} y2={y} />
                <text x={plotLeft - 1} y={y + 1.2} textAnchor="end">
                  {tick}
                </text>
              </g>
            );
          })}
          {kind === 'line' ? (
            <path className="matrix-chart-line" d={line} />
          ) : (
            scored.map((entry, index) => {
              const x = xForIndex(index, scored.length);
              const score = entry.score ?? 0;
              const y = yForScore(score);
              const width = Math.max(
                1.5,
                Math.min(4.4, (plotRight - plotLeft) / scored.length - 0.8),
              );
              return (
                <rect
                  key={entry.id}
                  x={x - width / 2}
                  y={y}
                  width={width}
                  height={plotBottom - y}
                  rx="0.5"
                  style={{ fill: familyColor(entry) }}
                >
                  <title>{`${entry.modelFamily} · ${entry.reasoningTier}: ${score.toFixed(1)} AIQ index`}</title>
                </rect>
              );
            })
          )}
          {kind === 'line'
            ? scored.map((entry, index) => {
                const x = xForIndex(index, scored.length);
                const y = yForScore(entry.score ?? 0);
                return (
                  <circle key={entry.id} cx={x} cy={y} r="1.4" style={{ fill: familyColor(entry) }}>
                    <title>{`${entry.modelFamily} · ${entry.reasoningTier}: ${(entry.score ?? 0).toFixed(1)} AIQ index`}</title>
                  </circle>
                );
              })
            : null}
          {scored.map((entry, index) => {
            const x = xForIndex(index, scored.length);
            return (
              <text
                className="matrix-chart-label"
                key={`${entry.id}-label`}
                x={x}
                y={plotBottom + 7}
                textAnchor="end"
                transform={`rotate(-48 ${x} ${plotBottom + 7})`}
              >
                {shortLabel(entry)}
              </text>
            );
          })}
        </svg>
      </div>
      <details className="chart-data-disclosure">
        <summary>Read the 17 configuration values</summary>
        <div className="table-scroll" tabIndex={0}>
          <table>
            <caption>Descriptive AIQ index values, highest first.</caption>
            <thead>
              <tr>
                <th scope="col">Configuration</th>
                <th scope="col">AIQ index</th>
                <th scope="col">Task sensitivity</th>
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
