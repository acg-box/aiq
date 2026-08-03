import { createServer } from 'node:http';

import { REQUIRED_RPC_CONTRACT } from '../src/server/readiness.ts';

const port = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Supply one valid mock Supabase port.');
}

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

const leaderboard = matrix.map((entry, index) => {
  const score = Number((84.2 - index * 0.7).toFixed(1));
  return {
    matrix_id: entry.id,
    run_id: `run-live-${entry.id}`,
    score,
    ci_low: Number((score - 1.8).toFixed(1)),
    ci_high: Number((score + 1.8).toFixed(1)),
    sample_size: 72,
    coverage_percent: 100,
    failures: 0,
    missing: 0,
    scoring_version: '1.0.0',
    score_status: 'official',
    synthetic: false,
  };
});

const provenanceHash = `sha256:${'1'.repeat(64)}`;
const runRows = matrix.map((entry, index) => ({
  id: `run-live-${entry.id}`,
  matrix_id: entry.id,
  started_at: `2026-07-${String(29 - index).padStart(2, '0')}T13:00:00.000Z`,
  completed_at: `2026-07-${String(29 - index).padStart(2, '0')}T13:27:00.000Z`,
  benchmark_version: 'aiq-core@1.0.1',
  scoring_version: '1.0.0',
  prompt_set_digest: `sha256:${'2'.repeat(64)}`,
  runner_commit: '7a0c4d1',
  region: 'us-east-1',
  synthetic: false,
  corpus_release_id: 'corpus_2026.07.29',
  corpus_commitment_sha256: `sha256:${'3'.repeat(64)}`,
  catalog_digest: 'sha256:b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc',
  task_set_digest: `sha256:${'5'.repeat(64)}`,
  preflight_digest: `sha256:${'6'.repeat(64)}`,
  runtime_digest: `sha256:${'7'.repeat(64)}`,
  run_class: 'official',
  permission_evidence_digest: `sha256:${'9'.repeat(64)}`,
  result_count: 72,
  passed_count: 72,
  failed_count: 0,
  invalid_count: 0,
  missing_count: 0,
  not_applicable_count: 0,
  observed_count: 72,
  coverage_percent: 100,
  covered_domain_count: 10,
  provisional_domain_count: 10,
}));

const calibrationRunId = `run_${'8'.repeat(64)}`;
const subsetCalibrationRunId = `run_${'7'.repeat(64)}`;
const pricingSource = 'https://developers.openai.com/api/docs/pricing';
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
  scoring_version: '1.0.0',
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
  const aiq = Number((82.5 - index * 0.6).toFixed(2));
  const unavailableContextBand = index === 1;
  const inputTokens = unavailableContextBand ? 344_001 : 72_000 + index * 1_000;
  const outputTokens = 36_000 + index * 800;
  return {
    run_id: calibrationRunId,
    model_family: entry.model_family.toLowerCase(),
    reasoning_effort: entry.reasoning_tier,
    descriptive_status: index === 0 ? 'conditional_observed' : 'complete_fixture',
    aiq,
    task_resampling_sensitivity_lower: Number((aiq - 1.5).toFixed(2)),
    task_resampling_sensitivity_upper: Number((aiq + 1.5).toFixed(2)),
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
      task_version: '1.0.1',
      domain: domainCounts[taskIndex % domainCounts.length]?.[0] ?? 'coding',
      model_family: entry.model_family.toLowerCase(),
      reasoning_effort: entry.reasoning_tier,
      outcome: workspaceIntegrity ? 'invalid' : 'correct',
      status: workspaceIntegrity ? 'invalid' : 'passed',
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

const modelEfficiency = calibrationScores.map((score, index) => ({
  run_id: leaderboard[index]?.run_id ?? `run-live-${matrix[index]?.id ?? index}`,
  matrix_batch_id: `run_${'b'.repeat(64)}`,
  model_family: score.model_family,
  reasoning_effort: score.reasoning_effort,
  matrix_batch_elapsed_ms: 7_652_000,
  summed_cell_adapter_elapsed_ms: score.observed_total_wall_ms,
  observed_median_wall_ms: score.observed_median_wall_ms,
  observed_p95_wall_ms: score.observed_p95_wall_ms,
  observed_time_sample_count: score.observed_time_sample_count,
  observed_time_coverage_percent: score.observed_time_coverage_percent,
  duration_evidence_level: score.duration_evidence_level,
  input_tokens: score.input_tokens,
  cached_input_tokens: score.cached_input_tokens,
  cache_write_input_tokens: score.cache_write_input_tokens,
  output_tokens: score.output_tokens,
  reasoning_output_tokens: score.reasoning_output_tokens,
  total_tokens: score.total_tokens,
  token_usage_sample_count: score.token_usage_sample_count,
  token_usage_coverage_percent: score.token_usage_coverage_percent,
  input_token_coverage_count: 72,
  input_token_coverage_percent: 100,
  cached_input_token_coverage_count: 72,
  cached_input_token_coverage_percent: 100,
  cache_write_input_token_coverage_count: 72,
  cache_write_input_token_coverage_percent: 100,
  output_token_coverage_count: 72,
  output_token_coverage_percent: 100,
  reasoning_token_coverage_count: 72,
  reasoning_token_coverage_percent: 100,
  total_token_coverage_count: 72,
  total_token_coverage_percent: 100,
  token_usage_source_level: score.token_usage_source_level,
  token_usage_evidence_level: score.token_usage_evidence_level,
  standard_api_equivalent_usd_nanos: score.standard_api_equivalent_usd_nanos,
  cost_estimator_status: score.cost_estimator_status,
  cost_evidence_level: score.cost_evidence_level,
  cost_method: 'standard_api_equivalent_text_token_estimate',
  pricing_source: score.pricing_source,
  pricing_as_of: score.pricing_as_of,
  pricing_version: score.pricing_version,
  pricing_currency: score.pricing_currency,
  pricing_processing_tier: score.pricing_processing_tier,
  result_count: 72,
  attempted_result_count: 72,
  invoked_result_count: 72,
  adapter_elapsed_observed_result_count: 72,
  token_observed_result_count: 72,
  priced_result_count: score.priced_result_count,
  execution_concurrency: 17,
  estimated_cost_sample_count: score.estimated_cost_sample_count,
  cost_estimator_limitations: score.cost_estimator_limitations,
  pricing_rates: pricingRates,
  cost_formula: costFormula,
}));

const historicalModelEfficiency = [
  ...modelEfficiency,
  { ...modelEfficiency[0], run_id: 'run-stale-official-history' },
];

/** @type {Array<{ run_id: string; [key: string]: unknown }>} */
const runResults = [];
for (const run of runRows) {
  const publishedScore = leaderboard.find((entry) => entry.matrix_id === run.matrix_id)?.score ?? 0;
  let globalIndex = 0;
  for (const [domain, taskCount] of domainCounts) {
    for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
      globalIndex += 1;
      runResults.push({
        run_id: run.id,
        id: `aiq-v1-${domain}-${String(taskIndex + 1).padStart(2, '0')}`,
        task: `${domain.replaceAll('_', ' ')} published fixture ${taskIndex + 1}`,
        domain,
        status: 'passed',
        score: publishedScore / 100,
        explanation_code: null,
        explanation_summary: null,
        retryable: null,
        tools: ['repository search', 'test runner'],
        latency_ms: 7_500 + globalIndex * 137,
        latency_evidence_level: 'runner_observed',
        input_tokens: 1_000 + globalIndex,
        cached_input_tokens: 200,
        cache_write_input_tokens: 50,
        output_tokens: 500 + globalIndex,
        reasoning_output_tokens: 250,
        total_tokens: 1_500 + globalIndex * 2,
        token_usage_source_level: 'provider_reported',
        token_usage_evidence_level: 'verifier_recomputed',
        standard_api_equivalent_usd_nanos: 650_000 + globalIndex * 1_000,
        cost_estimator_status: 'estimated',
        cost_evidence_level: 'verifier_recomputed',
      });
    }
  }
}

