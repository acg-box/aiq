'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { formatHumanDuration } from '../data/format-duration.ts';
import {
  orderConfigurationDecisions,
  summarizeConfigurationDecisions,
  type ConfigurationPriority,
} from './configuration-decision.ts';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';

const collapsedRowCount = 6;
const costStatusLabels = {
  estimated: 'Standard API estimate',
  unavailable_missing_usage: 'Token usage unavailable',
  unavailable_invalid_usage: 'Usage evidence invalid',
  unavailable_context_band: 'Outside the published price range',
} as const satisfies Readonly<Record<ExactEfficiencyRow['row']['costEstimatorStatus'], string>>;

function configurationName(candidate: ExactEfficiencyRow | null): string {
  return candidate
    ? `${candidate.entry.modelFamily} · ${candidate.entry.reasoningTier}`
    : 'Unavailable';
}

function formatCost(candidate: ExactEfficiencyRow | null): string {
  const nanos = candidate?.row.standardApiEquivalentUsdNanos;
  if (candidate?.row.costEstimatorStatus !== 'estimated' || nanos === null || nanos === undefined) {
    return 'Unavailable';
  }
  const dollars = nanos / 1_000_000_000;
  return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
}

function formatDuration(candidate: ExactEfficiencyRow | null): string {
  const duration = candidate?.row.summedCellAdapterElapsedMs;
  return duration === null || duration === undefined
    ? 'Unavailable'
    : formatHumanDuration(duration);
}

function costStatusLabel(candidate: ExactEfficiencyRow): string {
  return costStatusLabels[candidate.row.costEstimatorStatus];
}

function compareHref(candidate: ExactEfficiencyRow, rows: readonly ExactEfficiencyRow[]): string {
  const comparison = rows.find((row) => row.entry.id !== candidate.entry.id);
  return comparison
    ? `/?compareFirst=${encodeURIComponent(candidate.entry.id)}&compareSecond=${encodeURIComponent(comparison.entry.id)}#compare`
    : '/#compare';
}

function rowLabel(
  candidate: ExactEfficiencyRow,
  priority: ConfigurationPriority,
  summary: ReturnType<typeof summarizeConfigurationDecisions>,
): string {
  if (priority === 'time' && summary.shortestTime?.entry.id === candidate.entry.id)
    return 'Fastest';
  if (priority === 'cost' && summary.lowestCost?.entry.id === candidate.entry.id) {
    return 'Lowest cost';
  }
  if (priority === 'frontier') return 'Trade-off frontier';
  if (summary.highestAbility?.entry.id === candidate.entry.id) return 'Highest AIQ';
  if (summary.frontierKeys.has(candidate.entry.id)) return 'Trade-off frontier';
  return `${candidate.row.resultCount} task results`;
}

