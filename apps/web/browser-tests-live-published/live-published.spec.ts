import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test as base,
  type APIResponse,
  type Page,
  type Response,
  type TestInfo,
} from '@playwright/test';

interface LivePublishedFixtures {
  runtimeFailures: string[];
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

const routes = [
  '/',
  '/runs',
  '/runs/run-live-sol-ultra',
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
    await expect(page.locator('main h1')).toBeVisible();
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
  await expect(page.getByText('Highest published point estimate', { exact: true })).toBeVisible();
  const leaderboardRegion = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  await expect(leaderboardRegion.getByRole('row')).toHaveCount(18);
  await expect(leaderboardRegion.getByRole('link', { name: 'Inspect' })).toHaveCount(17);
  await expect(
    page.getByRole('region', { name: 'Index summary' }).getByText('17', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Latest verified calibration' })).toBeVisible();
  await expect(
    page.getByText('not Official / not ranking eligible', { exact: false }),
  ).toBeVisible();
  const calibrationEfficiency = page.getByRole('region', {
    name: 'Calibration model efficiency',
  });
  await expect(calibrationEfficiency.getByRole('row')).toHaveCount(2);
  await expect(
    calibrationEfficiency.getByRole('row').filter({ hasText: 'terra · medium' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Inspect the bounded 5-task subsets' }),
  ).toHaveAttribute('href', `/calibrations/${subsetCalibrationRunId}`);
  await expect(
    page.getByRole('heading', { name: 'Official time, tokens, and cost' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Official model efficiency' }).getByRole('row'),
  ).toHaveCount(18);
  const officialEfficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await expect(officialEfficiency).toContainText('1.6 h');
  await expect(officialEfficiency).toContainText('unavailable missing usage');
  await expect(officialEfficiency).toContainText('0/72 priced');
  await expect(officialEfficiency).not.toContainText('$0');
});

test('the public index preserves the 588 passed and 636 failed public outcomes', async ({
  page,
}) => {
  await page.goto('/');
  const publicIndex = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  await expect(publicIndex.getByRole('row')).toHaveCount(18);
  const failedAndMissing = await publicIndex.locator('tbody tr td:nth-child(6)').allTextContents();
  const failed = failedAndMissing.reduce(
    (sum, value) => sum + Number(value.split('/')[0]?.trim()),
    0,
  );
  expect(failed).toBe(636);
  expect(17 * 72 - failed).toBe(588);
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
  await expect(page.getByRole('status')).toContainText('Showing 5 of 5 result cells');
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
  await expect(page.getByRole('status')).toContainText('Showing 72 of 1,224 result cells');
  const selector = page.getByLabel('Model and reasoning configuration');
  await expect(selector.locator('option')).toHaveCount(17);
  const results = page.getByRole('region', { name: 'Calibration results' });
  await expect(results.getByRole('row')).toHaveCount(73);
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

test('Official compare efficiency is limited to current leaderboard run identities', async ({
  page,
}) => {
  await page.goto('/compare');
  const efficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await expect(efficiency.getByRole('row')).toHaveCount(18);
  await expect(efficiency).toContainText('run-live-sol-low');
  await expect(efficiency).not.toContainText(calibrationRunId);
  const missingUsageEfficiency = efficiency.getByRole('row').filter({ hasText: 'sol · medium' });
  await expect(missingUsageEfficiency).toContainText('Unavailable');
  await expect(missingUsageEfficiency).toContainText('unavailable missing usage');
  await expect(missingUsageEfficiency).toContainText('input unavailable (unavailable)');
  await expect(efficiency).toContainText(
    '72 results · 72 attempted · 72 adapter-invoked · concurrency 17',
  );
  await expect(efficiency).toContainText(
    'Reasoning is a subset of output and is not charged twice.',
  );
  await expect(efficiency).toContainText(
    'gpt-5.6-terra: input 2000, cached input 200, cache-write input 2500, output 12000 USD nanos/token',
  );
  await expect(efficiency).toContainText(
    'gpt-5.6-luna: input 200, cached input 20, cache-write input 250, output 1200 USD nanos/token',
  );
  await expect(efficiency).toContainText('Signed matrix batch wall-clock');
  await expect(efficiency).toContainText('1.6 h');
  await expect(efficiency).toContainText('count once across all 17 configurations');
  await expect(efficiency).toContainText('TTFT and TPS are unavailable');
  await expect(efficiency).toContainText('This is not actual subscription spend.');
  await expect(efficiency).not.toContainText('$0');
  await expect(efficiency.getByRole('link', { name: 'source' }).first()).toHaveAttribute(
    'href',
    'https://developers.openai.com/api/docs/pricing',
  );
});

test('Official trends expose historical time and cost evidence', async ({ page }) => {
  await page.goto('/trends?range=all');
  await expect(
    page.getByRole('heading', { name: 'Time and API-equivalent cost by retained point' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Official model efficiency' }).getByRole('row'),
  ).toHaveCount(18);
  await expect(
    page.getByText('Summed cell adapter durations can overlap', { exact: false }).first(),
  ).toBeVisible();
  const efficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await expect(efficiency).toContainText('unavailable missing usage');
  await expect(efficiency).not.toContainText('$0');
});

test('the published run exposes complete task and provenance evidence', async ({ page }) => {
  await page.goto('/runs/run-live-sol-ultra');
  await expect(page.locator('.task-list > article')).toHaveCount(72);
  await expect(page.getByText('Official', { exact: true })).toBeVisible();
  await expect(page.getByText('Passed', { exact: true }).locator('..')).toContainText('35');
  await expect(page.getByText('Failed', { exact: true }).locator('..').first()).toContainText('37');
  const provenance = page.getByRole('heading', { name: 'Run provenance' }).locator('..');
  await expect(provenance).toContainText('corpus_2026.07.29');
  await expect(provenance).toContainText(`sha256:${'9'.repeat(64)}`);
  await expect(provenance.getByText('Not published', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Official time, token coverage, and cost' }),
  ).toBeVisible();
  await expect(
    page.getByText('Neither value is isolated model latency.', { exact: false }),
  ).toBeVisible();
  const efficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await expect(efficiency).toContainText('1.6 h');
  await expect(efficiency).toContainText('unavailable missing usage');
  await expect(efficiency).not.toContainText('$0');
  const taskResults = page.locator('.task-list > article');
  await expect(taskResults.first()).toContainText('Codex adapter elapsed:');
  await expect(taskResults.first()).toContainText('Tokens: input unavailable');
  await expect(taskResults.first()).toContainText('API-equivalent cost: unavailable missing usage');
  const evaluatorOutcomes = taskResults.filter({
    hasText: 'The evaluator rejected the response.',
  });
  await expect(evaluatorOutcomes).toHaveCount(36);
  await expect(evaluatorOutcomes.first()).toContainText('Evaluator outcome');
  await expect(evaluatorOutcomes.first()).toContainText(
    'This is an evaluator result, not an execution failure.',
  );
  await expect(evaluatorOutcomes.first()).not.toContainText('EXPLANATION_NOT_PUBLISHED');
  const budgetExceeded = taskResults.filter({ hasText: 'budget_exceeded' });
  await expect(budgetExceeded).toHaveCount(1);
  await expect(budgetExceeded).toContainText('The task exceeded a resource budget.');
  await expect(budgetExceeded).toContainText('Retryable: no');

  await page.goto('/runs/run-live-sol-max');
  const timeout = page.locator('.task-list > article').filter({ hasText: 'timeout' });
  await expect(timeout).toHaveCount(1);
  await expect(timeout).toContainText('The task exceeded its time limit.');
  await expect(timeout).toContainText('Retryable: yes');
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
  await expect(page.getByText('Registry trust: trusted verified', { exact: true })).toBeVisible();
  await expect(page.getByText('Published', { exact: true })).toBeVisible();
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
