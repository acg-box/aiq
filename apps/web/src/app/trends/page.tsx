import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import { OfficialEfficiencyTable } from '../../components/official-efficiency-table.tsx';
import { TrendExplorer } from '../../components/trend-explorer.tsx';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
import { createPageMetadata } from '../site-metadata.ts';

export const metadata: Metadata = createPageMetadata({
  title: 'Trends',
  path: '/trends',
  description:
    'Follow retained AIQ fixed-fixture observations and sensitivity intervals over time.',
});
export const dynamic = 'force-dynamic';

import type { TrendRange } from '../../data/types.ts';

function isTrendRange(value: string | undefined): value is TrendRange {
  return value === 'day' || value === 'week' || value === 'month' || value === 'all';
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const requestedRange = (await searchParams).range;
  if (requestedRange !== undefined && !isTrendRange(requestedRange)) {
    notFound();
  }
  const range: TrendRange = requestedRange ?? 'all';
  const repository = createAiqRepository();
  const [entriesResult, pointsResult] = await Promise.all([
    readPublicData(
      repository,
      () => repository.listLeaderboard(),
      [],
      (value) => value.length === 0,
      (value) => value.map((entry) => entry.synthetic),
    ),
    readPublicData(
      repository,
      () => repository.listTrendPoints(range),
      [],
      (value) => value.length === 0,
      (value) => value.map((point) => point.synthetic),
    ),
  ]);
  const historicalRunIds = pointsResult.data.flatMap((point) =>
    point.runId === null ? [] : [point.runId],
  );
  const efficiencyResult = await readPublicData(
    repository,
    () => repository.listModelEfficiency(historicalRunIds),
    [],
    (value) => value.length === 0,
    (value) => value.map(() => false),
  );
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Longitudinal evidence</span>
        <h1>Benchmark history</h1>
        <p>
          Follow published fixed-fixture observations from the last day through all retained
          history. Each point carries its task count and task-resampling sensitivity interval.
        </p>
      </div>
      <ReadStateNote result={entriesResult} subject="Matrix entries" />
      <ReadStateNote result={pointsResult} subject="Trend points" />
      {entriesResult.state !== 'unavailable' && pointsResult.state !== 'unavailable' ? (
        <TrendExplorer entries={entriesResult.data} points={pointsResult.data} range={range} />
      ) : null}
      <section className="run-section" aria-labelledby="trend-efficiency-heading">
        <div className="section-heading compact">
          <div>
            <span className="eyebrow">Historical efficiency</span>
            <h2 id="trend-efficiency-heading">Time and API-equivalent cost by retained point</h2>
          </div>
          <p>
            Each row binds the exact Official run selected for a score bucket. Missing evidence
            stays unavailable. Summed cell adapter durations can overlap; each signed matrix batch
            wall-clock is shown once for its configurations.
          </p>
        </div>
        <ReadStateNote result={efficiencyResult} subject="Historical efficiency" />
        {efficiencyResult.state === 'published' ? (
          <OfficialEfficiencyTable rows={efficiencyResult.data} />
        ) : null}
      </section>
    </section>
  );
}
