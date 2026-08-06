import { expect, test } from '@playwright/test';

test('the homepage keeps exact evidence in server markup and defers analytics', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 400 });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  const serverMarkup = await response?.text();
  expect(serverMarkup).toContain('Synthetic matrix preview');
  expect(serverMarkup).toContain('Selected configuration exact-run snapshot');
  expect(serverMarkup).toContain('Exact run completed');
  expect(serverMarkup).toContain('data-homepage-analytics-loading="matrix"');
  expect(serverMarkup).toContain('Loading interactive configuration matrix');
  expect(serverMarkup).not.toContain('AIQ index by configuration');

  const snapshot = page.getByLabel('Selected configuration exact-run snapshot');
  await expect(snapshot).toContainText(/configuration \S+ · exact run \S+/);
  await expect(snapshot.locator('dl')).not.toHaveAttribute('tabindex', /.+/);
  const analytics = page.locator('[data-homepage-analytics="matrix"]');
  const loading = analytics.locator('[data-homepage-analytics-loading="matrix"]');
  await expect(loading).toHaveRole('status');
  await expect(loading).toContainText('Loading interactive configuration matrix');
  const reservedBox = await analytics.boundingBox();
  expect(reservedBox?.height ?? 0).toBeGreaterThanOrEqual(1_080);
  await expect(page.getByRole('region', { name: 'AIQ index by configuration' })).toHaveCount(0);

  const initialScriptCount = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/_next/static/chunks/')).length,
  );
  await analytics.evaluate((element) => {
    const documentTop = element.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, documentTop - window.innerHeight - 250);
  });
  await expect(loading).toHaveCount(0);
  const preloadedBox = await analytics.boundingBox();
  expect(preloadedBox?.y ?? 0).toBeGreaterThanOrEqual(400);
  await expect(page.getByRole('region', { name: 'AIQ index by configuration' })).toHaveCount(1);

  await analytics.scrollIntoViewIfNeeded();
  await expect(page.getByRole('region', { name: 'AIQ index by configuration' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Ordered + interval', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const loadedBox = await analytics.boundingBox();
  expect(loadedBox?.height ?? 0).toBeGreaterThanOrEqual(1_080);
  expect(Math.abs((loadedBox?.height ?? 0) - (reservedBox?.height ?? 0))).toBeLessThan(240);
  const loadedScriptCount = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/_next/static/chunks/')).length,
  );
  expect(loadedScriptCount).toBeGreaterThan(initialScriptCount);
});
