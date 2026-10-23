import assert from 'node:assert/strict';
import { expect, test } from '@playwright/test';

test('the comparison overview is readable before client JavaScript loads', async ({
  browser,
  baseURL,
}, testInfo) => {
  assert.ok(baseURL);
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    viewport: { width: 390, height: 400 },
  });
  try {
    const page = await context.newPage();
    expect((await page.goto('/benchmarks/memory'))?.status()).toBe(200);
    const comparison = page.getByRole('region', {
      name: 'October 15 · native retrieval results',
      exact: true,
    });
    await expect(comparison.locator('tbody tr')).toHaveCount(2);
    await expect(comparison).toContainText('11/13');
    await expect(comparison).toContainText('$0.024261');
    const overview = page.getByRole('table', { name: 'Memory comparison overview', exact: true });
    await expect(overview.locator('tbody tr')).toHaveCount(6);
    expect((await overview.boundingBox())?.y).toBeLessThan(400);
    await page.screenshot({ path: testInfo.outputPath('overview-without-javascript.png') });
  } finally {
    await context.close();
  }
});
