import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test as base,
  type APIResponse,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
} from '@playwright/test';

import { resolvePlaywrightCompanionPort } from '../playwright-port.ts';

interface LivePublishedFixtures {
  runtimeFailures: string[];
}

interface PublishedLeaderboardEvidence {
  matrix_id: string;
  run_id: string;
  score: number;
  sensitivity_low: number;
  sensitivity_high: number;
  sample_size: number;
  scoring_version: string;
  synthetic: boolean;
}

interface PublishedTrendEvidence extends PublishedLeaderboardEvidence {
  recorded_at: string;
  bucket_started_at: string;
  bucket_ended_at: string;
}

interface PublishedRunEvidence {
  id: string;
  matrix_id: string;
  started_at: string;
  completed_at: string;
  scoring_version: string;
  synthetic: boolean;
}

interface PublishedResultEvidence {
  run_id: string;
  domain: string;
  outcome: string;
  execution_status: string;
  score: number;
}

const test = base.extend<LivePublishedFixtures>({
  runtimeFailures: [
    async ({ page }, use) => {
      const failures: string[] = [];
      const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === 'error') failures.push(`console: ${message.text()}`);
      };
      const onPageError = (error: Error) => failures.push(`page: ${error.message}`);
      page.on('console', onConsole);
      page.on('pageerror', onPageError);
      await use(failures);
      expect.soft(failures, 'unexpected browser console or page errors').toEqual([]);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
    { auto: true },
  ],
});

const calibrationRunId = `run_${'8'.repeat(64)}`;
const subsetCalibrationRunId = `run_${'7'.repeat(64)}`;

const verifiedPublishedAggregates: Readonly<
  Record<string, { runId: string; score: number; sensitivityLow: number; sensitivityHigh: number }>
> = {
  'sol-low': {
    runId: 'run_441adf403347a1f32c3176e2ca837341e236a8db5ef5ee3059cdc7baa3cac1d7',
    score: 41.959,
    sensitivityLow: 31.377,
    sensitivityHigh: 52.066,
  },
  'sol-medium': {
    runId: 'run_fa605028cfc2d6c94d2ee0769a75d0f5c7bfddfc3b32b0106f525cc328e68930',
    score: 42.801,
    sensitivityLow: 32.474,
    sensitivityHigh: 52.45,
  },
  'sol-high': {
    runId: 'run_37c17d1683b14473966cfc9c4ac8fb97ea16b7f9a0bf2948bd8b234220f6240f',
    score: 42.26,
    sensitivityLow: 32.472,
    sensitivityHigh: 51.524,
  },
  'sol-xhigh': {
    runId: 'run_17b245b7a4b7c46348864a100e70cb0ce47d8f961e4d762ef4b4610e620bee5c',
    score: 42.865,
    sensitivityLow: 31.708,
    sensitivityHigh: 53.996,
  },
  'sol-max': {
    runId: 'run_87c706c0bdc9e7cdfd52eebc9f55661d3cb6c2f2606721dd68fd869df8723093',
    score: 42.397,
    sensitivityLow: 31.196,
    sensitivityHigh: 53.282,
  },
  'sol-ultra': {
    runId: 'run_f43f06eefb714c86d413a802587ba303b16e9a0ddc3de9f4cc01b8ff9e8d3f14',
    score: 40.803,
    sensitivityLow: 28.825,
    sensitivityHigh: 52.294,
  },
  'terra-low': {
    runId: 'run_a8358a9ea1ee1fb19edc9b2c0a3f8909764503d5f1d2c4f2a7161debaac610c4',
    score: 37.299,
    sensitivityLow: 27.509,
    sensitivityHigh: 47.286,
  },
  'terra-medium': {
    runId: 'run_130c49d83c7816a4939cf9851d936e8fa578d2b1d3dcedff5a6c9bbbfae53684',
    score: 40.571,
    sensitivityLow: 29.572,
    sensitivityHigh: 51.103,
  },
  'terra-high': {
    runId: 'run_0f873d71f76b85a0670444fec79be29fb0102e7435b1c1bcb3f0b2d8f50387b4',
    score: 39.117,
    sensitivityLow: 29.328,
    sensitivityHigh: 48.561,
  },
  'terra-xhigh': {
    runId: 'run_834fdafb3146ead1d05f146388e68b99a0f2569a19d92bd2fb9f3de25f93fcc7',
    score: 39.67,
    sensitivityLow: 29.983,
    sensitivityHigh: 48.929,
  },
  'terra-max': {
    runId: 'run_b7415ac6300414b294a668149710c4fecb7a7bec368d25361e4fcc961db7cac4',
    score: 42.432,
    sensitivityLow: 32,
    sensitivityHigh: 52.211,
  },
  'terra-ultra': {
    runId: 'run_db0ba87f356c60ee87a93df4cf730c44b3d511ca65c3310d00acb193686fa685',
    score: 42.347,
    sensitivityLow: 32.279,
    sensitivityHigh: 51.96,
  },
  'luna-low': {
    runId: 'run_ff1d6d7ac0b68f652e28a4437baa9417fbab23789dc60c2b0bb6c6fee4eac71c',
    score: 37.314,
    sensitivityLow: 26.628,
    sensitivityHigh: 47.616,
  },
  'luna-medium': {
    runId: 'run_f4bfbadc40f66cfd7bdd279a9ac025c4fdf6951e61e2f58ccb90b0988090a363',
    score: 39.083,
    sensitivityLow: 29.548,
    sensitivityHigh: 48.834,
  },
  'luna-high': {
    runId: 'run_34f3e4bdea2d80922c016d17f0fb8005ae4a4bfbd7724c0e841384466666dc82',
    score: 41.879,
    sensitivityLow: 31.824,
    sensitivityHigh: 51.618,
  },
  'luna-xhigh': {
    runId: 'run_5b896428917c276cc7aec28f91f48a3572b2b62e1266a89fd568cf8ac3983c8b',
    score: 38.781,
    sensitivityLow: 29.728,
    sensitivityHigh: 48.172,
  },
  'luna-max': {
    runId: 'run_03c1830225ab52b741137eb34847d4432b08f3f57c7e562df4288999f1b48f0d',
    score: 41.39,
    sensitivityLow: 31.042,
    sensitivityHigh: 51.324,
  },
};

