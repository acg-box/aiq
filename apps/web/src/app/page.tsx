import { BookOpenTextIcon } from '@phosphor-icons/react/dist/ssr/BookOpenText';
import Link from 'next/link';
import { Suspense } from 'react';

import { CompactRanking } from '../components/compact-ranking.tsx';
import { ConfigurationWorkbench } from '../components/configuration-workbench-view.tsx';
import { DataNote } from '../components/data-note.tsx';
import {
  DeferredCalibrationEfficiency,
  DeferredModelMatrixChart,
} from '../components/homepage-analytics.tsx';
import { LeaderboardTable } from '../components/leaderboard-table.tsx';
import { OfficialEfficiencyTable } from '../components/official-efficiency-table.tsx';
import { ReadStateNote } from '../components/read-state-note.tsx';
import { RunOutcomeCard } from '../components/run-outcome-card.tsx';
import {
  EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE,
  resolveExactEfficiencyRowsWithAvailability,
  resolveExactScientificEvidence,
} from '../components/scientific-evidence-resolution.ts';
import { formatHumanDuration } from '../data/format-duration.ts';
import { presentLeaderboardEntry } from '../data/leaderboard-presentation.ts';
import { createAiqRepository } from '../data/repository.ts';
import { readPublicData } from '../data/read-state.ts';
import { isScoredLeaderboardEntry, type BenchmarkRun } from '../data/types.ts';
import MethodPage from './method/page.tsx';
import RadarPage from './radar/page.tsx';
import RunsPage from './runs/page.tsx';
import TrendsPage from './trends/page.tsx';

export const dynamic = 'force-dynamic';