const scoringVersion = {
  benchmark_version: 'aiq-core@1.0.1',
  scoring_version: '1.0.0',
  published_at: '2026-07-29T16:00:00.000Z',
  principles: [
    'Estimate performance on the committed AIQ v1 fixed-fixture set.',
    'Score every frozen domain with equal weight.',
    'Publish outcome counts and provenance without exposing hidden payloads.',
    'Keep missing or invalid work visible.',
  ],
  missing_policy: 'Missing and invalid results block Official publication.',
  failure_policy: 'A valid failed attempt scores zero and remains visible.',
  confidence_policy:
    'The interval is a fixed-fixture task-resampling sensitivity interval, not a universal capability claim.',
  synthetic: false,
};

const taskCoverage = domainCounts.map(([domain, task_count]) => ({
  scoring_version: '1.0.0',
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

const trendDates = [
  '2026-07-29T12:00:00.000Z',
  '2026-07-26T12:00:00.000Z',
  '2026-07-12T12:00:00.000Z',
  '2026-05-29T12:00:00.000Z',
];
const trends = matrix.flatMap((entry, entryIndex) =>
  trendDates.map((recordedAt, dateIndex) => {
    const score = Number((84.2 - entryIndex * 0.7 - dateIndex * 0.4).toFixed(1));
    return {
      matrix_id: entry.id,
      run_id: `run-live-${entry.id}`,
      recorded_at: recordedAt,
      bucket_started_at: recordedAt,
      bucket_ended_at: new Date(Date.parse(recordedAt) + 3_600_000).toISOString(),
      score,
      ci_low: Number((score - 1.8).toFixed(1)),
      ci_high: Number((score + 1.8).toFixed(1)),
      sample_size: 72,
      represented_run_count: 1,
      resolution_seconds: 3_600,
      synthetic: false,
    };
  }),
);

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
  const dateCount = range === 'day' ? 1 : range === 'week' ? 2 : range === 'month' ? 3 : 4;
  const allowedDates = new Set(trendDates.slice(0, dateCount));
  return trends.filter((point) => allowedDates.has(point.recorded_at));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') {
    json(response, { status: 'ok' });
    return;
  }
  if (url.pathname === '/storage/v1/bucket') {
    json(response, [
      { name: 'private-packages', public: false },
      { name: 'private-artifacts', public: false },
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
  if (url.pathname === '/rest/v1/public_model_matrix') {
    json(response, limited(url, matrix));
    return;
  }
  if (url.pathname === '/rest/v1/public_leaderboard') {
    json(response, limited(url, leaderboard));
    return;
  }
  if (url.pathname === '/rest/v1/public_runs') {
    const exactId = url.searchParams.get('id')?.replace(/^eq\./, '');
    const rows = exactId ? runRows.filter((run) => run.id === exactId) : runRows;
    json(response, limited(url, rows));
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
    const rows = [subsetCalibrationRun, calibrationRun].filter(
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
        ? historicalModelEfficiency
        : historicalModelEfficiency.filter((entry) => selectedIds.has(entry.run_id));
    json(response, limited(url, rows));
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
