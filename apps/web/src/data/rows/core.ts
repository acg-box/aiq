import { AIQ_CORE_BENCHMARK_VERSION, AIQ_CORE_SCORING_VERSION } from '../../aiq-core-contract.ts';
import type {
  BenchmarkRun,
  BenchmarkRunSummary,
  CalibrationStatus,
  CalibrationOutcome,
  LeaderboardEntry,
  LeaderboardStatus,
  ModelFamily,
  ExecutionStatus,
  ReliabilityStatus,
  TaskResult,
} from '../types.ts';
import { PUBLIC_VIEW_NAMES } from '../public-views.ts';
import {
  type ModelMatrixRow,
  CANONICAL_MODEL_MATRIX,
  CANONICAL_MODEL_MATRIX_IDS,
  CANONICAL_MODEL_MATRIX_BY_ID,
} from '../model-matrix.ts';
import {
  isUnknownRecord,
  hasExactKeys,
  nullableNumberIsAtMost,
  SHA256,
  isBoundedText,
  isBoundedIdentifier,
  isFiniteNumber,
  isTimestamp,
  isCount,
  isPositiveCount,
  safeCountSum,
} from './validation.ts';
import {
  executionStatusForOutcome,
  isSafeResultCode,
  hasValidResultTaskScore,
  hasValidResultExplanation,
  isResultOutcome,
  isExecutionStatus,
} from '../result-outcomes.ts';

export const RUN_SUMMARY_SELECT =
  'id,matrix_id,started_at,completed_at,benchmark_version,scoring_version,prompt_set_digest,runner_commit,region,synthetic,corpus_release_id,corpus_commitment_sha256,catalog_digest,task_set_digest,preflight_digest,runtime_digest,run_class,permission_evidence_digest,result_count,correct_count,partial_count,incorrect_count,runtime_issue_count,invalid_count,missing_count,not_applicable_count,completed_count,observed_count,coverage_percent,covered_domain_count,provisional_domain_count';

export interface LeaderboardRow {
  matrix_id: string;
  run_id: string | null;
  score: number | null;
  theta: number | null;
  standard_error: number | null;
  theta_ci_low: number | null;
  theta_ci_high: number | null;
  score_ci_low: number | null;
  score_ci_high: number | null;
  information: number | null;
  quality_score: number | null;
  strict_pass_rate: number | null;
  strict_pass_low: number | null;
  strict_pass_high: number | null;
  strict_pass_sample_size: number | null;
  strict_pass_successes: number | null;
  reliability_status: ReliabilityStatus | null;
  calibration_status: CalibrationStatus;
  sensitivity_low: number | null;
  sensitivity_high: number | null;
  sample_size: number | null;
  coverage_percent: number | null;
  runtime_issues: number | null;
  missing: number | null;
  scoring_version: string | null;
  score_status: string | null;
  synthetic: boolean | null;
}

export interface TrendRow {
  matrix_id: string;
  run_id: string;
  scoring_version: string;
  recorded_at: string;
  bucket_started_at: string;
  bucket_ended_at: string;
  score: number;
  theta: number | null;
  standard_error: number | null;
  theta_ci_low: number | null;
  theta_ci_high: number | null;
  score_ci_low: number | null;
  score_ci_high: number | null;
  information: number | null;
  quality_score: number | null;
  strict_pass_rate: number | null;
  strict_pass_low: number | null;
  strict_pass_high: number | null;
  strict_pass_sample_size: number | null;
  strict_pass_successes: number | null;
  reliability_status: ReliabilityStatus | null;
  calibration_status: CalibrationStatus;
  sensitivity_low: number;
  sensitivity_high: number;
  sample_size: number;
  represented_run_count: number;
  resolution_seconds: number;
  synthetic: boolean;
}