function verifiedPublishedAggregate(matrixId: string) {
  const aggregate = verifiedPublishedAggregates[matrixId];
  if (!aggregate) throw new Error(`Missing verified public aggregate for ${matrixId}.`);
  return aggregate;
}

async function expectAlignedControlGroup(group: Locator) {
  await expect(group).toBeAttached();
  const controls = await group.locator(':scope > .chart-control').evaluateAll((elements) =>
    elements.map((control) => {
      const label = control.children[0];
      const action = control.children[1];
      if (!(label instanceof HTMLElement) || !(action instanceof HTMLElement)) {
        throw new Error('Expected each analytical control to contain one label and one action');
      }
      const labelBox = label.getBoundingClientRect();
      const actionBox = action.getBoundingClientRect();
      return {
        labelTop: labelBox.top,
        labelBottom: labelBox.bottom,
        actionTop: actionBox.top,
        actionHeight: actionBox.height,
      };
    }),
  );
  expect(controls.length).toBeGreaterThan(1);
  const labelTops = controls.map(({ labelTop }) => labelTop);
  const actionTops = controls.map(({ actionTop }) => actionTop);
  expect(Math.max(...labelTops) - Math.min(...labelTops)).toBeLessThanOrEqual(0.5);
  expect(Math.max(...actionTops) - Math.min(...actionTops)).toBeLessThanOrEqual(0.5);
  expect(
    controls.every(
      ({ actionHeight, actionTop, labelBottom }) =>
        actionHeight >= 38 && Math.abs(actionTop - labelBottom - 6) <= 0.5,
    ),
  ).toBe(true);
}

const routes = [
  '/',
  '/runs',
  `/runs/${verifiedPublishedAggregate('sol-ultra').runId}`,
  '/calibrations',
  `/calibrations/${calibrationRunId}`,
  `/calibrations/${subsetCalibrationRunId}`,
  '/compare',
  '/trends?range=day',
  '/trends?range=week',
  '/trends?range=month',
  '/trends?range=all',
  '/method',
  '/radar',
] as const;

function expectNotPubliclyCacheable(response: Response | null) {
  const cacheControl = response?.headers()['cache-control'] ?? '';
  expect(cacheControl).toMatch(/\b(?:private|no-store|no-cache)\b/);
  expect(cacheControl).not.toMatch(/\bpublic\b/);
}

