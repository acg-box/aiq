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
  const workbench = page.getByRole('region', { name: 'Compare configurations' }).first();
  await expect(page.getByRole('button', { name: /Highest AIQ/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Shortest task time/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Lowest cost ceiling/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Cost coverage/ })).toBeVisible();
  await expect(workbench).toBeVisible();
  await expect(workbench.getByRole('status')).toContainText('17/17 visible');
  const firstSummaryBox = await workbench
    .getByRole('button', { name: /Highest AIQ/ })
    .boundingBox();
  expect(firstSummaryBox).not.toBeNull();
  expect(firstSummaryBox?.y ?? 844).toBeLessThan(844);
  const chart = workbench.getByRole('region', { name: 'AIQ against summed task time' });
  await chart.scrollIntoViewIfNeeded();
  await expect(chart.locator('svg')).toBeVisible();
  await expect(chart.locator('canvas')).toHaveCount(0);
  await expect(
    workbench
      .getByRole('region', { name: 'Filtered configuration comparison table' })
      .locator('tbody tr'),
  ).toHaveCount(17);
  await workbench.getByRole('button', { name: 'Decision map', exact: true }).click();
  await expect(
    workbench.getByRole('region', {
      name: 'Three-metric decision map for AIQ, time, and API-equivalent cost',
    }),
  ).toBeVisible();
}

async function compareEvidenceSnapshot(page: Page): Promise<readonly string[]> {
  await expectPublishedNonSyntheticPage(page, '/compare');
  await page.waitForLoadState('networkidle');
  const workbench = page.getByRole('region', { name: 'Compare configurations' });
  const status = workbench.getByRole('status');
  const comparison = workbench.getByRole('region', {
    name: 'Filtered configuration comparison table',
  });
  await expect(status).toContainText('17/17 configurations visible');
  await expect(comparison.locator('tbody tr')).toHaveCount(17);
  const snapshots = await comparison.locator('tbody tr').allInnerTexts();
  expect(snapshots.some((row) => row.includes('Unavailable'))).toBe(true);
  expect(snapshots.some((row) => /\$\d/.test(row))).toBe(true);

  await workbench.getByRole('button', { name: 'Exact cost only', exact: true }).click();
  await expect(page).toHaveURL(/compareCost=estimated/);
  const measuredRows = comparison.locator('tbody tr');
  const measuredCount = await measuredRows.count();
  expect(measuredCount).toBeGreaterThan(0);
  expect(measuredCount).toBeLessThan(17);
  await expect(status).toContainText(`${measuredCount}/17 configurations visible`);
  expect((await measuredRows.allInnerTexts()).every((row) => !row.includes('Unavailable'))).toBe(
    true,
  );

  await workbench.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(status).toContainText('17/17 configurations visible');
  const aiqHeading = comparison.getByRole('columnheader', { name: /AIQ/ });
  const timeHeading = comparison.getByRole('columnheader', { name: /Task time/ });
  await expect(aiqHeading).toHaveAttribute('aria-sort', 'descending');
  const ascendingFirstId = await comparison
    .locator('tbody tr')
    .first()
    .getAttribute('data-configuration-id');
  await timeHeading.getByRole('button').click();
  await expect(page).toHaveURL(/compareOrder=time/);
  await expect(timeHeading).toHaveAttribute('aria-sort', 'ascending');
  const fastestId = await comparison
    .locator('tbody tr')
    .first()
    .getAttribute('data-configuration-id');
  await timeHeading.getByRole('button').click();
  await expect(page).toHaveURL(/compareDirection=desc/);
  await expect(timeHeading).toHaveAttribute('aria-sort', 'descending');
  const slowestId = await comparison
    .locator('tbody tr')
    .first()
    .getAttribute('data-configuration-id');
  expect(fastestId).not.toBe(slowestId);
  expect(ascendingFirstId).not.toBeNull();

  const timePlot = workbench.getByRole('region', { name: 'AIQ against summed task time' });
  const firstPoint = timePlot
    .locator('.echarts-host path[fill="var(--data-lime)"][stroke="var(--panel)"]')
    .first();
  await firstPoint.click({ force: true });
  await expect.poll(() => new URL(page.url()).searchParams.get('compareFocus')).not.toBeNull();
  await expect(comparison.locator('tbody tr[data-focused="true"]')).toHaveCount(1);
  await timePlot
    .locator('.echarts-host path[fill="var(--data-lime)"][stroke="var(--panel)"]')
    .first()
    .click({ force: true });
  await expect.poll(() => new URL(page.url()).searchParams.get('compareFocus')).toBeNull();

  const firstId = await comparison
    .locator('tbody tr')
    .first()
    .getAttribute('data-configuration-id');
  expect(firstId).toMatch(/^(?:sol|terra|luna)-/);
  await page.goto(`/compare?compareConfigs=${encodeURIComponent(firstId ?? '')}#compare`);
  const singleWorkbench = page.getByRole('region', { name: 'Compare configurations' });
  await expect(singleWorkbench.getByRole('status')).toContainText('1/17 configurations visible');
  await page.reload({ waitUntil: 'networkidle' });
  await expect(
    page.getByRole('region', { name: 'Compare configurations' }).getByRole('status'),
  ).toContainText('1/17 configurations visible');

  await page.goto('/compare');
  const restoredWorkbench = page.getByRole('region', { name: 'Compare configurations' });
  await expect(
    restoredWorkbench.getByRole('group', { name: 'Configuration selection' }),
  ).toBeVisible();
  await expect(
    restoredWorkbench.getByRole('group', { name: 'Sol configurations' }).getByRole('button'),
  ).toHaveText(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  await expect(
    restoredWorkbench.getByRole('group', { name: 'Terra configurations' }).getByRole('button'),
  ).toHaveText(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  await expect(
    restoredWorkbench.getByRole('group', { name: 'Luna configurations' }).getByRole('button'),
  ).toHaveText(['low', 'medium', 'high', 'xhigh', 'max']);
  await restoredWorkbench.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(restoredWorkbench.getByRole('status').first()).toContainText(
    '0/17 configurations visible',
  );
  await expect(
    restoredWorkbench.getByText('No configuration matches these filters.'),
  ).toBeVisible();
  await restoredWorkbench.getByRole('button', { name: 'Show all 17', exact: true }).click();
  await expect(restoredWorkbench.getByRole('status')).toContainText('17/17 configurations visible');
  return snapshots;
}

test('production compare exposes filterable all-configuration evidence and honest unavailable cost', async ({
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
