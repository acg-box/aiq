'use client';

import { NavigationLink } from './navigation-link.tsx';
import { useId } from 'react';
import { EvidenceDrawer } from './evidence-drawer.tsx';
import { ExpandableTableRow, RowDetailContext, TableRowFacts } from './expandable-table-row.tsx';
import { WorkspaceDetailLink } from './workspace-detail-link.tsx';
import { useWorkspaceQuery } from './workspace-query.ts';
import { CoreIntervalMark } from './core-interval-mark.tsx';
import { CoreComparisonMatrix, coreEfforts } from './core-comparison-matrix.tsx';
import { ComparisonFilters } from './comparison-filters.tsx';
import { ReferenceHeader } from './reference-layout.tsx';
import { TableNotes } from './table-notes.tsx';
import { TableColumnHeading } from './table-column-heading.tsx';
import { alphabetical } from '../display-order.ts';
import { AIQ_CORE_SCORING_VERSION } from '../aiq-core-contract.ts';
import {
  selectCoreResults,
  rankCoreResults,
  type CoreResultDataset,
  type CoreResultRow,
} from '../data/core-results.ts';
import { presentLeaderboardEntry } from '../data/leaderboard-presentation.ts';

function CoreRowDetails({ dataset, row }: { dataset: CoreResultDataset; row: CoreResultRow }) {
  const { entry } = row;
  const shown = presentLeaderboardEntry(entry);
  const ranked = rankCoreResults(dataset.rows);
  const best = ranked[0];
  const rank = ranked.find((candidate) => candidate.entry.runId === entry.runId)?.rank;
  const gap = best ? entry.score - best.entry.score : null;
  return (
    <>
      <p className="evidence-context">
        Core {dataset.version} · {dataset.historical ? 'Historical measurement' : 'Official result'}
        {rank ? ` · Rank ${rank} of ${ranked.length}` : ''}
      </p>
      <TableRowFacts
        items={[
          {
            label: 'Ability',
            unit: '0–100',
            value: (
              <>
                {entry.score.toFixed(3)}
                <small>{shown.interval} · conditional 95% interval</small>
              </>
            ),
          },
          {
            label: 'Strict pass',
            unit: '% of scored tasks',
            value: (
              <>
                {(entry.strictPassRate * 100).toFixed(1)}%
                <small>
                  {entry.strictPassSuccesses}/{entry.strictPassSampleSize} scored tasks
                </small>
              </>
            ),
          },
          {
            label: 'Gap to top score',
            unit: 'ability points',
            value: gap === null ? 'Not available' : gap === 0 ? '0.000' : gap.toFixed(3),
          },
          {
            label: 'Task coverage',
            unit: 'observed / expected',
            value: `${entry.sampleSize}/${entry.sampleSize + entry.missing}`,
          },
        ]}
      />
      {best ? (
        <p className="evidence-reading-key">
          Compared with {best.entry.modelFamily} {best.entry.reasoningTier} (
          {best.entry.score.toFixed(3)}) in this dataset. Point estimates do not establish a
          statistical winner.
        </p>
      ) : null}
      <RowDetailContext label="Intervals & interpretation">
        <TableRowFacts
          layout="rows"
          items={[
            { label: 'Ability interval', unit: 'conditional 95%', value: shown.interval },
            {
              label: 'Strict pass interval',
              unit: '95% · %',
              value:
                entry.strictPassLow !== null && entry.strictPassHigh !== null
                  ? `${(entry.strictPassLow * 100).toFixed(1)}–${(entry.strictPassHigh * 100).toFixed(1)}%`
                  : 'Not recorded',
            },
            { label: 'Coverage', unit: '% of tasks', value: shown.coverage },
          ]}
        />
        <p>The ability interval holds the item bank fixed.</p>
        {dataset.historical ? (
          <p>
            Historical measurements retain their original task and model versions. They do not
            qualify as current Core 1.1.0 results.
          </p>
        ) : null}
      </RowDetailContext>
      <RowDetailContext label="Run identity & original JSON">
        <TableRowFacts
          layout="rows"
          items={[
            { label: 'Model', value: entry.modelName },
            { label: 'Recorded', unit: 'date', value: row.completedAt.slice(0, 10) },
            { label: 'Scoring', unit: 'version', value: entry.scoringVersion },
            { label: 'Run ID', value: <code>{entry.runId}</code> },
          ]}
        />
        {dataset.historical ? (
          <a className="ui-action" href={row.evidenceHref} target="_blank" rel="noopener">
            Open original public record ↗
          </a>
        ) : (
          <WorkspaceDetailLink className="ui-action" href={row.evidenceHref}>
            Open complete run evidence
          </WorkspaceDetailLink>
        )}
      </RowDetailContext>
    </>
  );
}

