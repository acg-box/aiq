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

const routes = [
  '/',
  '/runs',
  '/runs/run-live-sol-ultra',
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
  await expect(page.getByText('aiq-core@1.0.0', { exact: true })).toBeVisible();
  await expect(page.getByText('1.0.0', { exact: true })).toBeVisible();
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