export function isTrendRow(value: unknown): value is TrendRow {
  if (!isUnknownRecord(value)) return false;
  const recordedAt = value.recorded_at;
  const bucketStartedAt = value.bucket_started_at;
  const bucketEndedAt = value.bucket_ended_at;
  const score = value.score;
  const theta = value.theta;
  const standardError = value.standard_error;
  const thetaCiLow = value.theta_ci_low;
  const thetaCiHigh = value.theta_ci_high;
  const scoreCiLow = value.score_ci_low;
  const scoreCiHigh = value.score_ci_high;
  const information = value.information;
  const qualityScore = value.quality_score;
  const strictPassRate = value.strict_pass_rate;
  const strictPassLow = value.strict_pass_low;
  const strictPassHigh = value.strict_pass_high;
  const strictPassSampleSize = value.strict_pass_sample_size;
  const strictPassSuccesses = value.strict_pass_successes;
  const sensitivityLow = value.sensitivity_low;
  const sensitivityHigh = value.sensitivity_high;
  const sampleSize = value.sample_size;
  const representedRunCount = value.represented_run_count;
  const resolutionSeconds = value.resolution_seconds;
  return (
    typeof value.matrix_id === 'string' &&
    CANONICAL_MODEL_MATRIX_BY_ID.has(value.matrix_id) &&
    typeof value.run_id === 'string' &&
    RUN_ID.test(value.run_id) &&
    typeof value.scoring_version === 'string' &&
    value.scoring_version === AIQ_CORE_SCORING_VERSION &&
    isTimestamp(recordedAt) &&
    isTimestamp(bucketStartedAt) &&
    isTimestamp(bucketEndedAt) &&
    Date.parse(bucketStartedAt) <= Date.parse(recordedAt) &&
    Date.parse(recordedAt) < Date.parse(bucketEndedAt) &&
    isFiniteNumber(score) &&
    score >= 0 &&
    score <= 100 &&
    isFiniteNumber(theta) &&
    isFiniteNumber(standardError) &&
    standardError > 0 &&
    isFiniteNumber(thetaCiLow) &&
    isFiniteNumber(thetaCiHigh) &&
    thetaCiLow <= thetaCiHigh &&
    isFiniteNumber(scoreCiLow) &&
    isFiniteNumber(scoreCiHigh) &&
    scoreCiLow >= 0 &&
    scoreCiLow <= score &&
    score <= scoreCiHigh &&
    scoreCiHigh <= 100 &&
    isFiniteNumber(information) &&
    information >= 0 &&
    information <= 72 &&
    isFiniteNumber(qualityScore) &&
    qualityScore >= 0 &&
    qualityScore <= 100 &&
    isFiniteNumber(strictPassRate) &&
    strictPassRate >= 0 &&
    strictPassRate <= 1 &&
    isFiniteNumber(strictPassLow) &&
    isFiniteNumber(strictPassHigh) &&
    strictPassLow >= 0 &&
    strictPassLow <= strictPassRate &&
    strictPassRate <= strictPassHigh &&
    strictPassHigh <= 1 &&
    isPositiveCount(strictPassSampleSize) &&
    strictPassSampleSize <= 72 &&
    isCount(strictPassSuccesses) &&
    strictPassSuccesses <= strictPassSampleSize &&
    Math.abs(strictPassRate - strictPassSuccesses / strictPassSampleSize) <= 0.000001 &&
    value.reliability_status === 'single_matrix_information_only' &&
    value.calibration_status === 'calibrated' &&
    isFiniteNumber(sensitivityLow) &&
    isFiniteNumber(sensitivityHigh) &&
    sensitivityLow >= 0 &&
    sensitivityLow <= qualityScore &&
    qualityScore <= sensitivityHigh &&
    sensitivityHigh <= 100 &&
    sampleSize === 72 &&
    isPositiveCount(representedRunCount) &&
    isCount(resolutionSeconds) &&
    value.synthetic === false
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
  correct_count: number;
  partial_count: number;
  incorrect_count: number;
  runtime_issue_count: number;
  invalid_count: number;
  missing_count: number;
  not_applicable_count: number;
  completed_count: number;
  observed_count: number;
  coverage_percent: number | null;
  covered_domain_count: number;
  provisional_domain_count: number;
}

const RUN_ROW_KEYS = new Set([
  'id',
  'matrix_id',
  'started_at',
  'completed_at',
  'benchmark_version',
  'scoring_version',
  'prompt_set_digest',
  'runner_commit',
  'region',
  'synthetic',
  'corpus_release_id',
  'corpus_commitment_sha256',
  'catalog_digest',
  'task_set_digest',
  'preflight_digest',
  'runtime_digest',
  'run_class',
  'permission_evidence_digest',
  'result_count',
  'correct_count',
  'partial_count',
  'incorrect_count',
  'runtime_issue_count',
  'invalid_count',
  'missing_count',
  'not_applicable_count',
  'completed_count',
  'observed_count',
  'coverage_percent',
  'covered_domain_count',
  'provisional_domain_count',
]);

export const RUN_ID = /^run_[0-9a-f]{64}$/;

const RESULT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RUNNER_COMMIT = /^[0-9a-f]{7,40}$/;

const CORPUS_RELEASE_ID = /^corpus_[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

const BENCHMARK_DOMAINS = new Set([
  'coding',
  'debugging',
  'repository_understanding',
  'data_processing',
  'retrieval_verification',
  'documentation_communication',
  'planning_execution',
  'tool_use',
  'instruction_following',
  'reliability_recovery',
]);

export const BENCHMARK_DOMAIN_TASK_COUNTS = new Map<string, number>([
  ['coding', 8],
  ['debugging', 8],
  ['repository_understanding', 7],
  ['data_processing', 8],
  ['retrieval_verification', 7],
  ['documentation_communication', 7],
  ['planning_execution', 7],
  ['tool_use', 7],
  ['instruction_following', 6],
  ['reliability_recovery', 7],
]);

const CORE_TASK_ID = /^(?<prefix>[a-z][a-z0-9-]{0,62})-(?<ordinal>[0-9]{2})$/;

const LEADERBOARD_STATUSES = new Set([
  'official',
  'synthetic_complete',
  'provisional',
  'coverage_only',
  'not_applicable',
  'missing',
  'failed',
  'infra_failure',
]);

const CALIBRATION_STATUSES = new Set(['calibrated', 'pending', 'failed', 'not_applicable']);

const RELIABILITY_STATUSES = new Set(['single_matrix_information_only', 'not_estimated']);

function isLeaderboardStatus(value: unknown): value is LeaderboardStatus {
  return typeof value === 'string' && LEADERBOARD_STATUSES.has(value);
}

function taskIdMatchesDomain(taskId: unknown, domain: unknown): taskId is string {
  if (typeof taskId !== 'string' || typeof domain !== 'string') return false;
  const expectedCount = BENCHMARK_DOMAIN_TASK_COUNTS.get(domain);
  const match = CORE_TASK_ID.exec(taskId);
  if (!expectedCount || !match?.groups) return false;
  const ordinal = Number(match.groups.ordinal);
  return (
    match.groups.prefix === domain.replaceAll('_', '-') &&
    Number.isInteger(ordinal) &&
    ordinal >= 1 &&
    ordinal <= expectedCount
  );
}

export function isRunSummaryRowForBenchmark(
  value: unknown,
  benchmarkVersion: string,
): value is RunRow {
  if (!isUnknownRecord(value)) return false;
  const counts = [
    value.correct_count,
    value.partial_count,
    value.incorrect_count,
    value.runtime_issue_count,
    value.invalid_count,
    value.missing_count,
    value.not_applicable_count,
  ];
  const resultCount = value.result_count;
  const completedCount = safeCountSum([
    value.correct_count,
    value.partial_count,
    value.incorrect_count,
  ]);
  const observedCount = completedCount;
  const expectedCoverage =
    isPositiveCount(resultCount) && observedCount !== null
      ? Number(((100 * observedCount) / resultCount).toFixed(1))
      : null;
  const provenance = [
    value.corpus_release_id,
    value.corpus_commitment_sha256,
    value.catalog_digest,
    value.task_set_digest,
    value.preflight_digest,
    value.runtime_digest,
    value.run_class,
    value.permission_evidence_digest,
  ];
  const provenanceIsAbsent = provenance.every((item) => item === null);
  const provenanceIsComplete =
    typeof value.corpus_release_id === 'string' &&
    CORPUS_RELEASE_ID.test(value.corpus_release_id) &&
    [
      value.corpus_commitment_sha256,
      value.catalog_digest,
      value.task_set_digest,
      value.preflight_digest,
      value.runtime_digest,
      value.permission_evidence_digest,
    ].every((item) => typeof item === 'string' && SHA256.test(item)) &&
    value.run_class === 'official';
  return (
    hasExactKeys(value, RUN_ROW_KEYS) &&
    typeof value.id === 'string' &&
    RUN_ID.test(value.id) &&
    typeof value.matrix_id === 'string' &&
    CANONICAL_MODEL_MATRIX_BY_ID.has(value.matrix_id) &&
    isTimestamp(value.started_at) &&
    isTimestamp(value.completed_at) &&
    Date.parse(value.started_at) <= Date.parse(value.completed_at) &&
    typeof value.benchmark_version === 'string' &&
    value.benchmark_version === benchmarkVersion &&
    typeof value.scoring_version === 'string' &&
    value.scoring_version === AIQ_CORE_SCORING_VERSION &&
    typeof value.prompt_set_digest === 'string' &&
    SHA256.test(value.prompt_set_digest) &&
    typeof value.runner_commit === 'string' &&
    RUNNER_COMMIT.test(value.runner_commit) &&
    isBoundedIdentifier(value.region) &&
    value.region.length <= 64 &&
    typeof value.synthetic === 'boolean' &&
    (provenanceIsAbsent || provenanceIsComplete) &&
    isCount(resultCount) &&
    resultCount <= 72 &&
    counts.every(isCount) &&
    safeCountSum(counts) === resultCount &&
    isCount(value.completed_count) &&
    value.completed_count === completedCount &&
    isCount(value.observed_count) &&
    value.observed_count === observedCount &&
    value.coverage_percent === expectedCoverage &&
    isCount(value.covered_domain_count) &&
    value.covered_domain_count <= 10 &&
    value.covered_domain_count <= value.observed_count &&
    isCount(value.provisional_domain_count) &&
    value.provisional_domain_count <= value.covered_domain_count &&
    value.provisional_domain_count * 4 <= value.observed_count &&
    (value.observed_count === 0 ? value.covered_domain_count === 0 : value.covered_domain_count > 0)
  );
}

export function isRunSummaryRow(value: unknown): value is RunRow {
  return isRunSummaryRowForBenchmark(value, AIQ_CORE_BENCHMARK_VERSION);
}

export function runRowsFollowQueryOrder(rows: readonly RunRow[], ascending: boolean): boolean {
  return rows.every((row, index) => {
    if (index === 0) return true;
    const previous = rows[index - 1];
    if (!previous) return false;
    const previousTime = Date.parse(previous.started_at);
    const currentTime = Date.parse(row.started_at);
    if (previousTime !== currentTime) {
      return ascending ? previousTime < currentTime : previousTime > currentTime;
    }
    const identityOrder = previous.id.localeCompare(row.id);
    return ascending ? identityOrder > 0 : identityOrder < 0;
  });
}

export interface RunResultRow {
  run_id: string;
  id: string;
  task_id: string;
  task: string;
  domain: string;
  outcome: CalibrationOutcome;
  execution_status: ExecutionStatus;
  score: number | null;
  explanation_code: string | null;
  explanation_summary: string | null;
  retryable: boolean | null;
  tools: string[];
  agent_steps: number;
  tool_call_count: number;
  tool_calls_by_type: Record<string, number>;
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
  pricing_digest: string;
}

const RUN_RESULT_ROW_KEYS = new Set([
  'run_id',
  'id',
  'task_id',
  'task',
  'domain',
  'outcome',
  'execution_status',
  'score',
  'explanation_code',
  'explanation_summary',
  'retryable',
  'tools',
  'agent_steps',
  'tool_call_count',
  'tool_calls_by_type',
  'latency_ms',
  'latency_evidence_level',
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
  'token_usage_source_level',
  'token_usage_evidence_level',
  'standard_api_equivalent_usd_nanos',
  'cost_estimator_status',
  'cost_evidence_level',
  'pricing_digest',
]);

const COST_RATES_BY_PRICING_DIGEST = new Map<
  string,
  Readonly<
    Record<
      ModelFamily,
      { input: number; cachedInput: number; cacheWriteInput: number; output: number }
    >
  >
>([
  [
    'sha256:e1a28656f2918a14e86997b06bf9e29ec4db084ff89ee0319aafa0c05cc1f31d',
    {
      Sol: { input: 5_000, cachedInput: 500, cacheWriteInput: 6_250, output: 30_000 },
      Terra: { input: 2_000, cachedInput: 200, cacheWriteInput: 2_500, output: 12_000 },
      Luna: { input: 200, cachedInput: 20, cacheWriteInput: 250, output: 1_200 },
    },
  ],
]);

export function isRunResultRow(
  value: unknown,
  matrixIdByRun: ReadonlyMap<string, string>,
): value is RunResultRow {
  if (!isUnknownRecord(value) || !hasExactKeys(value, RUN_RESULT_ROW_KEYS)) return false;
  const tokenValues = [
    value.input_tokens,
    value.cached_input_tokens,
    value.cache_write_input_tokens,
    value.output_tokens,
    value.reasoning_output_tokens,
    value.total_tokens,
  ];
  const hasTokenUsage = tokenValues.some((item) => item !== null);
  const hasCoreCostUsage = [
    value.input_tokens,
    value.cached_input_tokens,
    value.cache_write_input_tokens,
    value.output_tokens,
  ].every((item) => item !== null);
  const inputTokens = value.input_tokens;
  const cachedInputTokens = value.cached_input_tokens;
  const cacheWriteInputTokens = value.cache_write_input_tokens;
  const contextBand = hasCoreCostUsage && typeof inputTokens === 'number' && inputTokens > 272_000;
  const invalidUsage =
    hasCoreCostUsage &&
    typeof inputTokens === 'number' &&
    typeof cachedInputTokens === 'number' &&
    typeof cacheWriteInputTokens === 'number' &&
    cachedInputTokens + cacheWriteInputTokens > inputTokens;
  const runMatrixId =
    typeof value.run_id === 'string' ? matrixIdByRun.get(value.run_id) : undefined;
  const modelFamily = runMatrixId
    ? CANONICAL_MODEL_MATRIX_BY_ID.get(runMatrixId)?.modelFamily
    : undefined;
  const pricingRates =
    typeof value.pricing_digest === 'string'
      ? COST_RATES_BY_PRICING_DIGEST.get(value.pricing_digest)
      : undefined;
  const rates = modelFamily && pricingRates ? pricingRates[modelFamily] : undefined;
  const calculatedCost =
    hasCoreCostUsage &&
    !contextBand &&
    !invalidUsage &&
    rates &&
    typeof inputTokens === 'number' &&
    typeof cachedInputTokens === 'number' &&
    typeof cacheWriteInputTokens === 'number' &&
    typeof value.output_tokens === 'number'
      ? (inputTokens - cachedInputTokens - cacheWriteInputTokens) * rates.input +
        cachedInputTokens * rates.cachedInput +
        cacheWriteInputTokens * rates.cacheWriteInput +
        value.output_tokens * rates.output
      : null;
  const costOverflow = calculatedCost !== null && !Number.isSafeInteger(calculatedCost);
  const expectedCostStatus = !hasCoreCostUsage
    ? 'unavailable_missing_usage'
    : contextBand
      ? 'unavailable_context_band'
      : invalidUsage || costOverflow
        ? 'unavailable_invalid_usage'
        : 'estimated';
  const tools = value.tools;
  const toolCallsByType = value.tool_calls_by_type;
  const outcome = value.outcome;
  const explanationCode = value.explanation_code;
  return (
    typeof value.run_id === 'string' &&
    RUN_ID.test(value.run_id) &&
    typeof value.id === 'string' &&
    RESULT_UUID.test(value.id) &&
    taskIdMatchesDomain(value.task_id, value.domain) &&
    isBoundedText(value.task) &&
    typeof value.domain === 'string' &&
    BENCHMARK_DOMAINS.has(value.domain) &&
    isResultOutcome(outcome) &&
    isExecutionStatus(value.execution_status) &&
    value.execution_status === executionStatusForOutcome(outcome) &&
    hasValidResultTaskScore(outcome, value.score) &&
    hasValidResultExplanation(
      outcome,
      explanationCode,
      explanationCode,
      value.explanation_summary,
    ) &&
    (explanationCode === null ? value.retryable === null : typeof value.retryable === 'boolean') &&
    Array.isArray(tools) &&
    tools.every(isSafeResultCode) &&
    new Set(tools).size === tools.length &&
    tools.every((tool, index) => index === 0 || String(tools[index - 1]).localeCompare(tool) < 0) &&
    isCount(value.agent_steps) &&
    isCount(value.tool_call_count) &&
    isUnknownRecord(toolCallsByType) &&
    Object.keys(toolCallsByType).length <= 4 &&
    Object.entries(toolCallsByType).every(
      ([tool, count]) => isSafeResultCode(tool) && isCount(count),
    ) &&
    Object.values(toolCallsByType).reduce<number>((sum, count) => sum + Number(count), 0) ===
      value.tool_call_count &&
    tools.length === Object.keys(toolCallsByType).length &&
    tools.every((tool) => Object.hasOwn(toolCallsByType, tool)) &&
    ((value.latency_ms === null && value.latency_evidence_level === null) ||
      (isCount(value.latency_ms) && value.latency_evidence_level === 'runner_observed')) &&
    tokenValues.every((item) => item === null || isCount(item)) &&
    nullableNumberIsAtMost(value.cached_input_tokens, value.input_tokens) &&
    nullableNumberIsAtMost(value.reasoning_output_tokens, value.output_tokens) &&
    (!hasCoreCostUsage ||
      invalidUsage ||
      (typeof cachedInputTokens === 'number' &&
        typeof cacheWriteInputTokens === 'number' &&
        typeof inputTokens === 'number' &&
        cachedInputTokens + cacheWriteInputTokens <= inputTokens)) &&
    (hasTokenUsage
      ? value.token_usage_source_level === 'provider_reported' &&
        value.token_usage_evidence_level === 'verifier_recomputed'
      : value.token_usage_source_level === null && value.token_usage_evidence_level === null) &&
    typeof value.pricing_digest === 'string' &&
    pricingRates !== undefined &&
    value.cost_estimator_status === expectedCostStatus &&
    ((expectedCostStatus === 'estimated' &&
      isCount(value.standard_api_equivalent_usd_nanos) &&
      value.standard_api_equivalent_usd_nanos === calculatedCost &&
      value.cost_evidence_level === 'verifier_recomputed') ||
      (expectedCostStatus !== 'estimated' &&
        value.standard_api_equivalent_usd_nanos === null &&
        value.cost_evidence_level === null))
  );
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
      .map((result): TaskResult => ({
        id: result.task_id,
        task: result.task,
        domain: result.domain,
        outcome: result.outcome,
        executionStatus: result.execution_status,
        score: result.score,
        explanation: result.explanation_summary
          ? {
              code: result.explanation_code,
              summary: result.explanation_summary,
              retryable: result.retryable,
            }
          : null,
        tools: result.tools,
        agentSteps: result.agent_steps,
        toolCallCount: result.tool_call_count,
        toolCallsByType: result.tool_calls_by_type,
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
      })),
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
      correctCount: row.correct_count,
      partialCount: row.partial_count,
      incorrectCount: row.incorrect_count,
      runtimeIssueCount: row.runtime_issue_count,
      invalidCount: row.invalid_count,
      missingCount: row.missing_count,
      notApplicableCount: row.not_applicable_count,
      completedCount: row.completed_count,
    },
  };
}

