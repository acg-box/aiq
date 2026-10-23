import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectUnavailableCore(page: Page) {
  const response = await page.goto('/benchmarks/intelligence');
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Published results unavailable.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Board coverage' })).toHaveText(
    '72 tasks in design10 domains in designMeasurements unavailable',
  );
  await expect(page.getByRole('tab', { name: 'Leaderboard', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: /^Details: Evidence for / })).toHaveCount(0);
  await expect(page.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Demo values are synthetic seed data', { exact: false })).toHaveCount(
    0,
  );
  await expect(page.getByText('No Official results in this preview.', { exact: true })).toHaveCount(
    0,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
