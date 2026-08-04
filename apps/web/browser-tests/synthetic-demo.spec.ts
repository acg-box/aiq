import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const seedCalibrationRunId = `run_${'c'.repeat(64)}`;

const routes = [
  { path: '/', heading: 'A score is only useful', navigation: 'Overview' },
  { path: '/runs', heading: 'Every public run stays inspectable.', navigation: 'Runs' },
  {
    path: '/calibrations',
    heading: 'Verified provenance',
    navigation: 'Calibrations',
  },
  {
    path: `/calibrations/${seedCalibrationRunId}`,
    heading: 'Verified provenance',
    navigation: 'Calibrations',
  },
  { path: '/compare', heading: 'One model is not one behavior.', navigation: 'Compare' },
  { path: '/trends', heading: 'The past remains part of the record.', navigation: 'Trends' },
  { path: '/radar', heading: 'Know the runner behind the result.', navigation: 'Radar' },
  {
    path: '/method',
    heading: 'Transparent scoring, version by version.',
    navigation: 'Method',
  },
] as const;

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
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
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
  await expect(
    page.getByText('Highest synthetic seed point estimate', { exact: true }),
  ).toBeVisible();

  const leaderboard = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  await expect(leaderboard.getByRole('row')).toHaveCount(18);
  await expect(
    leaderboard.getByText('This order does not identify a statistical winner.', { exact: false }),
  ).toBeVisible();
  await expect(leaderboard.getByRole('columnheader', { name: 'Rank' })).toHaveCount(0);
  const inspectLinks = leaderboard.getByRole('link', { name: 'Inspect' });
  await expect(inspectLinks).toHaveCount(17);
  await expect(page.getByLabel('Index summary').getByText('17', { exact: true })).toBeVisible();

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
    has: page.locator('.result-failed'),
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

test('synthetic calibration evidence stays visibly separate and selectable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Latest verified calibration' })).toBeVisible();
  await expect(
    page.getByText('not Official / not ranking eligible', { exact: false }),
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
  await expect(page.getByRole('status')).toContainText('Showing 1 of 1 result cells');
  await expect(
    page.getByRole('region', { name: 'Calibration results' }).getByRole('row'),
  ).toHaveCount(2);
  await expect(page.getByText('v1.0.2', { exact: true })).toBeVisible();
  await expect(
    page.getByText('0 attempted · 0 adapter-invoked · 0 elapsed-observed'),
  ).toBeVisible();
});