function CoreResultEvidence({ dataset, row }: { dataset: CoreResultDataset; row: CoreResultRow }) {
  return (
    <EvidenceDrawer
      title={`${row.entry.modelFamily} · ${row.entry.reasoningTier}`}
      label={`Evidence for ${row.entry.modelFamily} ${row.entry.reasoningTier}`}
    >
      <CoreRowDetails dataset={dataset} row={row} />
    </EvidenceDrawer>
  );
}

export function CoreResultsTable({
  datasets,
  records = false,
}: {
  datasets: readonly [CoreResultDataset, ...CoreResultDataset[]];
  records?: boolean;
}) {
  const prefix = useId();
  const { params, update, href } = useWorkspaceQuery();
  const selected =
    params.get('dataset') ??
    datasets.find((dataset) => dataset.rows.length > 0)?.id ??
    datasets[0].id;
  const family = params.get('model') ?? 'all';
  const effort = params.get('effort') ?? 'all';
  const sortKey = params.get('sort');
  const sort: { key: 'ability' | 'strict' | 'model'; descending: boolean } = {
    key: sortKey === 'strict' || sortKey === 'model' ? sortKey : ('ability' as const),
    descending: params.get('order') !== 'asc',
  };
  const dataset = datasets.find((candidate) => candidate.id === selected) ?? datasets[0];
  const rows = selectCoreResults(dataset.rows, family, effort, sort);
  const filtered = family !== 'all' || effort !== 'all';
  const families = alphabetical(
    [...new Set(dataset.rows.map(({ entry }) => entry.modelFamily))],
    (value) => value,
  );
  const dates = [...new Set(dataset.rows.map((row) => row.completedAt.slice(0, 10)))].toSorted();
  const lower = dataset.rows.length
    ? Math.min(...dataset.rows.map(({ entry }) => entry.scoreCiLow ?? entry.score))
    : 0;
  const upper = dataset.rows.length
    ? Math.max(...dataset.rows.map(({ entry }) => entry.scoreCiHigh ?? entry.score))
    : 1;
  const padding = Math.max((upper - lower) * 0.05, 0.01);
  const minimum = lower - padding;
  const maximum = upper + padding;
  const emptyTitle =
    dataset.state === 'unavailable'
      ? 'Published results unavailable.'
      : dataset.state === 'preview'
        ? 'No Official results in this preview.'
        : 'No Official results published.';
  function sortColumn(key: typeof sort.key, label: string, unit: string, accessibleLabel = label) {
    return (
      <TableColumnHeading
        label={label}
        unit={unit}
        accessibleLabel={accessibleLabel}
        direction={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : undefined}
        disabled={dataset.rows.length < 2}
        onSort={() =>
          update({
            sort: key,
            order: (sort.key === key ? !sort.descending : key !== 'model') ? 'desc' : 'asc',
          })
        }
      />
    );
  }
  function order(key: typeof sort.key) {
    return rows.length === 0
      ? undefined
      : sort.key === key
        ? sort.descending
          ? ('descending' as const)
          : ('ascending' as const)
        : ('none' as const);
  }
  return (
    <div className={records ? 'core-records-workspace' : 'core-comparison-workspace'}>
      {records ? (
        <ReferenceHeader
          title="Result records"
          description="Measured configurations, newest first. Open a row’s details for scores, exact identity, and the original public record."
        />
      ) : null}
      <div className="core-comparison-toolbar">
        <div className="results-selection-meta core-results-meta">
          <p className="results-dataset" aria-live="polite">
            Core {dataset.version} ·{' '}
            {dataset.state === 'unavailable'
              ? 'Measurements unavailable'
              : `${rows.length} of ${dataset.rows.length} configurations`}{' '}
            · {dataset.historical ? 'Historical measurements' : 'Official measurements'}
          </p>
          {filtered ? (
            <button
              className="ui-action core-reset-filters"
              type="button"
              onClick={() => update({ model: null, effort: null })}
            >
              Clear filters
            </button>
          ) : null}
        </div>
        <ComparisonFilters
          label={records ? 'Filter records' : 'Refine comparison'}
          context={
            filtered
              ? `${family === 'all' ? 'All models' : family} · ${effort === 'all' ? 'All efforts' : effort}`
              : ''
          }
        >
          <div className="core-results-controls results-controls">
            <div className="core-dataset-control">
              <label htmlFor={`${prefix}-dataset`}>Dataset</label>
              <select
                id={`${prefix}-dataset`}
                value={dataset.id}
                onChange={(event) => {
                  update({
                    dataset: event.target.value,
                    model: null,
                    effort: null,
                    sort: null,
                    order: null,
                  });
                }}
              >
                {datasets.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    AIQ Core {candidate.version} · {candidate.historical ? 'historical' : 'current'}
                  </option>
                ))}
              </select>
            </div>
            <div className="core-filter-controls">
              {!records ? (
                <div className="core-mobile-sort">
                  <label htmlFor={`${prefix}-sort`}>Sort by</label>
                  <select
                    id={`${prefix}-sort`}
                    value={sort.key}
                    onChange={(event) =>
                      update({
                        sort: event.target.value,
                        order: event.target.value === 'model' ? 'asc' : 'desc',
                      })
                    }
                    disabled={dataset.rows.length < 2}
                  >
                    <option value="ability">Ability</option>
                    <option value="model">Model / effort</option>
                    <option value="strict">Strict pass</option>
                  </select>
                </div>
              ) : null}
              <div>
                <label htmlFor={`${prefix}-model`}>Model</label>
                <select
                  id={`${prefix}-model`}
                  value={family}
                  onChange={(event) => update({ model: event.target.value })}
                  disabled={dataset.rows.length === 0}
                >
                  <option value="all">All</option>
                  {families.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${prefix}-effort`}>Effort</label>
                <select
                  id={`${prefix}-effort`}
                  value={effort}
                  onChange={(event) => update({ effort: event.target.value })}
                  disabled={dataset.rows.length === 0}
                >
                  <option value="all">All</option>
                  {coreEfforts.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <p className="research-caption core-filter-provenance">
            Scoring {dataset.rows[0]?.entry.scoringVersion ?? AIQ_CORE_SCORING_VERSION}.
            {dates.length > 0
              ? ` Recorded ${dates[0]}${dates.length > 1 ? ` – ${dates.at(-1)}` : ''}.`
              : ''}
          </p>
        </ComparisonFilters>
        {dataset.historical ? (
          <p className="research-caption core-dataset-scope">
            Historical task and model versions. Current Core {datasets[0].version}:{' '}
            {datasets[0].state === 'unavailable'
              ? 'publication unavailable.'
              : datasets[0].rows.length === 0
                ? 'no Official results.'
                : `${datasets[0].rows.length} Official configurations in a separate dataset.`}
          </p>
        ) : null}
      </div>
      {!records && dataset.rows.length > 0 ? <CoreComparisonMatrix dataset={dataset} /> : null}
      <section className="core-ranking-workspace">
        {!records && dataset.rows.length > 0 ? (
          <div className="comparison-table-heading">
            <div className="overview-heading-actions">
              <h2 id="core-rankings" tabIndex={-1}>
                Practical task results
              </h2>
              <NavigationLink href={href({ view: 'method' })}>How scoring works</NavigationLink>
            </div>
            <p className="comparison-reading-key">
              <strong>Ability</strong>: calibrated task score. <strong>Strict pass</strong>: fully
              correct outcomes. Higher is better; lines show conditional 95% intervals.
            </p>
          </div>
        ) : null}
        {records ? (
          <>
            <div
              className="research-table-scroll results-table-scroll"
              role="region"
              tabIndex={0}
              aria-label="Core result records"
            >
              <table className="research-table results-table core-record-table compact-table">
                <caption className="sr-only">
                  Published result records in the selected dataset
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <TableColumnHeading label="Model" unit="effort" />
                    </th>
                    <th scope="col" className="core-record-date">
                      <TableColumnHeading label="Recorded" unit="date" />
                    </th>
                    <th scope="col" className="core-record-id compact-secondary">
                      <TableColumnHeading label="Run ID" />
                    </th>
                    <th scope="col" className="core-record-coverage compact-secondary">
                      <TableColumnHeading label="Task coverage" unit="observed / expected" />
                    </th>
                    <th scope="col" className="core-record-evidence compact-secondary">
                      <span>
                        <TableColumnHeading label="Evidence" />
                      </span>
                    </th>
                    <th scope="col" className="row-expand-cell">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows
                    .toSorted(
                      (a, b) =>
                        b.completedAt.localeCompare(a.completedAt) ||
                        a.entry.id.localeCompare(b.entry.id),
                    )
                    .map((row) => (
                      <ExpandableTableRow
                        key={row.entry.runId}
                        data-run-id={row.entry.runId}
                        label={`${row.entry.modelFamily} ${row.entry.reasoningTier}`}
                        visibleColumns={2}
                        details={<CoreRowDetails dataset={dataset} row={row} />}
                      >
                        <th scope="row">
                          {row.entry.modelFamily}{' '}
                          <span className="core-effort">{row.entry.reasoningTier}</span>
                          <span className="results-version">{row.entry.modelName}</span>
                        </th>
                        <td className="core-record-date">
                          <time dateTime={row.completedAt}>{row.completedAt.slice(0, 10)}</time>
                        </td>
                        <td className="core-record-id compact-secondary">
                          <code title={row.entry.runId}>{row.entry.runId.slice(0, 16)}…</code>
                        </td>
                        <td className="core-record-coverage research-number compact-secondary">
                          {row.entry.sampleSize}/{row.entry.sampleSize + row.entry.missing}
                        </td>
                        <td className="core-record-evidence compact-secondary">
                          <CoreResultEvidence dataset={dataset} row={row} />
                        </td>
                      </ExpandableTableRow>
                    ))}
                </tbody>
              </table>
              {rows.length === 0 ? (
                <div className="results-empty">
                  <h2>{dataset.rows.length > 0 ? 'No matching records.' : emptyTitle}</h2>
                  <p>
                    Records are limited to the selected result dataset. Calibration and synthetic
                    previews stay separate.
                  </p>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div
            className="research-table-scroll results-table-scroll"
            role="region"
            tabIndex={0}
            aria-label="Core leaderboard"
          >
            <table className="research-table results-table core-board-table compact-table">
              <caption className="sr-only">
                AIQ Core {dataset.version}
                {dataset.historical ? ' historical results' : ' Official results'}. Rank uses
                calibrated ability across all {dataset.rows.length} configurations in this dataset.
                Equal recorded scores share a rank.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="core-rank">
                    Rank
                  </th>
                  <th
                    scope="col"
                    className="core-model results-metric"
                    data-sorted={sort.key === 'model' || undefined}
                    aria-sort={order('model')}
                  >
                    {sortColumn('model', 'Model', 'effort', 'Model / effort')}
                  </th>
                  <th
                    scope="col"
                    className="results-metric core-ability-heading"
                    data-sorted={sort.key === 'ability' || undefined}
                    aria-sort={order('ability')}
                  >
                    {sortColumn('ability', 'Ability', '0–100 · 95% CI')}
                  </th>
                  <th
                    scope="col"
                    className="results-metric core-strict compact-secondary"
                    data-sorted={sort.key === 'strict' || undefined}
                    aria-sort={order('strict')}
                  >
                    {sortColumn('strict', 'Strict pass', '% of scored tasks')}
                  </th>
                  <th scope="col" className="results-metric core-coverage compact-secondary">
                    <TableColumnHeading label="Coverage" unit="% of tasks" />
                  </th>
                  <th scope="col" className="core-evidence compact-secondary">
                    <span>Evidence</span>
                  </th>
                  <th scope="col" className="row-expand-cell">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const { entry, rank } = row;
                  const shown = presentLeaderboardEntry(entry);
                  return (
                    <ExpandableTableRow
                      key={entry.id}
                      data-configuration={entry.id}
                      data-rank={rank}
                      label={`${entry.modelFamily} ${entry.reasoningTier}`}
                      visibleColumns={3}
                      details={<CoreRowDetails dataset={dataset} row={row} />}
                    >
                      <td className="core-rank research-number">{rank}</td>
                      <th scope="row" className="core-model">
                        {entry.modelFamily}{' '}
                        <span className="core-effort">{entry.reasoningTier}</span>
                        <span className="results-version" title={entry.modelName}>
                          {entry.modelName}
                        </span>
                      </th>
                      <td
                        className="research-number core-ability"
                        data-sorted={sort.key === 'ability' || undefined}
                      >
                        <div className="core-ability-reading">
                          <span className="core-ability-value">
                            <span title={`Recorded ability: ${entry.score}`}>
                              {entry.score.toFixed(3)}
                            </span>
                            <span className="core-interval">{shown.interval}</span>
                          </span>
                          <CoreIntervalMark
                            subject={entry.modelFamily}
                            value={entry.score}
                            low={entry.scoreCiLow}
                            high={entry.scoreCiHigh}
                            minimum={minimum}
                            maximum={maximum}
                          />
                        </div>
                      </td>
                      <td
                        className="research-number core-strict compact-secondary"
                        data-sorted={sort.key === 'strict' || undefined}
                      >
                        {(entry.strictPassRate * 100).toFixed(1)}%
                        <span className="core-interval">
                          {entry.strictPassSuccesses}/{entry.strictPassSampleSize}
                        </span>
                      </td>
                      <td className="research-number core-coverage compact-secondary">
                        {shown.coverage}
                        <span className="core-interval">
                          {entry.sampleSize}/{entry.sampleSize + entry.missing}
                        </span>
                      </td>
                      <td className="core-evidence compact-secondary">
                        <CoreResultEvidence dataset={dataset} row={row} />
                      </td>
                    </ExpandableTableRow>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="results-empty">
                      <h2>
                        {dataset.rows.length > 0 ? 'No matching configurations.' : emptyTitle}
                      </h2>
                      <p>
                        {dataset.rows.length > 0
                          ? 'Change the model or effort filter, or clear filters to show this dataset.'
                          : dataset.state === 'unavailable'
                            ? 'The public data source could not be read or the result identity could not be verified.'
                            : 'Synthetic previews and Calibration are excluded from this leaderboard.'}
                      </p>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        {!records && dataset.rows.length > 0 ? (
          <TableNotes
            label="AI Intelligence results"
            hint="Point-estimate order · intervals may overlap."
          >
            <p>
              Ability rank stays relative to all {dataset.rows.length} configurations when filters
              change. Equal recorded ability shares a rank; point-estimate order does not establish
              a statistical winner.
            </p>
            <p>
              Lines show conditional 95% intervals on the shared ability scale {minimum.toFixed(3)}–
              {maximum.toFixed(3)}, including after filtering. Ability and intervals use the
              selected benchmark version and scoring{' '}
              {dataset.rows[0]?.entry.scoringVersion ?? AIQ_CORE_SCORING_VERSION}. Historical
              measurements retain their original model and task version. Ability is specific to Core
              tasks and is not a human IQ norm.
            </p>
            <NavigationLink href={href({ view: 'method' })}>
              Full scoring method and limitations
            </NavigationLink>
          </TableNotes>
        ) : null}
        {!dataset.historical && dataset.rows.length === 0 ? (
          <TableNotes label="AI Intelligence publication" hint="Task counts describe the design.">
            <p>
              Task and domain counts describe the design, not completed measurements. Only published
              Official rows with exact run and configuration identity appear here. Synthetic
              previews and Calibration are excluded. Ability and conditional 95% intervals use the
              selected benchmark version and scoring {AIQ_CORE_SCORING_VERSION}; ability is not a
              human IQ norm.
            </p>
            <NavigationLink href={href({ view: 'method' })}>
              Full scoring method and limitations
            </NavigationLink>
          </TableNotes>
        ) : null}
      </section>
    </div>
  );
}
