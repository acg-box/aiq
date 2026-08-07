import type {
  BenchmarkRun,
  BenchmarkRunSummary,
  LeaderboardEntry,
  TrendPoint,
  TrendRange,
  TrustLevel,
  RadarNode,
} from './types.ts';

export const TRUST_LEVELS: readonly TrustLevel[] = [
  'unverified',
  'signed_community',
  'trusted_verified',
  'independently_reproduced',
];

export function formatTrustLevel(trust: TrustLevel): string {
  return trust.replaceAll('_', ' ');
}

export function formatRegistryStatus(status: RadarNode['registryStatus']): string {
  return status;
}

export function formatProtocolToken(value: string): string {
  return value.replaceAll('_', ' ');
}

export type ObservationRecency = 'never' | 'unavailable' | 'recent' | 'stale';

export function classifyObservationRecency(
  lastSeenAt: string | null,
  now = new Date(),
): ObservationRecency {
  if (lastSeenAt === null) return 'never';
  const observedAt = new Date(lastSeenAt);
  if (Number.isNaN(observedAt.getTime())) return 'unavailable';
  const age = now.getTime() - observedAt.getTime();
  return age > 15 * 60 * 1_000 ? 'stale' : 'recent';
}

export function formatLastObservation(lastSeenAt: string | null, now = new Date()): string {
  const recency = classifyObservationRecency(lastSeenAt, now);
  if (recency === 'never') return 'Never observed';
  if (recency === 'unavailable') return 'Observation time unavailable';
  return `${new Date(lastSeenAt ?? '').toLocaleString()} · ${recency}`;
}

export function leaderboardRunHref(entry: LeaderboardEntry): string | null {
  return entry.runId ? `/runs/${entry.runId}` : null;
}

export interface RunCompleteness {
  label: string;
  validResults: number;
  notApplicable: boolean;
}

function isValidResult(status: BenchmarkRun['tasks'][number]['executionStatus']): boolean {
  return status === 'completed';
}

export function formatScore(score: number): string {
  return score.toFixed(1);
}

export function formatSensitivityInterval(
  entry: Pick<LeaderboardEntry, 'sensitivityLow' | 'sensitivityHigh'>,
): string {
  if (entry.sensitivityLow === null || entry.sensitivityHigh === null) {
    return '—';
  }
  return `${formatScore(entry.sensitivityLow)}–${formatScore(entry.sensitivityHigh)}`;
}

export function formatScoreConfidenceInterval(
  entry: Pick<LeaderboardEntry, 'scoreCiLow' | 'scoreCiHigh'>,
): string {
  if (entry.scoreCiLow === null || entry.scoreCiHigh === null) return '—';
  return `${formatScore(entry.scoreCiLow)}–${formatScore(entry.scoreCiHigh)}`;
}

export function formatStrictPassRate(
  entry: Pick<LeaderboardEntry, 'strictPassRate' | 'strictPassSampleSize'>,
): string {
  if (entry.strictPassRate === null || entry.strictPassSampleSize === null) return '—';
  return `${(entry.strictPassRate * 100).toFixed(1)}% (n=${entry.strictPassSampleSize})`;
}

export function formatStrictPassConfidenceInterval(
  entry: Pick<LeaderboardEntry, 'strictPassLow' | 'strictPassHigh'>,
): string {
  if (entry.strictPassLow === null || entry.strictPassHigh === null) return '—';
  return `${(entry.strictPassLow * 100).toFixed(1)}%–${(entry.strictPassHigh * 100).toFixed(1)}%`;
}

export function sortLeaderboardByPointEstimate<T extends LeaderboardEntry>(
  entries: readonly T[],
): readonly T[] {
  return entries.toSorted((left, right) => {
    if (left.score !== null && right.score !== null) {
      return right.score - left.score || left.id.localeCompare(right.id);
    }
    if (left.score !== null) {
      return -1;
    }
    if (right.score !== null) {
      return 1;
    }
    return left.id.localeCompare(right.id);
  });
}

