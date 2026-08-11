'use client';

import Link from 'next/link';
import { useCallback, useMemo, useRef } from 'react';

import { formatHumanDuration } from '../data/format-duration.ts';
import { pushAnalyticalUrl, useAnalyticalSearchParams } from './analytical-url-state.ts';
import { configurationFrontierKeys } from './configuration-decision.ts';
import { ConfigurationWorkbenchChart } from './configuration-workbench-chart.tsx';
import {
  describeConfigurationCost,
  formatConfigurationCost,
  resolveConfigurationCost,
} from './configuration-cost.ts';
import {
  CONFIGURATION_FAMILIES,
  CONFIGURATION_REASONING_TIERS,
  encodeWorkbenchSelection,
  filterConfigurationWorkbenchRows,
  orderConfigurationWorkbenchRows,
  readConfigurationWorkbenchState,
  summarizeConfigurationWorkbench,
  type ConfigurationWorkbenchView,
} from './configuration-workbench.ts';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';

function formatCost(candidate: ExactEfficiencyRow | null): string {
  return candidate
    ? formatConfigurationCost(resolveConfigurationCost(candidate.row))
    : 'Unavailable';
}

function formatDuration(candidate: ExactEfficiencyRow | null): string {
  const duration = candidate?.row.summedCellAdapterElapsedMs;
  return duration === null || duration === undefined
    ? 'Unavailable'
    : formatHumanDuration(duration);
}

function configurationName(candidate: ExactEfficiencyRow | null): string {
  return candidate
    ? `${candidate.entry.modelFamily} · ${candidate.entry.reasoningTier}`
    : 'Unavailable';
}

function toggleSelection<Value extends string>(
  selection: readonly Value[],
  value: Value,
  allowed: readonly Value[],
): readonly Value[] {
  const selected = new Set(selection);
  if (selected.has(value)) selected.delete(value);
  else selected.add(value);
  return allowed.filter((candidate) => selected.has(candidate));
}

