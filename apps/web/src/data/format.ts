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

export function radarOrbitPosition(index: number): Readonly<{ left: string; top: string }> {
  const angle = index * 2.399963229728653 - Math.PI / 2;
  const radius = 19 + (index % 3) * 9;
  return {
    left: `${(50 + Math.cos(angle) * radius).toFixed(2)}%`,
    top: `${(50 + Math.sin(angle) * radius).toFixed(2)}%`,
  };
}

export function formatLastObservation(lastSeenAt: string | null, now = new Date()): string {
  if (lastSeenAt === null) {
    return 'Never observed';
  }
  const observedAt = new Date(lastSeenAt);
  if (Number.isNaN(observedAt.getTime())) {
    return 'Observation time unavailable';
  }
  const age = now.getTime() - observedAt.getTime();
  const freshness = age > 15 * 60 * 1_000 ? 'stale' : 'recent';
  return `${observedAt.toLocaleString()} · ${freshness}`;
}

export function leaderboardRunHref(entry: LeaderboardEntry): string | null {
  return entry.runId ? `/runs/${entry.runId}` : null;
}

export interface RunCompleteness {
  label: string;
  validResults: number;
  notApplicable: boolean;
}

function isValidResult(status: BenchmarkRun['tasks'][number]['status']): boolean {
  return status === 'passed' || status === 'failed';
}

export function formatScore(score: number): string {
  return score.toFixed(1);
}

export function formatConfidenceInterval(
  entry: Pick<LeaderboardEntry, 'ciLow' | 'ciHigh'>,
): string {
  if (entry.ciLow === null || entry.ciHigh === null) {
    return '—';
  }
  return `${formatScore(entry.ciLow)}–${formatScore(entry.ciHigh)}`;
}

export function sortLeaderboardByPointEstimate(
  entries: readonly LeaderboardEntry[],
): readonly LeaderboardEntry[] {
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

export function summarizeRun(run: BenchmarkRun): {
  passed: number;
  failed: number;
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
    passed: run.tasks.filter((task) => task.status === 'passed').length,
    failed: run.tasks.filter((task) => task.status === 'failed').length,
    invalid: run.tasks.filter((task) => task.status === 'invalid').length,
    missing: run.tasks.filter((task) => task.status === 'missing').length,
    notApplicable: run.tasks.filter((task) => task.status === 'not_applicable').length,
    medianLatencyMs,
  };
}

export interface RunOutcomeSummary {
  correct: number;
  partial: number;
  incorrect: number;
  executionFailures: number;
  unscored: number;
  passed: number;
  total: number;
  successRate: number | null;
}

const executionFailureCodes = new Set([
  'timeout',
  'budget_exceeded',
  'unsupported_model',
  'output_truncated',
  'missing_response',
]);

/**
 * Keep the user-facing outcome mix aligned with the immutable task score.
 * Status `passed` includes partial credit, so the task score is the source of
 * truth for the correct/partial split. Execution failures remain separate from
 * evaluator-rejected work.
 */
export function summarizeRunOutcomes(run: BenchmarkRun): RunOutcomeSummary {
  let correct = 0;
  let partial = 0;
  let incorrect = 0;
  let executionFailures = 0;
  let unscored = 0;
  for (const task of run.tasks) {
    if (
      task.score === null ||
      task.status === 'invalid' ||
      task.status === 'missing' ||
      task.status === 'not_applicable'
    ) {
      unscored += 1;
    } else if (task.score >= 1) {
      correct += 1;
    } else if (task.score > 0) {
      partial += 1;
    } else if (task.explanation?.code && executionFailureCodes.has(task.explanation.code)) {
      executionFailures += 1;
    } else {
      incorrect += 1;
    }
  }
  const total = run.tasks.length;
  const passed = correct + partial;
  return {
    correct,
    partial,
    incorrect,
    executionFailures,
    unscored,
    passed,
    total,
    successRate: total === 0 ? null : (passed / total) * 100,
  };
}

export interface RunDomainSummary {
  domain: string;
  score: number | null;
  coveragePercent: number;
  succeeded: number;
  failed: number;
  missing: number;
  invalid: number;
  notApplicable: number;
  total: number;
}

export function summarizeRunDomains(run: BenchmarkRun): readonly RunDomainSummary[] {
  return [...new Set(run.tasks.map((task) => task.domain))].toSorted().map((domain) => {
    const tasks = run.tasks.filter((task) => task.domain === domain);
    const observed = tasks.filter((task) => task.status === 'passed' || task.status === 'failed');
    return {
      domain,
      score:
        observed.length === 0
          ? null
          : (observed.reduce((sum, task) => sum + (task.score ?? 0), 0) / observed.length) * 100,
      coveragePercent: tasks.length === 0 ? 0 : (observed.length / tasks.length) * 100,
      succeeded: tasks.filter((task) => task.status === 'passed').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      missing: tasks.filter((task) => task.status === 'missing').length,
      invalid: tasks.filter((task) => task.status === 'invalid').length,
      notApplicable: tasks.filter((task) => task.status === 'not_applicable').length,
      total: tasks.length,
    };
  });
}

export function classifyRunCompleteness(run: BenchmarkRun): RunCompleteness {
  const validResults = run.tasks.filter((task) => isValidResult(task.status)).length;
  const notApplicable =
    run.tasks.length === 72 && run.tasks.every((task) => task.status === 'not_applicable');
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
        run.tasks.filter((task) => task.domain === domain && isValidResult(task.status)).length >=
        4,
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
  const notApplicable = summary.resultCount === 72 && summary.notApplicable === summary.resultCount;
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
