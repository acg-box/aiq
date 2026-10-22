'use client';

import { useId } from 'react';
import { comparisonColor } from '../data/comparison-palette.ts';
import { EvidenceDrawer } from './evidence-drawer.tsx';
import { ExpandableTableRow, RowDetailContext, TableRowFacts } from './expandable-table-row.tsx';
import { TableColumnHeading } from './table-column-heading.tsx';
import { useWorkspaceQuery } from './workspace-query.ts';
import { alphabetical } from '../display-order.ts';
import { formatMetric } from '../studies/format.ts';
import type { ComparisonGroup, MetricValue, Subject } from '../studies/types.ts';

export type StudySources = Record<string, { href: string; path: string }>;

const metricLabels: Record<string, { label: string; detail: string }> = {
  bound: { label: 'Complete', detail: '+ bound answers' },
  complete: { label: 'Complete', detail: 'answers' },
  quotes: { label: 'Quotes', detail: 'matched' },
  time: { label: 'Time', detail: 's · mean' },
  cost: { label: 'Cost', detail: 'USD total' },
  samples: { label: 'Inputs', detail: 'per profile' },
  atoms: { label: 'Atoms', detail: 'count' },
  json: { label: 'JSON', detail: 'outputs' },
};

function numeric(value: MetricValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && value.total > 0) return value.pass / value.total;
  return null;
}

