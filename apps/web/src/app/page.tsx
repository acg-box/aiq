import Link from 'next/link';

import { CalibrationEfficiency } from '../components/calibration-efficiency.tsx';
import { ReadStateNote } from '../components/read-state-note.tsx';
import { LeaderboardTable } from '../components/leaderboard-table.tsx';
import { OfficialEfficiencyTable } from '../components/official-efficiency-table.tsx';
import { ScoreRing } from '../components/score-ring.tsx';
import { createAiqRepository } from '../data/repository.ts';
import { readPublicData } from '../data/read-state.ts';
import { isScoredLeaderboardEntry } from '../data/types.ts';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const repository = createAiqRepository();
  const [leaderboardResult, nodesResult, calibrationRunsResult] = await Promise.all([
    readPublicData(
      repository,
      () => repository.listLeaderboard(),
      [],
      (value) => value.length === 0,
      (value) => value.map((entry) => entry.synthetic),
    ),
    readPublicData(
      repository,
      () => repository.listRadarNodes(),
      [],
      (value) => value.length === 0,
      (value) => value.map((node) => node.synthetic),
    ),
    readPublicData(
      repository,
      () => repository.listCalibrationRunPage(),
      { runs: [], newerCursor: null, olderCursor: null },
      (value) => value.runs.length === 0,
      (value) => value.runs.map((run) => run.synthetic),
    ),
  ]);
  const latestCalibration = calibrationRunsResult.data.runs[0];
  const calibrationScoresResult = await readPublicData(
    repository,
    () =>
      latestCalibration
        ? repository.listCalibrationScores(latestCalibration.id)
        : Promise.resolve([]),
    [],
    (value) => value.length === 0,
    (value) => value.map((score) => score.synthetic),
  );
  const leaderboard = leaderboardResult.data;
  const officialRunIds = leaderboard.flatMap((entry) =>
    entry.scoreStatus === 'official' && entry.runId ? [entry.runId] : [],
  );
  const officialEfficiencyResult = await readPublicData(
    repository,
    () => repository.listModelEfficiency(officialRunIds),
    [],
    (value) => value.length === 0,
    (value) => value.map(() => false),
  );
  const nodes = nodesResult.data;
  const scoredEntries = leaderboard.filter(isScoredLeaderboardEntry);
  const highestPointEstimate = scoredEntries.toSorted((left, right) => right.score - left.score)[0];
  const sampleTotal = leaderboard.reduce((sum, entry) => sum + (entry.sampleSize ?? 0), 0);
  const coveredEntries = leaderboard.filter((entry) => entry.coveragePercent !== null);
  const averageCoverage =
    coveredEntries.length === 0
      ? null
      : coveredEntries.reduce((sum, entry) => sum + (entry.coveragePercent ?? 0), 0) /
        coveredEntries.length;

  return (
    <>
      <section className="hero page-shell">
        <div className="hero-copy">
          <span className="eyebrow">AIQ v1 fixed-fixture evaluation</span>
          <h1>
            A score is only useful
            <br />
            when you can <em>inspect it.</em>
          </h1>
          <p>
            AIQ pairs each fixed-fixture result with task sensitivity, coverage, failures, history,
            and a route to all 72 task outcomes.
          </p>
          <div className="hero-actions">
            <Link className="button primary" href="#leaderboard">
              Explore the index
            </Link>
            <Link className="button secondary" href="/method">
              Read the method
            </Link>
          </div>
        </div>
        <div
          className="hero-score"
          aria-label={
            highestPointEstimate
              ? highestPointEstimate.synthetic
                ? 'Highest synthetic seed point estimate'
                : 'Highest published point estimate'
              : 'Publication status'
          }
        >
          {highestPointEstimate ? (
            <ScoreRing
              score={highestPointEstimate.score}
              label={
                highestPointEstimate.synthetic
                  ? 'Highest synthetic point estimate'
                  : 'Highest published point estimate'
              }
            />
          ) : (
            <div className="score-ring score-ring-empty" aria-label="No published score yet">
              <span>—</span>
              <small>AIQ</small>
            </div>
          )}
          <div>
            <span className="eyebrow">
              {highestPointEstimate
                ? highestPointEstimate.synthetic
                  ? 'Highest synthetic seed point estimate'
                  : 'Highest published point estimate'
                : 'Publication status'}
            </span>
            <strong>
              {highestPointEstimate
                ? `${highestPointEstimate.modelFamily} · ${highestPointEstimate.reasoningTier}`
                : 'No published score yet'}
            </strong>
            <small>
              {highestPointEstimate
                ? `${highestPointEstimate.modelName} · descriptive, not a winner claim`
                : 'The 17 configurations remain visible until a complete run is verified.'}
            </small>
            <Link className="text-link" href="/calibrations">
              Inspect separate Calibration evidence <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      <section className="signal-strip" aria-label="Index summary">
        <div>
          <span>Matrix</span>
          <strong>{leaderboard.length}</strong>
          <small>6 Sol · 6 Terra · 5 Luna</small>
        </div>
        <div>
          <span>Task observations</span>
          <strong>{sampleTotal.toLocaleString()}</strong>
          <small>across scored entries</small>
        </div>
        <div>
          <span>Mean coverage</span>
          <strong>{averageCoverage === null ? 'Unknown' : `${averageCoverage.toFixed(1)}%`}</strong>
          <small>{averageCoverage === null ? 'not measured' : 'missing remains visible'}</small>
        </div>
        <div>
          <span>Radar nodes</span>
          <strong>{nodes.length}</strong>
          <small>identity + provenance</small>
        </div>
      </section>

      <section className="page-shell section-block latest-calibration" id="latest-calibration">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Separate diagnostic evidence</span>
            <h2>Latest verified calibration</h2>
          </div>
          <p>
            This replay-verified local calibration is not Official / not ranking eligible. Its
            descriptive AIQ matrix, observed adapter elapsed time, and estimated Standard API
            equivalent token cost remain separate dimensions and do not affect the index order.
          </p>
        </div>
        <ReadStateNote result={calibrationRunsResult} subject="Latest calibration" />
        {latestCalibration ? (
          <>
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
              Inspect the bounded {latestCalibration.selectedTaskCount}-task subsets{' '}
              <span aria-hidden="true">→</span>
            </Link>
          </>
        ) : (
          <p className="empty-note">
            No verified calibration matrix is available. Official leaderboard data remains
            independent.
          </p>
        )}
      </section>

      <section className="page-shell section-block" aria-labelledby="official-efficiency-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Published efficiency</span>
            <h2 id="official-efficiency-heading">Official time, tokens, and cost</h2>
          </div>
          <p>
            Codex adapter elapsed, provider token counters, and Standard API-equivalent cost stay
            separate from AIQ. Summed cell elapsed and signed matrix batch wall-clock are distinct;
            the batch value is counted once across concurrent configurations.
          </p>
        </div>
        <ReadStateNote result={officialEfficiencyResult} subject="Official efficiency" />
        {officialEfficiencyResult.state === 'published' ? (
          <OfficialEfficiencyTable rows={officialEfficiencyResult.data} />
        ) : null}
      </section>

      <section className="page-shell section-block" id="leaderboard">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Model × reasoning matrix</span>
            <h2>Public index</h2>
          </div>
          <p>
            Official results require non-synthetic evidence for all 72 committed fixtures. Bounds
            are task-resampling sensitivity intervals, not general capability confidence intervals.
            The table order is descriptive and does not establish a winner.
          </p>
        </div>
        <ReadStateNote result={leaderboardResult} />
        {leaderboardResult.state === 'unavailable' ? null : (
          <LeaderboardTable entries={leaderboard} />
        )}
      </section>

      <section className="page-shell split-cta">
        <div>
          <span className="eyebrow">Look beyond the order</span>
          <h2>Compare like with like.</h2>
          <p>
            Select exact model and reasoning combinations. Inspect descriptive differences,
            intervals, and compatibility.
          </p>
          <Link className="text-link" href="/compare">
            Open comparison studio <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div>
          <span className="eyebrow">History is evidence</span>
          <h2>Keep the whole timeline.</h2>
          <p>Switch among day, week, month, and all-history views without deleting the past.</p>
          <Link className="text-link" href="/trends">
            Explore score history <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>
    </>
  );
}
