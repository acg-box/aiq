import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('board leaderboard distinguishes unavailable measurements from its task design', async ({
  page,
}) => {
  await page.goto('/benchmarks/intelligence');
  await expect(page.getByRole('heading', { name: 'AI Intelligence', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Published results unavailable.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Board coverage' })).toHaveText(
    '72 tasks in design10 domains in designMeasurements unavailable',
  );
  await expect(page.getByText('No Official results in this preview.', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('tab', { name: 'Leaderboard', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
});

test('production without public Supabase configuration never publishes synthetic seed data', async ({
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
  await page.getByRole('tab', { name: 'Method', exact: true }).click();
  const sections = page.getByRole('navigation', { name: 'On this page', exact: true });
  await sections.getByRole('link', { name: 'Task score', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Committed weighted checks with explicit hard gates' }),
  ).toBeVisible();
  await sections.getByRole('link', { name: 'Scope', exact: true }).click();
  await expect(page.getByText('aiq-core@1.1.0', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Frozen Core task catalogue', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0);
});
