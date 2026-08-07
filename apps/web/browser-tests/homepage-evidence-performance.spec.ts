import { expect, test } from '@playwright/test';

test('the homepage keeps exact evidence in server markup and defers analytics', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 400 });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  const serverMarkup = await response?.text();
  expect(serverMarkup).toContain('Synthetic benchmark');
  expect(serverMarkup).toContain('Top configurations');
  expect(serverMarkup).toContain('Domain profile');
  expect(serverMarkup).toContain('data-homepage-analytics-loading="matrix"');
  expect(serverMarkup).toContain('Loading interactive configuration matrix');
  expect(serverMarkup).not.toContain('Quality score by configuration');

  const ranking = page.getByRole('region', { name: 'Top configurations' });
  await expect(ranking.getByRole('listitem')).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Domain profile' })).toBeAttached();
  const analytics = page.locator('[data-homepage-analytics="matrix"]');
  const reservedBox = await analytics.boundingBox();
  expect(reservedBox?.height ?? 0).toBeGreaterThanOrEqual(430);

  await analytics.evaluate((element) => {
    const documentTop = element.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, documentTop - window.innerHeight - 250);
  });
  const preloadedBox = await analytics.boundingBox();
  expect(preloadedBox?.y ?? 0).toBeGreaterThanOrEqual(400);
  await expect(page.getByRole('region', { name: 'Quality score by configuration' })).toHaveCount(1);

  await analytics.scrollIntoViewIfNeeded();
  await expect(page.getByRole('region', { name: 'Quality score by configuration' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Ordered + interval', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const loadedBox = await analytics.boundingBox();
  expect(loadedBox?.height ?? 0).toBeGreaterThanOrEqual(430);
  expect(Math.abs((loadedBox?.height ?? 0) - (reservedBox?.height ?? 0))).toBeLessThan(180);
});
