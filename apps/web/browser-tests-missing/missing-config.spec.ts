import { expect, test } from '@playwright/test';
import { expectUnavailableCore } from '../browser-tests/configuration-assertions.ts';

test('missing production configuration keeps measurements unavailable and the method accessible', async ({
  page,
}) => {
  await expectUnavailableCore(page);
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
