import type { Metadata } from 'next';

import { CompareExplorer } from '../../components/compare-explorer.tsx';
import { ReadStateNote } from '../../components/read-state-note.tsx';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';

export const metadata: Metadata = { title: 'Compare' };
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
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Comparison studio</span>
        <h1>One model is not one behavior.</h1>
        <p>
          Compare exact model and reasoning-level pairs. Keep sample size, coverage, failure counts,
          scoring version, and task-set sensitivity beside each fixed-fixture point estimate. The
          public comparison is descriptive because aggregate leaderboard rows do not contain the
          paired-task evidence required for a statistically supported difference.
        </p>
      </div>
      <ReadStateNote result={result} />
      {result.state === 'unavailable' ? null : <CompareExplorer entries={result.data} />}
    </section>
  );
}
