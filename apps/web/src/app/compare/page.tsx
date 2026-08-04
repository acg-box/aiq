import type { Metadata } from 'next';
import Link from 'next/link';

import { CompareExplorer } from '../../components/compare-explorer.tsx';
import { OfficialEfficiencyTable } from '../../components/official-efficiency-table.tsx';
import { ReadStateNote } from '../../components/read-state-note.tsx';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
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
  const currentOfficialRunIds = [
    ...new Set(
      result.data.flatMap((entry) =>
        entry.scoreStatus === 'official' && entry.runId ? [entry.runId] : [],
      ),
    ),
  ];
  const efficiency = await readPublicData(
    repository,
    () => repository.listModelEfficiency(currentOfficialRunIds),
    [],
    (value) => value.length === 0,
    (value) => value.map(() => false),
  );
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Comparison studio</span>
        <h1>Configuration comparison</h1>
        <p>
          Compare exact model and reasoning-level pairs. Keep sample size, coverage, runtime issues,
          scoring version, and task-set sensitivity beside each fixed-fixture point estimate. The
          public comparison is descriptive because aggregate leaderboard rows do not contain the
          paired-task evidence required for a statistically supported difference.
        </p>
      </div>
      <ReadStateNote result={result} />
      {result.state === 'unavailable' ? null : <CompareExplorer entries={result.data} />}
      {efficiency.state === 'published' ? <OfficialEfficiencyTable rows={efficiency.data} /> : null}
      <p className="formula-note">
        AIQ remains the primary score. Codex adapter elapsed and estimated Standard API equivalent
        token cost are separate, coverage-qualified dimensions with no combined rank or API-frontier
        claim. Summed cell elapsed can overlap; signed matrix batch wall-clock is counted once.
        Missing cost is unavailable and excluded from any frontier.{' '}
        <Link href="/calibrations">Inspect current efficiency evidence</Link>; unavailable Official
        values are not replaced with zero.
      </p>
    </section>
  );
}
