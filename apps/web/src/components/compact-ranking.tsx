import Link from 'next/link';

import { sortLeaderboardByPointEstimate } from '../data/format.ts';
import { presentLeaderboardEntry } from '../data/leaderboard-presentation.ts';
import { isScoredLeaderboardEntry, type LeaderboardEntry } from '../data/types.ts';

const visibleRankingCount = 5;

export function CompactRanking({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const scored = entries.filter(isScoredLeaderboardEntry);
  const officialRanking = sortLeaderboardByPointEstimate(
    scored.filter((entry) => entry.scoreStatus === 'official'),
  ).slice(0, visibleRankingCount);
  const syntheticPreview = scored
    .filter((entry) => entry.scoreStatus === 'synthetic_complete')
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .slice(0, visibleRankingCount);
  const isOfficialRanking = officialRanking.length > 0;
  const isSyntheticPreview = !isOfficialRanking && syntheticPreview.length > 0;
  const visibleEntries = isOfficialRanking ? officialRanking : syntheticPreview;
  const heading = isOfficialRanking
    ? 'Published descriptive estimates'
    : isSyntheticPreview
      ? 'Synthetic matrix preview'
      : 'Published ranking unavailable';

  return (
    <section className="compact-ranking" aria-labelledby="compact-ranking-heading">
      <header>
        <div>
          <span className="eyebrow">
            {isOfficialRanking
              ? 'Fixed-task evidence · ordered for inspection'
              : isSyntheticPreview
                ? 'Non-ranking example'
                : 'Published evidence'}
          </span>
          <h2 id="compact-ranking-heading">{heading}</h2>
        </div>
        <Link href="#leaderboard">Analyze full matrix</Link>
      </header>
      {visibleEntries.length === 0 ? (
        <p className="empty-note">No scored configurations are available.</p>
      ) : (
        <div className="compact-ranking-table">
          <table>
            <caption className="sr-only">
              {isOfficialRanking
                ? `${visibleEntries.length} Official configuration${visibleEntries.length === 1 ? '' : 's'} shown in descending fixed-fixture AIQ point-estimate order. Each row includes its exact task-resampling sensitivity bounds. The order is descriptive and does not identify a winner.`
                : 'Synthetic configurations shown in configuration identifier order. Synthetic fixtures are not ranking eligible.'}
            </caption>
            <thead>
              <tr>
                <th scope="col">{isOfficialRanking ? 'Order' : 'Evidence'}</th>
                <th scope="col">Model / reasoning</th>
                <th scope="col">
                  {isOfficialRanking ? 'AIQ point / bounds' : 'AIQ demo / bounds'}
                </th>
                <th scope="col">Coverage</th>
                <th scope="col">Runtime issues</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry, index) => {
                const presentation = presentLeaderboardEntry(entry);
                return (
                  <tr key={entry.id}>
                    <td className="compact-rank">{isOfficialRanking ? index + 1 : 'Seed'}</td>
                    <th scope="row">
                      {presentation.runHref ? (
                        <Link href={presentation.runHref}>
                          <strong>{entry.modelFamily}</strong>
                          <span>{entry.reasoningTier}</span>
                        </Link>
                      ) : (
                        <span>
                          <strong>{entry.modelFamily}</strong>
                          <span>{entry.reasoningTier}</span>
                        </span>
                      )}
                    </th>
                    <td className="compact-score">
                      <span className="compact-score-point">{presentation.score}</span>
                      <span className="compact-score-bounds">
                        sensitivity {presentation.sensitivityInterval}
                      </span>
                    </td>
                    <td className="compact-coverage">
                      <span className="compact-cell-label" aria-hidden="true">
                        Coverage
                      </span>
                      {presentation.coverage}
                    </td>
                    <td className="compact-runtime">
                      <span className="compact-cell-label" aria-hidden="true">
                        Runtime issues
                      </span>
                      {presentation.runtimeIssues ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p>
        {isOfficialRanking
          ? 'AIQ is a fixed-task point estimate; bounds show task-resampling sensitivity. Inspect all 17 configurations before drawing conclusions.'
          : isSyntheticPreview
            ? 'Synthetic fixture · not Official · not ranking eligible.'
            : 'Awaiting a complete Official matrix.'}
      </p>
    </section>
  );
}
