import { createServer } from 'node:http';

import activeCatalog from '../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json' with { type: 'json' };
import generatedPublicFixture from '../../../benchmarks/fixtures/aiq-2.0-test-generated-public.json' with { type: 'json' };
import {
  AIQ_CORE_BENCHMARK_VERSION,
  AIQ_CORE_SCORING_VERSION,
  AIQ_CORE_TASK_SCORER_VERSION,
  AIQ_CORE_TASK_SET_VERSION,
} from '../src/aiq-core-contract.ts';
import { REQUIRED_RPC_CONTRACT } from '../src/server/readiness.ts';

if (
  generatedPublicFixture.schema_version !== 'aiq.test-generated-public-fixture.v1' ||
  generatedPublicFixture.fixture_provenance !== 'test_generated' ||
  !generatedPublicFixture.test_generated ||
  generatedPublicFixture.production_publishable ||
  generatedPublicFixture.official_eligible ||
  generatedPublicFixture.ranking_eligible ||
  !generatedPublicFixture.synthetic ||
  generatedPublicFixture.benchmark_version !== AIQ_CORE_BENCHMARK_VERSION ||
  generatedPublicFixture.scoring_version !== AIQ_CORE_SCORING_VERSION ||
  generatedPublicFixture.measurement_version !== '2.0.0' ||
  generatedPublicFixture.task_count !== 72 ||
  generatedPublicFixture.configuration_count !== 17 ||
  generatedPublicFixture.cell_count !== 1_224 ||
  !generatedPublicFixture.calibration_gate.passed ||
  generatedPublicFixture.calibration_gate.violations.length !== 0 ||
  generatedPublicFixture.leaderboard.length !== 17 ||
  generatedPublicFixture.trend.length !== 17 ||
  generatedPublicFixture.task_cells.length !== 1_224
) {
  throw new Error('The scorer-owned browser fixture is not isolated and complete.');
}

if (
  `${activeCatalog.task_set_id}@${activeCatalog.task_set_version}` !== AIQ_CORE_BENCHMARK_VERSION ||
  activeCatalog.task_set_version !== AIQ_CORE_TASK_SET_VERSION ||
  activeCatalog.scoring_version !== AIQ_CORE_TASK_SCORER_VERSION ||
  activeCatalog.tasks.length !== generatedPublicFixture.task_count
) {
  throw new Error('The scorer-owned browser fixture does not match the active public catalog.');
}

const port = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Supply one valid mock Supabase port.');
}
const emptyCalibrationEvidence = process.env.AIQ_MOCK_EMPTY_CALIBRATION_EVIDENCE === '1';

/** @type {ReadonlyArray<readonly [string, number]>} */
const domainCounts = [
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
];

