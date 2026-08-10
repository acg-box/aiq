import type { Metadata } from 'next';
import Link from 'next/link';

import { ConfigurationWorkbench } from '../../components/configuration-workbench-view.tsx';
import { ReadStateNote } from '../../components/read-state-note.tsx';
import { resolveExactEfficiencyRowsWithAvailability } from '../../components/scientific-evidence-resolution.ts';
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
  const exactRows = resolveExactEfficiencyRowsWithAvailability({
    runs: runSummaries.data,
    entries: result.data,
    efficiencyRows: efficiency.data,
    expectedRunIds: selectedRunIds,
  });
  const hasCompleteEvidence =
    exactRows.expectedCount > 0 &&
    exactRows.rows.length === exactRows.expectedCount &&
    exactRows.unavailableCount === 0 &&
    exactRows.rejectedCount === 0;
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">All configurations</span>
        <h1>Compare the complete matrix</h1>
        <p>
          Start with all 17 configurations, then filter any combination of model family, reasoning
          tier, cost evidence, Pareto status, or exact configuration.
        </p>
      </div>
      {result.state === 'unavailable' ? (
        <ReadStateNote result={result} subject="Comparison matrix" />
      ) : null}
      {runSummaries.state === 'unavailable' ? (
        <ReadStateNote result={runSummaries} subject="Selected run context" />
      ) : null}
      {efficiency.state === 'unavailable' ? (
        <ReadStateNote result={efficiency} subject="Selected efficiency" />
      ) : null}
      {hasCompleteEvidence ? <ConfigurationWorkbench rows={exactRows.rows} /> : null}
      {!hasCompleteEvidence && result.state !== 'unavailable' ? (
        <ReadStateNote
          result={{
            state: 'unavailable',
            detail:
              'The exact 17-configuration score, run, and efficiency join is unavailable. No partial comparison is shown.',
          }}
          subject="Comparison workspace"
        />
      ) : null}
      <details className="evidence-notes">
        <summary>
          <strong>Evidence notes</strong>
          <span>How to interpret time, cost, and uncertainty</span>
        </summary>
        <div className="evidence-note-body">
          <ReadStateNote result={result} subject="Comparison matrix" />
          <p className="fine-print">
            Official rows use calibrated ability and its conditional interval. Synthetic rows use
            descriptive quality and task-mix sensitivity and are not Official. Strict pass, adapter
            elapsed, and estimated Standard API-equivalent token cost remain separate,
            coverage-qualified dimensions; AIQ does not combine them into one rank. Summed cell time
            can overlap. Missing values remain unavailable, never zero.{' '}
            <Link href="/calibrations">Inspect calibration evidence</Link>.
          </p>
        </div>
      </details>
    </section>
  );
}
