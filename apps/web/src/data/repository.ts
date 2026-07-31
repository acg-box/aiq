import { createClient } from '@supabase/supabase-js';

import { createBoundedSupabaseFetch, createSupabaseApiKeyFetch } from '../server/supabase-http.ts';
import { filterTrendPoints } from './format.ts';
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
  BenchmarkRun,
  BenchmarkRunSummary,
  CapabilityRecordStatus,
  LeaderboardEntry,
  LeaderboardStatus,
  Methodology,
  ModelFamily,
  ObservationRecordStatus,
  ObservationState,
  RadarNode,
  ReasoningTier,
  RunStatus,
  SignatureStatus,
  RunHistoryCursor,
  RunHistoryPage,
  RunHistoryPageRequest,
  TaskResult,
  TrendPoint,
  TrendRange,
} from './types.ts';

export const PUBLIC_VIEW_NAMES = {
  modelMatrix: 'public_model_matrix',
  leaderboard: 'public_leaderboard',
  runs: 'public_runs',
  runResults: 'public_run_results',
  nodes: 'public_nodes',
  distributedRadar: 'public_distributed_radar',
  scoringVersions: 'public_scoring_versions',
  taskCoverage: 'public_task_coverage',
} as const;

export interface ModelMatrixRow {
  id: string;
  model_family: ModelFamily;
  model_name: string;
  reasoning_tier: ReasoningTier;
}

const CANONICAL_MODEL_MATRIX = [
  ['sol-low', 'Sol', 'gpt-5.6-sol', 'low'],
  ['sol-medium', 'Sol', 'gpt-5.6-sol', 'medium'],
  ['sol-high', 'Sol', 'gpt-5.6-sol', 'high'],
  ['sol-xhigh', 'Sol', 'gpt-5.6-sol', 'xhigh'],
  ['sol-max', 'Sol', 'gpt-5.6-sol', 'max'],
  ['sol-ultra', 'Sol', 'gpt-5.6-sol', 'ultra'],
  ['terra-low', 'Terra', 'gpt-5.6-terra', 'low'],
  ['terra-medium', 'Terra', 'gpt-5.6-terra', 'medium'],
  ['terra-high', 'Terra', 'gpt-5.6-terra', 'high'],
  ['terra-xhigh', 'Terra', 'gpt-5.6-terra', 'xhigh'],
  ['terra-max', 'Terra', 'gpt-5.6-terra', 'max'],
  ['terra-ultra', 'Terra', 'gpt-5.6-terra', 'ultra'],
  ['luna-low', 'Luna', 'gpt-5.6-luna', 'low'],
  ['luna-medium', 'Luna', 'gpt-5.6-luna', 'medium'],
  ['luna-high', 'Luna', 'gpt-5.6-luna', 'high'],
  ['luna-xhigh', 'Luna', 'gpt-5.6-luna', 'xhigh'],
  ['luna-max', 'Luna', 'gpt-5.6-luna', 'max'],
] as const satisfies ReadonlyArray<readonly [string, ModelFamily, string, ReasoningTier]>;

export const CANONICAL_MODEL_MATRIX_IDS = CANONICAL_MODEL_MATRIX.map(([id]) => id);

const CANONICAL_MODEL_MATRIX_BY_ID = new Map<
  string,
  {
    index: number;
    modelFamily: ModelFamily;
    modelName: string;
    reasoningTier: ReasoningTier;
  }
>(
  CANONICAL_MODEL_MATRIX.map(([id, modelFamily, modelName, reasoningTier], index) => [
    id,
    { index, modelFamily, modelName, reasoningTier },
  ]),
);

export interface LeaderboardRow {
  matrix_id: string;
  run_id: string | null;
  score: number | null;
  ci_low: number | null;
  ci_high: number | null;
  sample_size: number | null;
  coverage_percent: number | null;
  failures: number | null;
  missing: number | null;
  scoring_version: string | null;
  score_status: string | null;
  synthetic: boolean | null;
}