function formatDate(value: string | undefined): string {
  if (!value) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

type WorkspaceSearchParams = {
  after?: string;
  before?: string;
  range?: string;
};

function WorkspaceSectionLoading({ label }: { label: string }) {
  return (
    <p className="workspace-section-loading" role="status">
      Loading {label}…
    </p>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<WorkspaceSearchParams>;
}) {
  const repository = createAiqRepository();
  const [leaderboardResult, calibrationRunsResult] = await Promise.all([
    readPublicData(
      repository,
      () => repository.listLeaderboard(),
      [],
      (value) => value.length === 0,
      (value) => value.map((entry) => entry.synthetic),
    ),
    readPublicData(
      repository,
      () => repository.listCalibrationRunPage(),
      { runs: [], newerCursor: null, olderCursor: null },
      (value) => value.runs.length === 0,
      (value) => value.runs.map((run) => run.synthetic),
    ),
  ]);

  const leaderboard = leaderboardResult.data;
  const scoredEntries = leaderboard.filter(isScoredLeaderboardEntry);
  const officialEntries = scoredEntries.filter((entry) => entry.scoreStatus === 'official');
  const rankedEntries = (officialEntries.length > 0 ? officialEntries : scoredEntries).toSorted(
    (left, right) => right.score - left.score,
  );
  const selectedDescriptiveEstimate = rankedEntries[0];
  const latestCalibration = calibrationRunsResult.data.runs[0];
  const officialRunIds = leaderboard.flatMap((entry) =>
    entry.scoreStatus === 'official' && entry.runId ? [entry.runId] : [],
  );

  const [
    selectedRunResult,
    officialRunSummariesResult,
    officialEfficiencyResult,
    calibrationScoresResult,
  ] = await Promise.all([
    readPublicData<BenchmarkRun | null>(
      repository,
      () =>
        selectedDescriptiveEstimate?.runId
          ? repository.getRun(selectedDescriptiveEstimate.runId)
          : Promise.resolve(null),
      null,
      (value) => value === null,
      (value) => (value ? [value.synthetic] : []),
    ),
    readPublicData(
      repository,
      () => repository.listRunSummaries(officialRunIds),
      [],
      (value) => value.length === 0,
      (value) => value.map((run) => run.synthetic),
    ),
    readPublicData(
      repository,
      () => repository.listModelEfficiency(officialRunIds),
      [],
      (value) => value.length === 0,
      (value) => value.map(() => false),
    ),
    readPublicData(
      repository,
      () =>
        latestCalibration
          ? repository.listCalibrationScores(latestCalibration.id)
          : Promise.resolve([]),
      [],
      (value) => value.length === 0,
      (value) => value.map((score) => score.synthetic),
    ),
  ]);

  const selectedRun = selectedRunResult.data;
  const selectedEstimateEvidence =
    selectedDescriptiveEstimate && selectedRun
      ? resolveExactScientificEvidence({
          candidate: {
            runId: selectedDescriptiveEstimate.runId,
            entryId: selectedDescriptiveEstimate.id,
            scoringVersion: selectedDescriptiveEstimate.scoringVersion,
            synthetic: selectedDescriptiveEstimate.synthetic,
          },
          runs: [selectedRun],
          entries: leaderboard,
          efficiencyRows: officialEfficiencyResult.data,
        })
      : undefined;
  const highlightedRun =
    selectedEstimateEvidence?.state === 'exact' ? selectedEstimateEvidence.run : undefined;
  const highlightedScore =
    selectedEstimateEvidence?.state === 'exact'
      ? selectedEstimateEvidence.evidence.score
      : undefined;
  const highlightedEfficiency =
    selectedEstimateEvidence?.state === 'exact'
      ? selectedEstimateEvidence.evidence.efficiency
      : undefined;
  const highlightedPresentation = highlightedScore
    ? presentLeaderboardEntry(highlightedScore)
    : null;
  const exactOfficialEfficiency = resolveExactEfficiencyRowsWithAvailability({
    runs: officialRunSummariesResult.data,
    entries: leaderboard,
    efficiencyRows: officialEfficiencyResult.data,
    expectedRunIds: officialRunIds,
  });
  const selectedEstimateIdentityUnavailable =
    selectedDescriptiveEstimate !== undefined &&
    (selectedEstimateEvidence?.state !== 'exact' || highlightedScore === undefined);
  const overviewProvenance =
    leaderboardResult.state === 'synthetic'
      ? 'synthetic'
      : leaderboardResult.state === 'published'
        ? 'published'
        : leaderboardResult.state === 'mixed'
          ? 'mixed'
          : 'unavailable';
  const benchmarkLabel =
    overviewProvenance === 'synthetic' ? 'Synthetic benchmark' : 'Latest benchmark';
  const taskCount = highlightedScore?.sampleSize ?? selectedDescriptiveEstimate?.sampleSize;
  const cost =
    highlightedEfficiency?.costEstimatorStatus === 'estimated' &&
    highlightedEfficiency.standardApiEquivalentUsdNanos !== null
      ? `$${(highlightedEfficiency.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(2)}`
      : 'Unavailable';
  const hasEfficiencyEvidence =
    exactOfficialEfficiency.expectedCount > 0 &&
    exactOfficialEfficiency.rows.length === exactOfficialEfficiency.expectedCount &&
    exactOfficialEfficiency.unavailableCount === 0 &&
    exactOfficialEfficiency.rejectedCount === 0;

  return (
    <div className="page-shell results-page one-page-workspace">
      <section
        className="workspace-overview"
        id="results"
        data-workspace-section
        data-nav-section="results"
      >
        <header className="benchmark-strip">
          <div>
            <h1>{benchmarkLabel}</h1>
            <p>
              {leaderboard.length} configurations
              {taskCount === null || taskCount === undefined
                ? ''
                : ` · ${taskCount} tasks each`} ·{' '}
              {highlightedRun
                ? `Published ${formatDate(highlightedRun.completedAt)}`
                : 'Publication pending'}
            </p>
          </div>
          <Link className="text-link" href="#method">
            How AIQ works <span aria-hidden="true">→</span>
          </Link>
        </header>

        {hasEfficiencyEvidence ? (
          <ConfigurationWorkbench rows={exactOfficialEfficiency.rows} />
        ) : (
          <div className="results-main-grid" id="compare">
            <section className="analysis-panel efficiency-panel" aria-label="Score comparison">
              <DeferredModelMatrixChart entries={leaderboard} eager />
              {rankedEntries.length === 0 && leaderboard.length > 0 ? (
                <details className="data-disclosure empty-matrix-table">
                  <summary>Read all configuration values as a table</summary>
                  <LeaderboardTable entries={leaderboard} />
                </details>
              ) : null}
            </section>
            <CompactRanking entries={leaderboard} />
          </div>
        )}

        {highlightedRun ? (
          <RunOutcomeCard run={highlightedRun} />
        ) : selectedEstimateIdentityUnavailable ? (
          <ReadStateNote
            result={{ state: 'unavailable', detail: EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE }}
            subject="Top configuration domain profile"
          />
        ) : null}

        <details className="evidence-notes" open={leaderboardResult.state === 'unavailable'}>
          <summary>
            <BookOpenTextIcon aria-hidden="true" size={20} />
            <strong>Evidence notes</strong>
            <span>Scoring, sensitivity, provenance, time, and cost</span>
          </summary>
          <div className="evidence-note-body">
            <div className="evidence-note-grid">
              <div>
                <h2>What this page claims</h2>
                <p>
                  Official AIQ is a versioned 0–100 calibrated ability estimate. Its conditional 95%
                  interval holds the estimated item bank fixed. Quality score, task-mix sensitivity,
                  strict pass, time, and cost remain separate diagnostics. Synthetic previews expose
                  quality only and are never ranked as Official.
                </p>
              </div>
              <dl>
                <div>
                  <dt>Scoring version</dt>
                  <dd>{highlightedScore?.scoringVersion ?? 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Strict pass</dt>
                  <dd>
                    {highlightedPresentation
                      ? `${highlightedPresentation.strictPassRate} · Wilson 95% ${highlightedPresentation.strictPassInterval}`
                      : 'Unavailable'}
                  </dd>
                </div>
                <div>
                  <dt>Quality / task mix</dt>
                  <dd>
                    {highlightedPresentation
                      ? `${highlightedPresentation.qualityScore} · ${highlightedPresentation.sensitivityInterval}`
                      : 'Unavailable'}
                  </dd>
                </div>
                <div>
                  <dt>Summed adapter time</dt>
                  <dd>
                    {highlightedEfficiency?.summedCellAdapterElapsedMs == null
                      ? 'Unavailable'
                      : formatHumanDuration(highlightedEfficiency.summedCellAdapterElapsedMs)}
                  </dd>
                </div>
                <div>
                  <dt>API-equivalent cost</dt>
                  <dd>{cost}</dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>
                    {highlightedRun?.synthetic
                      ? 'Synthetic seed'
                      : highlightedRun
                        ? 'Published'
                        : 'Unavailable'}
                  </dd>
                </div>
              </dl>
            </div>
            <DataNote provenance={overviewProvenance} />
            <DataNote provenance={overviewProvenance} subject="Comparison matrix" />
            <ReadStateNote result={officialEfficiencyResult} subject="Official efficiency" />
            {selectedEstimateIdentityUnavailable ? (
              <ReadStateNote
                result={{ state: 'unavailable', detail: EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE }}
                subject="Top estimate run context"
              />
            ) : null}
            {highlightedRun ? (
              <p className="fine-print">
                Exact run <Link href={`/runs/${highlightedRun.id}`}>{highlightedRun.id}</Link> ·
                API-equivalent cost is a verifier-recomputed estimate, not billed subscription
                spend.
              </p>
            ) : null}
            {officialEfficiencyResult.state === 'published' ? (
              <details className="data-disclosure">
                <summary>Time, token, and cost table</summary>
                <OfficialEfficiencyTable
                  rows={exactOfficialEfficiency.rows}
                  expectedCount={exactOfficialEfficiency.expectedCount}
                  unavailableCount={exactOfficialEfficiency.unavailableCount}
                  rejectedCount={exactOfficialEfficiency.rejectedCount}
                />
              </details>
            ) : null}
            {latestCalibration ? (
              <details className="data-disclosure">
                <summary>Latest non-ranking calibration evidence</summary>
                <ReadStateNote result={calibrationRunsResult} subject="Calibration" />
                {calibrationScoresResult.state === 'unavailable' ||
                calibrationScoresResult.state === 'empty' ? null : (
                  <DeferredCalibrationEfficiency
                    scores={calibrationScoresResult.data}
                    scoringVersion={latestCalibration.scoringVersion || null}
                  />
                )}
                <Link className="text-link" href={`/calibrations/${latestCalibration.id}`}>
                  Inspect calibration <span aria-hidden="true">→</span>
                </Link>
              </details>
            ) : null}
          </div>
        </details>
      </section>

      <div
        className="workspace-section"
        id="trends"
        data-workspace-section
        data-nav-section="trends"
      >
        <Suspense fallback={<WorkspaceSectionLoading label="history" />}>
          <TrendsPage searchParams={searchParams} />
        </Suspense>
      </div>

      <div
        className="workspace-section"
        id="runs"
        data-workspace-section
        data-nav-section="evidence"
      >
        <Suspense fallback={<WorkspaceSectionLoading label="run evidence" />}>
          <RunsPage searchParams={searchParams} />
        </Suspense>
      </div>

      <div
        className="workspace-section"
        id="method"
        data-workspace-section
        data-nav-section="evidence"
      >
        <Suspense fallback={<WorkspaceSectionLoading label="method" />}>
          <MethodPage />
        </Suspense>
      </div>

      <div
        className="workspace-section"
        id="radar"
        data-workspace-section
        data-nav-section="evidence"
      >
        <Suspense fallback={<WorkspaceSectionLoading label="radar evidence" />}>
          <RadarPage />
        </Suspense>
      </div>
    </div>
  );
}
