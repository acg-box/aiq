import assert from 'node:assert/strict';
import { it } from 'node:test';

import { SeedAiqRepository } from '../data/repository.ts';
import { readCoreResults } from './core-data.ts';

void it('reads the archive through the repository port without requiring a Supabase class', async (t) => {
  const repository = new SeedAiqRepository();
  const history = t.mock.method(repository, 'listHistoricalCoreResults', async () => []);
  const results = await readCoreResults(repository);

  assert.equal(history.mock.callCount(), 1);
  assert.equal(results.datasets[0].state, 'preview');
  assert.equal(results.datasets.length, 1);
});

void it('does not read archive data after the leaderboard read fails', async (t) => {
  const repository = new SeedAiqRepository();
  t.mock.method(repository, 'listLeaderboard', async () => {
    throw new Error('read unavailable');
  });
  const history = t.mock.method(repository, 'listHistoricalCoreResults', async () => []);
  const results = await readCoreResults(repository);

  assert.equal(history.mock.callCount(), 0);
  assert.equal(results.datasets[0].state, 'unavailable');
  assert.equal(results.datasets[0].rows.length, 0);
});
