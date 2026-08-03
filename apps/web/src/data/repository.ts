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
  CalibrationModelFamily,
  CalibrationModelSelection,
  CalibrationOutcome,
  CalibrationRunPage,
  CalibrationRunPageRequest,
  CapabilityRecordStatus,
  LeaderboardEntry,
  LeaderboardStatus,
  Methodology,
  ModelFamily,
  ObservationRecordStatus,
  ObservationState,
  PublicCalibrationResult,
  PublicCalibrationRun,
  PublicCalibrationRunSummary,
  PublicCalibrationScore,
  PublicModelEfficiency,
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
import { CALIBRATION_OUTCOMES } from './types.ts';

export const PUBLIC_VIEW_NAMES = {
  modelMatrix: 'public_model_matrix',
  leaderboard: 'public_leaderboard',
  runs: 'public_runs',
  runResults: 'public_run_results',
  nodes: 'public_nodes',
  distributedRadar: 'public_distributed_radar',
  scoringVersions: 'public_scoring_versions',
  taskCoverage: 'public_task_coverage',
  calibrationRuns: 'public_calibration_runs',
  calibrationResults: 'public_calibration_results',
  calibrationScores: 'public_calibration_scores',
  modelEfficiency: 'public_model_efficiency',
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

function calibrationFamilyForModelFamily(modelFamily: ModelFamily): CalibrationModelFamily {
  if (modelFamily === 'Sol') return 'sol';
  if (modelFamily === 'Terra') return 'terra';
  return 'luna';
}

export const CALIBRATION_MODEL_CONFIGURATIONS: readonly CalibrationModelSelection[] =
  CANONICAL_MODEL_MATRIX.map(([, modelFamily, , reasoningEffort]) => ({
    modelFamily: calibrationFamilyForModelFamily(modelFamily),
    reasoningEffort,
  }));

export function calibrationConfigurationKey(selection: CalibrationModelSelection): string {
  return `${selection.modelFamily}:${selection.reasoningEffort}`;
}

const CALIBRATION_CONFIGURATION_KEYS = new Set(
  CALIBRATION_MODEL_CONFIGURATIONS.map(calibrationConfigurationKey),
);

const CALIBRATION_CONFIGURATION_INDEX = new Map(
  CALIBRATION_MODEL_CONFIGURATIONS.map((selection, index) => [
    calibrationConfigurationKey(selection),
    index,
  ]),
);

export function parseCalibrationConfiguration(value: unknown): CalibrationModelSelection | null {
  if (typeof value !== 'string') return null;
  return (
    CALIBRATION_MODEL_CONFIGURATIONS.find(
      (selection) => calibrationConfigurationKey(selection) === value,
    ) ?? null
  );
}

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
  latency_evidence_level: 'runner_observed' | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  token_usage_source_level: 'provider_reported' | null;
  token_usage_evidence_level: 'verifier_recomputed' | null;
  standard_api_equivalent_usd_nanos: number | null;
  cost_estimator_status: TaskResult['costEstimatorStatus'];
  cost_evidence_level: 'verifier_recomputed' | null;
}

export interface CalibrationRunRow {
  run_id: string;
  classification: 'local_calibration_non_official';
  scoring_version: string;
  selected_task_count: number;
  selected_model_count: number;
  result_count: number;
  started_at: string;
  completed_at: string;
  verified_at: string;
  published_at: string;
  replay_status: 'evaluator_replayed';
  official: false;
  ranking_eligible: false;
  pricing_currency: 'USD';
  pricing_processing_tier: 'standard';
}

export interface CalibrationResultRow {
  result_id: string;
  run_id: string;
  task_id: string;
  task_version: string;
  domain: string;
  model_family: 'sol' | 'terra' | 'luna';
  reasoning_effort: ReasoningTier;
  outcome: CalibrationOutcome;
  status: RunStatus;
  failure_code: string | null;
  explanation_code: string | null;
  explanation_summary: string | null;
  task_score: number | null;
  latency_ms: number | null;
  latency_evidence_level: 'runner_observed' | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  token_usage_source_level: 'provider_reported' | null;
  token_usage_evidence_level: 'verifier_recomputed' | null;
  standard_api_equivalent_usd_nanos: number | null;
  cost_estimator_status: PublicCalibrationResult['costEstimatorStatus'];
  cost_evidence_level: 'verifier_recomputed' | null;
  cost_estimator_limitations: string[];
  cost_method: string | null;
  cost_version: string | null;
  cost_as_of: string | null;
  cost_source: string | null;
  pricing_currency: 'USD';
  pricing_processing_tier: 'standard';
}

export function calibrationStatusForOutcome(outcome: CalibrationOutcome): RunStatus {
  if (outcome === 'correct' || outcome === 'partial') return 'passed';
  if (outcome === 'invalid' || outcome === 'missing' || outcome === 'not_applicable') {
    return outcome;
  }
  return 'failed';
}

export const CALIBRATION_EXPLANATION_SUMMARIES = {
  incorrect: 'The evaluator rejected the response.',
  timeout: 'The task exceeded its time limit.',
  budget_exhausted: 'The task exceeded a resource budget.',
  tool_failure: 'A permitted execution tool failed.',
  policy_failure: 'The result violated a controlled-output policy.',
  wrong_artifact: 'The expected artifact was not produced.',
  invalid: 'Benchmark infrastructure invalidated this result; an audited rerun is required.',
  missing: 'No task result was available.',
  not_applicable: 'The complete model configuration was unavailable.',
} as const satisfies Partial<Record<CalibrationOutcome, string>>;

function isSafeCalibrationCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[a-z0-9][a-z0-9._:-]*$/.test(value)
  );
}

function isSafeExplanationSummary(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    !value.isWellFormed()
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return false;
  }
  return true;
}

export function calibrationExplanationSummaryForOutcome(
  outcome: CalibrationOutcome,
): string | null {
  if (outcome === 'correct' || outcome === 'partial') return null;
  return CALIBRATION_EXPLANATION_SUMMARIES[outcome];
}

export function calibrationFailureCodeForOutcome(outcome: CalibrationOutcome): string | null {
  if (
    outcome === 'correct' ||
    outcome === 'partial' ||
    outcome === 'incorrect' ||
    outcome === 'missing'
  ) {
    return null;
  }
  if (outcome === 'timeout') return 'timeout';
  if (outcome === 'budget_exhausted') return 'budget_exceeded';
  if (outcome === 'tool_failure') return 'unsupported_model';
  if (outcome === 'policy_failure') return 'output_truncated';
  if (outcome === 'wrong_artifact') return 'missing_response';
  if (outcome === 'invalid') return 'evaluator_failure';
  return 'capability_unavailable';
}

function hasValidCalibrationFailureCode(
  outcome: CalibrationOutcome,
  failureCode: unknown,
): boolean {
  if (calibrationFailureCodeForOutcome(outcome) === null) return failureCode === null;
  if (!isSafeCalibrationCode(failureCode)) return false;
  if (outcome === 'tool_failure') {
    return failureCode === 'unsupported_model' || failureCode === 'non_zero_exit';
  }
  if (outcome === 'invalid') {
    return [
      'evaluator_failure',
      'workspace_unavailable',
      'missing_evaluator',
      'spawn',
      'authentication',
      'subscription_limit',
      'capability_validation_failed',
      'workspace_integrity',
    ].includes(failureCode);
  }
  return failureCode === calibrationFailureCodeForOutcome(outcome);
}

function hasValidCalibrationTaskScore(outcome: CalibrationOutcome, taskScore: unknown): boolean {
  if (outcome === 'correct') return taskScore === 1;
  if (outcome === 'partial') {
    return isFiniteNumber(taskScore) && taskScore > 0 && taskScore < 1;
  }
  if (outcome === 'invalid' || outcome === 'missing' || outcome === 'not_applicable') {
    return taskScore === null;
  }
  return taskScore === 0;
}

function hasValidCalibrationExplanation(
  outcome: CalibrationOutcome,
  failureCode: unknown,
  explanationCode: unknown,
  explanationSummary: unknown,
): boolean {
  const expectedSummary = calibrationExplanationSummaryForOutcome(outcome);
  if (expectedSummary === null) {
    return failureCode === null && explanationCode === null && explanationSummary === null;
  }
  return (
    hasValidCalibrationFailureCode(outcome, failureCode) &&
    explanationCode === failureCode &&
    isSafeExplanationSummary(explanationSummary) &&
    explanationSummary === expectedSummary
  );
}

function isCalibrationOutcome(value: unknown): value is CalibrationOutcome {
  return CALIBRATION_OUTCOMES.some((outcome) => outcome === value);
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === 'passed' ||
    value === 'failed' ||
    value === 'invalid' ||
    value === 'missing' ||
    value === 'not_applicable'
  );
}

export interface CalibrationScoreRow {
  run_id: string;
  model_family: 'sol' | 'terra' | 'luna';
  reasoning_effort: ReasoningTier;
  descriptive_status: PublicCalibrationScore['descriptiveStatus'];
  aiq: number | null;
  task_resampling_sensitivity_lower: number | null;
  task_resampling_sensitivity_upper: number | null;
  task_resampling_sensitivity_method: string | null;
  result_count: number;
  sample_size: number;
  coverage_percent: number;
  observed_total_wall_ms: number | null;
  observed_median_wall_ms: number | null;
  observed_p95_wall_ms: number | null;
  observed_time_sample_count: number;
  observed_time_coverage_percent: number;
  duration_evidence_level: 'runner_observed' | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  token_usage_sample_count: number;
  token_usage_source_level: 'provider_reported' | null;
  token_usage_evidence_level: 'verifier_recomputed' | null;
  standard_api_equivalent_usd_nanos: number | null;
  estimated_cost_sample_count: number;
  cost_estimator_status: PublicCalibrationScore['costEstimatorStatus'];
  cost_evidence_level: 'verifier_recomputed' | null;
  cost_estimator_limitations: string[];
  token_usage_coverage_percent: number | null;
  pricing_source: string | null;
  pricing_as_of: string | null;
  pricing_version: string | null;
  pricing_currency: 'USD';
  pricing_processing_tier: 'standard';
  attempted_result_count: number;
  invoked_result_count: number;
  adapter_elapsed_observed_result_count: number;
  token_observed_result_count: number;
  priced_result_count: number;
}

