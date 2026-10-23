import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAiq2CutoverEvidence } from './check-aiq-2-cutover.ts';

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

void test('AIQ 2.0 cutover rejects a mismatch in any required publication field', () => {
  for (const [field, value] of Object.entries(completeEvidence)) {
    assert.throws(
      () =>
        parseAiq2CutoverEvidence({
          ...completeEvidence,
          [field]: typeof value === 'number' ? value + 1 : 'unsupported',
        }),
      /AIQ 2\.0 cutover is blocked/,
      field,
    );
  }
});