export interface TrendRow {
  matrix_id: string;
  run_id: string;
  recorded_at: string;
  bucket_started_at: string;
  bucket_ended_at: string;
  score: number;
  ci_low: number;
  ci_high: number;
  sample_size: number;
  represented_run_count: number;
  resolution_seconds: number;
  synthetic: boolean;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTrendRow(value: unknown): value is TrendRow {
  if (!isUnknownRecord(value)) return false;
  const recordedAt = value.recorded_at;
  const bucketStartedAt = value.bucket_started_at;
  const bucketEndedAt = value.bucket_ended_at;
  const score = value.score;
  const ciLow = value.ci_low;
  const ciHigh = value.ci_high;
  const sampleSize = value.sample_size;
  const representedRunCount = value.represented_run_count;
  const resolutionSeconds = value.resolution_seconds;
  return (
    isBoundedIdentifier(value.matrix_id) &&
    isBoundedIdentifier(value.run_id) &&
    isTimestamp(recordedAt) &&
    isTimestamp(bucketStartedAt) &&
    isTimestamp(bucketEndedAt) &&
    Date.parse(bucketStartedAt) <= Date.parse(recordedAt) &&
    Date.parse(recordedAt) < Date.parse(bucketEndedAt) &&
    isFiniteNumber(score) &&
    score >= 0 &&
    score <= 100 &&
    isFiniteNumber(ciLow) &&
    isFiniteNumber(ciHigh) &&
    ciLow <= score &&
    score <= ciHigh &&
    isPositiveCount(sampleSize) &&
    isPositiveCount(representedRunCount) &&
    isCount(resolutionSeconds) &&
    typeof value.synthetic === 'boolean'
  );
}

export interface RunRow {
  id: string;
  matrix_id: string;
  started_at: string;
  completed_at: string;
  benchmark_version: string;
  scoring_version: string;
  prompt_set_digest: string;
  runner_commit: string;
  region: string;
  synthetic: boolean;
  corpus_release_id: string | null;
  corpus_commitment_sha256: string | null;
  catalog_digest: string | null;
  task_set_digest: string | null;
  preflight_digest: string | null;
  runtime_digest: string | null;
  run_class: string | null;
  permission_evidence_digest: string | null;
  result_count: number;
  passed_count: number;
  failed_count: number;
  invalid_count: number;
  missing_count: number;
  not_applicable_count: number;
  observed_count: number;
  coverage_percent: number | null;
  covered_domain_count: number;
  provisional_domain_count: number;
}

export interface RunResultRow {
  run_id: string;
  id: string;
  task: string;
  domain: string;
  status: RunStatus;
  score: number | null;
  explanation_code: string | null;
  explanation_summary: string | null;
  retryable: boolean | null;
  tools: string[];
  latency_ms: number | null;
}

export function mapRunRow(row: RunRow, resultRows: readonly RunResultRow[]): BenchmarkRun {
  return {
    id: row.id,
    entryId: row.matrix_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    benchmarkVersion: row.benchmark_version,
    scoringVersion: row.scoring_version,
    promptSetDigest: row.prompt_set_digest,
    runnerCommit: row.runner_commit,
    region: row.region,
    synthetic: row.synthetic,
    corpusReleaseId: row.corpus_release_id,
    corpusCommitmentSha256: row.corpus_commitment_sha256,
    catalogDigest: row.catalog_digest,
    taskSetDigest: row.task_set_digest,
    preflightDigest: row.preflight_digest,
    runtimeDigest: row.runtime_digest,
    runClass: row.run_class,
    permissionEvidenceDigest: row.permission_evidence_digest,
    tasks: resultRows
      .filter((result) => result.run_id === row.id)
      .map(
        (result): TaskResult => ({
          id: result.id,
          task: result.task,
          domain: result.domain,
          status: result.status,
          score: result.score,
          explanation:
            result.explanation_code && result.explanation_summary && result.retryable !== null
              ? {
                  code: result.explanation_code,
                  summary: result.explanation_summary,
                  retryable: result.retryable,
                }
              : null,
          tools: result.tools,
          latencyMs: result.latency_ms,
        }),
      ),
  };
}

export function mapRunSummaryRow(row: RunRow): BenchmarkRunSummary {
  const { tasks: _tasks, ...run } = mapRunRow(row, []);
  return {
    ...run,
    resultSummary: {
      resultCount: row.result_count,
      observedCount: row.observed_count,
      coveragePercent: row.coverage_percent,
      coveredDomainCount: row.covered_domain_count,
      provisionalDomainCount: row.provisional_domain_count,
      passed: row.passed_count,
      failed: row.failed_count,
      invalid: row.invalid_count,
      missing: row.missing_count,
      notApplicable: row.not_applicable_count,
    },
  };
}

export interface DistributedRadarRow {
  node_id: string;
  name: string;
  operator: string;
  public_key_fingerprint: string;
  registry_trust: RadarNode['registryTrust'];
  registry_status: RadarNode['registryStatus'];
  last_seen_at: string | null;
  synthetic: boolean;
  latest_capability_schema_version: string | null;
  latest_capability_hash: string | null;
  latest_capability_status: CapabilityRecordStatus | null;
  latest_capability_signature_status: SignatureStatus | null;
  latest_capability_observed_at: string | null;
  latest_observation_schema_version: string | null;
  latest_observation_state: ObservationState | null;
  latest_observation_sequence: number | null;
  latest_observation_hash: string | null;
  latest_observation_status: ObservationRecordStatus | null;
  latest_observation_signature_status: SignatureStatus | null;
  latest_observation_observed_at: string | null;
  latest_observation_provenance_hash: string | null;
  assignment_total_count: number;
  assignment_offered_count: number;
  assignment_accepted_count: number;
  assignment_running_count: number;
  assignment_completed_count: number;
  assignment_revoked_count: number;
  assignment_expired_count: number;
  receipt_total_count: number;
  receipt_received_count: number;
  receipt_accepted_count: number;
  receipt_rejected_count: number;
  receiver_verified_trusted_count: number;
  signed_untrusted_count: number;
  rejected_count: number;
  missing_count: number;
  aggregated_at: string | null;
}

interface ScoringVersionRow {
  benchmark_version: string;
  scoring_version: string;
  published_at: string;
  principles: string[];
  missing_policy: string;
  failure_policy: string;
  confidence_policy: string;
  synthetic: boolean;
}

interface TaskCoverageRow {
  scoring_version: string;
  domain: string;
  weight: number;
  task_count: number;
}

const REGISTRY_TRUST = new Set([
  'unverified',
  'signed_community',
  'trusted_verified',
  'independently_reproduced',
]);
const REGISTRY_STATUS = new Set(['pending', 'active', 'degraded', 'offline', 'revoked']);
const CAPABILITY_STATUS = new Set(['declared', 'validated', 'rejected', 'expired']);
const SIGNATURE_STATUS = new Set(['unverified', 'verified', 'rejected']);
const OBSERVATION_STATE = new Set(['ready', 'busy', 'draining', 'degraded', 'offline']);
const OBSERVATION_STATUS = new Set(['observed', 'accepted', 'rejected', 'stale']);
const NODE_ID = /^node_[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CAPABILITY_SCHEMA = 'aiq.distributed-capability.v1';
const OBSERVATION_SCHEMA = 'aiq.distributed-observation.v1';

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isOptionalTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function safeCountSum(values: readonly unknown[]): number | null {
  if (!values.every(isCount)) return null;
  const sum = values.reduce<number>((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

function groupIsComplete(values: readonly unknown[]): boolean {
  return values.every((value) => value === null) || values.every((value) => value !== null);
}

function isEnumValue(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}

function isDistributedRadarRow(value: unknown): value is DistributedRadarRow {
  if (typeof value !== 'object' || value === null) return false;
  const get = (key: keyof DistributedRadarRow): unknown => Reflect.get(value, key);
  const capability = [
    get('latest_capability_schema_version'),
    get('latest_capability_hash'),
    get('latest_capability_status'),
    get('latest_capability_signature_status'),
    get('latest_capability_observed_at'),
  ];
  const observation = [
    get('latest_observation_schema_version'),
    get('latest_observation_state'),
    get('latest_observation_sequence'),
    get('latest_observation_hash'),
    get('latest_observation_status'),
    get('latest_observation_signature_status'),
    get('latest_observation_observed_at'),
    get('latest_observation_provenance_hash'),
  ];
  const counts: readonly (keyof DistributedRadarRow)[] = [
    'assignment_total_count',
    'assignment_offered_count',
    'assignment_accepted_count',
    'assignment_running_count',
    'assignment_completed_count',
    'assignment_revoked_count',
    'assignment_expired_count',
    'receipt_total_count',
    'receipt_received_count',
    'receipt_accepted_count',
    'receipt_rejected_count',
    'receiver_verified_trusted_count',
    'signed_untrusted_count',
    'rejected_count',
    'missing_count',
  ];
  const assignmentStatusCounts = [
    get('assignment_offered_count'),
    get('assignment_accepted_count'),
    get('assignment_running_count'),
    get('assignment_completed_count'),
    get('assignment_revoked_count'),
    get('assignment_expired_count'),
  ];
  const receiptStatusCounts = [
    get('receipt_received_count'),
    get('receipt_accepted_count'),
    get('receipt_rejected_count'),
  ];
  const aggregationCounts = [
    get('receiver_verified_trusted_count'),
    get('signed_untrusted_count'),
    get('rejected_count'),
    get('missing_count'),
  ];
  const assignmentStatusTotal = safeCountSum(assignmentStatusCounts);
  const receiptStatusTotal = safeCountSum(receiptStatusCounts);
  const aggregationTotal = safeCountSum(aggregationCounts);
  const synthetic = get('synthetic');
  const registryTrust = get('registry_trust');
  const capabilitySignature = get('latest_capability_signature_status');
  const observationSignature = get('latest_observation_signature_status');
  const trustedAggregationCount = get('receiver_verified_trusted_count');
  const aggregatedAt = get('aggregated_at');
  const nodeId = get('node_id');
  const publicKeyFingerprint = get('public_key_fingerprint');
  return (
    isBoundedText(nodeId) &&
    NODE_ID.test(nodeId) &&
    isBoundedText(get('name')) &&
    isBoundedText(get('operator')) &&
    typeof publicKeyFingerprint === 'string' &&
    SHA256.test(publicKeyFingerprint) &&
    isEnumValue(registryTrust, REGISTRY_TRUST) &&
    isEnumValue(get('registry_status'), REGISTRY_STATUS) &&
    isOptionalTimestamp(get('last_seen_at')) &&
    typeof synthetic === 'boolean' &&
    groupIsComplete(capability) &&
    (capability[0] === null ||
      (capability[0] === CAPABILITY_SCHEMA &&
        typeof capability[1] === 'string' &&
        SHA256.test(capability[1]) &&
        typeof capability[2] === 'string' &&
        CAPABILITY_STATUS.has(capability[2]) &&
        typeof capability[3] === 'string' &&
        SIGNATURE_STATUS.has(capability[3]) &&
        isTimestamp(capability[4]))) &&
    groupIsComplete(observation) &&
    (observation[0] === null ||
      (observation[0] === OBSERVATION_SCHEMA &&
        typeof observation[1] === 'string' &&
        OBSERVATION_STATE.has(observation[1]) &&
        isPositiveCount(observation[2]) &&
        typeof observation[3] === 'string' &&
        SHA256.test(observation[3]) &&
        typeof observation[4] === 'string' &&
        OBSERVATION_STATUS.has(observation[4]) &&
        typeof observation[5] === 'string' &&
        SIGNATURE_STATUS.has(observation[5]) &&
        isTimestamp(observation[6]) &&
        typeof observation[7] === 'string' &&
        SHA256.test(observation[7]))) &&
    counts.every((key) => isCount(get(key))) &&
    assignmentStatusTotal === get('assignment_total_count') &&
    receiptStatusTotal === get('receipt_total_count') &&
    aggregationTotal !== null &&
    isOptionalTimestamp(aggregatedAt) &&
    ((aggregationTotal === 0 && aggregatedAt === null) ||
      (aggregationTotal > 0 && isTimestamp(aggregatedAt))) &&
    (!synthetic ||
      (registryTrust === 'unverified' &&
        capabilitySignature !== 'verified' &&
        observationSignature !== 'verified' &&
        trustedAggregationCount === 0))
  );
}

function requireRadarValue<Value>(value: Value | null): Value {
  if (value === null) {
    throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.distributedRadar}: incomplete response row`);
  }
  return value;
}

export function parseDistributedRadarRows(value: unknown): readonly RadarNode[] {
  if (!Array.isArray(value) || !value.every(isDistributedRadarRow)) {
    throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.distributedRadar}: invalid response shape`);
  }
  return value.map((row) => ({
    id: row.node_id,
    name: row.name,
    operator: row.operator,
    publicKeyFingerprint: row.public_key_fingerprint,
    registryTrust: row.registry_trust,
    registryStatus: row.registry_status,
    registryLastSeenAt: row.last_seen_at,
    latestCapability:
      row.latest_capability_schema_version === null
        ? null
        : {
            schemaVersion: row.latest_capability_schema_version,
            contentHash: requireRadarValue(row.latest_capability_hash),
            status: requireRadarValue(row.latest_capability_status),
            signatureStatus: requireRadarValue(row.latest_capability_signature_status),
            observedAt: requireRadarValue(row.latest_capability_observed_at),
          },
    latestObservation:
      row.latest_observation_schema_version === null
        ? null
        : {
            schemaVersion: row.latest_observation_schema_version,
            state: requireRadarValue(row.latest_observation_state),
            sequence: requireRadarValue(row.latest_observation_sequence),
            contentHash: requireRadarValue(row.latest_observation_hash),
            recordStatus: requireRadarValue(row.latest_observation_status),
            signatureStatus: requireRadarValue(row.latest_observation_signature_status),
            observedAt: requireRadarValue(row.latest_observation_observed_at),
            provenanceHash: requireRadarValue(row.latest_observation_provenance_hash),
          },
    assignmentCounts: {
      total: row.assignment_total_count,
      offered: row.assignment_offered_count,
      accepted: row.assignment_accepted_count,
      running: row.assignment_running_count,
      completed: row.assignment_completed_count,
      revoked: row.assignment_revoked_count,
      expired: row.assignment_expired_count,
    },
    receiptCounts: {
      total: row.receipt_total_count,
      received: row.receipt_received_count,
      accepted: row.receipt_accepted_count,
      rejected: row.receipt_rejected_count,
    },
    aggregation: {
      receiverVerifiedTrusted: row.receiver_verified_trusted_count,
      signedUntrusted: row.signed_untrusted_count,
      rejected: row.rejected_count,
      missing: row.missing_count,
      aggregatedAt: row.aggregated_at,
    },
    synthetic: row.synthetic,
  }));
}

export class SeedAiqRepository implements AiqRepository {
  readonly mode = 'synthetic' as const;
  readonly configuration = 'seed' as const;

  async listLeaderboard(): Promise<readonly LeaderboardEntry[]> {
    return seedLeaderboard;
  }

  async listTrendPoints(range: TrendRange = 'all'): Promise<readonly TrendPoint[]> {
    const latest = new Date(
      Math.max(...seedTrendPoints.map((point) => new Date(point.recordedAt).getTime())),
    );
    return filterTrendPoints(seedTrendPoints, range, latest);
  }

  async listRunPage(request: RunHistoryPageRequest = {}): Promise<RunHistoryPage> {
    return buildSeedRunHistoryPage(seedRuns, request);
  }

  async getRun(id: string): Promise<BenchmarkRun | null> {
    return seedRuns.find((run) => run.id === id) ?? null;
  }

  async getMethodology(): Promise<Methodology> {
    return seedMethodology;
  }

  async listRadarNodes(): Promise<readonly RadarNode[]> {
    return seedRadarNodes;
  }
}

function normalizeLeaderboardStatus(row: LeaderboardRow | undefined): LeaderboardStatus {
  if (!row) {
    return 'unpublished';
  }
  if (
    row.score_status === 'official' ||
    row.score_status === 'not_applicable' ||
    row.score_status === 'missing'
  ) {
    return row.score_status;
  }
  return 'missing';
}

function orderCanonicalModelMatrix(matrix: readonly unknown[]): readonly ModelMatrixRow[] {
  if (matrix.length !== CANONICAL_MODEL_MATRIX.length) {
    throw new Error(
      `Cannot read ${PUBLIC_VIEW_NAMES.modelMatrix}: expected ${CANONICAL_MODEL_MATRIX.length} canonical rows`,
    );
  }
  const rowsById = new Map<string, ModelMatrixRow>();
  for (const row of matrix) {
    if (!isUnknownRecord(row) || typeof row.id !== 'string') {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.modelMatrix}: invalid canonical matrix`);
    }
    const expected = CANONICAL_MODEL_MATRIX_BY_ID.get(row.id);
    if (
      !expected ||
      rowsById.has(row.id) ||
      row.model_family !== expected.modelFamily ||
      row.model_name !== expected.modelName ||
      row.reasoning_tier !== expected.reasoningTier
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.modelMatrix}: invalid canonical matrix`);
    }
    rowsById.set(row.id, {
      id: row.id,
      model_family: expected.modelFamily,
      model_name: expected.modelName,
      reasoning_tier: expected.reasoningTier,
    });
  }
  return CANONICAL_MODEL_MATRIX_IDS.map((id) => {
    const row = rowsById.get(id);
    if (!row) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.modelMatrix}: incomplete canonical matrix`);
    }
    return row;
  });
}

function isLeaderboardRow(value: unknown): value is LeaderboardRow {
  if (!isUnknownRecord(value)) return false;
  const baseShape =
    isBoundedIdentifier(value.matrix_id) &&
    isBoundedIdentifier(value.run_id) &&
    isBoundedIdentifier(value.scoring_version) &&
    typeof value.synthetic === 'boolean';
  if (!baseShape) return false;
  if (value.score_status === 'official') {
    return (
      isFiniteNumber(value.score) &&
      value.score >= 0 &&
      value.score <= 100 &&
      isFiniteNumber(value.ci_low) &&
      isFiniteNumber(value.ci_high) &&
      value.ci_low >= 0 &&
      value.ci_low <= value.score &&
      value.score <= value.ci_high &&
      value.ci_high <= 100 &&
      isPositiveCount(value.sample_size) &&
      isFiniteNumber(value.coverage_percent) &&
      value.coverage_percent >= 0 &&
      value.coverage_percent <= 100 &&
      isCount(value.failures) &&
      isCount(value.missing)
    );
  }
  return (
    (value.score_status === 'not_applicable' || value.score_status === 'missing') &&
    value.score === null &&
    value.ci_low === null &&
    value.ci_high === null &&
    value.sample_size === null &&
    value.coverage_percent === null &&
    value.failures === null &&
    value.missing === null
  );
}

export function joinModelMatrixWithLeaderboard(
  matrix: readonly ModelMatrixRow[],
  rows: readonly LeaderboardRow[],
): readonly LeaderboardEntry[] {
  const orderedMatrix = orderCanonicalModelMatrix(matrix);
  const scores = new Map<string, LeaderboardRow>();
  for (const row of rows) {
    if (
      !isLeaderboardRow(row) ||
      !CANONICAL_MODEL_MATRIX_BY_ID.has(row.matrix_id) ||
      scores.has(row.matrix_id)
    ) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.leaderboard}: invalid response shape`);
    }
    scores.set(row.matrix_id, row);
  }
  return orderedMatrix.map((identity) => {
    const row = scores.get(identity.id);
    const scoreStatus = normalizeLeaderboardStatus(row);
    const officialRow = scoreStatus === 'official' ? row : undefined;
    return {
      id: identity.id,
      modelFamily: identity.model_family,
      modelName: identity.model_name,
      reasoningTier: identity.reasoning_tier,
      score: officialRow?.score ?? null,
      ciLow: officialRow?.ci_low ?? null,
      ciHigh: officialRow?.ci_high ?? null,
      sampleSize: officialRow?.sample_size ?? null,
      coveragePercent: officialRow?.coverage_percent ?? null,
      failures: officialRow?.failures ?? null,
      missing: officialRow?.missing ?? null,
      scoringVersion: officialRow?.scoring_version ?? null,
      scoreStatus,
      runId: officialRow?.run_id ?? null,
      synthetic: officialRow?.synthetic ?? null,
    };
  });
}