interface ModelEfficiencyRow {
  run_id: string;
  matrix_batch_id: string;
  model_family: 'sol' | 'terra' | 'luna';
  reasoning_effort: ReasoningTier;
  matrix_batch_elapsed_ms: number;
  summed_cell_adapter_elapsed_ms: number | null;
  observed_median_wall_ms: number | null;
  observed_p95_wall_ms: number | null;
  observed_time_sample_count: number;
  observed_time_coverage_percent: number;
  duration_evidence_level: 'runner_observed' | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  token_usage_sample_count: number;
  token_usage_source_level: 'provider_reported' | null;
  standard_api_equivalent_usd_nanos: number | null;
  cost_estimator_status: PublicModelEfficiency['costEstimatorStatus'];
  token_usage_coverage_percent: number | null;
  input_token_coverage_count: number | null;
  input_token_coverage_percent: number | null;
  cached_input_token_coverage_count: number | null;
  cached_input_token_coverage_percent: number | null;
  cache_write_input_token_coverage_count: number | null;
  cache_write_input_token_coverage_percent: number | null;
  output_token_coverage_count: number | null;
  output_token_coverage_percent: number | null;
  reasoning_token_coverage_count: number | null;
  reasoning_token_coverage_percent: number | null;
  total_token_coverage_count: number | null;
  total_token_coverage_percent: number | null;
  token_usage_evidence_level: 'verifier_recomputed' | null;
  cost_evidence_level: 'verifier_recomputed' | null;
  cost_method: string | null;
  pricing_source: string | null;
  pricing_as_of: string | null;
  pricing_version: string | null;
  pricing_currency: 'USD' | null;
  pricing_processing_tier: 'standard' | null;
  result_count: number;
  attempted_result_count: number;
  invoked_result_count: number;
  adapter_elapsed_observed_result_count: number;
  token_observed_result_count: number;
  priced_result_count: number;
  execution_concurrency: number;
  estimated_cost_sample_count: number;
  cost_estimator_limitations: string[];
  pricing_rates: PublicModelEfficiency['pricingRates'];
  cost_formula: string | null;
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
          latencyEvidenceLevel: result.latency_evidence_level,
          inputTokens: result.input_tokens,
          cachedInputTokens: result.cached_input_tokens,
          cacheWriteInputTokens: result.cache_write_input_tokens,
          outputTokens: result.output_tokens,
          reasoningOutputTokens: result.reasoning_output_tokens,
          totalTokens: result.total_tokens,
          tokenUsageSourceLevel: result.token_usage_source_level,
          tokenUsageEvidenceLevel: result.token_usage_evidence_level,
          standardApiEquivalentUsdNanos: result.standard_api_equivalent_usd_nanos,
          costEstimatorStatus: result.cost_estimator_status,
          costEvidenceLevel: result.cost_evidence_level,
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

function isCalibrationRunRow(value: unknown): value is CalibrationRunRow {
  if (!isUnknownRecord(value)) return false;
  return (
    isBoundedIdentifier(value.run_id) &&
    value.classification === 'local_calibration_non_official' &&
    isBoundedIdentifier(value.scoring_version) &&
    isPositiveCount(value.selected_task_count) &&
    value.selected_task_count <= 72 &&
    isPositiveCount(value.selected_model_count) &&
    value.selected_model_count <= 17 &&
    isPositiveCount(value.result_count) &&
    value.result_count === value.selected_task_count * value.selected_model_count &&
    isTimestamp(value.started_at) &&
    isTimestamp(value.completed_at) &&
    Date.parse(value.started_at) <= Date.parse(value.completed_at) &&
    isTimestamp(value.verified_at) &&
    isTimestamp(value.published_at) &&
    Date.parse(value.completed_at) <= Date.parse(value.verified_at) &&
    Date.parse(value.verified_at) <= Date.parse(value.published_at) &&
    value.replay_status === 'evaluator_replayed' &&
    value.official === false &&
    value.ranking_eligible === false &&
    value.pricing_currency === 'USD' &&
    value.pricing_processing_tier === 'standard'
  );
}

function isCalibrationResultRow(value: unknown): value is CalibrationResultRow {
  if (!isUnknownRecord(value)) return false;
  return (
    isBoundedIdentifier(value.result_id) &&
    isBoundedIdentifier(value.run_id) &&
    isBoundedIdentifier(value.task_id) &&
    isBoundedIdentifier(value.task_version) &&
    isBoundedIdentifier(value.domain) &&
    (value.model_family === 'sol' ||
      value.model_family === 'terra' ||
      value.model_family === 'luna') &&
    typeof value.reasoning_effort === 'string' &&
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoning_effort) &&
    isCalibrationOutcome(value.outcome) &&
    isRunStatus(value.status) &&
    value.status === calibrationStatusForOutcome(value.outcome) &&
    hasValidCalibrationExplanation(
      value.outcome,
      value.failure_code,
      value.explanation_code,
      value.explanation_summary,
    ) &&
    hasValidCalibrationTaskScore(value.outcome, value.task_score) &&
    isNullableNonnegativeNumber(value.latency_ms) &&
    ((value.latency_ms === null && value.latency_evidence_level === null) ||
      (value.latency_ms !== null && value.latency_evidence_level === 'runner_observed')) &&
    [
      value.input_tokens,
      value.cached_input_tokens,
      value.cache_write_input_tokens,
      value.output_tokens,
      value.reasoning_output_tokens,
      value.total_tokens,
    ].every(isNullableNonnegativeNumber) &&
    (value.token_usage_source_level === null ||
      value.token_usage_source_level === 'provider_reported') &&
    (value.token_usage_evidence_level === null ||
      value.token_usage_evidence_level === 'verifier_recomputed') &&
    (([
      value.input_tokens,
      value.cached_input_tokens,
      value.cache_write_input_tokens,
      value.output_tokens,
      value.reasoning_output_tokens,
      value.total_tokens,
    ].every((entry) => entry === null) &&
      value.token_usage_source_level === null &&
      value.token_usage_evidence_level === null) ||
      ([
        value.input_tokens,
        value.cached_input_tokens,
        value.cache_write_input_tokens,
        value.output_tokens,
        value.reasoning_output_tokens,
        value.total_tokens,
      ].some((entry) => entry !== null) &&
        value.token_usage_source_level === 'provider_reported' &&
        value.token_usage_evidence_level === 'verifier_recomputed')) &&
    (value.standard_api_equivalent_usd_nanos === null ||
      isCount(value.standard_api_equivalent_usd_nanos)) &&
    [
      'estimated',
      'unavailable_missing_usage',
      'unavailable_invalid_usage',
      'unavailable_context_band',
    ].includes(String(value.cost_estimator_status)) &&
    (value.cost_evidence_level === null || value.cost_evidence_level === 'verifier_recomputed') &&
    Array.isArray(value.cost_estimator_limitations) &&
    value.cost_estimator_limitations.every(isBoundedText) &&
    (value.cost_method === null || isBoundedText(value.cost_method)) &&
    (value.cost_version === null || isBoundedIdentifier(value.cost_version)) &&
    (value.cost_as_of === null ||
      (typeof value.cost_as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.cost_as_of))) &&
    (value.cost_source === null || isBoundedText(value.cost_source)) &&
    value.pricing_currency === 'USD' &&
    value.pricing_processing_tier === 'standard' &&
    groupIsComplete([value.cost_method, value.cost_version, value.cost_as_of, value.cost_source]) &&
    nullableNumberIsAtMost(value.cached_input_tokens, value.input_tokens) &&
    nullableNumberIsAtMost(value.reasoning_output_tokens, value.output_tokens) &&
    ((value.cost_estimator_status === 'estimated' &&
      value.standard_api_equivalent_usd_nanos !== null &&
      value.cost_evidence_level === 'verifier_recomputed') ||
      (value.cost_estimator_status !== 'estimated' &&
        value.standard_api_equivalent_usd_nanos === null &&
        value.cost_evidence_level === null)) &&
    (value.cost_estimator_status === 'unavailable_context_band') ===
      isUnavailableContextBandUsage(
        value.input_tokens,
        value.cached_input_tokens,
        value.cache_write_input_tokens,
        value.output_tokens,
      )
  );
}

