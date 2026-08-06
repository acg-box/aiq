import { formatHumanDuration } from '../data/format-duration.ts';
import {
  isScoredLeaderboardEntry,
  type LeaderboardEntry,
  type PublicModelEfficiency,
  type RunResultSummary,
  type ScoredLeaderboardEntry,
} from '../data/types.ts';

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
  interval: string;
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

export interface ScientificRunIdentity {
  id: string;
  entryId: string;
  scoringVersion: string;
  synthetic: boolean;
}

export interface ExactRunScientificEvidence {
  score: ScoredLeaderboardEntry | undefined;
  efficiency: PublicModelEfficiency | undefined;
}

export function hasExactScientificIdentity(
  run: ScientificRunIdentity,
  candidate: {
    runId: string;
    entryId: string;
    scoringVersion: string;
    synthetic: boolean;
  },
): boolean {
  return (
    candidate.runId === run.id &&
    candidate.entryId === run.entryId &&
    candidate.scoringVersion === run.scoringVersion &&
    candidate.synthetic === run.synthetic
  );
}

export function joinExactRunScientificEvidence({
  run,
  entries,
  efficiencyRows,
}: {
  run: ScientificRunIdentity;
  entries: readonly LeaderboardEntry[];
  efficiencyRows: readonly PublicModelEfficiency[];
}): ExactRunScientificEvidence {
  const identityCandidates = entries.filter((entry) => entry.runId === run.id);
  if (identityCandidates.length > 1) {
    throw new Error(`Ambiguous leaderboard evidence for run ${run.id}.`);
  }
  const identityCandidate = identityCandidates[0];
  if (identityCandidate && !isScoredLeaderboardEntry(identityCandidate)) {
    throw new Error(`Mismatched leaderboard evidence for run ${run.id}.`);
  }
  const scoreCandidates = identityCandidates.filter((entry): entry is ScoredLeaderboardEntry =>
    isScoredLeaderboardEntry(entry),
  );
  if (scoreCandidates.length > 1) {
    throw new Error(`Ambiguous leaderboard evidence for run ${run.id}.`);
  }
  const score = scoreCandidates[0];
  const scoreEntryId = score
    ? `${score.modelFamily.toLowerCase()}-${score.reasoningTier}`
    : undefined;
  if (
    score &&
    (scoreEntryId !== score.id ||
      !hasExactScientificIdentity(run, {
        runId: score.runId,
        entryId: score.id,
        scoringVersion: score.scoringVersion,
        synthetic: score.synthetic,
      }))
  ) {
    throw new Error(`Mismatched leaderboard evidence for run ${run.id}.`);
  }

  const efficiencyCandidates = efficiencyRows.filter((row) => row.runId === run.id);
  if (efficiencyCandidates.length > 1) {
    throw new Error(`Ambiguous efficiency evidence for run ${run.id}.`);
  }
  const efficiency = efficiencyCandidates[0];
  if (efficiency) {
    const expectedEntryId = `${efficiency.modelFamily}-${efficiency.reasoningEffort}`;
    const identityEntries = entries.filter((entry) => entry.id === run.entryId);
    if (identityEntries.length > 1) {
      throw new Error(`Ambiguous configuration evidence for run ${run.id}.`);
    }
    const identityEntry = identityEntries[0];
    const entryConfigurationMatches =
      identityEntry === undefined ||
      (identityEntry.modelFamily.toLowerCase() === efficiency.modelFamily &&
        identityEntry.reasoningTier === efficiency.reasoningEffort);
    if (run.synthetic || expectedEntryId !== run.entryId || !entryConfigurationMatches) {
      throw new Error(`Mismatched efficiency evidence for run ${run.id}.`);
    }
  }
  return { score, efficiency };
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
  const costAvailable =
    exactEfficiency?.costEstimatorStatus === 'estimated' &&
    exactEfficiency.standardApiEquivalentUsdNanos !== null;
  return {
    score: score ? score.score.toFixed(1) : UNAVAILABLE,
    interval: score
      ? `${score.sensitivityLow.toFixed(1)}–${score.sensitivityHigh.toFixed(1)}`
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
    cost: costAvailable
      ? `$${((exactEfficiency?.standardApiEquivalentUsdNanos ?? 0) / 1_000_000_000).toFixed(4)}`
      : UNAVAILABLE,
    metricCoverage: exactEfficiency
      ? `time ${exactEfficiency.observedTimeSampleCount}/${exactEfficiency.resultCount} · cost ${exactEfficiency.pricedResultCount}/${exactEfficiency.resultCount}`
      : UNAVAILABLE,
  };
}

export function formatScientificScoreContextHtml(context: ScientificScoreContext): string {
  return `score n=${context.sampleSize} · coverage ${context.coverage}<br/>runtime ${context.runtime} · missing ${context.missing}<br/>status ${context.status} · scoring ${context.scoringVersion} · ${context.provenance}`;
}