function version(subject: Subject | undefined): string {
  const value = subject?.configuration.version ?? subject?.configuration.model;
  if (!value) return '';
  return /^[a-f0-9]{40}$/.test(value) ? value.slice(0, 7) : value.replace(/^[^/]+\//, '');
}

function StudyResultEvidence({
  group,
  subjects,
  selectedRunId,
  source,
}: {
  group: ComparisonGroup;
  subjects: Subject[];
  selectedRunId: string;
  source: StudySources[string] | undefined;
}) {
  const run = group.runs.find((candidate) => candidate.id === selectedRunId);
  const selected = group.results.find((candidate) => candidate.runId === selectedRunId);
  const subject = subjects.find((candidate) => candidate.id === run?.subjectId);
  const comparisonKeys = group.metrics.some((metric) => metric.key === 'bound')
    ? ['bound', 'cost']
    : ['cost', 'time'];
  const metrics = group.metrics.filter((metric) => comparisonKeys.includes(metric.key));
  const rows = alphabetical(
    group.results,
    (result) =>
      subjects.find(
        (item) =>
          item.id === group.runs.find((candidate) => candidate.id === result.runId)?.subjectId,
      )?.label ?? result.runId,
  );
  return (
    <>
      <p className="evidence-context">
        {group.title} · {run?.sampleSize ?? 'Unknown'} inputs per profile
      </p>
      <div className="evidence-comparison-grid" role="table" aria-label="Same-test comparison">
        <div className="evidence-comparison-row evidence-comparison-head" role="row">
          <div role="columnheader">
            <TableColumnHeading label="Profile" />
          </div>
          {metrics.map((metric) => (
            <div key={metric.key} role="columnheader">
              <TableColumnHeading
                label={metricLabels[metric.key]?.label ?? metric.label}
                unit={metricLabels[metric.key]?.detail ?? metric.unit}
              />
            </div>
          ))}
        </div>
        {rows.map((result) => {
          const peerRun = group.runs.find((candidate) => candidate.id === result.runId);
          const peer = subjects.find((candidate) => candidate.id === peerRun?.subjectId);
          return (
            <div
              className="evidence-comparison-row"
              role="row"
              key={result.runId}
              aria-current={result.runId === selectedRunId ? 'true' : undefined}
            >
              <div role="rowheader">
                {peer?.label ?? result.runId}
                {result.runId === selectedRunId ? <small>Selected</small> : null}
              </div>
              {metrics.map((metric) => (
                <div role="cell" key={metric.key}>
                  {formatMetric(
                    result.values[metric.key],
                    metric.unit === 'usd' ? { ...metric, precision: 6 } : metric,
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <p className="evidence-reading-key">
        {group.metrics.some((metric) => metric.key === 'bound')
          ? 'Complete + bound requires a complete answer and exact quote binding. Other test groups remain separate.'
          : 'Resource use for saved extraction outputs. Writer quality is not scored.'}
      </p>
      <RowDetailContext label="All recorded measures">
        <TableRowFacts
          items={group.metrics.map((metric) => ({
            label: metricLabels[metric.key]?.label ?? metric.label,
            unit: metricLabels[metric.key]?.detail ?? metric.unit,
            value: formatMetric(selected?.values[metric.key], metric),
          }))}
        />
      </RowDetailContext>
      <RowDetailContext label="Configuration & original record">
        <TableRowFacts
          layout="rows"
          items={[
            { label: 'Recorded', unit: 'date', value: run?.date ?? 'Not recorded' },
            ...Object.entries(subject?.configuration ?? {}).map(([label, value]) => ({
              label: label.charAt(0).toUpperCase() + label.slice(1).replaceAll('_', ' '),
              value,
            })),
          ]}
        />
        <p>{run?.scope}</p>
        <p>{group.costScope}</p>
        <p>
          One diagnostic pass with real provider calls. Sort order is descriptive. Source binding
          alone does not establish semantic support.
        </p>
        {source ? (
          <a className="ui-action" href={source.href} target="_blank" rel="noopener">
            Open original {source.path} ↗
          </a>
        ) : (
          <p>Original record unavailable.</p>
        )}
      </RowDetailContext>
    </>
  );
}

export function StudyResultsTable({
  group,
  subjects,
  sources = {},
}: {
  group: ComparisonGroup;
  subjects: Subject[];
  sources?: StudySources;
}) {
  const defaultKey = group.metrics.some((metric) => metric.key === 'bound') ? 'bound' : 'cost';
  const prefix = useId();
  const { params, update } = useWorkspaceQuery();
  const selectedMetric = params.get('metric');
  const sort = {
    key: group.metrics.find((metric) => metric.key === selectedMetric)?.key ?? defaultKey,
    descending: params.get('metricOrder')
      ? params.get('metricOrder') === 'desc'
      : defaultKey === 'bound',
  };
  function setSort(next: typeof sort) {
    update({ metric: next.key, metricOrder: next.descending ? 'desc' : 'asc' });
  }
  const metrics = [
    ...group.metrics.filter((metric) => metric.key === 'bound'),
    ...group.metrics.filter((metric) => metric.key !== 'bound'),
  ];
  const measuredKeys = new Set(
    metrics
      .filter((metric) =>
        group.results.some((result) => numeric(result.values[metric.key]) !== null),
      )
      .map((metric) => metric.key),
  );
  const primaryKeys = new Set([defaultKey, ...['cost'].filter((key) => measuredKeys.has(key))]);
  const rows = group.results.toSorted((left, right) => {
    const a = numeric(left.values[sort.key]);
    const b = numeric(right.values[sort.key]);
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return sort.descending ? b - a : a - b;
  });
  return (
    <>
      <div className="results-mobile-controls">
        <span>Expand a row for all metrics</span>
        <details className="results-sort-disclosure">
          <summary>Sort</summary>
          <label htmlFor={`${prefix}-sort`}>Metric</label>
          <select
            id={`${prefix}-sort`}
            value={sort.key}
            onChange={(event) => {
              const metric = metrics.find((item) => item.key === event.target.value);
              setSort({
                key: event.target.value,
                descending: metric?.unit === 'ratio' || metric?.unit === 'count',
              });
            }}
          >
            {alphabetical(
              metrics.filter((metric) => measuredKeys.has(metric.key)),
              (metric) => metric.label,
            ).map((metric) => (
              <option key={metric.key} value={metric.key}>
                {metric.label}
              </option>
            ))}
          </select>
          <button
            className="ui-action"
            type="button"
            aria-label="Reverse metric sort order"
            onClick={() => setSort({ ...sort, descending: !sort.descending })}
          >
            {sort.descending ? '↓ High first' : '↑ Low first'}
          </button>
        </details>
      </div>
      <div
        className="research-table-scroll results-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${group.title} results`}
      >
        <table
          id={`${prefix}-table`}
          className={`research-table results-table study-results-table compact-table${metrics.length <= 3 ? ' results-table-short' : ''}`}
        >
          <caption className="sr-only">
            {group.title}. Values are specific to this test. {group.costScope}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <TableColumnHeading label="Profile" unit="version" />
              </th>
              {metrics.map((metric) => {
                const comparable = group.results.length > 1 && measuredKeys.has(metric.key);
                const primary = primaryKeys.has(metric.key);
                const shown = metricLabels[metric.key];
                return (
                  <th
                    key={metric.key}
                    scope="col"
                    className={`results-metric${metric.key === 'cost' ? ' results-cost' : ''}${primary ? '' : ' results-secondary'}`}
                    data-sorted={sort.key === metric.key || undefined}
                    aria-sort={
                      sort.key === metric.key
                        ? sort.descending
                          ? 'descending'
                          : 'ascending'
                        : 'none'
                    }
                  >
                    <TableColumnHeading
                      label={shown?.label ?? metric.label}
                      unit={shown?.detail ?? metric.unit}
                      accessibleLabel={metric.label}
                      direction={
                        sort.key === metric.key
                          ? sort.descending
                            ? 'descending'
                            : 'ascending'
                          : undefined
                      }
                      disabled={!comparable}
                      onSort={() =>
                        setSort({
                          key: metric.key,
                          descending:
                            sort.key === metric.key
                              ? !sort.descending
                              : metric.unit === 'ratio' || metric.unit === 'count',
                        })
                      }
                    />
                  </th>
                );
              })}
              <th scope="col" className="results-source-heading compact-secondary">
                <span>Evidence</span>
              </th>
              <th scope="col" className="row-expand-cell">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((result) => {
              const run = group.runs.find((candidate) => candidate.id === result.runId);
              const subject = subjects.find((candidate) => candidate.id === run?.subjectId);
              const source = run?.evidenceIds.map((id) => sources[id]).find(Boolean);
              return (
                <ExpandableTableRow
                  key={result.runId}
                  label={subject?.label ?? result.runId}
                  visibleColumns={
                    1 + metrics.filter((metric) => primaryKeys.has(metric.key)).length
                  }
                  details={
                    <StudyResultEvidence
                      group={group}
                      subjects={subjects}
                      selectedRunId={result.runId}
                      source={source}
                    />
                  }
                >
                  <th scope="row">
                    {subject?.label ?? result.runId}
                    <span
                      className="results-version"
                      title={subject?.configuration.version ?? subject?.configuration.model}
                    >
                      {version(subject)}
                    </span>
                  </th>
                  {metrics.map((metric) => {
                    const value = result.values[metric.key];
                    const missing = value === null || value === undefined;
                    const primary = primaryKeys.has(metric.key);
                    const recorded = formatMetric(value, metric);
                    return (
                      <td
                        key={metric.key}
                        className={`research-number${primary ? '' : ' results-secondary'}`}
                        data-sorted={sort.key === metric.key || undefined}
                      >
                        {missing ? (
                          <span aria-label={recorded} title={recorded}>
                            —
                          </span>
                        ) : (
                          <span title={metric.unit === 'usd' ? `Recorded: ${recorded}` : undefined}>
                            {metric.unit === 'usd'
                              ? formatMetric(value, { ...metric, precision: 6 })
                              : recorded}
                          </span>
                        )}
                        {metric.key === 'bound' && numeric(value) !== null ? (
                          <span className="result-cell-bar" aria-hidden="true">
                            <span
                              style={{
                                width: `${(numeric(value) ?? 0) * 100}%`,
                                background: comparisonColor(subject?.label ?? result.runId),
                              }}
                            />
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                  <td className="results-source-cell compact-secondary">
                    <EvidenceDrawer
                      title={subject?.label ?? result.runId}
                      label={`Evidence for ${subject?.label ?? result.runId}`}
                    >
                      <StudyResultEvidence
                        group={group}
                        subjects={subjects}
                        selectedRunId={result.runId}
                        source={source}
                      />
                    </EvidenceDrawer>
                  </td>
                </ExpandableTableRow>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
