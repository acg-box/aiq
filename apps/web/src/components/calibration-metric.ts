import type { PublicCalibrationScore } from '../data/types.ts';

export type CalibrationMetric = 'cost' | 'time';
export type CalibrationMetricEvidence = Pick<
  PublicCalibrationScore,
  | 'observedMedianWallMs'
  | 'observedTimeCoveragePercent'
  | 'costEstimatorStatus'
  | 'tokenUsageCoveragePercent'
  | 'standardApiEquivalentUsdNanos'
>;

export function calibrationMetricValue(
  score: CalibrationMetricEvidence,
  metric: CalibrationMetric,
): number | null {
  if (metric === 'cost') {
    return score.costEstimatorStatus === 'estimated' && score.tokenUsageCoveragePercent === 100
      ? score.standardApiEquivalentUsdNanos === null
        ? null
        : score.standardApiEquivalentUsdNanos / 1_000_000_000
      : null;
  }
  return score.observedTimeCoveragePercent === 100 && score.observedMedianWallMs !== null
    ? score.observedMedianWallMs / 1_000
    : null;
}
