import { AIQ_CORE_SCORING_VERSION, AIQ_CORE_TASK_SET_VERSION } from '../aiq-core-contract.ts';
import { resolveExactScientificEvidence } from '../components/scientific-evidence-resolution.ts';
import { readPublicData } from '../data/read-state.ts';
import { createAiqRepository, SupabaseAiqRepository } from '../data/repository.ts';
import type { CoreResultDataset } from '../data/core-results.ts';
import { isScoredLeaderboardEntry } from '../data/types.ts';

// Shared server read for the board and homepage; keep the same publication identity checks.
export async function readCoreResults() {
  const repository = createAiqRepository();
  const results = await readPublicData(
    repository,
    () => repository.listLeaderboard(),
    [],
    (rows) => rows.length === 0,
    (rows) => rows.map((row) => row.synthetic),
  );
  const archive =
    repository instanceof SupabaseAiqRepository && results.state !== 'unavailable'
      ? await readPublicData(
          repository,
          () => repository.listHistoricalCoreResults(results.data),
          [],
          (rows) => rows.length === 0,
          (rows) => rows.map((row) => row.entry.synthetic),
        )
      : null;
  const archivedRunIds = new Set(archive?.data.map(({ run }) => run.id));
  const official = results.data
    .filter(isScoredLeaderboardEntry)
    .filter(
      (entry) =>
        entry.scoreStatus === 'official' &&
        entry.scoringVersion === AIQ_CORE_SCORING_VERSION &&
        !archivedRunIds.has(entry.runId),
    );
  const runs =
    official.length > 0
      ? await readPublicData(
          repository,
          () => repository.listRunSummaries(official.map((entry) => entry.runId)),
          [],
          (rows) => rows.length === 0,
          (rows) => rows.map((run) => run.synthetic),
        )
      : null;
  const verified = official.flatMap((entry) => {
    const resolution = resolveExactScientificEvidence({
      candidate: {
        runId: entry.runId,
        entryId: entry.id,
        scoringVersion: entry.scoringVersion,
        synthetic: entry.synthetic,
      },
      runs: runs?.data ?? [],
      entries: official,
      efficiencyRows: [],
    });
    return resolution.state === 'exact' ? [{ entry, run: resolution.run }] : [];
  });
  const unavailable =
    results.state === 'unavailable' ||
    runs?.state === 'unavailable' ||
    verified.length !== official.length;
  const rows = unavailable ? [] : verified;
  const datasets: [CoreResultDataset, ...CoreResultDataset[]] = [
    {
      id: 'current',
      version: AIQ_CORE_TASK_SET_VERSION,
      historical: false,
      state: unavailable
        ? 'unavailable'
        : results.state === 'synthetic'
          ? 'preview'
          : rows.length > 0
            ? 'available'
            : 'empty',
      rows: rows.map(({ entry, run }) => ({
        entry,
        completedAt: run.completedAt,
        evidenceHref: `/benchmarks/intelligence/records/${entry.runId}`,
      })),
    },
  ];
  if (archive && archive.data.length > 0)
    datasets.push({
      id: 'historical-1.0.7',
      version: '1.0.7',
      historical: true,
      state: 'available',
      rows: archive.data.map(({ entry, run }) => ({
        entry,
        completedAt: run.completedAt,
        evidenceHref: `/api/benchmarks/intelligence/records/${run.id}`,
      })),
    });

  return { repository, archive, verified, unavailable, datasets };
}
