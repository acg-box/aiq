import type { Metadata } from 'next';
import Link from 'next/link';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import { RunScientificSummaryPanel } from '../../components/run-scientific-summary.tsx';
import { resolveExactScientificEvidence } from '../../components/scientific-evidence-resolution.ts';
import { buildRunScientificSummary } from '../../components/scientific-score-context.ts';
import { classifyRunSummaryCompleteness } from '../../data/format.ts';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
import { createPageMetadata } from '../site-metadata.ts';

export const metadata: Metadata = createPageMetadata({
  title: 'Run history',
  path: '/runs',
  description:
    'Inspect the public history of complete, coverage-only, and missing-result AIQ configuration runs.',
});
export const dynamic = 'force-dynamic';

type RunsSearchParams = { before?: string; after?: string };

function historyHref(parameter: 'after' | 'before', cursor: string): string {
  return `/?${parameter}=${encodeURIComponent(cursor)}#runs`;
}

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
  const efficiencyResult = await readPublicData(
    repository,
    () => repository.listModelEfficiency(runsResult.data.runs.map((run) => run.id)),
    [],
    (value) => value.length === 0,
    (value) => value.map(() => false),
  );
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Evidence archive</span>
        <h1>Run archive</h1>
        <p>
          Each row is one model configuration. One complete benchmark batch contains 17 runs × 72
          tasks: 1,224 task attempts, not 1,224 benchmark runs.
        </p>
      </div>
      <ReadStateNote result={runsResult} subject="Run archive" />
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
                <th scope="col">Scientific summary</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {runsResult.data.runs.map((run) => {
                const entry = entries.get(run.entryId);
                const completeness = classifyRunSummaryCompleteness(run);
                const summary = run.resultSummary;
                const evidence = resolveExactScientificEvidence({
                  candidate: {
                    runId: run.id,
                    entryId: run.entryId,
                    scoringVersion: run.scoringVersion,
                    synthetic: run.synthetic,
                  },
                  runs: runsResult.data.runs,
                  entries: leaderboardResult.data,
                  efficiencyRows: efficiencyResult.data,
                });
                return (
                  <tr key={run.id}>
                    <td data-label="Started">
                      <time dateTime={run.startedAt}>
                        {new Date(run.startedAt).toLocaleDateString()}
                      </time>
                    </td>
                    <td data-label="Configuration">
                      <strong>
                        {entry ? `${entry.modelFamily} · ${entry.reasoningTier}` : run.entryId}
                      </strong>
                      <small>{entry?.modelName ?? 'Public matrix identity'}</small>
                    </td>
                    <td data-label="Scientific summary">
                      <strong>{completeness.label}</strong>
                      <RunScientificSummaryPanel
                        compact
                        summary={buildRunScientificSummary({
                          run,
                          resultSummary: summary,
                          leaderboardEntry:
                            evidence.state === 'exact' ? evidence.evidence.score : undefined,
                          efficiency:
                            evidence.state === 'exact' ? evidence.evidence.efficiency : undefined,
                        })}
                      />
                    </td>
                    <td data-label="Evidence">
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
            <Link href={historyHref('after', runsResult.data.newerCursor)}>← Newer runs</Link>
          ) : (
            <span aria-disabled="true">← Newer runs</span>
          )}
          {runsResult.data.olderCursor ? (
            <Link href={historyHref('before', runsResult.data.olderCursor)}>Older runs →</Link>
          ) : (
            <span aria-disabled="true">Older runs →</span>
          )}
        </nav>
      )}
    </section>
  );
}
