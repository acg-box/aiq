import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIResponse, type Page } from '@playwright/test';

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
  const evidenceLabel = path.startsWith('/trends')
    ? 'Matrix entries provenance'
    : 'Data provenance';
  const primaryEvidence = page.getByLabel(evidenceLabel, { exact: true });
  await expect(primaryEvidence).toBeVisible();
  await expect(primaryEvidence.getByText('Published evidence', { exact: true })).toBeVisible();
  await expect(primaryEvidence.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0);
  await expect(primaryEvidence.getByText('Mixed evidence', { exact: true })).toHaveCount(0);
  await expect(primaryEvidence.getByText('No published evidence', { exact: true })).toHaveCount(0);
  await expect(
    primaryEvidence.getByText('Published evidence unavailable', { exact: true }),
  ).toHaveCount(0);
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

async function compareEvidenceSnapshot(page: Page): Promise<readonly string[]> {
  await expectPublishedNonSyntheticPage(page, '/compare');
  const efficiency = page.getByRole('region', { name: 'Official model efficiency' });
  const rows = efficiency.locator('tbody tr');
  await expect(rows).toHaveCount(17);
  await expect(
    efficiency.getByText('Signed matrix batch wall-clock', { exact: true }),
  ).toBeVisible();
  const batchWallTime = efficiency.locator('.formula-note > p[title]');
  await expect(batchWallTime).toHaveCount(1);
  await expect(batchWallTime).toContainText(/\d+(?:\.\d+)? (?:s|min|h)/);

  const snapshots: string[] = [];
  let unavailableCostRows = 0;
  for (const row of await rows.all()) {
    const runId = await row.getAttribute('data-run-id');
    expect(runId).toMatch(/^run[-_][A-Za-z0-9._:-]+$/);
    const cost = (await row.getByRole('cell').nth(1).innerText()).trim();
    if (cost.startsWith('Unavailable')) {
      unavailableCostRows += 1;
      expect(cost).not.toContain('$0');
    }
    snapshots.push(`${runId}\n${await row.innerText()}`);
  }
  expect(new Set(snapshots.map((row) => row.split('\n', 1)[0])).size).toBe(17);
  expect(
    unavailableCostRows,
    'at least one Official cost must be explicitly unavailable',
  ).toBeGreaterThan(0);
  return snapshots;
}

test('production compare exposes published Official efficiency and honest unavailable cost', async ({
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
  const paths = ['/', '/compare', '/runs', runPath, '/trends?range=all', '/method', '/radar'];

  for (const path of paths) {
    await expectPublishedNonSyntheticPage(page, path);
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
