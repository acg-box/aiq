import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAiqRepository,
  PreviewAiqRepository,
  RUN_HISTORY_PAGE_SIZE,
  SupabaseAiqRepository,
  type PreviewStatusRow,
  type PreviewStatusSource,
} from './repository.ts';
import {
  seedLeaderboard,
  seedMethodology,
  seedRadarNodes,
  seedRuns,
  seedTrendPoints,
} from './seed.ts';
import type {
  BenchmarkRun,
  CalibrationModelSelection,
  CalibrationRunPage,
  CalibrationRunPageRequest,
  LeaderboardEntry,
  Methodology,
  PublicCalibrationRun,
  PublicCalibrationScore,
  PublicModelEfficiency,
  RadarNode,
  RunHistoryPage,
  RunHistoryPageRequest,
  TrendPoint,
  TrendRange,
} from './types.ts';

const validStatus = {
  contract_version: 'aiq.preview-status.v1',
  profile_id: 'acgbox-aiq-preview-v1',
  canonical_model_matrix: true,
  task_count: 72,
  model_configuration_count: 17,
  synthetic_run_count: 17,
  synthetic_task_result_count: 1_224,
  synthetic_score_snapshot_count: 17,
  synthetic_scoring_definition_count: 1,
  synthetic_radar_node_count: 3,
  published_run_count: 0,
  published_leaderboard_count: 0,
  published_trend_point_count: 0,
  calibration_run_count: 0,
  calibration_result_count: 0,
  calibration_score_count: 0,
  non_synthetic_evidence_count: 0,
} as const satisfies PreviewStatusRow;

class LivePreviewFixtureRepository implements PreviewStatusSource {
  readonly mode = 'live' as const;
  readonly configuration = 'live' as const;
  statusRows: unknown = [validStatus];
  statusError: Error | undefined;
  statusReads = 0;
  publicDataReads = 0;

  async readPreviewStatusRows(): Promise<unknown> {
    this.statusReads += 1;
    if (this.statusError) throw this.statusError;
    return this.statusRows;
  }

  async listLeaderboard(): Promise<readonly LeaderboardEntry[]> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live leaderboard rows');
  }

  async listTrendPoints(_range?: TrendRange): Promise<readonly TrendPoint[]> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live trend rows');
  }

  async listRunPage(_request?: RunHistoryPageRequest): Promise<RunHistoryPage> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live run rows');
  }

  async getRun(_id: string): Promise<BenchmarkRun | null> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live run detail');
  }
  async listCalibrationRunPage(_request?: CalibrationRunPageRequest): Promise<CalibrationRunPage> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live calibration rows');
  }
  async getCalibrationRun(
    _id: string,
    _selection: CalibrationModelSelection,
  ): Promise<PublicCalibrationRun | null> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live calibration detail');
  }
  async listCalibrationScores(_runId: string): Promise<readonly PublicCalibrationScore[]> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live calibration scores');
  }
  async listModelEfficiency(_runIds: readonly string[]): Promise<readonly PublicModelEfficiency[]> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live model efficiency rows');
  }

  async getMethodology(): Promise<Methodology> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live methodology rows');
  }

  async listRadarNodes(): Promise<readonly RadarNode[]> {
    this.publicDataReads += 1;
    throw new Error('preview must not read live radar rows');
  }
}

