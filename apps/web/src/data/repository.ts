import { createClient } from '@supabase/supabase-js';
import {
  AIQ_CORE_BENCHMARK_VERSION,
  AIQ_CORE_SCORING_VERSION,
  AIQ_CORE_TASK_SET_VERSION,
} from '../aiq-core-contract.ts';
import { createBoundedSupabaseFetch, createSupabaseApiKeyFetch } from '../server/supabase-http.ts';
import { filterTrendPoints, latestCompletedRun } from './format.ts';
import {
  inspectPublicSupabaseConfiguration,
  type PublicDataConfiguration,
} from './public-configuration.ts';
import {
  seedLeaderboard,
  seedMethodology,
  seedRadarNodes,
  seedRuns,
  seedTrendPoints,
} from './seed.ts';
import type {
  AiqRepository,
  HistoricalCoreResult,
  BenchmarkRun,
  BenchmarkRunSummary,
  CalibrationModelSelection,
  CalibrationOutcome,
  CalibrationRunPage,
  CalibrationRunPageRequest,
  LeaderboardEntry,
  Methodology,
  PublicCalibrationRun,
  PublicCalibrationRunSummary,
  PublicCalibrationScore,
  PublicModelEfficiency,
  PublicSpeedObservation,
  RadarNode,
  RunHistoryCursor,
  RunHistoryPage,
  RunHistoryPageRequest,
  ScoredLeaderboardEntry,
  TaskResult,
  SpeedTrendPoint,
  TrendPoint,
  TrendRange,
} from './types.ts';
import { isScoredLeaderboardEntry } from './types.ts';
import { PUBLIC_VIEW_NAMES } from './public-views.ts';
import {
  RUN_SUMMARY_SELECT,
  type LeaderboardRow,
  isTrendRow,
  type RunRow,
  RUN_ID,
  BENCHMARK_DOMAIN_TASK_COUNTS,
  isRunSummaryRowForBenchmark,
  isRunSummaryRow,
  runRowsFollowQueryOrder,
  type RunResultRow,
  isRunResultRow,
  mapRunRow,
  mapRunSummaryRow,
  type ScoringVersionRow,
  type TaskCoverageRow,
  orderCanonicalModelMatrix,
  joinModelMatrixWithLeaderboard,
} from './rows/core.ts';
import {
  type ModelMatrixRow,
  CALIBRATION_MODEL_CONFIGURATIONS,
  calibrationConfigurationKey,
  CALIBRATION_CONFIGURATION_KEYS,
  CALIBRATION_CONFIGURATION_INDEX,
  CANONICAL_MODEL_MATRIX_BY_ID,
} from './model-matrix.ts';
import { isUnknownRecord, hasExactKeys, isBoundedIdentifier } from './rows/validation.ts';
import {
  isSpeedObservationRow,
  isSpeedTrendRow,
  mapSpeedObservationRow,
  mapSpeedTrendRow,
} from './rows/speed.ts';
import {
  isCalibrationRunRow,
  isCalibrationResultRow,
  isCalibrationScoreRow,
  isModelEfficiencyRow,
  mapCalibrationRunSummary,
  mapCalibrationRun,
  mapCalibrationScoreRow,
  mapModelEfficiencyRow,
} from './rows/calibration.ts';
import { parseDistributedRadarRows } from './rows/radar.ts';

const seedCalibrationRun: PublicCalibrationRun = {
  id: `run_${'c'.repeat(64)}`,
  classification: 'local_calibration_non_official',
  scoringVersion: AIQ_CORE_SCORING_VERSION,
  selectedTaskCount: 1,
  selectedModelCount: 1,
  resultCount: 1,
  startedAt: '2026-07-27T12:00:00Z',
  completedAt: '2026-07-27T12:00:01Z',
  verifiedAt: '2026-07-27T12:00:02Z',
  publishedAt: '2026-07-27T12:00:03Z',
  replayStatus: 'evaluator_replayed',
  official: false,
  rankingEligible: false,
  pricingCurrency: 'USD',
  pricingProcessingTier: 'standard',
  synthetic: true,
  selectedConfiguration: { modelFamily: 'sol', reasoningEffort: 'low' },
  results: [
    {
      id: `result_${'d'.repeat(64)}`,
      runId: `run_${'c'.repeat(64)}`,
      taskId: 'synthetic-calibration-task',
      taskVersion: AIQ_CORE_TASK_SET_VERSION,
      domain: 'coding',
      modelFamily: 'sol',
      reasoningEffort: 'low',
      outcome: 'correct',
      executionStatus: 'completed',
      failureCode: null,
      explanationCode: null,
      explanationSummary: null,
      taskScore: 1,
      latencyMs: null,
      latencyEvidenceLevel: null,
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      tokenUsageSourceLevel: null,
      tokenUsageEvidenceLevel: null,
      standardApiEquivalentUsdNanos: null,
      costEstimatorStatus: 'unavailable_missing_usage',
      costEvidenceLevel: null,
      costEstimatorLimitations: ['Synthetic seed has no provider usage.'],
      costMethod: null,
      costVersion: null,
      costAsOf: null,
      costSource: null,
      pricingCurrency: 'USD',
      pricingProcessingTier: 'standard',
    },
  ],
};

const seedCalibrationScores: readonly PublicCalibrationScore[] = [
  {
    runId: seedCalibrationRun.id,
    modelFamily: 'sol',
    reasoningEffort: 'low',
    descriptiveStatus: 'coverage_only',
    qualityScore: null,
    taskResamplingSensitivityLower: null,
    taskResamplingSensitivityUpper: null,
    taskResamplingSensitivityMethod: null,
    sampleSize: 1,
    resultCount: 1,
    coveragePercent: 100 / 72,
    observedTotalWallMs: null,
    observedMedianWallMs: null,
    observedP95WallMs: null,
    observedTimeSampleCount: 0,
    observedTimeCoveragePercent: 0,
    durationEvidenceLevel: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    tokenUsageSampleCount: 0,
    tokenUsageSourceLevel: null,
    tokenUsageEvidenceLevel: null,
    standardApiEquivalentUsdNanos: null,
    estimatedCostSampleCount: 0,
    costEstimatorStatus: 'unavailable_missing_usage',
    costEvidenceLevel: null,
    costEstimatorLimitations: ['Synthetic seed has no token usage evidence.'],
    tokenUsageCoveragePercent: null,
    pricingSource: null,
    pricingAsOf: null,
    pricingVersion: null,
    pricingCurrency: 'USD',
    pricingProcessingTier: 'standard',
    attemptedResultCount: 0,
    invokedResultCount: 0,
    adapterElapsedObservedResultCount: 0,
    tokenObservedResultCount: 0,
    pricedResultCount: 0,
    synthetic: true,
  },
];

export class SeedAiqRepository implements AiqRepository {
  readonly mode = 'synthetic' as const;
  readonly configuration = 'seed' as const;

  async listLeaderboard(): Promise<readonly LeaderboardEntry[]> {
    return seedLeaderboard;
  }

  async listHistoricalCoreResults(): Promise<readonly HistoricalCoreResult[]> {
    return [];
  }

  async listTrendPoints(range: TrendRange = 'all'): Promise<readonly TrendPoint[]> {
    const latest = new Date(
      Math.max(...seedTrendPoints.map((point) => new Date(point.recordedAt).getTime())),
    );
    return filterTrendPoints(seedTrendPoints, range, latest);
  }

  async listSpeedObservations(): Promise<readonly PublicSpeedObservation[]> {
    return [];
  }

