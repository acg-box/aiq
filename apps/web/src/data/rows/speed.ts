import type {
  CalibrationModelFamily,
  ModelFamily,
  PublicSpeedObservation,
  ReasoningTier,
  SpeedTrendPoint,
} from '../types.ts';
import { CANONICAL_MODEL_MATRIX } from '../model-matrix.ts';
import {
  isUnknownRecord,
  nullableCount,
  hasExactKeys,
  isBoundedText,
  isTimestamp,
  isCount,
  isPositiveCount,
  safeCountSum,
} from './validation.ts';

const SPEED_CONFIGURATION_BY_KEY = new Map(
  CANONICAL_MODEL_MATRIX.map(([id, modelFamily, , reasoningTier]) => [
    `${modelFamily.toLowerCase()}:${reasoningTier}`,
    { entryId: id, modelFamily, reasoningTier },
  ]),
);

const SPEED_OBSERVATION_KEYS = new Set<keyof SpeedObservationRow>([
  'batch_id',
  'observed_at',
  'model_family',
  'reasoning_effort',
  'mode',
  'availability_status',
  'availability_reason',
  'trials_per_mode',
  'attempted_trials',
  'completed_trials',
  'invalid_response_trials',
  'failed_trials',
  'median_elapsed_ms',
  'p95_elapsed_ms',
  'median_aggregate_output_tps_millis',
  'estimated_credits_nanos',
  'estimated_credit_sample_count',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'total_tokens',
  'median_agent_steps',
  'median_tool_call_count',
  'median_ttft_ms',
  'ttft_status',
  'median_post_first_token_output_tps_millis',
  'post_first_token_output_tps_status',
  'catalog_status',
  'codex_version',
  'credit_rate_card_version',
  'scoring_impact',
]);

const SPEED_TREND_KEYS = new Set<keyof SpeedTrendRow>([
  'model_family',
  'reasoning_effort',
  'mode',
  'recorded_at',
  'bucket_started_at',
  'bucket_ended_at',
  'attempted_trials',
  'completed_trials',
  'represented_batch_count',
  'median_elapsed_ms',
  'p95_elapsed_ms',
  'median_aggregate_output_tps_millis',
  'estimated_credits_nanos',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'total_tokens',
  'median_agent_steps',
  'median_tool_call_count',
  'resolution_seconds',
]);

interface SpeedObservationRow {
  batch_id: string;
  observed_at: string;
  model_family: CalibrationModelFamily;
  reasoning_effort: ReasoningTier;
  mode: 'normal' | 'fast';
  availability_status: 'available' | 'unsupported' | 'unavailable';
  availability_reason: string | null;
  trials_per_mode: number;
  attempted_trials: number;
  completed_trials: number;
  invalid_response_trials: number;
  failed_trials: number;
  median_elapsed_ms: number | null;
  p95_elapsed_ms: number | null;
  median_aggregate_output_tps_millis: number | null;
  estimated_credits_nanos: number | null;
  estimated_credit_sample_count: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  median_agent_steps: number | null;
  median_tool_call_count: number | null;
  median_ttft_ms: null;
  ttft_status: 'unavailable';
  median_post_first_token_output_tps_millis: null;
  post_first_token_output_tps_status: 'unavailable';
  catalog_status: 'available' | 'unavailable';
  codex_version: string | null;
  credit_rate_card_version: string;
  scoring_impact: 'none';
}

interface SpeedTrendRow {
  model_family: CalibrationModelFamily;
  reasoning_effort: ReasoningTier;
  mode: 'normal' | 'fast';
  recorded_at: string;
  bucket_started_at: string;
  bucket_ended_at: string;
  attempted_trials: number;
  completed_trials: number;
  represented_batch_count: number;
  median_elapsed_ms: number | null;
  p95_elapsed_ms: number | null;
  median_aggregate_output_tps_millis: number | null;
  estimated_credits_nanos: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  median_agent_steps: number | null;
  median_tool_call_count: number | null;
  resolution_seconds: number;
}

function speedConfiguration(
  family: unknown,
  reasoningEffort: unknown,
): { entryId: string; modelFamily: ModelFamily; reasoningTier: ReasoningTier } | null {
  if (typeof family !== 'string' || typeof reasoningEffort !== 'string') return null;
  return SPEED_CONFIGURATION_BY_KEY.get(`${family}:${reasoningEffort}`) ?? null;
}

function speedMeasurementShapeIsValid(value: SpeedObservationRow): boolean {
  const completed = value.completed_trials > 0;
  const timeValues = [value.median_elapsed_ms, value.p95_elapsed_ms];
  const tokenValues = [
    value.input_tokens,
    value.cached_input_tokens,
    value.output_tokens,
    value.total_tokens,
  ];
  return (
    timeValues.every(nullableCount) &&
    (completed ? timeValues.every(isCount) : timeValues.every((item) => item === null)) &&
    nullableCount(value.median_aggregate_output_tps_millis) &&
    nullableCount(value.median_agent_steps) &&
    nullableCount(value.median_tool_call_count) &&
    tokenValues.every(nullableCount) &&
    (value.estimated_credit_sample_count > 0
      ? isCount(value.estimated_credits_nanos)
      : value.estimated_credits_nanos === null)
  );
}