void describe('AIQ Wiki preview repository', () => {
  void it('validates one status row once and serves every explicit fixture without more live reads', async () => {
    const live = new LivePreviewFixtureRepository();
    const preview = new PreviewAiqRepository(live);

    assert.equal(preview.mode, 'synthetic');
    assert.equal(preview.configuration, 'live');
    assert.deepEqual(await preview.listLeaderboard(), seedLeaderboard);
    const page = await preview.listRunPage();
    assert.equal(page.runs.length, RUN_HISTORY_PAGE_SIZE);
    assert.ok(page.runs.every((run) => run.synthetic));
    const firstRun = seedRuns[0];
    assert.ok(firstRun);
    assert.deepEqual(await preview.getRun(firstRun.id), firstRun);
    assert.deepEqual(await preview.listTrendPoints('all'), seedTrendPoints);
    assert.deepEqual(await preview.getMethodology(), seedMethodology);
    assert.deepEqual(await preview.listRadarNodes(), seedRadarNodes);
    assert.deepEqual(await preview.listCalibrationRunPage(), {
      runs: [],
      newerCursor: null,
      olderCursor: null,
    });
    assert.equal(
      await preview.getCalibrationRun('missing', {
        modelFamily: 'sol',
        reasoningEffort: 'low',
      }),
      null,
    );
    assert.deepEqual(await preview.listCalibrationScores('missing'), []);
    assert.deepEqual(await preview.listModelEfficiency([]), []);
    assert.equal(live.statusReads, 1);
    assert.equal(live.publicDataReads, 0);
  });

  void it('uses one bounded Supabase status-view request for all preview methods', async () => {
    const requests: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      requests.push(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      return Response.json([validStatus]);
    };
    const live = new SupabaseAiqRepository(
      'http://127.0.0.1:54321',
      'sb_publishable_preview_status_test',
      fetchImplementation,
    );
    const preview = new PreviewAiqRepository(live);

    await Promise.all([
      preview.listLeaderboard(),
      preview.listTrendPoints(),
      preview.listRunPage(),
      preview.getRun(seedRuns[0]?.id ?? 'missing'),
      preview.getMethodology(),
      preview.listRadarNodes(),
    ]);

    assert.equal(requests.length, 1);
    const requestUrl = new URL(requests[0] ?? 'invalid:');
    assert.equal(requestUrl.pathname, '/rest/v1/aiq_preview_status_v1');
    assert.equal(requestUrl.searchParams.get('limit'), '2');
    assert.deepEqual(
      new Set(requestUrl.searchParams.get('select')?.split(',')),
      new Set(Object.keys(validStatus)),
    );
  });

  void it('rejects missing and multiple status rows', async () => {
    await Promise.all(
      [[], [validStatus, validStatus]].map(async (statusRows) => {
        const live = new LivePreviewFixtureRepository();
        live.statusRows = statusRows;
        await assert.rejects(new PreviewAiqRepository(live).listLeaderboard(), /exactly one/);
      }),
    );
  });

  void it('rejects malformed status identity, shape, and counts', async () => {
    const malformedRows: unknown[] = [
      null,
      { ...validStatus, contract_version: 'aiq.preview-status.v2' },
      { ...validStatus, profile_id: 'another-preview' },
      { ...validStatus, canonical_model_matrix: false },
      { ...validStatus, task_count: '72' },
      { ...validStatus, model_configuration_count: 16 },
      { ...validStatus, synthetic_run_count: 16 },
      { ...validStatus, synthetic_task_result_count: 1_223 },
      { ...validStatus, synthetic_score_snapshot_count: 16 },
      { ...validStatus, synthetic_scoring_definition_count: 0 },
      { ...validStatus, synthetic_radar_node_count: 2 },
      { ...validStatus, extra_field: true },
    ];
    await Promise.all(
      malformedRows.map(async (row) => {
        const live = new LivePreviewFixtureRepository();
        live.statusRows = [row];
        await assert.rejects(new PreviewAiqRepository(live).listLeaderboard(), /fixture contract/);
      }),
    );
  });

  void it('rejects all nonempty publication and non-synthetic evidence counts', async () => {
    await Promise.all(
      [
        'published_run_count',
        'published_leaderboard_count',
        'published_trend_point_count',
        'non_synthetic_evidence_count',
      ].map(async (field) => {
        const live = new LivePreviewFixtureRepository();
        live.statusRows = [{ ...validStatus, [field]: 1 }];
        await assert.rejects(new PreviewAiqRepository(live).listLeaderboard(), /fixture contract/);
      }),
    );
  });

  void it('caches and propagates an upstream status failure without seed substitution', async () => {
    const live = new LivePreviewFixtureRepository();
    live.statusError = new Error('bounded upstream failure');
    const preview = new PreviewAiqRepository(live);
    await assert.rejects(preview.listLeaderboard(), /bounded upstream failure/);
    await assert.rejects(preview.listRadarNodes(), /bounded upstream failure/);
    assert.equal(live.statusReads, 1);
    assert.equal(live.publicDataReads, 0);
  });

  void it('fails closed when preview has no live browser-safe configuration', async () => {
    const repository = createAiqRepository({
      AIQ_DEPLOYMENT_PROFILE: 'preview',
      NODE_ENV: 'production',
    });
    assert.equal(repository.configuration, 'invalid');
    await assert.rejects(repository.listLeaderboard(), /preview requires both browser-safe/);
  });
});