const matrix = [
  {
    family: 'Sol',
    model: 'gpt-5.6-sol',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    family: 'Terra',
    model: 'gpt-5.6-terra',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    family: 'Luna',
    model: 'gpt-5.6-luna',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
].flatMap(({ family, model, tiers }) =>
  tiers.map((tier) => ({
    id: `${family.toLowerCase()}-${tier}`,
    model_family: family,
    model_name: model,
    reasoning_tier: tier,
  })),
);

const speedBatchId = `speed_${'c'.repeat(64)}`;
const speedObservedAt = '2026-08-10T15:00:00.000Z';
const speedObservationRows = matrix.flatMap((entry, index) => {
  const normalElapsed = 18_000 + index * 650;
  const normalCredits =
    entry.model_family === 'Sol'
      ? 7_900_000_000
      : entry.model_family === 'Terra'
        ? 3_200_000_000
        : 320_000_000;
  return ['normal', 'fast'].map((mode) => {
    const fast = mode === 'fast';
    const elapsed = fast ? Math.round(normalElapsed * (0.62 + (index % 4) * 0.04)) : normalElapsed;
    return {
      batch_id: speedBatchId,
      observed_at: speedObservedAt,
      model_family: entry.model_family.toLowerCase(),
      reasoning_effort: entry.reasoning_tier,
      mode,
      availability_status: 'available',
      availability_reason: 'live_catalog_advertised',
      trials_per_mode: 5,
      attempted_trials: 5,
      completed_trials: index === 15 && fast ? 4 : 5,
      invalid_response_trials: index === 15 && fast ? 1 : 0,
      failed_trials: 0,
      median_elapsed_ms: elapsed,
      p95_elapsed_ms: Math.round(elapsed * 1.13),
      median_aggregate_output_tps_millis: Math.round((803 * 1_000_000) / elapsed),
      estimated_credits_nanos: fast ? Math.round(normalCredits * 2.5) : normalCredits,
      estimated_credit_sample_count: 5,
      input_tokens: 39_200 + index * 10,
      cached_input_tokens: 0,
      output_tokens: 4_015,
      total_tokens: 43_215 + index * 10,
      median_agent_steps: 1,
      median_tool_call_count: 0,
      median_ttft_ms: null,
      ttft_status: 'unavailable',
      median_post_first_token_output_tps_millis: null,
      post_first_token_output_tps_status: 'unavailable',
      catalog_status: 'available',
      codex_version: 'codex-cli 0.147.0-alpha.6.5',
      credit_rate_card_version: 'openai-codex-rate-card-2026-08-10',
      scoring_impact: 'none',
    };
  });
});

const speedTrendDates = [
  '2026-08-06T15:00:00.000Z',
  '2026-08-07T15:00:00.000Z',
  '2026-08-08T15:00:00.000Z',
  '2026-08-09T15:00:00.000Z',
  speedObservedAt,
];
const speedTrendRows = speedTrendDates.flatMap((recordedAt, dateIndex) =>
  speedObservationRows.map((row, rowIndex) => ({
    model_family: row.model_family,
    reasoning_effort: row.reasoning_effort,
    mode: row.mode,
    recorded_at: recordedAt,
    bucket_started_at: recordedAt,
    bucket_ended_at: new Date(new Date(recordedAt).getTime() + 12 * 60 * 60 * 1_000).toISOString(),
    attempted_trials: 5,
    completed_trials: row.completed_trials,
    represented_batch_count: 1,
    median_elapsed_ms: Math.round(
      row.median_elapsed_ms * (1 + (dateIndex - 2) * 0.018 + (rowIndex % 3) * 0.004),
    ),
    p95_elapsed_ms: Math.round(row.p95_elapsed_ms * (1 + (dateIndex - 2) * 0.018)),
    median_aggregate_output_tps_millis: row.median_aggregate_output_tps_millis,
    estimated_credits_nanos: row.estimated_credits_nanos,
    input_tokens: row.input_tokens,
    cached_input_tokens: row.cached_input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    median_agent_steps: 1,
    median_tool_call_count: 0,
    resolution_seconds: 43_200,
  })),
);

const provenanceHash = `sha256:${'1'.repeat(64)}`;
const currentRunStartedAt = '2025-12-31T23:00:00.000Z';
const currentRunCompletedAt = '2025-12-31T23:59:59.000Z';

/**
 * Build public result-row shape from the active catalog only.
 *
 * The formal scorer-generated task cells below replace every value in these
 * templates. The templates provide transport fields only and contain no
 * historical scores or hand-authored latent values.
 */
function generatedResultTemplates() {
  return activeCatalog.tasks.map((task, taskIndex) => ({
    id: `00000000-0000-4000-8000-${String(taskIndex + 1).padStart(12, '0')}`,
    task_id: task.task_id,
    task: task.title,
    domain: task.domain,
    outcome: 'incorrect',
    execution_status: 'completed',
    score: 0,
    explanation_code: null,
    explanation_summary: 'The evaluator rejected the response.',
    retryable: null,
  }));
}

/**
 * Recompute the descriptive quality score: average within each domain, then
 * give all ten domains equal weight.
 *
 * @param {ReadonlyArray<{domain: string; score: number}>} results
 */
function equalDomainQualityScore(results) {
  if (results.length !== 72) throw new Error('Quality evidence requires exactly 72 result rows.');
  const domainMeans = domainCounts.map(([domain, expectedTaskCount]) => {
    const scores = results
      .filter((result) => result.domain === domain)
      .map((result) => result.score);
    if (
      scores.length !== expectedTaskCount ||
      scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      throw new Error(`Quality evidence requires ${expectedTaskCount} valid ${domain} scores.`);
    }
    return scores.reduce((total, score) => total + score, 0) / scores.length;
  });
  return (100 * domainMeans.reduce((total, score) => total + score, 0)) / domainMeans.length;
}

/** @param {ReadonlyArray<{outcome: string; execution_status: string}>} results */
function summarizeOfficialOutcomes(results) {
  return {
    correct: results.filter((result) => result.outcome === 'correct').length,
    partial: results.filter((result) => result.outcome === 'partial').length,
    evaluatorIncorrect: results.filter((result) => result.outcome === 'incorrect').length,
    timeouts: results.filter((result) => result.outcome === 'timeout').length,
    budgetExceeded: results.filter((result) => result.outcome === 'budget_exhausted').length,
    executionFailures: results.filter((result) => result.execution_status === 'runtime_issue')
      .length,
    completed: results.filter((result) => result.execution_status === 'completed').length,
  };
}

const generatedLeaderboardByMatrix = new Map(
  generatedPublicFixture.leaderboard.map((row) => [row.matrix_id, row]),
);
const catalogByTaskId = new Map(activeCatalog.tasks.map((task) => [task.task_id, task]));

const currentRunEvidence = matrix.map((entry) => {
  const generatedRow = generatedLeaderboardByMatrix.get(entry.id);
  const generatedCells = generatedPublicFixture.task_cells.filter(
    (cell) => cell.matrix_id === entry.id,
  );
  const resultTemplates = generatedResultTemplates();
  const resultTemplatesByTaskId = new Map(
    resultTemplates.map((template) => [template.task_id, template]),
  );
  if (!generatedRow || generatedCells.length !== 72 || resultTemplates.length !== 72) {
    throw new Error(`Missing complete scorer-generated evidence for ${entry.id}.`);
  }
  const results = generatedCells.map((cell) => {
    const task = catalogByTaskId.get(cell.task_id);
    const template = resultTemplatesByTaskId.get(cell.task_id);
    if (
      !task ||
      !template ||
      task.task_version !== cell.task_version ||
      task.domain !== template.domain ||
      cell.provenance !== 'test_generated' ||
      !['correct', 'partial', 'incorrect'].includes(cell.evaluation)
    ) {
      throw new Error(`Invalid scorer-generated task evidence for ${entry.id}.`);
    }
    return Object.assign({}, template, {
      task_id: cell.task_id,
      task: task.title,
      domain: task.domain,
      outcome: cell.evaluation,
      execution_status: 'completed',
      score: cell.task_score,
      explanation_code: null,
      explanation_summary:
        cell.evaluation === 'incorrect' ? 'The evaluator rejected the response.' : null,
      retryable: null,
    });
  });
  const outcomes = summarizeOfficialOutcomes(results);
  const recomputedQuality = equalDomainQualityScore(results);
  const strictPassSuccesses = results.filter((result) => result.score === 1).length;
  if (
    Math.abs(recomputedQuality - generatedRow.quality_score) > Number.EPSILON * 100 ||
    generatedRow.strict_pass_sample_size !== 72 ||
    generatedRow.strict_pass_successes !== strictPassSuccesses ||
    Math.abs(generatedRow.strict_pass_rate - strictPassSuccesses / 72) > Number.EPSILON ||
    generatedRow.sensitivity_low > generatedRow.quality_score ||
    generatedRow.sensitivity_high < generatedRow.quality_score ||
    generatedRow.score_ci_low > generatedRow.score ||
    generatedRow.score_ci_high < generatedRow.score
  ) {
    throw new Error(`Scorer-generated aggregates do not match ${entry.id} task evidence.`);
  }
  return {
    entry,
    runId: generatedRow.run_id,
    startedAt: currentRunStartedAt,
    completedAt: currentRunCompletedAt,
    outcomes,
    results,
    generatedRow,
  };
});

const officialOutcomeTotals = currentRunEvidence.reduce(
  (totals, { outcomes }) => ({
    correct: totals.correct + outcomes.correct,
    partial: totals.partial + outcomes.partial,
    evaluatorIncorrect: totals.evaluatorIncorrect + outcomes.evaluatorIncorrect,
    timeouts: totals.timeouts + outcomes.timeouts,
    budgetExceeded: totals.budgetExceeded + outcomes.budgetExceeded,
    executionFailures: totals.executionFailures + outcomes.executionFailures,
    completed: totals.completed + outcomes.completed,
  }),
  {
    correct: 0,
    partial: 0,
    evaluatorIncorrect: 0,
    timeouts: 0,
    budgetExceeded: 0,
    executionFailures: 0,
    completed: 0,
  },
);
if (
  officialOutcomeTotals.timeouts !== 0 ||
  officialOutcomeTotals.budgetExceeded !== 0 ||
  officialOutcomeTotals.executionFailures !== 0 ||
  officialOutcomeTotals.completed !== 1_224 ||
  currentRunEvidence.reduce((total, evidence) => total + evidence.results.length, 0) !== 1_224
) {
  throw new Error('The live-published fixture does not match scorer-generated outcome totals.');
}

// This test server projects the scorer-generated nested rows into an Official-shaped
// public-view contract only after the fail-closed outer fixture flags above are checked.
// The module is browser-test-only and is not an ingestion or publication path.
const leaderboard = generatedPublicFixture.leaderboard;

const runEvidence = currentRunEvidence;
const runRows = runEvidence.map(({ entry, runId, startedAt, completedAt, outcomes }) => {
  return {
    id: runId,
    matrix_id: entry.id,
    started_at: startedAt,
    completed_at: completedAt,
    benchmark_version: generatedPublicFixture.benchmark_version,
    scoring_version: generatedPublicFixture.scoring_version,
    prompt_set_digest: `sha256:${'2'.repeat(64)}`,
    runner_commit: 'b76148cd419ab4ebb491cdb9f6a00555059eab67',
    region: 'test-generated',
    synthetic: false,
    corpus_release_id: 'corpus_test-generated-aiq-core-1.1.0',
    corpus_commitment_sha256:
      'sha256:f196b67599a7305473dba1054d8511c9bf60011c67fb2f58bb0f8706d04db612',
    catalog_digest: 'sha256:c00b278d0edbdcd3c45cd0d4f21bd9a1b31a40d97acc47253373cd4228c953fb',
    task_set_digest: 'sha256:c7481e46c64dbf5ff9f50a85c83608d48390a03cbf9e94a1d89ab36aeb6df89a',
    preflight_digest: `sha256:${'6'.repeat(64)}`,
    runtime_digest: `sha256:${'7'.repeat(64)}`,
    run_class: 'official',
    permission_evidence_digest: `sha256:${'9'.repeat(64)}`,
    result_count: 72,
    correct_count: outcomes.correct,
    partial_count: outcomes.partial,
    incorrect_count: outcomes.evaluatorIncorrect,
    runtime_issue_count: outcomes.executionFailures,
    invalid_count: 0,
    missing_count: 0,
    not_applicable_count: 0,
    completed_count: outcomes.completed,
    observed_count: 72,
    coverage_percent: 100,
    covered_domain_count: 10,
    provisional_domain_count: 10,
  };
});

const calibrationRunId = `run_${'8'.repeat(64)}`;
const subsetCalibrationRunId = `run_${'7'.repeat(64)}`;
const pricingSource = 'https://developers.openai.com/api/docs/pricing';
const pricingDigest = 'sha256:e1a28656f2918a14e86997b06bf9e29ec4db084ff89ee0319aafa0c05cc1f31d';
const pricingLimitation =
  'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing';
const costFormula =
  '(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again';
const pricingRates = [
  {
    model: 'gpt-5.6-sol',
    input_usd_nanos_per_token: 5000,
    cached_input_usd_nanos_per_token: 500,
    cache_write_input_usd_nanos_per_token: 6250,
    output_usd_nanos_per_token: 30000,
  },
  {
    model: 'gpt-5.6-terra',
    input_usd_nanos_per_token: 2000,
    cached_input_usd_nanos_per_token: 200,
    cache_write_input_usd_nanos_per_token: 2500,
    output_usd_nanos_per_token: 12000,
  },
  {
    model: 'gpt-5.6-luna',
    input_usd_nanos_per_token: 200,
    cached_input_usd_nanos_per_token: 20,
    cache_write_input_usd_nanos_per_token: 250,
    output_usd_nanos_per_token: 1200,
  },
];
const calibrationRun = {
  run_id: calibrationRunId,
  classification: 'local_calibration_non_official',
  scoring_version: generatedPublicFixture.scoring_version,
  selected_task_count: 72,
  selected_model_count: 17,
  result_count: 1_224,
  started_at: '2026-07-30T12:00:00.000Z',
  completed_at: '2026-07-30T14:00:00.000Z',
  verified_at: '2026-07-30T14:05:00.000Z',
  published_at: '2026-07-30T14:10:00.000Z',
  replay_status: 'evaluator_replayed',
  official: false,
  ranking_eligible: false,
  pricing_currency: 'USD',
  pricing_processing_tier: 'standard',
};

const subsetCalibrationRun = {
  ...calibrationRun,
  run_id: subsetCalibrationRunId,
  selected_task_count: 5,
  selected_model_count: 1,
  result_count: 5,
  started_at: '2026-07-31T12:00:00.000Z',
  completed_at: '2026-07-31T12:10:00.000Z',
  verified_at: '2026-07-31T12:15:00.000Z',
  published_at: '2026-07-31T12:20:00.000Z',
};

const calibrationScores = matrix.map((entry, index) => {
  const qualityScore = Number((82.5 - index * 0.6).toFixed(2));
  const unavailableContextBand = index === 1;
  const inputTokens = unavailableContextBand ? 344_001 : 72_000 + index * 1_000;
  const outputTokens = 36_000 + index * 800;
  return {
    run_id: calibrationRunId,
    model_family: entry.model_family.toLowerCase(),
    reasoning_effort: entry.reasoning_tier,
    descriptive_status: index === 0 ? 'conditional_observed' : 'complete_fixture',
    quality_score: qualityScore,
    task_resampling_sensitivity_lower: Number((qualityScore - 1.5).toFixed(2)),
    task_resampling_sensitivity_upper: Number((qualityScore + 1.5).toFixed(2)),
    task_resampling_sensitivity_method: 'finite_cluster_calibrated_percentile_sensitivity_v1',
    result_count: 72,
    sample_size: index === 0 ? 71 : 72,
    coverage_percent: index === 0 ? (71 / 72) * 100 : 100,
    observed_total_wall_ms: 720_000 + index * 36_000,
    observed_median_wall_ms: 10_000 + index * 500,
    observed_p95_wall_ms: 12_000 + index * 550,
    observed_time_sample_count: 72,
    observed_time_coverage_percent: 100,
    duration_evidence_level: 'runner_observed',
    input_tokens: inputTokens,
    cached_input_tokens: 12_000,
    cache_write_input_tokens: 2_000,
    output_tokens: outputTokens,
    reasoning_output_tokens: 18_000 + index * 400,
    total_tokens: inputTokens + outputTokens,
    token_usage_sample_count: 72,
    token_usage_source_level: 'provider_reported',
    token_usage_evidence_level: 'verifier_recomputed',
    standard_api_equivalent_usd_nanos: unavailableContextBand
      ? null
      : 48_000_000 + index * 2_000_000,
    estimated_cost_sample_count: unavailableContextBand ? 71 : 72,
    cost_estimator_status: unavailableContextBand ? 'unavailable_context_band' : 'estimated',
    cost_evidence_level: unavailableContextBand ? null : 'verifier_recomputed',
    cost_estimator_limitations: [pricingLimitation],
    token_usage_coverage_percent: 100,
    pricing_source: pricingSource,
    pricing_as_of: '2026-08-02',
    pricing_version: 'aiq.standard-api-equivalent-usd.v1',
    pricing_currency: 'USD',
    pricing_processing_tier: 'standard',
    attempted_result_count: 72,
    invoked_result_count: 72,
    adapter_elapsed_observed_result_count: 72,
    token_observed_result_count: 72,
    priced_result_count: unavailableContextBand ? 71 : 72,
  };
});

const subsetCalibrationScore = {
  ...calibrationScores[7],
  run_id: subsetCalibrationRunId,
  result_count: 5,
  sample_size: 5,
  coverage_percent: 100,
  observed_time_sample_count: 5,
  token_usage_sample_count: 5,
  estimated_cost_sample_count: 5,
  attempted_result_count: 5,
  invoked_result_count: 5,
  adapter_elapsed_observed_result_count: 5,
  token_observed_result_count: 5,
  priced_result_count: 5,
};

const historicalCalibrationScores = [
  subsetCalibrationScore,
  ...calibrationScores,
  { ...calibrationScores[0], run_id: 'run-stale-calibration-history' },
];

const calibrationResults = matrix.flatMap((entry, configurationIndex) =>
  Array.from({ length: 72 }, (_, taskIndex) => {
    const unavailableContextBand = configurationIndex === 0 && taskIndex === 1;
    const inputTokens = unavailableContextBand
      ? 272_001
      : 1_000 + configurationIndex * 10 + taskIndex;
    const outputTokens = 500 + taskIndex;
    const workspaceIntegrity = configurationIndex === 0 && taskIndex === 0;
    return {
      result_id: `result_${String(configurationIndex).padStart(2, '0')}_${String(taskIndex).padStart(2, '0')}`,
      run_id: calibrationRunId,
      task_id: `aiq-v1-calibration-task-${String(taskIndex + 1).padStart(2, '0')}`,
      task_version: AIQ_CORE_TASK_SET_VERSION,
      domain: domainCounts[taskIndex % domainCounts.length]?.[0] ?? 'coding',
      model_family: entry.model_family.toLowerCase(),
      reasoning_effort: entry.reasoning_tier,
      outcome: workspaceIntegrity ? 'invalid' : 'correct',
      execution_status: workspaceIntegrity ? 'invalid' : 'completed',
      failure_code: workspaceIntegrity ? 'workspace_integrity' : null,
      explanation_code: workspaceIntegrity ? 'workspace_integrity' : null,
      explanation_summary: workspaceIntegrity
        ? 'Benchmark infrastructure invalidated this result; an audited rerun is required.'
        : null,
      task_score: workspaceIntegrity ? null : 1,
      latency_ms: 8_000 + taskIndex * 50,
      latency_evidence_level: 'runner_observed',
      input_tokens: inputTokens,
      cached_input_tokens: 200,
      cache_write_input_tokens: 50,
      output_tokens: outputTokens,
      reasoning_output_tokens: 250,
      total_tokens: inputTokens + outputTokens,
      token_usage_source_level: 'provider_reported',
      token_usage_evidence_level: 'verifier_recomputed',
      standard_api_equivalent_usd_nanos: unavailableContextBand
        ? null
        : 650_000 + taskIndex * 1_000,
      cost_estimator_status: unavailableContextBand ? 'unavailable_context_band' : 'estimated',
      cost_evidence_level: unavailableContextBand ? null : 'verifier_recomputed',
      cost_estimator_limitations: [pricingLimitation],
      cost_method: 'standard_api_equivalent_text_token_estimate',
      cost_version: 'aiq.standard-api-equivalent-usd.v1',
      cost_as_of: '2026-08-02',
      cost_source: pricingSource,
      pricing_currency: 'USD',
      pricing_processing_tier: 'standard',
    };
  }),
);

calibrationResults.push(
  ...calibrationResults
    .filter((result) => result.model_family === 'terra' && result.reasoning_effort === 'medium')
    .slice(0, 5)
    .map((result, index) =>
      Object.assign({}, result, {
        result_id: `subset_result_${String(index).padStart(2, '0')}`,
        run_id: subsetCalibrationRunId,
      }),
    ),
);

const modelEfficiency = calibrationScores.map((score, index) => {
  const completeTokens = index === 0;
  const partialTokens = index === 2;
  const contextBandTokens = index === 4;
  const tokenCount = completeTokens || contextBandTokens ? 72 : partialTokens ? 36 : 0;
  const tokenCoveragePercent = tokenCount === 0 ? null : (tokenCount / 72) * 100;
  const tokensAvailable = tokenCount > 0;
  const durationAvailable = index !== 3;
  const runId = leaderboard[index]?.run_id;
  if (!runId) throw new Error(`Missing generated run identity for matrix index ${index}.`);
  return {
    run_id: runId,
    matrix_batch_id: `run_${'b'.repeat(64)}`,
    model_family: score.model_family,
    reasoning_effort: score.reasoning_effort,
    matrix_batch_elapsed_ms: 5_844_411,
    summed_cell_adapter_elapsed_ms: durationAvailable ? score.observed_total_wall_ms : null,
    observed_median_wall_ms: durationAvailable ? score.observed_median_wall_ms : null,
    observed_p95_wall_ms: durationAvailable ? score.observed_p95_wall_ms : null,
    observed_time_sample_count: durationAvailable ? 72 : 0,
    observed_time_coverage_percent: durationAvailable ? 100 : 0,
    duration_evidence_level: durationAvailable ? 'runner_observed' : null,
    input_tokens: tokensAvailable ? 72_000 : null,
    cached_input_tokens: tokensAvailable ? 12_000 : null,
    cache_write_input_tokens: tokensAvailable ? 6_000 : null,
    output_tokens: tokensAvailable ? 36_000 : null,
    reasoning_output_tokens: tokensAvailable ? 12_000 : null,
    total_tokens: null,
    token_usage_sample_count: tokenCount,
    token_usage_coverage_percent: tokenCoveragePercent,
    input_token_coverage_count: tokensAvailable ? tokenCount : null,
    input_token_coverage_percent: tokenCoveragePercent,
    cached_input_token_coverage_count: tokensAvailable ? tokenCount : null,
    cached_input_token_coverage_percent: tokenCoveragePercent,
    cache_write_input_token_coverage_count: tokensAvailable ? tokenCount : null,
    cache_write_input_token_coverage_percent: tokenCoveragePercent,
    output_token_coverage_count: tokensAvailable ? tokenCount : null,
    output_token_coverage_percent: tokenCoveragePercent,
    reasoning_token_coverage_count: tokensAvailable ? tokenCount : null,
    reasoning_token_coverage_percent: tokenCoveragePercent,
    total_token_coverage_count: null,
    total_token_coverage_percent: null,
    token_usage_source_level: tokensAvailable ? 'provider_reported' : null,
    token_usage_evidence_level: tokensAvailable ? 'verifier_recomputed' : null,
    standard_api_equivalent_usd_nanos: completeTokens ? 12_345_600_000 : null,
    cost_estimator_status: completeTokens
      ? 'estimated'
      : contextBandTokens
        ? 'unavailable_context_band'
        : 'unavailable_missing_usage',
    cost_evidence_level: completeTokens ? 'verifier_recomputed' : null,
    cost_method: 'standard_api_equivalent_text_token_estimate',
    pricing_source: score.pricing_source,
    pricing_as_of: score.pricing_as_of,
    pricing_version: score.pricing_version,
    pricing_currency: score.pricing_currency,
    pricing_processing_tier: score.pricing_processing_tier,
    result_count: 72,
    attempted_result_count: 72,
    invoked_result_count: 72,
    adapter_elapsed_observed_result_count: durationAvailable ? 72 : 0,
    token_observed_result_count: tokenCount,
    priced_result_count: completeTokens || contextBandTokens ? 72 : 0,
    execution_concurrency: 17,
    estimated_cost_sample_count: completeTokens || contextBandTokens ? 72 : 0,
    cost_estimator_limitations: score.cost_estimator_limitations,
    pricing_rates: pricingRates,
    cost_formula: costFormula,
  };
});

const publishedModelEfficiency = modelEfficiency;

/** @type {Array<{ run_id: string; [key: string]: unknown }>} */
const runResults = [];
let publishedResultIndex = 0;
for (const evidence of runEvidence) {
  const modelRate = pricingRates.find((rate) => rate.model === evidence.entry.model_name);
  if (!modelRate) throw new Error(`Missing pricing rate for ${evidence.entry.model_name}.`);
  let globalIndex = 0;
  for (const result of evidence.results) {
    globalIndex += 1;
    publishedResultIndex += 1;
    const runtimeIssue = result.execution_status === 'runtime_issue';
    const unavailableContextBand = !runtimeIssue && publishedResultIndex <= 10;
    const unavailableMissingUsage = !runtimeIssue && publishedResultIndex > 1_218;
    const estimatedCost = !runtimeIssue && !unavailableContextBand && !unavailableMissingUsage;
    const tokensAvailable = estimatedCost || unavailableContextBand;
    const inputTokens = tokensAvailable
      ? unavailableContextBand
        ? 272_001 + publishedResultIndex
        : 1_000 + publishedResultIndex
      : null;
    const cachedInputTokens = tokensAvailable ? 200 : null;
    const cacheWriteInputTokens = tokensAvailable ? 50 : null;
    const outputTokens = tokensAvailable ? 500 : null;
    const estimatedUsdNanos = estimatedCost
      ? (inputTokens - cachedInputTokens - cacheWriteInputTokens) *
          modelRate.input_usd_nanos_per_token +
        cachedInputTokens * modelRate.cached_input_usd_nanos_per_token +
        cacheWriteInputTokens * modelRate.cache_write_input_usd_nanos_per_token +
        outputTokens * modelRate.output_usd_nanos_per_token
      : null;
    runResults.push({
      run_id: evidence.runId,
      id: result.id,
      task_id: result.task_id,
      task: result.task,
      domain: result.domain,
      outcome: result.outcome,
      execution_status: result.execution_status,
      score: result.score,
      explanation_code: result.explanation_code,
      explanation_summary: result.explanation_summary,
      retryable: result.retryable,
      tools: ['repository_search', 'test_runner'],
      agent_steps: 8 + (globalIndex % 19),
      tool_call_count: 4,
      tool_calls_by_type: { repository_search: 2, test_runner: 2 },
      latency_ms: 7_500 + globalIndex * 137,
      latency_evidence_level: 'runner_observed',
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      cache_write_input_tokens: cacheWriteInputTokens,
      output_tokens: outputTokens,
      reasoning_output_tokens: tokensAvailable ? 250 : null,
      total_tokens: null,
      token_usage_source_level: tokensAvailable ? 'provider_reported' : null,
      token_usage_evidence_level: tokensAvailable ? 'verifier_recomputed' : null,
      standard_api_equivalent_usd_nanos: estimatedUsdNanos,
      cost_estimator_status: estimatedCost
        ? 'estimated'
        : unavailableContextBand
          ? 'unavailable_context_band'
          : 'unavailable_missing_usage',
      cost_evidence_level: estimatedCost ? 'verifier_recomputed' : null,
      pricing_digest: pricingDigest,
    });
  }
}

const resultCostCoverage = {
  estimated: runResults.filter((result) => result.cost_estimator_status === 'estimated').length,
  unavailableContextBand: runResults.filter(
    (result) => result.cost_estimator_status === 'unavailable_context_band',
  ).length,
  unavailableMissingUsage: runResults.filter(
    (result) => result.cost_estimator_status === 'unavailable_missing_usage',
  ).length,
};
if (
  resultCostCoverage.estimated !== 1_208 ||
  resultCostCoverage.unavailableContextBand !== 10 ||
  resultCostCoverage.unavailableMissingUsage !== 6
) {
  throw new Error('Official result cost coverage must match the verified production matrix.');
}

const scoringVersion = {
  benchmark_version: generatedPublicFixture.benchmark_version,
  scoring_version: generatedPublicFixture.scoring_version,
  published_at: '2026-01-01T00:00:00.000Z',
  principles: [
    'Calibrate latent ability from one complete fixed 17-by-72 matrix.',
    'Keep descriptive quality score separate from calibrated ability.',
    'Publish strict-pass Wilson uncertainty and task-mix sensitivity separately.',
    'Keep missing, invalid, and runtime evidence visible.',
  ],
  missing_policy: 'Missing and invalid results block Official publication.',
  failure_policy: 'A valid failed attempt scores zero and remains visible.',
  sensitivity_policy:
    'Task-mix sensitivity surrounds descriptive quality score; the conditional interval surrounds calibrated ability.',
  synthetic: false,
};

const taskCoverage = domainCounts.map(([domain, task_count]) => ({
  scoring_version: generatedPublicFixture.scoring_version,
  domain,
  weight: 0.1,
  task_count,
}));

const radar = [
  {
    node_id: `node_${'b'.repeat(64)}`,
    name: 'Published East Runner',
    operator: 'AIQ production fixture operator',
    public_key_fingerprint: provenanceHash,
    registry_trust: 'trusted_verified',
    registry_status: 'active',
    last_seen_at: '2026-07-29T15:58:00.000Z',
    synthetic: false,
    latest_capability_schema_version: 'aiq.distributed-capability.v1',
    latest_capability_hash: `sha256:${'c'.repeat(64)}`,
    latest_capability_status: 'validated',
    latest_capability_signature_status: 'verified',
    latest_capability_observed_at: '2026-07-29T15:55:00.000Z',
    latest_observation_schema_version: 'aiq.distributed-observation.v1',
    latest_observation_state: 'ready',
    latest_observation_sequence: 42,
    latest_observation_hash: `sha256:${'d'.repeat(64)}`,
    latest_observation_status: 'accepted',
    latest_observation_signature_status: 'verified',
    latest_observation_observed_at: '2026-07-29T15:58:00.000Z',
    latest_observation_provenance_hash: `sha256:${'e'.repeat(64)}`,
    assignment_total_count: 12,
    assignment_offered_count: 0,
    assignment_accepted_count: 0,
    assignment_running_count: 0,
    assignment_completed_count: 12,
    assignment_revoked_count: 0,
    assignment_expired_count: 0,
    receipt_total_count: 12,
    receipt_received_count: 0,
    receipt_accepted_count: 12,
    receipt_rejected_count: 0,
    receiver_verified_trusted_count: 12,
    signed_untrusted_count: 0,
    rejected_count: 0,
    missing_count: 0,
    aggregated_at: '2026-07-29T15:59:00.000Z',
  },
];

const trends = generatedPublicFixture.trend;
const trendDates = [...new Set(trends.map((point) => point.recorded_at))];

if (new Set(trends.map((point) => point.run_id)).size !== trends.length) {
  throw new Error('Every retained trend point must have one independent run identity.');
}
for (const point of trends) {
  const run = runRows.find((candidate) => candidate.id === point.run_id);
  if (
    !run ||
    run.matrix_id !== point.matrix_id ||
    run.synthetic ||
    point.synthetic ||
    Date.parse(run.started_at) > Date.parse(run.completed_at) ||
    Date.parse(run.completed_at) > Date.parse(point.recorded_at)
  ) {
    throw new Error('Retained trend evidence must bind one time-valid non-synthetic run.');
  }
}
for (const current of leaderboard) {
  const retainedCount = trends.filter((point) => point.matrix_id === current.matrix_id).length;
  const latest = trends.find((point) => point.matrix_id === current.matrix_id);
  if (
    retainedCount !== 1 ||
    !latest ||
    latest.run_id !== current.run_id ||
    latest.score !== current.score ||
    latest.sensitivity_low !== current.sensitivity_low ||
    latest.sensitivity_high !== current.sensitivity_high ||
    latest.sample_size !== current.sample_size
  ) {
    throw new Error('The latest retained trend point must equal its current leaderboard row.');
  }
}

for (const evidence of currentRunEvidence) {
  const current = leaderboard.find((row) => row.run_id === evidence.runId);
  const recomputedQuality = equalDomainQualityScore(evidence.results);
  const strictPassSuccesses = evidence.results.filter((result) => result.score === 1).length;
  if (
    !current ||
    Math.abs(current.quality_score - recomputedQuality) > Number.EPSILON * 100 ||
    current.strict_pass_sample_size !== evidence.results.length ||
    current.strict_pass_successes !== strictPassSuccesses ||
    Math.abs(current.strict_pass_rate - strictPassSuccesses / evidence.results.length) >
      Number.EPSILON ||
    current.sensitivity_low > current.quality_score ||
    current.sensitivity_high < current.quality_score ||
    current.score_ci_low > current.score ||
    current.score_ci_high < current.score
  ) {
    throw new Error('Current leaderboard values must derive from their exact task evidence.');
  }
}

const rpcContract = Object.entries(REQUIRED_RPC_CONTRACT).map(([name, contract]) => ({
  name,
  arguments: contract.arguments,
  result: contract.result,
  default_count: contract.defaultCount,
  argument_modes: contract.modes,
  executable_roles: contract.grants,
}));

/**
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} value
 * @param {number} [status]
 */
function json(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {string | null}
 */
function decodeRole(request) {
  const authorization = request.headers.authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const encodedPayload = token.split('.')[1];
  if (!encodedPayload) return null;
  try {
    /** @type {unknown} */
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    if (!('role' in payload)) return null;
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * @template T
 * @param {URL} url
 * @param {readonly T[]} rows
 * @returns {T[]}
 */
function limited(url, rows) {
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  return Number.isSafeInteger(limit) && limit >= 0 ? rows.slice(0, limit) : [...rows];
}

/**
 * @param {string} range
 */
function trendRowsForRange(range) {
  const dateCount = range === 'day' ? 1 : range === 'week' ? 2 : range === 'month' ? 4 : 5;
  const allowedDates = new Set(trendDates.slice(0, dateCount));
  return trends.filter((point) => allowedDates.has(point.recorded_at));
}

/**
 * @param {string} range
 */
function speedTrendRowsForRange(range) {
  const dateCount = range === 'day' ? 1 : range === 'week' ? 5 : 5;
  const allowedDates = new Set(speedTrendDates.slice(-dateCount));
  return speedTrendRows.filter((point) => allowedDates.has(point.recorded_at));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') {
    json(response, { status: 'ok' });
    return;
  }
  if (url.pathname === '/storage/v1/bucket') {
    json(response, [
      { name: 'aiq-submission-packages', public: false },
      { name: 'aiq-runner-artifacts', public: false },
    ]);
    return;
  }
  if (url.pathname === '/rest/v1/rpc/aiq_describe_web_rpc_contract') {
    json(response, rpcContract);
    return;
  }
  if (url.pathname === '/rest/v1/rpc/aiq_gateway_role_probe') {
    json(response, decodeRole(request));
    return;
  }
  if (url.pathname === '/rest/v1/rpc/public_trend_points') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      /** @type {unknown} */
      const payload = JSON.parse(body || '{}');
      const suppliedRange =
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        'supplied_range' in payload
          ? payload.supplied_range
          : undefined;
      const range = typeof suppliedRange === 'string' ? suppliedRange : 'all';
      json(response, trendRowsForRange(range));
    });
    return;
  }
  if (url.pathname === '/rest/v1/rpc/public_speed_trend_points') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      /** @type {unknown} */
      const payload = JSON.parse(body || '{}');
      const suppliedRange =
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        'supplied_range' in payload
          ? payload.supplied_range
          : undefined;
      const range = typeof suppliedRange === 'string' ? suppliedRange : 'all';
      json(response, speedTrendRowsForRange(range));
    });
    return;
  }
  if (url.pathname === '/rest/v1/public_model_matrix') {
    json(response, limited(url, matrix));
    return;
  }
  if (url.pathname === '/rest/v1/public_leaderboard') {
    json(response, limited(url, leaderboard));
    return;
  }
  if (url.pathname === '/rest/v1/public_runs') {
    const idFilter = url.searchParams.get('id') ?? '';
    const exactId = idFilter.startsWith('eq.') ? idFilter.slice(3) : undefined;
    const selectedIds = new Set(
      idFilter.startsWith('in.(') ? idFilter.slice(4, -1).split(',').filter(Boolean) : [],
    );
    const exactStartedAt = url.searchParams.get('started_at')?.replace(/^eq\./, '');
    const cursorExpression = url.searchParams.get('or') ?? '';
    const olderStartedAt = /started_at\.lt\.([^,)]+)/.exec(cursorExpression)?.[1];
    const newerStartedAt = /started_at\.gt\.([^,)]+)/.exec(cursorExpression)?.[1];
    const boundaryStartedAt = /started_at\.eq\.([^,)]+)/.exec(cursorExpression)?.[1];
    const olderId = /id\.gt\.([^,)]+)/.exec(cursorExpression)?.[1];
    const newerId = /id\.lt\.([^,)]+)/.exec(cursorExpression)?.[1];
    const ordered = [...runRows];
    const ascending = (url.searchParams.get('order') ?? '').includes('started_at.asc');
    ordered.sort(
      (left, right) =>
        (ascending
          ? left.started_at.localeCompare(right.started_at)
          : right.started_at.localeCompare(left.started_at)) ||
        (ascending ? right.id.localeCompare(left.id) : left.id.localeCompare(right.id)),
    );
    const rows =
      selectedIds.size > 0
        ? ordered.filter((run) => selectedIds.has(run.id))
        : exactId
          ? ordered.filter(
              (run) => run.id === exactId && (!exactStartedAt || run.started_at === exactStartedAt),
            )
          : ordered.filter((run) => {
              if (olderStartedAt) {
                return (
                  run.started_at < olderStartedAt ||
                  (run.started_at === boundaryStartedAt && (!olderId || run.id > olderId))
                );
              }
              if (newerStartedAt) {
                return (
                  run.started_at > newerStartedAt ||
                  (run.started_at === boundaryStartedAt && (!newerId || run.id < newerId))
                );
              }
              return true;
            });
    const selectedRows =
      url.searchParams.get('select') === 'id,started_at'
        ? rows.map(({ id, started_at }) => ({ id, started_at }))
        : rows;
    json(response, limited(url, selectedRows));
    return;
  }
  if (url.pathname === '/rest/v1/public_run_results') {
    const runIdFilter = url.searchParams.get('run_id') ?? '';
    const selectedIds = new Set(
      runIdFilter
        .replace(/^in\.\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .filter(Boolean),
    );
    const rows =
      selectedIds.size === 0
        ? runResults
        : runResults.filter((result) => selectedIds.has(result.run_id));
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_scoring_versions') {
    const wantsObject = request.headers.accept?.includes('application/vnd.pgrst.object+json');
    json(response, wantsObject ? scoringVersion : limited(url, [scoringVersion]));
    return;
  }
  if (url.pathname === '/rest/v1/public_task_coverage') {
    json(response, limited(url, taskCoverage));
    return;
  }
  if (url.pathname === '/rest/v1/public_calibration_runs') {
    const exactId = url.searchParams.get('run_id')?.replace(/^eq\./, '');
    const exactStartedAt = url.searchParams.get('started_at')?.replace(/^eq\./, '');
    const rows = (emptyCalibrationEvidence ? [] : [subsetCalibrationRun, calibrationRun]).filter(
      (run) =>
        (!exactId || run.run_id === exactId) &&
        (!exactStartedAt || run.started_at === exactStartedAt),
    );
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_calibration_results') {
    const exactRunId = url.searchParams.get('run_id')?.replace(/^eq\./, '');
    const family = url.searchParams.get('model_family')?.replace(/^eq\./, '');
    const effort = url.searchParams.get('reasoning_effort')?.replace(/^eq\./, '');
    const rows = calibrationResults.filter(
      (result) =>
        (!exactRunId || result.run_id === exactRunId) &&
        (!family || result.model_family === family) &&
        (!effort || result.reasoning_effort === effort),
    );
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_calibration_scores') {
    const exactRunId = url.searchParams.get('run_id')?.replace(/^eq\./, '');
    const rows = exactRunId
      ? historicalCalibrationScores.filter((score) => score.run_id === exactRunId)
      : historicalCalibrationScores;
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_model_efficiency') {
    const runIdFilter = url.searchParams.get('run_id') ?? '';
    const selectedIds = new Set(
      runIdFilter
        .replace(/^in\.\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .filter(Boolean),
    );
    const rows =
      selectedIds.size === 0
        ? publishedModelEfficiency
        : publishedModelEfficiency.filter((entry) => selectedIds.has(entry.run_id));
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_speed_observations') {
    json(response, limited(url, speedObservationRows));
    return;
  }
  if (url.pathname === '/rest/v1/public_distributed_radar') {
    json(response, limited(url, radar));
    return;
  }
  if (url.pathname === '/rest/v1/public_nodes') {
    json(response, []);
    return;
  }
  json(response, { message: 'not found' }, 404);
});

server.listen(port, '127.0.0.1');