export function latestCompletedRun<T extends Pick<BenchmarkRunSummary, 'completedAt' | 'id'>>(
  runs: readonly T[],
): T | null {
  return (
    runs.toSorted((left, right) => {
      const leftCompletedAt = new Date(left.completedAt).getTime();
      const rightCompletedAt = new Date(right.completedAt).getTime();
      const leftTime = Number.isNaN(leftCompletedAt) ? Number.NEGATIVE_INFINITY : leftCompletedAt;
      const rightTime = Number.isNaN(rightCompletedAt)
        ? Number.NEGATIVE_INFINITY
        : rightCompletedAt;
      return rightTime - leftTime || left.id.localeCompare(right.id);
    })[0] ?? null
  );
}

export function summarizeRun(run: BenchmarkRun): {
  correct: number;
  partial: number;
  incorrect: number;
  runtimeIssues: number;
  invalid: number;
  missing: number;
  notApplicable: number;
  medianLatencyMs: number | null;
} {
  const latencies = run.tasks
    .flatMap((task) => (task.latencyMs === null ? [] : [task.latencyMs]))
    .toSorted((left, right) => left - right);
  const middle = Math.floor(latencies.length / 2);
  let medianLatencyMs: number | null = null;
  if (latencies.length > 0) {
    const left = latencies.at(middle - (latencies.length % 2 === 0 ? 1 : 0)) ?? 0;
    const right = latencies.at(middle) ?? left;
    medianLatencyMs = (left + right) / 2;
  }
  return {
    correct: run.tasks.filter((task) => task.outcome === 'correct').length,
    partial: run.tasks.filter((task) => task.outcome === 'partial').length,
    incorrect: run.tasks.filter((task) => task.outcome === 'incorrect').length,
    runtimeIssues: run.tasks.filter((task) => task.executionStatus === 'runtime_issue').length,
    invalid: run.tasks.filter((task) => task.executionStatus === 'invalid').length,
    missing: run.tasks.filter((task) => task.executionStatus === 'missing').length,
    notApplicable: run.tasks.filter((task) => task.executionStatus === 'not_applicable').length,
    medianLatencyMs,
  };
}

export interface RunOutcomeSummary {
  correct: number;
  partial: number;
  incorrect: number;
  runtimeIssues: number;
  invalid: number;
  missing: number;
  notApplicable: number;
  anyCredit: number;
  completedOutcomes: number;
  total: number;
  anyCreditRate: number | null;
}

export function formatAnyCreditRate(rate: number | null): string {
  return rate === null ? '—' : `${rate.toFixed(0)}%`;
}

/**
 * Keep the user-facing outcome mix aligned with the immutable task score.
 * Exact public outcomes are the semantic source of truth. Execution status is
 * the independent source of truth for runtime and coverage state.
 */
export function summarizeRunOutcomes(run: BenchmarkRun): RunOutcomeSummary {
  let correct = 0;
  let partial = 0;
  let incorrect = 0;
  let runtimeIssues = 0;
  let invalid = 0;
  let missing = 0;
  let notApplicable = 0;
  for (const task of run.tasks) {
    if (task.executionStatus === 'runtime_issue') {
      runtimeIssues += 1;
    } else if (task.executionStatus === 'invalid') {
      invalid += 1;
    } else if (task.executionStatus === 'missing') {
      missing += 1;
    } else if (task.executionStatus === 'not_applicable') {
      notApplicable += 1;
    } else if (task.outcome === 'correct') {
      correct += 1;
    } else if (task.outcome === 'partial') {
      partial += 1;
    } else if (task.outcome === 'incorrect') {
      incorrect += 1;
    } else {
      invalid += 1;
    }
  }
  const total = run.tasks.length;
  const anyCredit = correct + partial;
  const completedOutcomes = correct + partial + incorrect;
  return {
    correct,
    partial,
    incorrect,
    runtimeIssues,
    invalid,
    missing,
    notApplicable,
    anyCredit,
    completedOutcomes,
    total,
    anyCreditRate: completedOutcomes === 0 ? null : (anyCredit / completedOutcomes) * 100,
  };
}

