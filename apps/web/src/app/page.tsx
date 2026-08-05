import Link from 'next/link';

import { CalibrationEfficiency } from '../components/calibration-efficiency.tsx';
import { CompactRanking } from '../components/compact-ranking.tsx';
import { DataNote } from '../components/data-note.tsx';
import { EfficiencyPlot } from '../components/efficiency-plot.tsx';
import { LeaderboardTable } from '../components/leaderboard-table.tsx';
import { ModelMatrixChart } from '../components/model-matrix-chart.tsx';
import { OfficialEfficiencyTable } from '../components/official-efficiency-table.tsx';
import { ReadStateNote } from '../components/read-state-note.tsx';
import { RunOutcomeCard } from '../components/run-outcome-card.tsx';
import { ScoreReadout } from '../components/score-readout.tsx';
import {
  EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE,
  resolveExactEfficiencyRowsWithAvailability,
  resolveExactScientificEvidence,
} from '../components/scientific-evidence-resolution.ts';
import { createAiqRepository } from '../data/repository.ts';
import { readPublicData } from '../data/read-state.ts';
import {
  isScoredLeaderboardEntry,
  type BenchmarkRun,
  type BenchmarkRunSummary,
} from '../data/types.ts';
import { formatHumanDuration } from '../data/format-duration.ts';

export const dynamic = 'force-dynamic';

