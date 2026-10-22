import { openStudyEvidence } from './workspace-helpers.ts';
import { expect, test } from '@playwright/test';

test('the comparison overview is in server markup before client controls load', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 400 });
  const response = await page.goto('/benchmarks/memory');
  expect(response?.status()).toBe(200);
  const markup = await response?.text();
  expect(markup).toContain('11/13');
  expect(markup).toContain('0.024261');
  expect(markup).toContain('Leaderboard');
  expect(markup).not.toContain('data-homepage-analytics-loading');
  const comparison = page.getByRole('region', {
    name: 'October 15 · native retrieval results',
    exact: true,
  });
  await expect(comparison.locator('tbody tr')).toHaveCount(2);
  const overview = page.getByRole('table', { name: 'Memory comparison overview', exact: true });
  await expect(overview.locator('tbody tr')).toHaveCount(6);
  expect((await overview.boundingBox())?.y).toBeLessThan(400);
  const opened = await openStudyEvidence(page, 'OpenViking');
  await expect(opened.content).toContainText('11/13');
});