function isUnavailableContextBandUsage(
  inputTokens: unknown,
  cachedInputTokens: unknown,
  cacheWriteInputTokens: unknown,
  outputTokens: unknown,
): boolean {
  return (
    isFiniteNumber(inputTokens) &&
    isFiniteNumber(cachedInputTokens) &&
    isFiniteNumber(cacheWriteInputTokens) &&
    isFiniteNumber(outputTokens) &&
    inputTokens > 272_000
  );
}

function isNullableNonnegativeNumber(value: unknown): value is number | null {
  return value === null || (isFiniteNumber(value) && value >= 0);
}

function nullableNumberIsAtMost(left: unknown, right: unknown): boolean {
  return (
    left === null ||
    right === null ||
    (isFiniteNumber(left) && isFiniteNumber(right) && left <= right)
  );
}

function isCalibrationScoreRow(value: unknown): value is CalibrationScoreRow {
  if (!isUnknownRecord(value)) return false;
  return (
    isBoundedIdentifier(value.run_id) &&
    (value.model_family === 'sol' ||
      value.model_family === 'terra' ||
      value.model_family === 'luna') &&
    typeof value.reasoning_effort === 'string' &&
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoning_effort) &&
    typeof value.descriptive_status === 'string' &&
    ['complete_fixture', 'conditional_observed', 'coverage_only', 'not_applicable'].includes(
      value.descriptive_status,
    ) &&
    (value.aiq === null || (isFiniteNumber(value.aiq) && value.aiq >= 0 && value.aiq <= 100)) &&
    isNullableNonnegativeNumber(value.task_resampling_sensitivity_lower) &&
    isNullableNonnegativeNumber(value.task_resampling_sensitivity_upper) &&
    (value.task_resampling_sensitivity_method === null ||
      isBoundedText(value.task_resampling_sensitivity_method)) &&
    groupIsComplete([
      value.task_resampling_sensitivity_lower,
      value.task_resampling_sensitivity_upper,
      value.task_resampling_sensitivity_method,
    ]) &&
    (value.task_resampling_sensitivity_lower === null ||
      (value.task_resampling_sensitivity_upper !== null &&
        value.aiq !== null &&
        value.task_resampling_sensitivity_lower <= value.aiq &&
        value.aiq <= value.task_resampling_sensitivity_upper &&
        value.task_resampling_sensitivity_upper <= 100)) &&
    isCount(value.sample_size) &&
    isCount(value.result_count) &&
    value.sample_size <= value.result_count &&
    isFiniteNumber(value.coverage_percent) &&
    value.coverage_percent >= 0 &&
    value.coverage_percent <= 100 &&
    isNullableNonnegativeNumber(value.observed_total_wall_ms) &&
    isNullableNonnegativeNumber(value.observed_median_wall_ms) &&
    isNullableNonnegativeNumber(value.observed_p95_wall_ms) &&
    isCount(value.observed_time_sample_count) &&
    isFiniteNumber(value.observed_time_coverage_percent) &&
    value.observed_time_coverage_percent >= 0 &&
    value.observed_time_coverage_percent <= 100 &&
    ((value.observed_time_sample_count === 0 &&
      value.observed_total_wall_ms === null &&
      value.observed_median_wall_ms === null &&
      value.observed_p95_wall_ms === null &&
      value.duration_evidence_level === null) ||
      (value.observed_time_sample_count > 0 &&
        value.observed_total_wall_ms !== null &&
        value.observed_median_wall_ms !== null &&
        value.observed_p95_wall_ms !== null &&
        value.duration_evidence_level === 'runner_observed')) &&
    [
      value.input_tokens,
      value.cached_input_tokens,
      value.cache_write_input_tokens,
      value.output_tokens,
      value.reasoning_output_tokens,
      value.total_tokens,
    ].every(isNullableNonnegativeNumber) &&
    isCount(value.token_usage_sample_count) &&
    (value.token_usage_source_level === null ||
      value.token_usage_source_level === 'provider_reported') &&
    (value.token_usage_evidence_level === null ||
      value.token_usage_evidence_level === 'verifier_recomputed') &&
    ((value.token_usage_sample_count === 0 &&
      [
        value.input_tokens,
        value.cached_input_tokens,
        value.cache_write_input_tokens,
        value.output_tokens,
        value.reasoning_output_tokens,
        value.total_tokens,
      ].every((entry) => entry === null) &&
      value.token_usage_source_level === null &&
      value.token_usage_evidence_level === null) ||
      (value.token_usage_sample_count > 0 &&
        [
          value.input_tokens,
          value.cached_input_tokens,
          value.cache_write_input_tokens,
          value.output_tokens,
          value.reasoning_output_tokens,
          value.total_tokens,
        ].some((entry) => entry !== null) &&
        value.token_usage_source_level === 'provider_reported' &&
        value.token_usage_evidence_level === 'verifier_recomputed')) &&
    nullableNumberIsAtMost(value.cached_input_tokens, value.input_tokens) &&
    nullableNumberIsAtMost(value.reasoning_output_tokens, value.output_tokens) &&
    (value.standard_api_equivalent_usd_nanos === null ||
      isCount(value.standard_api_equivalent_usd_nanos)) &&
    isCount(value.estimated_cost_sample_count) &&
    typeof value.cost_estimator_status === 'string' &&
    [
      'estimated',
      'unavailable_missing_usage',
      'unavailable_invalid_usage',
      'unavailable_context_band',
    ].includes(value.cost_estimator_status) &&
    (value.cost_evidence_level === null || value.cost_evidence_level === 'verifier_recomputed') &&
    Array.isArray(value.cost_estimator_limitations) &&
    value.cost_estimator_limitations.every(isBoundedText) &&
    ((value.cost_estimator_status === 'estimated' &&
      value.standard_api_equivalent_usd_nanos !== null) ||
      (value.cost_estimator_status !== 'estimated' &&
        value.standard_api_equivalent_usd_nanos === null)) &&
    ((value.cost_estimator_status === 'estimated' &&
      value.cost_evidence_level === 'verifier_recomputed' &&
      value.estimated_cost_sample_count === value.result_count) ||
      (value.cost_estimator_status !== 'estimated' && value.cost_evidence_level === null)) &&
    (value.token_usage_coverage_percent === null ||
      (isFiniteNumber(value.token_usage_coverage_percent) &&
        value.token_usage_coverage_percent >= 0 &&
        value.token_usage_coverage_percent <= 100)) &&
    (value.pricing_source === null || isBoundedText(value.pricing_source)) &&
    (value.pricing_as_of === null ||
      (typeof value.pricing_as_of === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value.pricing_as_of))) &&
    (value.pricing_version === null || isBoundedIdentifier(value.pricing_version)) &&
    value.pricing_currency === 'USD' &&
    value.pricing_processing_tier === 'standard' &&
    isCount(value.attempted_result_count) &&
    isCount(value.invoked_result_count) &&
    isCount(value.adapter_elapsed_observed_result_count) &&
    isCount(value.token_observed_result_count) &&
    isCount(value.priced_result_count) &&
    value.attempted_result_count <= value.result_count &&
    value.invoked_result_count <= value.attempted_result_count &&
    value.adapter_elapsed_observed_result_count <= value.invoked_result_count &&
    value.adapter_elapsed_observed_result_count === value.observed_time_sample_count &&
    value.token_observed_result_count === value.token_usage_sample_count &&
    value.priced_result_count === value.estimated_cost_sample_count &&
    groupIsComplete([value.pricing_source, value.pricing_as_of, value.pricing_version])
  );
}