  async listSpeedTrendPoints(_range: TrendRange = 'all'): Promise<readonly SpeedTrendPoint[]> {
    return [];
  }

  async listRunPage(request: RunHistoryPageRequest = {}): Promise<RunHistoryPage> {
    return buildSeedRunHistoryPage(seedRuns, request);
  }

  async listRunSummaries(runIds: readonly string[]): Promise<readonly BenchmarkRunSummary[]> {
    const selected = new Set(runIds);
    return seedRuns.filter((run) => selected.has(run.id)).map(runSummaryFromRun);
  }

  async getNewestCompletedRun(): Promise<BenchmarkRunSummary | null> {
    const run = latestCompletedRun(seedRuns);
    return run ? runSummaryFromRun(run) : null;
  }

  async getRun(id: string): Promise<BenchmarkRun | null> {
    return seedRuns.find((run) => run.id === id) ?? null;
  }

  async listCalibrationRunPage(
    request: CalibrationRunPageRequest = {},
  ): Promise<CalibrationRunPage> {
    const {
      results: _results,
      selectedConfiguration: _selectedConfiguration,
      ...summary
    } = seedCalibrationRun;
    return buildSeedCalibrationRunPage([summary], request);
  }

  async getCalibrationRun(
    id: string,
    selection: CalibrationModelSelection,
  ): Promise<PublicCalibrationRun | null> {
    return id === seedCalibrationRun.id &&
      calibrationConfigurationKey(selection) ===
        calibrationConfigurationKey(seedCalibrationRun.selectedConfiguration)
      ? seedCalibrationRun
      : null;
  }

  async listCalibrationScores(runId: string): Promise<readonly PublicCalibrationScore[]> {
    return seedCalibrationScores.filter((score) => score.runId === runId);
  }

  async listModelEfficiency(_runIds: readonly string[]): Promise<readonly PublicModelEfficiency[]> {
    return [];
  }

  async getMethodology(): Promise<Methodology> {
    return seedMethodology;
  }

  async listRadarNodes(): Promise<readonly RadarNode[]> {
    return seedRadarNodes;
  }
}

export const PUBLIC_READ_PAGE_SIZE = 1_000;
export const TREND_MAX_POINTS = 340;
export const SPEED_TREND_MAX_POINTS = 680;
export const RUN_HISTORY_PAGE_SIZE = 10;
export const CALIBRATION_RUN_PAGE_SIZE = 20;
const MAX_PUBLIC_READ_PAGES = 100;
const RUN_ID_BATCH_SIZE = 50;

function isObservedTask(task: TaskResult): boolean {
  return task.executionStatus === 'completed';
}

function runSummaryFromRun(run: BenchmarkRun): BenchmarkRunSummary {
  const { tasks, ...metadata } = run;
  const observedTasks = tasks.filter(isObservedTask);
  const observedCountsByDomain = new Map<string, number>();
  for (const task of observedTasks) {
    observedCountsByDomain.set(task.domain, (observedCountsByDomain.get(task.domain) ?? 0) + 1);
  }
  return {
    ...metadata,
    resultSummary: {
      resultCount: tasks.length,
      observedCount: observedTasks.length,
      coveragePercent: tasks.length === 0 ? null : (observedTasks.length / tasks.length) * 100,
      coveredDomainCount: [...observedCountsByDomain.values()].filter((count) => count >= 1).length,
      provisionalDomainCount: [...observedCountsByDomain.values()].filter((count) => count >= 4)
        .length,
      correctCount: tasks.filter((task) => task.outcome === 'correct').length,
      partialCount: tasks.filter((task) => task.outcome === 'partial').length,
      incorrectCount: tasks.filter((task) => task.outcome === 'incorrect').length,
      runtimeIssueCount: tasks.filter((task) => task.executionStatus === 'runtime_issue').length,
      invalidCount: tasks.filter((task) => task.executionStatus === 'invalid').length,
      missingCount: tasks.filter((task) => task.executionStatus === 'missing').length,
      notApplicableCount: tasks.filter((task) => task.executionStatus === 'not_applicable').length,
      completedCount: tasks.filter((task) => task.executionStatus === 'completed').length,
    },
  };
}

export function encodeRunHistoryCursor(cursor: RunHistoryCursor): string {
  return Buffer.from(JSON.stringify([cursor.startedAt, cursor.id]), 'utf8').toString('base64url');
}

export function decodeRunHistoryCursor(value: string): RunHistoryCursor {
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid run-history cursor.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid run-history cursor.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed[0]) ||
    Number.isNaN(Date.parse(parsed[0])) ||
    typeof parsed[1] !== 'string' ||
    parsed[1].length === 0 ||
    parsed[1].length > 160 ||
    !/^[A-Za-z0-9:_-]+$/.test(parsed[1])
  ) {
    throw new Error('Invalid run-history cursor.');
  }
  return { startedAt: parsed[0], id: parsed[1] };
}

export function encodeCalibrationRunCursor(cursor: RunHistoryCursor): string {
  return encodeRunHistoryCursor(cursor);
}

export function decodeCalibrationRunCursor(value: string): RunHistoryCursor {
  try {
    return decodeRunHistoryCursor(value);
  } catch {
    throw new Error('Invalid calibration-run cursor.');
  }
}

function compareRunKeys(
  left: Pick<BenchmarkRun, 'startedAt' | 'id'>,
  right: Pick<BenchmarkRun, 'startedAt' | 'id'>,
): number {
  return right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id);
}

function cursorFor(run: Pick<BenchmarkRun, 'startedAt' | 'id'>): string {
  return encodeRunHistoryCursor({ startedAt: run.startedAt, id: run.id });
}

export function buildSeedRunHistoryPage(
  runs: readonly BenchmarkRun[],
  request: RunHistoryPageRequest = {},
): RunHistoryPage {
  const ordered = runs.toSorted(compareRunKeys);
  const cursor = request.cursor ? decodeRunHistoryCursor(request.cursor) : undefined;
  const cursorIndex = cursor
    ? ordered.findIndex((run) => run.startedAt === cursor.startedAt && run.id === cursor.id)
    : -1;
  if (cursor && cursorIndex === -1) throw new Error('Invalid run-history cursor.');
  const direction = request.direction ?? 'older';
  const start = cursor
    ? direction === 'older'
      ? cursorIndex + 1
      : Math.max(0, cursorIndex - RUN_HISTORY_PAGE_SIZE)
    : 0;
  const end = cursor && direction === 'newer' ? cursorIndex : start + RUN_HISTORY_PAGE_SIZE;
  const selected = ordered.slice(start, end);
  const selectedLast = selected.at(-1);
  return {
    runs: selected.map(runSummaryFromRun),
    newerCursor: start > 0 && selected[0] ? cursorFor(selected[0]) : null,
    olderCursor: end < ordered.length && selectedLast ? cursorFor(selectedLast) : null,
  };
}

export function buildSeedCalibrationRunPage(
  runs: readonly PublicCalibrationRunSummary[],
  request: CalibrationRunPageRequest = {},
): CalibrationRunPage {
  const ordered = runs.toSorted(compareRunKeys);
  const cursor = request.cursor ? decodeCalibrationRunCursor(request.cursor) : undefined;
  const cursorIndex = cursor
    ? ordered.findIndex((run) => run.startedAt === cursor.startedAt && run.id === cursor.id)
    : -1;
  if (cursor && cursorIndex === -1) throw new Error('Invalid calibration-run cursor.');
  const direction = request.direction ?? 'older';
  const start = cursor
    ? direction === 'older'
      ? cursorIndex + 1
      : Math.max(0, cursorIndex - CALIBRATION_RUN_PAGE_SIZE)
    : 0;
  const end = cursor && direction === 'newer' ? cursorIndex : start + CALIBRATION_RUN_PAGE_SIZE;
  const selected = ordered.slice(start, end);
  const selectedLast = selected.at(-1);
  return {
    runs: selected,
    newerCursor:
      start > 0 && selected[0]
        ? encodeCalibrationRunCursor({ startedAt: selected[0].startedAt, id: selected[0].id })
        : null,
    olderCursor:
      end < ordered.length && selectedLast
        ? encodeCalibrationRunCursor({
            startedAt: selectedLast.startedAt,
            id: selectedLast.id,
          })
        : null,
  };
}

