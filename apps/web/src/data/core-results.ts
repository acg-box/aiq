import type { ScoredLeaderboardEntry } from './types.ts';

export interface CoreResultRow {
  entry: ScoredLeaderboardEntry;
  completedAt: string;
  evidenceHref: string;
}

export interface CoreResultDataset {
  id: string;
  version: string;
  historical: boolean;
  state: 'available' | 'empty' | 'unavailable' | 'preview';
  rows: readonly CoreResultRow[];
}

/** Competition ranks use recorded ability, before filtering or display rounding. */
export function rankCoreResults(rows: readonly CoreResultRow[]) {
  const ordered = rows.toSorted(
    (left, right) =>
      right.entry.score - left.entry.score || left.entry.id.localeCompare(right.entry.id),
  );
  let rank = 0;
  return ordered.map((row, index) => {
    if (index === 0 || ordered[index - 1]?.entry.score !== row.entry.score) rank = index + 1;
    return { entry: row.entry, completedAt: row.completedAt, evidenceHref: row.evidenceHref, rank };
  });
}

export function selectCoreResults(
  rows: readonly CoreResultRow[],
  family: string,
  effort: string,
  sort: { key: 'ability' | 'strict' | 'model'; descending: boolean },
) {
  return rankCoreResults(rows)
    .filter(
      ({ entry }) =>
        (family === 'all' || entry.modelFamily === family) &&
        (effort === 'all' || entry.reasoningTier === effort),
    )
    .toSorted((left, right) => {
      const value =
        sort.key === 'model'
          ? left.entry.id.localeCompare(right.entry.id)
          : sort.key === 'strict'
            ? left.entry.strictPassRate - right.entry.strictPassRate
            : left.entry.score - right.entry.score;
      return (
        (sort.descending ? -value : value) ||
        left.rank - right.rank ||
        left.entry.id.localeCompare(right.entry.id)
      );
    });
}