export function ConfigurationWorkbench({ rows }: { rows: readonly ExactEfficiencyRow[] }) {
  const searchParams = useAnalyticalSearchParams();
  const configurationPicker = useRef<HTMLDetailsElement>(null);
  const state = useMemo(
    () => readConfigurationWorkbenchState(searchParams, rows),
    [rows, searchParams],
  );
  const filterQuery = (() => {
    const filters = new URLSearchParams();
    for (const key of [
      'compareFamilies',
      'compareReasoning',
      'compareConfigs',
      'compareCost',
      'compareFrontier',
    ]) {
      const value = searchParams.get(key);
      if (value !== null) filters.set(key, value);
    }
    return filters.toString();
  })();
  const visibleRows = useMemo(() => {
    const filterState = readConfigurationWorkbenchState(new URLSearchParams(filterQuery), rows);
    return filterConfigurationWorkbenchRows(rows, filterState);
  }, [filterQuery, rows]);
  const orderedRows = useMemo(
    () => orderConfigurationWorkbenchRows(visibleRows, state.order),
    [state.order, visibleRows],
  );
  const summary = useMemo(
    () => summarizeConfigurationWorkbench(rows, visibleRows),
    [rows, visibleRows],
  );
  const frontierKeys = useMemo(() => configurationFrontierKeys(rows), [rows]);
  const configurationIds = useMemo(() => rows.map(({ entry }) => entry.id), [rows]);
  const visibleIds = useMemo(
    () => new Set(visibleRows.map(({ entry }) => entry.id)),
    [visibleRows],
  );
  const focusId = state.focusId !== null && visibleIds.has(state.focusId) ? state.focusId : null;

  const updateSelection = useCallback(
    (key: string, selected: readonly string[], allowed: readonly string[]) => {
      pushAnalyticalUrl({ [key]: encodeWorkbenchSelection(selected, allowed), compareFocus: null });
    },
    [],
  );
  const reset = useCallback(() => {
    pushAnalyticalUrl({
      compareFamilies: null,
      compareReasoning: null,
      compareConfigs: null,
      compareCost: null,
      compareFrontier: null,
      compareView: null,
      compareOrder: null,
      compareFocus: null,
    });
  }, []);

  const summaryItems: ReadonlyArray<{
    label: string;
    identity: string;
    value: string;
    onClick: () => void;
    pressed: boolean;
  }> = [
    {
      label: 'Highest AIQ',
      identity: configurationName(summary.highestAbility),
      value: summary.highestAbility
        ? `${summary.highestAbility.entry.score.toFixed(1)} AIQ`
        : 'Unavailable',
      onClick: () =>
        pushAnalyticalUrl({
          compareOrder: null,
          compareFocus: summary.highestAbility?.entry.id ?? null,
        }),
      pressed: state.order === 'ability',
    },
    {
      label: 'Shortest task time',
      identity: configurationName(summary.shortestTime),
      value: formatDuration(summary.shortestTime),
      onClick: () =>
        pushAnalyticalUrl({
          compareOrder: 'time',
          compareView: 'duration',
          compareFocus: summary.shortestTime?.entry.id ?? null,
        }),
      pressed: state.order === 'time' && state.view === 'duration',
    },
    {
      label: 'Lowest cost upper bound',
      identity: configurationName(summary.lowestCost),
      value: formatCost(summary.lowestCost),
      onClick: () =>
        pushAnalyticalUrl({
          compareOrder: 'cost',
          compareView: 'cost',
          compareFocus: summary.lowestCost?.entry.id ?? null,
        }),
      pressed: state.order === 'cost' && state.view === 'cost',
    },
    {
      label: 'Cost evidence',
      identity: `${summary.costComparableCount}/${summary.visibleCount} comparable`,
      value: `${summary.costMeasuredCount} exact · ${summary.costBoundedCount} bounded`,
      onClick: () =>
        pushAnalyticalUrl({
          compareView: 'decision',
          compareFocus: null,
        }),
      pressed: state.view === 'decision',
    },
  ];

  return (
    <section
      className="configuration-workbench"
      id="compare"
      data-workspace-section
      data-nav-section="compare"
      aria-labelledby="configuration-workbench-heading"
    >
      <h2 className="sr-only" id="configuration-workbench-heading">
        Compare configurations
      </h2>
      <p className="sr-only">
        AIQ ranks task outcomes; time and cost remain independent observations.
      </p>

      <div className="workbench-summaries" aria-label="Filtered comparison shortcuts">
        {summaryItems.map((item) => (
          <button
            key={item.label}
            type="button"
            aria-pressed={item.pressed}
            onClick={item.onClick}
            disabled={summary.visibleCount === 0}
          >
            <span>{item.label}</span>
            <strong>{item.identity}</strong>
            <small>{item.value}</small>
          </button>
        ))}
      </div>

      <div className="workbench-filter-bar" aria-label="Comparison filters">
        <fieldset>
          <legend>Model family</legend>
          <div className="workbench-filter-options">
            {CONFIGURATION_FAMILIES.map((family) => (
              <button
                key={family}
                type="button"
                aria-pressed={state.families.includes(family)}
                onClick={() =>
                  updateSelection(
                    'compareFamilies',
                    toggleSelection(state.families, family, CONFIGURATION_FAMILIES),
                    CONFIGURATION_FAMILIES,
                  )
                }
              >
                {family}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Reasoning</legend>
          <div className="workbench-filter-options workbench-filter-options-wide">
            {CONFIGURATION_REASONING_TIERS.map((tier) => (
              <button
                key={tier}
                type="button"
                aria-pressed={state.reasoningTiers.includes(tier)}
                onClick={() =>
                  updateSelection(
                    'compareReasoning',
                    toggleSelection(state.reasoningTiers, tier, CONFIGURATION_REASONING_TIERS),
                    CONFIGURATION_REASONING_TIERS,
                  )
                }
              >
                {tier}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Evidence</legend>
          <div className="workbench-filter-options">
            <button
              type="button"
              aria-pressed={state.costOnly}
              onClick={() =>
                pushAnalyticalUrl({
                  compareCost: state.costOnly ? null : 'estimated',
                  compareFocus: null,
                })
              }
            >
              Exact cost only
            </button>
            <button
              type="button"
              aria-pressed={state.frontierOnly}
              onClick={() =>
                pushAnalyticalUrl({
                  compareFrontier: state.frontierOnly ? null : 'only',
                  compareFocus: null,
                })
              }
            >
              Pareto only
            </button>
          </div>
        </fieldset>
      </div>

      <div className="workbench-selection-row">
        <details ref={configurationPicker} className="workbench-configuration-picker">
          <summary>
            Custom selection · {state.configurationIds.length}/{configurationIds.length}
          </summary>
          <div className="workbench-picker-actions">
            <button
              type="button"
              onClick={() => updateSelection('compareConfigs', configurationIds, configurationIds)}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => {
                updateSelection('compareConfigs', [], configurationIds);
                if (configurationPicker.current) configurationPicker.current.open = false;
              }}
            >
              Clear
            </button>
          </div>
          <div className="workbench-configuration-options">
            {rows.map(({ entry }) => (
              <label key={entry.id}>
                <input
                  type="checkbox"
                  checked={state.configurationIds.includes(entry.id)}
                  onChange={() =>
                    updateSelection(
                      'compareConfigs',
                      toggleSelection(state.configurationIds, entry.id, configurationIds),
                      configurationIds,
                    )
                  }
                />
                <span>
                  {entry.modelFamily} · {entry.reasoningTier}
                </span>
              </label>
            ))}
          </div>
        </details>
        <span className="workbench-filter-result" role="status" aria-live="polite">
          {summary.visibleCount}/{summary.totalCount} configurations visible
        </span>
        <button className="workbench-reset" type="button" onClick={reset}>
          Reset filters
        </button>
      </div>

      {visibleRows.length === 0 ? (
        <div className="workbench-empty" role="status">
          <strong>No configuration matches these filters.</strong>
          <p>Clear a filter or restore the complete 17-configuration matrix.</p>
          <button type="button" onClick={reset}>
            Show all 17
          </button>
        </div>
      ) : (
        <>
          <div className="workbench-view-bar">
            <div className="workbench-view-switch" role="group" aria-label="Comparison view">
              {(
                [
                  ['duration', 'AIQ × time'],
                  ['cost', 'AIQ × cost range'],
                  ['decision', 'Decision map'],
                ] as const satisfies ReadonlyArray<readonly [ConfigurationWorkbenchView, string]>
              ).map(([view, label]) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={state.view === view}
                  onClick={() => pushAnalyticalUrl({ compareView: view, compareFocus: null })}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              <span>Highlight</span>
              <select
                value={focusId ?? ''}
                onChange={(event) =>
                  pushAnalyticalUrl({ compareFocus: event.target.value || null })
                }
              >
                <option value="">None · show all equally</option>
                {visibleRows.map(({ entry }) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.modelFamily} · {entry.reasoningTier}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="workbench-visualization">
            <ConfigurationWorkbenchChart
              allRows={rows}
              rows={visibleRows}
              metric={state.view}
              focusId={focusId}
            />
          </div>

          <div className="workbench-table-heading">
            <div>
              <h3>Filtered configurations</h3>
              <p>Every visible row uses the same filters as the chart above.</p>
            </div>
            <label>
              <span>Order</span>
              <select
                value={state.order}
                onChange={(event) => {
                  const order = event.target.value;
                  if (
                    order !== 'ability' &&
                    order !== 'time' &&
                    order !== 'cost' &&
                    order !== 'family'
                  ) {
                    return;
                  }
                  pushAnalyticalUrl({ compareOrder: order === 'ability' ? null : order });
                }}
              >
                <option value="ability">AIQ · high to low</option>
                <option value="time">Time · low to high</option>
                <option value="cost">Cost upper bound · low to high</option>
                <option value="family">Model family</option>
              </select>
            </label>
          </div>
          <div
            className="workbench-table"
            role="region"
            aria-label="Filtered configuration comparison table"
            tabIndex={0}
          >
            <table>
              <caption className="sr-only">
                Filtered Official configurations. AIQ, time, and cost are separate measures.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Configuration</th>
                  <th scope="col">AIQ</th>
                  <th scope="col">Task time</th>
                  <th scope="col">API-equivalent cost</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {orderedRows.map((candidate) => {
                  const duration = candidate.row.summedCellAdapterElapsedMs;
                  const interval =
                    candidate.entry.scoreCiLow === null || candidate.entry.scoreCiHigh === null
                      ? 'Interval unavailable'
                      : `${candidate.entry.scoreCiLow.toFixed(1)}–${candidate.entry.scoreCiHigh.toFixed(1)} 95% interval`;
                  return (
                    <tr
                      key={candidate.entry.id}
                      data-configuration-id={candidate.entry.id}
                      data-focused={focusId === candidate.entry.id ? 'true' : undefined}
                    >
                      <th scope="row" className="workbench-identity">
                        <button
                          type="button"
                          aria-pressed={focusId === candidate.entry.id}
                          onClick={() =>
                            pushAnalyticalUrl({
                              compareFocus:
                                focusId === candidate.entry.id ? null : candidate.entry.id,
                            })
                          }
                        >
                          {candidate.entry.modelFamily} · {candidate.entry.reasoningTier}
                        </button>
                        <small>
                          {frontierKeys.has(candidate.entry.id)
                            ? 'Pareto frontier'
                            : `${candidate.row.resultCount} task results`}
                        </small>
                      </th>
                      <td className="workbench-metric" data-label="AIQ">
                        <strong>{candidate.entry.score.toFixed(1)}</strong>
                        <small>{interval}</small>
                      </td>
                      <td className="workbench-metric" data-label="Time">
                        <strong>
                          {duration === null ? 'Unavailable' : formatHumanDuration(duration)}
                        </strong>
                        <small>{candidate.row.resultCount}-task sum</small>
                      </td>
                      <td className="workbench-metric" data-label="Cost">
                        <strong>{formatCost(candidate)}</strong>
                        <small>
                          {describeConfigurationCost(resolveConfigurationCost(candidate.row))}
                        </small>
                      </td>
                      <td className="workbench-evidence" data-label="Evidence">
                        <Link href={`/runs/${candidate.row.runId}`}>Official run</Link>
                        <small>{candidate.entry.coveragePercent.toFixed(0)}% coverage</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="workbench-footnote">
            Time is the sum of retained adapter durations across 72 tasks. Cost is a Standard
            API-equivalent evidence is either exact or a conservative published-rate range when
            aggregate task usage cannot identify each long-context request. It is not billed ChatGPT
            subscription spend. Paired Normal/Fast transport measurements appear in the history
            section below and never change AIQ.
          </p>
        </>
      )}
    </section>
  );
}