function isModelEfficiencyRow(value: unknown): value is ModelEfficiencyRow {
  if (!isUnknownRecord(value)) return false;
  const resultCount = value.result_count;
  const categoryCoverage = [
    [value.input_token_coverage_count, value.input_token_coverage_percent],
    [value.cached_input_token_coverage_count, value.cached_input_token_coverage_percent],
    [value.cache_write_input_token_coverage_count, value.cache_write_input_token_coverage_percent],
    [value.output_token_coverage_count, value.output_token_coverage_percent],
    [value.reasoning_token_coverage_count, value.reasoning_token_coverage_percent],
    [value.total_token_coverage_count, value.total_token_coverage_percent],
  ];
  return (
    isBoundedIdentifier(value.run_id) &&
    isBoundedIdentifier(value.matrix_batch_id) &&
    (value.model_family === 'sol' ||
      value.model_family === 'terra' ||
      value.model_family === 'luna') &&
    typeof value.reasoning_effort === 'string' &&
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoning_effort) &&
    isPositiveCount(resultCount) &&
    isCount(value.matrix_batch_elapsed_ms) &&
    isNullableNonnegativeNumber(value.summed_cell_adapter_elapsed_ms) &&
    isNullableNonnegativeNumber(value.observed_median_wall_ms) &&
    isNullableNonnegativeNumber(value.observed_p95_wall_ms) &&
    isCount(value.observed_time_sample_count) &&
    value.observed_time_sample_count <= resultCount &&
    isFiniteNumber(value.observed_time_coverage_percent) &&
    value.observed_time_coverage_percent ===
      Number(((100 * value.observed_time_sample_count) / resultCount).toFixed(4)) &&
    ((value.observed_time_sample_count === 0 &&
      value.summed_cell_adapter_elapsed_ms === null &&
      value.observed_median_wall_ms === null &&
      value.observed_p95_wall_ms === null &&
      value.duration_evidence_level === null) ||
      (value.observed_time_sample_count > 0 &&
        value.summed_cell_adapter_elapsed_ms !== null &&
        value.observed_median_wall_ms !== null &&
        value.observed_p95_wall_ms !== null &&
        value.duration_evidence_level === 'runner_observed')) &&
    [
      value.input_tokens,
      value.cached_input_tokens,
      value.cache_write_input_tokens,
      value.output_tokens,
      value.reasoning_output_tokens,
      value.total_tokens,
    ].every(isNullableNonnegativeNumber) &&
    isCount(value.token_usage_sample_count) &&
    value.token_usage_sample_count <= resultCount &&
    (value.token_usage_source_level === null ||
      value.token_usage_source_level === 'provider_reported') &&
    (value.standard_api_equivalent_usd_nanos === null ||
      isCount(value.standard_api_equivalent_usd_nanos)) &&
    (value.cost_estimator_status === 'estimated' ||
      value.cost_estimator_status === 'unavailable_missing_usage' ||
      value.cost_estimator_status === 'unavailable_invalid_usage' ||
      value.cost_estimator_status === 'unavailable_context_band') &&
    ((value.cost_estimator_status === 'estimated' &&
      value.standard_api_equivalent_usd_nanos !== null) ||
      (value.cost_estimator_status !== 'estimated' &&
        value.standard_api_equivalent_usd_nanos === null)) &&
    ((value.token_usage_sample_count === 0 && value.token_usage_coverage_percent === null) ||
      (value.token_usage_sample_count > 0 &&
        isFiniteNumber(value.token_usage_coverage_percent) &&
        value.token_usage_coverage_percent ===
          Number(((100 * value.token_usage_sample_count) / resultCount).toFixed(4)))) &&
    categoryCoverage.every(
      ([count, percent]) =>
        (count === null && percent === null) ||
        (isPositiveCount(count) &&
          isFiniteNumber(percent) &&
          percent > 0 &&
          percent <= 100 &&
          percent === Number(((100 * count) / resultCount).toFixed(4))),
    ) &&
    (value.token_usage_evidence_level === null ||
      value.token_usage_evidence_level === 'verifier_recomputed') &&
    (value.cost_evidence_level === null || value.cost_evidence_level === 'verifier_recomputed') &&
    (value.cost_method === null || isBoundedText(value.cost_method)) &&
    (value.pricing_source === null || isBoundedText(value.pricing_source)) &&
    (value.pricing_as_of === null ||
      (typeof value.pricing_as_of === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value.pricing_as_of))) &&
    (value.pricing_version === null || isBoundedIdentifier(value.pricing_version)) &&
    (value.pricing_currency === null || value.pricing_currency === 'USD') &&
    (value.pricing_processing_tier === null || value.pricing_processing_tier === 'standard') &&
    isCount(value.attempted_result_count) &&
    isCount(value.invoked_result_count) &&
    isCount(value.adapter_elapsed_observed_result_count) &&
    isCount(value.token_observed_result_count) &&
    isCount(value.priced_result_count) &&
    isPositiveCount(value.execution_concurrency) &&
    isCount(value.estimated_cost_sample_count) &&
    value.attempted_result_count <= resultCount &&
    value.invoked_result_count <= value.attempted_result_count &&
    value.adapter_elapsed_observed_result_count <= value.invoked_result_count &&
    value.adapter_elapsed_observed_result_count === value.observed_time_sample_count &&
    value.token_observed_result_count === value.token_usage_sample_count &&
    value.priced_result_count === value.estimated_cost_sample_count &&
    value.priced_result_count <= resultCount &&
    Array.isArray(value.cost_estimator_limitations) &&
    value.cost_estimator_limitations.every(isBoundedText) &&
    Array.isArray(value.pricing_rates) &&
    value.pricing_rates.every(isPricingRate) &&
    (value.cost_formula === null || isBoundedText(value.cost_formula)) &&
    groupIsComplete([
      value.cost_method,
      value.pricing_source,
      value.pricing_as_of,
      value.pricing_version,
      value.pricing_currency,
      value.pricing_processing_tier,
      value.cost_formula,
    ]) &&
    ((value.token_usage_sample_count === 0 &&
      [
        value.input_tokens,
        value.cached_input_tokens,
        value.cache_write_input_tokens,
        value.output_tokens,
        value.reasoning_output_tokens,
        value.total_tokens,
      ].every((entry) => entry === null) &&
      value.token_usage_source_level === null &&
      value.token_usage_evidence_level === null) ||
      (value.token_usage_sample_count > 0 &&
        [
          value.input_tokens,
          value.cached_input_tokens,
          value.cache_write_input_tokens,
          value.output_tokens,
          value.reasoning_output_tokens,
          value.total_tokens,
        ].some((entry) => entry !== null) &&
        value.token_usage_source_level === 'provider_reported' &&
        value.token_usage_evidence_level === 'verifier_recomputed')) &&
    nullableNumberIsAtMost(value.cached_input_tokens, value.input_tokens) &&
    nullableNumberIsAtMost(value.reasoning_output_tokens, value.output_tokens) &&
    ((value.cost_estimator_status === 'estimated' &&
      value.standard_api_equivalent_usd_nanos !== null &&
      value.cost_evidence_level === 'verifier_recomputed' &&
      value.token_usage_coverage_percent === 100 &&
      value.priced_result_count === resultCount) ||
      (value.cost_estimator_status !== 'estimated' &&
        value.standard_api_equivalent_usd_nanos === null &&
        value.cost_evidence_level === null))
  );
}

