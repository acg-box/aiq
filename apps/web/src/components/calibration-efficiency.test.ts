import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type CalibrationMetricEvidence, calibrationMetricValue } from './calibration-metric.ts';

function score(overrides: Partial<CalibrationMetricEvidence> = {}): CalibrationMetricEvidence {
  return {
    observedMedianWallMs: 12_345,
    observedTimeCoveragePercent: 100,
    costEstimatorStatus: 'estimated',
    tokenUsageCoveragePercent: 100,
    standardApiEquivalentUsdNanos: 1_250_000_000,
    ...overrides,
  };
}

void describe('calibration efficiency metric units', () => {
  void it('converts covered median adapter time from milliseconds to seconds', () => {
    assert.equal(calibrationMetricValue(score(), 'time'), 12.345);
  });

  void it('keeps time unavailable without complete observation coverage', () => {
    assert.equal(
      calibrationMetricValue(score({ observedTimeCoveragePercent: 99.9 }), 'time'),
      null,
    );
    assert.equal(calibrationMetricValue(score({ observedMedianWallMs: null }), 'time'), null);
  });

  void it('converts covered API-equivalent cost from nanos to dollars', () => {
    assert.equal(calibrationMetricValue(score(), 'cost'), 1.25);
  });
});
