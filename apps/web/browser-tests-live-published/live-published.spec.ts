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

const routes = [
  '/',
  '/runs',
  '/runs/run-live-sol-ultra',
  '/calibrations',
  `/calibrations/${calibrationRunId}`,
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
  await expect(calibrationEfficiency.getByRole('row')).toHaveCount(18);
  const contextBandScore = calibrationEfficiency
    .getByRole('row')
    .filter({ hasText: 'sol · medium' });
  await expect(contextBandScore).toContainText('Unavailable');
  await expect(contextBandScore).toContainText('unavailable context band');
  await expect(contextBandScore).toContainText(
    'A result above 272000 aggregate input tokens is unpriced',
  );
});

test('calibration history and detail keep one run and one 72-task slice bounded', async ({
  page,
  request,
}) => {
  await page.goto('/calibrations');
  const register = page.getByRole('region', { name: 'Public calibration register' });
  await expect(register.getByRole('row')).toHaveCount(2);
  await expect(register).toContainText('1,224 retained result cells');
  await expect(
    page.getByRole('region', { name: 'Calibration model efficiency' }).getByRole('row'),
  ).toHaveCount(18);
  await register.getByRole('link', { name: 'Inspect calibration' }).click();

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
    'A result above 272000 aggregate input tokens is unpriced',
  );

  await selector.selectOption('terra:medium');
  await page.getByRole('button', { name: 'Show 72-task slice' }).click();
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
  const contextBandEfficiency = efficiency.getByRole('row').filter({ hasText: 'sol · medium' });
  await expect(contextBandEfficiency).toContainText('Unavailable');
  await expect(contextBandEfficiency).toContainText('unavailable context band');
});

test('the published run exposes complete task and provenance evidence', async ({ page }) => {
  await page.goto('/runs/run-live-sol-ultra');
  await expect(page.locator('.task-list > article')).toHaveCount(72);
  await expect(page.getByText('Official', { exact: true })).toBeVisible();
  const provenance = page.getByRole('heading', { name: 'Run provenance' }).locator('..');
  await expect(provenance).toContainText('corpus_2026.07.29');
  await expect(provenance).toContainText(`sha256:${'9'.repeat(64)}`);
  await expect(provenance.getByText('Not published', { exact: true })).toHaveCount(0);
});

test('the published method and radar retain versioned, signed provenance', async ({ page }) => {
  await page.goto('/method');
  await expect(page.getByText('aiq-core@1.0.1', { exact: true })).toBeVisible();
  await expect(page.getByText('1.0.0', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'official OpenAI API pricing documentation' }),
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
