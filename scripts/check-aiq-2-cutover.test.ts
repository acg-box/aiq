import assert from 'node:assert/strict';
import test from 'node:test';

import { AIQ_2_CUTOVER_QUERY, parseAiq2CutoverEvidence } from './check-aiq-2-cutover.ts';

const completeEvidence = {
  measurement_version: '2.0.0',
  measurement_method: 'rasch_fractional_fixed_bank_map_v2',
  published_batches: 1,
  published_runs: 17,
  official_scores: 17,
  published_task_results: 1224,
  calibration_digests: 1,
  synthetic_official_scores: 0,
  public_official_rows: 17,
  public_synthetic_rows: 0,
};

void test('AIQ 2.0 cutover accepts exactly one complete real Official matrix', () => {
  assert.deepEqual(parseAiq2CutoverEvidence(completeEvidence), completeEvidence);
});

void test('AIQ 2.0 cutover rejects empty, synthetic, or incomplete publication', () => {
  for (const patch of [
    { published_batches: 0 },
    { published_task_results: 0 },
    { synthetic_official_scores: 1 },
    { measurement_method: 'rasch_fractional_map_v1' },
  ]) {
    assert.throws(
      () => parseAiq2CutoverEvidence({ ...completeEvidence, ...patch }),
      /AIQ 2\.0 cutover is blocked/,
    );
  }
});

void test('AIQ 2.0 cutover query binds new measurement and non-synthetic 17×72 evidence', () => {
  assert.match(AIQ_2_CUTOVER_QUERY, /scoring_version = '1\.0\.7'/g);
  assert.match(AIQ_2_CUTOVER_QUERY, /not synthetic/);
  assert.match(AIQ_2_CUTOVER_QUERY, /published_task_results/);
  assert.match(AIQ_2_CUTOVER_QUERY, /public\.public_leaderboard/);
});
