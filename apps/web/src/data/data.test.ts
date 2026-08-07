import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  classifyRunCompleteness,
  classifyRunSummaryCompleteness,
  classifyObservationRecency,
  filterTrendPoints,
  formatAnyCreditRate,
  formatSensitivityInterval,
  formatLastObservation,
  formatTrustLevel,
  latestCompletedRun,
  leaderboardRunHref,
  sortLeaderboardByPointEstimate,
  summarizeRun,
  summarizeRunDomains,
  summarizeRunOutcomes,
  TRUST_LEVELS,
} from './format.ts';
import {
  presentLeaderboardEntry,
  presentedScoreRange,
  presentScoreMetric,
  sortByPresentedScore,
} from './leaderboard-presentation.ts';
import {
  CALIBRATION_MODEL_CONFIGURATIONS,
  CALIBRATION_RUN_PAGE_SIZE,
  CANONICAL_MODEL_MATRIX_IDS,
  buildSeedCalibrationRunPage,
  buildSeedRunHistoryPage,
  calibrationExplanationSummaryForOutcome,
  calibrationFailureCodeForOutcome,
  executionStatusForOutcome,
  classifyPublicDataConfiguration,
  collectPaginatedRows,
  createAiqRepository,
  decodeCalibrationRunCursor,
  joinModelMatrixWithLeaderboard,
  decodeRunHistoryCursor,
  encodeCalibrationRunCursor,
  encodeRunHistoryCursor,
  mapRunRow,
  parseDistributedRadarRows,
  PUBLIC_READ_PAGE_SIZE,
  PUBLIC_VIEW_NAMES,
  RUN_HISTORY_PAGE_SIZE,
  SeedAiqRepository,
  SupabaseAiqRepository,
  type DistributedRadarRow,
  type LeaderboardRow,
  type ModelMatrixRow,
  type RunResultRow,
  type RunRow,
  TREND_MAX_POINTS,
  type TrendRow,
} from './repository.ts';
import { inspectPublicSupabaseConfiguration } from './public-configuration.ts';
import { readPublicData } from './read-state.ts';
import {
  benchmarkDomainConfig,
  seedLeaderboard,
  seedMethodology,
  seedRadarNodes,
  seedRuns,
  seedTrendPoints,
} from './seed.ts';
import { TREND_SERIES_STYLES } from './trend-styles.ts';
import { classifyDataProvenance } from './provenance.ts';
import {
  CALIBRATION_OUTCOMES,
  isScoredLeaderboardEntry,
  type PublicCalibrationResult,
  type PublicCalibrationRunSummary,
  type RadarNode,
} from './types.ts';

function distributedRadarRowFromNode(node: RadarNode): DistributedRadarRow {
  return {
    node_id: node.id,
    name: node.name,
    operator: node.operator,
    public_key_fingerprint: node.publicKeyFingerprint,
    registry_trust: node.registryTrust,
    registry_status: node.registryStatus,
    last_seen_at: node.registryLastSeenAt,
    synthetic: node.synthetic,
    latest_capability_schema_version: node.latestCapability?.schemaVersion ?? null,
    latest_capability_hash: node.latestCapability?.contentHash ?? null,
    latest_capability_status: node.latestCapability?.status ?? null,
    latest_capability_signature_status: node.latestCapability?.signatureStatus ?? null,
    latest_capability_observed_at: node.latestCapability?.observedAt ?? null,
    latest_observation_schema_version: node.latestObservation?.schemaVersion ?? null,
    latest_observation_state: node.latestObservation?.state ?? null,
    latest_observation_sequence: node.latestObservation?.sequence ?? null,
    latest_observation_hash: node.latestObservation?.contentHash ?? null,
    latest_observation_status: node.latestObservation?.recordStatus ?? null,
    latest_observation_signature_status: node.latestObservation?.signatureStatus ?? null,
    latest_observation_observed_at: node.latestObservation?.observedAt ?? null,
    latest_observation_provenance_hash: node.latestObservation?.provenanceHash ?? null,
    assignment_total_count: node.assignmentCounts.total,
    assignment_offered_count: node.assignmentCounts.offered,
    assignment_accepted_count: node.assignmentCounts.accepted,
    assignment_running_count: node.assignmentCounts.running,
    assignment_completed_count: node.assignmentCounts.completed,
    assignment_revoked_count: node.assignmentCounts.revoked,
    assignment_expired_count: node.assignmentCounts.expired,
    receipt_total_count: node.receiptCounts.total,
    receipt_received_count: node.receiptCounts.received,
    receipt_accepted_count: node.receiptCounts.accepted,
    receipt_rejected_count: node.receiptCounts.rejected,
    receiver_verified_trusted_count: node.aggregation.receiverVerifiedTrusted,
    signed_untrusted_count: node.aggregation.signedUntrusted,
    rejected_count: node.aggregation.rejected,
    missing_count: node.aggregation.missing,
    aggregated_at: node.aggregation.aggregatedAt,
  };
}

function canonicalRunId(seed: string): string {
  return `run_${createHash('sha256').update(seed).digest('hex')}`;
}

const officialLeaderboardRowEvidence = {
  theta: 0.4,
  standard_error: 0.2,
  theta_ci_low: 0.01,
  theta_ci_high: 0.79,
  score_ci_low: 50,
  score_ci_high: 100,
  information: 24,
  quality_score: 70,
  strict_pass_rate: 0.5,
  strict_pass_low: 0.39,
  strict_pass_high: 0.61,
  strict_pass_sample_size: 72,
  strict_pass_successes: 36,
  reliability_status: 'single_matrix_information_only' as const,
  calibration_status: 'calibrated' as const,
};

const unscoredLeaderboardRowEvidence = {
  theta: null,
  standard_error: null,
  theta_ci_low: null,
  theta_ci_high: null,
  score_ci_low: null,
  score_ci_high: null,
  information: null,
  quality_score: null,
  strict_pass_rate: null,
  strict_pass_low: null,
  strict_pass_high: null,
  strict_pass_sample_size: null,
  strict_pass_successes: null,
  reliability_status: null,
  calibration_status: 'pending' as const,
};

const officialTrendRowEvidence = {
  theta: 0.4,
  standard_error: 0.2,
  theta_ci_low: 0.01,
  theta_ci_high: 0.79,
  score_ci_low: 50,
  score_ci_high: 80,
  information: 24,
  quality_score: 70,
  strict_pass_rate: 0.5,
  strict_pass_low: 0.39,
  strict_pass_high: 0.61,
  strict_pass_sample_size: 72,
  strict_pass_successes: 36,
  reliability_status: 'single_matrix_information_only' as const,
  calibration_status: 'calibrated' as const,
};

function trendRow(matrixId: string, recordedAt: string): TrendRow {
  return {
    matrix_id: matrixId,
    run_id: canonicalRunId(`${matrixId}:${recordedAt}`),
    scoring_version: '1.0.6',
    recorded_at: recordedAt,
    bucket_started_at: recordedAt,
    bucket_ended_at: new Date(Date.parse(recordedAt) + 1).toISOString(),
    score: 70,
    ...officialTrendRowEvidence,
    sensitivity_low: 68,
    sensitivity_high: 72,
    sample_size: 72,
    represented_run_count: 1,
    resolution_seconds: 1,
    synthetic: false,
  };
}

function calibrationScoreRepository(row: unknown): SupabaseAiqRepository {
  return new SupabaseAiqRepository(
    'https://example.supabase.co',
    'sb_publishable_public_example',
    async () => Response.json([row]),
  );
}

function modelEfficiencyRepository(rows: readonly unknown[]): SupabaseAiqRepository {
  return new SupabaseAiqRepository(
    'https://example.supabase.co',
    'sb_publishable_public_example',
    async () => Response.json(rows),
  );
}

function runSummaryRow(index = 0): RunRow {
  return {
    id: `run_${index.toString(16).padStart(64, '0')}`,
    matrix_id: 'sol-low',
    started_at: '2026-08-04T12:00:00.000Z',
    completed_at: '2026-08-04T12:30:00.000Z',
    benchmark_version: 'aiq-core@1.0.6',
    scoring_version: '1.0.6',
    prompt_set_digest: `sha256:${'1'.repeat(64)}`,
    runner_commit: 'abcdef0',
    region: 'us-east-1',
    synthetic: false,
    corpus_release_id: null,
    corpus_commitment_sha256: null,
    catalog_digest: null,
    task_set_digest: null,
    preflight_digest: null,
    runtime_digest: null,
    run_class: null,
    permission_evidence_digest: null,
    result_count: 72,
    correct_count: 20,
    partial_count: 10,
    incorrect_count: 40,
    runtime_issue_count: 2,
    invalid_count: 0,
    missing_count: 0,
    not_applicable_count: 0,
    completed_count: 70,
    observed_count: 70,
    coverage_percent: 97.2,
    covered_domain_count: 10,
    provisional_domain_count: 10,
  };
}

function runSummaryRepository(response: () => Response): SupabaseAiqRepository {
  return new SupabaseAiqRepository(
    'https://example.supabase.co',
    'sb_publishable_public_example',
    async () => response(),
  );
}

function runResultRow(runId: string, index = 1): RunResultRow {
  return {
    run_id: runId,
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    task_id: `coding-${String(index).padStart(2, '0')}`,
    task: `Task ${index}`,
    domain: 'coding',
    outcome: 'correct',
    execution_status: 'completed',
    score: 1,
    explanation_code: null,
    explanation_summary: null,
    retryable: null,
    tools: [],
    latency_ms: 1,
    latency_evidence_level: 'runner_observed',
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    total_tokens: null,
    token_usage_source_level: null,
    token_usage_evidence_level: null,
    standard_api_equivalent_usd_nanos: null,
    cost_estimator_status: 'unavailable_missing_usage',
    cost_evidence_level: null,
    pricing_digest: 'sha256:e1a28656f2918a14e86997b06bf9e29ec4db084ff89ee0319aafa0c05cc1f31d',
  };
}

function singleResultRunRow(index = 1): RunRow {
  return {
    ...runSummaryRow(index),
    result_count: 1,
    correct_count: 1,
    partial_count: 0,
    incorrect_count: 0,
    runtime_issue_count: 0,
    invalid_count: 0,
    missing_count: 0,
    not_applicable_count: 0,
    completed_count: 1,
    observed_count: 1,
    coverage_percent: 100,
    covered_domain_count: 1,
    provisional_domain_count: 0,
  };
}

function runDetailRepository(
  runResponse: readonly unknown[],
  resultResponse: readonly unknown[],
): SupabaseAiqRepository {
  return new SupabaseAiqRepository(
    'https://example.supabase.co',
    'sb_publishable_public_example',
    async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return Response.json(
        url.pathname.endsWith(`/${PUBLIC_VIEW_NAMES.runResults}`) ? resultResponse : runResponse,
      );
    },
  );
}

