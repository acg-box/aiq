import AxeBuilder from '@axe-core/playwright';
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
  await expect(page.locator('main h1')).toBeVisible();
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
  await expectPublishedNonSyntheticPage(page, '/runs');
  const path = await page
    .getByRole('region', { name: 'Public run history' })
    .getByRole('link', { name: 'Inspect run' })
    .first()
    .getAttribute('href');
  expect(path).toMatch(/^\/runs\/[A-Za-z0-9._:-]+$/);
  return path ?? '';
}

async function expectMobileMatrixLegibility(page: Page) {
  const ranking = page.getByRole('region', { name: 'Published descriptive estimates' });
  const snapshot = page.getByRole('region', { name: 'Secondary benchmark snapshot' });
  await expect(ranking).toBeVisible();
  await expect(ranking.getByRole('row')).toHaveCount(6);
  const rankingBox = await ranking.boundingBox();
  expect(rankingBox).not.toBeNull();
  expect((rankingBox?.y ?? 844) + (rankingBox?.height ?? 0)).toBeLessThanOrEqual(844);
  const snapshotBox = await snapshot.boundingBox();
  expect(snapshotBox).not.toBeNull();
  expect(rankingBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    snapshotBox?.y ?? Number.NEGATIVE_INFINITY,
  );
  await page.locator('[data-homepage-analytics="matrix"]').scrollIntoViewIfNeeded();
  const chart = page.getByRole('region', { name: 'AIQ index by configuration' });
  await expect(chart.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    chart.getByRole('button', { name: 'Ordered + interval', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.getByText('All 17 configurations shown', { exact: false })).toBeVisible();
  await expect(chart.getByText('Read 17 configuration values', { exact: true })).toBeVisible();
  const labels = await chart
    .locator('svg text')
    .evaluateAll((elements) =>
      elements
        .filter((element) => /^[STL]·/.test(element.textContent ?? ''))
        .map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    );
  expect(labels).toHaveLength(17);
  expect(labels.every((fontSize) => fontSize >= 12)).toBe(true);
}

async function compareEvidenceSnapshot(page: Page): Promise<readonly string[]> {
  await expectPublishedNonSyntheticPage(page, '/compare');
  const comparison = page.getByRole('table', { name: 'Selected comparison' });
  const first = page.getByLabel('First model and reasoning level');
  const second = page.getByLabel('Second model and reasoning level');
  const secondValue = await second.inputValue();
  const optionValues = await first
    .locator('option')
    .evaluateAll((options) =>
      options.map((option) => (option instanceof HTMLOptionElement ? option.value : '')),
    );
  const snapshots: string[] = [];
  let hasUnavailableCost = false;
  for (const value of optionValues) {
    if (value === secondValue) continue;
    await first.selectOption(value);
    const snapshot = await comparison.innerText();
    snapshots.push(snapshot);
    const costRow = comparison.getByRole('row').filter({ hasText: 'API-equivalent cost' });
    const cost = (await costRow.getByRole('cell').first().innerText()).trim();
    if (cost === 'Unavailable') hasUnavailableCost = true;
    expect(cost).not.toBe('$0');
  }
  await expect(
    comparison.getByRole('row').filter({ hasText: 'Summed adapter duration' }),
  ).toBeVisible();
  await expect(comparison.getByRole('row').filter({ hasText: 'Batch wall-clock' })).toBeVisible();
  await expect(comparison.getByRole('row').filter({ hasText: 'Duration coverage' })).toBeVisible();
  await expect(comparison.getByRole('row').filter({ hasText: 'Cost coverage' })).toBeVisible();
  expect(hasUnavailableCost, 'at least one selected Official cost must be unavailable').toBe(true);
  return snapshots;
}

test('production compare exposes selected-run efficiency and honest unavailable cost', async ({
  page,
}) => {
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
    expect(runPath).toMatch(/^\/runs\/run_[0-9a-f]{64}$/);
  }
  const paths = [
    '/',
    '/compare',
    '/runs',
    runPath,
    '/trends?range=all',
    '/calibrations',
    '/method',
    '/radar',
  ];

  for (const path of paths) {
    await expectPublishedNonSyntheticPage(page, path);
    if (path === '/') await expectMobileMatrixLegibility(page);
    await expectNoHorizontalOverflow(page, path);
  }
});

test('overview, compare, and one actual run detail have no selective Axe violations', async ({
  page,
}) => {
  const runPath = await getActualRunPath(page);
  for (const path of ['/', '/compare', runPath]) {
    await expectPublishedNonSyntheticPage(page, path);
    expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
  }
});
