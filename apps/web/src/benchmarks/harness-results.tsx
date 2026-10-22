'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useWorkspaceQuery } from '../components/workspace-query.ts';
import { ComparisonFilters } from '../components/comparison-filters.tsx';
import { ReferenceHeader } from '../components/reference-layout.tsx';
import { TableNotes } from '../components/table-notes.tsx';
import { comparisonColor } from '../data/comparison-palette.ts';

type Harness = { id: string; name: string; documentation: string };
type Comparison = { id: string; name: string; description: string };
type Workload = { id: string; name: string };

export function HarnessResults({
  proposedModel,
  plannedTasks,
  harnesses,
  comparisons,
  workloads,
  records = false,
  children,
}: {
  proposedModel: string;
  plannedTasks: number;
  harnesses: Harness[];
  comparisons: Comparison[];
  workloads: Workload[];
  records?: boolean;
  children?: ReactNode;
}) {
  const { params, update, href } = useWorkspaceQuery();
  const comparison =
    comparisons.find((item) => item.id === params.get('comparison')) ??
    comparisons.find((item) => item.id === 'same-model');
  const harness = harnesses.some((item) => item.id === params.get('harness'))
    ? (params.get('harness') ?? 'all')
    : 'all';
  const workload = workloads.some((item) => item.id === params.get('workload'))
    ? (params.get('workload') ?? 'all')
    : 'all';
  const scoped = harnesses.filter((item) => harness === 'all' || item.id === harness);
  const filtered = comparison?.id !== 'same-model' || harness !== 'all' || workload !== 'all';
  const filters = (
    <div className="harness-comparison-toolbar">
      {filtered ? (
        <div className="results-selection-meta">
          <button
            type="button"
            className="ui-action workspace-reset"
            onClick={() => update({ comparison: null, harness: null, workload: null })}
          >
            Clear comparison filters
          </button>
        </div>
      ) : null}
      <ComparisonFilters
        context={[
          comparison?.name,
          harnesses.find((item) => item.id === harness)?.name,
          workloads.find((item) => item.id === workload)?.name,
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <div className="results-controls harness-controls">
          <div>
            <label htmlFor="harness-comparison">Comparison</label>
            <select
              id="harness-comparison"
              value={comparison?.id}
              onChange={(event) => update({ comparison: event.target.value })}
            >
              {comparisons.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="harness-filter">Harness</label>
            <select
              id="harness-filter"
              value={harness}
              onChange={(event) => update({ harness: event.target.value })}
            >
              <option value="all">All in V1</option>
              {harnesses.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="harness-workload">Task family</label>
            <select
              id="harness-workload"
              value={workload}
              onChange={(event) => update({ workload: event.target.value })}
            >
              <option value="all">All families</option>
              {workloads.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </ComparisonFilters>
    </div>
  );
  const notes = (
    <TableNotes label="Harness comparison" hint="Draft · no measurements.">
      <p>{comparison?.description}</p>
      <p>
        Proposed model: <code>{proposedModel}</code>. Releases are not pinned; runtime compatibility
        is unqualified. Task specifications are authored; workspace packages and graders are
        pending.
      </p>
      <Link href={href({ view: 'method' })}>Full comparison method and acceptance criteria</Link>
    </TableNotes>
  );
  return (
    <>
      {records ? (
        <section
          className="reference-page harness-records-empty"
          aria-label="Harness trial records"
        >
          <ReferenceHeader
            title="No trial records"
            description="No executed trials or result artifacts. Task specifications are available for review."
          />
          {filters}
          <dl className="evidence-facts">
            <div>
              <dt>Harness scope</dt>
              <dd>{scoped.map((item) => item.name).join(' · ')}</dd>
            </div>
            <div>
              <dt>Runtime qualification</dt>
              <dd>Not run</dd>
            </div>
            <div>
              <dt>Task specifications</dt>
              <dd>{plannedTasks} authored · workspace packages and graders pending</dd>
            </div>
          </dl>
          {notes}
          <div className="harness-draft-links">
            <Link className="ui-action" href={href({ view: 'method' })}>
              Review {plannedTasks} task specifications →
            </Link>
            <Link className="ui-action" href={`${href({ view: 'data' })}#harness-artifacts`}>
              Required evidence and protocol →
            </Link>
          </div>
        </section>
      ) : (
        <section className="harness-scope" aria-label="Harness leaderboard">
          <h2 id="harness-rankings" tabIndex={-1} className="comparison-rankings-title">
            Harness scope
          </h2>
          <div
            className="research-table-scroll"
            role="region"
            tabIndex={0}
            aria-label="V1 harness scope"
          >
            <table className="research-table harness-scope-table">
              <caption className="sr-only">Harnesses included in the draft study</caption>
              <thead>
                <tr>
                  <th scope="col">Harness</th>
                  <th scope="col" className="harness-proposed-model">
                    Proposed model
                  </th>
                  <th scope="col" className="harness-version">
                    Release
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Docs</th>
                </tr>
              </thead>
              <tbody>
                {scoped.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      <i
                        className="data-swatch"
                        style={{ background: comparisonColor(item.name) }}
                        aria-hidden="true"
                      />
                      {item.name}
                    </th>
                    <td className="harness-proposed-model">
                      <code>{proposedModel}</code>
                    </td>
                    <td className="harness-version">Not pinned</td>
                    <td>Not run</td>
                    <td>
                      <a
                        href={item.documentation}
                        target="_blank"
                        rel="noopener"
                        aria-label={`Docs for ${item.name}`}
                      >
                        Docs ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {notes}
          {filters}
          {children}
          <div className="harness-draft-status">
            <div>
              <h3>No measured combinations</h3>
            </div>
            <Link href={href({ view: 'method' })}>Review {plannedTasks} task specifications</Link>
          </div>
        </section>
      )}
    </>
  );
}
