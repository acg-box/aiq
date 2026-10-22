import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('partial public Supabase configuration fails closed with its missing-variable diagnostic', async ({
  page,
}) => {
  const response = await page.goto('/benchmarks/intelligence');
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Published results unavailable.', exact: true }),
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
