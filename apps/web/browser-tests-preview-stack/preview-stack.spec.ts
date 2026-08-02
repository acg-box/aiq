import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test as base,
  type APIResponse,
  type Page,
  type Response,
  type TestInfo,
} from '@playwright/test';

interface PreviewStackFixtures {
  runtimeFailures: string[];
}

const test = base.extend<PreviewStackFixtures>({
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
  test(`${route} renders the real synthetic preview stack accessibly`, async ({
    page,
  }, testInfo) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    expectPrivateNoStore(response);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Deployment status' })).toHaveText(
      'ACGbox preview · synthetic · read-only · not production',
    );
    await expect(page.getByText('Synthetic / seed data', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Published evidence', { exact: true })).toHaveCount(0);
    expect(await new AxeBuilder({ page }).analyze()).toMatchObject({ violations: [] });
    await expectNoDocumentOverflow(page, testInfo);
  });
}

test('the preview validates the 17-row PostgreSQL matrix before rendering fixtures', async ({
  page,
}) => {
  const response = await page.goto('/');
  expectPrivateNoStore(response);
  await expect(
    page.getByText('Highest synthetic seed point estimate', { exact: true }),
  ).toBeVisible();
  const leaderboard = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  await expect(leaderboard.getByRole('row')).toHaveCount(18);
  const inspectLinks = leaderboard.getByRole('link', { name: 'Inspect' });
  await expect(inspectLinks).toHaveCount(17);
  const runHref = await inspectLinks.first().getAttribute('href');
  expect(runHref).toMatch(/^\/runs\/run-2026-07-[0-9]{2}-(?:sol|terra|luna)-/);
});

test('one preview run exposes all 72 checked-in synthetic task fixtures', async ({ page }) => {
  await page.goto('/');
  const runHref = await page
    .getByRole('region', { name: 'Descriptively ordered public index table' })
    .getByRole('link', { name: 'Inspect' })
    .first()
    .getAttribute('href');
  expect(runHref).toMatch(/^\/runs\/run-2026-07-[0-9]{2}-(?:sol|terra|luna)-/);

  const response = await page.goto(runHref ?? '/runs/invalid-preview-run');
  expect(response?.status()).toBe(200);
  expectPrivateNoStore(response);
  await expect(page.locator('.task-list > article')).toHaveCount(72);
  await expect(page.getByText('Synthetic / seed data', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Published evidence', { exact: true })).toHaveCount(0);
});

test('the preview readiness endpoint stays explicit about absent production gateways', async ({
  request,
}) => {
  const response = await request.get('/api/readiness');
  expect(response.status()).toBe(503);
  expectNoStore(response);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    state: 'configuration_error',
    scope_ready: false,
    mode: 'non_production',
    checks: {
      runtime_mode: 'non_production',
      configuration: 'invalid',
      dependencies: 'not_run',
    },
  });
  if (typeof body !== 'object' || body === null || !('issues' in body)) {
    throw new Error('Preview readiness response has no issues array.');
  }
  expect(body.issues).toEqual([
    'SUPABASE_URL is missing',
    'SUPABASE_SECRET_KEY is missing',
    'AIQ_RUNNER_SUBMISSION_TOKEN is missing',
    'AIQ_SUBMISSION_PACKAGE_BUCKET is missing',
    'AIQ_RUNNER_ARTIFACT_BUCKET is missing',
    'AIQ_VERIFIER_INGRESS_TOKEN is missing',
    'AIQ_SUPABASE_PUBLISHABLE_KEY is missing',
    'AIQ_SUPABASE_JWT_PRIVATE_JWK is missing',
    'AIQ_PUBLISHER_NODE_ID is missing',
  ]);
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('local_preview_validation');
  expect(serialized).not.toContain('127.0.0.1');
  expect(serialized).not.toMatch(/sb_(?:publishable|secret)_/);
});

test('the disposable preview cannot be indexed as production evidence', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('AIQ Wiki — ACGbox synthetic preview');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /ACGbox read-only preview with synthetic AIQ Wiki fixtures/,
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /nofollow/);
  await expect(page.getByText('Complete synthetic fixture · not Official').first()).toBeVisible();
});

test('the persistent preview chrome fits a 320 CSS pixel viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Deployment status' })).toBeVisible();
  await expectNoDocumentOverflow(page, testInfo);
});

test('an unknown preview run remains an uncached 404', async ({ page, runtimeFailures }) => {
  const response = await page.goto('/runs/unknown-preview-run');
  expect(response?.status()).toBe(404);
  expectPrivateNoStore(response);
  await expect(
    page.getByRole('heading', { name: 'This evidence is not in the index.' }),
  ).toBeVisible();
  const expectedNotFoundErrors = runtimeFailures.filter(
    (failure) =>
      failure ===
      'console: Failed to load resource: the server responded with a status of 404 (Not Found)',
  );
  expect(runtimeFailures).toEqual(expectedNotFoundErrors);
  runtimeFailures.length = 0;
});
