import Link from 'next/link';

import { sortLeaderboardByPointEstimate } from '../data/format.ts';
import { presentLeaderboardEntry } from '../data/leaderboard-presentation.ts';
import { isScoredLeaderboardEntry, type LeaderboardEntry } from '../data/types.ts';

const visibleRankingCount = 5;

export function CompactRanking({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const scored = entries.filter(isScoredLeaderboardEntry);
  const official = scored.filter((entry) => entry.scoreStatus === 'official');
  const source = official.length > 0 ? official : scored;
  const visibleEntries = sortLeaderboardByPointEstimate(source).slice(0, visibleRankingCount);
  const isOfficial = official.length > 0;
  const metricLabel = isOfficial
    ? 'Calibrated ability'
    : scored.length > 0
      ? 'Quality score'
      : 'Score unavailable';

  return (
    <section className="compact-ranking analysis-panel" aria-labelledby="compact-ranking-heading">
      <header className="panel-heading">
        <div>
          <span className="eyebrow">Ranking</span>
          <h2 id="compact-ranking-heading">Top configurations</h2>
          <p>
            {isOfficial
              ? 'Official calibrated estimates'
              : scored.length > 0
                ? 'Synthetic quality preview · not Official'
                : 'Publication pending'}
          </p>
        </div>
        <span className="panel-meta">{metricLabel} ↓</span>
      </header>
      {visibleEntries.length === 0 ? (
        <p className="empty-note">No scored configurations are available.</p>
      ) : (
        <ol className="ranking-list">
          {visibleEntries.map((entry, index) => {
            const presentation = presentLeaderboardEntry(entry);
            const compareWith = visibleEntries.find((candidate) => candidate.id !== entry.id);
            const compareHref = compareWith
              ? `/?compareFirst=${encodeURIComponent(entry.id)}&compareSecond=${encodeURIComponent(compareWith.id)}#compare`
              : '/#compare';
            return (
              <li key={entry.id}>
                <span className="ranking-position" aria-label={`Position ${index + 1}`}>
                  {index + 1}
                </span>
                <span
                  className={`family-dot family-${entry.modelFamily.toLowerCase()}`}
                  aria-hidden="true"
                />
                <div className="ranking-identity">
                  {presentation.runHref ? (
                    <Link href={presentation.runHref}>
                      <strong>
                        {entry.modelFamily} {entry.reasoningTier}
                      </strong>
                    </Link>
                  ) : (
                    <strong>
                      {entry.modelFamily} {entry.reasoningTier}
                    </strong>
                  )}
                  <small>
                    {presentation.intervalLabel} {presentation.interval}
                  </small>
                </div>
                <strong className="ranking-score">{presentation.score}</strong>
                <Link className="quiet-button" href={compareHref}>
                  Compare
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      <Link className="panel-link" href="#matrix">
        View all {entries.length} configurations
      </Link>
    </section>
  );
}
