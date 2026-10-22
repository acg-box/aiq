import assert from 'node:assert/strict';
import { it } from 'node:test';
import { rankCoreResults, selectCoreResults, type CoreResultRow } from './core-results.ts';
import { seedLeaderboard } from './seed.ts';
import { isScoredLeaderboardEntry } from './types.ts';

const scored = seedLeaderboard.filter(isScoredLeaderboardEntry);
function row(id: string, score: number, strictPassRate = 0.5): CoreResultRow {
  const entry = scored.find((candidate) => candidate.id === id);
  assert.ok(entry);
  return {
    entry: { ...entry, score, strictPassRate },
    completedAt: '2026-08-28T16:22:56Z',
    evidenceHref: '/test-evidence',
  };
}

void it('uses recorded ability for competition ranks and retains global ranks after filtering', () => {
  const rows = [row('sol-low', 75.225), row('terra-low', 75.225), row('luna-low', 75.2249)];
  assert.deepEqual(
    rankCoreResults(rows).map(({ entry, rank }) => [entry.id, rank]),
    [
      ['sol-low', 1],
      ['terra-low', 1],
      ['luna-low', 3],
    ],
  );
  assert.deepEqual(
    selectCoreResults(rows, 'Luna', 'low', { key: 'ability', descending: true }).map(
      ({ rank }) => rank,
    ),
    [3],
  );
  assert.deepEqual(
    selectCoreResults(rows, 'Luna', 'ultra', { key: 'ability', descending: true }),
    [],
  );
});

void it('sorts strict pass independently without changing the ability ranks', () => {
  const rows = [row('sol-low', 80, 0.25), row('terra-low', 70, 0.75)];
  assert.deepEqual(
    selectCoreResults(rows, 'all', 'all', { key: 'strict', descending: true }).map(
      ({ entry, rank }) => [entry.id, rank],
    ),
    [
      ['terra-low', 2],
      ['sol-low', 1],
    ],
  );
  assert.deepEqual(
    selectCoreResults(rows, 'all', 'all', { key: 'ability', descending: false }).map(
      ({ entry }) => entry.id,
    ),
    ['terra-low', 'sol-low'],
  );
});
