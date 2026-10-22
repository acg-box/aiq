import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { selectTheme } from './workspace-helpers.ts';

const seedCalibrationRunId = `run_${'c'.repeat(64)}`;

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

const routes = [
  '/benchmarks/intelligence',
  '/benchmarks/intelligence?view=records',
  '/benchmarks/intelligence?view=method',
  '/benchmarks/intelligence/calibrations',
  `/benchmarks/intelligence/calibrations/${seedCalibrationRunId}`,
  '/benchmarks/intelligence/verification',
  '/benchmarks/memory',
] as const;
for (const path of routes) {
  test(`${path} uses one board shell with current uncached evidence`, async ({
    page,
  }, testInfo) => {
    const failures = monitorErrors(page);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['cache-control']).toContain('no-store');
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    expect(response?.headers()['x-frame-options']).toBe('DENY');
    await expect(page.locator('main h1').first()).toBeVisible();
    await expectNoDocumentOverflow(page, testInfo);
    await expectAccessible(page);
    expect(failures).toEqual([]);
  });
}
test('synthetic calibration evidence stays visibly separate and selectable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/benchmarks/intelligence/calibrations');
  const register = page.getByRole('region', { name: 'Public calibration register' });
  await expect(register.getByRole('row')).toHaveCount(2);
  await expect(register).toContainText('Synthetic seed');
  await expect(register.getByRole('link', { name: 'Inspect calibration' })).toBeInViewport();
  await register.getByRole('link', { name: 'Inspect calibration' }).click();
  await expect(page).toHaveURL(
    `/benchmarks/intelligence/calibrations/${seedCalibrationRunId}?${new URLSearchParams({ return: '/benchmarks/intelligence/calibrations' })}`,
  );
  await expect(
    page.getByRole('link', { name: '← Back to calibrations', exact: true }),
  ).toHaveAttribute('href', '/benchmarks/intelligence/calibrations');
  await expect(page.getByLabel('Model and reasoning configuration').locator('option')).toHaveCount(
    1,
  );
  await expect(page.getByRole('status', { name: 'Calibration result count' })).toContainText(
    'Showing 1 of 1 result cells',
  );
  await expect(
    page.getByRole('region', { name: 'Calibration results' }).getByRole('row'),
  ).toHaveCount(2);
  expect(
    await page
      .getByRole('region', { name: 'Calibration results' })
      .locator('tbody tr:not(.row-expanded)')
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThan(200);
  await expect(page.getByText('v1.1.0', { exact: true })).toBeVisible();
  await page
    .locator('.calibration-efficiency-table')
    .getByRole('button', { name: 'Details for sol low', exact: true })
    .click();
  const details = page.locator('.calibration-efficiency-table .row-expanded');
  await details.locator('.row-detail-context > summary').click();
  await expect(
    details
      .locator('dt')
      .filter({ hasText: /^Adapter invocation/ })
      .locator('..')
      .locator('dd'),
  ).toHaveText('0/0');
  await expect(
    details
      .locator('dt')
      .filter({ hasText: /^Runtime issues/ })
      .locator('..')
      .locator('dd'),
  ).toHaveText('0');
  await expect(
    details
      .locator('dt')
      .filter({ hasText: /^Missing/ })
      .locator('..')
      .locator('dd'),
  ).toHaveText('0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectAccessible(page);
});

test('radar separates synthetic registry, observation, and aggregation evidence', async ({
  page,
}, testInfo) => {
  const runtimeFailures = monitorErrors(page);
  await page.goto('/benchmarks/intelligence/verification');
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
  await expect(registry.getByRole('columnheader', { name: 'Telemetry' })).toHaveCount(1);
  await expect(registry.getByRole('columnheader', { name: 'Registry record' })).toHaveCount(0);
  await expect(registry.getByText('ready · signature unverified', { exact: true })).toBeVisible();
  await expect(registry.getByText('busy · signature rejected', { exact: true })).toBeVisible();
  await expect(registry.getByText('offline · signature unverified', { exact: true })).toBeVisible();
  await expectNoDocumentOverflow(page, testInfo);
  await expectAccessible(page);
  expect(runtimeFailures).toEqual([]);
});

test('methodology exposes task scoring and equal domain weighting', async ({ page }) => {
  await page.goto('/benchmarks/intelligence?view=method');
  await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Task score', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Committed weighted checks with explicit hard gates' }),
  ).toBeVisible();
  await expect(
    page.getByText('hard gate or structural failure ? 0 : Σ(weight × passed) ÷ Σ(weight)'),
  ).toBeVisible();
  await expect(page.getByText('unscored and blocks Official publication')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Domains', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Domain coverage', exact: true })).toBeVisible();
  await expect(
    page.getByText('72 tasks · 10 equally weighted domains', { exact: true }),
  ).toBeVisible();
  const coverage = page.getByRole('table', {
    name: 'Exact fixed-fixture domain task counts and macro-average weights.',
  });
  await expect(coverage.getByRole('row')).toHaveCount(12);
  await expect(coverage.getByRole('row').filter({ hasText: 'coding' })).toContainText('8');
  await expect(coverage.getByRole('row').filter({ hasText: 'coding' })).toContainText('10%');
  await expect(
    coverage.getByRole('row').filter({ hasText: 'instruction following' }),
  ).toContainText('6');
  await expect(coverage.getByRole('row').filter({ hasText: 'Total' })).toContainText('72');
  await expect(coverage.getByRole('row').filter({ hasText: 'Total' })).toContainText('100%');
});

test('trend chart exposes scaled score and UTC date axes at narrow widths', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/benchmarks/intelligence?view=records&range=all');
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
    ['var(--plot-teal)', 'var(--plot-amber)', 'var(--plot-rose)'],
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

test('reduced-motion preferences disable smooth scrolling and transitions', async ({ page }) => {
  const runtimeFailures = monitorErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/benchmarks/intelligence?view=records&range=all');

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

test('theme selection persists across both boards and a narrow layout', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/benchmarks/memory');
  await selectTheme(page, 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectAccessible(page);
  await page.goto('/benchmarks/intelligence');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await selectTheme(page, 'light');
  await expectAccessible(page);
  await expectNoDocumentOverflow(page, testInfo);
});
