import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIResponse, type Page } from '@playwright/test';

import { expectProductionPageEvidence } from './production-page-evidence.ts';

/* oxlint-disable no-await-in-loop -- Production requests stay serial to bound load and preserve before/after evidence order. */

const readinessScope = [
  'runtime_mode',
  'configuration_contract',
  'public_read_views',
  'public_trend_points_rpc',
  'private_storage_buckets',
  'role_scoped_rpc_contract',
  'gateway_role_credentials',
  'production_reference_initialization',
] as const;

const unauthenticatedWritePaths = [
  '/api/submissions',
  '/api/artifacts',
  '/api/claims',
  '/api/artifacts/resolve',
  '/api/verifications',
] as const;

function expectNoStore(response: APIResponse) {
  expect(response.headers()['cache-control'] ?? '').toContain('no-store');
}

async function expectPublishedNonSyntheticPage(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `${path} response status`).toBe(200);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expectProductionPageEvidence(page, path);
}

async function expectNoHorizontalOverflow(page: Page, path: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${path} document width ${dimensions.scrollWidth} exceeds ${dimensions.clientWidth}`,
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function getActualRunPath(page: Page): Promise<string> {
  await expectPublishedNonSyntheticPage(page, '/benchmarks/intelligence');
  const table = page.getByRole('region', { name: 'Core leaderboard' });
  const evidence = table.getByRole('button', { name: /^Details: Evidence for / }).first();
  const desktop = await evidence.isVisible();
  if (desktop) await evidence.click();
  else
    await table
      .getByRole('button', { name: /^Details for / })
      .first()
      .click();
  const content = desktop ? page.getByRole('dialog') : table.locator('.row-expanded-content');
  await content.getByText('Run identity & original JSON', { exact: true }).click();
  const path = await content
    .getByRole('link', { name: 'Open complete run evidence', exact: true })
    .getAttribute('href');
  const target = new URL(path ?? '', page.url());
  expect(target.pathname).toMatch(/^\/benchmarks\/intelligence\/records\/run_[a-f0-9]{64}$/);
  expect(target.searchParams.get('return')).toBe('/benchmarks/intelligence');
  if (desktop) await page.keyboard.press('Escape');
  else await content.getByRole('button', { name: /^Close details for / }).click();
  return target.pathname;
}

async function expectMobileMatrixLegibility(page: Page) {
  const table = page.getByRole('region', { name: 'Core leaderboard' });
  await expect(table.locator('tbody tr')).toHaveCount(17);
  expect((await table.locator('table').boundingBox())?.width).toBeLessThanOrEqual(390);
  await expect(table.locator('tbody tr').first().locator('.core-ability')).toBeVisible();
}

async function compareEvidenceSnapshot(page: Page): Promise<readonly string[]> {
  await expectPublishedNonSyntheticPage(page, '/benchmarks/intelligence');
  const comparison = page.getByRole('region', { name: 'Core leaderboard' });
  await expect(comparison.locator('tbody tr')).toHaveCount(17);
  const snapshots = await comparison.locator('tbody tr').allInnerTexts();
  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Model', { exact: true }).selectOption('Sol');
  await expect(comparison.locator('tbody tr')).toHaveCount(6);
  await page.getByLabel('Effort', { exact: true }).selectOption('medium');
  await expect(comparison.locator('tbody tr')).toHaveCount(1);
  await page.reload();
  await expect(comparison.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(comparison.locator('tbody tr')).toHaveCount(17);
  return snapshots;
}

test('production leaderboard filters preserve a complete publication', async ({ page }) => {
  await compareEvidenceSnapshot(page);
});

test('production readiness reports the exact bounded dependency contract', async ({
  request,
}, testInfo) => {
  const response = await request.get('/api/readiness');
  expect(response.status()).toBe(200);
  expectNoStore(response);
  expect(response.headers()['cache-control']).toBe('no-store, max-age=0');

  const isLocalContractMock = testInfo.config.metadata.productionEvidenceVariants === true;
  const mode = isLocalContractMock ? 'non_production' : 'production';
  expect(await response.json()).toEqual({
    state: isLocalContractMock ? 'local_dependencies_ready' : 'bounded_dependency_probe_passed',
    scope_ready: true,
    mode,
    checks: {
      runtime_mode: mode,
      configuration: 'valid',
      dependencies: 'available',
    },
    scope: readinessScope,
  });
});

test('unauthenticated production writes return uncached 401 responses without public side effects', async ({
  page,
  request,
}) => {
  const before = await compareEvidenceSnapshot(page);

  for (const path of unauthenticatedWritePaths) {
    const response = await request.post(path, { data: {} });
    expect(response.status(), path).toBe(401);
    expectNoStore(response);
    expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
  }

  expect(await compareEvidenceSnapshot(page)).toEqual(before);
});

test('production launch pages fit a 390-by-844 mobile viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const runPath = await getActualRunPath(page);
  if (testInfo.config.metadata.productionEvidenceVariants === true) {
    expect(runPath).toMatch(/^\/benchmarks\/intelligence\/records\/run_[0-9a-f]{64}$/);
  }
  const paths = [
    '/',
    '/benchmarks/intelligence',
    '/benchmarks/intelligence?view=records',
    runPath,
    '/benchmarks/intelligence?view=records&range=all',
    '/benchmarks/intelligence/calibrations',
    '/benchmarks/intelligence?view=method',
    '/benchmarks/intelligence/verification',
    '/benchmarks/memory',
  ];

  for (const path of paths) {
    await expectPublishedNonSyntheticPage(page, path);
    if (path === '/benchmarks/intelligence') await expectMobileMatrixLegibility(page);
    await expectNoHorizontalOverflow(page, path);
  }
});

test('board views and one actual run detail have no selective Axe violations', async ({ page }) => {
  const runPath = await getActualRunPath(page);
  for (const path of ['/', '/benchmarks/intelligence', runPath]) {
    await expectPublishedNonSyntheticPage(page, path);
    expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
  }
});
