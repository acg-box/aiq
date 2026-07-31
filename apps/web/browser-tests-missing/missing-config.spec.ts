import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('production without public Supabase configuration never publishes synthetic seed data', async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('invalid config', { exact: true })).toBeVisible();
  await expect(page.getByText('Published evidence unavailable', { exact: true })).toBeVisible();
  await expect(
    page
      .getByText('Synthetic seed mode requires NODE_ENV to be development or test', {
        exact: false,
      })
      .first(),
  ).toBeVisible();
  await expect(page.getByText('public data', { exact: true })).toHaveCount(0);
  await expect(page.getByText('seed mode', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Demo values are synthetic seed data', { exact: false })).toHaveCount(
    0,
  );
  await expect(page.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0);
  expect(await new AxeBuilder({ page }).analyze()).toMatchObject({ violations: [] });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});