export function ConfigurationDecisionTable({ rows }: { rows: readonly ExactEfficiencyRow[] }) {
  const [priority, setPriority] = useState<ConfigurationPriority>('ability');
  const [showAll, setShowAll] = useState(false);
  const summary = useMemo(() => summarizeConfigurationDecisions(rows), [rows]);
  const ordered = useMemo(() => orderConfigurationDecisions(rows, priority), [priority, rows]);
  const visibleRows =
    priority === 'frontier' || showAll ? ordered : ordered.slice(0, collapsedRowCount);
  const canExpand = priority !== 'frontier' && ordered.length > collapsedRowCount;
  const summaries: ReadonlyArray<{
    priority: ConfigurationPriority;
    label: string;
    identity: string;
    value: string;
  }> = [
    {
      priority: 'ability',
      label: 'Highest ability',
      identity: configurationName(summary.highestAbility),
      value: summary.highestAbility
        ? `${summary.highestAbility.entry.score.toFixed(1)} AIQ`
        : 'Unavailable',
    },
    {
      priority: 'time',
      label: 'Shortest task time',
      identity: configurationName(summary.shortestTime),
      value: formatDuration(summary.shortestTime),
    },
    {
      priority: 'cost',
      label: 'Lowest estimated cost',
      identity: configurationName(summary.lowestCost),
      value: formatCost(summary.lowestCost),
    },
    {
      priority: 'frontier',
      label: 'Efficient trade-offs',
      identity: `${summary.frontierKeys.size} of ${summary.fullyMeasuredCount} measured`,
      value: 'Not dominated on AIQ, time, and cost',
    },
  ];

  return (
    <section className="configuration-decision" aria-labelledby="configuration-decision-heading">
      <header className="decision-heading">
        <div>
          <span className="eyebrow">Configuration chooser</span>
          <h2 id="configuration-decision-heading">Choose by ability, time, or cost.</h2>
        </div>
        <p>
          AIQ measures task performance only. Time and Standard API-equivalent cost are separate
          observations, never score inputs.
        </p>
      </header>

      <div className="decision-priorities" role="group" aria-label="Choose a comparison priority">
        {summaries.map((item) => (
          <button
            key={item.priority}
            type="button"
            aria-pressed={priority === item.priority}
            onClick={() => {
              setPriority(item.priority);
              setShowAll(false);
            }}
          >
            <span>{item.label}</span>
            <strong>{item.identity}</strong>
            <small>{item.value}</small>
          </button>
        ))}
      </div>

      <div
        className="decision-table"
        role="region"
        aria-label="Configuration decision table"
        tabIndex={0}
      >
        <table>
          <caption className="sr-only">
            Official configurations ordered by the selected comparison priority. Time and cost do
            not affect AIQ.
          </caption>
          <thead>
            <tr>
              <th scope="col">Configuration</th>
              <th scope="col">AIQ</th>
              <th scope="col">Task time</th>
              <th scope="col">API-equivalent cost</th>
              <th scope="col" aria-label="Comparison action" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((candidate) => {
              const href = compareHref(candidate, ordered);
              const interval =
                candidate.entry.scoreCiLow === null || candidate.entry.scoreCiHigh === null
                  ? 'Interval unavailable'
                  : `${candidate.entry.scoreCiLow.toFixed(1)}–${candidate.entry.scoreCiHigh.toFixed(1)} 95% interval`;
              const duration = candidate.row.summedCellAdapterElapsedMs;
              return (
                <tr key={candidate.entry.id} data-configuration-id={candidate.entry.id}>
                  <th scope="row" className="decision-identity">
                    <Link href={href}>
                      {candidate.entry.modelFamily} · {candidate.entry.reasoningTier}
                    </Link>
                    <small>{rowLabel(candidate, priority, summary)}</small>
                  </th>
                  <td className="decision-metric" data-label="AIQ">
                    <strong>{candidate.entry.score.toFixed(1)}</strong>
                    <small>{interval}</small>
                  </td>
                  <td className="decision-metric" data-label="Time">
                    <strong>
                      {duration === null ? 'Unavailable' : formatHumanDuration(duration)}
                    </strong>
                    <small>{candidate.row.resultCount}-task sum</small>
                  </td>
                  <td className="decision-metric" data-label="Cost">
                    <strong>
                      {candidate.row.costEstimatorStatus === 'estimated'
                        ? formatCost(candidate)
                        : 'Not estimated'}
                    </strong>
                    <small>{costStatusLabel(candidate)}</small>
                  </td>
                  <td className="decision-action">
                    <Link className="quiet-button" href={href}>
                      Compare
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="decision-footer">
        <p>
          Task time is the sum of retained adapter durations across the fixed 72-task form. No
          paired Fast-mode evidence is published, so Fast is not shown.
        </p>
        {canExpand ? (
          <button type="button" onClick={() => setShowAll((value) => !value)}>
            {showAll ? 'Show the top 6' : `Show all ${ordered.length}`}
          </button>
        ) : null}
      </footer>
    </section>
  );
}
