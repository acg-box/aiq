import { AIQ_CORE_SCORING_VERSION } from '../../aiq-core-contract.ts';
import type {
  CalibrationModelSelection,
  CalibrationOutcome,
  ExecutionStatus,
  PublicCalibrationResult,
  PublicCalibrationRun,
  PublicCalibrationRunSummary,
  PublicCalibrationScore,
  PublicModelEfficiency,
  ReasoningTier,
} from '../types.ts';
import {
  isUnknownRecord,
  isNullableNonnegativeNumber,
  nullableNumberIsAtMost,
  isPricingRate,
  isBoundedText,
  isBoundedIdentifier,
  isFiniteNumber,
  isTimestamp,
  isCount,
  isPositiveCount,
  groupIsComplete,
} from './validation.ts';
import {
  executionStatusForOutcome,
  hasValidResultTaskScore,
  hasValidResultExplanation,
  isResultOutcome,
  isExecutionStatus,
} from '../result-outcomes.ts';

interface CalibrationRunRow {
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

interface CalibrationResultRow {
  result_id: string;
  run_id: string;
  task_id: string;
  task_version: string;
  domain: string;
  model_family: 'sol' | 'terra' | 'luna';
  reasoning_effort: ReasoningTier;
  outcome: CalibrationOutcome;
  execution_status: ExecutionStatus;
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

interface CalibrationScoreRow {
  run_id: string;
  model_family: 'sol' | 'terra' | 'luna';
  reasoning_effort: ReasoningTier;
  descriptive_status: PublicCalibrationScore['descriptiveStatus'];
  quality_score: number | null;
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

export function isCalibrationRunRow(value: unknown): value is CalibrationRunRow {
  if (!isUnknownRecord(value)) return false;
  return (
    isBoundedIdentifier(value.run_id) &&
    value.classification === 'local_calibration_non_official' &&
    value.scoring_version === AIQ_CORE_SCORING_VERSION &&
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

export function isCalibrationResultRow(value: unknown): value is CalibrationResultRow {
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
    isResultOutcome(value.outcome) &&
    isExecutionStatus(value.execution_status) &&
    value.execution_status === executionStatusForOutcome(value.outcome) &&
    hasValidResultExplanation(
      value.outcome,
      value.failure_code,
      value.explanation_code,
      value.explanation_summary,
    ) &&
    hasValidResultTaskScore(value.outcome, value.task_score) &&
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

export function isCalibrationScoreRow(value: unknown): value is CalibrationScoreRow {
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
    (value.quality_score === null ||
      (isFiniteNumber(value.quality_score) &&
        value.quality_score >= 0 &&
        value.quality_score <= 100)) &&
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
        value.quality_score !== null &&
        value.task_resampling_sensitivity_lower <= value.quality_score &&
        value.quality_score <= value.task_resampling_sensitivity_upper &&
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

export function isModelEfficiencyRow(value: unknown): value is ModelEfficiencyRow {
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

export function mapCalibrationRunSummary(row: CalibrationRunRow): PublicCalibrationRunSummary {
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

export function mapCalibrationRun(
  row: CalibrationRunRow,
  results: readonly CalibrationResultRow[],
  selection: CalibrationModelSelection,
): PublicCalibrationRun {
  return {
    ...mapCalibrationRunSummary(row),
    selectedConfiguration: selection,
    results: results.map((result): PublicCalibrationResult => ({
      id: result.result_id,
      runId: result.run_id,
      taskId: result.task_id,
      taskVersion: result.task_version,
      domain: result.domain,
      modelFamily: result.model_family,
      reasoningEffort: result.reasoning_effort,
      outcome: result.outcome,
      executionStatus: result.execution_status,
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
    })),
  };
}

export function mapCalibrationScoreRow(row: CalibrationScoreRow): PublicCalibrationScore {
  return {
    runId: row.run_id,
    modelFamily: row.model_family,
    reasoningEffort: row.reasoning_effort,
    descriptiveStatus: row.descriptive_status,
    qualityScore: row.quality_score,
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

export function mapModelEfficiencyRow(row: ModelEfficiencyRow): PublicModelEfficiency {
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