test('radar separates synthetic registry, observation, and aggregation evidence', async ({
  page,
}, testInfo) => {
  const runtimeFailures = monitorErrors(page);
  await page.goto('/radar');
  await expect(page.getByText('Synthetic and unverified', { exact: true })).toHaveCount(3);
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

test('methodology describes equal weighting while preserving domain task counts', async ({
  page,
}) => {
  await page.goto('/method');
  await expect(
    page.getByRole('heading', { name: '72 tasks · 10 equally weighted domains' }),
  ).toBeVisible();
  const coverage = page.locator('.domain-bars');
  await expect(coverage).toContainText('coding');
  await expect(coverage).toContainText('8 tasks · 10%');
  await expect(coverage).toContainText('6 tasks · 10%');
});

test('a user can discover and inspect a missing-result run from history', async ({
  page,
}, testInfo) => {
  const runtimeFailures = monitorErrors(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page).toHaveURL('/runs');

  const history = page.getByRole('region', { name: 'Public run history' });
  await expect(history.getByRole('row')).toHaveCount(11);
  await page.getByRole('link', { name: 'Older runs' }).click();
  await expect(page).toHaveURL(/\/runs\?before=/);
  await expect(history.getByRole('row')).toHaveCount(9);
  const missingRun = history.getByRole('row').filter({ hasText: 'Coverage-only · not ranked' });
  await expect(missingRun).toHaveCount(1);
  await expect(missingRun).toContainText('14');
  await missingRun.getByRole('link', { name: 'Inspect run' }).click();

  await expect(page).toHaveURL('/runs/run-2026-07-05-coverage-only-sol-ultra');
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
  await expect(domains.getByRole('columnheader', { name: 'Succeeded' })).toBeVisible();
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
  const disclosure = page.getByText('Read trend values as a table', { exact: true });
  await disclosure.click();
  const trendRows = page.locator('.data-disclosure tbody tr');
  const allHistoryCount = await trendRows.count();
  expect(allHistoryCount).toBeGreaterThan(5);
  const legend = page.getByRole('list', { name: 'Trend series' });
  await expect(legend.getByRole('listitem')).toHaveCount(17);
  await expect(
    legend.getByRole('listitem').filter({ hasText: 'No observations in selected range' }),
  ).toHaveCount(12);
  await expect(page.getByRole('note')).toContainText(
    'Synthetic fixture points do not claim a matching run detail',
  );

  const day = page.getByRole('link', { name: 'Day' });
  await day.click();
  await expect(page).toHaveURL('/trends?range=day');
  await expect(day).toHaveAttribute('aria-current', 'page');
  expect(await trendRows.count()).toBeLessThan(allHistoryCount);
  expect(allHistoryCount).toBeLessThanOrEqual(100);
  await expect(page.getByRole('note')).toContainText('latest exact Official run in its bucket');
  await expect(page.getByRole('columnheader', { name: 'Bucket coverage' })).toBeVisible();
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
    await expect(legend.getByRole('listitem')).toHaveCount(17);
  }

  expect(runtimeFailures).toEqual([]);
  const invalidRange = await page.goto('/trends?range=year');
  expect(invalidRange?.status()).toBe(404);
  await expect(
    page.getByRole('heading', { name: 'This evidence is not in the index.' }),
  ).toBeVisible();
  expect(runtimeFailures.every((failure) => failure.includes('404 (Not Found)'))).toBe(true);
  runtimeFailures.length = 0;

  await page.getByRole('link', { name: 'Compare', exact: true }).click();
  await expect(page).toHaveURL('/compare');
  const firstModel = page.getByLabel('First model and reasoning level');
  const difference = page.getByText('Descriptive point-estimate difference:', { exact: false });
  const initialDifference = await difference.textContent();
  await firstModel.selectOption({ index: 3 });
  await expect(difference).not.toHaveText(initialDifference ?? '');
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
  await page.goto('/trends');
  const chart = page.getByRole('img', { name: 'AIQ score history' });
  await expect(chart).toBeVisible();
  await expect(chart.getByText('AIQ score', { exact: true })).toBeVisible();
  await expect(chart.getByText('Observation date (UTC)', { exact: true })).toBeVisible();
  const scoreLabels = await chart.locator('.chart-axis text').allTextContents();
  expect(scoreLabels.some((label) => /^\d+(?:\.\d)?$/.test(label))).toBe(true);
  expect(scoreLabels.some((label) => /^[A-Z][a-z]{2} \d{1,2}$/.test(label))).toBe(true);
  const narrowTick = chart.locator('.chart-axis text:not(.axis-label)').first();
  const renderedText = await narrowTick.evaluate((label) => {
    const svg = label.closest('svg');
    if (!svg) return { fontSize: 0, glyphHeight: 0 };
    const viewBoxWidth = Number(svg.getAttribute('viewBox')?.split(/\s+/)[2] ?? 0);
    const scale = viewBoxWidth === 0 ? 0 : svg.getBoundingClientRect().width / viewBoxWidth;
    return {
      fontSize: Number.parseFloat(getComputedStyle(label).fontSize) * scale,
      glyphHeight: label.getBoundingClientRect().height,
    };
  });
  expect(renderedText.fontSize).toBeGreaterThanOrEqual(10);
  expect(renderedText.glyphHeight).toBeGreaterThanOrEqual(9);
  const box = await chart.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320);
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

  await expect(
    page.getByRole('heading', { level: 1, name: /A score is only useful/ }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expectNoDocumentOverflow(page, testInfo);
  expect(runtimeFailures).toEqual([]);
});

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