void describe('seed repository', () => {
  void it('provides the complete 6/6/5 model and reasoning matrix', () => {
    assert.equal(seedLeaderboard.length, 17);
    assert.deepEqual(
      Object.fromEntries(
        ['Sol', 'Terra', 'Luna'].map((family) => [
          family,
          seedLeaderboard.filter((entry) => entry.modelFamily === family).length,
        ]),
      ),
      { Sol: 6, Terra: 6, Luna: 5 },
    );
    const tiersByFamily = Object.fromEntries(
      ['Sol', 'Terra', 'Luna'].map((family) => [
        family,
        seedLeaderboard
          .filter((entry) => entry.modelFamily === family)
          .map((entry) => entry.reasoningTier)
          .toSorted(),
      ]),
    );
    assert.deepEqual(tiersByFamily, {
      Sol: ['high', 'low', 'max', 'medium', 'ultra', 'xhigh'],
      Terra: ['high', 'low', 'max', 'medium', 'ultra', 'xhigh'],
      Luna: ['high', 'low', 'max', 'medium', 'xhigh'],
    });
    assert.ok(
      seedLeaderboard.every(
        (entry) =>
          entry.synthetic &&
          entry.modelName === `gpt-5.6-${entry.modelFamily.toLowerCase()}` &&
          entry.sampleSize === 72 &&
          entry.coveragePercent === 100 &&
          entry.missing === 0 &&
          entry.scoringVersion === '1.0.6',
      ),
    );
  });

  void it('uses seed data unless a complete valid public Supabase pair exists', () => {
    assert.ok(createAiqRepository({ NODE_ENV: 'development' }) instanceof SeedAiqRepository);
    assert.equal(
      createAiqRepository({
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      }).configuration,
      'invalid',
    );
    assert.equal(classifyPublicDataConfiguration({ NODE_ENV: 'development' }), 'seed');
    assert.equal(classifyPublicDataConfiguration({ NODE_ENV: 'test' }), 'seed');
    assert.equal(classifyPublicDataConfiguration({ NODE_ENV: 'production' }), 'invalid');
    assert.equal(classifyPublicDataConfiguration({}), 'invalid');
    assert.equal(
      classifyPublicDataConfiguration({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'only-one' }),
      'invalid',
    );
    assert.equal(
      classifyPublicDataConfiguration({
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      }),
      'live',
    );
    assert.deepEqual(Object.values(PUBLIC_VIEW_NAMES), [
      'public_model_matrix',
      'public_leaderboard',
      'public_runs',
      'public_run_results',
      'public_nodes',
      'public_distributed_radar',
      'public_scoring_versions',
      'public_task_coverage',
      'public_calibration_runs',
      'public_calibration_results',
      'public_calibration_scores',
      'public_model_efficiency',
    ]);
  });

  void it('preserves a precise sanitized diagnostic for partial public configuration', async () => {
    const repository = createAiqRepository({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
    });
    assert.equal(repository.configuration, 'invalid');
    await assert.rejects(repository.listLeaderboard(), /NEXT_PUBLIC_SUPABASE_URL is missing/);
  });

  void it('rejects malformed origins and non-public keys at the browser boundary', async () => {
    const invalidEnvironments = [
      {
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'http://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: 'https://user:password@example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co/path',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co?query=value',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co#fragment',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: 'https://EXAMPLE.supabase.co/',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: 'example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'not-a-public-key',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_service_example',
      },
      {
        NEXT_PUBLIC_SUPABASE_URL: ' https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
    ];

    for (const environment of invalidEnvironments) {
      assert.equal(inspectPublicSupabaseConfiguration(environment).state, 'invalid');
      assert.equal(createAiqRepository(environment).configuration, 'invalid');
    }

    const malformed = createAiqRepository({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co/path?query=value',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_service_example',
    });
    await assert.rejects(
      malformed.listLeaderboard(),
      /origin without credentials, a path, a query, or a fragment.*invalid publishable-key shape/,
    );
  });

  void it('allows canonical HTTPS and explicit development or test loopback origins', () => {
    const liveEnvironments = [
      {
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      },
      ...['development', 'test'].map((NODE_ENV) => ({
        NODE_ENV,
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      })),
    ];
    for (const environment of liveEnvironments) {
      assert.equal(inspectPublicSupabaseConfiguration(environment).state, 'live');
      assert.equal(classifyPublicDataConfiguration(environment), 'live');
    }
    assert.equal(
      classifyPublicDataConfiguration({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
      }),
      'invalid',
    );
  });

  void it('joins a partial live leaderboard onto every fixed matrix identity', () => {
    const matrix: readonly ModelMatrixRow[] = seedLeaderboard.map((entry) => ({
      id: entry.id,
      model_family: entry.modelFamily,
      model_name: entry.modelName,
      reasoning_tier: entry.reasoningTier,
    }));
    const official = seedLeaderboard[0];
    const notApplicable = seedLeaderboard[1];
    const missing = seedLeaderboard[2];
    assert.ok(official);
    assert.ok(notApplicable);
    assert.ok(missing);
    const rows: readonly LeaderboardRow[] = [
      {
        matrix_id: official.id,
        run_id: canonicalRunId(official.id),
        ...officialLeaderboardRowEvidence,
        quality_score: official.qualityScore,
        score: official.score,
        sensitivity_low: official.sensitivityLow,
        sensitivity_high: official.sensitivityHigh,
        sample_size: official.sampleSize,
        coverage_percent: official.coveragePercent,
        runtime_issues: official.runtimeIssues,
        missing: official.missing,
        scoring_version: official.scoringVersion,
        score_status: 'official',
        synthetic: false,
      },
      {
        matrix_id: notApplicable.id,
        run_id: canonicalRunId(notApplicable.id),
        ...unscoredLeaderboardRowEvidence,
        score: null,
        sensitivity_low: null,
        sensitivity_high: null,
        sample_size: null,
        coverage_percent: null,
        runtime_issues: null,
        missing: null,
        scoring_version: '1.0.6',
        score_status: 'not_applicable',
        synthetic: false,
      },
      {
        matrix_id: missing.id,
        run_id: canonicalRunId(missing.id),
        ...unscoredLeaderboardRowEvidence,
        score: null,
        sensitivity_low: null,
        sensitivity_high: null,
        sample_size: null,
        coverage_percent: null,
        runtime_issues: null,
        missing: null,
        scoring_version: '1.0.6',
        score_status: 'missing',
        synthetic: false,
      },
    ];

    const joined = joinModelMatrixWithLeaderboard(matrix, rows);
    assert.equal(joined.length, 17);
    assert.deepEqual(
      joined.map((entry) => entry.id),
      CANONICAL_MODEL_MATRIX_IDS,
    );
    assert.equal(joined.find((entry) => entry.id === official.id)?.score, official.score);
    const joinedOfficial = joined.find((entry) => entry.id === official.id);
    assert.ok(joinedOfficial);
    assert.equal(leaderboardRunHref(joinedOfficial), `/runs/${canonicalRunId(official.id)}`);
    assert.equal(
      joined.find((entry) => entry.id === notApplicable.id)?.scoreStatus,
      'not_applicable',
    );
    const joinedNotApplicable = joined.find((entry) => entry.id === notApplicable.id);
    const joinedMissing = joined.find((entry) => entry.id === missing.id);
    assert.ok(joinedNotApplicable);
    assert.ok(joinedMissing);
    assert.deepEqual(
      {
        score: joinedNotApplicable.score,
        sampleSize: joinedNotApplicable.sampleSize,
        scoringVersion: joinedNotApplicable.scoringVersion,
        runId: joinedNotApplicable.runId,
        synthetic: joinedNotApplicable.synthetic,
      },
      { score: null, sampleSize: null, scoringVersion: null, runId: null, synthetic: null },
    );
    assert.equal(joinedMissing.scoreStatus, 'missing');
    assert.deepEqual(
      {
        score: joinedMissing.score,
        sampleSize: joinedMissing.sampleSize,
        scoringVersion: joinedMissing.scoringVersion,
        runId: joinedMissing.runId,
        synthetic: joinedMissing.synthetic,
      },
      { score: null, sampleSize: null, scoringVersion: null, runId: null, synthetic: null },
    );
    const unpublished = joined.find(
      (entry) =>
        entry.id !== official.id && entry.id !== notApplicable.id && entry.id !== missing.id,
    );
    assert.equal(unpublished?.scoreStatus, 'unpublished');
    assert.equal(unpublished?.score, null);
    assert.equal(unpublished?.runId, null);
    assert.equal(unpublished?.synthetic, null);
    assert.ok(unpublished);
    assert.equal(leaderboardRunHref(unpublished), null);
  });

  void it('fails closed for null, empty, and future live leaderboard statuses', () => {
    const matrix: readonly ModelMatrixRow[] = seedLeaderboard.map((entry) => ({
      id: entry.id,
      model_family: entry.modelFamily,
      model_name: entry.modelName,
      reasoning_tier: entry.reasoningTier,
    }));
    const baseRow: LeaderboardRow = {
      matrix_id: 'sol-low',
      run_id: 'run_untrusted_status',
      ...officialLeaderboardRowEvidence,
      score: 99,
      sensitivity_low: 98,
      sensitivity_high: 100,
      sample_size: 72,
      coverage_percent: 100,
      runtime_issues: 0,
      missing: 0,
      scoring_version: '1.0.6',
      score_status: null,
      synthetic: false,
    };

    for (const scoreStatus of [null, '', 'provisional', 'official_v2']) {
      assert.throws(
        () =>
          joinModelMatrixWithLeaderboard(matrix, [
            Object.assign({}, baseRow, { score_status: scoreStatus }),
          ]),
        /public_leaderboard/,
      );
    }
    assert.throws(
      () =>
        joinModelMatrixWithLeaderboard(matrix, [
          Object.assign({}, baseRow, { scoring_version: '1.0.5' }),
        ]),
      /public_leaderboard/,
    );

    const unscoredRow = {
      ...baseRow,
      ...unscoredLeaderboardRowEvidence,
      score: null,
      sensitivity_low: null,
      sensitivity_high: null,
      sample_size: null,
      coverage_percent: null,
      runtimeIssues: null,
      missing: null,
    };
    for (const syntheticRow of [
      { ...baseRow, score_status: 'official', synthetic: true },
      { ...unscoredRow, score_status: 'not_applicable', synthetic: true },
      { ...unscoredRow, score_status: 'missing', synthetic: true },
    ]) {
      assert.throws(
        () => joinModelMatrixWithLeaderboard(matrix, [syntheticRow]),
        /public_leaderboard/,
      );
    }
  });

  void it('orders unordered live matrix rows canonically and rejects matrix drift', () => {
    const canonicalMatrix: readonly ModelMatrixRow[] = seedLeaderboard.map((entry) => ({
      id: entry.id,
      model_family: entry.modelFamily,
      model_name: entry.modelName,
      reasoning_tier: entry.reasoningTier,
    }));
    assert.deepEqual(
      joinModelMatrixWithLeaderboard(canonicalMatrix.toReversed(), []).map((entry) => entry.id),
      CANONICAL_MODEL_MATRIX_IDS,
    );

    const missing = canonicalMatrix.slice(1);
    const first = canonicalMatrix[0];
    assert.ok(first);
    const duplicate = [...canonicalMatrix.slice(0, -1), first];
    const unknown = canonicalMatrix.map((row, index) =>
      index === 0 ? { ...row, id: 'future-low' } : row,
    );
    const malformed = canonicalMatrix.map((row, index) =>
      index === 0 ? Object.assign({}, row, { model_name: 'gpt-5.6-terra' }) : row,
    );
    for (const matrix of [missing, duplicate, unknown, malformed]) {
      assert.throws(() => joinModelMatrixWithLeaderboard(matrix, []), /public_model_matrix/);
    }
  });

  void it('rejects unknown, duplicate, and malformed live leaderboard rows', () => {
    const matrix: readonly ModelMatrixRow[] = seedLeaderboard.map((entry) => ({
      id: entry.id,
      model_family: entry.modelFamily,
      model_name: entry.modelName,
      reasoning_tier: entry.reasoningTier,
    }));
    const row: LeaderboardRow = {
      matrix_id: 'sol-low',
      run_id: canonicalRunId('sol-low'),
      ...officialLeaderboardRowEvidence,
      score: 70,
      sensitivity_low: 68,
      sensitivity_high: 72,
      sample_size: 72,
      coverage_percent: 100,
      runtime_issues: 1,
      missing: 0,
      scoring_version: '1.0.6',
      score_status: 'official',
      synthetic: false,
    };
    const separatedScales = joinModelMatrixWithLeaderboard(matrix, [
      { ...row, score: 90, score_ci_low: 80, score_ci_high: 100 },
    ])[0];
    assert.equal(separatedScales?.score, 90);
    assert.equal(separatedScales?.qualityScore, 70);
    assert.equal(separatedScales?.sensitivityLow, 68);
    assert.equal(separatedScales?.sensitivityHigh, 72);
    for (const rows of [
      [row, row],
      [{ ...row, matrix_id: 'future-low' }],
      [{ ...row, sample_size: Number.NaN }],
      [{ ...row, sample_size: 71 }],
      [{ ...row, coverage_percent: 99.9 }],
      [{ ...row, missing: 1 }],
      [{ ...row, run_id: 'run-short' }],
    ]) {
      assert.throws(() => joinModelMatrixWithLeaderboard(matrix, rows), /public_leaderboard/);
    }
  });
});

void describe('presentation aggregates', () => {
  void it('orders scores descriptively and formats task-resampling sensitivity bounds', () => {
    const ordered = sortLeaderboardByPointEstimate(seedLeaderboard);
    assert.ok((ordered[0]?.score ?? 0) >= (ordered.at(-1)?.score ?? 100));
    assert.ok(ordered.every((entry) => !('rank' in entry)));
    assert.equal(
      formatSensitivityInterval({ sensitivityLow: 78.15, sensitivityHigh: 82.94 }),
      '78.2–82.9',
    );
  });

  void it('keeps scored status, provenance, and presentation consistent', () => {
    const syntheticEntry = seedLeaderboard[0];
    assert.ok(syntheticEntry);
    assert.equal(isScoredLeaderboardEntry(syntheticEntry), true);
    assert.equal(isScoredLeaderboardEntry({ ...syntheticEntry, scoreStatus: 'official' }), false);
    assert.equal(isScoredLeaderboardEntry({ ...syntheticEntry, synthetic: false }), false);
    assert.deepEqual(
      {
        status: presentLeaderboardEntry(syntheticEntry).status,
        evidence: presentLeaderboardEntry(syntheticEntry).evidence,
      },
      { status: 'Complete synthetic fixture · not Official', evidence: 'Synthetic' },
    );
    assert.deepEqual(presentScoreMetric(syntheticEntry), {
      official: false,
      score: syntheticEntry.qualityScore,
      scoreText: syntheticEntry.qualityScore?.toFixed(1),
      scoreLabel: 'Quality score',
      intervalLow: syntheticEntry.sensitivityLow,
      intervalHigh: syntheticEntry.sensitivityHigh,
      interval: formatSensitivityInterval(syntheticEntry),
      intervalLabel: 'Task-mix sensitivity',
    });

    const officialEntry = {
      ...syntheticEntry,
      scoreStatus: 'official' as const,
      synthetic: false as const,
      theta: 0.4,
      standardError: 0.2,
      thetaCiLow: 0.01,
      thetaCiHigh: 0.79,
      scoreCiLow: 70,
      scoreCiHigh: 90,
      information: 24,
      reliabilityStatus: 'single_matrix_information_only' as const,
      calibrationStatus: 'calibrated' as const,
    };
    assert.equal(isScoredLeaderboardEntry(officialEntry), true);
    assert.equal(presentLeaderboardEntry(officialEntry).runtimeIssues, officialEntry.runtimeIssues);
    assert.deepEqual(presentScoreMetric(officialEntry), {
      official: true,
      score: officialEntry.score,
      scoreText: officialEntry.score.toFixed(1),
      scoreLabel: 'Calibrated ability',
      intervalLow: officialEntry.scoreCiLow,
      intervalHigh: officialEntry.scoreCiHigh,
      interval: '70.0–90.0',
      intervalLabel: 'Conditional 95% interval',
    });
    assert.deepEqual(
      {
        status: presentLeaderboardEntry(officialEntry).status,
        evidence: presentLeaderboardEntry(officialEntry).evidence,
      },
      { status: 'Official · 72/72', evidence: 'Published' },
    );
  });

  void it('orders and summarizes divergent synthetic values on the presented quality scale', () => {
    const first = seedLeaderboard[0];
    const second = seedLeaderboard[1];
    assert.ok(first);
    assert.ok(second);
    const higherRawScore = {
      ...first,
      score: 95,
      qualityScore: 20,
      sensitivityLow: 10,
      sensitivityHigh: 30,
    };
    const higherPresentedQuality = {
      ...second,
      score: 5,
      qualityScore: 80,
      sensitivityLow: 70,
      sensitivityHigh: 90,
    };

    assert.deepEqual(sortByPresentedScore([higherRawScore, higherPresentedQuality]), [
      higherPresentedQuality,
      higherRawScore,
    ]);
    assert.deepEqual(presentedScoreRange([higherRawScore, higherPresentedQuality]), {
      minimum: 20,
      maximum: 80,
    });
  });

  void it('provides complete synthetic runs and a structured coverage-only run', () => {
    const firstRun = seedRuns[0];
    const coverageOnlyRun = seedRuns.find((run) => run.id.includes('coverage-only'));
    assert.ok(firstRun);
    assert.ok(coverageOnlyRun);
    assert.equal(firstRun.tasks.length, 72);
    assert.equal(firstRun.benchmarkVersion, 'aiq-core@1.0.6');
    assert.equal(seedMethodology.benchmarkVersion, 'aiq-core@1.0.6');
    for (const run of seedRuns.filter(
      (candidate) =>
        candidate.synthetic &&
        candidate.tasks.length === 72 &&
        !candidate.id.includes('coverage-only'),
    )) {
      const entry = seedLeaderboard.find((candidate) => candidate.runId === run.id);
      assert.ok(entry, `synthetic run ${run.id} must have a leaderboard entry`);
      const validTasks = run.tasks.filter((task) => task.score !== null);
      const strictPasses = validTasks.filter((task) => task.score === 1).length;
      assert.equal(validTasks.length, entry.strictPassSampleSize);
      assert.equal(strictPasses, entry.strictPassSuccesses);
      assert.equal(entry.strictPassRate, strictPasses / validTasks.length);
    }
    assert.ok(
      seedRuns
        .flatMap((run) => run.tasks)
        .every(
          (task) =>
            task.latencyMs === null &&
            task.latencyEvidenceLevel === null &&
            task.inputTokens === null &&
            task.cachedInputTokens === null &&
            task.cacheWriteInputTokens === null &&
            task.outputTokens === null &&
            task.reasoningOutputTokens === null &&
            task.totalTokens === null &&
            task.tokenUsageSourceLevel === null &&
            task.tokenUsageEvidenceLevel === null &&
            task.standardApiEquivalentUsdNanos === null &&
            task.costEvidenceLevel === null,
        ),
      'synthetic task fixtures must not claim retained invocation efficiency evidence',
    );
    assert.deepEqual(
      Object.fromEntries(
        benchmarkDomainConfig.map((domain) => [
          domain.domain,
          firstRun.tasks.filter((task) => task.domain === domain.domain).length,
        ]),
      ),
      Object.fromEntries(benchmarkDomainConfig.map((domain) => [domain.domain, domain.taskCount])),
    );
    assert.deepEqual(
      {
        correct: summarizeRun(coverageOnlyRun).correct,
        partial: summarizeRun(coverageOnlyRun).partial,
        incorrect: summarizeRun(coverageOnlyRun).incorrect,
        runtimeIssues: summarizeRun(coverageOnlyRun).runtimeIssues,
        invalid: summarizeRun(coverageOnlyRun).invalid,
        missing: summarizeRun(coverageOnlyRun).missing,
        notApplicable: summarizeRun(coverageOnlyRun).notApplicable,
      },
      {
        correct: 0,
        partial: 56,
        incorrect: 0,
        runtimeIssues: 2,
        invalid: 0,
        missing: 14,
        notApplicable: 0,
      },
    );
    assert.ok(
      coverageOnlyRun.tasks
        .filter((task) => task.executionStatus !== 'completed')
        .every((task) => task.explanation !== null),
    );
    assert.deepEqual(classifyRunCompleteness(firstRun), {
      label: 'Complete synthetic fixture · not Official',
      validResults: 72,
      notApplicable: false,
    });
    assert.equal(classifyRunCompleteness({ ...firstRun, synthetic: false }).label, 'Official');
    assert.deepEqual(classifyRunCompleteness(coverageOnlyRun), {
      label: 'Coverage-only · not ranked',
      validResults: 56,
      notApplicable: false,
    });
    const domainSummary = summarizeRunDomains(coverageOnlyRun);
    assert.equal(domainSummary.length, 10);
    assert.equal(
      domainSummary.reduce((sum, domain) => sum + domain.total, 0),
      72,
    );
    assert.equal(
      domainSummary.reduce((sum, domain) => sum + domain.missing, 0),
      14,
    );
    assert.ok(domainSummary.every((domain) => domain.coveragePercent < 100));
    const notApplicableRun = {
      ...firstRun,
      tasks: firstRun.tasks.map((task) =>
        Object.assign({}, task, {
          outcome: 'not_applicable' as const,
          executionStatus: 'not_applicable' as const,
          score: null,
        }),
      ),
    };
    assert.deepEqual(classifyRunCompleteness(notApplicableRun), {
      label: 'N/A · unsupported in a valid preflight',
      validResults: 0,
      notApplicable: true,
    });
  });

  void it('keeps partial credit, incorrect work, execution failures, and unscored cells distinct', () => {
    const source = seedRuns[0];
    assert.ok(source);
    const template = source.tasks[0];
    assert.ok(template);
    const run = {
      ...source,
      tasks: [
        {
          ...template,
          outcome: 'correct' as const,
          executionStatus: 'completed' as const,
          score: 1,
          explanation: null,
        },
        {
          ...template,
          outcome: 'partial' as const,
          executionStatus: 'completed' as const,
          score: 0.5,
          explanation: null,
        },
        {
          ...template,
          outcome: 'incorrect' as const,
          executionStatus: 'completed' as const,
          score: 0,
          explanation: null,
        },
        {
          ...template,
          outcome: 'timeout' as const,
          executionStatus: 'runtime_issue' as const,
          score: null,
          explanation: { code: 'timeout', summary: 'Timed out', retryable: true },
        },
        {
          ...template,
          outcome: 'missing' as const,
          executionStatus: 'missing' as const,
          score: null,
          explanation: null,
        },
        {
          ...template,
          outcome: 'invalid' as const,
          executionStatus: 'invalid' as const,
          score: null,
          explanation: null,
        },
        {
          ...template,
          outcome: 'not_applicable' as const,
          executionStatus: 'not_applicable' as const,
          score: null,
          explanation: null,
        },
      ],
    };
    assert.deepEqual(summarizeRunOutcomes(run), {
      correct: 1,
      partial: 1,
      incorrect: 1,
      runtimeIssues: 1,
      invalid: 1,
      missing: 1,
      notApplicable: 1,
      anyCredit: 2,
      completedOutcomes: 3,
      total: 7,
      anyCreditRate: (2 / 3) * 100,
    });
    const [domain] = summarizeRunDomains(run);
    assert.ok(domain);
    assert.equal(domain.score, 50);
    assert.equal(domain.completed, 3);
    assert.equal(domain.runtimeIssues, 1);
    assert.equal(domain.coveragePercent, (3 / 7) * 100);
    assert.deepEqual(classifyRunCompleteness(run), {
      label: 'Coverage-only · not ranked',
      validResults: 3,
      notApplicable: false,
    });
  });

  void it('does not present an all-runtime run as all failed', () => {
    const source = seedRuns[0];
    assert.ok(source);
    const run = {
      ...source,
      tasks: source.tasks.map((task) =>
        Object.assign({}, task, {
          outcome: 'timeout' as const,
          executionStatus: 'runtime_issue' as const,
          score: null,
          explanation: { code: 'timeout', summary: 'Timed out', retryable: true },
        }),
      ),
    };
    const summary = summarizeRunOutcomes(run);
    assert.deepEqual(summary, {
      correct: 0,
      partial: 0,
      incorrect: 0,
      runtimeIssues: 72,
      invalid: 0,
      missing: 0,
      notApplicable: 0,
      anyCredit: 0,
      completedOutcomes: 0,
      total: 72,
      anyCreditRate: null,
    });
    assert.equal(formatAnyCreditRate(summary.anyCreditRate), '—');
    assert.deepEqual(classifyRunCompleteness(run), {
      label: 'Coverage-only · not ranked',
      validResults: 0,
      notApplicable: false,
    });
  });

  void it('keeps uniform incorrect, runtime, invalid, and missing matrices distinct', () => {
    const source = seedRuns[0];
    assert.ok(source);
    const cases = [
      {
        task: {
          outcome: 'incorrect' as const,
          executionStatus: 'completed' as const,
          score: 0,
          explanation: null,
        },
        expected: {
          incorrect: 72,
          runtimeIssues: 0,
          invalid: 0,
          missing: 0,
          completedOutcomes: 72,
          anyCreditRate: 0,
        },
      },
      {
        task: {
          outcome: 'timeout' as const,
          executionStatus: 'runtime_issue' as const,
          score: null,
          explanation: { code: 'timeout', summary: 'Timed out', retryable: true },
        },
        expected: {
          incorrect: 0,
          runtimeIssues: 72,
          invalid: 0,
          missing: 0,
          completedOutcomes: 0,
          anyCreditRate: null,
        },
      },
      {
        task: {
          outcome: 'invalid' as const,
          executionStatus: 'invalid' as const,
          score: null,
          explanation: null,
        },
        expected: {
          incorrect: 0,
          runtimeIssues: 0,
          invalid: 72,
          missing: 0,
          completedOutcomes: 0,
          anyCreditRate: null,
        },
      },
      {
        task: {
          outcome: 'missing' as const,
          executionStatus: 'missing' as const,
          score: null,
          explanation: null,
        },
        expected: {
          incorrect: 0,
          runtimeIssues: 0,
          invalid: 0,
          missing: 72,
          completedOutcomes: 0,
          anyCreditRate: null,
        },
      },
    ];

    for (const fixture of cases) {
      const summary = summarizeRunOutcomes({
        ...source,
        tasks: source.tasks.map((task) => Object.assign({}, task, fixture.task)),
      });
      assert.deepEqual(
        {
          incorrect: summary.incorrect,
          runtimeIssues: summary.runtimeIssues,
          invalid: summary.invalid,
          missing: summary.missing,
          completedOutcomes: summary.completedOutcomes,
          anyCreditRate: summary.anyCreditRate,
        },
        fixture.expected,
      );
    }
  });

  void it('keeps synthetic calibration invocation counts and efficiency evidence unavailable', async () => {
    const repository = new SeedAiqRepository();
    const page = await repository.listCalibrationRunPage();
    const seed = page.runs[0];
    assert.ok(seed);
    const detail = await repository.getCalibrationRun(seed.id, {
      modelFamily: 'sol',
      reasoningEffort: 'low',
    });
    assert.equal(detail?.results[0]?.taskVersion, '1.0.6');
    const scores = await repository.listCalibrationScores(seed.id);
    assert.deepEqual(
      scores.map((score) => ({
        attempted: score.attemptedResultCount,
        invoked: score.invokedResultCount,
        elapsed: score.adapterElapsedObservedResultCount,
        elapsedMs: score.observedTotalWallMs,
        durationEvidence: score.durationEvidenceLevel,
        tokenCount: score.tokenObservedResultCount,
        pricedCount: score.pricedResultCount,
      })),
      [
        {
          attempted: 0,
          invoked: 0,
          elapsed: 0,
          elapsedMs: null,
          durationEvidence: null,
          tokenCount: 0,
          pricedCount: 0,
        },
      ],
    );
  });

  void it('keeps leaderboard scores consistent with equal-weight fixed-domain means', () => {
    for (const entry of seedLeaderboard) {
      const run = seedRuns.find(
        (candidate) => candidate.entryId === entry.id && !candidate.id.includes('coverage-only'),
      );
      assert.ok(run);
      const domainMeans = benchmarkDomainConfig.map((domain) => {
        const scores = run.tasks
          .filter((task) => task.domain === domain.domain)
          .map((task) => task.score ?? 0);
        return scores.reduce((sum, score) => sum + score, 0) / domain.taskCount;
      });
      const score = (domainMeans.reduce((sum, mean) => sum + mean, 0) / 10) * 100;
      assert.ok(Math.abs(score - entry.score) < 0.02);
      assert.equal(
        run.tasks.filter((task) => task.executionStatus === 'runtime_issue').length,
        entry.runtimeIssues,
      );
    }
  });

  void it('states the conditional Provisional estimand and planned completion bounds', () => {
    assert.match(seedMethodology.missingPolicy, /complete synthetic fixture.*never Official/);
    assert.match(seedMethodology.missingPolicy, /averages valid observed tasks within each domain/);
    assert.match(seedMethodology.missingPolicy, /retain every planned task/);
    assert.match(seedMethodology.missingPolicy, /assign unobserved tasks zero or one/);
    assert.match(seedMethodology.missingPolicy, /at least 60 results/);
    assert.match(seedMethodology.missingPolicy, /at least 4 in every domain/);
    assert.doesNotMatch(seedMethodology.missingPolicy, /never shrink a denominator/i);
  });

  void it('preserves all history and filters shorter windows from a supplied clock', () => {
    const now = new Date('2026-07-24T00:00:00.000Z');
    assert.equal(filterTrendPoints(seedTrendPoints, 'all', now).length, seedTrendPoints.length);
    assert.ok(
      filterTrendPoints(seedTrendPoints, 'month', now).length <
        filterTrendPoints(seedTrendPoints, 'all', now).length,
    );
  });

  void it('does not attach changing synthetic trend fixtures to unrelated run details', () => {
    assert.ok(seedTrendPoints.length > 0);
    assert.ok(seedTrendPoints.every((point) => point.runId === null && point.synthetic));
    assert.equal(
      new Set(seedTrendPoints.map((point) => `${point.entryId}:${point.recordedAt}`)).size,
      seedTrendPoints.length,
    );
    assert.ok(
      seedTrendPoints.every(
        (point) =>
          point.bucketStartedAt === point.recordedAt &&
          new Date(point.bucketEndedAt).getTime() > new Date(point.recordedAt).getTime() &&
          point.representedRunCount === 1,
      ),
    );
  });

  void it('uses one bounded trend RPC and preserves representation metadata', async () => {
    const requests: Request[] = [];
    const row: TrendRow = {
      matrix_id: 'sol-ultra',
      run_id: canonicalRunId('latest-in-bucket'),
      scoring_version: '1.0.6',
      recorded_at: '2026-07-24T00:00:00.000Z',
      bucket_started_at: '2026-07-23T12:00:00.000Z',
      bucket_ended_at: '2026-07-24T00:00:00.001Z',
      score: 82.4,
      theta: 0.8,
      standard_error: 0.2,
      theta_ci_low: 0.41,
      theta_ci_high: 1.19,
      score_ci_low: 70,
      score_ci_high: 90,
      information: 24,
      quality_score: 82.4,
      strict_pass_rate: 0.5,
      strict_pass_low: 0.39,
      strict_pass_high: 0.61,
      strict_pass_sample_size: 72,
      strict_pass_successes: 36,
      reliability_status: 'single_matrix_information_only',
      calibration_status: 'calibrated',
      sensitivity_low: 80.1,
      sensitivity_high: 84.7,
      sample_size: 72,
      represented_run_count: 19,
      resolution_seconds: 43_200,
      synthetic: false,
    };
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request.clone());
        return Response.json([row]);
      },
    );
    assert.deepEqual(await repository.listTrendPoints('week'), [
      {
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
      },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]?.url ?? '').pathname, '/rest/v1/rpc/public_trend_points');
    assert.deepEqual(JSON.parse((await requests[0]?.text()) ?? '{}'), { supplied_range: 'week' });

    const oversized = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      async () => Response.json(Array.from({ length: TREND_MAX_POINTS + 1 }, () => row)),
    );
    await assert.rejects(oversized.listTrendPoints('all'), /response exceeded 340 rows/);
  });

  void it('orders live trend points by the canonical series and fails closed on drift', async () => {
    const unordered = [
      trendRow('luna-max', '2026-07-24T02:00:00.000Z'),
      trendRow('sol-low', '2026-07-24T02:00:00.000Z'),
      trendRow('sol-low', '2026-07-24T01:00:00.000Z'),
      trendRow('terra-medium', '2026-07-24T02:00:00.000Z'),
    ];
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      async () => Response.json(unordered),
    );
    assert.deepEqual(
      (await repository.listTrendPoints()).map(
        ({ entryId, recordedAt }) => `${entryId}:${recordedAt}`,
      ),
      [
        'sol-low:2026-07-24T01:00:00.000Z',
        'sol-low:2026-07-24T02:00:00.000Z',
        'terra-medium:2026-07-24T02:00:00.000Z',
        'luna-max:2026-07-24T02:00:00.000Z',
      ],
    );

    const invalidRows = [
      [unordered[0], unordered[0]],
      [trendRow('future-low', '2026-07-24T02:00:00.000Z')],
      [{ ...unordered[0], score: Number.NaN }],
      [{ ...unordered[0], scoring_version: '1.0.5' }],
      [{ ...unordered[0], sample_size: 71 }],
      [{ ...unordered[0], sensitivity_high: 101 }],
      [{ ...unordered[0], run_id: 'run-short' }],
    ];
    await Promise.all(
      invalidRows.map(async (rows) => {
        const invalid = new SupabaseAiqRepository(
          'https://example.supabase.co',
          'sb_publishable_public_example',
          async () => Response.json(rows),
        );
        await assert.rejects(invalid.listTrendPoints(), /public_trend_points/);
      }),
    );
  });

  void it('reads exact run summaries in bounded, deduplicated batches', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => runSummaryRow(index + 1));
    const requests: Request[] = [];
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request.clone());
        return Response.json(requests.length === 1 ? rows.slice(0, 50) : rows.slice(50));
      },
    );

    assert.deepEqual(await repository.listRunSummaries([]), []);
    assert.equal(requests.length, 0);
    const summaries = await repository.listRunSummaries([
      ...rows.map((row) => row.id),
      rows[0]?.id ?? '',
    ]);
    assert.equal(summaries.length, rows.length);
    assert.equal(requests.length, 2);
    assert.equal(new URL(requests[0]?.url ?? '').searchParams.get('limit'), '51');
    assert.equal(new URL(requests[1]?.url ?? '').searchParams.get('limit'), '2');
  });

  void it('rejects invalid and oversized run-summary selections without a request', async () => {
    let requests = 0;
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      async () => {
        requests += 1;
        return Response.json([]);
      },
    );
    await assert.rejects(repository.listRunSummaries(['x'.repeat(161)]), /invalid run selection/);
    await assert.rejects(
      repository.listRunSummaries(
        Array.from({ length: TREND_MAX_POINTS + 1 }, (_, index) => `run-${index}`),
      ),
      /invalid run selection/,
    );
    assert.equal(requests, 0);
  });

  void it('accepts coherent empty and partial run-summary coverage', async () => {
    const empty = {
      ...runSummaryRow(1),
      result_count: 0,
      correct_count: 0,
      partial_count: 0,
      incorrect_count: 0,
      runtime_issue_count: 0,
      completed_count: 0,
      observed_count: 0,
      coverage_percent: null,
      covered_domain_count: 0,
      provisional_domain_count: 0,
    };
    const partial = {
      ...runSummaryRow(2),
      result_count: 4,
      correct_count: 1,
      partial_count: 0,
      incorrect_count: 0,
      runtime_issue_count: 1,
      invalid_count: 1,
      missing_count: 1,
      completed_count: 1,
      observed_count: 1,
      coverage_percent: 25,
      covered_domain_count: 1,
      provisional_domain_count: 0,
    };
    const summaries = await runSummaryRepository(() =>
      Response.json([empty, partial]),
    ).listRunSummaries([empty.id, partial.id]);
    assert.deepEqual(
      summaries.map((run) => run.resultSummary.coveragePercent),
      [null, 25],
    );
  });

  void it('fails closed on run-summary transport, identity, and shape drift', async () => {
    const row = runSummaryRow(1);
    await assert.rejects(
      runSummaryRepository(() =>
        Response.json({ message: 'unavailable' }, { status: 503 }),
      ).listRunSummaries([row.id]),
      /public_runs/,
    );
    await assert.rejects(
      runSummaryRepository(() =>
        Response.json([{ ...row, id: runSummaryRow(2).id }]),
      ).listRunSummaries([row.id]),
      /invalid response shape/,
    );
    await assert.rejects(
      runSummaryRepository(() => Response.json([row, row])).listRunSummaries([row.id]),
      /invalid response shape|duplicate run identity/,
    );

    const malformedRows = [
      { ...row, matrix_id: 'future-low' },
      { ...row, synthetic: 'false' },
      { ...row, benchmark_version: 'aiq-core@1.0.5' },
      { ...row, scoring_version: '1.0.5' },
      { ...row, completed_at: 'not-a-timestamp' },
      { ...row, completed_at: '2026-08-04T11:59:59.999Z' },
      { ...row, run_class: 'official' },
      { ...row, unexpected: true },
      { ...row, result_count: '72' },
      { ...row, correct_count: -1, incorrect_count: 41 },
      { ...row, completed_count: 69 },
      { ...row, observed_count: 71 },
      { ...row, coverage_percent: 99.9 },
      { ...row, covered_domain_count: 11 },
      { ...row, provisional_domain_count: 11 },
      {
        ...row,
        correct_count: 1,
        partial_count: 0,
        incorrect_count: 0,
        runtime_issue_count: 0,
        missing_count: 71,
        completed_count: 1,
        observed_count: 1,
        coverage_percent: 1.4,
        covered_domain_count: 2,
        provisional_domain_count: 0,
      },
      {
        ...row,
        correct_count: 1,
        partial_count: 0,
        incorrect_count: 0,
        runtime_issue_count: 0,
        missing_count: 71,
        completed_count: 1,
        observed_count: 1,
        coverage_percent: 1.4,
        covered_domain_count: 1,
        provisional_domain_count: 1,
      },
    ];
    await Promise.all(
      malformedRows.map((malformed) =>
        assert.rejects(
          runSummaryRepository(() => Response.json([malformed])).listRunSummaries([row.id]),
          /invalid response shape/,
        ),
      ),
    );
  });

  void it('fails closed on malformed and duplicate run-page and newest-run transport', async () => {
    const row = runSummaryRow(1);
    await assert.rejects(
      runSummaryRepository(() => Response.json([{ ...row, unexpected: true }])).listRunPage(),
      /invalid response shape/,
    );
    await assert.rejects(
      runSummaryRepository(() => Response.json([row, row])).listRunPage(),
      /duplicate run identity/,
    );
    await assert.rejects(
      runSummaryRepository(() => Response.json([runSummaryRow(2), runSummaryRow(1)])).listRunPage(),
      /invalid response order/,
    );
    await assert.rejects(
      runSummaryRepository(() =>
        Response.json([{ ...row, completed_at: 'yesterday' }]),
      ).getNewestCompletedRun(),
      /invalid response shape/,
    );
    await assert.rejects(
      runSummaryRepository(() => Response.json([row, row])).getNewestCompletedRun(),
      /invalid response shape/,
    );
  });

  void it('validates complete run-detail transport and aggregate coherence', async () => {
    const row = singleResultRunRow(1);
    const result = runResultRow(row.id);
    const run = await runDetailRepository([row], [result]).getRun(row.id);
    assert.equal(run?.id, row.id);
    assert.deepEqual(
      run?.tasks.map((task) => task.id),
      [result.task_id],
    );

    await assert.rejects(
      runDetailRepository([row, row], []).getRun(row.id),
      /duplicate run identity/,
    );
    await assert.rejects(
      runDetailRepository([row], [result, result]).getRun(row.id),
      /duplicate result identity/,
    );
    await assert.rejects(
      runDetailRepository(
        [
          {
            ...row,
            result_count: 2,
            correct_count: 2,
            completed_count: 2,
            observed_count: 2,
          },
        ],
        [
          result,
          {
            ...result,
            id: '00000000-0000-4000-8000-000000000002',
          },
        ],
      ).getRun(row.id),
      /result summary does not match run/,
    );
    await assert.rejects(
      runDetailRepository([row], [{ ...result, run_id: runSummaryRow(2).id }]).getRun(row.id),
      /invalid response shape/,
    );
    await assert.rejects(
      runDetailRepository(
        [
          {
            ...row,
            result_count: 2,
            missing_count: 1,
            coverage_percent: 50,
          },
        ],
        [result],
      ).getRun(row.id),
      /result summary does not match run/,
    );
  });

  void it('rejects malformed public result token, cost, and evidence relationships', async () => {
    const row = singleResultRunRow(1);
    const result = runResultRow(row.id);
    const pricedResult: RunResultRow = {
      ...result,
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 1,
      total_tokens: 13,
      token_usage_source_level: 'provider_reported',
      token_usage_evidence_level: 'verifier_recomputed',
      standard_api_equivalent_usd_nanos: 132_250,
      cost_estimator_status: 'estimated',
      cost_evidence_level: 'verifier_recomputed',
    };
    assert.equal(
      (await runDetailRepository([row], [pricedResult]).getRun(row.id))?.tasks[0]
        ?.standardApiEquivalentUsdNanos,
      132_250,
    );
    const malformedResults = [
      { ...result, input_tokens: -1 },
      { ...result, unexpected: true },
      { ...result, task_id: 'debugging-01' },
      { ...result, task_id: 'coding-09' },
      { ...result, pricing_digest: `sha256:${'2'.repeat(64)}` },
      { ...result, input_tokens: 10, token_usage_source_level: null },
      {
        ...result,
        input_tokens: 10,
        cached_input_tokens: 8,
        cache_write_input_tokens: 3,
        output_tokens: 2,
        token_usage_source_level: 'provider_reported',
        token_usage_evidence_level: 'verifier_recomputed',
        cost_estimator_status: 'estimated',
        standard_api_equivalent_usd_nanos: 1,
        cost_evidence_level: 'verifier_recomputed',
      },
      { ...result, cost_estimator_status: 'estimated' },
      { ...result, execution_status: 'runtime_issue' },
      { ...result, score: 0 },
    ];
    await Promise.all(
      malformedResults.map((malformed) =>
        assert.rejects(
          runDetailRepository([row], [malformed]).getRun(row.id),
          /invalid response shape/,
        ),
      ),
    );
  });

  void it('returns a not-found result for a noncanonical public run without a request', async () => {
    let requestCount = 0;
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      async () => {
        requestCount += 1;
        return Response.json([]);
      },
    );

    assert.equal(await repository.getRun('unknown-live-run'), null);
    assert.equal(requestCount, 0);
  });

  void it('uses the same bounded pagination contract for run and task-result history', async () => {
    const rows = Array.from({ length: 2_105 }, (_, index) => ({
      id: `row-${String(index).padStart(4, '0')}`,
    }));
    const ranges: Array<[number, number]> = [];
    const paged = await collectPaginatedRows('public_run_results', async (first, last) => {
      ranges.push([first, last]);
      return { data: rows.slice(first, last + 1), error: null };
    });

    assert.equal(PUBLIC_READ_PAGE_SIZE, 1_000);
    assert.deepEqual(paged, rows);
    assert.deepEqual(ranges, [
      [0, PUBLIC_READ_PAGE_SIZE - 1],
      [PUBLIC_READ_PAGE_SIZE, PUBLIC_READ_PAGE_SIZE * 2 - 1],
      [PUBLIC_READ_PAGE_SIZE * 2, PUBLIC_READ_PAGE_SIZE * 3 - 1],
    ]);
  });

  void it('reads only one stable 72-task slice from a 1,224-cell calibration run', async () => {
    const runId = `run_${'c'.repeat(64)}`;
    const run = {
      run_id: runId,
      classification: 'local_calibration_non_official',
      scoring_version: '1.0.6',
      selected_task_count: 72,
      selected_model_count: 17,
      result_count: 1_224,
      started_at: '2026-08-02T12:00:00Z',
      completed_at: '2026-08-02T13:00:00Z',
      verified_at: '2026-08-02T13:01:00Z',
      published_at: '2026-08-02T13:02:00Z',
      replay_status: 'evaluator_replayed',
      official: false,
      ranking_eligible: false,
      pricing_currency: 'USD',
      pricing_processing_tier: 'standard',
    };
    const rows = CALIBRATION_MODEL_CONFIGURATIONS.flatMap((configuration, configurationIndex) =>
      Array.from({ length: 72 }, (_, taskIndex) => {
        const outcome = CALIBRATION_OUTCOMES[taskIndex % CALIBRATION_OUTCOMES.length] ?? 'correct';
        const unavailableContextBand = taskIndex === 1;
        const explanationSummary = calibrationExplanationSummaryForOutcome(outcome);
        const failureCode =
          outcome === 'invalid' && taskIndex === 8
            ? 'workspace_integrity'
            : calibrationFailureCodeForOutcome(outcome);
        const index = configurationIndex * 72 + taskIndex;
        return {
          result_id: `result_${index.toString(16).padStart(64, '0')}`,
          run_id: runId,
          task_id: `task-${String(taskIndex).padStart(2, '0')}`,
          task_version: '1.0.6',
          domain: 'coding',
          model_family: configuration.modelFamily,
          reasoning_effort: configuration.reasoningEffort,
          outcome,
          execution_status: executionStatusForOutcome(outcome),
          failure_code: failureCode,
          explanation_code: failureCode,
          explanation_summary: explanationSummary,
          task_score:
            outcome === 'correct'
              ? 1
              : outcome === 'partial'
                ? 0.5
                : outcome === 'incorrect'
                  ? 0
                  : null,
          latency_ms: null,
          latency_evidence_level: null,
          input_tokens: unavailableContextBand ? 272_001 : null,
          cached_input_tokens: unavailableContextBand ? 0 : null,
          cache_write_input_tokens: unavailableContextBand ? 0 : null,
          output_tokens: unavailableContextBand ? 0 : null,
          reasoning_output_tokens: unavailableContextBand ? 0 : null,
          total_tokens: unavailableContextBand ? 272_001 : null,
          token_usage_source_level: unavailableContextBand ? 'provider_reported' : null,
          token_usage_evidence_level: unavailableContextBand ? 'verifier_recomputed' : null,
          standard_api_equivalent_usd_nanos: null,
          cost_estimator_status: unavailableContextBand
            ? 'unavailable_context_band'
            : 'unavailable_missing_usage',
          cost_evidence_level: null,
          cost_estimator_limitations: [
            'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing',
          ],
          cost_method: 'standard_api_equivalent_text_token_estimate',
          cost_version: 'aiq.standard-api-equivalent-usd.v1',
          cost_as_of: '2026-08-02',
          cost_source: 'https://developers.openai.com/api/docs/pricing',
          pricing_currency: 'USD',
          pricing_processing_tier: 'standard',
        };
      }),
    );
    const resultRequests: Request[] = [];
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith('/public_calibration_runs')) return Response.json([run]);
        resultRequests.push(request.clone());
        const family = url.searchParams.get('model_family')?.replace(/^eq\./, '');
        const effort = url.searchParams.get('reasoning_effort')?.replace(/^eq\./, '');
        return Response.json(
          rows.filter((row) => row.model_family === family && row.reasoning_effort === effort),
        );
      },
    );

    const calibration = await repository.getCalibrationRun(runId, {
      modelFamily: 'sol',
      reasoningEffort: 'low',
    });
    assert.ok(calibration);
    assert.equal(rows.length, 1_224);
    assert.equal(calibration.resultCount, 1_224);
    assert.equal(calibration.results.length, 72);
    assert.equal(new Set(calibration.results.map((result) => result.taskId)).size, 72);
    assert.deepEqual(
      new Set(calibration.results.map((result) => result.outcome)),
      new Set(CALIBRATION_OUTCOMES),
    );
    assert.ok(
      calibration.results.every(
        (result) => result.executionStatus === executionStatusForOutcome(result.outcome),
      ),
    );
    for (const outcome of ['incorrect', 'missing'] as const) {
      const outcomeResult: PublicCalibrationResult | undefined = calibration.results.find(
        (result) => result.outcome === outcome,
      );
      assert.ok(outcomeResult);
      assert.equal(outcomeResult.failureCode, null);
      assert.equal(outcomeResult.explanationCode, null);
      assert.equal(
        outcomeResult.explanationSummary,
        calibrationExplanationSummaryForOutcome(outcome),
      );
    }
    const workspaceIntegrity = calibration.results.find(
      (result) => result.failureCode === 'workspace_integrity',
    );
    assert.ok(workspaceIntegrity);
    assert.equal(workspaceIntegrity.outcome, 'invalid');
    assert.equal(workspaceIntegrity.executionStatus, 'invalid');
    assert.equal(workspaceIntegrity.taskScore, null);
    assert.equal(workspaceIntegrity.explanationCode, 'workspace_integrity');
    assert.equal(
      workspaceIntegrity.explanationSummary,
      'Benchmark infrastructure invalidated this result; an audited rerun is required.',
    );
    const contextBand = calibration.results.find(
      (result) => result.costEstimatorStatus === 'unavailable_context_band',
    );
    assert.ok(contextBand);
    assert.equal(contextBand.standardApiEquivalentUsdNanos, null);
    assert.equal(contextBand.costEvidenceLevel, null);
    assert.deepEqual(contextBand.costEstimatorLimitations, [
      'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing',
    ]);
    assert.equal(resultRequests.length, 1);
    const resultUrl = new URL(resultRequests[0]?.url ?? 'invalid:');
    assert.equal(resultUrl.searchParams.get('run_id'), `eq.${runId}`);
    assert.equal(resultUrl.searchParams.get('model_family'), 'eq.sol');
    assert.equal(resultUrl.searchParams.get('reasoning_effort'), 'eq.low');
    assert.equal(resultUrl.searchParams.get('limit'), '73');
    assert.equal(resultRequests[0]?.headers.get('range'), null);

    const selectedRows = rows.slice(0, 72);
    const duplicateRows = [...selectedRows];
    const duplicatedRow = duplicateRows[0];
    assert.ok(duplicatedRow);
    duplicateRows[1] = duplicatedRow;
    const duplicateRepository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith('/public_calibration_runs')) return Response.json([run]);
        return Response.json(duplicateRows);
      },
    );
    await assert.rejects(
      duplicateRepository.getCalibrationRun(runId, {
        modelFamily: 'sol',
        reasoningEffort: 'low',
      }),
      /incomplete or unstable result ordering/,
    );

    await assert.rejects(
      repository.getCalibrationRun(runId, {
        modelFamily: 'luna',
        reasoningEffort: 'ultra',
      }),
      /unsupported calibration model configuration/,
    );

    const invalidRows = [
      selectedRows.map((row, index) =>
        index === 2 ? { ...row, execution_status: 'runtime_issue' } : row,
      ),
      selectedRows.map((row, index) =>
        index === 2 ? { ...row, explanation_summary: 'An internal detail leaked.' } : row,
      ),
      selectedRows.map((row, index) =>
        index === 3
          ? Object.assign({}, row, {
              failure_code: 'unsafe code',
              explanation_code: 'unsafe code',
            })
          : row,
      ),
      selectedRows.map((row, index) =>
        index === 3 ? Object.assign({}, row, { failure_code: null, explanation_code: null }) : row,
      ),
      selectedRows.map((row, index) =>
        index === 1 ? Object.assign({}, row, { standard_api_equivalent_usd_nanos: 1 }) : row,
      ),
      selectedRows.map((row, index) =>
        index === 1 ? Object.assign({}, row, { cost_evidence_level: 'verifier_recomputed' }) : row,
      ),
      selectedRows.map((row, index) =>
        index === 1 ? Object.assign({}, row, { input_tokens: 272_000 }) : row,
      ),
      selectedRows.map((row, index) =>
        index === 1
          ? Object.assign({}, row, { cost_estimator_status: 'unavailable_invalid_usage' })
          : row,
      ),
    ];
    await Promise.all(
      invalidRows.map(async (invalidResultRows) => {
        const invalidRepository = new SupabaseAiqRepository(
          'https://example.supabase.co',
          'sb_publishable_public_example',
          async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            return Response.json(
              url.pathname.endsWith('/public_calibration_runs') ? [run] : invalidResultRows,
            );
          },
        );
        await assert.rejects(
          invalidRepository.getCalibrationRun(runId, {
            modelFamily: 'sol',
            reasoningEffort: 'low',
          }),
          /public_calibration_results: invalid response shape/,
        );
      }),
    );
  });

  void it('preserves selected, attempted, adapter-invoked, and elapsed counts', async () => {
    const runId = `run_${'e'.repeat(64)}`;
    const scoreRow = {
      run_id: runId,
      model_family: 'terra',
      reasoning_effort: 'medium',
      descriptive_status: 'conditional_observed',
      quality_score: 57.5,
      task_resampling_sensitivity_lower: 45,
      task_resampling_sensitivity_upper: 68,
      task_resampling_sensitivity_method: 'finite_cluster_calibrated_percentile_sensitivity_v1',
      result_count: 72,
      sample_size: 69,
      coverage_percent: (69 / 72) * 100,
      observed_total_wall_ms: 700_000,
      observed_median_wall_ms: 10_000,
      observed_p95_wall_ms: 12_000,
      observed_time_sample_count: 70,
      observed_time_coverage_percent: (70 / 72) * 100,
      duration_evidence_level: 'runner_observed',
      input_tokens: null,
      cached_input_tokens: null,
      cache_write_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null,
      token_usage_sample_count: 0,
      token_usage_source_level: null,
      token_usage_evidence_level: null,
      standard_api_equivalent_usd_nanos: null,
      estimated_cost_sample_count: 0,
      token_usage_coverage_percent: 0,
      cost_estimator_status: 'unavailable_missing_usage',
      cost_evidence_level: null,
      cost_estimator_limitations: [
        'Standard short-context API-equivalent comparison only. This is not actual subscription spend.',
      ],
      pricing_source: 'https://developers.openai.com/api/docs/pricing',
      pricing_as_of: '2026-08-02',
      pricing_version: 'aiq.standard-api-equivalent-usd.v1',
      pricing_currency: 'USD',
      pricing_processing_tier: 'standard',
      attempted_result_count: 71,
      invoked_result_count: 70,
      adapter_elapsed_observed_result_count: 70,
      token_observed_result_count: 0,
      priced_result_count: 0,
    };
    const scores = await calibrationScoreRepository(scoreRow).listCalibrationScores(runId);
    assert.equal(scores.length, 1);
    assert.equal(scores[0]?.resultCount, 72);
    assert.equal(scores[0]?.attemptedResultCount, 71);
    assert.equal(scores[0]?.invokedResultCount, 70);
    assert.equal(scores[0]?.adapterElapsedObservedResultCount, 70);

    await Promise.all(
      [
        { ...scoreRow, attempted_result_count: 73 },
        { ...scoreRow, invoked_result_count: 72 },
        { ...scoreRow, adapter_elapsed_observed_result_count: 71 },
      ].map((invalid) =>
        assert.rejects(
          calibrationScoreRepository(invalid).listCalibrationScores(runId),
          /public_calibration_scores: invalid response shape/,
        ),
      ),
    );
  });

  void it('keeps signed matrix wall-clock separate from summed concurrent cell time', async () => {
    const runId = `run_${'d'.repeat(64)}`;
    const matrixBatchId = `run_${'b'.repeat(64)}`;
    const row = {
      run_id: runId,
      matrix_batch_id: matrixBatchId,
      model_family: 'sol',
      reasoning_effort: 'low',
      matrix_batch_elapsed_ms: 7_652_000,
      summed_cell_adapter_elapsed_ms: 12_240_000,
      observed_median_wall_ms: 160_000,
      observed_p95_wall_ms: 240_000,
      observed_time_sample_count: 72,
      observed_time_coverage_percent: 100,
      duration_evidence_level: 'runner_observed',
      input_tokens: null,
      cached_input_tokens: null,
      cache_write_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null,
      token_usage_sample_count: 0,
      token_usage_coverage_percent: null,
      input_token_coverage_count: null,
      input_token_coverage_percent: null,
      cached_input_token_coverage_count: null,
      cached_input_token_coverage_percent: null,
      cache_write_input_token_coverage_count: null,
      cache_write_input_token_coverage_percent: null,
      output_token_coverage_count: null,
      output_token_coverage_percent: null,
      reasoning_token_coverage_count: null,
      reasoning_token_coverage_percent: null,
      total_token_coverage_count: null,
      total_token_coverage_percent: null,
      token_usage_source_level: null,
      token_usage_evidence_level: null,
      standard_api_equivalent_usd_nanos: null,
      cost_estimator_status: 'unavailable_missing_usage',
      cost_evidence_level: null,
      cost_method: null,
      pricing_source: null,
      pricing_as_of: null,
      pricing_version: null,
      pricing_currency: null,
      pricing_processing_tier: null,
      result_count: 72,
      attempted_result_count: 72,
      invoked_result_count: 72,
      adapter_elapsed_observed_result_count: 72,
      token_observed_result_count: 0,
      priced_result_count: 0,
      execution_concurrency: 17,
      estimated_cost_sample_count: 0,
      cost_estimator_limitations: [],
      pricing_rates: [],
      cost_formula: null,
    };
    const [efficiency] = await modelEfficiencyRepository([row]).listModelEfficiency([runId]);
    assert.equal(efficiency?.matrixBatchId, matrixBatchId);
    assert.equal(efficiency?.matrixBatchElapsedMs, 7_652_000);
    assert.equal(efficiency?.summedCellAdapterElapsedMs, 12_240_000);

    await Promise.all(
      [
        { ...row, observed_time_coverage_percent: 99 },
        { ...row, adapter_elapsed_observed_result_count: 71 },
        { ...row, token_usage_sample_count: 73 },
        { ...row, priced_result_count: 73, estimated_cost_sample_count: 73 },
        { ...row, model_family: 'future' },
        { ...row, reasoning_effort: 'future' },
      ].map((invalid) =>
        assert.rejects(
          modelEfficiencyRepository([invalid]).listModelEfficiency([runId]),
          /public_model_efficiency: invalid response shape/,
        ),
      ),
    );

    const secondRunId = `run_${'e'.repeat(64)}`;
    await assert.rejects(
      modelEfficiencyRepository([
        row,
        {
          ...row,
          run_id: secondRunId,
          model_family: 'terra',
          matrix_batch_elapsed_ms: 7_652_001,
        },
      ]).listModelEfficiency([runId, secondRunId]),
      /inconsistent matrix batch elapsed time/,
    );

    await assert.rejects(
      modelEfficiencyRepository([
        row,
        { ...row, model_family: 'terra', reasoning_effort: 'high' },
      ]).listModelEfficiency([runId, secondRunId]),
      /duplicate run identity/,
    );
  });

  void it('uses stable keyset cursors to navigate all run-history pages', async () => {
    const first = buildSeedRunHistoryPage(seedRuns);
    assert.equal(first.runs.length, RUN_HISTORY_PAGE_SIZE);
    assert.equal(first.newerCursor, null);
    assert.ok(first.olderCursor);
    const second = buildSeedRunHistoryPage(seedRuns, {
      direction: 'older',
      cursor: first.olderCursor,
    });
    assert.equal(second.runs.length, seedRuns.length - RUN_HISTORY_PAGE_SIZE);
    assert.ok(second.newerCursor);
    assert.equal(second.olderCursor, null);
    assert.deepEqual(
      [...first.runs, ...second.runs].map((run) => run.id),
      seedRuns
        .toSorted(
          (left, right) =>
            right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id),
        )
        .map((run) => run.id),
    );
    const returned = buildSeedRunHistoryPage(seedRuns, {
      direction: 'newer',
      cursor: second.newerCursor,
    });
    assert.deepEqual(
      returned.runs.map((run) => run.id),
      first.runs.map((run) => run.id),
    );
    const firstRun = first.runs[0];
    assert.ok(firstRun);
    const decoded = decodeRunHistoryCursor(
      encodeRunHistoryCursor({ startedAt: firstRun.startedAt, id: firstRun.id }),
    );
    assert.deepEqual(decoded, {
      startedAt: firstRun.startedAt,
      id: firstRun.id,
    });
    assert.throws(() => decodeRunHistoryCursor('not-json'), /Invalid run-history cursor/);
  });

  void it('retains more than 1,000 calibration runs behind 20-row keyset pages', () => {
    const runs: PublicCalibrationRunSummary[] = Array.from({ length: 1_001 }, (_, index) => ({
      id: `calibration-${String(index).padStart(4, '0')}`,
      classification: 'local_calibration_non_official',
      scoringVersion: '1.0.6',
      selectedTaskCount: 72,
      selectedModelCount: 17,
      resultCount: 1_224,
      startedAt: '2026-08-02T12:00:00.000Z',
      completedAt: '2026-08-02T13:00:00.000Z',
      verifiedAt: '2026-08-02T13:01:00.000Z',
      publishedAt: '2026-08-02T13:02:00.000Z',
      replayStatus: 'evaluator_replayed',
      official: false,
      rankingEligible: false,
      pricingCurrency: 'USD',
      pricingProcessingTier: 'standard',
      synthetic: false,
    }));
    const expectedIds = runs.map((run) => run.id);
    const pages = [];
    let page = buildSeedCalibrationRunPage(runs);
    for (;;) {
      pages.push(page);
      assert.ok(page.runs.length <= CALIBRATION_RUN_PAGE_SIZE);
      if (!page.olderCursor) break;
      page = buildSeedCalibrationRunPage(runs, {
        direction: 'older',
        cursor: page.olderCursor,
      });
    }
    assert.equal(pages.length, Math.ceil(runs.length / CALIBRATION_RUN_PAGE_SIZE));
    assert.deepEqual(
      pages.flatMap((candidate) => candidate.runs.map((run) => run.id)),
      expectedIds,
    );

    const newerIds: string[] = [];
    page = pages.at(-1) ?? page;
    newerIds.unshift(...page.runs.map((run) => run.id));
    while (page.newerCursor) {
      page = buildSeedCalibrationRunPage(runs, {
        direction: 'newer',
        cursor: page.newerCursor,
      });
      newerIds.unshift(...page.runs.map((run) => run.id));
    }
    assert.deepEqual(newerIds, expectedIds);
    assert.equal(new Set(newerIds).size, 1_001);

    const boundary = runs[0];
    assert.ok(boundary);
    assert.deepEqual(
      decodeCalibrationRunCursor(
        encodeCalibrationRunCursor({ startedAt: boundary.startedAt, id: boundary.id }),
      ),
      { startedAt: boundary.startedAt, id: boundary.id },
    );
    assert.throws(() => decodeCalibrationRunCursor('not-json'), /Invalid calibration-run cursor/);
  });

  void it('preserves every tie-heavy seed run while paging older and newer', () => {
    const template = seedRuns[0];
    assert.ok(template);
    const tiedRuns = Array.from({ length: 31 }, (_, index) => ({
      ...template,
      id: `run-tie-${String(index).padStart(2, '0')}`,
      startedAt: '2026-07-24T12:00:00.000Z',
    }));
    const runs = [
      { ...template, id: 'run-newest', startedAt: '2026-07-25T12:00:00.000Z' },
      ...tiedRuns,
      { ...template, id: 'run-oldest', startedAt: '2026-07-23T12:00:00.000Z' },
    ];
    const expected = runs
      .toSorted(
        (left, right) =>
          right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id),
      )
      .map((run) => run.id);
    const olderPages = [];
    let page = buildSeedRunHistoryPage(runs);
    for (;;) {
      olderPages.push(page);
      if (!page.olderCursor) break;
      page = buildSeedRunHistoryPage(runs, { direction: 'older', cursor: page.olderCursor });
    }
    assert.deepEqual(
      olderPages.flatMap((candidate) => candidate.runs.map((run) => run.id)),
      expected,
      'forward keyset traversal must have no gaps or duplicates',
    );

    const newerIds: string[] = [];
    page = olderPages.at(-1) ?? page;
    newerIds.unshift(...page.runs.map((run) => run.id));
    while (page.newerCursor) {
      page = buildSeedRunHistoryPage(runs, {
        direction: 'newer',
        cursor: page.newerCursor,
      });
      newerIds.unshift(...page.runs.map((run) => run.id));
    }
    assert.deepEqual(
      newerIds,
      expected,
      'backward keyset traversal must have no gaps or duplicates',
    );
    assert.equal(new Set(newerIds).size, runs.length);
  });

  void it('keeps canonical coverage separate from the Provisional per-domain threshold', () => {
    const complete = seedRuns[0];
    assert.ok(complete);
    const sparseDomain = 'coding';
    const retainedTaskId = complete.tasks.find((task) => task.domain === sparseDomain)?.id;
    assert.ok(retainedTaskId);
    const counterexample = {
      ...complete,
      id: 'run-summary-threshold-counterexample',
      tasks: complete.tasks.map((task) => {
        if (task.domain !== sparseDomain || task.id === retainedTaskId) {
          return task;
        }
        return Object.assign({}, task, {
          outcome: 'missing' as const,
          executionStatus: 'missing' as const,
          score: null,
        });
      }),
    };
    const summary = buildSeedRunHistoryPage([counterexample]).runs[0];
    assert.ok(summary);
    assert.equal(summary.resultSummary.observedCount, 65);
    assert.equal(summary.resultSummary.coveredDomainCount, 10);
    assert.equal(summary.resultSummary.provisionalDomainCount, 9);
    assert.equal(classifyRunSummaryCompleteness(summary).label, 'Coverage-only · not ranked');
  });

  void it('validates live cursor boundary tuples with constant requests per page', async () => {
    const storedBoundary = {
      id: 'run-valid-boundary',
      started_at: '2026-07-24T12:00:00.000Z',
    };
    const requests: URL[] = [];
    const testFetch: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url);
      const selected = url.searchParams.get('select');
      if (selected === 'id,started_at') {
        const id = url.searchParams.get('id')?.replace(/^eq\./, '');
        const startedAt = url.searchParams.get('started_at')?.replace(/^eq\./, '');
        return Response.json(
          id === storedBoundary.id && startedAt === storedBoundary.started_at
            ? [storedBoundary]
            : [],
        );
      }
      return Response.json([]);
    };
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      testFetch,
    );

    await repository.listRunPage();
    assert.equal(requests.length, 1, 'the first page must remain one bounded query');

    requests.length = 0;
    await repository.listRunPage({
      direction: 'older',
      cursor: encodeRunHistoryCursor({
        id: storedBoundary.id,
        startedAt: storedBoundary.started_at,
      }),
    });
    assert.equal(requests.length, 2, 'a cursor page must use one boundary and one page query');
    assert.equal(requests[0]?.searchParams.get('limit'), '1');

    requests.length = 0;
    await assert.rejects(
      repository.listRunPage({
        cursor: encodeRunHistoryCursor({
          id: 'run-does-not-exist',
          startedAt: storedBoundary.started_at,
        }),
      }),
      /Invalid run-history cursor/,
    );
    assert.equal(requests.length, 1);

    requests.length = 0;
    await assert.rejects(
      repository.listRunPage({
        cursor: encodeRunHistoryCursor({
          id: storedBoundary.id,
          startedAt: '2026-07-24T12:00:01.000Z',
        }),
      }),
      /Invalid run-history cursor/,
    );
    assert.equal(requests.length, 1);

    requests.length = 0;
    const validCursor = encodeRunHistoryCursor({
      id: storedBoundary.id,
      startedAt: storedBoundary.started_at,
    });
    await assert.rejects(
      repository.listRunPage({ cursor: `${validCursor.slice(0, -1)}!` }),
      /Invalid run-history cursor/,
    );
    assert.equal(requests.length, 0);
  });

  void it('preserves every same-time live run in both directions with constant requests', async () => {
    const rows: RunRow[] = Array.from({ length: 31 }, (_, index) => ({
      ...runSummaryRow(index + 1),
      started_at: '2026-07-24T12:00:00.000Z',
      result_count: 72,
      correct_count: 72,
      partial_count: 0,
      incorrect_count: 0,
      runtime_issue_count: 0,
      invalid_count: 0,
      missing_count: 0,
      not_applicable_count: 0,
      completed_count: 72,
      observed_count: 72,
      coverage_percent: 100,
      covered_domain_count: 10,
      provisional_domain_count: 10,
    }));
    const requests: URL[] = [];
    const testFetch: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url);
      if (url.searchParams.get('select') === 'id,started_at') {
        const id = url.searchParams.get('id')?.replace(/^eq\./, '');
        return Response.json(
          rows
            .filter((row) => row.id === id)
            .slice(0, 1)
            .map((row) => ({ id: row.id, started_at: row.started_at })),
        );
      }
      const boundary = /id\.(gt|lt)\.([^)]+)/.exec(url.searchParams.get('or') ?? '');
      let selected = boundary
        ? rows.filter((row) =>
            boundary[1] === 'gt' ? row.id > (boundary[2] ?? '') : row.id < (boundary[2] ?? ''),
          )
        : [...rows];
      const ascending = url.searchParams.get('order')?.startsWith('started_at.asc') ?? false;
      selected.sort((left, right) =>
        ascending ? right.id.localeCompare(left.id) : left.id.localeCompare(right.id),
      );
      return Response.json(selected.slice(0, Number(url.searchParams.get('limit') ?? 0)));
    };
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      testFetch,
    );
    const olderPages = [];
    let page = await repository.listRunPage();
    assert.equal(requests.length, 1);
    for (;;) {
      olderPages.push(page);
      if (!page.olderCursor) break;
      const before: number = requests.length;
      // oxlint-disable-next-line no-await-in-loop -- each cursor depends on the prior page.
      page = await repository.listRunPage({ direction: 'older', cursor: page.olderCursor });
      assert.equal(requests.length - before, 2);
    }
    const expected = rows.map((row) => row.id);
    assert.deepEqual(
      olderPages.flatMap((candidate) => candidate.runs.map((run) => run.id)),
      expected,
    );

    const newerIds: string[] = [];
    page = olderPages.at(-1) ?? page;
    newerIds.unshift(...page.runs.map((run) => run.id));
    while (page.newerCursor) {
      const before: number = requests.length;
      // oxlint-disable-next-line no-await-in-loop -- each cursor depends on the prior page.
      page = await repository.listRunPage({ direction: 'newer', cursor: page.newerCursor });
      assert.equal(requests.length - before, 2);
      newerIds.unshift(...page.runs.map((run) => run.id));
    }
    assert.deepEqual(newerIds, expected);
    assert.equal(new Set(newerIds).size, rows.length);
  });

  void it('distinguishes synthetic, empty live, and unavailable live reads', async () => {
    const syntheticRepository = new SeedAiqRepository();
    assert.equal(
      (
        await readPublicData(
          syntheticRepository,
          () => Promise.resolve([1]),
          [],
          (v) => v.length === 0,
          () => [true],
        )
      ).state,
      'synthetic',
    );
    const liveRepository = createAiqRepository({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    });
    assert.equal(
      (
        await readPublicData(
          liveRepository,
          () => Promise.resolve([]),
          [],
          (v) => v.length === 0,
          () => [],
        )
      ).state,
      'empty',
    );
    const unavailable = await readPublicData(
      liveRepository,
      () => Promise.reject(new Error('missing public view')),
      [],
      (v) => v.length === 0,
      () => [],
    );
    assert.equal(unavailable.state, 'unavailable');
    assert.match(
      unavailable.state === 'unavailable' ? unavailable.detail : '',
      /missing public view/,
    );
  });

  void it('classifies successful live evidence from row provenance', async () => {
    const liveRepository = createAiqRepository({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    });
    const cases: ReadonlyArray<{
      values: readonly boolean[];
      expected: 'synthetic' | 'published' | 'mixed';
    }> = [
      { values: [true, true], expected: 'synthetic' },
      { values: [false, false], expected: 'published' },
      { values: [true, false], expected: 'mixed' },
    ];
    await Promise.all(
      cases.map(async ({ values, expected }) => {
        const result = await readPublicData(
          liveRepository,
          () => Promise.resolve(values),
          [],
          (value) => value.length === 0,
          (value) => value,
        );
        assert.equal(result.state, expected);
      }),
    );
  });

  void it('preserves a mixed calibration matrix provenance state', async () => {
    const liveRepository = createAiqRepository({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    });
    const scoreProvenance = Array.from({ length: 17 }, (_, index) => ({
      configuration: CALIBRATION_MODEL_CONFIGURATIONS[index],
      synthetic: index === 0,
    }));
    const result = await readPublicData(
      liveRepository,
      () => Promise.resolve(scoreProvenance),
      [],
      (value) => value.length === 0,
      (value) => value.map((score) => score.synthetic),
    );
    assert.equal(result.state, 'mixed');
    assert.equal(result.data.length, 17);
  });

  void it('formats never-seen and stale registry observations without liveness claims', () => {
    const now = new Date('2026-07-24T15:00:00.000Z');
    assert.equal(formatLastObservation(null, now), 'Never observed');
    assert.match(formatLastObservation('2026-07-24T14:00:00.000Z', now), /stale$/);
    assert.doesNotMatch(formatLastObservation(null, now), /online/i);
    assert.equal(classifyObservationRecency('2026-07-24T14:50:00.000Z', now), 'recent');
    assert.equal(classifyObservationRecency('not-a-date', now), 'unavailable');
  });

  void it('selects the newest completed run rather than a score-ordered run', () => {
    assert.deepEqual(
      latestCompletedRun([
        { id: 'highest-score', completedAt: '2026-07-24T14:00:00.000Z' },
        { id: 'newest-evidence', completedAt: '2026-07-25T14:00:00.000Z' },
        { id: 'invalid-time', completedAt: 'not-a-date' },
      ]),
      { id: 'newest-evidence', completedAt: '2026-07-25T14:00:00.000Z' },
    );
  });

  void it('queries the newest completed run across the complete retained relation', async () => {
    const newestRow: RunRow = {
      ...runSummaryRow(1),
      started_at: '2026-07-01T12:00:00.000Z',
      completed_at: '2026-08-04T12:00:00.000Z',
      result_count: 72,
      correct_count: 72,
      partial_count: 0,
      incorrect_count: 0,
      runtime_issue_count: 0,
      invalid_count: 0,
      missing_count: 0,
      not_applicable_count: 0,
      completed_count: 72,
      observed_count: 72,
      coverage_percent: 100,
      covered_domain_count: 10,
      provisional_domain_count: 10,
    };
    const requests: URL[] = [];
    const testFetch: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url);
      return Response.json([newestRow]);
    };
    const repository = new SupabaseAiqRepository(
      'https://example.supabase.co',
      'sb_publishable_public_example',
      testFetch,
    );

    const newest = await repository.getNewestCompletedRun();

    assert.equal(newest?.id, newestRow.id);
    assert.equal(newest?.completedAt, newestRow.completed_at);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.searchParams.get('order'), 'completed_at.desc,id.asc');
    assert.equal(requests[0]?.searchParams.get('limit'), '1');
  });

  void it('maps all public run provenance fields and preserves nulls', () => {
    const row: RunRow = {
      id: 'run-provenance',
      matrix_id: 'sol-ultra',
      started_at: '2026-07-26T12:00:00.000Z',
      completed_at: '2026-07-26T12:10:00.000Z',
      benchmark_version: 'aiq-core@1.0.6',
      scoring_version: '1.0.6',
      prompt_set_digest: 'sha256:prompt',
      runner_commit: 'abc1234',
      region: 'us-east-1',
      synthetic: false,
      corpus_release_id: 'corpus_2026.07.26',
      corpus_commitment_sha256: 'sha256:corpus',
      catalog_digest: 'sha256:catalog',
      task_set_digest: 'sha256:tasks',
      preflight_digest: 'sha256:preflight',
      runtime_digest: 'sha256:runtime',
      run_class: 'official',
      permission_evidence_digest: 'sha256:permission',
      result_count: 0,
      correct_count: 0,
      partial_count: 0,
      incorrect_count: 0,
      runtime_issue_count: 0,
      invalid_count: 0,
      missing_count: 0,
      not_applicable_count: 0,
      completed_count: 0,
      observed_count: 0,
      coverage_percent: null,
      covered_domain_count: 0,
      provisional_domain_count: 0,
    };
    const run = mapRunRow(row, []);
    assert.deepEqual(
      {
        corpusReleaseId: run.corpusReleaseId,
        corpusCommitmentSha256: run.corpusCommitmentSha256,
        catalogDigest: run.catalogDigest,
        taskSetDigest: run.taskSetDigest,
        preflightDigest: run.preflightDigest,
        runtimeDigest: run.runtimeDigest,
        runClass: run.runClass,
        permissionEvidenceDigest: run.permissionEvidenceDigest,
      },
      {
        corpusReleaseId: 'corpus_2026.07.26',
        corpusCommitmentSha256: 'sha256:corpus',
        catalogDigest: 'sha256:catalog',
        taskSetDigest: 'sha256:tasks',
        preflightDigest: 'sha256:preflight',
        runtimeDigest: 'sha256:runtime',
        runClass: 'official',
        permissionEvidenceDigest: 'sha256:permission',
      },
    );
    assert.ok(
      seedRuns.every((seedRun) =>
        [
          seedRun.corpusReleaseId,
          seedRun.corpusCommitmentSha256,
          seedRun.catalogDigest,
          seedRun.taskSetDigest,
          seedRun.preflightDigest,
          seedRun.runtimeDigest,
          seedRun.runClass,
          seedRun.permissionEvidenceDigest,
        ].every((value) => value === null),
      ),
    );
  });

  void it('preserves evaluator outcomes separately from execution-failure explanations', () => {
    const template = seedRuns[0];
    assert.ok(template);
    const row: RunRow = {
      id: 'run-public-explanations',
      matrix_id: template.entryId,
      started_at: template.startedAt,
      completed_at: template.completedAt,
      benchmark_version: template.benchmarkVersion,
      scoring_version: template.scoringVersion,
      prompt_set_digest: template.promptSetDigest,
      runner_commit: template.runnerCommit,
      region: template.region,
      synthetic: false,
      corpus_release_id: template.corpusReleaseId,
      corpus_commitment_sha256: template.corpusCommitmentSha256,
      catalog_digest: template.catalogDigest,
      task_set_digest: template.taskSetDigest,
      preflight_digest: template.preflightDigest,
      runtime_digest: template.runtimeDigest,
      run_class: 'official',
      permission_evidence_digest: template.permissionEvidenceDigest,
      result_count: 3,
      correct_count: 0,
      partial_count: 0,
      incorrect_count: 1,
      runtime_issue_count: 2,
      invalid_count: 0,
      missing_count: 0,
      not_applicable_count: 0,
      completed_count: 1,
      observed_count: 1,
      coverage_percent: 33.3,
      covered_domain_count: 1,
      provisional_domain_count: 0,
    };
    const evaluatorIncorrect: RunResultRow = {
      run_id: row.id,
      id: 'result-evaluator-incorrect',
      task_id: 'coding-01',
      task: 'Evaluator-incorrect result',
      domain: 'coding',
      outcome: 'incorrect',
      execution_status: 'completed',
      score: 0,
      explanation_code: null,
      explanation_summary: 'The evaluator rejected the response.',
      retryable: null,
      tools: [],
      latency_ms: 1_500,
      latency_evidence_level: 'runner_observed',
      input_tokens: null,
      cached_input_tokens: null,
      cache_write_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null,
      token_usage_source_level: null,
      token_usage_evidence_level: null,
      standard_api_equivalent_usd_nanos: null,
      cost_estimator_status: 'unavailable_missing_usage',
      cost_evidence_level: null,
      pricing_digest: 'sha256:e1a28656f2918a14e86997b06bf9e29ec4db084ff89ee0319aafa0c05cc1f31d',
    };
    const timeout: RunResultRow = {
      ...evaluatorIncorrect,
      id: 'result-timeout',
      task_id: 'coding-02',
      task: 'Timed-out result',
      outcome: 'timeout',
      execution_status: 'runtime_issue',
      score: null,
      explanation_code: 'timeout',
      explanation_summary: 'The task exceeded its time limit.',
      retryable: true,
    };
    const budgetExceeded: RunResultRow = {
      ...evaluatorIncorrect,
      id: 'result-budget-exceeded',
      task_id: 'coding-03',
      task: 'Budget-exhausted result',
      outcome: 'budget_exhausted',
      execution_status: 'runtime_issue',
      score: null,
      explanation_code: 'budget_exceeded',
      explanation_summary: 'The task exceeded a resource budget.',
      retryable: false,
    };

    const tasks = mapRunRow(row, [evaluatorIncorrect, timeout, budgetExceeded]).tasks;
    assert.deepEqual(tasks[0]?.explanation, {
      code: null,
      summary: 'The evaluator rejected the response.',
      retryable: null,
    });
    assert.deepEqual(tasks[1]?.explanation, {
      code: 'timeout',
      summary: 'The task exceeded its time limit.',
      retryable: true,
    });
    assert.deepEqual(tasks[2]?.explanation, {
      code: 'budget_exceeded',
      summary: 'The task exceeded a resource budget.',
      retryable: false,
    });
  });

  void it('provides distinct color and line-pattern encodings for all 17 trend series', () => {
    assert.equal(TREND_SERIES_STYLES.length, 17);
    assert.equal(
      new Set(
        TREND_SERIES_STYLES.map(
          (style) => `${style.color}:${style.dashArray ?? 'solid'}:${style.pattern}`,
        ),
      ).size,
      17,
    );
    assert.ok(TREND_SERIES_STYLES.some((style) => style.pattern === 'dashed'));
    assert.ok(TREND_SERIES_STYLES.some((style) => style.pattern === 'dotted'));
  });

  void it('labels mixed provenance and keeps synthetic radar evidence explicitly unverified', () => {
    assert.equal(classifyDataProvenance([true, false]), 'mixed');
    assert.equal(classifyDataProvenance([true, null]), 'synthetic');
    assert.equal(classifyDataProvenance([null]), 'unavailable');
    assert.deepEqual(TRUST_LEVELS, [
      'unverified',
      'signed_community',
      'trusted_verified',
      'independently_reproduced',
    ]);
    assert.ok(seedRadarNodes.every((node) => node.registryTrust === 'unverified'));
    assert.ok(
      seedRadarNodes.every(
        (node) =>
          node.latestCapability?.signatureStatus !== 'verified' &&
          node.latestObservation?.signatureStatus !== 'verified' &&
          node.aggregation.receiverVerifiedTrusted === 0,
      ),
    );
    assert.equal(formatTrustLevel('signed_community'), 'signed community');
    assert.ok(
      seedLeaderboard.every((entry) => leaderboardRunHref(entry) === `/runs/${entry.runId}`),
    );
  });

  void it('parses the distributed radar contract and keeps trust layers distinct', () => {
    const atlas = seedRadarNodes[0];
    assert.ok(atlas);
    const publishedRow = {
      ...distributedRadarRowFromNode(atlas),
      synthetic: false,
      registry_trust: 'signed_community',
      latest_capability_status: 'validated',
      latest_capability_signature_status: 'verified',
      latest_observation_state: 'degraded',
      latest_observation_status: 'accepted',
      latest_observation_signature_status: 'verified',
      receiver_verified_trusted_count: 1,
      signed_untrusted_count: 1,
    } satisfies DistributedRadarRow;
    const node = parseDistributedRadarRows([publishedRow])[0];
    assert.ok(node);
    assert.equal(node.registryTrust, 'signed_community');
    assert.equal(node.latestObservation?.state, 'degraded');
    assert.equal(node.latestObservation?.recordStatus, 'accepted');
    assert.equal(node.aggregation.receiverVerifiedTrusted, 1);
    assert.equal(node.aggregation.signedUntrusted, 1);

    const absentEvidence = {
      ...publishedRow,
      latest_capability_schema_version: null,
      latest_capability_hash: null,
      latest_capability_status: null,
      latest_capability_signature_status: null,
      latest_capability_observed_at: null,
      latest_observation_schema_version: null,
      latest_observation_state: null,
      latest_observation_sequence: null,
      latest_observation_hash: null,
      latest_observation_status: null,
      latest_observation_signature_status: null,
      latest_observation_observed_at: null,
      latest_observation_provenance_hash: null,
      receiver_verified_trusted_count: 0,
      signed_untrusted_count: 0,
      rejected_count: 0,
      missing_count: 0,
      aggregated_at: null,
    } satisfies DistributedRadarRow;
    const nodeWithoutEvidence = parseDistributedRadarRows([absentEvidence])[0];
    assert.equal(nodeWithoutEvidence?.latestCapability, null);
    assert.equal(nodeWithoutEvidence?.latestObservation, null);
    assert.equal(nodeWithoutEvidence?.aggregation.aggregatedAt, null);
  });

  void it('keeps the three fallback radar rows equivalent to the public synthetic seed', () => {
    assert.deepEqual(
      seedRadarNodes.map((node) => ({
        id: node.id,
        name: node.name,
        operator: node.operator,
        trust: node.registryTrust,
        status: node.registryStatus,
        capability: [node.latestCapability?.status, node.latestCapability?.signatureStatus],
        observation: [
          node.latestObservation?.state,
          node.latestObservation?.recordStatus,
          node.latestObservation?.signatureStatus,
        ],
        assignments: node.assignmentCounts,
        receipts: node.receiptCounts,
        aggregation: node.aggregation,
      })),
      [
        {
          id: 'node_33518601c2f58e370fd02c26a1a3dc8172285fb40231393d3aa735608d5fe633',
          name: 'Atlas / IAD',
          operator: 'official',
          trust: 'unverified',
          status: 'active',
          capability: ['declared', 'unverified'],
          observation: ['ready', 'observed', 'unverified'],
          assignments: {
            total: 3,
            offered: 1,
            accepted: 1,
            running: 1,
            completed: 0,
            revoked: 0,
            expired: 0,
          },
          receipts: { total: 1, received: 1, accepted: 0, rejected: 0 },
          aggregation: {
            receiverVerifiedTrusted: 0,
            signedUntrusted: 1,
            rejected: 0,
            missing: 0,
            aggregatedAt: '2026-07-24T14:30:00.000Z',
          },
        },
        {
          id: 'node_eee08e5881ce3843a8a5002a2391accbf897a06049889cb691730eda20b18cf0',
          name: 'Kepler / FRA',
          operator: 'verifier',
          trust: 'unverified',
          status: 'degraded',
          capability: ['rejected', 'rejected'],
          observation: ['busy', 'rejected', 'rejected'],
          assignments: {
            total: 2,
            offered: 0,
            accepted: 0,
            running: 0,
            completed: 1,
            revoked: 1,
            expired: 0,
          },
          receipts: { total: 2, received: 0, accepted: 1, rejected: 1 },
          aggregation: {
            receiverVerifiedTrusted: 0,
            signedUntrusted: 1,
            rejected: 1,
            missing: 0,
            aggregatedAt: '2026-07-24T14:32:00.000Z',
          },
        },
        {
          id: 'node_bd09f64ce3b8a251a9e7c1d8587b39fb296edb68981e0bc92a279d0bff85cfdf',
          name: 'Nomad / unknown',
          operator: 'community',
          trust: 'unverified',
          status: 'offline',
          capability: ['declared', 'unverified'],
          observation: ['offline', 'stale', 'unverified'],
          assignments: {
            total: 1,
            offered: 0,
            accepted: 0,
            running: 0,
            completed: 0,
            revoked: 0,
            expired: 1,
          },
          receipts: { total: 0, received: 0, accepted: 0, rejected: 0 },
          aggregation: {
            receiverVerifiedTrusted: 0,
            signedUntrusted: 0,
            rejected: 0,
            missing: 1,
            aggregatedAt: '2026-07-24T14:33:00.000Z',
          },
        },
      ],
    );
    assert.deepEqual(
      parseDistributedRadarRows(seedRadarNodes.map(distributedRadarRowFromNode)),
      seedRadarNodes,
    );
  });

  void it('fails closed for every distributed radar identity and evidence invariant', () => {
    const atlas = seedRadarNodes[0];
    assert.ok(atlas);
    const valid = distributedRadarRowFromNode(atlas);
    const invalidRows: ReadonlyArray<{ name: string; row: unknown }> = [
      { name: 'node identity', row: { ...valid, node_id: 'node_contract' } },
      { name: 'fingerprint', row: { ...valid, public_key_fingerprint: 'ed25519:example' } },
      { name: 'registry trust', row: { ...valid, registry_trust: 'trusted' } },
      { name: 'registry status', row: { ...valid, registry_status: 'online' } },
      {
        name: 'capability schema',
        row: { ...valid, latest_capability_schema_version: 'aiq.distributed-capability.v2' },
      },
      { name: 'capability hash', row: { ...valid, latest_capability_hash: 'sha256:bad' } },
      { name: 'capability status', row: { ...valid, latest_capability_status: 'accepted' } },
      {
        name: 'capability signature',
        row: { ...valid, latest_capability_signature_status: 'valid' },
      },
      {
        name: 'partial capability',
        row: { ...valid, latest_capability_hash: null },
      },
      {
        name: 'observation schema',
        row: { ...valid, latest_observation_schema_version: 'aiq.distributed-observation.v2' },
      },
      { name: 'observation state', row: { ...valid, latest_observation_state: 'online' } },
      {
        name: 'observation sequence',
        row: { ...valid, latest_observation_sequence: -1 },
      },
      {
        name: 'zero observation sequence',
        row: { ...valid, latest_observation_sequence: 0 },
      },
      { name: 'observation hash', row: { ...valid, latest_observation_hash: 'sha256:bad' } },
      {
        name: 'observation disposition',
        row: { ...valid, latest_observation_status: 'validated' },
      },
      {
        name: 'observation signature',
        row: { ...valid, latest_observation_signature_status: 'valid' },
      },
      {
        name: 'partial observation',
        row: { ...valid, latest_observation_provenance_hash: null },
      },
      {
        name: 'timestamp',
        row: { ...valid, latest_observation_observed_at: '2026-07-27' },
      },
    ];
    for (const { name, row } of invalidRows) {
      assert.throws(() => parseDistributedRadarRows([row]), /invalid response shape/, name);
    }
  });

  void it('fails closed for incoherent distributed radar counts and aggregation time', () => {
    const atlas = seedRadarNodes[0];
    assert.ok(atlas);
    const valid = distributedRadarRowFromNode(atlas);
    const invalidRows: ReadonlyArray<{ name: string; row: unknown }> = [
      { name: 'negative count', row: { ...valid, assignment_total_count: -1 } },
      { name: 'fractional count', row: { ...valid, receipt_total_count: 1.5 } },
      {
        name: 'unsafe count',
        row: { ...valid, missing_count: Number.MAX_SAFE_INTEGER + 1 },
      },
      {
        name: 'assignment sum',
        row: { ...valid, assignment_offered_count: valid.assignment_offered_count + 1 },
      },
      {
        name: 'receipt sum',
        row: { ...valid, receipt_received_count: valid.receipt_received_count + 1 },
      },
      {
        name: 'aggregation sum overflow',
        row: {
          ...valid,
          signed_untrusted_count: Number.MAX_SAFE_INTEGER,
          rejected_count: 1,
        },
      },
      {
        name: 'zero aggregation with time',
        row: {
          ...valid,
          receiver_verified_trusted_count: 0,
          signed_untrusted_count: 0,
          rejected_count: 0,
          missing_count: 0,
        },
      },
      {
        name: 'nonzero aggregation without time',
        row: { ...valid, aggregated_at: null },
      },
    ];
    for (const { name, row } of invalidRows) {
      assert.throws(() => parseDistributedRadarRows([row]), /invalid response shape/, name);
    }
  });

  void it('rejects synthetic rows that claim verified or trusted evidence', () => {
    const atlas = seedRadarNodes[0];
    assert.ok(atlas);
    const valid = distributedRadarRowFromNode(atlas);
    const invalidRows: ReadonlyArray<{ name: string; row: unknown }> = [
      { name: 'signed community registry', row: { ...valid, registry_trust: 'signed_community' } },
      { name: 'trusted registry', row: { ...valid, registry_trust: 'trusted_verified' } },
      {
        name: 'independently reproduced registry',
        row: { ...valid, registry_trust: 'independently_reproduced' },
      },
      {
        name: 'verified capability',
        row: { ...valid, latest_capability_signature_status: 'verified' },
      },
      {
        name: 'verified observation',
        row: { ...valid, latest_observation_signature_status: 'verified' },
      },
      {
        name: 'trusted aggregation',
        row: {
          ...valid,
          receiver_verified_trusted_count: 1,
          signed_untrusted_count: valid.signed_untrusted_count - 1,
        },
      },
    ];
    for (const { name, row } of invalidRows) {
      assert.throws(() => parseDistributedRadarRows([row]), /invalid response shape/, name);
    }
  });
});