function expectNoStore(response: APIResponse) {
  const cacheControl = response.headers()['cache-control'] ?? '';
  expect(cacheControl).toContain('no-store');
  expect(cacheControl).toContain('max-age=0');
}

function companionOrigin(baseURL: string): string {
  const application = new URL(baseURL);
  const applicationPort = Number(application.port);
  if (!Number.isSafeInteger(applicationPort)) {
    throw new Error('The live-published application URL must include one valid port.');
  }
  application.port = String(resolvePlaywrightCompanionPort(applicationPort));
  return application.origin;
}

function parseEvidenceTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  expect(Number.isFinite(timestamp), `invalid evidence timestamp: ${value}`).toBe(true);
  return timestamp;
}

function isEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPublishedLeaderboardEvidence(value: unknown): value is PublishedLeaderboardEvidence {
  return (
    isEvidenceRecord(value) &&
    typeof value.matrix_id === 'string' &&
    typeof value.run_id === 'string' &&
    typeof value.score === 'number' &&
    typeof value.sensitivity_low === 'number' &&
    typeof value.sensitivity_high === 'number' &&
    typeof value.sample_size === 'number' &&
    typeof value.scoring_version === 'string' &&
    typeof value.synthetic === 'boolean'
  );
}

function isPublishedTrendEvidence(value: unknown): value is PublishedTrendEvidence {
  return (
    isPublishedLeaderboardEvidence(value) &&
    isEvidenceRecord(value) &&
    typeof value.recorded_at === 'string' &&
    typeof value.bucket_started_at === 'string' &&
    typeof value.bucket_ended_at === 'string'
  );
}

function isPublishedRunEvidence(value: unknown): value is PublishedRunEvidence {
  return (
    isEvidenceRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.matrix_id === 'string' &&
    typeof value.started_at === 'string' &&
    typeof value.completed_at === 'string' &&
    typeof value.scoring_version === 'string' &&
    typeof value.synthetic === 'boolean'
  );
}

function isPublishedResultEvidence(value: unknown): value is PublishedResultEvidence {
  return (
    isEvidenceRecord(value) &&
    typeof value.run_id === 'string' &&
    typeof value.domain === 'string' &&
    typeof value.outcome === 'string' &&
    typeof value.execution_status === 'string' &&
    typeof value.score === 'number'
  );
}

const officialDomainTaskCounts = [
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
] as const;

function recomputeEqualDomainAiq(results: readonly PublishedResultEvidence[]): number {
  if (results.length !== 72) throw new Error('Official result evidence must contain 72 rows.');
  const domainMeans = officialDomainTaskCounts.map(([domain, expectedTaskCount]) => {
    const scores = results.filter((result) => result.domain === domain).map(({ score }) => score);
    if (
      scores.length !== expectedTaskCount ||
      scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      throw new Error(`Invalid ${domain} score evidence.`);
    }
    return scores.reduce((total, score) => total + score, 0) / scores.length;
  });
  return (100 * domainMeans.reduce((total, score) => total + score, 0)) / domainMeans.length;
}

function evidenceRows<T>(value: unknown, isRow: (row: unknown) => row is T, subject: string): T[] {
  if (!Array.isArray(value) || !value.every(isRow)) {
    throw new Error(`Invalid ${subject} fixture evidence.`);
  }
  return value;
}