export function isSpeedObservationRow(value: unknown): value is SpeedObservationRow {
  if (!isUnknownRecord(value) || !hasExactKeys(value, SPEED_OBSERVATION_KEYS)) return false;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exact keys are established before every field is validated below.
  const row = value as unknown as SpeedObservationRow;
  const configuration = speedConfiguration(row.model_family, row.reasoning_effort);
  const counts = [row.completed_trials, row.invalid_response_trials, row.failed_trials];
  return (
    /^speed_[0-9a-f]{64}$/.test(row.batch_id) &&
    isTimestamp(row.observed_at) &&
    configuration !== null &&
    (row.mode === 'normal' || row.mode === 'fast') &&
    ['available', 'unsupported', 'unavailable'].includes(row.availability_status) &&
    (row.availability_reason === null || isBoundedText(row.availability_reason)) &&
    (row.availability_status === 'available' || row.availability_reason !== null) &&
    isPositiveCount(row.trials_per_mode) &&
    row.trials_per_mode <= 10 &&
    isCount(row.attempted_trials) &&
    counts.every(isCount) &&
    safeCountSum(counts) === row.attempted_trials &&
    row.completed_trials <= row.attempted_trials &&
    (row.availability_status === 'available'
      ? row.attempted_trials === row.trials_per_mode
      : row.attempted_trials === 0) &&
    speedMeasurementShapeIsValid(row) &&
    row.median_ttft_ms === null &&
    row.ttft_status === 'unavailable' &&
    row.median_post_first_token_output_tps_millis === null &&
    row.post_first_token_output_tps_status === 'unavailable' &&
    (row.catalog_status === 'available' || row.catalog_status === 'unavailable') &&
    (row.codex_version === null || isBoundedText(row.codex_version)) &&
    row.credit_rate_card_version === 'openai-codex-rate-card-2026-08-10' &&
    row.scoring_impact === 'none'
  );
}

export function isSpeedTrendRow(value: unknown): value is SpeedTrendRow {
  if (!isUnknownRecord(value) || !hasExactKeys(value, SPEED_TREND_KEYS)) return false;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exact keys are established before every field is validated below.
  const row = value as unknown as SpeedTrendRow;
  const configuration = speedConfiguration(row.model_family, row.reasoning_effort);
  const nullableMeasurements = [
    row.median_elapsed_ms,
    row.p95_elapsed_ms,
    row.median_aggregate_output_tps_millis,
    row.estimated_credits_nanos,
    row.input_tokens,
    row.cached_input_tokens,
    row.output_tokens,
    row.total_tokens,
    row.median_agent_steps,
    row.median_tool_call_count,
  ];
  return (
    configuration !== null &&
    (row.mode === 'normal' || row.mode === 'fast') &&
    isTimestamp(row.recorded_at) &&
    isTimestamp(row.bucket_started_at) &&
    isTimestamp(row.bucket_ended_at) &&
    Date.parse(row.bucket_started_at) <= Date.parse(row.recorded_at) &&
    Date.parse(row.recorded_at) < Date.parse(row.bucket_ended_at) &&
    isCount(row.attempted_trials) &&
    isCount(row.completed_trials) &&
    row.completed_trials <= row.attempted_trials &&
    isPositiveCount(row.represented_batch_count) &&
    nullableMeasurements.every(nullableCount) &&
    isPositiveCount(row.resolution_seconds)
  );
}

export function mapSpeedObservationRow(row: SpeedObservationRow): PublicSpeedObservation {
  const configuration = speedConfiguration(row.model_family, row.reasoning_effort);
  if (!configuration) throw new Error('Cannot map unknown speed observation configuration');
  return {
    batchId: row.batch_id,
    observedAt: row.observed_at,
    ...configuration,
    mode: row.mode,
    availabilityStatus: row.availability_status,
    availabilityReason: row.availability_reason,
    trialsPerMode: row.trials_per_mode,
    attemptedTrials: row.attempted_trials,
    completedTrials: row.completed_trials,
    invalidResponseTrials: row.invalid_response_trials,
    failedTrials: row.failed_trials,
    medianElapsedMs: row.median_elapsed_ms,
    p95ElapsedMs: row.p95_elapsed_ms,
    medianAggregateOutputTps:
      row.median_aggregate_output_tps_millis === null
        ? null
        : row.median_aggregate_output_tps_millis / 1000,
    estimatedCredits:
      row.estimated_credits_nanos === null ? null : row.estimated_credits_nanos / 1_000_000_000,
    estimatedCreditSampleCount: row.estimated_credit_sample_count,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    medianAgentSteps: row.median_agent_steps,
    medianToolCallCount: row.median_tool_call_count,
    medianTtftMs: null,
    ttftStatus: 'unavailable',
    medianPostFirstTokenOutputTps: null,
    postFirstTokenOutputTpsStatus: 'unavailable',
    catalogStatus: row.catalog_status,
    codexVersion: row.codex_version,
    creditRateCardVersion: row.credit_rate_card_version,
    scoringImpact: 'none',
  };
}

export function mapSpeedTrendRow(row: SpeedTrendRow): SpeedTrendPoint {
  const configuration = speedConfiguration(row.model_family, row.reasoning_effort);
  if (!configuration) throw new Error('Cannot map unknown speed trend configuration');
  return {
    ...configuration,
    mode: row.mode,
    recordedAt: row.recorded_at,
    bucketStartedAt: row.bucket_started_at,
    bucketEndedAt: row.bucket_ended_at,
    attemptedTrials: row.attempted_trials,
    completedTrials: row.completed_trials,
    representedBatchCount: row.represented_batch_count,
    medianElapsedMs: row.median_elapsed_ms,
    p95ElapsedMs: row.p95_elapsed_ms,
    medianAggregateOutputTps:
      row.median_aggregate_output_tps_millis === null
        ? null
        : row.median_aggregate_output_tps_millis / 1000,
    estimatedCredits:
      row.estimated_credits_nanos === null ? null : row.estimated_credits_nanos / 1_000_000_000,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    medianAgentSteps: row.median_agent_steps,
    medianToolCallCount: row.median_tool_call_count,
    resolutionSeconds: row.resolution_seconds,
  };
}