function isPricingRate(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    isBoundedIdentifier(value.model) &&
    isCount(value.input_usd_nanos_per_token) &&
    isCount(value.cached_input_usd_nanos_per_token) &&
    isCount(value.cache_write_input_usd_nanos_per_token) &&
    isCount(value.output_usd_nanos_per_token)
  );
}

function mapCalibrationRunSummary(row: CalibrationRunRow): PublicCalibrationRunSummary {
  return {
    id: row.run_id,
    classification: row.classification,
    scoringVersion: row.scoring_version,
    selectedTaskCount: row.selected_task_count,
    selectedModelCount: row.selected_model_count,
    resultCount: row.result_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    verifiedAt: row.verified_at,
    publishedAt: row.published_at,
    replayStatus: row.replay_status,
    official: false,
    rankingEligible: false,
    pricingCurrency: row.pricing_currency,
    pricingProcessingTier: row.pricing_processing_tier,
    synthetic: false,
  };
}

function mapCalibrationRun(
  row: CalibrationRunRow,
  results: readonly CalibrationResultRow[],
  selection: CalibrationModelSelection,
): PublicCalibrationRun {
  return {
    ...mapCalibrationRunSummary(row),
    selectedConfiguration: selection,
    results: results.map(
      (result): PublicCalibrationResult => ({
        id: result.result_id,
        runId: result.run_id,
        taskId: result.task_id,
        taskVersion: result.task_version,
        domain: result.domain,
        modelFamily: result.model_family,
        reasoningEffort: result.reasoning_effort,
        outcome: result.outcome,
        status: result.status,
        failureCode: result.failure_code,
        explanationCode: result.explanation_code,
        explanationSummary: result.explanation_summary,
        taskScore: result.task_score,
        latencyMs: result.latency_ms,
        latencyEvidenceLevel: result.latency_evidence_level,
        inputTokens: result.input_tokens,
        cachedInputTokens: result.cached_input_tokens,
        cacheWriteInputTokens: result.cache_write_input_tokens,
        outputTokens: result.output_tokens,
        reasoningOutputTokens: result.reasoning_output_tokens,
        totalTokens: result.total_tokens,
        tokenUsageSourceLevel: result.token_usage_source_level,
        tokenUsageEvidenceLevel: result.token_usage_evidence_level,
        standardApiEquivalentUsdNanos: result.standard_api_equivalent_usd_nanos,
        costEstimatorStatus: result.cost_estimator_status,
        costEvidenceLevel: result.cost_evidence_level,
        costEstimatorLimitations: result.cost_estimator_limitations,
        costMethod: result.cost_method,
        costVersion: result.cost_version,
        costAsOf: result.cost_as_of,
        costSource: result.cost_source,
        pricingCurrency: result.pricing_currency,
        pricingProcessingTier: result.pricing_processing_tier,
      }),
    ),
  };
}