async function expectNoDocumentOverflow(page: Page, testInfo: TestInfo) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${testInfo.project.name} document width ${dimensions.scrollWidth} exceeds ${dimensions.clientWidth}`,
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

for (const route of routes) {
  test(`${route} renders published live evidence accessibly`, async ({ page }, testInfo) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    expectNotPubliclyCacheable(response);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.locator('.live-pill')).toHaveClass(/status-public/);
    if (route.startsWith('/trends')) {
      const evidenceDisclosure = page.locator('details.evidence-status-disclosure');
      await expect(evidenceDisclosure).not.toHaveAttribute('open', '');
      await evidenceDisclosure.locator('summary').click();
      await expect(evidenceDisclosure).toHaveAttribute('open', '');
    }
    if (route === '/compare') {
      await page.locator('main details.evidence-notes > summary').first().click();
    }
    await expect(page.getByText('Published evidence', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText('Demo values are synthetic seed data', { exact: false }),
    ).toHaveCount(0);
    expect(await new AxeBuilder({ page }).analyze()).toMatchObject({ violations: [] });
    await expectNoDocumentOverflow(page, testInfo);
  });
}

test('the live overview exposes all 17 published configurations without seed substitution', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Latest benchmark' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Top configurations' })).toBeVisible();
  await expect(page.getByText('Published Aug 3, 2026', { exact: false })).toBeVisible();
  await page.locator('[data-homepage-analytics="matrix"]').scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: 'AIQ index by configuration' })).toBeVisible();
  await expect(page.locator('.matrix-chart-svg svg')).toBeVisible();
  await expect(page.locator('.matrix-chart-svg canvas')).toHaveCount(0);
  await page.getByText('Read all configuration values as a table', { exact: true }).click();
  const leaderboardRegion = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  await expect(leaderboardRegion.getByRole('row')).toHaveCount(18);
  await expect(leaderboardRegion.getByRole('link', { name: 'Inspect' })).toHaveCount(17);
  await expect(page.getByText('1,224 task cells', { exact: false })).toBeVisible();
  await page.locator('[data-homepage-analytics="efficiency"]').scrollIntoViewIfNeeded();
  const efficiencyPlot = page.getByRole('region', {
    name: 'AIQ score vs total run time',
  });
  await expect(efficiencyPlot).toBeVisible();
  await expect(efficiencyPlot).toContainText('Lower and left is more efficient');
  await expect(efficiencyPlot.locator('.efficiency-chart svg')).toBeVisible();
  await expect(efficiencyPlot.locator('canvas')).toHaveCount(0);
  await expect(efficiencyPlot).toContainText(
    '16/17 configurations plotted in the canonical matrix',
  );
  await Promise.all([
    expectAlignedControlGroup(efficiencyPlot.locator('.chart-controls')),
    expectAlignedControlGroup(page.locator('.matrix-chart .chart-controls')),
    expectAlignedControlGroup(page.locator('.trend-mode-control')),
  ]);
  await efficiencyPlot.getByRole('button', { name: 'Cost', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'AIQ score vs API-equivalent cost' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'AIQ score vs API-equivalent cost' }),
  ).toContainText('1/17 configurations plotted in the canonical matrix');
  await page.locator('#results > details.evidence-notes > summary').click();
  await page.getByText('Latest non-ranking calibration evidence', { exact: true }).click();
  await expect(
    page.getByText(/not Official.*not ranking eligible/, { exact: false }).first(),
  ).toBeVisible();
  const calibrationEfficiency = page.getByRole('region', {
    name: 'Calibration model efficiency',
  });
  await expect(calibrationEfficiency.getByRole('row')).toHaveCount(2);
  await expect(
    calibrationEfficiency.getByRole('row').filter({ hasText: 'terra · medium' }),
  ).toBeVisible();
  await expect(page.locator('.calibration-chart svg')).toHaveCount(1);
  await expect(page.locator('.calibration-chart canvas')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Inspect calibration' })).toHaveAttribute(
    'href',
    `/calibrations/${subsetCalibrationRunId}`,
  );
  await page.getByText('Time, token, and cost table', { exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Official model efficiency' }).getByRole('row'),
  ).toHaveCount(18);
  const officialEfficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await expect(officialEfficiency).toContainText('1.6 h');
  await expect(officialEfficiency).toContainText('unavailable missing usage');
  await expect(officialEfficiency).toContainText('0/72 priced');
  await expect(officialEfficiency).not.toContainText('$0');
});

test('the public index reports runtime issues without conflating evaluator outcomes', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-homepage-analytics="matrix"]').scrollIntoViewIfNeeded();
  await page.getByText('Read all configuration values as a table', { exact: true }).click();
  const publicIndex = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  await expect(publicIndex.getByRole('row')).toHaveCount(18);
  const runtimeIssues = await publicIndex.locator('tbody tr td:nth-child(6)').allTextContents();
  expect(runtimeIssues.reduce((sum, value) => sum + Number(value.trim()), 0)).toBe(6);
  await expect(publicIndex.getByRole('columnheader', { name: 'Runtime issues' })).toBeVisible();
});

test('a partial Terra-only calibration derives a valid default and reports its selected subset', async ({
  page,
  request,
}) => {
  await page.goto('/calibrations');
  const register = page.getByRole('region', { name: 'Public calibration register' });
  await expect(register.getByRole('row')).toHaveCount(3);
  await expect(register).toContainText('1 models × 5 tasks');
  await register.getByRole('link', { name: 'Inspect calibration' }).first().click();

  await expect(page).toHaveURL(`/calibrations/${subsetCalibrationRunId}`);
  await expect(page.getByText('Current filter', { exact: true }).locator('..')).toContainText(
    'terra · medium',
  );
  await expect(page.getByRole('status', { name: 'Calibration result count' })).toContainText(
    'Showing 5 of 5 result cells',
  );
  await expect(page.getByLabel('Model and reasoning configuration').locator('option')).toHaveCount(
    1,
  );
  await expect(page.getByRole('button', { name: 'Show 5-task subset' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Calibration results' }).getByRole('row'),
  ).toHaveCount(6);

  const absentConfiguration = await request.get(
    `/calibrations/${subsetCalibrationRunId}?configuration=sol%3Alow`,
  );
  expect(absentConfiguration.status()).toBe(404);
  expectNoStore(absentConfiguration);

  const absentRun = await request.get(`/calibrations/run_${'6'.repeat(64)}`);
  expect(absentRun.status()).toBe(404);
  expectNoStore(absentRun);
});

test('full calibration detail keeps one run and one selected-task subset bounded', async ({
  page,
  request,
}) => {
  await page.goto(`/calibrations/${calibrationRunId}`);
  await expect(page).toHaveURL(`/calibrations/${calibrationRunId}`);
  await expect(page.getByText('Current filter', { exact: true }).locator('..')).toContainText(
    'sol · low',
  );
  await expect(page.getByRole('status', { name: 'Calibration result count' })).toContainText(
    'Showing 72 of 1,224 result cells',
  );
  const selector = page.getByLabel('Model and reasoning configuration');
  await expect(selector.locator('option')).toHaveCount(17);
  const results = page.getByRole('region', { name: 'Calibration results' });
  await expect(results.getByRole('row')).toHaveCount(73);
  await expect(page.locator('.calibration-chart svg')).toHaveCount(1);
  await expect(page.locator('.calibration-chart canvas')).toHaveCount(0);
  const workspaceIntegrity = results
    .getByRole('row')
    .filter({ hasText: 'aiq-v1-calibration-task-01' });
  await expect(workspaceIntegrity).toContainText('invalid');
  await expect(workspaceIntegrity).toContainText('workspace_integrity');
  await expect(workspaceIntegrity).toContainText(
    'Benchmark infrastructure invalidated this result; an audited rerun is required.',
  );
  await expect(workspaceIntegrity).toContainText('8.0 s');
  await expect(workspaceIntegrity).toContainText('$0.000650');
  const contextBandResult = results
    .getByRole('row')
    .filter({ hasText: 'aiq-v1-calibration-task-02' });
  await expect(contextBandResult).toContainText('Unavailable');
  await expect(contextBandResult).toContainText('unavailable context band');
  await expect(contextBandResult).toContainText(
    'a result above 272000 aggregate input tokens is therefore unpriced',
  );

  await selector.selectOption('terra:medium');
  await page.getByRole('button', { name: 'Show 72-task subset' }).click();
  await expect(page).toHaveURL(`/calibrations/${calibrationRunId}?configuration=terra%3Amedium`);
  await expect(page.getByText('Current filter', { exact: true }).locator('..')).toContainText(
    'terra · medium',
  );
  await expect(results.getByRole('row')).toHaveCount(73);

  const invalid = await request.get(`/calibrations/${calibrationRunId}?configuration=luna%3Aultra`);
  expect(invalid.status()).toBe(404);
  expectNoStore(invalid);
});

test('Official compare efficiency is limited to the two selected run identities', async ({
  page,
}) => {
  await page.goto('/compare');
  const comparison = page.getByRole('table', { name: 'Selected comparison' });
  await expect(comparison.getByRole('row')).toHaveCount(7);
  const cost = comparison.getByRole('row').filter({ hasText: 'API-equivalent cost' });
  await expect(cost.getByRole('cell').first()).toHaveText('$12.3456');
  await expect(cost.getByRole('cell').nth(1)).toHaveText('Unavailable');
  await page.getByText('Exact run, provenance, and metric coverage', { exact: true }).click();
  const evidence = page.getByRole('table', { name: 'Comparison evidence details' });
  await expect(evidence.getByRole('row')).toHaveCount(8);
  const batch = evidence.getByRole('row').filter({ hasText: 'Batch wall-clock' });
  await expect(batch.getByRole('cell')).toHaveText(['1.6 h', '1.6 h']);
  const durationCoverage = evidence.getByRole('row').filter({ hasText: 'Duration coverage' });
  await expect(durationCoverage.getByRole('cell')).toHaveText(['72/72 (100.0%)', '72/72 (100.0%)']);
  await expect(comparison).not.toContainText(calibrationRunId);
  await expect(comparison).not.toContainText('$0');
});

test('published leaderboard, trends, runs, and results share coherent score evidence', async ({
  baseURL,
  request,
}) => {
  expect(baseURL).toBeDefined();
  const origin = companionOrigin(baseURL ?? '');
  const [leaderboardResponse, trendsResponse, runsResponse, resultsResponse] = await Promise.all([
    request.get(`${origin}/rest/v1/public_leaderboard?limit=1000`),
    request.post(`${origin}/rest/v1/rpc/public_trend_points`, {
      data: { supplied_range: 'all' },
    }),
    request.get(`${origin}/rest/v1/public_runs?limit=1000`),
    request.get(
      `${origin}/rest/v1/public_run_results?select=run_id,domain,outcome,execution_status,score&limit=2000`,
    ),
  ]);
  expect(leaderboardResponse.status()).toBe(200);
  expect(trendsResponse.status()).toBe(200);
  expect(runsResponse.status()).toBe(200);
  expect(resultsResponse.status()).toBe(200);

  const leaderboardPayload: unknown = await leaderboardResponse.json();
  const trendsPayload: unknown = await trendsResponse.json();
  const runsPayload: unknown = await runsResponse.json();
  const resultsPayload: unknown = await resultsResponse.json();
  const leaderboard = evidenceRows(
    leaderboardPayload,
    isPublishedLeaderboardEvidence,
    'leaderboard',
  );
  const trends = evidenceRows(trendsPayload, isPublishedTrendEvidence, 'trend');
  const runs = evidenceRows(runsPayload, isPublishedRunEvidence, 'run');
  const results = evidenceRows(resultsPayload, isPublishedResultEvidence, 'result');
  expect(leaderboard).toHaveLength(17);
  expect(trends).toHaveLength(17);
  expect(runs).toHaveLength(17);
  expect(results).toHaveLength(1_224);
  expect(leaderboard.every((row) => !row.synthetic)).toBe(true);
  expect(trends.every((row) => !row.synthetic)).toBe(true);
  expect(runs.every((row) => !row.synthetic)).toBe(true);
  expect(new Set(trends.map((row) => row.run_id)).size).toBe(trends.length);
  expect(new Set(runs.map((row) => row.id)).size).toBe(runs.length);

  for (const current of leaderboard) {
    const verified = verifiedPublishedAggregate(current.matrix_id);
    expect(current).toMatchObject({
      run_id: verified.runId,
      score: verified.score,
      sensitivity_low: verified.sensitivityLow,
      sensitivity_high: verified.sensitivityHigh,
    });
  }

  const leaderboardByRunId = new Map(leaderboard.map((row) => [row.run_id, row]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const resultsByRunId = new Map<string, PublishedResultEvidence[]>();
  for (const result of results) {
    const retained = resultsByRunId.get(result.run_id) ?? [];
    retained.push(result);
    resultsByRunId.set(result.run_id, retained);
  }
  expect(resultsByRunId.size).toBe(17);
  let sharedRunCount = 0;
  for (const trend of trends) {
    const run = runsById.get(trend.run_id);
    expect(run, `missing run evidence for ${trend.run_id}`).toBeDefined();
    if (!run) continue;
    expect(run.matrix_id).toBe(trend.matrix_id);
    expect(run.scoring_version).toBe(trend.scoring_version);
    const runStartedAt = parseEvidenceTimestamp(run.started_at);
    const runCompletedAt = parseEvidenceTimestamp(run.completed_at);
    const recordedAt = parseEvidenceTimestamp(trend.recorded_at);
    const bucketStartedAt = parseEvidenceTimestamp(trend.bucket_started_at);
    const bucketEndedAt = parseEvidenceTimestamp(trend.bucket_ended_at);
    expect(runStartedAt).toBeLessThanOrEqual(runCompletedAt);
    expect(runCompletedAt).toBeLessThanOrEqual(recordedAt);
    expect(bucketStartedAt).toBeLessThanOrEqual(recordedAt);
    expect(recordedAt).toBeLessThanOrEqual(bucketEndedAt);

    const current = leaderboardByRunId.get(trend.run_id);
    if (!current) continue;
    sharedRunCount += 1;
    const runResults = resultsByRunId.get(current.run_id);
    expect(runResults, `missing task results for ${current.run_id}`).toBeDefined();
    if (!runResults) continue;
    const recomputedAiq = Number(recomputeEqualDomainAiq(runResults).toFixed(3));
    expect(recomputedAiq).toBe(current.score);
    expect(recomputedAiq).toBe(trend.score);
    expect(current.sensitivity_low).toBeLessThanOrEqual(recomputedAiq);
    expect(current.sensitivity_high).toBeGreaterThanOrEqual(recomputedAiq);
    expect(trend).toMatchObject({
      matrix_id: current.matrix_id,
      run_id: current.run_id,
      score: current.score,
      sensitivity_low: current.sensitivity_low,
      sensitivity_high: current.sensitivity_high,
      sample_size: current.sample_size,
      scoring_version: current.scoring_version,
    });
  }
  expect(sharedRunCount).toBe(leaderboard.length);

  for (const current of leaderboard) {
    const retained = trends.filter((trend) => trend.matrix_id === current.matrix_id);
    retained.sort((left, right) => right.recorded_at.localeCompare(left.recorded_at));
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      run_id: current.run_id,
      score: current.score,
      sensitivity_low: current.sensitivity_low,
      sensitivity_high: current.sensitivity_high,
      sample_size: current.sample_size,
      scoring_version: current.scoring_version,
    });
  }

  expect(results.filter((result) => result.outcome === 'correct')).toHaveLength(329);
  expect(results.filter((result) => result.outcome === 'partial')).toHaveLength(259);
  expect(results.filter((result) => result.outcome === 'incorrect')).toHaveLength(630);
  expect(results.filter((result) => result.outcome === 'timeout')).toHaveLength(5);
  expect(results.filter((result) => result.outcome === 'budget_exhausted')).toHaveLength(1);
  expect(new Set(results.map((result) => result.outcome))).toEqual(
    new Set(['correct', 'partial', 'incorrect', 'timeout', 'budget_exhausted']),
  );
  expect(results.filter((result) => result.execution_status === 'completed')).toHaveLength(1_218);
  expect(results.filter((result) => result.execution_status === 'runtime_issue')).toHaveLength(6);
  expect(new Set(results.map((result) => result.execution_status))).toEqual(
    new Set(['completed', 'runtime_issue']),
  );
  expect(
    results.every((result) => {
      if (result.outcome === 'correct') return result.score === 1;
      if (result.outcome === 'partial') return result.score > 0 && result.score < 1;
      return result.score === 0;
    }),
  ).toBe(true);
});

test('Official trends expose current time and cost evidence', async ({ page }) => {
  await page.goto('/trends?range=all');
  await page.getByText('Evidence notes and visible values', { exact: true }).click();
  const values = page.getByRole('region', { name: 'Visible trend values' });
  await expect(values.getByRole('row')).toHaveCount(7);
  await expect(values.getByRole('columnheader', { name: 'Coverage' })).toBeVisible();
  await expect(values.getByRole('columnheader', { name: 'Runtime' })).toBeVisible();
  await expect(values.getByRole('columnheader', { name: 'Missing' })).toBeVisible();
  await expect(values.getByRole('columnheader', { name: 'Summed adapter duration' })).toBeVisible();
  await expect(values.getByRole('columnheader', { name: 'API-equivalent cost' })).toBeVisible();
  await expect(values).toContainText('$12.3456');
  await expect(values).toContainText('Unavailable');
  await expect(values).not.toContainText('$0');
});

test('the published run exposes complete task and provenance evidence', async ({ page }) => {
  await page.goto(`/runs/${verifiedPublishedAggregate('sol-ultra').runId}`);
  await expect(page.locator('.task-list > article')).toHaveCount(72);
  await page.locator('details.run-evidence-notes > summary').click();
  await expect(page.getByText('Official', { exact: true })).toBeVisible();
  await expect(page.getByText('Correct', { exact: true }).locator('..')).toContainText('19');
  await expect(page.getByText('Partial', { exact: true }).locator('..')).toContainText('16');
  await expect(page.getByText('Incorrect', { exact: true }).locator('..')).toContainText('35');
  await expect(
    page.locator('.run-stats').getByText('Runtime issue', { exact: true }).locator('..'),
  ).toContainText('2');
  const provenance = page.getByRole('heading', { name: 'Run provenance' }).locator('..');
  await expect(provenance).toContainText('corpus_2026.08.02-aiq-core-1.0.2-controlled.1');
  await expect(provenance).toContainText(`sha256:${'9'.repeat(64)}`);
  await expect(provenance.getByText('Not published', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Time, token coverage, and cost' })).toBeVisible();
  await expect(
    page.getByText('Neither value is isolated model latency.', { exact: false }),
  ).toBeVisible();
  const efficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await expect(efficiency).toContainText('1.6 h');
  await expect(efficiency).toContainText('unavailable missing usage');
  await expect(efficiency).not.toContainText('$0');
  const taskResults = page.locator('.task-list > article');
  await expect(taskResults.first()).toContainText('Codex adapter elapsed:');
  await expect(taskResults.first()).toContainText('Tokens: input 1,361');
  await expect(taskResults.first()).toContainText('total unavailable');
  await expect(taskResults.first()).toContainText(
    'Estimated Standard API-equivalent cost: $0.020968 · token evidence verifier-recomputed · cost evidence verifier-recomputed',
  );
  const evaluatorOutcomes = taskResults.filter({
    hasText: 'The evaluator rejected the response.',
  });
  await expect(evaluatorOutcomes).toHaveCount(35);
  await expect(evaluatorOutcomes.first()).toContainText('Published outcome');
  await expect(evaluatorOutcomes.first()).toContainText('incorrect · completed');
  await expect(evaluatorOutcomes.first()).not.toContainText('EXPLANATION_NOT_PUBLISHED');
  await page.goto(`/runs/${verifiedPublishedAggregate('sol-max').runId}`);
  const timeout = page.locator('.task-list > article').filter({ hasText: 'timeout' });
  await expect(timeout).toHaveCount(1);
  await expect(timeout).toContainText('The task exceeded its time limit.');
  await expect(timeout).toContainText('Retryable: yes');

  await page.goto(`/runs/${verifiedPublishedAggregate('luna-max').runId}`);
  const budgetExceeded = page.locator('.task-list > article').filter({
    hasText: 'budget_exceeded',
  });
  await expect(budgetExceeded).toHaveCount(1);
  await expect(budgetExceeded).toContainText('The task exceeded a resource budget.');
  await expect(budgetExceeded).toContainText('Retryable: no');
});

test('the published method and radar retain versioned, signed provenance', async ({ page }) => {
  await page.goto('/method');
  await expect(page.getByText('aiq-core@1.0.2', { exact: true })).toBeVisible();
  await expect(page.getByText('1.0.2', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'official OpenAI API pricing documentation' }),
  ).toHaveAttribute('href', 'https://developers.openai.com/api/docs/pricing');
  await expect(
    page.getByRole('link', {
      name: 'Prompts above 272,000 input tokens use 2× input and 1.5× output rates',
    }),
  ).toHaveAttribute('href', 'https://developers.openai.com/api/docs/pricing');
  await expect(page.getByText('unavailable context band status', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '72 tasks · 10 equally weighted domains' }),
  ).toBeVisible();

  await page.goto('/radar');
  await page.locator('details.radar-node-details > summary').click();
  await expect(page.getByText('Registry trust: trusted verified', { exact: true })).toBeVisible();
  await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Verified observation signatures').locator('..')).toContainText('1');
  await expect(page.getByText('Receiver-verified trusted', { exact: true })).toBeVisible();
});

test('the readiness route reports successful bounded loopback dependency probes', async ({
  request,
}) => {
  const response = await request.get('/api/readiness');
  expect(response.status()).toBe(200);
  expectNoStore(response);
  expect(await response.json()).toMatchObject({
    state: 'local_dependencies_ready',
    scope_ready: true,
    mode: 'non_production',
    checks: {
      runtime_mode: 'non_production',
      configuration: 'valid',
      dependencies: 'available',
    },
  });
});
