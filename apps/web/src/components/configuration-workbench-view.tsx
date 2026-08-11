'use client';

import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretUpIcon } from '@phosphor-icons/react/dist/csr/CaretUp';
import { CaretUpDownIcon } from '@phosphor-icons/react/dist/csr/CaretUpDown';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

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
  defaultWorkbenchDirection,
  encodeWorkbenchSelection,
  filterConfigurationWorkbenchRows,
  orderConfigurationWorkbenchRows,
  readConfigurationWorkbenchState,
  summarizeConfigurationWorkbench,
  type ConfigurationWorkbenchOrder,
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

function configurationMetrics(
  candidate: ExactEfficiencyRow | null,
  lead: 'ability' | 'cost' | 'time' = 'ability',
): string {
  if (!candidate) return 'Evidence unavailable';
  const metrics = {
    ability: `${candidate.entry.score.toFixed(1)} AIQ`,
    cost: formatCost(candidate),
    time: formatDuration(candidate),
  };
  const order =
    lead === 'ability'
      ? (['ability', 'time', 'cost'] as const)
      : lead === 'time'
        ? (['time', 'ability', 'cost'] as const)
        : (['cost', 'ability', 'time'] as const);
  return order.map((metric) => metrics[metric]).join(' · ');
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchParams = useAnalyticalSearchParams();
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
    () => orderConfigurationWorkbenchRows(visibleRows, state.order, state.direction),
    [state.direction, state.order, visibleRows],
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
  const visibleRowsByIdentity = useMemo(
    () =>
      new Map(
        visibleRows.map((candidate) => [
          `${candidate.entry.modelFamily}:${candidate.entry.reasoningTier}`,
          candidate,
        ]),
      ),
    [visibleRows],
  );
  const allRowsByIdentity = useMemo(
    () =>
      new Map(
        rows.map((candidate) => [
          `${candidate.entry.modelFamily}:${candidate.entry.reasoningTier}`,
          candidate,
        ]),
      ),
    [rows],
  );
  const focusId = state.focusId !== null && visibleIds.has(state.focusId) ? state.focusId : null;
  const focusedRow = visibleRows.find(({ entry }) => entry.id === focusId) ?? null;
  const hasActiveFilters =
    state.families.length !== CONFIGURATION_FAMILIES.length ||
    state.reasoningTiers.length !== CONFIGURATION_REASONING_TIERS.length ||
    state.configurationIds.length !== configurationIds.length ||
    state.costOnly ||
    state.frontierOnly;

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
      compareDirection: null,
      compareFocus: null,
    });
  }, []);
  const updateFocus = useCallback((configurationId: string | null) => {
    pushAnalyticalUrl({ compareFocus: configurationId });
  }, []);
  const updateOrder = useCallback(
    (order: ConfigurationWorkbenchOrder) => {
      const direction =
        state.order === order
          ? state.direction === 'asc'
            ? 'desc'
            : 'asc'
          : defaultWorkbenchDirection(order);
      pushAnalyticalUrl({
        compareOrder: order === 'ability' ? null : order,
        compareDirection: direction === defaultWorkbenchDirection(order) ? null : direction,
      });
    },
    [state.direction, state.order],
  );
  const sortHeader = (order: ConfigurationWorkbenchOrder, label: string) => {
    const active = state.order === order;
    const direction = active ? state.direction : null;
    const SortIcon =
      direction === 'asc' ? CaretUpIcon : direction === 'desc' ? CaretDownIcon : CaretUpDownIcon;
    return (
      <th
        scope="col"
        aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
      >
        <button
          type="button"
          aria-label={
            direction === null
              ? `Sort by ${label}`
              : `${label}, sorted ${direction === 'asc' ? 'ascending' : 'descending'}; activate to reverse`
          }
          onClick={() => updateOrder(order)}
        >
          <span>{label}</span>
          <SortIcon aria-hidden="true" size={14} weight="bold" />
        </button>
      </th>
    );
  };

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
      value: configurationMetrics(summary.highestAbility),
      onClick: () =>
        pushAnalyticalUrl({
          compareOrder: null,
          compareDirection: null,
          compareFocus: summary.highestAbility?.entry.id ?? null,
        }),
      pressed: state.order === 'ability' && state.direction === 'desc',
    },
    {
      label: 'Lowest task-time total',
      identity: configurationName(summary.shortestTime),
      value: configurationMetrics(summary.shortestTime, 'time'),
      onClick: () =>
        pushAnalyticalUrl({
          compareOrder: 'time',
          compareDirection: null,
          compareView: 'duration',
          compareFocus: summary.shortestTime?.entry.id ?? null,
        }),
      pressed: state.order === 'time' && state.direction === 'asc' && state.view === 'duration',
    },
    {
      label: 'Lowest API-equivalent cost',
      identity: configurationName(summary.lowestCost),
      value: configurationMetrics(summary.lowestCost, 'cost'),
      onClick: () =>
        pushAnalyticalUrl({
          compareOrder: 'cost',
          compareDirection: null,
          compareView: 'cost',
          compareFocus: summary.lowestCost?.entry.id ?? null,
        }),
      pressed: state.order === 'cost' && state.direction === 'asc' && state.view === 'cost',
    },
    {
      label: 'Trade-off shortlist',
      identity: `${summary.visibleFrontierCount} options`,
      value: 'No other option is better on AIQ, time, and cost',
      onClick: () =>
        pushAnalyticalUrl({
          compareFrontier: 'only',
          compareView: 'decision',
          compareFocus: null,
        }),
      pressed: state.frontierOnly && state.view === 'decision',
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

      <button
        className="workbench-filter-toggle"
        type="button"
        aria-expanded={filtersOpen}
        aria-controls="workbench-filter-content"
        onClick={() => setFiltersOpen((open) => !open)}
      >
        <span>
          <strong>Filters & configurations</strong>
          <small role="status" aria-live="polite">
            {summary.visibleCount}/{summary.totalCount} visible
            {hasActiveFilters ? ' · filtered' : ''}
          </small>
        </span>
        {filtersOpen ? (
          <CaretUpIcon aria-hidden="true" size={16} weight="bold" />
        ) : (
          <CaretDownIcon aria-hidden="true" size={16} weight="bold" />
        )}
      </button>

      <div
        className="workbench-filter-content"
        id="workbench-filter-content"
        data-open={filtersOpen ? 'true' : 'false'}
      >
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
          <div className="workbench-selection-heading">
            <div>
              <span className="workbench-control-label">Configurations</span>
              <span className="workbench-filter-result" role="status" aria-live="polite">
                {state.configurationIds.length}/{configurationIds.length} selected ·{' '}
                {summary.visibleCount}/{summary.totalCount} configurations visible
              </span>
            </div>
            <div className="workbench-picker-actions">
              <button
                type="button"
                onClick={() =>
                  updateSelection('compareConfigs', configurationIds, configurationIds)
                }
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => updateSelection('compareConfigs', [], configurationIds)}
              >
                Clear
              </button>
              <button className="workbench-reset" type="button" onClick={reset}>
                Reset filters
              </button>
            </div>
          </div>
          <div
            className="workbench-configuration-options"
            role="group"
            aria-label="Configuration selection"
          >
            {CONFIGURATION_FAMILIES.map((family) => (
              <div className="workbench-configuration-row" key={family}>
                <span className="workbench-configuration-family">{family}</span>
                <div role="group" aria-label={`${family} configurations`}>
                  {rows
                    .filter(({ entry }) => entry.modelFamily === family)
                    .toSorted(
                      (left, right) =>
                        CONFIGURATION_REASONING_TIERS.indexOf(left.entry.reasoningTier) -
                        CONFIGURATION_REASONING_TIERS.indexOf(right.entry.reasoningTier),
                    )
                    .map(({ entry }) => (
                      <button
                        key={entry.id}
                        type="button"
                        aria-label={`${entry.modelFamily} ${entry.reasoningTier} configuration`}
                        aria-pressed={state.configurationIds.includes(entry.id)}
                        onClick={() =>
                          updateSelection(
                            'compareConfigs',
                            toggleSelection(state.configurationIds, entry.id, configurationIds),
                            configurationIds,
                          )
                        }
                      >
                        {entry.reasoningTier}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
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
            <div className="workbench-focus-status" aria-live="polite">
              <span>
                {focusedRow
                  ? `Selected: ${focusedRow.entry.modelFamily} · ${focusedRow.entry.reasoningTier}`
                  : state.view === 'decision'
                    ? summary.costComparableCount === summary.visibleCount
                      ? 'Select a point · bubble area shows cost'
                      : 'Select a point · hollow means cost unavailable'
                    : 'Select a point or row for details'}
              </span>
              {focusedRow ? (
                <button type="button" onClick={() => updateFocus(null)}>
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <div className="workbench-analysis-grid">
            <section
              className="workbench-at-a-glance"
              aria-labelledby="workbench-at-a-glance-heading"
            >
              <header>
                <h3 id="workbench-at-a-glance-heading">At a glance</h3>
                <p>AIQ first · task time and cost below</p>
              </header>
              <div className="workbench-at-a-glance-scroll" tabIndex={0}>
                <table>
                  <caption className="sr-only">
                    Visible configurations arranged by model family and reasoning level. Each cell
                    shows AIQ, task time, and API-equivalent cost.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      {CONFIGURATION_REASONING_TIERS.map((tier) => (
                        <th scope="col" key={tier}>
                          {tier}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {CONFIGURATION_FAMILIES.map((family) => (
                      <tr key={family}>
                        <th scope="row">{family}</th>
                        {CONFIGURATION_REASONING_TIERS.map((tier) => {
                          const identity = `${family}:${tier}`;
                          const candidate = visibleRowsByIdentity.get(identity);
                          const available = allRowsByIdentity.has(identity);
                          if (!candidate) {
                            return (
                              <td
                                className="workbench-at-a-glance-empty"
                                data-filtered={available ? 'true' : undefined}
                                key={tier}
                              >
                                <span aria-hidden="true">{available ? 'filtered' : '—'}</span>
                                <span className="sr-only">
                                  {available
                                    ? `${family} ${tier} is filtered out`
                                    : `${family} ${tier} is not in the benchmark matrix`}
                                </span>
                              </td>
                            );
                          }
                          return (
                            <td key={tier}>
                              <button
                                type="button"
                                aria-label={`${family} ${tier}: ${configurationMetrics(candidate)}${frontierKeys.has(candidate.entry.id) ? '; trade-off option' : ''}`}
                                aria-pressed={focusId === candidate.entry.id}
                                onClick={() =>
                                  updateFocus(
                                    focusId === candidate.entry.id ? null : candidate.entry.id,
                                  )
                                }
                              >
                                <strong>{candidate.entry.score.toFixed(1)}</strong>
                                <span>{formatDuration(candidate)}</span>
                                <small>{formatCost(candidate)}</small>
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="workbench-at-a-glance-note">
                {summary.visibleCount}/{summary.totalCount} visible · click a cell to focus the
                chart and detailed table
              </p>
            </section>

            <div className="workbench-visualization">
              <ConfigurationWorkbenchChart
                allRows={rows}
                rows={visibleRows}
                metric={state.view}
                focusId={focusId}
                onFocusChange={updateFocus}
              />
            </div>
          </div>

          <div className="workbench-table-heading">
            <h3>Filtered configurations</h3>
            <p>Click a column heading to sort. Click a configuration to focus it in the chart.</p>
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
                  {sortHeader('family', 'Configuration')}
                  {sortHeader('ability', 'AIQ')}
                  {sortHeader('time', 'Task time')}
                  {sortHeader('cost', 'API-equivalent cost')}
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
                            ? 'Trade-off option'
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
            Time is the sum of retained adapter durations across 72 tasks. Standard API-equivalent
            cost evidence is either exact or a conservative published-rate range when aggregate task
            usage cannot identify each long-context request. It is not billed ChatGPT subscription
            spend. Paired Normal/Fast transport measurements appear in the history section below and
            never change AIQ.
          </p>
        </>
      )}
    </section>
  );
}
