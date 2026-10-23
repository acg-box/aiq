import {
  isScoredLeaderboardEntry,
  type LeaderboardEntry,
  type PublicModelEfficiency,
  type ScoredLeaderboardEntry,
} from './types.ts';

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
  candidate: ScientificEvidenceCandidate,
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
  const score = identityCandidate;
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

export const EXACT_SCIENTIFIC_EVIDENCE_UNAVAILABLE =
  'Exact run, configuration, scoring-version, and provenance identity could not be verified.';

export interface ScientificEvidenceCandidate {
  runId: string;
  entryId: string;
  scoringVersion: string;
  synthetic: boolean;
}

export type ExactScientificEvidenceResolution<TRun extends ScientificRunIdentity> =
  | {
      state: 'exact';
      run: TRun;
      evidence: ExactRunScientificEvidence;
    }
  | { state: 'unavailable' };

export interface ExactEfficiencyRow {
  entry: ScoredLeaderboardEntry;
  row: PublicModelEfficiency;
}

export interface ExactEfficiencyRowsResolution {
  rows: readonly ExactEfficiencyRow[];
  expectedCount: number;
  unavailableCount: number;
  rejectedCount: number;
}

export function resolveExactScientificEvidence<TRun extends ScientificRunIdentity>({
  candidate,
  runs,
  entries,
  efficiencyRows,
}: {
  candidate: ScientificEvidenceCandidate;
  runs: readonly TRun[];
  entries: readonly LeaderboardEntry[];
  efficiencyRows: readonly PublicModelEfficiency[];
}): ExactScientificEvidenceResolution<TRun> {
  const runCandidates = runs.filter((run) => run.id === candidate.runId);
  if (runCandidates.length !== 1) return { state: 'unavailable' };
  const run = runCandidates[0];
  if (!run || !hasExactScientificIdentity(run, candidate)) {
    return { state: 'unavailable' };
  }

  try {
    return {
      state: 'exact',
      run,
      evidence: joinExactRunScientificEvidence({ run, entries, efficiencyRows }),
    };
  } catch {
    return { state: 'unavailable' };
  }
}

export function resolveExactEfficiencyRows({
  runs,
  entries,
  efficiencyRows,
}: {
  runs: readonly ScientificRunIdentity[];
  entries: readonly LeaderboardEntry[];
  efficiencyRows: readonly PublicModelEfficiency[];
}): readonly ExactEfficiencyRow[] {
  return resolveExactEfficiencyRowsWithAvailability({ runs, entries, efficiencyRows }).rows;
}

export function resolveExactEfficiencyRowsWithAvailability({
  runs,
  entries,
  efficiencyRows,
  expectedRunIds = efficiencyRows.map((row) => row.runId),
}: {
  runs: readonly ScientificRunIdentity[];
  entries: readonly LeaderboardEntry[];
  efficiencyRows: readonly PublicModelEfficiency[];
  expectedRunIds?: readonly string[];
}): ExactEfficiencyRowsResolution {
  const expected = new Set(expectedRunIds);
  const rows = efficiencyRows.flatMap((row) => {
    if (!expected.has(row.runId)) return [];
    const entryId = `${row.modelFamily}-${row.reasoningEffort}`;
    const entryCandidates = entries.filter(
      (entry): entry is ScoredLeaderboardEntry =>
        isScoredLeaderboardEntry(entry) && entry.runId === row.runId && entry.id === entryId,
    );
    if (entryCandidates.length !== 1) return [];
    const entry = entryCandidates[0];
    if (!entry) return [];
    const resolution = resolveExactScientificEvidence({
      candidate: {
        runId: entry.runId,
        entryId: entry.id,
        scoringVersion: entry.scoringVersion,
        synthetic: entry.synthetic,
      },
      runs,
      entries,
      efficiencyRows,
    });
    return resolution.state === 'exact' && resolution.evidence.efficiency === row
      ? [{ entry, row }]
      : [];
  });
  const exactRunIds = new Set(rows.map(({ row }) => row.runId));
  return {
    rows,
    expectedCount: expected.size,
    unavailableCount: [...expected].filter((runId) => !exactRunIds.has(runId)).length,
    rejectedCount: efficiencyRows.length - rows.length,
  };
}
