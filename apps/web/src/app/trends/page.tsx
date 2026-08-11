import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import { SpeedObservationExplorer } from '../../components/speed-observation-explorer.tsx';
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
  const [entriesResult, pointsResult, speedResult, speedTrendResult] = await Promise.all([
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
    readPublicData(
      repository,
      () => repository.listSpeedObservations(),
      [],
      (value) => value.length === 0,
      () => [],
    ),
    readPublicData(
      repository,
      () => repository.listSpeedTrendPoints(range),
      [],
      (value) => value.length === 0,
      () => [],
    ),
  ]);
  const historicalRunIds = pointsResult.data.flatMap((point) =>
    point.runId === null ? [] : [point.runId],
  );
  const [runSummariesResult, efficiencyResult] = await Promise.all([
    readPublicData(
      repository,
      () => repository.listRunSummaries(historicalRunIds),
      [],
      (value) => value.length === 0,
      (value) => value.map((run) => run.synthetic),
    ),
    readPublicData(
      repository,
      () => repository.listModelEfficiency(historicalRunIds),
      [],
      (value) => value.length === 0,
      (value) => value.map(() => false),
    ),
  ]);
  const evidenceStates = [
    entriesResult.state,
    pointsResult.state,
    runSummariesResult.state,
    efficiencyResult.state,
  ];
  const evidenceNeedsAttention = evidenceStates.some(
    (state) => state === 'empty' || state === 'unavailable',
  );
  const evidenceStateSummary = [...new Set(evidenceStates)]
    .map((state) => (state === 'synthetic' ? 'synthetic / seed' : state))
    .join(' + ');
  const observationCount = new Set(pointsResult.data.map((point) => point.recordedAt)).size;
  const isSingleObservation = observationCount === 1;
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">History</span>
        <h1>{isSingleObservation ? 'Latest AIQ snapshot' : 'AIQ over time'}</h1>
        <p>
          {isSingleObservation
            ? 'Compare every published configuration now; trend lines begin after the next Official cycle.'
            : 'Compare AIQ, time, cost, and Normal/Fast measurements across every published run.'}
        </p>
      </div>
      {evidenceNeedsAttention ? <ReadStateNote result={pointsResult} subject="History" /> : null}
      {entriesResult.state !== 'unavailable' && pointsResult.state !== 'unavailable' ? (
        <TrendExplorer
          entries={entriesResult.data}
          points={pointsResult.data}
          runSummaries={runSummariesResult.data}
          efficiency={efficiencyResult.data}
          range={range}
        />
      ) : null}
      <SpeedObservationExplorer
        observations={speedResult.data}
        trendPoints={speedTrendResult.data}
      />
      <details className="evidence-status-disclosure" open={evidenceNeedsAttention}>
        <summary>
          <span>Evidence availability</span>
          <span>{evidenceStateSummary} · 4 sources</span>
        </summary>
        <div className="evidence-status-grid" aria-label="Trend evidence availability">
          <ReadStateNote result={entriesResult} subject="Matrix entries" />
          <ReadStateNote result={pointsResult} subject="Trend points" />
          <ReadStateNote result={runSummariesResult} subject="Historical run context" />
          <ReadStateNote result={efficiencyResult} subject="Historical efficiency" />
        </div>
      </details>
    </section>
  );
}
