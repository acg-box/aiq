import type { Metadata } from 'next';
import Link from 'next/link';

import { CalibrationEfficiency } from '../../components/calibration-efficiency.tsx';
import { ReadStateNote } from '../../components/read-state-note.tsx';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';

export const metadata: Metadata = { title: 'Calibration evidence' };
export const dynamic = 'force-dynamic';

type CalibrationSearchParams = { before?: string; after?: string };

export default async function CalibrationsPage({
  searchParams,
}: {
  searchParams: Promise<CalibrationSearchParams>;
}) {
  const { before, after } = await searchParams;
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
      <div className="page-intro">
        <span className="eyebrow">Calibration register</span>
        <h1>Verified provenance · untrusted calibration · not Official · not ranking eligible</h1>
        <p>
          Chronological, replay-verified diagnostic evidence stays separate from the Official
          leaderboard, compare, and trends surfaces. Each page contains at most 20 retained runs.
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
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Selection</th>
                <th>Replay</th>
                <th>Classification</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                  </td>
                  <td>
                    {run.selectedModelCount} models × {run.selectedTaskCount} tasks
                    <small>{run.resultCount.toLocaleString()} retained result cells</small>
                  </td>
                  <td>{run.replayStatus.replaceAll('_', ' ')}</td>
                  <td>
                    Untrusted · not Official · not ranking eligible
                    {run.synthetic ? <small>Synthetic seed</small> : null}
                  </td>
                  <td>
                    <Link href={`/calibrations/${run.id}`}>Inspect calibration</Link>
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
            <Link href={`/calibrations?after=${encodeURIComponent(runs.data.newerCursor)}`}>
              ← Newer calibrations
            </Link>
          ) : (
            <span aria-disabled="true">← Newer calibrations</span>
          )}
          {runs.data.olderCursor ? (
            <Link href={`/calibrations?before=${encodeURIComponent(runs.data.olderCursor)}`}>
              Older calibrations →
            </Link>
          ) : (
            <span aria-disabled="true">Older calibrations →</span>
          )}
        </nav>
      ) : null}
      {selectedRun && hasScores ? (
        <>
          <p className="formula-note">
            Efficiency and scatter evidence below is bounded to the first run on this page:{' '}
            <code>{selectedRun.id}</code>.
          </p>
          <CalibrationEfficiency scores={scores.data} />
        </>
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