function mapCalibrationScoreRow(row: CalibrationScoreRow): PublicCalibrationScore {
  return {
    runId: row.run_id,
    modelFamily: row.model_family,
    reasoningEffort: row.reasoning_effort,
    descriptiveStatus: row.descriptive_status,
    aiq: row.aiq,
    taskResamplingSensitivityLower: row.task_resampling_sensitivity_lower,
    taskResamplingSensitivityUpper: row.task_resampling_sensitivity_upper,
    taskResamplingSensitivityMethod: row.task_resampling_sensitivity_method,
    sampleSize: row.sample_size,
    resultCount: row.result_count,
    coveragePercent: row.coverage_percent,
    observedTotalWallMs: row.observed_total_wall_ms,
    observedMedianWallMs: row.observed_median_wall_ms,
    observedP95WallMs: row.observed_p95_wall_ms,
    observedTimeSampleCount: row.observed_time_sample_count,
    observedTimeCoveragePercent: row.observed_time_coverage_percent,
    durationEvidenceLevel: row.duration_evidence_level,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteInputTokens: row.cache_write_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    tokenUsageSampleCount: row.token_usage_sample_count,
    tokenUsageSourceLevel: row.token_usage_source_level,
    tokenUsageEvidenceLevel: row.token_usage_evidence_level,
    standardApiEquivalentUsdNanos: row.standard_api_equivalent_usd_nanos,
    estimatedCostSampleCount: row.estimated_cost_sample_count,
    costEstimatorStatus: row.cost_estimator_status,
    costEvidenceLevel: row.cost_evidence_level,
    costEstimatorLimitations: row.cost_estimator_limitations,
    tokenUsageCoveragePercent: row.token_usage_coverage_percent,
    pricingSource: row.pricing_source,
    pricingAsOf: row.pricing_as_of,
    pricingVersion: row.pricing_version,
    pricingCurrency: row.pricing_currency,
    pricingProcessingTier: row.pricing_processing_tier,
    attemptedResultCount: row.attempted_result_count,
    invokedResultCount: row.invoked_result_count,
    adapterElapsedObservedResultCount: row.adapter_elapsed_observed_result_count,
    tokenObservedResultCount: row.token_observed_result_count,
    pricedResultCount: row.priced_result_count,
    synthetic: false,
  };
}

