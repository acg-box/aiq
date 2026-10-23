import {
  joinExactRunScientificEvidence,
  type ExactRunScientificEvidence,
  type ScientificRunIdentity,
} from '../data/scientific-evidence.ts';
import { formatHumanDuration } from '../data/format-duration.ts';
import { presentLeaderboardEntry, presentScoreMetric } from '../data/leaderboard-presentation.ts';
import {
  type LeaderboardEntry,
  type PublicModelEfficiency,
  type RunResultSummary,
} from '../data/types.ts';
import { formatConfigurationCost, resolveConfigurationCost } from './configuration-cost.ts';

export const UNAVAILABLE = 'Unavailable';

export interface ScientificScoreContext {
  sampleSize: number;
  coverage: string;
  runtime: string;
  missing: string;
  status: string;
  scoringVersion: string;
  provenance: string;
}

export interface RunScientificSummary {
  score: string;
  scoreLabel: string;
  interval: string;
  intervalLabel: string;
  qualityScore: string;
  sensitivityInterval: string;
  strictPass: string;
  sampleSize: string;
  coverage: string;
  runtime: string;
  missing: string;
  scoring: string;
  provenance: string;
  adapterDuration: string;
  batchWallClock: string;
  cost: string;
  metricCoverage: string;
}

export function buildRunScientificSummary({
  run,
  resultSummary,
  leaderboardEntry,
  efficiency,
}: {
  run: ScientificRunIdentity;
  resultSummary: RunResultSummary;
  leaderboardEntry?: LeaderboardEntry | undefined;
  efficiency?: PublicModelEfficiency | undefined;
}): RunScientificSummary {
  let evidence: ExactRunScientificEvidence = { score: undefined, efficiency: undefined };
  try {
    evidence = joinExactRunScientificEvidence({
      run,
      entries: leaderboardEntry ? [leaderboardEntry] : [],
      efficiencyRows: efficiency ? [efficiency] : [],
    });
  } catch {
    // Public pages must fail closed when joined evidence drifts from the run identity.
  }
  const { score, efficiency: exactEfficiency } = evidence;
  const metric = score ? presentScoreMetric(score) : null;
  const presentation = score ? presentLeaderboardEntry(score) : null;
  const cost = exactEfficiency ? resolveConfigurationCost(exactEfficiency) : null;
  return {
    score: metric?.scoreText ?? UNAVAILABLE,
    scoreLabel: metric?.scoreLabel ?? (run.synthetic ? 'Quality score' : 'Calibrated ability'),
    interval: metric?.interval ?? UNAVAILABLE,
    intervalLabel:
      metric?.intervalLabel ??
      (run.synthetic ? 'Task-mix sensitivity' : 'Conditional 95% interval'),
    qualityScore: presentation?.qualityScore ?? UNAVAILABLE,
    sensitivityInterval: presentation?.sensitivityInterval ?? UNAVAILABLE,
    strictPass: presentation
      ? `${presentation.strictPassRate} · Wilson 95% ${presentation.strictPassInterval}`
      : UNAVAILABLE,
    sampleSize: score ? score.sampleSize.toLocaleString() : UNAVAILABLE,
    coverage:
      resultSummary.coveragePercent === null
        ? UNAVAILABLE
        : `${resultSummary.coveragePercent.toFixed(1)}%`,
    runtime: resultSummary.runtimeIssueCount.toLocaleString(),
    missing: resultSummary.missingCount.toLocaleString(),
    scoring: run.scoringVersion || UNAVAILABLE,
    provenance: run.synthetic ? 'Synthetic seed' : 'Published',
    adapterDuration:
      exactEfficiency?.summedCellAdapterElapsedMs == null
        ? UNAVAILABLE
        : formatHumanDuration(exactEfficiency.summedCellAdapterElapsedMs),
    batchWallClock:
      exactEfficiency?.matrixBatchElapsedMs == null
        ? UNAVAILABLE
        : formatHumanDuration(exactEfficiency.matrixBatchElapsedMs),
    cost: cost ? formatConfigurationCost(cost) : UNAVAILABLE,
    metricCoverage: exactEfficiency
      ? `time ${exactEfficiency.observedTimeSampleCount}/${exactEfficiency.resultCount} · cost ${exactEfficiency.pricedResultCount}/${exactEfficiency.resultCount}`
      : UNAVAILABLE,
  };
}

export function formatScientificScoreContextHtml(context: ScientificScoreContext): string {
  return `score n=${context.sampleSize} · coverage ${context.coverage}<br/>runtime ${context.runtime} · missing ${context.missing}<br/>status ${context.status} · scoring ${context.scoringVersion} · ${context.provenance}`;
}
