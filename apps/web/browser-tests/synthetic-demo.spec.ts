import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const seedCalibrationRunId = `run_${'c'.repeat(64)}`;

const routes = [
  { path: '/', heading: 'Benchmark overview', navigation: 'Overview' },
  { path: '/runs', heading: 'Public run history', navigation: 'Runs' },
  {
    path: '/calibrations',
    heading: 'Calibration register',
    navigation: 'Calibrations',
  },
  {
    path: `/calibrations/${seedCalibrationRunId}`,
    heading: 'Calibration evidence',
    navigation: 'Calibrations',
  },
  { path: '/compare', heading: 'Configuration comparison', navigation: 'Compare' },
  { path: '/trends', heading: 'Benchmark history', navigation: 'Trends' },
  { path: '/radar', heading: 'Runner provenance', navigation: 'Radar' },
  {
    path: '/method',
    heading: 'Scoring method',
    navigation: 'Method',
  },
] as const;

const secondaryNavigation = new Set(['Compare', 'Trends', 'Calibrations', 'Method', 'Radar']);

function monitorErrors(page: Page) {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
  return failures;
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

async function expectAccessible(page: Page) {
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations).toEqual([]);
}

async function expectTextContrast(locator: Locator) {
  const contrast = await locator.evaluate((element) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this browser-context helper with the callback.
    const channels = (value: string) => {
      const match = value.match(/[\d.]+/g);
      if (!match || match.length < 3) throw new Error(`Cannot parse color: ${value}`);
      return match.slice(0, 3).map(Number);
    };
    const luminance = (color: string) => {
      const [red = 0, green = 0, blue = 0] = channels(color).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const style = getComputedStyle(element);
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

for (const route of routes) {
  test(`${route.path} renders synthetic data without runtime or accessibility failures`, async ({
    page,
  }, testInfo) => {
    const runtimeFailures = monitorErrors(page);
    const response = await page.goto(route.path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['cache-control']).toContain('no-store');
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response?.headers()['permissions-policy']).toContain('camera=()');
    expect(response?.headers()['x-frame-options']).toBe('DENY');
    const canonicalUrl = route.path === '/' ? 'https://aiq.wiki' : `https://aiq.wiki${route.path}`;
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', canonicalUrl);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', canonicalUrl);
    await expect(
      page.getByRole('heading', { level: 1, name: new RegExp(route.heading) }),
    ).toBeVisible();
    await expect(
      page.getByText('Demo values are synthetic seed data', { exact: false }),
    ).toBeVisible();
    await expect(page.locator('.live-pill')).toHaveClass(/status-seed/);
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    if (secondaryNavigation.has(route.navigation)) {
      await navigation.locator('.site-more > summary').click();
    }
    await expect(
      navigation.getByRole('link', {
        name: route.navigation,
        exact: true,
      }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    await expectNoDocumentOverflow(page, testInfo);
    await expectAccessible(page);
    expect(runtimeFailures).toEqual([]);
  });
}

test('crawler metadata routes expose only the public surface', async ({ request }) => {
  const robotsResponse = await request.get('/robots.txt');
  expect(robotsResponse.status()).toBe(200);
  expect(robotsResponse.headers()['content-type']).toContain('text/plain');
  const robotsBody = await robotsResponse.text();
  expect(robotsBody).toContain('Allow: /');
  expect(robotsBody).toContain('Disallow: /api/');
  expect(robotsBody).toContain('Sitemap: https://aiq.wiki/sitemap.xml');

  const sitemapResponse = await request.get('/sitemap.xml');
  expect(sitemapResponse.status()).toBe(200);
  expect(sitemapResponse.headers()['content-type']).toContain('application/xml');
  const sitemapBody = await sitemapResponse.text();
  for (const publicRoute of routes.filter(
    (candidate) => !candidate.path.includes(seedCalibrationRunId),
  )) {
    expect(sitemapBody).toContain(`<loc>https://aiq.wiki${publicRoute.path}</loc>`);
  }
  expect(sitemapBody).not.toContain('/api/');
});

test('the index exposes the fixed 17-configuration matrix and a complete run', async ({
  page,
}, testInfo) => {
  const runtimeFailures = monitorErrors(page);
  const response = await page.goto('/');
  expect(response?.headers()['cache-control']).toContain('no-store');
  await expect(page.getByRole('heading', { name: 'Current configuration matrix' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'AIQ index by configuration' })).toBeVisible();
  const compactPreview = page.getByRole('region', { name: 'Synthetic matrix preview' });
  await expect(compactPreview).toBeVisible();
  await expect(compactPreview.getByRole('row')).toHaveCount(6);
  await Promise.all(
    ['Evidence', 'Model / reasoning', 'AIQ demo', 'Coverage'].map((heading) =>
      expect(compactPreview.getByRole('columnheader', { name: heading })).toBeVisible(),
    ),
  );
  await expect(compactPreview.getByRole('columnheader', { name: 'Rank' })).toHaveCount(0);
  await expect(compactPreview.getByRole('cell', { name: 'Seed', exact: true })).toHaveCount(5);
  await expect(compactPreview.getByRole('row').nth(1)).toContainText('Luna');
  await expect(compactPreview).toContainText('not Official · not ranking eligible');
  await page.getByText('Show all 17 configurations and intervals', { exact: true }).click();

  const leaderboard = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  await expect(leaderboard.getByRole('row')).toHaveCount(18);
  await expect(
    leaderboard.getByText('order does not identify a statistical winner', { exact: false }),
  ).toBeVisible();
  await expect(leaderboard.getByRole('columnheader', { name: 'Rank' })).toHaveCount(0);
  const inspectLinks = leaderboard.getByRole('link', { name: 'Inspect' });
  await expect(inspectLinks).toHaveCount(17);
  await expect(page.getByText('17 configurations · 1,224 task cells')).toBeVisible();
  await expect(
    page.getByText('Average coverage across 17/17 configurations:', { exact: false }),
  ).toBeVisible();

  const runHref = await inspectLinks.first().getAttribute('href');
  expect(runHref).toMatch(/^\/runs\/run-2026-07-\d{2}-/);
  const runResponse = await page.goto(runHref ?? '/runs/unavailable');
  expect(runResponse?.headers()['cache-control']).toContain('no-store');
  await expect(page).toHaveURL(/\/runs\/run-2026-07-\d{2}-/);
  await expect(page).toHaveTitle(/Run detail · AIQ/);
  await expect(page.getByRole('link', { name: 'Runs', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Sol|Terra|Luna/);
  await expect(page.locator('.task-list > article')).toHaveCount(72);
  await expect(page.locator('.task-list')).toContainText('Codex adapter elapsed: unavailable');
  await expect(page.locator('.task-list')).not.toContainText('runner-observed');
  const failedTasks = page.locator('.task-list > article').filter({
    has: page.locator('.result-runtime_issue'),
  });
  const failedTaskCount = await failedTasks.count();
  expect(failedTaskCount).toBeGreaterThan(0);
  await expect(failedTasks.locator('.result-explanation')).toHaveCount(failedTaskCount);
  expect(
    (await failedTasks.locator('.result-explanation code').allTextContents()).every((code) =>
      /^(AGENT_TIMEOUT|MODEL_TIMEOUT|TOOL_TIMEOUT)$/.test(code),
    ),
  ).toBe(true);
  await expect(failedTasks.locator('.result-explanation p')).toHaveCount(failedTaskCount);
  await expect(failedTasks.locator('.result-explanation small')).toHaveCount(failedTaskCount);
  await expectNoDocumentOverflow(page, testInfo);
  await expectAccessible(page);
  expect(runtimeFailures).toEqual([]);
});

test('the overview workspace exposes evidence and switches chart modes and family', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const chart = page.getByRole('region', { name: 'AIQ index by configuration' });
  const bars = chart.getByRole('button', { name: 'Bars + interval', exact: true });
  const dots = chart.getByRole('button', { name: 'Dot + interval', exact: true });
  const ordered = chart.getByRole('button', { name: 'Ordered + interval', exact: true });
  await expect(dots).toHaveAttribute('aria-pressed', 'true');
  await expect(bars).toHaveAttribute('aria-pressed', 'false');
  await expect(
    chart.getByRole('img', { name: /Dots with task-sensitivity intervals/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 620, height: 900 });
  await expect(ordered).toHaveAttribute('aria-pressed', 'true');
  await expect(
    chart.getByRole('img', { name: /Ordered horizontal bars with task-sensitivity intervals/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await dots.click();
  await expect(chart.locator('.matrix-chart-svg svg')).toBeVisible();
  await bars.click();
  await expect(bars).toHaveAttribute('aria-pressed', 'true');
  await expect(
    chart.getByRole('img', { name: /Zero-baseline bars with task-sensitivity intervals/ }),
  ).toBeVisible();
  await ordered.click();
  await expect(ordered).toHaveAttribute('aria-pressed', 'true');
  await expect(bars).toHaveAttribute('aria-pressed', 'false');
  await expect(
    chart.getByRole('img', { name: /Ordered horizontal bars with task-sensitivity intervals/ }),
  ).toBeVisible();
  await chart.getByRole('button', { name: 'Sol', exact: true }).click();
  await expect(chart.getByText('Showing 6 Sol configurations as ordered.')).toBeAttached();
  const snapshot = page.getByLabel('Latest matrix snapshot');
  await expect(snapshot).toContainText('Task-sensitivity interval');
  await expect(chart.getByText('Dot + CI', { exact: true })).toHaveCount(0);
  await expect(snapshot).toContainText('Coverage');
  await expect(snapshot).toContainText('runtime 3 · missing 0');
  await expect(snapshot).toContainText('scoring 1.0.5 · synthetic');
  await expect(snapshot).toContainText('Newest retained run');
  await expect(snapshot).toContainText('Jul 22, 2026');
  await expect(snapshot).toContainText('Duration');
  await expect(snapshot).toContainText('API-equivalent cost');
  await expect(snapshot).toContainText('not billed subscription cost');
  await expect(snapshot.getByRole('meter')).toHaveAttribute('aria-valuemax', '100');
  const valuesDisclosure = chart.getByText('Read 6 configuration values', { exact: true });
  await valuesDisclosure.click();
  const valuesTable = chart.getByRole('region', { name: 'AIQ configuration values' });
  await expect(valuesTable).toBeVisible();
  for (const heading of [
    'Task sensitivity',
    'n',
    'Coverage',
    'Runtime',
    'Missing',
    'Scoring',
    'Evidence',
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- each scientific context field is an independent public contract.
    await expect(
      valuesTable.getByRole('columnheader', { name: heading, exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Task outcomes, not model IQ' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Domain profile for this configuration' }),
  ).toBeVisible();
  await expect(
    page.getByText('A zero here is a valid scored outcome', { exact: false }),
  ).toBeVisible();
  const outcomeCard = page.getByRole('region', { name: 'Task outcomes, not model IQ' });
  const outcomeGrid = outcomeCard.locator('.outcome-grid');
  await expect(outcomeGrid).toBeVisible();
  await expect(outcomeCard.getByText('Runtime issues', { exact: true })).toBeVisible();
  await expect(outcomeCard.getByText('Invalid', { exact: true })).toBeVisible();
  await expect(outcomeCard.getByText('Missing', { exact: true })).toBeVisible();
  await expect(outcomeCard.getByText('N/A', { exact: true })).toBeVisible();
  await expect(outcomeCard.getByText('Timeout / budget', { exact: true })).toHaveCount(0);
  await expectNoDocumentOverflow(page, testInfo);
});

test('synthetic calibration evidence stays visibly separate and selectable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Latest verified calibration' })).toBeVisible();
  await page.getByText('Open 1 × 1 calibration evidence', { exact: true }).click();
  await expect(
    page.getByText(/not Official.*not ranking eligible/, { exact: false }).first(),
  ).toBeVisible();

  await page.goto('/calibrations');
  const register = page.getByRole('region', { name: 'Public calibration register' });
  await expect(register.getByRole('row')).toHaveCount(2);
  await expect(register).toContainText('Synthetic seed');
  await register.getByRole('link', { name: 'Inspect calibration' }).click();
  await expect(page).toHaveURL(`/calibrations/${seedCalibrationRunId}`);
  await expect(page.getByLabel('Model and reasoning configuration').locator('option')).toHaveCount(
    1,
  );
  await expect(page.getByRole('status', { name: 'Calibration result count' })).toContainText(
    'Showing 1 of 1 result cells',
  );
  await expect(
    page.getByRole('region', { name: 'Calibration results' }).getByRole('row'),
  ).toHaveCount(2);
  await expect(page.getByText('v1.0.5', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Adapter invocation: 0/0 attempted · elapsed observed 0'),
  ).toBeVisible();
  await expect(page.getByText('Runtime issues: 0 · missing 0')).toBeVisible();
});

test('radar separates synthetic registry, observation, and aggregation evidence', async ({
  page,
}, testInfo) => {
  const runtimeFailures = monitorErrors(page);
  await page.goto('/radar');
  await expect(
    page.locator('.node-card').getByText('Synthetic and unverified', { exact: true }),
  ).toHaveCount(3);
  await expect(page.getByText('Registry trust: unverified', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Latest signed observation record' })).toHaveCount(
    3,
  );
  await expect(page.getByRole('heading', { name: 'Trust-layer aggregation' })).toHaveCount(3);
  await expect(page.getByText('Receiver-verified trusted', { exact: true })).toHaveCount(3);
  await expect(
    page.getByText('None of these records is a live heartbeat.', { exact: false }),
  ).toBeVisible();
  await expectNoDocumentOverflow(page, testInfo);
  await expectAccessible(page);
  expect(runtimeFailures).toEqual([]);
});

test('methodology exposes task scoring and equal domain weighting', async ({ page }) => {
  await page.goto('/method');
  await expect(
    page.getByRole('heading', { name: 'Committed weighted checks with explicit hard gates' }),
  ).toBeVisible();
  await expect(
    page.getByText('hard gate or structural failure ? 0 : Σ(weight × passed) ÷ Σ(weight)'),
  ).toBeVisible();
  await expect(page.getByText('unscored and blocks Official publication')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '72 tasks · 10 equally weighted domains' }),
  ).toBeVisible();
  const coverage = page.getByRole('table', {
    name: 'Exact fixed-fixture domain task counts and macro-average weights.',
  });
  await expect(coverage.getByRole('row')).toHaveCount(12);
  await expect(coverage.getByRole('row').filter({ hasText: 'coding' })).toContainText('8');
  await expect(coverage.getByRole('row').filter({ hasText: 'coding' })).toContainText('10%');
  await expect(
    coverage.getByRole('row').filter({ hasText: 'instruction_following' }),
  ).toContainText('6');
  await expect(coverage.getByRole('row').filter({ hasText: 'Total' })).toContainText('72');
  await expect(coverage.getByRole('row').filter({ hasText: 'Total' })).toContainText('100%');
});

test('a user can discover and inspect a missing-result run from history', async ({
  page,
}, testInfo) => {
  const runtimeFailures = monitorErrors(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page).toHaveURL('/runs');
  await expect(
    page.getByText('one batch of 17 configuration runs', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('1,224 executions', { exact: false })).toBeVisible();
  await expect(page.getByText('not 1,224 benchmark runs', { exact: false })).toBeVisible();

  const history = page.getByRole('region', { name: 'Public run history' });
  await expect(history.getByRole('row')).toHaveCount(11);
  await page.getByRole('link', { name: 'Older runs' }).click();
  await expect(page).toHaveURL(/\/runs\?before=/);
  await expect(history.getByRole('row')).toHaveCount(9);
  const missingRun = history.getByRole('row').filter({ hasText: 'Coverage-only · not ranked' });
  await expect(missingRun).toHaveCount(1);
  await expect(missingRun).toContainText('14');
  await expect(missingRun.getByText('AIQ', { exact: true })).toBeVisible();
  await expect(missingRun.getByText('Coverage', { exact: true })).toBeVisible();
  await expect(missingRun.getByText('Runtime issues', { exact: true })).toBeVisible();
  await expect(missingRun.getByText('Missing', { exact: true })).toBeVisible();
  await missingRun.getByText('Provenance, time, and cost', { exact: true }).click();
  await expect(missingRun.getByText('Time / cost coverage', { exact: true })).toBeVisible();
  await missingRun.getByRole('link', { name: 'Inspect run' }).click();

  await expect(page).toHaveURL('/runs/run-2026-07-05-coverage-only-sol-ultra');
  await expect(
    page.getByText('one batch of 17 configuration runs', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('1,224 task-level executions', { exact: false })).toBeVisible();
  await expect(page.getByText('Coverage-only · not ranked', { exact: true })).toBeVisible();
  const missingTasks = page.locator('.task-list > article').filter({
    has: page.locator('.result-missing'),
  });
  await expect(missingTasks).toHaveCount(14);
  await expect(missingTasks.locator('.result-explanation')).toHaveCount(14);
  await expect(missingTasks.first()).toContainText('RESULT_NOT_RECEIVED');
  await expect(missingTasks.first()).toContainText('fixed denominator remains unchanged');

  const domains = page.getByRole('region', { name: 'Run domain summary' });
  await expect(domains.getByRole('row')).toHaveCount(11);
  await expect(domains.getByRole('columnheader', { name: 'Coverage' })).toBeVisible();
  await expect(domains.getByRole('columnheader', { name: 'Completed' })).toBeVisible();
  const provenance = page.getByRole('region', { name: 'Run provenance' });
  const unpublishedProvenanceLabels = [
    'Corpus release',
    'Corpus commitment',
    'Catalog digest',
    'Task-set digest',
    'Preflight digest',
    'Runtime digest',
    'Run class',
    'Permission evidence',
  ];
  await Promise.all(
    unpublishedProvenanceLabels.map((label) =>
      expect(provenance.getByText(label, { exact: true }).locator('..')).toContainText(
        'Not published',
      ),
    ),
  );
  await expect(provenance.getByText('Not published', { exact: true })).toHaveCount(
    unpublishedProvenanceLabels.length,
  );

  await page.getByRole('link', { name: 'Back to run history' }).click();
  await expect(page).toHaveURL('/runs');
  await expectNoDocumentOverflow(page, testInfo);
  await expectAccessible(page);
  expect(runtimeFailures).toEqual([]);
});

test('time range and comparison filters update the visible result', async ({ page }) => {
  const runtimeFailures = monitorErrors(page);
  await page.goto('/trends');
  const disclosure = page.getByText('Read visible trend values as a table', { exact: true });
  await disclosure.click();
  const trendRows = page.locator('.data-disclosure tbody tr');
  const allHistoryCount = await trendRows.count();
  expect(allHistoryCount).toBeGreaterThan(5);
  const legend = page.getByRole('list', { name: 'Visible trend series' });
  await expect(legend.getByRole('listitem')).toHaveCount(6);
  await expect(page.getByRole('note')).toContainText(
    'The family is an explicit filter, not a point-estimate cutoff.',
  );

  const day = page.getByRole('link', { name: 'Day' });
  await day.click();
  await expect(page).toHaveURL('/trends?range=day');
  await expect(day).toHaveAttribute('aria-current', 'page');
  expect(await trendRows.count()).toBeLessThan(allHistoryCount);
  expect(allHistoryCount).toBeLessThanOrEqual(120);
  await expect(page.getByRole('note')).toContainText('latest exact Official run');
  await expect(page.getByRole('columnheader', { name: 'Run / bucket' })).toBeVisible();
  await expect(page.getByText('Synthetic fixture · no run detail', { exact: true })).toHaveCount(
    await trendRows.count(),
  );

  for (const range of ['week', 'month', 'all'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- each navigation verifies one server range.
    await page
      .getByRole('link', { name: range === 'all' ? 'All history' : new RegExp(range, 'i') })
      .click();
    // oxlint-disable-next-line no-await-in-loop -- the assertion belongs to the selected range.
    await expect(page).toHaveURL(`/trends?range=${range}`);
    // oxlint-disable-next-line no-await-in-loop -- the same bounded legend must survive each range.
    await expect(legend.getByRole('listitem')).toHaveCount(6);
  }

  expect(runtimeFailures).toEqual([]);
  const invalidRange = await page.goto('/trends?range=year');
  expect(invalidRange?.status()).toBe(404);
  await expect(
    page.getByRole('heading', { name: 'This evidence is not in the index.' }),
  ).toBeVisible();
  expect(runtimeFailures.every((failure) => failure.includes('404 (Not Found)'))).toBe(true);
  runtimeFailures.length = 0;

  await page.getByText('Analyze', { exact: true }).click();
  await page.getByRole('link', { name: 'Compare', exact: true }).click();
  await expect(page).toHaveURL('/compare');
  await expect(page.getByLabel('Selected run context status')).toHaveCount(0);
  const firstModel = page.getByLabel('First model and reasoning level');
  const difference = page.getByText('Descriptive point-estimate difference:', { exact: false });
  const initialDifference = await difference.textContent();
  await firstModel.selectOption({ index: 3 });
  await expect(difference).not.toHaveText(initialDifference ?? '');
  const comparison = page.getByRole('table', { name: 'Selected comparison' });
  await Promise.all(
    [
      'Summed adapter duration',
      'Batch wall-clock',
      'Duration coverage',
      'API-equivalent cost',
      'Cost coverage',
    ].map((metric) =>
      expect(comparison.getByRole('row').filter({ hasText: metric })).toContainText('Unavailable'),
    ),
  );
  const compatibility = page.getByRole('term').filter({ hasText: 'Scoring version' });
  await expect(compatibility).toBeVisible();
  await expect(page.getByRole('note')).toContainText(
    'No statistically supported difference can be declared',
  );
  expect(runtimeFailures).toEqual([]);
});

test('trend chart exposes scaled score and UTC date axes at narrow widths', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/trends?range=all');
  const chart = page.getByRole('img', { name: 'AIQ score history' });
  await expect(chart).toBeVisible();
  await expect(chart.getByText('AIQ index (0–100)', { exact: true })).toBeVisible();
  await expect(chart.getByText('Observation date (UTC)', { exact: true })).toBeVisible();
  const scoreLabels = await chart.locator('svg text').allTextContents();
  expect(scoreLabels.some((label) => /^\d+(?:\.\d)?$/.test(label))).toBe(true);
  expect(await chart.locator('svg text').count()).toBeGreaterThan(2);
  const box = await chart.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320);
  const lineMode = page.getByRole('button', { name: 'Line', exact: true });
  const barMode = page.getByRole('button', { name: 'Bar', exact: true });
  await expect(lineMode).toHaveAttribute('aria-pressed', 'true');
  await barMode.click();
  await expect(barMode).toHaveAttribute('aria-pressed', 'true');
  await expect(chart).toHaveAttribute(
    'aria-label',
    'AIQ score history. Grouped bars with per-series aligned task-sensitivity intervals.',
  );
  await expect(page.locator('.trend-resolution')).toContainText(
    'Each grouped bar and its task-sensitivity interval use the same per-series category offset.',
  );
  const chartSvg = chart.locator('svg');
  await expect(chartSvg).toBeVisible();
  const intervalAlignment = await page.evaluate(
    (seriesColors) => {
      const svg = document.querySelector('.trend-chart-echarts svg');
      if (!(svg instanceof SVGSVGElement)) return [];
      const paths = [...svg.querySelectorAll<SVGPathElement>('path')];
      return seriesColors.map((color) => {
        const barCenters: number[] = [];
        const intervalCenters: number[] = [];
        for (const path of paths) {
          const values = (path.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
          if (path.getAttribute('fill') === color && values.length >= 3) {
            barCenters.push((values[0] ?? 0) + (values[2] ?? 0) / 2);
          }
          if (
            path.getAttribute('stroke') === color &&
            values.length === 4 &&
            Math.abs((values[0] ?? 0) - (values[2] ?? 0)) < 0.001
          ) {
            intervalCenters.push(values[0] ?? 0);
          }
        }
        barCenters.sort((left, right) => left - right);
        intervalCenters.sort((left, right) => left - right);
        return {
          barCount: barCenters.length,
          intervalCount: intervalCenters.length,
          maximumCenterDelta: Math.max(
            0,
            ...barCenters.map((center, index) =>
              Math.abs(center - (intervalCenters[index] ?? Number.POSITIVE_INFINITY)),
            ),
          ),
        };
      });
    },
    [
      'var(--series-1)',
      'var(--series-2)',
      'var(--series-3)',
      'var(--series-4)',
      'var(--series-5)',
      'var(--series-6)',
    ],
  );
  const activeIntervalAlignment = intervalAlignment.filter(({ barCount }) => barCount > 0);
  expect(activeIntervalAlignment.length, JSON.stringify(intervalAlignment)).toBeGreaterThanOrEqual(
    2,
  );
  expect(
    intervalAlignment.every(
      ({ barCount, intervalCount, maximumCenterDelta }) =>
        barCount === intervalCount && maximumCenterDelta <= 0.01,
    ),
    JSON.stringify(intervalAlignment),
  ).toBe(true);
  await expectNoDocumentOverflow(page, testInfo);
});

test('keyboard users can reach navigation and operate trend controls with visible focus', async ({
  browserName,
  page,
}) => {
  const runtimeFailures = monitorErrors(page);
  const linkNavigationKey = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.goto('/');
  await page.keyboard.press(linkNavigationKey);
  const skipLink = page.getByRole('link', { name: 'Skip to content' });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveCSS('position', 'fixed');

  await page.keyboard.press(linkNavigationKey);
  await expect(page.getByRole('link', { name: 'AIQ home' })).toBeFocused();

  await page.goto('/trends');
  const day = page.getByRole('link', { name: 'Day' });
  await day.focus();
  await expect(day).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/trends?range=day');
  await expect(day).toHaveAttribute('aria-current', 'page');
  expect(runtimeFailures).toEqual([]);
});

test('the index reflows at a 320 CSS pixel narrow viewport', async ({ page }, testInfo) => {
  const runtimeFailures = monitorErrors(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Benchmark overview' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  const chart = page.getByRole('region', { name: 'AIQ index by configuration' });
  await expect(chart.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    chart.getByRole('button', { name: 'Ordered + interval', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    chart.getByRole('img', {
      name: /Ordered horizontal bars with task-sensitivity intervals compare AIQ for 17 configurations/,
    }),
  ).toBeVisible();
  await expect(chart.getByText('All 17 configurations shown', { exact: false })).toBeVisible();
  await expect(chart.getByText('Read 17 configuration values', { exact: true })).toBeVisible();
  const chartBox = await chart.locator('.matrix-chart-svg').boundingBox();
  expect(chartBox?.height ?? 0).toBeGreaterThanOrEqual(600);
  const configurationLabels = await chart.locator('svg text').evaluateAll((labels) =>
    labels
      .filter((label) => /^[STL]·/.test(label.textContent ?? ''))
      .map((label) => ({
        text: label.textContent,
        fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
      })),
  );
  expect(configurationLabels).toHaveLength(17);
  expect(configurationLabels.every(({ fontSize }) => fontSize >= 12)).toBe(true);
  await expectNoDocumentOverflow(page, testInfo);
  expect(runtimeFailures).toEqual([]);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 800 },
] as const) {
  test(`the ${viewport.width}-pixel first viewport leads with a visible matrix preview`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const ranking = page.getByRole('region', { name: 'Synthetic matrix preview' });
    const snapshot = page.getByRole('region', { name: 'Secondary benchmark snapshot' });
    await expect(ranking).toBeVisible();
    await expect(ranking.getByRole('row')).toHaveCount(6);
    await expect(ranking.getByRole('cell', { name: 'Seed', exact: true })).toHaveCount(5);
    await expect(ranking.getByRole('columnheader', { name: 'Rank' })).toHaveCount(0);
    const rankingBox = await ranking.boundingBox();
    expect(rankingBox).not.toBeNull();
    expect((rankingBox?.y ?? viewport.height) + (rankingBox?.height ?? 0)).toBeLessThanOrEqual(
      viewport.height,
    );
    const snapshotBox = await snapshot.boundingBox();
    expect(snapshotBox).not.toBeNull();
    expect(rankingBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
      snapshotBox?.y ?? Number.NEGATIVE_INFINITY,
    );
  });
}

for (const route of [
  '/compare',
  '/runs',
  '/runs/run-2026-07-05-coverage-only-sol-ultra',
  '/method',
  '/radar',
] as const) {
  test(`${route} has no page-level overflow at a 320 CSS pixel, 200%-zoom-equivalent viewport`, async ({
    page,
  }, testInfo) => {
    const runtimeFailures = monitorErrors(page);
    await page.setViewportSize({ width: 320, height: 800 });
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator('main h1')).toBeVisible();
    await expectNoDocumentOverflow(page, testInfo);
    expect(runtimeFailures).toEqual([]);
  });
}

test('the index remains usable in a compact landscape viewport', async ({ page }, testInfo) => {
  const runtimeFailures = monitorErrors(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/');

  expect(await page.evaluate(() => matchMedia('(orientation: landscape)').matches)).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Runs', exact: true })).toBeVisible();
  await expectNoDocumentOverflow(page, testInfo);
  expect(runtimeFailures).toEqual([]);
});

test('reduced-motion preferences disable smooth scrolling and transitions', async ({ page }) => {
  const runtimeFailures = monitorErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/trends');

  const motionStyles = await page.evaluate(() => {
    const rangeLink = document.querySelector('.range-tabs a');
    if (rangeLink === null) throw new Error('Expected the trends page to contain a range link.');

    return {
      preferenceMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      transitionDuration: getComputedStyle(rangeLink).transitionDuration,
    };
  });
  expect(motionStyles).toEqual({
    preferenceMatches: true,
    scrollBehavior: 'auto',
    transitionDuration: '0s',
  });
  expect(runtimeFailures).toEqual([]);
});

test('light and dark themes persist and remain accessible across public pages', async ({
  browserName,
  page,
}, testInfo) => {
  test.skip(
    browserName !== 'chromium',
    'Theme page-by-page acceptance is captured once in Chromium.',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const resolvedTheme = page.getByRole('status', { name: 'Resolved color theme' });
  await expect(resolvedTheme).toContainText('Theme preference system; currently light.');
  await expect(page.locator('.score-readout').first()).toHaveCSS('background-image', 'none');
  await expect(page.locator('.score-readout').first()).toHaveCSS('border-left-width', '4px');
  await testInfo.attach('overview-light', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  for (const route of routes) {
    // oxlint-disable-next-line no-await-in-loop -- each public page needs light-theme acceptance.
    await page.goto(route.path);
    // oxlint-disable-next-line no-await-in-loop -- verify the explicit theme on each navigation.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // oxlint-disable-next-line no-await-in-loop -- axe must inspect each rendered page.
    await expectAccessible(page);
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(resolvedTheme).toContainText('Theme preference dark; currently dark.');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await testInfo.attach('overview-dark', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  for (const route of routes) {
    // oxlint-disable-next-line no-await-in-loop -- each public page needs dark-theme acceptance.
    await page.goto(route.path);
    // oxlint-disable-next-line no-await-in-loop -- verify the persisted theme on each navigation.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // oxlint-disable-next-line no-await-in-loop -- axe must inspect each rendered page.
    await expectAccessible(page);
  }

  await page.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-setting', 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(resolvedTheme).toContainText('Theme preference system; currently light.');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(resolvedTheme).toContainText('Theme preference system; currently dark.');
});

test('light not-found actions and the focused skip link retain accessible contrast', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const response = await page.goto('/not-found-light-theme');
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const primaryAction = page.getByRole('link', { name: 'Return to the index' });
  await expect(primaryAction).toBeVisible();
  await expectTextContrast(primaryAction);

  const skipLink = page.getByRole('link', { name: 'Skip to content' });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await expectTextContrast(skipLink);
  await expectAccessible(page);
});