export interface ScoringVersionRow {
  benchmark_version: string;
  scoring_version: string;
  published_at: string;
  principles: string[];
  missing_policy: string;
  failure_policy: string;
  sensitivity_policy: string;
  synthetic: boolean;
}

export interface TaskCoverageRow {
  scoring_version: string;
  domain: string;
  weight: number;
  task_count: number;
}

function normalizeLeaderboardStatus(row: LeaderboardRow | undefined): LeaderboardStatus {
  if (!row) {
    return 'unpublished';
  }
  if (isLeaderboardStatus(row.score_status)) {
    return row.score_status;
  }
  return 'missing';
}

export function orderCanonicalModelMatrix(matrix: readonly unknown[]): readonly ModelMatrixRow[] {
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
    typeof value.matrix_id === 'string' &&
    CANONICAL_MODEL_MATRIX_BY_ID.has(value.matrix_id) &&
    typeof value.run_id === 'string' &&
    RUN_ID.test(value.run_id) &&
    typeof value.scoring_version === 'string' &&
    value.scoring_version === AIQ_CORE_SCORING_VERSION &&
    value.synthetic === false;
  if (!baseShape) return false;
  if (!isLeaderboardStatus(value.score_status)) {
    return false;
  }
  if (
    typeof value.calibration_status !== 'string' ||
    !CALIBRATION_STATUSES.has(value.calibration_status)
  ) {
    return false;
  }
  if (
    value.reliability_status !== null &&
    (typeof value.reliability_status !== 'string' ||
      !RELIABILITY_STATUSES.has(value.reliability_status))
  ) {
    return false;
  }
  if (value.score_status === 'official') {
    return (
      isFiniteNumber(value.score) &&
      value.score >= 0 &&
      value.score <= 100 &&
      isFiniteNumber(value.theta) &&
      isFiniteNumber(value.standard_error) &&
      value.standard_error > 0 &&
      isFiniteNumber(value.theta_ci_low) &&
      isFiniteNumber(value.theta_ci_high) &&
      value.theta_ci_low <= value.theta_ci_high &&
      isFiniteNumber(value.score_ci_low) &&
      isFiniteNumber(value.score_ci_high) &&
      value.score_ci_low >= 0 &&
      value.score_ci_low <= value.score &&
      value.score <= value.score_ci_high &&
      value.score_ci_high <= 100 &&
      isFiniteNumber(value.information) &&
      value.information >= 0 &&
      value.information <= 72 &&
      isFiniteNumber(value.quality_score) &&
      value.quality_score >= 0 &&
      value.quality_score <= 100 &&
      isFiniteNumber(value.strict_pass_rate) &&
      value.strict_pass_rate >= 0 &&
      value.strict_pass_rate <= 1 &&
      isFiniteNumber(value.strict_pass_low) &&
      isFiniteNumber(value.strict_pass_high) &&
      value.strict_pass_low >= 0 &&
      value.strict_pass_low <= value.strict_pass_rate &&
      value.strict_pass_rate <= value.strict_pass_high &&
      value.strict_pass_high <= 1 &&
      isPositiveCount(value.strict_pass_sample_size) &&
      value.strict_pass_sample_size <= 72 &&
      isCount(value.strict_pass_successes) &&
      value.strict_pass_successes <= value.strict_pass_sample_size &&
      Math.abs(
        value.strict_pass_rate - value.strict_pass_successes / value.strict_pass_sample_size,
      ) <= 0.000001 &&
      value.reliability_status === 'single_matrix_information_only' &&
      value.calibration_status === 'calibrated' &&
      isFiniteNumber(value.sensitivity_low) &&
      isFiniteNumber(value.sensitivity_high) &&
      value.sensitivity_low >= 0 &&
      value.sensitivity_low <= value.quality_score &&
      value.quality_score <= value.sensitivity_high &&
      value.sensitivity_high <= 100 &&
      value.sample_size === 72 &&
      value.coverage_percent === 100 &&
      isCount(value.runtime_issues) &&
      value.runtime_issues <= 72 &&
      value.missing === 0
    );
  }
  return (
    value.score === null &&
    value.theta === null &&
    value.standard_error === null &&
    value.theta_ci_low === null &&
    value.theta_ci_high === null &&
    value.score_ci_low === null &&
    value.score_ci_high === null &&
    value.information === null &&
    value.quality_score === null &&
    value.strict_pass_rate === null &&
    value.strict_pass_low === null &&
    value.strict_pass_high === null &&
    value.strict_pass_sample_size === null &&
    value.strict_pass_successes === null &&
    value.reliability_status === null &&
    value.calibration_status !== 'calibrated' &&
    value.sensitivity_low === null &&
    value.sensitivity_high === null &&
    value.sample_size === null &&
    value.coverage_percent === null &&
    value.runtime_issues === null &&
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
      theta: officialRow?.theta ?? null,
      standardError: officialRow?.standard_error ?? null,
      thetaCiLow: officialRow?.theta_ci_low ?? null,
      thetaCiHigh: officialRow?.theta_ci_high ?? null,
      scoreCiLow: officialRow?.score_ci_low ?? null,
      scoreCiHigh: officialRow?.score_ci_high ?? null,
      information: officialRow?.information ?? null,
      qualityScore: officialRow?.quality_score ?? null,
      strictPassRate: officialRow?.strict_pass_rate ?? null,
      strictPassLow: officialRow?.strict_pass_low ?? null,
      strictPassHigh: officialRow?.strict_pass_high ?? null,
      strictPassSampleSize: officialRow?.strict_pass_sample_size ?? null,
      strictPassSuccesses: officialRow?.strict_pass_successes ?? null,
      reliabilityStatus: officialRow?.reliability_status ?? null,
      calibrationStatus: row?.calibration_status ?? 'pending',
      sensitivityLow: officialRow?.sensitivity_low ?? null,
      sensitivityHigh: officialRow?.sensitivity_high ?? null,
      sampleSize: officialRow?.sample_size ?? null,
      coveragePercent: officialRow?.coverage_percent ?? null,
      runtimeIssues: officialRow?.runtime_issues ?? null,
      missing: officialRow?.missing ?? null,
      scoringVersion: officialRow?.scoring_version ?? null,
      scoreStatus,
      runId: officialRow?.run_id ?? null,
      synthetic: officialRow?.synthetic ?? null,
    };
  });
}