type PageReader<Row> = (
  firstRow: number,
  lastRow: number,
) => Promise<{ data: readonly Row[] | null; error: { message: string } | null }>;

export async function collectPaginatedRows<Row>(
  resource: string,
  readPage: PageReader<Row>,
): Promise<readonly Row[]> {
  const rows: Row[] = [];
  const pageFingerprints = new Set<string>();

  for (let page = 0; page < MAX_PUBLIC_READ_PAGES; page += 1) {
    const firstRow = page * PUBLIC_READ_PAGE_SIZE;
    // oxlint-disable-next-line no-await-in-loop -- each offset depends on the prior page ending.
    const result = await readPage(firstRow, firstRow + PUBLIC_READ_PAGE_SIZE - 1);
    if (result.error) {
      throw new Error(`Cannot read ${resource}: ${result.error.message}`);
    }
    const pageRows = result.data ?? [];
    if (pageRows.length > PUBLIC_READ_PAGE_SIZE) {
      throw new Error(`Cannot read ${resource}: page exceeded the requested size`);
    }
    if (pageRows.length === 0) {
      return rows;
    }
    const fingerprint = JSON.stringify(pageRows);
    if (pageFingerprints.has(fingerprint)) {
      throw new Error(`Cannot read ${resource}: repeated page detected`);
    }
    pageFingerprints.add(fingerprint);
    rows.push(...pageRows);
    if (pageRows.length < PUBLIC_READ_PAGE_SIZE) {
      return rows;
    }
  }

  throw new Error(`Cannot read ${resource}: exceeded ${MAX_PUBLIC_READ_PAGES} pages`);
}

export class SupabaseAiqRepository implements AiqRepository {
  readonly mode = 'live' as const;
  readonly configuration = 'live' as const;
  readonly #client: ReturnType<typeof createClient>;
  readonly #url: string;
  readonly #publishableKey: string;
  readonly #fetchImplementation: typeof fetch;