export const PUBLIC_READ_PAGE_SIZE = 1_000;
export const TREND_MAX_POINTS = 340;
export const RUN_HISTORY_PAGE_SIZE = 10;
const MAX_PUBLIC_READ_PAGES = 100;
const RUN_ID_BATCH_SIZE = 50;

function isObservedTask(task: TaskResult): boolean {
  return task.status === 'passed' || task.status === 'failed';
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
      passed: tasks.filter((task) => task.status === 'passed').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      invalid: tasks.filter((task) => task.status === 'invalid').length,
      missing: tasks.filter((task) => task.status === 'missing').length,
      notApplicable: tasks.filter((task) => task.status === 'not_applicable').length,
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
          'matrix_id,run_id,score,ci_low,ci_high,sample_size,coverage_percent,failures,missing,scoring_version,score_status,synthetic',
        )
        .overrideTypes<LeaderboardRow[], { merge: false }>(),
    ]);
    if (result.error) {
      throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.leaderboard}: ${result.error.message}`);
    }
    return joinModelMatrixWithLeaderboard(matrix, result.data);
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
        recordedAt: row.recorded_at,
        bucketStartedAt: row.bucket_started_at,
        bucketEndedAt: row.bucket_ended_at,
        score: row.score,
        ciLow: row.ci_low,
        ciHigh: row.ci_high,
        sampleSize: row.sample_size,
        representedRunCount: row.represented_run_count,
        resolutionSeconds: row.resolution_seconds,
        synthetic: row.synthetic,
      }));
  }

  async #runRows(id?: string): Promise<readonly RunRow[]> {
    return collectPaginatedRows(PUBLIC_VIEW_NAMES.runs, async (firstRow, lastRow) => {
      let query = this.#client
        .from(PUBLIC_VIEW_NAMES.runs)
        .select(
          'id,matrix_id,started_at,completed_at,benchmark_version,scoring_version,prompt_set_digest,runner_commit,region,synthetic,corpus_release_id,corpus_commitment_sha256,catalog_digest,task_set_digest,preflight_digest,runtime_digest,run_class,permission_evidence_digest,result_count,passed_count,failed_count,invalid_count,missing_count,not_applicable_count,observed_count,coverage_percent,covered_domain_count,provisional_domain_count',
        )
        .order('started_at', { ascending: false })
        .order('id', { ascending: true });
      if (id) {
        query = query.eq('id', id);
      }
      return query.range(firstRow, lastRow).overrideTypes<RunRow[], { merge: false }>();
    });
  }

  async #resultRows(runIds: readonly string[]): Promise<readonly RunResultRow[]> {
    if (runIds.length === 0) {
      return [];
    }
    const rows: RunResultRow[] = [];
    for (let offset = 0; offset < runIds.length; offset += RUN_ID_BATCH_SIZE) {
      const batch = runIds.slice(offset, offset + RUN_ID_BATCH_SIZE);
      // oxlint-disable-next-line no-await-in-loop -- bounded batches avoid oversized filter URLs.
      const batchRows = await collectPaginatedRows(
        PUBLIC_VIEW_NAMES.runResults,
        async (firstRow, lastRow) =>
          this.#client
            .from(PUBLIC_VIEW_NAMES.runResults)
            .select(
              'run_id,id,task,domain,status,score,explanation_code,explanation_summary,retryable,tools,latency_ms',
            )
            .in('run_id', batch)
            .order('run_id', { ascending: true })
            .order('id', { ascending: true })
            .range(firstRow, lastRow)
            .overrideTypes<RunResultRow[], { merge: false }>(),
      );
      rows.push(...batchRows);
    }
    return rows;
  }

  #assembleRuns(
    rows: readonly RunRow[],
    resultRows: readonly RunResultRow[],
  ): readonly BenchmarkRun[] {
    return rows.map((row) => mapRunRow(row, resultRows));
  }

  async listRunPage(request: RunHistoryPageRequest = {}): Promise<RunHistoryPage> {
    const direction = request.direction ?? 'older';
    const cursor = request.cursor ? decodeRunHistoryCursor(request.cursor) : undefined;
    if (cursor) {
      const boundary = await this.#client
        .from(PUBLIC_VIEW_NAMES.runs)
        .select('id,started_at')
        .eq('id', cursor.id)
        .eq('started_at', cursor.startedAt)
        .limit(1)
        .overrideTypes<Array<Pick<RunRow, 'id' | 'started_at'>>, { merge: false }>();
      if (boundary.error) {
        throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: ${boundary.error.message}`);
      }
      if (boundary.data.length !== 1) throw new Error('Invalid run-history cursor.');
    }
    let query = this.#client
      .from(PUBLIC_VIEW_NAMES.runs)
      .select(
        'id,matrix_id,started_at,completed_at,benchmark_version,scoring_version,prompt_set_digest,runner_commit,region,synthetic,corpus_release_id,corpus_commitment_sha256,catalog_digest,task_set_digest,preflight_digest,runtime_digest,run_class,permission_evidence_digest,result_count,passed_count,failed_count,invalid_count,missing_count,not_applicable_count,observed_count,coverage_percent,covered_domain_count,provisional_domain_count',
      );
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
      .overrideTypes<RunRow[], { merge: false }>();
    if (error) throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.runs}: ${error.message}`);
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

  async getRun(id: string): Promise<BenchmarkRun | null> {
    const runs = await this.#runRows(id);
    const results = await this.#resultRows(runs.map((run) => run.id));
    return this.#assembleRuns(runs, results)[0] ?? null;
  }

  async getMethodology(): Promise<Methodology> {
    const [versionResult, coverageResult] = await Promise.all([
      this.#client
        .from(PUBLIC_VIEW_NAMES.scoringVersions)
        .select(
          'benchmark_version,scoring_version,published_at,principles,missing_policy,failure_policy,confidence_policy,synthetic',
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
    return {
      benchmarkVersion: version.benchmark_version,
      scoringVersion: version.scoring_version,
      publishedAt: version.published_at,
      principles: version.principles,
      missingPolicy: version.missing_policy,
      failurePolicy: version.failure_policy,
      confidencePolicy: version.confidence_policy,
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
  async listTrendPoints(): Promise<readonly TrendPoint[]> {
    throw this.#error;
  }
  async listRunPage(): Promise<RunHistoryPage> {
    throw this.#error;
  }
  async getRun(): Promise<BenchmarkRun | null> {
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
