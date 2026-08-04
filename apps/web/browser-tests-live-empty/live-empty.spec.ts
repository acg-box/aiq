import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test as base,
  type APIResponse,
  type Page,
  type Response,
  type TestInfo,
} from '@playwright/test';

interface LiveEmptyFixtures {
  runtimeFailures: string[];
}

const test = base.extend<LiveEmptyFixtures>({
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
  '/calibrations',
  '/compare',
  '/trends?range=day',
  '/trends?range=week',
  '/trends?range=month',
  '/trends?range=all',
  '/method',
  '/radar',
] as const;

function expectPrivateNoStore(response: Response | null) {
  const cacheControl = response?.headers()['cache-control'] ?? '';
  expect(cacheControl).toContain('private');
  expect(cacheControl).toContain('no-store');
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
  test(`${route} fails closed accessibly when live PostgREST has no evidence`, async ({
    page,
  }, testInfo) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    expectPrivateNoStore(response);
    await expect(page.getByText('public data', { exact: true })).toBeVisible();
    await expect(page.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0);
    await expect(page.locator('main h1')).toBeVisible();
    expect(await new AxeBuilder({ page }).analyze()).toMatchObject({ violations: [] });
    await expectNoDocumentOverflow(page, testInfo);
  });
}

test('the live empty overview preserves all 17 fixed matrix identities without scores', async ({
  page,
}) => {
  const response = await page.goto('/');
  expectPrivateNoStore(response);
  await expect(page.getByText('No published evidence', { exact: true }).first()).toBeVisible();
  await page.getByText('Show all 17 configurations and intervals', { exact: true }).click();
  const table = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  await expect(table.getByRole('row')).toHaveCount(18);
  await expect(table.getByRole('link', { name: 'Inspect' })).toHaveCount(0);
  const snapshot = page.getByLabel('Latest matrix snapshot');
  const coverage = snapshot.getByText('Coverage', { exact: true }).locator('..');
  const newestRetained = snapshot.getByText('Newest retained run', { exact: true }).locator('..');
  await expect(coverage).toContainText('Sample size unavailable');
  await expect(coverage).not.toContainText('0 fixed task cells');
  await expect(
    page.getByText('17 configurations · task cells unavailable', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('17 configurations · 0 task cells', { exact: true })).toHaveCount(0);
  await expect(newestRetained).toContainText('Unavailable');
  await expect(newestRetained).toContainText('No published run evidence');
  await expect(snapshot).not.toContainText('trusted publication');
  await expect(page.getByRole('heading', { name: 'Latest verified calibration' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Latest calibration status' })).toContainText(
    'The live public read is available, but it has no evidence to display.',
  );
});

test('the live empty calibration register does not substitute seed evidence', async ({ page }) => {
  await page.goto('/calibrations');
  await expect(page.getByRole('region', { name: 'Public calibration register' })).toHaveCount(0);
  await expect(page.getByText('No published evidence', { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic seed', { exact: true })).toHaveCount(0);
});

test('the live empty trends page reports matrix and point reads separately', async ({ page }) => {
  const response = await page.goto('/trends');
  expectPrivateNoStore(response);
  await expect(page.getByRole('status', { name: 'Matrix entries status' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Trend points status' })).toBeVisible();
});

test('an unknown live run detail remains an uncached 404 without synthetic fallback', async ({
  page,
  runtimeFailures,
}) => {
  const response = await page.goto('/runs/unknown-live-run');
  expect(response?.status()).toBe(404);
  expectPrivateNoStore(response);
  await expect(
    page.getByRole('heading', { name: 'This evidence is not in the index.' }),
  ).toBeVisible();
  await expect(page.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0);

  const expectedNotFoundErrors = runtimeFailures.filter(
    (failure) =>
      failure ===
      'console: Failed to load resource: the server responded with a status of 404 (Not Found)',
  );
  expect(runtimeFailures).toEqual(expectedNotFoundErrors);
  runtimeFailures.length = 0;
});

test('the production readiness API stays uncached when deployment configuration is incomplete', async ({
  request,
}) => {
  const response = await request.get('/api/readiness');
  expect(response.status()).toBe(503);
  expectNoStore(response);
  expect(await response.json()).toMatchObject({
    scope_ready: false,
  });
});
