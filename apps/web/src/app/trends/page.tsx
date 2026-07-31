import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import { TrendExplorer } from '../../components/trend-explorer.tsx';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';

export const metadata: Metadata = { title: 'Trends' };
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
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Longitudinal evidence</span>
        <h1>The past remains part of the record.</h1>
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
    </section>
  );
}
