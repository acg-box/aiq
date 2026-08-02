import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyRunCompleteness,
  classifyRunSummaryCompleteness,
  filterTrendPoints,
  formatConfidenceInterval,
  formatLastObservation,
  formatTrustLevel,
  leaderboardRunHref,
  radarOrbitPosition,
  sortLeaderboardByPointEstimate,
  summarizeRun,
  summarizeRunDomains,
  TRUST_LEVELS,
} from './format.ts';
import { presentLeaderboardEntry } from './leaderboard-presentation.ts';
import {
  CALIBRATION_MODEL_CONFIGURATIONS,
  CALIBRATION_RUN_PAGE_SIZE,
  CANONICAL_MODEL_MATRIX_IDS,
  buildSeedCalibrationRunPage,
  buildSeedRunHistoryPage,
  calibrationExplanationSummaryForOutcome,
  calibrationFailureCodeForOutcome,
  calibrationStatusForOutcome,
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

function trendRow(matrixId: string, recordedAt: string): TrendRow {
  return {
    matrix_id: matrixId,
    run_id: `run-${matrixId}-${recordedAt}`,
    recorded_at: recordedAt,
    bucket_started_at: recordedAt,
    bucket_ended_at: new Date(Date.parse(recordedAt) + 1).toISOString(),
    score: 70,
    ci_low: 68,
    ci_high: 72,
    sample_size: 72,
    represented_run_count: 1,
    resolution_seconds: 1,
    synthetic: false,
  };
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
          entry.scoringVersion === '1.0.0',
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
        run_id: official.runId,
        score: official.score,
        ci_low: official.ciLow,
        ci_high: official.ciHigh,
        sample_size: official.sampleSize,
        coverage_percent: official.coveragePercent,
        failures: official.failures,
        missing: official.missing,
        scoring_version: official.scoringVersion,
        score_status: 'official',
        synthetic: false,
      },
      {
        matrix_id: notApplicable.id,
        run_id: 'run_not_applicable',
        score: null,
        ci_low: null,
        ci_high: null,
        sample_size: null,
        coverage_percent: null,
        failures: null,
        missing: null,
        scoring_version: '1.0.0',
        score_status: 'not_applicable',
        synthetic: false,
      },
      {
        matrix_id: missing.id,
        run_id: 'run_missing',
        score: null,
        ci_low: null,
        ci_high: null,
        sample_size: null,
        coverage_percent: null,
        failures: null,
        missing: null,
        scoring_version: '1.0.0',
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
    assert.equal(leaderboardRunHref(joinedOfficial), `/runs/${official.runId}`);
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
      score: 99,
      ci_low: 98,
      ci_high: 100,
      sample_size: 72,
      coverage_percent: 100,
      failures: 0,
      missing: 0,
      scoring_version: '1.0.0',
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

    const unscoredRow = {
      ...baseRow,
      score: null,
      ci_low: null,
      ci_high: null,
      sample_size: null,
      coverage_percent: null,
      failures: null,
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
      run_id: 'run-sol-low',
      score: 70,
      ci_low: 68,
      ci_high: 72,
      sample_size: 72,
      coverage_percent: 100,
      failures: 1,
      missing: 0,
      scoring_version: '1.0.0',
      score_status: 'official',
      synthetic: false,
    };
    for (const rows of [
      [row, row],
      [{ ...row, matrix_id: 'future-low' }],
      [{ ...row, sample_size: Number.NaN }],
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
    assert.equal(formatConfidenceInterval({ ciLow: 78.15, ciHigh: 82.94 }), '78.2–82.9');
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

    const officialEntry = {
      ...syntheticEntry,
      scoreStatus: 'official' as const,
      synthetic: false as const,
    };
    assert.equal(isScoredLeaderboardEntry(officialEntry), true);
    assert.deepEqual(
      {
        status: presentLeaderboardEntry(officialEntry).status,
        evidence: presentLeaderboardEntry(officialEntry).evidence,
      },
      { status: 'Official · 72/72', evidence: 'Published' },
    );
  });

  void it('provides complete synthetic runs and a structured coverage-only run', () => {
    const firstRun = seedRuns[0];
    const coverageOnlyRun = seedRuns.find((run) => run.id.includes('coverage-only'));
    assert.ok(firstRun);
    assert.ok(coverageOnlyRun);
    assert.equal(firstRun.tasks.length, 72);
    assert.equal(firstRun.benchmarkVersion, 'aiq-core@1.0.0');
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
        passed: summarizeRun(coverageOnlyRun).passed,
        failed: summarizeRun(coverageOnlyRun).failed,
        invalid: summarizeRun(coverageOnlyRun).invalid,
        missing: summarizeRun(coverageOnlyRun).missing,
        notApplicable: summarizeRun(coverageOnlyRun).notApplicable,
      },
      { passed: 56, failed: 2, invalid: 0, missing: 14, notApplicable: 0 },
    );
    assert.ok(
      coverageOnlyRun.tasks
        .filter((task) => task.status !== 'passed')
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
      validResults: 58,
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
        Object.assign({}, task, { status: 'not_applicable' as const, score: null }),
      ),
    };
    assert.deepEqual(classifyRunCompleteness(notApplicableRun), {
      label: 'N/A · unsupported in a valid preflight',
      validResults: 0,
      notApplicable: true,
    });
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
      assert.equal(run.tasks.filter((task) => task.status === 'failed').length, entry.failures);
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
      run_id: 'run-latest-in-bucket',
      recorded_at: '2026-07-24T00:00:00.000Z',
      bucket_started_at: '2026-07-23T12:00:00.000Z',
      bucket_ended_at: '2026-07-24T00:00:00.001Z',
      score: 82.4,
      ci_low: 80.1,
      ci_high: 84.7,
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
      scoring_version: '1.0.0',
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
        const explanationSummary = calibrationExplanationSummaryForOutcome(outcome);
        const failureCode = calibrationFailureCodeForOutcome(outcome);
        const index = configurationIndex * 72 + taskIndex;
        return {
          result_id: `result_${index.toString(16).padStart(64, '0')}`,
          run_id: runId,
          task_id: `task-${String(taskIndex).padStart(2, '0')}`,
          task_version: '1',
          domain: 'coding',
          model_family: configuration.modelFamily,
          reasoning_effort: configuration.reasoningEffort,
          outcome,
          status: calibrationStatusForOutcome(outcome),
          failure_code: failureCode,
          explanation_code: failureCode,
          explanation_summary: explanationSummary,
          task_score:
            outcome === 'correct'
              ? 1
              : outcome === 'partial'
                ? 0.5
                : outcome === 'invalid' || outcome === 'missing' || outcome === 'not_applicable'
                  ? null
                  : 0,
          latency_ms: null,
          latency_evidence_level: null,
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
          cost_estimator_limitations: ['Provider usage is unavailable.'],
          cost_method: 'standard_api_equivalent_text_token_estimate',
          cost_version: 'aiq.standard-api-equivalent-usd.v1',
          cost_as_of: '2026-08-02',
          cost_source: 'https://developers.openai.com/api/docs/models/compare',
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
        (result) => result.status === calibrationStatusForOutcome(result.outcome),
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
      selectedRows.map((row, index) => (index === 2 ? { ...row, status: 'passed' } : row)),
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
      scoringVersion: '1.0.0',
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
        return Object.assign({}, task, { status: 'missing' as const, score: null });
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
    const template = seedRuns[0];
    assert.ok(template);
    const rows: RunRow[] = Array.from({ length: 31 }, (_, index) => ({
      id: `run-tie-${String(index).padStart(2, '0')}`,
      matrix_id: template.entryId,
      started_at: '2026-07-24T12:00:00.000Z',
      completed_at: template.completedAt,
      benchmark_version: template.benchmarkVersion,
      scoring_version: template.scoringVersion,
      prompt_set_digest: template.promptSetDigest,
      runner_commit: template.runnerCommit,
      region: template.region,
      synthetic: template.synthetic,
      corpus_release_id: null,
      corpus_commitment_sha256: null,
      catalog_digest: null,
      task_set_digest: null,
      preflight_digest: null,
      runtime_digest: null,
      run_class: null,
      permission_evidence_digest: null,
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
    const requests: URL[] = [];
    const testFetch: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url);
      if (url.searchParams.get('select') === 'id,started_at') {
        const id = url.searchParams.get('id')?.replace(/^eq\./, '');
        return Response.json(rows.filter((row) => row.id === id).slice(0, 1));
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
  });

  void it('positions every current radar node and additional nodes inside the orbit', () => {
    const positions = Array.from({ length: 12 }, (_, index) => radarOrbitPosition(index));
    assert.equal(new Set(positions.map(({ left, top }) => `${left}:${top}`)).size, 12);
    for (const position of positions) {
      assert.ok(Number.parseFloat(position.left) > 0 && Number.parseFloat(position.left) < 100);
      assert.ok(Number.parseFloat(position.top) > 0 && Number.parseFloat(position.top) < 100);
    }
  });

  void it('maps all public run provenance fields and preserves nulls', () => {
    const row: RunRow = {
      id: 'run-provenance',
      matrix_id: 'sol-ultra',
      started_at: '2026-07-26T12:00:00.000Z',
      completed_at: '2026-07-26T12:10:00.000Z',
      benchmark_version: 'aiq-core@1.0.0',
      scoring_version: '1.0.0',
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
      passed_count: 0,
      failed_count: 0,
      invalid_count: 0,
      missing_count: 0,
      not_applicable_count: 0,
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
