import { BoardDetailNavigation } from '../../../../components/board-detail-navigation.tsx';
import { TableColumnHeading } from '../../../../components/table-column-heading.tsx';
import type { Metadata } from 'next';
import { NavigationLink } from '../../../../components/navigation-link.tsx';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowRight';

import { CalibrationEfficiency } from '../../../../components/calibration-efficiency.tsx';
import { ReadStateNote } from '../../../../components/read-state-note.tsx';
import { readPublicData } from '../../../../data/read-state.ts';
import { createAiqRepository } from '../../../../data/repository.ts';
import { createPageMetadata } from '../../../site-metadata.ts';

export const metadata: Metadata = createPageMetadata({
  title: 'Calibration evidence',
  path: '/benchmarks/intelligence/calibrations',
  description:
    'Inspect replay-verified AIQ calibration evidence kept separate from Official rankings.',
});
export const dynamic = 'force-dynamic';

type CalibrationSearchParams = { before?: string; after?: string; return?: string };

export default async function CalibrationsPage({
  searchParams,
}: {
  searchParams: Promise<CalibrationSearchParams>;
}) {
  const { before, after, return: returnTo } = await searchParams;
  function calibrationHref(path: string, cursor?: { before?: string; after?: string }) {
    const query = new URLSearchParams(cursor);
    if (returnTo) query.set('return', returnTo);
    return `${path}${query.size ? `?${query}` : ''}`;
  }
  const registerHref = calibrationHref(
    '/benchmarks/intelligence/calibrations',
    before ? { before } : after ? { after } : undefined,
  );
  const repository = createAiqRepository();
  const pageRequest = before
    ? { direction: 'older' as const, cursor: before }
    : after
      ? { direction: 'newer' as const, cursor: after }
      : undefined;
  const runs = await readPublicData(
    repository,
    () =>
      before && after
        ? Promise.reject(new Error('Choose only one calibration-run cursor.'))
        : repository.listCalibrationRunPage(pageRequest),
    { runs: [], newerCursor: null, olderCursor: null },
    (value) => value.runs.length === 0,
    (value) => value.runs.map((run) => run.synthetic),
  );
  const selectedRun = runs.data.runs[0];
  const scores = await readPublicData(
    repository,
    () => (selectedRun ? repository.listCalibrationScores(selectedRun.id) : Promise.resolve([])),
    [],
    (value) => value.length === 0,
    (value) => value.map((score) => score.synthetic),
  );
  const hasRuns =
    runs.state === 'synthetic' || runs.state === 'published' || runs.state === 'mixed';
  const hasScores =
    scores.state === 'synthetic' || scores.state === 'published' || scores.state === 'mixed';

  return (
    <section className="page-shell inner-page">
      <BoardDetailNavigation board="intelligence" selected="records" />
      <div className="page-intro">
        <span className="eyebrow">Diagnostics</span>
        <h1>Calibration evidence</h1>
        <p>
          Replay-verified evaluator checks live here, separate from Official scores and rankings.
          Use them to inspect scoring behavior, not to compare models.
        </p>
      </div>
      <ReadStateNote result={runs} subject="Calibration register" />
      {hasRuns ? (
        <div
          className="table-scroll"
          role="region"
          aria-label="Public calibration register"
          tabIndex={0}
        >
          <table className="calibration-register-table">
            <thead>
              <tr>
                <th scope="col" className="calibration-start">
                  <TableColumnHeading label="Started" unit="date / time" />
                </th>
                <th scope="col">
                  <TableColumnHeading label="Selection" unit="models × tasks" />
                </th>
                <th scope="col" className="calibration-extra">
                  <TableColumnHeading label="Scoring" unit="version" />
                </th>
                <th scope="col" className="calibration-extra">
                  <TableColumnHeading label="Replay" unit="verification" />
                </th>
                <th scope="col" className="calibration-extra">
                  <TableColumnHeading label="Classification" unit="evidence status" />
                </th>
                <th className="calibration-detail">
                  <span>Evidence</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((run) => (
                <tr key={run.id}>
                  <td className="calibration-start">
                    <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                  </td>
                  <td>
                    {run.selectedModelCount} models × {run.selectedTaskCount} tasks
                    <small>{run.resultCount.toLocaleString()} retained result cells</small>
                    <small className="calibration-mobile-meta">
                      Scoring {run.scoringVersion || 'unavailable'} ·{' '}
                      {run.replayStatus.replaceAll('_', ' ')}
                    </small>
                    <small className="calibration-mobile-meta">
                      Untrusted · not Official · not ranking eligible
                      {run.synthetic ? ' · Synthetic seed' : ''}
                    </small>
                  </td>
                  <td className="calibration-extra">{run.scoringVersion || 'Unavailable'}</td>
                  <td className="calibration-extra">{run.replayStatus.replaceAll('_', ' ')}</td>
                  <td className="calibration-extra">
                    Untrusted · not Official · not ranking eligible
                    {run.synthetic ? <small>Synthetic seed</small> : null}
                  </td>
                  <td className="calibration-detail">
                    <NavigationLink
                      className="ui-action"
                      aria-label="Inspect calibration"
                      href={`/benchmarks/intelligence/calibrations/${run.id}?${new URLSearchParams({ return: registerHref })}`}
                    >
                      <span>Inspect calibration</span>
                      <ArrowRightIcon size={15} aria-hidden="true" />
                    </NavigationLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {hasRuns ? (
        <nav className="history-pagination" aria-label="Calibration register pages">
          {runs.data.newerCursor ? (
            <NavigationLink
              href={calibrationHref('/benchmarks/intelligence/calibrations', {
                after: runs.data.newerCursor,
              })}
            >
              ← Newer calibrations
            </NavigationLink>
          ) : (
            <span aria-disabled="true">← Newer calibrations</span>
          )}
          {runs.data.olderCursor ? (
            <NavigationLink
              href={calibrationHref('/benchmarks/intelligence/calibrations', {
                before: runs.data.olderCursor,
              })}
            >
              Older calibrations →
            </NavigationLink>
          ) : (
            <span aria-disabled="true">Older calibrations →</span>
          )}
        </nav>
      ) : null}
      {selectedRun && hasScores ? (
        <details className="evidence-notes calibration-analysis-disclosure">
          <summary>
            <strong>Selected calibration analysis</strong>
            <span>Scores, intervals, time, cost, and exact run identity</span>
          </summary>
          <div className="evidence-note-body">
            <p className="fine-print">
              This analysis is bounded to the first run on this page: <code>{selectedRun.id}</code>.
            </p>
            <CalibrationEfficiency
              scores={scores.data}
              scoringVersion={selectedRun.scoringVersion || null}
            />
          </div>
        </details>
      ) : hasRuns ? (
        <>
          <ReadStateNote result={scores} subject="Selected-run score matrix" />
          <p className="empty-note">
            Efficiency context is unavailable until safe model-level calibration scores are public.
          </p>
        </>
      ) : null}
    </section>
  );
}
