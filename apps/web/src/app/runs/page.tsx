import type { Metadata } from 'next';
import Link from 'next/link';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import { classifyRunSummaryCompleteness } from '../../data/format.ts';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
import { createPageMetadata } from '../site-metadata.ts';

export const metadata: Metadata = createPageMetadata({
  title: 'Run history',
  path: '/runs',
  description:
    'Inspect the public history of complete, coverage-only, and missing-result AIQ runs.',
});
export const dynamic = 'force-dynamic';

type RunsSearchParams = { before?: string; after?: string };

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<RunsSearchParams>;
}) {
  const { before, after } = await searchParams;
  const repository = createAiqRepository();
  const pageRequest = before
    ? { direction: 'older' as const, cursor: before }
    : after
      ? { direction: 'newer' as const, cursor: after }
      : undefined;
  const [runsResult, leaderboardResult] = await Promise.all([
    readPublicData(
      repository,
      () =>
        before && after
          ? Promise.reject(new Error('Choose only one run-history cursor.'))
          : repository.listRunPage(pageRequest),
      { runs: [], newerCursor: null, olderCursor: null },
      (value) => value.runs.length === 0,
      (value) => value.runs.map((run) => run.synthetic),
    ),
    readPublicData(
      repository,
      () => repository.listLeaderboard(),
      [],
      (value) => value.length === 0,
      (value) => value.map((entry) => entry.synthetic),
    ),
  ]);
  const entries = new Map(leaderboardResult.data.map((entry) => [entry.id, entry]));

  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Run history</span>
        <h1>Every public run stays inspectable.</h1>
        <p>
          Complete, coverage-only, and missing-result runs share one timeline. Missing evidence
          stays visible and never becomes an invented score.
        </p>
      </div>
      <ReadStateNote result={runsResult} />
      {runsResult.state === 'unavailable' || runsResult.state === 'empty' ? null : (
        <div
          className="table-scroll run-history"
          role="region"
          aria-label="Public run history"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Configuration</th>
                <th scope="col">Completeness</th>
                <th scope="col">Coverage</th>
                <th scope="col">Failed</th>
                <th scope="col">Missing</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {runsResult.data.runs.map((run) => {
                const entry = entries.get(run.entryId);
                const completeness = classifyRunSummaryCompleteness(run);
                const summary = run.resultSummary;
                return (
                  <tr key={run.id}>
                    <td>
                      <time dateTime={run.startedAt}>
                        {new Date(run.startedAt).toLocaleDateString()}
                      </time>
                    </td>
                    <td>
                      <strong>
                        {entry ? `${entry.modelFamily} · ${entry.reasoningTier}` : run.entryId}
                      </strong>
                      <small>{entry?.modelName ?? 'Public matrix identity'}</small>
                    </td>
                    <td>{completeness.label}</td>
                    <td>
                      {summary.coveragePercent === null
                        ? 'Not reported'
                        : `${summary.coveragePercent.toFixed(1)}%`}
                    </td>
                    <td>{summary.failed}</td>
                    <td>{summary.missing}</td>
                    <td>
                      <Link href={`/runs/${run.id}`}>Inspect run</Link>
                      <small>{run.synthetic ? 'Synthetic seed' : 'Published'}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {runsResult.state === 'unavailable' || runsResult.state === 'empty' ? null : (
        <nav className="history-pagination" aria-label="Run history pages">
          {runsResult.data.newerCursor ? (
            <Link href={`/runs?after=${encodeURIComponent(runsResult.data.newerCursor)}`}>
              ← Newer runs
            </Link>
          ) : (
            <span aria-disabled="true">← Newer runs</span>
          )}
          {runsResult.data.olderCursor ? (
            <Link href={`/runs?before=${encodeURIComponent(runsResult.data.olderCursor)}`}>
              Older runs →
            </Link>
          ) : (
            <span aria-disabled="true">Older runs →</span>
          )}
        </nav>
      )}
    </section>
  );
}