function formatDate(value: string | undefined): string {
  if (!value) return 'date unavailable';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export default async function OverviewPage() {
  const repository = createAiqRepository();
  const [leaderboardResult, calibrationRunsResult, newestRunResult] = await Promise.all([
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
    readPublicData<BenchmarkRunSummary | null>(
      repository,
      () => repository.getNewestCompletedRun(),
      null,
      (value) => value === null,
      (value) => (value ? [value.synthetic] : []),
    ),
  ]);

  const leaderboard = leaderboardResult.data;
  const scoredEntries = leaderboard.filter(isScoredLeaderboardEntry);
  const highestPointEstimate = scoredEntries.toSorted((left, right) => right.score - left.score)[0];
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
        highestPointEstimate?.runId
          ? repository.getRun(highestPointEstimate.runId)
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

  const taskCellCounts = leaderboard.map((entry) => entry.sampleSize);
  const sampleTotal =
    taskCellCounts.length > 0 &&
    taskCellCounts.every((taskCellCount): taskCellCount is number => taskCellCount !== null)
      ? taskCellCounts.reduce((sum, taskCellCount) => sum + taskCellCount, 0)
      : null;
  const coveredEntries = leaderboard.filter((entry) => entry.coveragePercent !== null);
  const averageCoverage =
    coveredEntries.length === 0
      ? null
      : coveredEntries.reduce((sum, entry) => sum + (entry.coveragePercent ?? 0), 0) /
        coveredEntries.length;
  const selectedRun = selectedRunResult.data;
  const newestRetainedRun = newestRunResult.data;
  const highestPointEvidence =
    highestPointEstimate && selectedRun
      ? resolveExactScientificEvidence({
          candidate: {
            runId: highestPointEstimate.runId,
            entryId: highestPointEstimate.id,
            scoringVersion: highestPointEstimate.scoringVersion,
            synthetic: highestPointEstimate.synthetic,
          },
          runs: [selectedRun],
          entries: leaderboard,
          efficiencyRows: officialEfficiencyResult.data,
        })
      : undefined;
  const latestEfficiency =
    highestPointEvidence?.state === 'exact' ? highestPointEvidence.evidence.efficiency : undefined;
  const exactOfficialEfficiency = resolveExactEfficiencyRowsWithAvailability({
    runs: officialRunSummariesResult.data,
    entries: leaderboard,
    efficiencyRows: officialEfficiencyResult.data,
    expectedRunIds: officialRunIds,
  });
  const highestPointIdentityUnavailable =
    highestPointEstimate !== undefined && highestPointEvidence?.state !== 'exact';
  const overviewProvenance =
    leaderboardResult.state === 'synthetic'
      ? 'synthetic'
      : leaderboardResult.state === 'published'
        ? 'published'
        : leaderboardResult.state === 'mixed'
          ? 'mixed'
          : 'unavailable';
  const overviewEyebrow =
    overviewProvenance === 'synthetic'
      ? 'AIQ v1 · synthetic demo matrix'
      : overviewProvenance === 'published'
        ? 'AIQ v1 · latest published matrix'
        : 'AIQ v1 · matrix status';
  const scoreLabel =
    highestPointEstimate?.synthetic === true
      ? 'Highest synthetic AIQ index'
      : 'Highest published AIQ index';

  return (
    <>
      <section className="workspace-hero page-shell">
        <header className="workspace-intro">
          <div>
            <span className="eyebrow">{overviewEyebrow}</span>
            <h1>Benchmark overview</h1>
          </div>
          <p>
            Analyze 17 fixed configurations across score, task-mix sensitivity, coverage, runtime,
            and cost.
          </p>
        </header>
        <CompactRanking entries={leaderboard} />
      </section>

      <section className="page-shell overview-secondary" aria-label="Secondary benchmark snapshot">
        <div className="benchmark-snapshot" aria-label="Latest matrix snapshot">
          <div className="snapshot-estimate">
            {highestPointEstimate ? (
              <ScoreReadout
                score={highestPointEstimate.score}
                label={scoreLabel}
                unit="AIQ index"
              />
            ) : (
              <div
                className="score-readout score-readout-empty"
                role="img"
                aria-label="No published score yet"
              >
                <span>—</span>
                <small>AIQ index · 0–100</small>
              </div>
            )}
            <div>
              <span className="snapshot-label">Highest point estimate</span>
              <strong>
                {highestPointEstimate
                  ? `${highestPointEstimate.modelFamily} / ${highestPointEstimate.reasoningTier}`
                  : 'No published score yet'}
              </strong>
              <small>
                {highestPointEstimate
                  ? `${highestPointEstimate.modelName} · scoring ${highestPointEstimate.scoringVersion} · ${highestPointEstimate.synthetic ? 'synthetic' : 'published'}`
                  : 'Awaiting a complete matrix'}
              </small>
            </div>
          </div>
          <dl className="snapshot-metrics" tabIndex={0} aria-label="Benchmark evidence metrics">
            <div>
              <dt>Task-sensitivity interval</dt>
              <dd>
                {highestPointEstimate
                  ? `${highestPointEstimate.sensitivityLow.toFixed(1)}–${highestPointEstimate.sensitivityHigh.toFixed(1)}`
                  : '—'}
              </dd>
              <dd className="snapshot-note">task-resampling sensitivity</dd>
            </div>
            <div>
              <dt>Coverage</dt>
              <dd>
                {highestPointEstimate ? `${highestPointEstimate.coveragePercent.toFixed(1)}%` : '—'}
              </dd>
              <dd className="snapshot-note">
                {highestPointEstimate?.sampleSize == null
                  ? 'Sample size unavailable'
                  : `${highestPointEstimate.sampleSize} fixed task cells · runtime ${highestPointEstimate.runtimeIssues} · missing ${highestPointEstimate.missing}`}
              </dd>
            </div>
            <div>
              <dt>Newest retained run</dt>
              <dd>
                {newestRetainedRun ? formatDate(newestRetainedRun.completedAt) : 'Unavailable'}
              </dd>
              <dd className="snapshot-note">
                {newestRetainedRun
                  ? newestRetainedRun.synthetic
                    ? 'synthetic seed'
                    : 'published run evidence'
                  : 'No published run evidence'}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {latestEfficiency?.summedCellAdapterElapsedMs == null
                  ? 'Unavailable'
                  : formatHumanDuration(latestEfficiency.summedCellAdapterElapsedMs)}
              </dd>
              <dd className="snapshot-note">summed cell adapter time</dd>
            </div>
            <div>
              <dt>API-equivalent cost</dt>
              <dd>
                {latestEfficiency?.costEstimatorStatus !== 'estimated' ||
                latestEfficiency.standardApiEquivalentUsdNanos == null
                  ? 'Unavailable'
                  : `$${(latestEfficiency.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(2)}`}
              </dd>
              <dd className="snapshot-note">
                Standard API estimate · not billed subscription cost
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="page-shell overview-provenance">
        <DataNote provenance={overviewProvenance} />
        {highestPointIdentityUnavailable ? (
          <ReadStateNote
            result={{
              state: 'unavailable',
              detail: EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE,
            }}
            subject="Highest-point run context"
          />
        ) : null}
      </div>

      <section className="page-shell section-block overview-priority" id="leaderboard">
        <div className="section-heading">
          <div>
            <span className="eyebrow">
              17 configurations ·{' '}
              {sampleTotal === null
                ? 'task cells unavailable'
                : `${sampleTotal.toLocaleString()} task cells`}
            </span>
            <h2>Current configuration matrix</h2>
          </div>
          <p>
            Average coverage across {coveredEntries.length}/17 configurations:{' '}
            {averageCoverage === null ? 'unavailable' : `${averageCoverage.toFixed(1)}%`}. Compare
            coverage-qualified scores by family or encoding.
          </p>
        </div>
        <ReadStateNote result={leaderboardResult} subject="Latest matrix" />
        <ModelMatrixChart entries={leaderboard} />
        {selectedRun ? (
          <RunOutcomeCard run={selectedRun} />
        ) : (
          <ReadStateNote result={selectedRunResult} subject="Highlighted run outcomes" />
        )}
        {officialRunSummariesResult.state === 'unavailable' ? (
          <ReadStateNote result={officialRunSummariesResult} subject="Efficiency run context" />
        ) : null}
        <EfficiencyPlot
          entries={leaderboard}
          runSummaries={officialRunSummariesResult.data}
          rows={officialEfficiencyResult.data}
        />
        <details className="leaderboard-disclosure">
          <summary>Show all {leaderboard.length} configurations and intervals</summary>
          <LeaderboardTable entries={leaderboard} />
        </details>
      </section>

      <section
        className="page-shell section-block compact-insights"
        aria-labelledby="efficiency-heading"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">Secondary evidence</span>
            <h2 id="efficiency-heading">Time and cost, kept separate</h2>
          </div>
          <p>
            Inspect runner-observed adapter time and verifier-recomputed API-equivalent cost as
            separate measures.
          </p>
        </div>
        <ReadStateNote result={officialEfficiencyResult} subject="Official efficiency" />
        {officialEfficiencyResult.state === 'published' ? (
          <details className="evidence-disclosure">
            <summary>Open time, token, and cost details</summary>
            <OfficialEfficiencyTable
              rows={exactOfficialEfficiency.rows}
              expectedCount={exactOfficialEfficiency.expectedCount}
              unavailableCount={exactOfficialEfficiency.unavailableCount}
              rejectedCount={exactOfficialEfficiency.rejectedCount}
            />
          </details>
        ) : null}
      </section>

      <section
        className="page-shell section-block compact-insights"
        aria-labelledby="calibration-heading"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">Separate diagnostic evidence</span>
            <h2 id="calibration-heading">Latest verified calibration</h2>
          </div>
          <p>
            Inspect replay-verified evaluator checks. Calibration remains non-Official and
            non-ranking.
          </p>
        </div>
        <ReadStateNote result={calibrationRunsResult} subject="Latest calibration" />
        {latestCalibration ? (
          <details className="evidence-disclosure">
            <summary>
              Open {latestCalibration.selectedModelCount} × {latestCalibration.selectedTaskCount}{' '}
              calibration evidence
            </summary>
            <dl className="calibration-facts">
              <div>
                <dt>Verified run</dt>
                <dd>{latestCalibration.id}</dd>
              </div>
              <div>
                <dt>Matrix</dt>
                <dd>
                  {latestCalibration.selectedModelCount} configurations ×{' '}
                  {latestCalibration.selectedTaskCount} tasks
                </dd>
              </div>
              <div>
                <dt>Published</dt>
                <dd>
                  <time dateTime={latestCalibration.publishedAt}>
                    {new Date(latestCalibration.publishedAt).toLocaleString()}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Classification</dt>
                <dd>Untrusted · not Official · not ranking eligible</dd>
              </div>
              <div>
                <dt>Scoring</dt>
                <dd>{latestCalibration.scoringVersion || 'Unavailable'}</dd>
              </div>
            </dl>
            <ReadStateNote result={calibrationScoresResult} subject="Calibration score matrix" />
            {calibrationScoresResult.state === 'unavailable' ||
            calibrationScoresResult.state === 'empty' ? null : (
              <CalibrationEfficiency
                scores={calibrationScoresResult.data}
                scoringVersion={latestCalibration.scoringVersion || null}
              />
            )}
            <Link className="text-link" href={`/calibrations/${latestCalibration.id}`}>
              Inspect calibration subsets <span aria-hidden="true">→</span>
            </Link>
          </details>
        ) : null}
      </section>

      <section className="page-shell split-cta">
        <div>
          <span className="eyebrow">Compare behavior</span>
          <h2>Compare two configurations.</h2>
          <p>Inspect score, interval, coverage, runtime, duration, and cost.</p>
          <Link className="text-link" href="/compare">
            Open comparison <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div>
          <span className="eyebrow">Keep the history</span>
          <h2>Inspect score history.</h2>
          <p>Trace retained runs with coverage, missing cells, duration, and cost.</p>
          <Link className="text-link" href="/trends">
            Explore trends <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>
    </>
  );
}