function mapModelEfficiencyRow(row: ModelEfficiencyRow): PublicModelEfficiency {
  return {
    runId: row.run_id,
    matrixBatchId: row.matrix_batch_id,
    modelFamily: row.model_family,
    reasoningEffort: row.reasoning_effort,
    matrixBatchElapsedMs: row.matrix_batch_elapsed_ms,
    summedCellAdapterElapsedMs: row.summed_cell_adapter_elapsed_ms,
    observedMedianWallMs: row.observed_median_wall_ms,
    observedP95WallMs: row.observed_p95_wall_ms,
    observedTimeSampleCount: row.observed_time_sample_count,
    observedTimeCoveragePercent: row.observed_time_coverage_percent,
    durationEvidenceLevel: row.duration_evidence_level,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteInputTokens: row.cache_write_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    tokenUsageSampleCount: row.token_usage_sample_count,
    tokenUsageSourceLevel: row.token_usage_source_level,
    standardApiEquivalentUsdNanos: row.standard_api_equivalent_usd_nanos,
    costEstimatorStatus: row.cost_estimator_status,
    tokenUsageCoveragePercent: row.token_usage_coverage_percent,
    tokenCoverage: {
      input: { count: row.input_token_coverage_count, percent: row.input_token_coverage_percent },
      cachedInput: {
        count: row.cached_input_token_coverage_count,
        percent: row.cached_input_token_coverage_percent,
      },
      cacheWriteInput: {
        count: row.cache_write_input_token_coverage_count,
        percent: row.cache_write_input_token_coverage_percent,
      },
      output: {
        count: row.output_token_coverage_count,
        percent: row.output_token_coverage_percent,
      },
      reasoning: {
        count: row.reasoning_token_coverage_count,
        percent: row.reasoning_token_coverage_percent,
      },
      total: { count: row.total_token_coverage_count, percent: row.total_token_coverage_percent },
    },
    tokenUsageEvidenceLevel: row.token_usage_evidence_level,
    costEvidenceLevel: row.cost_evidence_level,
    costMethod: row.cost_method,
    pricingSource: row.pricing_source,
    pricingAsOf: row.pricing_as_of,
    pricingVersion: row.pricing_version,
    pricingCurrency: row.pricing_currency,
    pricingProcessingTier: row.pricing_processing_tier,
    resultCount: row.result_count,
    attemptedResultCount: row.attempted_result_count,
    invokedResultCount: row.invoked_result_count,
    adapterElapsedObservedResultCount: row.adapter_elapsed_observed_result_count,
    tokenObservedResultCount: row.token_observed_result_count,
    pricedResultCount: row.priced_result_count,
    executionConcurrency: row.execution_concurrency,
    estimatedCostSampleCount: row.estimated_cost_sample_count,
    costEstimatorLimitations: row.cost_estimator_limitations,
    pricingRates: row.pricing_rates,
    costFormula: row.cost_formula,
  };
}

const seedCalibrationRun: PublicCalibrationRun = {
  id: `run_${'c'.repeat(64)}`,
  classification: 'local_calibration_non_official',
  scoringVersion: '1.0.2',
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
      taskVersion: '1.0.2',
      domain: 'coding',
      modelFamily: 'sol',
      reasoningEffort: 'low',
      outcome: 'correct',
      status: 'passed',
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
    aiq: null,
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
    value.synthetic === false;
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
export const CALIBRATION_RUN_PAGE_SIZE = 20;
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
              'run_id,id,task,domain,status,score,explanation_code,explanation_summary,retryable,tools,latency_ms,latency_evidence_level,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,token_usage_source_level,token_usage_evidence_level,standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level',
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
        'result_id,run_id,task_id,task_version,domain,model_family,reasoning_effort,outcome,status,failure_code,explanation_code,explanation_summary,task_score,latency_ms,latency_evidence_level,input_tokens,cached_input_tokens,output_tokens,cache_write_input_tokens,reasoning_output_tokens,total_tokens,token_usage_source_level,token_usage_evidence_level,standard_api_equivalent_usd_nanos,cost_estimator_status,cost_evidence_level,cost_estimator_limitations,cost_method,cost_version,cost_as_of,cost_source,pricing_currency,pricing_processing_tier',
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
        'run_id,model_family,reasoning_effort,descriptive_status,aiq,task_resampling_sensitivity_lower,task_resampling_sensitivity_upper,task_resampling_sensitivity_method,result_count,sample_size,coverage_percent,observed_total_wall_ms,observed_median_wall_ms,observed_p95_wall_ms,observed_time_sample_count,observed_time_coverage_percent,duration_evidence_level,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,token_usage_sample_count,token_usage_source_level,token_usage_evidence_level,standard_api_equivalent_usd_nanos,estimated_cost_sample_count,token_usage_coverage_percent,cost_estimator_status,cost_evidence_level,cost_estimator_limitations,pricing_source,pricing_as_of,pricing_version,pricing_currency,pricing_processing_tier,attempted_result_count,invoked_result_count,adapter_elapsed_observed_result_count,token_observed_result_count,priced_result_count',
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
      const identity = `${row.run_id}\0${row.model_family}\0${row.reasoning_effort}`;
      if (identities.has(identity)) {
        throw new Error(
          `Cannot read ${PUBLIC_VIEW_NAMES.modelEfficiency}: duplicate efficiency identity`,
        );
      }
      identities.add(identity);
    }
    return data.map(mapModelEfficiencyRow);
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