export interface RunDomainSummary {
  domain: string;
  score: number | null;
  coveragePercent: number;
  completed: number;
  runtimeIssues: number;
  missing: number;
  invalid: number;
  notApplicable: number;
  total: number;
}

export function summarizeRunDomains(run: BenchmarkRun): readonly RunDomainSummary[] {
  return [...new Set(run.tasks.map((task) => task.domain))].toSorted().map((domain) => {
    const tasks = run.tasks.filter((task) => task.domain === domain);
    const observed = tasks.filter((task) => task.executionStatus === 'completed');
    return {
      domain,
      score:
        observed.length === 0
          ? null
          : (observed.reduce((sum, task) => sum + (task.score ?? 0), 0) / observed.length) * 100,
      coveragePercent: tasks.length === 0 ? 0 : (observed.length / tasks.length) * 100,
      completed: tasks.filter((task) => task.executionStatus === 'completed').length,
      runtimeIssues: tasks.filter((task) => task.executionStatus === 'runtime_issue').length,
      missing: tasks.filter((task) => task.executionStatus === 'missing').length,
      invalid: tasks.filter((task) => task.executionStatus === 'invalid').length,
      notApplicable: tasks.filter((task) => task.executionStatus === 'not_applicable').length,
      total: tasks.length,
    };
  });
}

export function classifyRunCompleteness(run: BenchmarkRun): RunCompleteness {
  const validResults = run.tasks.filter((task) => isValidResult(task.executionStatus)).length;
  const notApplicable =
    run.tasks.length === 72 && run.tasks.every((task) => task.executionStatus === 'not_applicable');
  if (notApplicable) {
    return {
      label: 'N/A · unsupported in a valid preflight',
      validResults,
      notApplicable,
    };
  }
  const domains = [...new Set(run.tasks.map((task) => task.domain))];
  const hasMinimumDomainCoverage =
    domains.length === 10 &&
    domains.every(
      (domain) =>
        run.tasks.filter((task) => task.domain === domain && isValidResult(task.executionStatus))
          .length >= 4,
    );
  return {
    label:
      validResults === 72
        ? run.synthetic
          ? 'Complete synthetic fixture · not Official'
          : 'Official'
        : validResults >= 60 && hasMinimumDomainCoverage
          ? 'Provisional · not ranked'
          : 'Coverage-only · not ranked',
    validResults,
    notApplicable,
  };
}

export function classifyRunSummaryCompleteness(run: BenchmarkRunSummary): RunCompleteness {
  const summary = run.resultSummary;
  const notApplicable =
    summary.resultCount === 72 && summary.notApplicableCount === summary.resultCount;
  return {
    label: notApplicable
      ? 'N/A · unsupported in a valid preflight'
      : summary.observedCount === 72
        ? run.synthetic
          ? 'Complete synthetic fixture · not Official'
          : 'Official'
        : summary.observedCount >= 60 && summary.provisionalDomainCount === 10
          ? 'Provisional · not ranked'
          : 'Coverage-only · not ranked',
    validResults: summary.observedCount,
    notApplicable,
  };
}

const rangeMilliseconds: Record<Exclude<TrendRange, 'all'>, number> = {
  day: 86_400_000,
  week: 604_800_000,
  month: 2_678_400_000,
};

export function filterTrendPoints(
  points: readonly TrendPoint[],
  range: TrendRange,
  now: Date,
): readonly TrendPoint[] {
  if (range === 'all') {
    return points;
  }
  const cutoff = now.getTime() - rangeMilliseconds[range];
  return points.filter((point) => new Date(point.recordedAt).getTime() >= cutoff);
}
