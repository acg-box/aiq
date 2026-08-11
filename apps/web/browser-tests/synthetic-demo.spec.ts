import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const seedCalibrationRunId = `run_${'c'.repeat(64)}`;

const routes = [
  { path: '/', heading: 'Synthetic preview', navigation: 'Results' },
  { path: '/runs', heading: 'Run archive', navigation: 'Evidence' },
  {
    path: '/calibrations',
    heading: 'Calibration evidence',
    navigation: 'Evidence',
  },
  {
    path: `/calibrations/${seedCalibrationRunId}`,
    heading: 'Calibration run',
    navigation: 'Evidence',
  },
  { path: '/compare', heading: 'Compare the complete matrix', navigation: 'Compare' },
  { path: '/trends', heading: 'AIQ over time', navigation: 'Trends' },
  { path: '/radar', heading: 'Runner network', navigation: 'Evidence' },
  {
    path: '/method',
    heading: 'How AIQ is scored',
    navigation: 'Evidence',
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
    let backgroundElement: Element | null = element;
    let backgroundColor = style.backgroundColor;
    while (backgroundElement.parentElement && /rgba?\([^)]*,\s*0\s*\)$/.test(backgroundColor)) {
      backgroundElement = backgroundElement.parentElement;
      backgroundColor = getComputedStyle(backgroundElement).backgroundColor;
    }
    const background = luminance(backgroundColor);
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

test('workspace navigation keeps the selected destination active while scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');

  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const compare = navigation.getByRole('link', { name: 'Compare', exact: true });
  await compare.click();
  const activeLinks = await page.evaluate(async () => {
    const observed: string[] = [];
    for (let frame = 0; frame < 150; frame += 1) {
      observed.push(
        document.querySelector<HTMLElement>(
          'nav[aria-label="Main navigation"] a[aria-current="page"]',
        )?.innerText ?? '',
      );
      // oxlint-disable-next-line no-await-in-loop -- consecutive frames record the transition order.
      await new Promise(requestAnimationFrame);
    }
    return observed;
  });

  await expect(page).toHaveURL('/#compare');
  await expect(compare).toHaveAttribute('aria-current', 'page');
  expect(new Set(activeLinks.filter(Boolean))).toEqual(new Set(['Compare']));

  await page.locator('#results').evaluate((section) =>
    section.scrollIntoView({
      behavior: 'instant',
      block: 'start',
    }),
  );
  await expect(navigation.getByRole('link', { name: 'Results', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await compare.click();
  await expect
    .poll(() =>
      page
        .locator('#compare')
        .evaluate((section) => Math.round(section.getBoundingClientRect().top)),
    )
    .toBeLessThanOrEqual(85);
  await expect(page).toHaveURL('/#compare');
  await expect(compare).toHaveAttribute('aria-current', 'page');

  await navigation.getByRole('link', { name: 'Trends', exact: true }).click();
  await page.getByLabel('Trend measure').getByRole('button', { name: 'Time', exact: true }).click();
  await page
    .getByLabel('Trend chart mode')
    .getByRole('button', { name: 'Bar', exact: true })
    .click();
  await expect(page).toHaveURL('/?trendEncoding=bar&trendMetric=duration#trends');
  await compare.click();
  await expect(page).toHaveURL('/?trendEncoding=bar&trendMetric=duration#compare');
  await expect
    .poll(() =>
      page
        .locator('#compare')
        .evaluate((section) => Math.round(section.getBoundingClientRect().top)),
    )
    .toBeLessThanOrEqual(85);
  await expect(compare).toHaveAttribute('aria-current', 'page');
});

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
  const ranking = page.getByRole('region', { name: 'Top configurations' });
  await expect(ranking).toBeVisible();
  await expect(ranking.getByRole('listitem')).toHaveCount(5);
  await expect(ranking).toContainText('Synthetic quality preview · not Official');
  await page.locator('[data-homepage-analytics="matrix"]').scrollIntoViewIfNeeded();
  const chart = page.getByRole('region', { name: 'Quality score by configuration' });
  await expect(chart).toBeVisible();
  await chart.getByText('Read 17 configuration values', { exact: true }).click();
  const values = chart.getByRole('region', { name: 'AIQ configuration values' });
  await expect(values.getByRole('row')).toHaveCount(18);
  await expect(values.getByRole('columnheader', { name: 'Rank' })).toHaveCount(0);
  await expect(values.getByRole('cell', { name: 'Synthetic', exact: true })).toHaveCount(17);

  const runHref = await ranking.locator('.ranking-identity a').first().getAttribute('href');
  expect(runHref).toMatch(/^\/runs\/run-2026-07-\d{2}-/);
  const runResponse = await page.goto(runHref ?? '/runs/unavailable');
  expect(runResponse?.headers()['cache-control']).toContain('no-store');
  await expect(page).toHaveURL(/\/runs\/run-2026-07-\d{2}-/);
  await expect(page).toHaveTitle(/Run detail · AIQ/);
  await expect(page.getByRole('link', { name: 'Evidence', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Sol|Terra|Luna/);
  await expect(page.locator('.task-list > article')).toHaveCount(72);
  await expect(page.locator('.task-list')).toContainText('Codex adapter elapsed: unavailable');
  await expect(page.locator('.task-list')).not.toContainText('runner-observed');
  await expect(page.locator('.task-list .result-completed')).toHaveCount(72);
  await expect(page.locator('.task-list .result-runtime_issue')).toHaveCount(0);
  await expect(page.locator('.task-list .result-explanation')).toHaveCount(0);
  await expectNoDocumentOverflow(page, testInfo);
  await expectAccessible(page);
  expect(runtimeFailures).toEqual([]);
});

test('the overview workspace exposes evidence and switches chart modes and family', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.locator('[data-homepage-analytics="matrix"]').scrollIntoViewIfNeeded();
  const chart = page.getByRole('region', { name: 'Quality score by configuration' });
  const bars = chart.getByRole('button', { name: 'Bars + interval', exact: true });
  const dots = chart.getByRole('button', { name: 'Dot + interval', exact: true });
  const ordered = chart.getByRole('button', { name: 'Ordered + interval', exact: true });
  await expect(dots).toHaveAttribute('aria-pressed', 'true');
  await expect(bars).toHaveAttribute('aria-pressed', 'false');
  await expect(chart.getByRole('img', { name: /Dots with task-mix sensitivity/ })).toBeVisible();
  await page.setViewportSize({ width: 620, height: 900 });
  await expect(ordered).toHaveAttribute('aria-pressed', 'true');
  await expect(
    chart.getByRole('img', { name: /Ordered horizontal bars with task-mix sensitivity/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await dots.click();
  await expect(chart.locator('.matrix-chart-svg svg')).toBeVisible();
  await bars.click();
  await expect(bars).toHaveAttribute('aria-pressed', 'true');
  await expect(
    chart.getByRole('img', { name: /Zero-baseline bars with task-mix sensitivity/ }),
  ).toBeVisible();
  await ordered.click();
  await expect(ordered).toHaveAttribute('aria-pressed', 'true');
  await expect(bars).toHaveAttribute('aria-pressed', 'false');
  await expect(
    chart.getByRole('img', { name: /Ordered horizontal bars with task-mix sensitivity/ }),
  ).toBeVisible();
  await chart.getByRole('button', { name: 'Sol', exact: true }).click();
  await expect(chart.getByText('Showing 6 Sol configurations as ordered.')).toBeAttached();
  const selected = chart.locator('.matrix-encoding-note[aria-live="polite"]');
  await expect(selected).toContainText('task-mix sensitivity');
  await expect(chart.getByText('Dot + CI', { exact: true })).toHaveCount(0);
  await expect(selected).toContainText('coverage 100.0%');
  await expect(selected).toContainText('scoring 1.0.8 · synthetic');
  const valuesDisclosure = chart.getByText('Read 6 configuration values', { exact: true });
  await valuesDisclosure.click();
  const valuesTable = chart.getByRole('region', { name: 'AIQ configuration values' });
  await expect(valuesTable).toBeVisible();
  for (const heading of [
    'Primary interval',
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
  const outcomeCard = page.getByRole('region', { name: 'Domain profile' });
  await expect(
    outcomeCard.getByRole('img', { name: 'Average task score by benchmark domain' }),
  ).toBeVisible();
  await expect(outcomeCard.getByText('Runtime / invalid', { exact: true })).toBeVisible();
  await expect(outcomeCard.getByText('Missing / N/A', { exact: true })).toBeVisible();
  await expect(outcomeCard).toContainText('A zero is a scored outcome, not missing data.');
  await page.locator('#results > details.evidence-notes > summary').click();
  await expect(page.getByText('Summed adapter time', { exact: true })).toBeVisible();
  await expect(page.getByText('API-equivalent cost', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Synthetic / seed data', { exact: true }).first()).toBeVisible();
  await expectNoDocumentOverflow(page, testInfo);
});

test('matrix points remain visible while the pointer moves across them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?matrixEncoding=dots#results');
  await page.locator('[data-homepage-analytics="matrix"]').scrollIntoViewIfNeeded();
  const chart = page.getByRole('region', { name: 'Quality score by configuration' });
  await expect(chart.locator('.matrix-chart-svg svg')).toBeVisible();

  const pointPositions = await chart.locator('.matrix-chart-svg svg path').evaluateAll((paths) => {
    return paths
      .filter((path) => path.getAttribute('fill')?.startsWith('var(--data-'))
      .slice(0, 3)
      .map((path) => {
        const bounds = path.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      });
  });
  const [first, second, third] = pointPositions;
  if (!first || !second || !third) throw new Error('Expected at least three matrix points');

  const expectEveryPointVisible = async () => {
    const pointFills = await chart.locator('.matrix-chart-svg svg path').evaluateAll((paths) => {
      return paths
        .filter((path) => path.getAttribute('d')?.startsWith('M1 0A1 1'))
        .map((path) => path.getAttribute('fill'));
    });
    expect(pointFills).toHaveLength(17);
    expect(pointFills).not.toContain('none');
  };

  await page.mouse.move(first.x, first.y);
  await expectEveryPointVisible();
  await page.mouse.move(second.x, second.y);
  await expectEveryPointVisible();
  await page.mouse.move(third.x, third.y);
  await expectEveryPointVisible();
});

test('synthetic calibration evidence stays visibly separate and selectable', async ({ page }) => {
  await page.goto('/');
  const evidenceNotes = page.locator('#results > details.evidence-notes');
  await evidenceNotes.locator(':scope > summary').click();
  const calibrationDisclosure = evidenceNotes
    .locator('details.data-disclosure')
    .filter({ hasText: 'Latest non-ranking calibration evidence' });
  await calibrationDisclosure.locator(':scope > summary').click();
  await expect(calibrationDisclosure).toHaveAttribute('open', '');
  await expect(
    calibrationDisclosure.getByText(/not Official.*not ranking eligible/, { exact: false }).first(),
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
  await expect(page.getByText('v1.0.7', { exact: true })).toBeVisible();
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
  await page.locator('details.radar-node-details > summary').click();
  await expect(
    page.locator('.node-card').getByText('Synthetic and unverified', { exact: true }),
  ).toHaveCount(3);
  await expect(page.getByText('Registry trust: unverified', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Latest signed observation record' })).toHaveCount(
    3,
  );
  await expect(page.getByRole('heading', { name: 'Trust-layer aggregation' })).toHaveCount(3);
  await expect(page.getByText('Receiver-verified trusted', { exact: true })).toHaveCount(3);
  const registry = page.getByRole('region', { name: 'Runner registry evidence' });
  await expect(registry.getByRole('columnheader', { name: 'Telemetry' })).toBeVisible();
  await expect(registry.getByRole('columnheader', { name: 'Registry record' })).toHaveCount(0);
  await expect(registry.getByText('ready · signature unverified', { exact: true })).toBeVisible();
  await expect(registry.getByText('busy · signature rejected', { exact: true })).toBeVisible();
  await expect(registry.getByText('offline · signature unverified', { exact: true })).toBeVisible();
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
  await page.getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page).toHaveURL('/#runs');
  await expect(page.getByText('Open any configuration', { exact: false })).toBeVisible();
  await expect(page.getByText('72 task results', { exact: false })).toBeVisible();
  await expect(
    page.getByText('failures, timing, cost, and provenance', { exact: false }),
  ).toBeVisible();

  const history = page.getByRole('region', { name: 'Public run history' });
  await expect(history.getByRole('row')).toHaveCount(11);
  await page.getByRole('link', { name: 'Older runs' }).click();
  await expect(page).toHaveURL(/\/?\?before=.*#runs/);
  await expect(history.getByRole('row')).toHaveCount(9);
  const missingRun = history.getByRole('row').filter({ hasText: 'Coverage-only · not ranked' });
  await expect(missingRun).toHaveCount(1);
  await expect(missingRun).toContainText('14');
  await expect(missingRun.getByText('Quality score', { exact: true }).first()).toBeVisible();
  await expect(missingRun.getByText('Coverage', { exact: true })).toBeVisible();
  await expect(missingRun.getByText('Runtime issues', { exact: true })).toBeVisible();
  await expect(missingRun.getByText('Missing', { exact: true })).toBeVisible();
  await missingRun.getByText('More evidence', { exact: true }).click();
  await expect(missingRun.getByText('Time / cost coverage', { exact: true })).toBeVisible();
  await missingRun.getByRole('link', { name: 'Inspect run' }).click();

  await expect(page).toHaveURL('/runs/run-2026-07-05-coverage-only-sol-ultra');
  await page.locator('details.run-evidence-notes > summary').click();
  await expect(page.getByText('Coverage-only · not ranked', { exact: true })).toBeVisible();
  await expect(
    page.getByText('One complete Official batch contains 17 runs', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('1,224 task attempts', { exact: false })).toBeVisible();
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
  await expect(page).toHaveURL('/#runs');
  await expectNoDocumentOverflow(page, testInfo);
  await expectAccessible(page);
  expect(runtimeFailures).toEqual([]);
});

test('time range filters update and comparison fails closed without exact efficiency', async ({
  page,
}) => {
  const runtimeFailures = monitorErrors(page);
  await page.goto('/trends');
  const disclosure = page.getByText('Evidence notes and visible values', { exact: true });
  await disclosure.click();
  const trendRows = page.getByRole('region', { name: 'Visible trend values' }).locator('tbody tr');
  const allHistoryCount = await trendRows.count();
  expect(allHistoryCount).toBeGreaterThan(5);
  const legend = page.getByRole('list', { name: 'Visible trend series' });
  await expect(legend.getByRole('listitem')).toHaveCount(17);
  await expect(page.getByRole('note')).toContainText(
    'Family and reasoning are explicit filters, not point-estimate cutoffs.',
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
    // oxlint-disable-next-line no-await-in-loop -- all configurations must survive each range.
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
  await expect(page).toHaveURL('/#compare');
  await expect(page.getByLabel('Selected run context status')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Top configurations' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Compare configurations' })).toHaveCount(0);
  await page.goto('/compare');
  await expect(page.getByLabel('Comparison workspace status')).toContainText(
    'The exact 17-configuration score, run, and efficiency join is unavailable.',
  );
  await expect(page.getByRole('region', { name: 'Compare configurations' })).toHaveCount(0);
  expect(runtimeFailures).toEqual([]);
});

test('trend chart exposes scaled score and UTC date axes at narrow widths', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/trends?range=all');
  const chart = page.getByRole('img', { name: 'AIQ (0–100) history' });
  await expect(chart).toBeVisible();
  await expect(chart.getByText('AIQ (0–100)', { exact: true })).toBeVisible();
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
    'AIQ (0–100) history. Grouped bars with provenance-matched intervals.',
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
        barCount === intervalCount && maximumCenterDelta <= 2,
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
  await page.goto('/', { waitUntil: 'networkidle' });
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

  await expect(page.getByRole('heading', { level: 1, name: 'Synthetic preview' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.locator('[data-homepage-analytics="matrix"]').scrollIntoViewIfNeeded();
  const chart = page.getByRole('region', { name: 'Quality score by configuration' });
  await expect(chart.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    chart.getByRole('button', { name: 'Ordered + interval', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    chart.getByRole('img', {
      name: /Ordered horizontal bars with task-mix sensitivity compare quality score for 17 configurations/,
    }),
  ).toBeVisible();
  await expect(
    chart.getByText('All 17 scored configurations shown', { exact: false }),
  ).toBeVisible();
  await expect(chart.getByText('Read 17 configuration values', { exact: true })).toBeVisible();
  const chartBox = await chart.locator('.matrix-chart-svg').boundingBox();
  expect(chartBox?.height ?? 0).toBeGreaterThanOrEqual(500);
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
  test(`the ${viewport.width}-pixel first viewport leads with benchmark insights`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const ranking = page.getByRole('region', { name: 'Top configurations' });
    await expect(ranking).toBeVisible();
    await expect(ranking.getByRole('listitem')).toHaveCount(5);
    const rankingBox = await ranking.boundingBox();
    expect(rankingBox).not.toBeNull();
    expect(rankingBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(viewport.height);
    const firstEvidenceRowBox = await ranking.getByRole('listitem').first().boundingBox();
    expect(firstEvidenceRowBox).not.toBeNull();
    expect(
      (firstEvidenceRowBox?.y ?? viewport.height) + (firstEvidenceRowBox?.height ?? 0),
    ).toBeLessThanOrEqual(viewport.height);
    const analyticsBox = await page.locator('[data-homepage-analytics="matrix"]').boundingBox();
    expect(analyticsBox).not.toBeNull();
    expect(rankingBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
      analyticsBox?.y ?? Number.NEGATIVE_INFINITY,
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
    await expect(page.locator('main h1').first()).toBeVisible();
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
  await expect(page.getByRole('link', { name: 'Trends', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Evidence', exact: true })).toBeVisible();
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
  test.slow();
  test.skip(
    browserName !== 'chromium',
    'Theme page-by-page acceptance is captured once in Chromium.',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const resolvedTheme = page.getByRole('status', { name: 'Resolved color theme' });
  await expect(resolvedTheme).toContainText('Theme preference system; currently light.');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 246, 247)');
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
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(8, 9, 10)');
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

  await page.getByRole('button', { name: 'Use device theme', exact: true }).click();
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
