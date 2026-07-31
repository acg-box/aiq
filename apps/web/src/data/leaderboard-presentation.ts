import { formatConfidenceInterval, leaderboardRunHref } from './format.ts';
import type { LeaderboardEntry, LeaderboardStatus } from './types.ts';

const statusLabels: Record<LeaderboardStatus, string> = {
  official: 'Official · 72/72',
  not_applicable: 'N/A · unsupported',
  missing: 'Missing result',
  unpublished: 'Unpublished',
};

export interface LeaderboardPresentation {
  score: string;
  confidenceInterval: string;
  samples: string;
  coverage: string;
  failuresAndMissing: Readonly<{
    failures: number;
    missing: number;
    failuresAreBad: boolean;
  }> | null;
  scoringVersion: string | null;
  status: string;
  evidence: string;
  runHref: string | null;
}

export function presentLeaderboardEntry(entry: LeaderboardEntry): LeaderboardPresentation {
  return {
    score: entry.score === null ? '—' : entry.score.toFixed(1),
    confidenceInterval: formatConfidenceInterval(entry),
    samples: entry.sampleSize === null ? '—' : String(entry.sampleSize),
    coverage: entry.coveragePercent === null ? '—' : `${entry.coveragePercent.toFixed(1)}%`,
    failuresAndMissing:
      entry.failures === null || entry.missing === null
        ? null
        : {
            failures: entry.failures,
            missing: entry.missing,
            failuresAreBad: entry.failures > 2,
          },
    scoringVersion: entry.scoringVersion,
    status: statusLabels[entry.scoreStatus],
    evidence:
      entry.synthetic === null ? 'No evidence' : entry.synthetic ? 'Synthetic' : 'Published',
    runHref: leaderboardRunHref(entry),
  };
}