  constructor(
    url: string,
    publishableKey: string,
    fetchImplementation: typeof fetch = createBoundedSupabaseFetch(),
  ) {
    this.#url = url;
    this.#publishableKey = publishableKey;
    this.#fetchImplementation = fetchImplementation;
    this.#client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: createSupabaseApiKeyFetch(publishableKey, undefined, fetchImplementation),
      },
    });
  }

  async #modelMatrix(): Promise<readonly ModelMatrixRow[]> {
    const { data, error } = await this.#client
      .from(PUBLIC_VIEW_NAMES.modelMatrix)
      .select('id,model_family,model_name,reasoning_tier')
      .overrideTypes<ModelMatrixRow[], { merge: false }>();
    if (error) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.modelMatrix}: ${error.message}`);
    }
    return orderCanonicalModelMatrix(data);
  }

  async listLeaderboard(): Promise<readonly LeaderboardEntry[]> {
    const [matrix, result] = await Promise.all([
      this.#modelMatrix(),
      this.#client
        .from(PUBLIC_VIEW_NAMES.leaderboard)
        .select(
          'matrix_id,run_id,score,theta,standard_error,theta_ci_low,theta_ci_high,score_ci_low,score_ci_high,information,quality_score,strict_pass_rate,strict_pass_low,strict_pass_high,strict_pass_sample_size,strict_pass_successes,reliability_status,calibration_status,sensitivity_low,sensitivity_high,sample_size,coverage_percent,runtime_issues,missing,scoring_version,score_status,synthetic',
        )
        .overrideTypes<LeaderboardRow[], { merge: false }>(),
    ]);
    if (result.error) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.leaderboard}: ${result.error.message}`);
    }
    return joinModelMatrixWithLeaderboard(matrix, result.data);
  }

  /** Read the published 1.0.7 archive without admitting it to the active Core repository. */
  async listHistoricalCoreResults(
    entries: readonly LeaderboardEntry[],
  ): Promise<readonly HistoricalCoreResult[]> {
    const candidates = entries.filter(
      (entry): entry is ScoredLeaderboardEntry =>
        isScoredLeaderboardEntry(entry) && entry.scoreStatus === 'official',
    );
    if (candidates.length === 0) return [];
    const { data, error } = await this.#client
      .from(PUBLIC_VIEW_NAMES.runs)
      .select(RUN_SUMMARY_SELECT)
      .in(
        'id',
        candidates.map((entry) => entry.runId),
      )
      .eq('benchmark_version', 'aiq-core@1.0.7')
      .limit(candidates.length + 1)
      .overrideTypes<unknown[], { merge: false }>();
    if (error) throw new Error(`Cannot read historical Core results: ${error.message}`);
    if (
      data.length > candidates.length ||
      !data.every((row) => isRunSummaryRowForBenchmark(row, 'aiq-core@1.0.7'))
    ) {
      throw new Error('Cannot read historical Core results: invalid run records');
    }
    const identities = new Set<string>();
    return data.map((row) => {
      const matching = candidates.filter((entry) => entry.runId === row.id);
      const entry = matching[0];
      if (
        matching.length !== 1 ||
        !entry ||
        identities.has(row.id) ||
        row.matrix_id !== entry.id ||
        row.scoring_version !== entry.scoringVersion ||
        row.synthetic ||
        row.run_class !== 'official' ||
        row.result_count !== entry.sampleSize ||
        row.observed_count !== entry.sampleSize ||
        row.coverage_percent !== entry.coveragePercent
      ) {
        throw new Error('Cannot read historical Core results: mismatched result identity');
      }
      identities.add(row.id);
      return { entry, run: mapRunSummaryRow(row), source: row };
    });
  }

  async listTrendPoints(range: TrendRange = 'all'): Promise<readonly TrendPoint[]> {
    const response = await this.#fetchImplementation(
      `${this.#url}/rest/v1/rpc/public_trend_points`,
      {
        method: 'POST',
        headers: {
          apikey: this.#publishableKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ supplied_range: range }),
      },
    );
    if (!response.ok) {
      throw new Error(`Cannot read public_trend_points: HTTP ${response.status}`);
    }
    const decoded: unknown = await response.json();
    if (!Array.isArray(decoded) || !decoded.every(isTrendRow)) {
      throw new Error('Cannot read public_trend_points: invalid response shape');
    }
    const data = decoded;
    if (data.length > TREND_MAX_POINTS) {
      throw new Error(
        `Cannot read public_trend_points: response exceeded ${TREND_MAX_POINTS} rows`,
      );
    }
    const rowsByIdentity = new Set<string>();
    const pointsPerConfiguration = new Map<string, number>();
    for (const row of data) {
      if (!CANONICAL_MODEL_MATRIX_BY_ID.has(row.matrix_id)) {
        throw new Error('Cannot read public_trend_points: unknown matrix identity');
      }
      const identity = `${row.matrix_id}\0${row.recorded_at}`;
      if (rowsByIdentity.has(identity)) {
        throw new Error('Cannot read public_trend_points: duplicate trend point');
      }
      rowsByIdentity.add(identity);
      const count = (pointsPerConfiguration.get(row.matrix_id) ?? 0) + 1;
      if (count > 20) {
        throw new Error('Cannot read public_trend_points: configuration exceeded 20 rows');
      }
      pointsPerConfiguration.set(row.matrix_id, count);
    }
    return data
      .toSorted(
        (left, right) =>
          (CANONICAL_MODEL_MATRIX_BY_ID.get(left.matrix_id)?.index ?? Number.MAX_SAFE_INTEGER) -
            (CANONICAL_MODEL_MATRIX_BY_ID.get(right.matrix_id)?.index ?? Number.MAX_SAFE_INTEGER) ||
          left.recorded_at.localeCompare(right.recorded_at),
      )
      .map((row) => ({
        entryId: row.matrix_id,
        runId: row.run_id,
        scoringVersion: row.scoring_version,
        recordedAt: row.recorded_at,
        bucketStartedAt: row.bucket_started_at,
        bucketEndedAt: row.bucket_ended_at,
        score: row.score,
        theta: row.theta,
        standardError: row.standard_error,
        thetaCiLow: row.theta_ci_low,
        thetaCiHigh: row.theta_ci_high,
        scoreCiLow: row.score_ci_low,
        scoreCiHigh: row.score_ci_high,
        information: row.information,
        qualityScore: row.quality_score,
        strictPassRate: row.strict_pass_rate,
        strictPassLow: row.strict_pass_low,
        strictPassHigh: row.strict_pass_high,
        strictPassSampleSize: row.strict_pass_sample_size,
        strictPassSuccesses: row.strict_pass_successes,
        reliabilityStatus: row.reliability_status,
        calibrationStatus: row.calibration_status,
        sensitivityLow: row.sensitivity_low,
        sensitivityHigh: row.sensitivity_high,
        sampleSize: row.sample_size,
        representedRunCount: row.represented_run_count,
        resolutionSeconds: row.resolution_seconds,
        synthetic: row.synthetic,
      }));
  }

  async listSpeedObservations(): Promise<readonly PublicSpeedObservation[]> {
    const { data, error } = await this.#client
      .from(PUBLIC_VIEW_NAMES.speedObservations)
      .select(
        'batch_id,observed_at,model_family,reasoning_effort,mode,availability_status,availability_reason,trials_per_mode,attempted_trials,completed_trials,invalid_response_trials,failed_trials,median_elapsed_ms,p95_elapsed_ms,median_aggregate_output_tps_millis,estimated_credits_nanos,estimated_credit_sample_count,input_tokens,cached_input_tokens,output_tokens,total_tokens,median_agent_steps,median_tool_call_count,median_ttft_ms,ttft_status,median_post_first_token_output_tps_millis,post_first_token_output_tps_status,catalog_status,codex_version,credit_rate_card_version,scoring_impact',
      )
      .order('observed_at', { ascending: false })
      .order('model_family', { ascending: true })
      .order('reasoning_effort', { ascending: true })
      .order('mode', { ascending: true })
      .limit(34)
      .overrideTypes<unknown[], { merge: false }>();
    if (error) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.speedObservations}: ${error.message}`);
    }
    if (!data.every(isSpeedObservationRow)) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.speedObservations}: invalid response shape`);
    }
    if (data.length === 0) return [];
    const batchId = data[0]?.batch_id;
    const identities = new Set<string>();
    for (const row of data) {
      const identity = `${row.model_family}:${row.reasoning_effort}:${row.mode}`;
      if (row.batch_id !== batchId || identities.has(identity)) {
        throw new Error(
          `Cannot read ${PUBLIC_VIEW_NAMES.speedObservations}: inconsistent latest batch`,
        );
      }
      identities.add(identity);
    }
    if (data.length !== 34) {
      throw new Error(
        `Cannot read ${PUBLIC_VIEW_NAMES.speedObservations}: incomplete latest batch`,
      );
    }
    return data
      .map(mapSpeedObservationRow)
      .toSorted(
        (left, right) =>
          (CANONICAL_MODEL_MATRIX_BY_ID.get(left.entryId)?.index ?? Number.MAX_SAFE_INTEGER) -
            (CANONICAL_MODEL_MATRIX_BY_ID.get(right.entryId)?.index ?? Number.MAX_SAFE_INTEGER) ||
          left.mode.localeCompare(right.mode),
      );
  }

  async listSpeedTrendPoints(range: TrendRange = 'all'): Promise<readonly SpeedTrendPoint[]> {
    const response = await this.#fetchImplementation(
      `${this.#url}/rest/v1/rpc/public_speed_trend_points`,
      {
        method: 'POST',
        headers: {
          apikey: this.#publishableKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ supplied_range: range }),
      },
    );
    if (!response.ok) {
      throw new Error(`Cannot read public_speed_trend_points: HTTP ${response.status}`);
    }
    const decoded: unknown = await response.json();
    if (!Array.isArray(decoded) || !decoded.every(isSpeedTrendRow)) {
      throw new Error('Cannot read public_speed_trend_points: invalid response shape');
    }
    if (decoded.length > SPEED_TREND_MAX_POINTS) {
      throw new Error(
        `Cannot read public_speed_trend_points: response exceeded ${SPEED_TREND_MAX_POINTS} rows`,
      );
    }
    const identities = new Set<string>();
    const seriesCounts = new Map<string, number>();
    for (const row of decoded) {
      const series = `${row.model_family}:${row.reasoning_effort}:${row.mode}`;
      const identity = `${series}:${row.recorded_at}`;
      if (identities.has(identity)) {
        throw new Error('Cannot read public_speed_trend_points: duplicate trend point');
      }
      identities.add(identity);
      const count = (seriesCounts.get(series) ?? 0) + 1;
      if (count > 20) {
        throw new Error('Cannot read public_speed_trend_points: series exceeded 20 rows');
      }
      seriesCounts.set(series, count);
    }
    return decoded
      .map(mapSpeedTrendRow)
      .toSorted(
        (left, right) =>
          (CANONICAL_MODEL_MATRIX_BY_ID.get(left.entryId)?.index ?? Number.MAX_SAFE_INTEGER) -
            (CANONICAL_MODEL_MATRIX_BY_ID.get(right.entryId)?.index ?? Number.MAX_SAFE_INTEGER) ||
          left.mode.localeCompare(right.mode) ||
          left.recordedAt.localeCompare(right.recordedAt),
      );
  }

  async #runRows(id?: string): Promise<readonly RunRow[]> {
    const rows = await collectPaginatedRows(PUBLIC_VIEW_NAMES.runs, async (firstRow, lastRow) => {
      let query = this.#client
        .from(PUBLIC_VIEW_NAMES.runs)
        .select(RUN_SUMMARY_SELECT)
        .order('started_at', { ascending: false })
        .order('id', { ascending: true });
      if (id) {
        query = query.eq('id', id);
      }
      return query.range(firstRow, lastRow).overrideTypes<unknown[], { merge: false }>();
    });
    if (!rows.every(isRunSummaryRow) || (id !== undefined && rows.some((row) => row.id !== id))) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: invalid response shape`);
    }
    const identities = new Set<string>();
    for (const row of rows) {
      if (identities.has(row.id)) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: duplicate run identity`);
      }
      identities.add(row.id);
    }
    return rows;
  }

  async #resultRows(runs: readonly RunRow[]): Promise<readonly RunResultRow[]> {
    const runIds = runs.map((run) => run.id);
    if (runIds.length === 0) {
      return [];
    }
    const rows: RunResultRow[] = [];
    const requestedRunIds = new Set(runIds);
    const matrixIdByRun = new Map(runs.map((run) => [run.id, run.matrix_id]));
    const resultIdentities = new Set<string>();
    for (let offset = 0; offset < runIds.length; offset += RUN_ID_BATCH_SIZE) {
      const batch = runIds.slice(offset, offset + RUN_ID_BATCH_SIZE);
      // oxlint-disable-next-line no-await-in-loop -- bounded batches avoid oversized filter URLs.
      const batchRows = await collectPaginatedRows(
        PUBLIC_VIEW_NAMES.runResults,
        async (firstRow, lastRow) =>
          this.#client
            .from(PUBLIC_VIEW_NAMES.runResults)
            .select(
              'run_id,id,task_id,task,domain,outcome,execution_status,score,explanation_code,explanation_summary,retryable,tools,agent_steps,tool_call_count,tool_calls_by_type,latency_ms,latency_evidence_level,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,token_usage_source_level,token_usage_evidence_level,standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level,pricing_digest',
            )
            .in('run_id', batch)
            .order('run_id', { ascending: true })
            .order('id', { ascending: true })
            .range(firstRow, lastRow)
            .overrideTypes<unknown[], { merge: false }>(),
      );
      if (
        !batchRows.every((row) => isRunResultRow(row, matrixIdByRun)) ||
        batchRows.some((row) => !requestedRunIds.has(row.run_id))
      ) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runResults}: invalid response shape`);
      }
      for (const row of batchRows) {
        const identity = `${row.run_id}\0${row.id}`;
        if (resultIdentities.has(identity)) {
          throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runResults}: duplicate result identity`);
        }
        resultIdentities.add(identity);
      }
      rows.push(...batchRows);
    }
    return rows;
  }

  #assembleRuns(
    rows: readonly RunRow[],
    resultRows: readonly RunResultRow[],
  ): readonly BenchmarkRun[] {
    const runIds = new Set(rows.map((row) => row.id));
    if (resultRows.some((row) => !runIds.has(row.run_id))) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runResults}: invalid run identity`);
    }
    for (const row of rows) {
      const results = resultRows.filter((result) => result.run_id === row.id);
      const taskIds = new Set(results.map((result) => result.task_id));
      const domainCounts = new Map<string, number>();
      for (const result of results) {
        domainCounts.set(result.domain, (domainCounts.get(result.domain) ?? 0) + 1);
      }
      const outcomeCount = (outcome: CalibrationOutcome): number =>
        results.filter((result) => result.outcome === outcome).length;
      const completedCount = results.filter(
        (result) => result.execution_status === 'completed',
      ).length;
      const runtimeIssueCount = results.filter(
        (result) => result.execution_status === 'runtime_issue',
      ).length;
      const observedByDomain = new Map<string, number>();
      for (const result of results) {
        if (
          result.execution_status === 'completed' ||
          result.execution_status === 'runtime_issue'
        ) {
          observedByDomain.set(result.domain, (observedByDomain.get(result.domain) ?? 0) + 1);
        }
      }
      const coveredDomainCount = [...observedByDomain.values()].filter(
        (count) => count >= 1,
      ).length;
      const provisionalDomainCount = [...observedByDomain.values()].filter(
        (count) => count >= 4,
      ).length;
      if (
        results.length !== row.result_count ||
        taskIds.size !== results.length ||
        (results.length === 72 &&
          [...BENCHMARK_DOMAIN_TASK_COUNTS].some(
            ([domain, expectedCount]) => domainCounts.get(domain) !== expectedCount,
          )) ||
        outcomeCount('correct') !== row.correct_count ||
        outcomeCount('partial') !== row.partial_count ||
        outcomeCount('incorrect') !== row.incorrect_count ||
        runtimeIssueCount !== row.runtime_issue_count ||
        outcomeCount('invalid') !== row.invalid_count ||
        outcomeCount('missing') !== row.missing_count ||
        outcomeCount('not_applicable') !== row.not_applicable_count ||
        completedCount !== row.completed_count ||
        completedCount + runtimeIssueCount !== row.observed_count ||
        coveredDomainCount !== row.covered_domain_count ||
        provisionalDomainCount !== row.provisional_domain_count
      ) {
        throw new Error(
          `Cannot read ${PUBLIC_VIEW_NAMES.runResults}: result summary does not match run`,
        );
      }
    }
    return rows.map((row) => mapRunRow(row, resultRows));
  }

  async listRunPage(request: RunHistoryPageRequest = {}): Promise<RunHistoryPage> {
    const direction = request.direction ?? 'older';
    if (direction !== 'older' && direction !== 'newer') {
      throw new Error('Invalid run-history direction.');
    }
    const cursor = request.cursor ? decodeRunHistoryCursor(request.cursor) : undefined;
    if (cursor) {
      const boundary = await this.#client
        .from(PUBLIC_VIEW_NAMES.runs)
        .select('id,started_at')
        .eq('id', cursor.id)
        .eq('started_at', cursor.startedAt)
        .limit(1)
        .overrideTypes<unknown[], { merge: false }>();
      if (boundary.error) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: ${boundary.error.message}`);
      }
      if (
        boundary.data.length !== 1 ||
        !boundary.data.every(
          (row) =>
            isUnknownRecord(row) &&
            hasExactKeys(row, new Set(['id', 'started_at'])) &&
            row.id === cursor.id &&
            row.started_at === cursor.startedAt,
        )
      ) {
        throw new Error('Invalid run-history cursor.');
      }
    }
    let query = this.#client.from(PUBLIC_VIEW_NAMES.runs).select(RUN_SUMMARY_SELECT);
    if (cursor) {
      const timestampOperator = direction === 'older' ? 'lt' : 'gt';
      const idOperator = direction === 'older' ? 'gt' : 'lt';
      query = query.or(
        `started_at.${timestampOperator}.${cursor.startedAt},and(started_at.eq.${cursor.startedAt},id.${idOperator}.${cursor.id})`,
      );
    }
    const ascending = direction === 'newer';
    const { data, error } = await query
      .order('started_at', { ascending })
      .order('id', { ascending: !ascending })
      .limit(RUN_HISTORY_PAGE_SIZE + 1)
      .overrideTypes<unknown[], { merge: false }>();
    if (error) throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: ${error.message}`);
    if (!data.every(isRunSummaryRow)) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: invalid response shape`);
    }
    const runIdentities = new Set<string>();
    for (const row of data) {
      if (runIdentities.has(row.id)) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: duplicate run identity`);
      }
      runIdentities.add(row.id);
    }
    if (!runRowsFollowQueryOrder(data, ascending)) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: invalid response order`);
    }
    const hasMore = data.length > RUN_HISTORY_PAGE_SIZE;
    const pageRows = data.slice(0, RUN_HISTORY_PAGE_SIZE);
    if (ascending) pageRows.reverse();
    const first = pageRows[0];
    const last = pageRows.at(-1);
    return {
      runs: pageRows.map(mapRunSummaryRow),
      newerCursor:
        first && (direction === 'older' ? Boolean(cursor) : hasMore)
          ? cursorFor({ startedAt: first.started_at, id: first.id })
          : null,
      olderCursor:
        last && (direction === 'newer' ? Boolean(cursor) : hasMore)
          ? cursorFor({ startedAt: last.started_at, id: last.id })
          : null,
    };
  }

  async listRunSummaries(runIds: readonly string[]): Promise<readonly BenchmarkRunSummary[]> {
    const selectedRunIds = [...new Set(runIds)];
    if (
      selectedRunIds.length > TREND_MAX_POINTS ||
      selectedRunIds.some((runId) => !isBoundedIdentifier(runId))
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: invalid run selection`);
    }
    if (selectedRunIds.length === 0) return [];
    const rows: unknown[] = [];
    for (let offset = 0; offset < selectedRunIds.length; offset += RUN_ID_BATCH_SIZE) {
      const batch = selectedRunIds.slice(offset, offset + RUN_ID_BATCH_SIZE);
      // oxlint-disable-next-line no-await-in-loop -- bounded batches avoid oversized filter URLs.
      const result = await this.#client
        .from(PUBLIC_VIEW_NAMES.runs)
        .select(RUN_SUMMARY_SELECT)
        .in('id', batch)
        .order('id', { ascending: true })
        .limit(batch.length + 1)
        .overrideTypes<unknown[], { merge: false }>();
      if (result.error) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: ${result.error.message}`);
      }
      rows.push(...result.data);
    }
    const selected = new Set(selectedRunIds);
    if (
      !rows.every(isRunSummaryRow) ||
      rows.length > selectedRunIds.length ||
      rows.some((row) => !selected.has(row.id))
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: invalid response shape`);
    }
    const identities = new Set<string>();
    for (const row of rows) {
      if (identities.has(row.id)) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: duplicate run identity`);
      }
      identities.add(row.id);
    }
    return rows.map(mapRunSummaryRow);
  }

  async getNewestCompletedRun(): Promise<BenchmarkRunSummary | null> {
    const { data, error } = await this.#client
      .from(PUBLIC_VIEW_NAMES.runs)
      .select(RUN_SUMMARY_SELECT)
      .order('completed_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(1)
      .overrideTypes<unknown[], { merge: false }>();
    if (error) throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: ${error.message}`);
    if (data.length > 1 || !data.every(isRunSummaryRow)) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: invalid response shape`);
    }
    const row = data[0];
    return row ? mapRunSummaryRow(row) : null;
  }

  async getRun(id: string): Promise<BenchmarkRun | null> {
    if (!RUN_ID.test(id)) {
      return null;
    }
    const runs = await this.#runRows(id);
    const results = await this.#resultRows(runs);
    return this.#assembleRuns(runs, results)[0] ?? null;
  }

  async listCalibrationRunPage(
    request: CalibrationRunPageRequest = {},
  ): Promise<CalibrationRunPage> {
    const direction = request.direction ?? 'older';
    if (direction !== 'older' && direction !== 'newer') {
      throw new Error('Invalid calibration-run direction.');
    }
    const cursor = request.cursor ? decodeCalibrationRunCursor(request.cursor) : undefined;
    if (cursor) {
      const boundary = await this.#client
        .from(PUBLIC_VIEW_NAMES.calibrationRuns)
        .select('run_id,started_at')
        .eq('run_id', cursor.id)
        .eq('started_at', cursor.startedAt)
        .limit(1)
        .overrideTypes<unknown[], { merge: false }>();
      if (boundary.error) {
        throw new Error(
          `Cannot read ${PUBLIC_VIEW_NAMES.calibrationRuns}: ${boundary.error.message}`,
        );
      }
      const boundaryRow = boundary.data[0];
      if (
        boundary.data.length !== 1 ||
        !isUnknownRecord(boundaryRow) ||
        boundaryRow.run_id !== cursor.id ||
        boundaryRow.started_at !== cursor.startedAt
      ) {
        throw new Error('Invalid calibration-run cursor.');
      }
    }
    let query = this.#client
      .from(PUBLIC_VIEW_NAMES.calibrationRuns)
      .select(
        'run_id,classification,scoring_version,selected_task_count,selected_model_count,result_count,started_at,completed_at,verified_at,published_at,replay_status,official,ranking_eligible,pricing_currency,pricing_processing_tier',
      );
    if (cursor) {
      const timestampOperator = direction === 'older' ? 'lt' : 'gt';
      const idOperator = direction === 'older' ? 'gt' : 'lt';
      query = query.or(
        `started_at.${timestampOperator}.${cursor.startedAt},and(started_at.eq.${cursor.startedAt},run_id.${idOperator}.${cursor.id})`,
      );
    }
    const ascending = direction === 'newer';
    const { data, error } = await query
      .order('started_at', { ascending })
      .order('run_id', { ascending: !ascending })
      .limit(CALIBRATION_RUN_PAGE_SIZE + 1)
      .overrideTypes<unknown[], { merge: false }>();
    if (error) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.calibrationRuns}: ${error.message}`);
    }
    if (
      !Array.isArray(data) ||
      data.length > CALIBRATION_RUN_PAGE_SIZE + 1 ||
      !data.every(isCalibrationRunRow)
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.calibrationRuns}: invalid response shape`);
    }
    const rowIdentities = new Set<string>();
    for (let index = 0; index < data.length; index += 1) {
      const row = data[index];
      const previous = data[index - 1];
      if (!row || rowIdentities.has(row.run_id)) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.calibrationRuns}: duplicate run identity`);
      }
      rowIdentities.add(row.run_id);
      if (previous) {
        const comparison = compareRunKeys(
          { startedAt: previous.started_at, id: previous.run_id },
          { startedAt: row.started_at, id: row.run_id },
        );
        if ((ascending && comparison < 0) || (!ascending && comparison > 0)) {
          throw new Error(
            `Cannot read ${PUBLIC_VIEW_NAMES.calibrationRuns}: unstable run ordering`,
          );
        }
      }
    }
    const hasMore = data.length > CALIBRATION_RUN_PAGE_SIZE;
    const pageRows = data.slice(0, CALIBRATION_RUN_PAGE_SIZE);
    if (ascending) pageRows.reverse();
    const first = pageRows[0];
    const last = pageRows.at(-1);
    return {
      runs: pageRows.map(mapCalibrationRunSummary),
      newerCursor:
        first && (direction === 'older' ? Boolean(cursor) : hasMore)
          ? encodeCalibrationRunCursor({ startedAt: first.started_at, id: first.run_id })
          : null,
      olderCursor:
        last && (direction === 'newer' ? Boolean(cursor) : hasMore)
          ? encodeCalibrationRunCursor({ startedAt: last.started_at, id: last.run_id })
          : null,
    };
  }

  async getCalibrationRun(
    id: string,
    selection: CalibrationModelSelection,
  ): Promise<PublicCalibrationRun | null> {
    if (!isBoundedIdentifier(id)) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.calibrationRuns}: invalid run identity`);
    }
    if (!CALIBRATION_CONFIGURATION_KEYS.has(calibrationConfigurationKey(selection))) {
      throw new Error(
        `Cannot read ${PUBLIC_VIEW_NAMES.calibrationResults}: unsupported calibration model configuration`,
      );
    }
    const runResult = await this.#client
      .from(PUBLIC_VIEW_NAMES.calibrationRuns)
      .select(
        'run_id,classification,scoring_version,selected_task_count,selected_model_count,result_count,started_at,completed_at,verified_at,published_at,replay_status,official,ranking_eligible,pricing_currency,pricing_processing_tier',
      )
      .eq('run_id', id)
      .limit(2)
      .overrideTypes<unknown[], { merge: false }>();
    if (runResult.error)
      throw new Error(
        `Cannot read ${PUBLIC_VIEW_NAMES.calibrationRuns}: ${runResult.error.message}`,
      );
    if (
      !Array.isArray(runResult.data) ||
      runResult.data.length > 1 ||
      !runResult.data.every(isCalibrationRunRow)
    )
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.calibrationRuns}: invalid response shape`);
    const run = runResult.data[0];
    if (!run) return null;
    const result = await this.#client
      .from(PUBLIC_VIEW_NAMES.calibrationResults)
      .select(
        'result_id,run_id,task_id,task_version,domain,model_family,reasoning_effort,outcome,execution_status,failure_code,explanation_code,explanation_summary,task_score,latency_ms,latency_evidence_level,input_tokens,cached_input_tokens,output_tokens,cache_write_input_tokens,reasoning_output_tokens,total_tokens,token_usage_source_level,token_usage_evidence_level,standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level,cost_estimator_limitations,cost_method,cost_version,cost_as_of,cost_source,pricing_currency,pricing_processing_tier',
      )
      .eq('run_id', id)
      .eq('model_family', selection.modelFamily)
      .eq('reasoning_effort', selection.reasoningEffort)
      .order('result_id', { ascending: true })
      .limit(run.selected_task_count + 1)
      .overrideTypes<unknown[], { merge: false }>();
    if (result.error) {
      throw new Error(
        `Cannot read ${PUBLIC_VIEW_NAMES.calibrationResults}: ${result.error.message}`,
      );
    }
    const resultRows = result.data;
    if (
      !Array.isArray(resultRows) ||
      !resultRows.every(isCalibrationResultRow) ||
      resultRows.length !== run.selected_task_count ||
      resultRows.some(
        (row) =>
          row.run_id !== id ||
          row.model_family !== selection.modelFamily ||
          row.reasoning_effort !== selection.reasoningEffort,
      )
    )
      throw new Error(
        `Cannot read ${PUBLIC_VIEW_NAMES.calibrationResults}: invalid response shape`,
      );
    const resultIds = resultRows.map((row) => row.result_id);
    const taskIds = resultRows.map((row) => row.task_id);
    if (
      new Set(resultIds).size !== resultIds.length ||
      new Set(taskIds).size !== taskIds.length ||
      resultIds.some((resultId, index) => index > 0 && resultId <= (resultIds[index - 1] ?? ''))
    )
      throw new Error(
        `Cannot read ${PUBLIC_VIEW_NAMES.calibrationResults}: incomplete or unstable result ordering`,
      );
    return mapCalibrationRun(run, resultRows, selection);
  }

  async listCalibrationScores(runId: string): Promise<readonly PublicCalibrationScore[]> {
    if (!isBoundedIdentifier(runId)) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.calibrationScores}: invalid run identity`);
    }
    const { data, error } = await this.#client
      .from(PUBLIC_VIEW_NAMES.calibrationScores)
      .select(
        'run_id,model_family,reasoning_effort,descriptive_status,quality_score,task_resampling_sensitivity_lower,task_resampling_sensitivity_upper,task_resampling_sensitivity_method,result_count,sample_size,coverage_percent,observed_total_wall_ms,observed_median_wall_ms,observed_p95_wall_ms,observed_time_sample_count,observed_time_coverage_percent,duration_evidence_level,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,token_usage_sample_count,token_usage_source_level,token_usage_evidence_level,standard_api_equivalent_usd_nanos,estimated_cost_sample_count,token_usage_coverage_percent,cost_estimator_status,cost_evidence_level,cost_estimator_limitations,pricing_source,pricing_as_of,pricing_version,pricing_currency,pricing_processing_tier,attempted_result_count,invoked_result_count,adapter_elapsed_observed_result_count,token_observed_result_count,priced_result_count',
      )
      .eq('run_id', runId)
      .order('model_family', { ascending: true })
      .order('reasoning_effort', { ascending: true })
      .limit(CALIBRATION_MODEL_CONFIGURATIONS.length + 1)
      .overrideTypes<unknown[], { merge: false }>();
    if (error) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.calibrationScores}: ${error.message}`);
    }
    if (
      !Array.isArray(data) ||
      data.length > CALIBRATION_MODEL_CONFIGURATIONS.length ||
      !data.every(isCalibrationScoreRow) ||
      data.some(
        (row) =>
          row.run_id !== runId ||
          !CALIBRATION_CONFIGURATION_KEYS.has(
            calibrationConfigurationKey({
              modelFamily: row.model_family,
              reasoningEffort: row.reasoning_effort,
            }),
          ),
      )
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.calibrationScores}: invalid response shape`);
    }
    const identities = new Set<string>();
    for (const row of data) {
      const identity = `${row.model_family}\0${row.reasoning_effort}`;
      if (identities.has(identity)) {
        throw new Error(
          `Cannot read ${PUBLIC_VIEW_NAMES.calibrationScores}: duplicate score identity`,
        );
      }
      identities.add(identity);
    }
    return data
      .toSorted(
        (left, right) =>
          (CALIBRATION_CONFIGURATION_INDEX.get(
            calibrationConfigurationKey({
              modelFamily: left.model_family,
              reasoningEffort: left.reasoning_effort,
            }),
          ) ?? Number.MAX_SAFE_INTEGER) -
          (CALIBRATION_CONFIGURATION_INDEX.get(
            calibrationConfigurationKey({
              modelFamily: right.model_family,
              reasoningEffort: right.reasoning_effort,
            }),
          ) ?? Number.MAX_SAFE_INTEGER),
      )
      .map(mapCalibrationScoreRow);
  }

  async listModelEfficiency(runIds: readonly string[]): Promise<readonly PublicModelEfficiency[]> {
    const selectedRunIds = [...new Set(runIds)];
    if (
      selectedRunIds.length > TREND_MAX_POINTS ||
      selectedRunIds.some((runId) => !isBoundedIdentifier(runId))
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.modelEfficiency}: invalid run selection`);
    }
    if (selectedRunIds.length === 0) return [];
    const maximumRows = selectedRunIds.length;
    const data: unknown[] = [];
    for (let offset = 0; offset < selectedRunIds.length; offset += RUN_ID_BATCH_SIZE) {
      const runIdBatch = selectedRunIds.slice(offset, offset + RUN_ID_BATCH_SIZE);
      // oxlint-disable-next-line no-await-in-loop -- bounded batches avoid oversized filter URLs.
      const result = await this.#client
        .from(PUBLIC_VIEW_NAMES.modelEfficiency)
        .select(
          'run_id,matrix_batch_id,model_family,reasoning_effort,matrix_batch_elapsed_ms,summed_cell_adapter_elapsed_ms,observed_median_wall_ms,observed_p95_wall_ms,observed_time_sample_count,observed_time_coverage_percent,duration_evidence_level,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,token_usage_sample_count,token_usage_coverage_percent,input_token_coverage_count,input_token_coverage_percent,cached_input_token_coverage_count,cached_input_token_coverage_percent,cache_write_input_token_coverage_count,cache_write_input_token_coverage_percent,output_token_coverage_count,output_token_coverage_percent,reasoning_token_coverage_count,reasoning_token_coverage_percent,total_token_coverage_count,total_token_coverage_percent,token_usage_source_level,token_usage_evidence_level,standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level,cost_method,pricing_source,pricing_as_of,pricing_version,pricing_currency,pricing_processing_tier,result_count,attempted_result_count,invoked_result_count,adapter_elapsed_observed_result_count,token_observed_result_count,priced_result_count,execution_concurrency,estimated_cost_sample_count,cost_estimator_limitations,pricing_rates,cost_formula',
        )
        .in('run_id', runIdBatch)
        .order('run_id', { ascending: true })
        .limit(runIdBatch.length + 1)
        .overrideTypes<unknown[], { merge: false }>();
      if (result.error) {
        throw new Error(
          `Cannot read ${PUBLIC_VIEW_NAMES.modelEfficiency}: ${result.error.message}`,
        );
      }
      data.push(...result.data);
    }
    const selectedRunIdSet = new Set(selectedRunIds);
    if (
      !Array.isArray(data) ||
      data.length > maximumRows ||
      !data.every(isModelEfficiencyRow) ||
      data.some(
        (row) =>
          !selectedRunIdSet.has(row.run_id) ||
          !CALIBRATION_CONFIGURATION_KEYS.has(
            calibrationConfigurationKey({
              modelFamily: row.model_family,
              reasoningEffort: row.reasoning_effort,
            }),
          ),
      )
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.modelEfficiency}: invalid response shape`);
    }
    const batchElapsedById = new Map<string, number>();
    for (const row of data) {
      const priorElapsed = batchElapsedById.get(row.matrix_batch_id);
      if (priorElapsed !== undefined && priorElapsed !== row.matrix_batch_elapsed_ms) {
        throw new Error(
          `Cannot read ${PUBLIC_VIEW_NAMES.modelEfficiency}: inconsistent matrix batch elapsed time`,
        );
      }
      batchElapsedById.set(row.matrix_batch_id, row.matrix_batch_elapsed_ms);
    }
    const identities = new Set<string>();
    for (const row of data) {
      if (identities.has(row.run_id)) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.modelEfficiency}: duplicate run identity`);
      }
      identities.add(row.run_id);
    }
    return data.map(mapModelEfficiencyRow);
  }

  async getMethodology(): Promise<Methodology> {
    const [versionResult, coverageResult] = await Promise.all([
      this.#client
        .from(PUBLIC_VIEW_NAMES.scoringVersions)
        .select(
          'benchmark_version,scoring_version,published_at,principles,missing_policy,failure_policy,sensitivity_policy,synthetic',
        )
        .order('published_at', { ascending: false })
        .limit(1)
        .single()
        .overrideTypes<ScoringVersionRow, { merge: false }>(),
      this.#client
        .from(PUBLIC_VIEW_NAMES.taskCoverage)
        .select('scoring_version,domain,weight,task_count')
        .overrideTypes<TaskCoverageRow[], { merge: false }>(),
    ]);
    if (versionResult.error) {
      throw new Error(
        `Cannot read ${PUBLIC_VIEW_NAMES.scoringVersions}: ${versionResult.error.message}`,
      );
    }
    if (coverageResult.error) {
      throw new Error(
        `Cannot read ${PUBLIC_VIEW_NAMES.taskCoverage}: ${coverageResult.error.message}`,
      );
    }
    const version = versionResult.data;
    if (
      version.benchmark_version !== AIQ_CORE_BENCHMARK_VERSION ||
      version.scoring_version !== AIQ_CORE_SCORING_VERSION ||
      !Array.isArray(coverageResult.data) ||
      coverageResult.data.some((coverage) => coverage.scoring_version !== AIQ_CORE_SCORING_VERSION)
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.scoringVersions}: stale active tuple`);
    }
    return {
      benchmarkVersion: version.benchmark_version,
      scoringVersion: version.scoring_version,
      publishedAt: version.published_at,
      principles: version.principles,
      missingPolicy: version.missing_policy,
      failurePolicy: version.failure_policy,
      sensitivityPolicy: version.sensitivity_policy,
      synthetic: version.synthetic,
      domainWeights: coverageResult.data
        .filter((coverage) => coverage.scoring_version === version.scoring_version)
        .map((coverage) => ({
          domain: coverage.domain,
          weight: coverage.weight,
          taskCount: coverage.task_count,
        })),
    };
  }

  async listRadarNodes(): Promise<readonly RadarNode[]> {
    const { data, error } = await this.#client
      .from(PUBLIC_VIEW_NAMES.distributedRadar)
      .select(
        'node_id,name,operator,public_key_fingerprint,registry_trust,registry_status,last_seen_at,synthetic,latest_capability_schema_version,latest_capability_hash,latest_capability_status,latest_capability_signature_status,latest_capability_observed_at,latest_observation_schema_version,latest_observation_state,latest_observation_sequence,latest_observation_hash,latest_observation_status,latest_observation_signature_status,latest_observation_observed_at,latest_observation_provenance_hash,assignment_total_count,assignment_offered_count,assignment_accepted_count,assignment_running_count,assignment_completed_count,assignment_revoked_count,assignment_expired_count,receipt_total_count,receipt_received_count,receipt_accepted_count,receipt_rejected_count,receiver_verified_trusted_count,signed_untrusted_count,rejected_count,missing_count,aggregated_at',
      )
      .overrideTypes<unknown[], { merge: false }>();
    if (error) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.distributedRadar}: ${error.message}`);
    }
    return parseDistributedRadarRows(data);
  }
}

class InvalidLiveAiqRepository implements AiqRepository {
  readonly mode = 'live' as const;
  readonly configuration = 'invalid' as const;
  readonly #error: Error;

  constructor(issues: readonly string[]) {
    this.#error = new Error(
      issues.length > 0
        ? `Public Supabase configuration is invalid: ${issues.join('; ')}.`
        : 'Public Supabase client configuration could not be initialized.',
    );
  }

  async listLeaderboard(): Promise<readonly LeaderboardEntry[]> {
    throw this.#error;
  }
  async listHistoricalCoreResults(): Promise<readonly HistoricalCoreResult[]> {
    throw this.#error;
  }
  async listTrendPoints(): Promise<readonly TrendPoint[]> {
    throw this.#error;
  }
  async listSpeedObservations(): Promise<readonly PublicSpeedObservation[]> {
    throw this.#error;
  }
  async listSpeedTrendPoints(): Promise<readonly SpeedTrendPoint[]> {
    throw this.#error;
  }
  async listRunPage(): Promise<RunHistoryPage> {
    throw this.#error;
  }
  async listRunSummaries(_runIds: readonly string[]): Promise<readonly BenchmarkRunSummary[]> {
    throw this.#error;
  }
  async getNewestCompletedRun(): Promise<BenchmarkRunSummary | null> {
    throw this.#error;
  }
  async getRun(): Promise<BenchmarkRun | null> {
    throw this.#error;
  }
  async listCalibrationRunPage(): Promise<CalibrationRunPage> {
    throw this.#error;
  }
  async getCalibrationRun(
    _id: string,
    _selection: CalibrationModelSelection,
  ): Promise<PublicCalibrationRun | null> {
    throw this.#error;
  }
  async listCalibrationScores(_runId: string): Promise<readonly PublicCalibrationScore[]> {
    throw this.#error;
  }
  async listModelEfficiency(_runIds: readonly string[]): Promise<readonly PublicModelEfficiency[]> {
    throw this.#error;
  }
  async getMethodology(): Promise<Methodology> {
    throw this.#error;
  }
  async listRadarNodes(): Promise<readonly RadarNode[]> {
    throw this.#error;
  }
}

export function createAiqRepository(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AiqRepository {
  const configuration = inspectPublicSupabaseConfiguration(environment);
  if (configuration.state === 'live' && configuration.url && configuration.publishableKey) {
    try {
      return new SupabaseAiqRepository(configuration.url, configuration.publishableKey);
    } catch {
      return new InvalidLiveAiqRepository([]);
    }
  }
  if (configuration.state === 'invalid') {
    return new InvalidLiveAiqRepository(configuration.issues);
  }
  return new SeedAiqRepository();
}

export function classifyPublicDataConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PublicDataConfiguration {
  return inspectPublicSupabaseConfiguration(environment).state;
}
