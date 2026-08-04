import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('malformed public Supabase configuration fails closed with sanitized diagnostics', async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('invalid config', { exact: true })).toBeVisible();
  await expect(page.getByText('Invalid public data configuration', { exact: false })).toBeVisible();
  await expect(
    page.getByText('Published evidence unavailable', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByText('must be an origin without credentials, a path, a query, or a fragment', {
        exact: false,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByText('invalid publishable-key shape', { exact: false }).first(),
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
