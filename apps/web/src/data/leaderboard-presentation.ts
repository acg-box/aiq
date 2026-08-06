import {
  formatScoreConfidenceInterval,
  formatSensitivityInterval,
  formatStrictPassConfidenceInterval,
  formatStrictPassRate,
  leaderboardRunHref,
} from './format.ts';
import type { CalibrationStatus, LeaderboardEntry, LeaderboardStatus } from './types.ts';

const statusLabels: Record<LeaderboardStatus, string> = {
  official: 'Official · 72/72',
  synthetic_complete: 'Complete synthetic fixture · not Official',
  provisional: 'Provisional · not ranked',
  coverage_only: 'Coverage only · no score',
  not_applicable: 'N/A · unsupported',
  missing: 'Missing result',
  failed: 'Failed · no score',
  infra_failure: 'Infrastructure failure · rerun required',
  unpublished: 'Unpublished',
};

export interface LeaderboardPresentation {
  score: string;
  scoreLabel: 'Calibrated ability' | 'Quality score';
  interval: string;
  intervalLabel: 'Conditional 95% interval' | 'Task-mix sensitivity';
  qualityScore: string;
  sensitivityInterval: string;
  strictPassRate: string;
  strictPassInterval: string;
  calibration: string;
  samples: string;
  coverage: string;
  runtimeIssues: number | null;
  scoringVersion: string | null;
  status: string;
  evidence: string;
  runHref: string | null;
}

export interface ScoreMetricDatum {
  score: number | null;
  qualityScore: number | null;
  scoreCiLow: number | null;
  scoreCiHigh: number | null;
  sensitivityLow: number | null;
  sensitivityHigh: number | null;
  strictPassRate: number | null;
  strictPassLow: number | null;
  strictPassHigh: number | null;
  strictPassSampleSize: number | null;
  calibrationStatus: CalibrationStatus;
  synthetic: boolean | null;
  scoreStatus?: LeaderboardStatus;
}

export interface ScoreMetricPresentation {
  official: boolean;
  score: number | null;
  scoreText: string;
  scoreLabel: 'Calibrated ability' | 'Quality score';
  intervalLow: number | null;
  intervalHigh: number | null;
  interval: string;
  intervalLabel: 'Conditional 95% interval' | 'Task-mix sensitivity';
}

/**
 * Keep the public primary metric and its interval on the same statistical scale.
 * Official rows use calibrated ability with its conditional score interval.
 * Synthetic rows use descriptive quality with task-mix sensitivity.
 */
export function presentScoreMetric(entry: ScoreMetricDatum): ScoreMetricPresentation {
  const statusAllowsOfficial = entry.scoreStatus === undefined || entry.scoreStatus === 'official';
  const official =
    statusAllowsOfficial &&
    entry.synthetic === false &&
    entry.calibrationStatus === 'calibrated' &&
    entry.score !== null &&
    entry.scoreCiLow !== null &&
    entry.scoreCiHigh !== null;
  const score = official ? entry.score : (entry.qualityScore ?? entry.score);
  const intervalLow = official ? entry.scoreCiLow : entry.sensitivityLow;
  const intervalHigh = official ? entry.scoreCiHigh : entry.sensitivityHigh;
  return {
    official,
    score,
    scoreText: score === null ? '—' : score.toFixed(1),
    scoreLabel: official ? 'Calibrated ability' : 'Quality score',
    intervalLow,
    intervalHigh,
    interval: official ? formatScoreConfidenceInterval(entry) : formatSensitivityInterval(entry),
    intervalLabel: official ? 'Conditional 95% interval' : 'Task-mix sensitivity',
  };
}

export function presentLeaderboardEntry(entry: LeaderboardEntry): LeaderboardPresentation {
  const metric = presentScoreMetric(entry);
  return {
    score: metric.scoreText,
    scoreLabel: metric.scoreLabel,
    interval: metric.interval,
    intervalLabel: metric.intervalLabel,
    qualityScore: entry.qualityScore === null ? '—' : entry.qualityScore.toFixed(1),
    sensitivityInterval: formatSensitivityInterval(entry),
    strictPassRate: formatStrictPassRate(entry),
    strictPassInterval: formatStrictPassConfidenceInterval(entry),
    calibration: entry.calibrationStatus.replaceAll('_', ' '),
    samples: entry.sampleSize === null ? '—' : String(entry.sampleSize),
    coverage: entry.coveragePercent === null ? '—' : `${entry.coveragePercent.toFixed(1)}%`,
    runtimeIssues: entry.runtimeIssues,
    scoringVersion: entry.scoringVersion,
    status: statusLabels[entry.scoreStatus],
    evidence:
      entry.synthetic === null ? 'No evidence' : entry.synthetic ? 'Synthetic' : 'Published',
    runHref: leaderboardRunHref(entry),
  };
}
