'use client';

import { useId, useState } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { alphabetical } from '../display-order.ts';
import type { StudyCase } from '../studies/types.ts';
import { TableColumnHeading } from '../components/table-column-heading.tsx';
import { useWorkspaceQuery } from '../components/workspace-query.ts';
import { MemoryCaseLink } from './memory-results.tsx';
import { useSavedWorkspacePosition } from '../components/workspace-position.ts';

export type MemoryCaseSummary = Pick<
  StudyCase,
  'id' | 'title' | 'kind' | 'question' | 'explanation'
> & {
  outputCount: number;
};

function MemoryRecordRow({
  studyId,
  item,
  showKind,
}: {
  studyId: string;
  item: MemoryCaseSummary;
  showKind: boolean;
}) {
  const id = useId();
  const saved = useSavedWorkspacePosition();
  const rowKey = `case:${item.id}`;
  const [expanded, setExpanded] = useState(() => saved?.rows.includes(rowKey) ?? false);
  const context =
    studyId === 'native-memory'
      ? item.id.startsWith('pre-')
        ? 'Before updates'
        : 'After updates and recovery'
      : showKind
        ? item.kind === 'reader'
          ? 'Reader'
          : 'Writer'
        : null;
  return (
    <>
      <tr data-case-id={item.id}>
        <th scope="row">
          <MemoryCaseLink studyId={studyId} caseId={item.id}>
            {item.title}
          </MemoryCaseLink>
          {context ? <small className="memory-case-kind">{context}</small> : null}
        </th>
        <td className="memory-case-outputs">
          <span className="mobile-column-label">Saved outputs </span>
          {item.outputCount}
        </td>
        <td className="memory-case-review">
          <button
            type="button"
            className="case-review-toggle"
            aria-label={`Recorded finding for ${item.title}`}
            aria-expanded={expanded}
            aria-controls={expanded ? id : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            <CaretDownIcon size={12} aria-hidden="true" />
            Recorded finding
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="memory-record-detail">
          <td colSpan={3}>
            <div
              id={id}
              data-expanded-row={rowKey}
              role="region"
              aria-label={`Review of ${item.title}`}
            >
              <dl className="case-review-facts">
                <div>
                  <dt>{item.kind === 'reader' ? 'Question' : 'Input summary'}</dt>
                  <dd>{item.kind === 'reader' ? item.question : item.title}</dd>
                </div>
                <div>
                  <dt>Finding</dt>
                  <dd>{item.explanation}</dd>
                </div>
                <div>
                  <dt>Case ID</dt>
                  <dd>
                    <code>{item.id}</code>
                  </dd>
                </div>
              </dl>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function MemoryRecords({ studyId, cases }: { studyId: string; cases: MemoryCaseSummary[] }) {
  const prefix = useId();
  const { params, update } = useWorkspaceQuery();
  const search = params.get('caseSearch') ?? '';
  const selectedTest = params.get('test');
  const kind =
    params.get('caseKind') ??
    (selectedTest === 'reader' || selectedTest === 'writer' ? selectedTest : 'all');
  const kinds = alphabetical([...new Set(cases.map((item) => item.kind))], (value) => value);
  const query = search.trim().toLocaleLowerCase('en-US');
  const rows = alphabetical(
    cases.filter(
      (item) =>
        (kind === 'all' || item.kind === kind) &&
        `${item.title} ${item.question} ${item.id}`.toLocaleLowerCase('en-US').includes(query),
    ),
    (item) => item.title,
  );
  const filtered = query !== '' || kind !== 'all';
  return (
    <section className="memory-records" aria-label="Saved case records">
      <div className="reference-record-controls">
        <div className="reference-record-search">
          <label htmlFor={`${prefix}-search`}>Find a case</label>
          <input
            id={`${prefix}-search`}
            type="search"
            value={search}
            placeholder="Question or case ID"
            onChange={(event) =>
              update({ caseSearch: event.target.value || null }, { replace: true })
            }
          />
        </div>
        {kinds.length > 1 ? (
          <div>
            <label htmlFor={`${prefix}-workload`}>Workload</label>
            <select
              id={`${prefix}-workload`}
              value={kind}
              onChange={(event) => update({ caseKind: event.target.value })}
            >
              <option value="all">All</option>
              {kinds.map((value) => (
                <option key={value} value={value}>
                  {value === 'reader' ? 'Reader' : 'Writer'}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <p className="reference-record-count" role="status">
          {rows.length} of {cases.length} cases
        </p>
        {filtered ? (
          <button
            className="ui-action"
            type="button"
            onClick={() => update({ caseSearch: null, caseKind: 'all' })}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <div className="research-table-scroll" role="region" tabIndex={0} aria-label="Case index">
        <table className="research-table memory-record-table">
          <caption className="sr-only">
            Cases in the selected memory study. Saved outputs are evidence records, not passes.
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <TableColumnHeading label="Case" />
              </th>
              <th scope="col">
                <TableColumnHeading label="Outputs" unit="saved" />
              </th>
              <th scope="col">
                <TableColumnHeading label="Review" />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <MemoryRecordRow
                key={item.id}
                studyId={studyId}
                item={item}
                showKind={kinds.length > 1}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="research-empty">
            No cases match these filters. Clear filters to see all {cases.length} cases.
          </p>
        ) : null}
      </div>
    </section>
  );
}
