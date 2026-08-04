import Link from 'next/link';

import { CalibrationEfficiency } from '../components/calibration-efficiency.tsx';
import { DataNote } from '../components/data-note.tsx';
import { EfficiencyPlot } from '../components/efficiency-plot.tsx';
import { LeaderboardTable } from '../components/leaderboard-table.tsx';
import { ModelMatrixChart } from '../components/model-matrix-chart.tsx';
import { OfficialEfficiencyTable } from '../components/official-efficiency-table.tsx';
import { ReadStateNote } from '../components/read-state-note.tsx';
import { RunOutcomeCard } from '../components/run-outcome-card.tsx';
import { ScoreReadout } from '../components/score-readout.tsx';
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
  const [selectedRunResult, officialEfficiencyResult, calibrationScoresResult] = await Promise.all([
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
  const latestEfficiency = officialEfficiencyResult.data.find(
    (row) => row.runId === highestPointEstimate?.runId,
  );
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
            17 model and reasoning configurations, with score, uncertainty, coverage, runtime, cost,
            and task evidence kept together.
          </p>
        </header>
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
              <small>{highestPointEstimate?.modelName ?? 'Awaiting a complete matrix'}</small>
            </div>
          </div>
          <dl className="snapshot-metrics" tabIndex={0} aria-label="Benchmark evidence metrics">
            <div>
              <dt>Task-sensitivity interval</dt>
              <dd>
                {highestPointEstimate
                  ? `${highestPointEstimate.ciLow.toFixed(1)}–${highestPointEstimate.ciHigh.toFixed(1)}`
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
                  : `${highestPointEstimate.sampleSize} fixed task cells`}
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
                {latestEfficiency?.standardApiEquivalentUsdNanos == null
                  ? 'Unavailable'
                  : `$${(latestEfficiency.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(2)}`}
              </dd>
              <dd className="snapshot-note">Standard pricing estimate</dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="page-shell overview-provenance">
        <DataNote provenance={overviewProvenance} />
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
            Average coverage{' '}
            {averageCoverage === null ? 'unavailable' : `${averageCoverage.toFixed(1)}%`}. Filter by
            model family or change the visual encoding without changing the underlying evidence.
          </p>
        </div>
        <ReadStateNote result={leaderboardResult} subject="Latest matrix" />
        <ModelMatrixChart entries={leaderboard} />
        {selectedRun ? <RunOutcomeCard run={selectedRun} /> : null}
        <EfficiencyPlot entries={leaderboard} rows={officialEfficiencyResult.data} />
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
            These measurements describe the run, not the AIQ index. API-equivalent cost is a
            comparison estimate and is never presented as ChatGPT subscription spend.
          </p>
        </div>
        <ReadStateNote result={officialEfficiencyResult} subject="Official efficiency" />
        {officialEfficiencyResult.state === 'published' ? (
          <details className="evidence-disclosure">
            <summary>Open time, token, and cost details</summary>
            <OfficialEfficiencyTable rows={officialEfficiencyResult.data} />
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
            Calibration replay is useful for checking the evaluator, but it is not Official and
            never changes the public ranking.
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
          <h2>Same matrix, different trade-offs.</h2>
          <p>Select two exact configurations and keep their intervals and evidence together.</p>
          <Link className="text-link" href="/compare">
            Open comparison <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div>
          <span className="eyebrow">Keep the history</span>
          <h2>Watch the index over time.</h2>
          <p>Switch between line and bar views without losing the retained run record.</p>
          <Link className="text-link" href="/trends">
            Explore trends <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>
    </>
  );
}
