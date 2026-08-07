import type { Metadata } from 'next';
import Link from 'next/link';

import { CompareExplorer } from '../../components/compare-explorer.tsx';
import { ReadStateNote } from '../../components/read-state-note.tsx';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
import { isScoredLeaderboardEntry } from '../../data/types.ts';
import { createPageMetadata } from '../site-metadata.ts';

export const metadata: Metadata = createPageMetadata({
  title: 'Compare',
  path: '/compare',
  description: 'Compare exact AIQ model and reasoning configurations with their public evidence.',
});
export const dynamic = 'force-dynamic';

export default async function ComparePage() {
  const repository = createAiqRepository();
  const result = await readPublicData(
    repository,
    () => repository.listLeaderboard(),
    [],
    (value) => value.length === 0,
    (value) => value.map((entry) => entry.synthetic),
  );
  const selectedRunIds = [
    ...new Set(
      result.data.flatMap((entry) => (isScoredLeaderboardEntry(entry) ? [entry.runId] : [])),
    ),
  ];
  const [runSummaries, efficiency] = await Promise.all([
    readPublicData(
      repository,
      () => repository.listRunSummaries(selectedRunIds),
      [],
      (value) => value.length === 0,
      (value) => value.map((run) => run.synthetic),
    ),
    readPublicData(
      repository,
      () => repository.listModelEfficiency(selectedRunIds),
      [],
      (value) => value.length === 0,
      (value) => value.map(() => false),
    ),
  ]);
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Side by side</span>
        <h1>Compare configurations</h1>
        <p>
          Select any two model and reasoning configurations. Compare capability first, then inspect
          coverage, reliability, time, and API-equivalent cost.
        </p>
      </div>
      {result.state === 'unavailable' ? (
        <ReadStateNote result={result} subject="Comparison" />
      ) : null}
      {runSummaries.state === 'unavailable' ? (
        <ReadStateNote result={runSummaries} subject="Selected run context" />
      ) : null}
      {efficiency.state === 'unavailable' ? (
        <ReadStateNote result={efficiency} subject="Selected efficiency" />
      ) : null}
      {result.state === 'unavailable' ? null : (
        <CompareExplorer
          entries={result.data}
          runSummaries={runSummaries.data}
          efficiency={efficiency.data}
        />
      )}
      <details className="evidence-notes">
        <summary>
          <strong>Evidence notes</strong>
          <span>How to interpret time, cost, and uncertainty</span>
        </summary>
        <div className="evidence-note-body">
          <ReadStateNote result={result} subject="Comparison" />
          <p className="fine-print">
            AIQ remains the primary score. Adapter elapsed and estimated Standard API-equivalent
            token cost are separate, coverage-qualified dimensions; AIQ does not combine them into
            one rank. Summed cell time can overlap. Missing values remain unavailable, never zero.{' '}
            <Link href="/calibrations">Inspect calibration evidence</Link>.
          </p>
        </div>
      </details>
    </section>
  );
}
