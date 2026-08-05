import {
  isScoredLeaderboardEntry,
  type LeaderboardEntry,
  type PublicModelEfficiency,
  type ScoredLeaderboardEntry,
} from '../data/types.ts';
import {
  hasExactScientificIdentity,
  joinExactRunScientificEvidence,
  type ExactRunScientificEvidence,
  type ScientificRunIdentity,
} from './scientific-score-context.ts';

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
