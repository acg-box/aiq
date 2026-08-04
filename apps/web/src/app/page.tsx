import Link from 'next/link';

import { CalibrationEfficiency } from '../components/calibration-efficiency.tsx';
import { DataNote } from '../components/data-note.tsx';
import { LeaderboardTable } from '../components/leaderboard-table.tsx';
import { ModelMatrixChart } from '../components/model-matrix-chart.tsx';
import { OfficialEfficiencyTable } from '../components/official-efficiency-table.tsx';
import { ReadStateNote } from '../components/read-state-note.tsx';
import { RunOutcomeCard } from '../components/run-outcome-card.tsx';
import { ScoreRing } from '../components/score-ring.tsx';
import { createAiqRepository } from '../data/repository.ts';
import { readPublicData } from '../data/read-state.ts';
import {
  isScoredLeaderboardEntry,
  type BenchmarkRun,
  type LeaderboardEntry,
} from '../data/types.ts';
import { summarizeRunOutcomes } from '../data/format.ts';

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

function scoreRange(entries: readonly LeaderboardEntry[]) {
  const scored = entries.filter(isScoredLeaderboardEntry);
  if (scored.length === 0) return null;
  const scores = scored.map((entry) => entry.score);
  return { low: Math.min(...scores), high: Math.max(...scores) };
}

export default async function OverviewPage() {
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
  const highestPointEstimate = scoredEntries.toSorted((left, right) => right.score - left.score)[0];
  const latestCalibration = calibrationRunsResult.data.runs[0];
  const officialRunIds = leaderboard.flatMap((entry) =>
    entry.scoreStatus === 'official' && entry.runId ? [entry.runId] : [],
  );
  const [latestRunResult, officialEfficiencyResult, calibrationScoresResult] = await Promise.all([
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

  const sampleTotal = leaderboard.reduce((sum, entry) => sum + (entry.sampleSize ?? 0), 0);
  const coveredEntries = leaderboard.filter((entry) => entry.coveragePercent !== null);
  const averageCoverage =
    coveredEntries.length === 0
      ? null
      : coveredEntries.reduce((sum, entry) => sum + (entry.coveragePercent ?? 0), 0) /
        coveredEntries.length;
  const latestRun = latestRunResult.data;
  const latestOutcomes = latestRun ? summarizeRunOutcomes(latestRun) : null;
  const range = scoreRange(leaderboard);
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
      <section className="hero page-shell">
        <div className="hero-copy">
          <span className="eyebrow">{overviewEyebrow}</span>
          <h1>
            What can a model <em>actually do?</em>
          </h1>
          <p>
            Start with the latest 17-configuration snapshot. Then inspect the task outcomes, domain
            balance, time, and cost behind every point.
          </p>
          <div className="hero-actions">
            <Link className="button primary" href="#leaderboard">
              See the latest matrix
            </Link>
            <Link className="button secondary" href="/compare">
              Compare configurations
            </Link>
          </div>
          <p className="hero-note">
            AIQ is a fixed-fixture task index from 0–100, not an IQ estimate or a claim about
            general intelligence.
          </p>
        </div>
        <div className="hero-score" aria-label="Latest matrix snapshot">
          {highestPointEstimate ? (
            <ScoreRing score={highestPointEstimate.score} label={scoreLabel} unit="AIQ index" />
          ) : (
            <div className="score-ring score-ring-empty" aria-label="No published score yet">
              <span>—</span>
              <small>AIQ index</small>
            </div>
          )}
          <div className="hero-score-copy">
            <span className="eyebrow">
              {overviewProvenance === 'synthetic'
                ? 'Synthetic demo snapshot'
                : 'Latest matrix snapshot'}
            </span>
            <strong>
              {highestPointEstimate
                ? `${highestPointEstimate.modelFamily} · ${highestPointEstimate.reasoningTier}`
                : 'No published score yet'}
            </strong>
            <small>
              {highestPointEstimate
                ? `${highestPointEstimate.modelName} · ${formatDate(latestRun?.completedAt)}`
                : 'The 17 configurations remain visible until a complete run is verified.'}
            </small>
            <dl className="hero-facts">
              <div>
                <dt>Full / partial credit</dt>
                <dd>{latestOutcomes ? `${latestOutcomes.passed}/${latestOutcomes.total}` : '—'}</dd>
              </div>
              <div>
                <dt>Index range</dt>
                <dd>{range ? `${range.low.toFixed(1)}–${range.high.toFixed(1)}` : '—'}</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section className="signal-strip" aria-label="Index summary">
        <div>
          <span>Configurations</span>
          <strong>{leaderboard.length}</strong>
          <small>6 Sol · 6 Terra · 5 Luna</small>
        </div>
        <div>
          <span>Task cells scored</span>
          <strong>{sampleTotal.toLocaleString()}</strong>
          <small>17 × 72 task cells in this snapshot</small>
        </div>
        <div>
          <span>Top task credit</span>
          <strong>
            {latestOutcomes?.successRate === null || !latestOutcomes
              ? '—'
              : `${latestOutcomes.successRate.toFixed(0)}%`}
          </strong>
          <small>correct + partial on the top run</small>
        </div>
        <div>
          <span>Result coverage</span>
          <strong>{averageCoverage === null ? 'Unknown' : `${averageCoverage.toFixed(1)}%`}</strong>
          <small>coverage is not correctness</small>
        </div>
      </section>

      <div className="page-shell overview-provenance">
        <DataNote provenance={overviewProvenance} />
      </div>

      <section className="page-shell section-block overview-priority" id="leaderboard">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Latest matrix</span>
            <h2>Who leads, and why?</h2>
          </div>
          <p>
            The chart gives the fast answer. The outcome card explains what the leading point
            contains. Open any run when you need the task-level evidence.
          </p>
        </div>
        <ReadStateNote result={leaderboardResult} subject="Latest matrix" />
        <ModelMatrixChart entries={leaderboard} />
        {latestRun ? <RunOutcomeCard run={latestRun} /> : null}
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
            </dl>
            <ReadStateNote result={calibrationScoresResult} subject="Calibration score matrix" />
            {calibrationScoresResult.state === 'unavailable' ||
            calibrationScoresResult.state === 'empty' ? null : (
              <CalibrationEfficiency scores={calibrationScoresResult.data} />
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
