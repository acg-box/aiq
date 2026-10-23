import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seedRuns } from '../src/data/seed.ts';

for (const [board, query, label, heading] of [
  ['intelligence', '&model=Terra&effort=medium', 'Time & cost', 'Time and cost'],
  ['harness', '&q=refund', 'Budget', 'Proposed budget'],
  ['memory', '&study=luna-effort&test=writer', 'Versions', 'Compared versions'],
] as const) {
  test(`${board} keeps view navigation available in long content and restarts the selected view`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/benchmarks/${board}?view=method${query}`);
    await page
      .getByRole('navigation', { name: 'On this page', exact: true })
      .getByRole('link', { name: label, exact: true })
      .click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeInViewport();
    const tabs = page.getByRole('tablist', { name: 'Board views', exact: true });
    await expect(tabs).toBeInViewport();
    const headerBottom = await page
      .locator('.workspace-header')
      .evaluate((element) => element.getBoundingClientRect().bottom);
    const tabTop = await tabs.evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(tabTop - headerBottom)).toBeLessThanOrEqual(1);
    await tabs.getByRole('tab', { name: 'Records', exact: true }).click();
    await expect(tabs.getByRole('tab', { name: 'Records', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('main h1')).toBeInViewport();
    await page.goBack();
    await expect(tabs.getByRole('tab', { name: 'Method', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeInViewport();
    await page.goForward();
    await expect(tabs.getByRole('tab', { name: 'Records', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByRole('tabpanel', { name: 'Records', exact: true }).getByRole('heading').first(),
    ).toBeInViewport();
    await tabs.getByRole('tab', { name: 'Data', exact: true }).click();
    await expect(
      page.getByRole('tabpanel', { name: 'Data', exact: true }).getByRole('heading').first(),
    ).toBeInViewport();
    await page.goBack();
    await expect(tabs.getByRole('tab', { name: 'Records', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    for (const [key, value] of new URLSearchParams(query)) {
      expect(new URL(page.url()).searchParams.get(key)).toBe(value);
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('a Mem case keeps a compact return action visible and restores its selected scope', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'mobile-chromium')
    await page.setViewportSize({ width: 320, height: 844 });
  const source = '/benchmarks/memory?view=records&study=luna-effort&test=writer';
  await page.goto(source);
  const record = page
    .getByRole('region', { name: 'Case index', exact: true })
    .locator('tbody a')
    .first();
  const recordBounds = await record.boundingBox();
  assert.ok(recordBounds);
  await record.click({ position: { x: recordBounds.width / 2, y: recordBounds.height / 2 } });
  const back = page.getByRole('link', { name: '← Back to Mem records', exact: true });
  await expect(back).toHaveAttribute('href', source);
  await page
    .getByRole('navigation', { name: 'On this page', exact: true })
    .getByRole('link', { name: 'Originals', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Protocol and expected facts', exact: true }),
  ).toBeInViewport();
  await expect(back).toBeInViewport();
  const views = page.getByRole('navigation', { name: 'Board views', exact: true });
  await expect(views.getByRole('link', { name: 'Records', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('memory-detail-navigation.png') });
  await back.click();
  await expect(page).toHaveURL(source);
  await expect(page.getByLabel('Study', { exact: true })).toHaveValue('luna-effort');
});

test('run details return to the original homepage and verification stays in the record scope', async ({
  page,
}) => {
  const run = seedRuns[0];
  assert.ok(run);
  await page.goto(
    `/benchmarks/intelligence/records/${run.id}?${new URLSearchParams({ return: '/benchmarks/intelligence' })}`,
  );
  await page.getByRole('link', { name: '← Back to leaderboard', exact: true }).click();
  await expect(page).toHaveURL('/benchmarks/intelligence');
  await expect(page.getByRole('tab', { name: 'Leaderboard', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Records', exact: true }).click();
  await page
    .getByRole('link', { name: 'Verification and provenance records', exact: true })
    .click();
  await expect(page.getByRole('link', { name: '← Back to records', exact: true })).toHaveAttribute(
    'href',
    '/benchmarks/intelligence?view=records',
  );
  await page.getByRole('link', { name: '← Back to records', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Records', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

for (const [board, label, definition] of [
  ['intelligence', /Task catalogue.*JSON/u, 'candidates/aiq-core-1.1.0/catalog.json'],
  ['harness', /Task set and protocol.*JSON/u, 'harness-rank/protocol.json'],
] as const) {
  test(`${board} definition download serves the declared JSON file`, async ({ page }) => {
    await page.goto(`/benchmarks/${board}?view=data`);
    const file = page.getByRole('link', { name: label, exact: true });
    await expect(file).toBeVisible();
    await expect(file).toHaveAttribute('download', '');
    const downloadStarted = page.waitForEvent('download');
    await file.click();
    const download = await downloadStarted;
    expect(await download.failure()).toBeNull();
    const downloaded = await download.path();
    assert.ok(downloaded);
    expect(JSON.parse(await readFile(downloaded, 'utf8'))).toEqual(
      JSON.parse(
        await readFile(new URL(`../../../benchmarks/${definition}`, import.meta.url), 'utf8'),
      ),
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
test('memory originals keep byte identity and study changes reach matching records', async ({
  page,
  request,
}) => {
  await page.goto('/benchmarks/memory?view=data&study=native-memory');
  await page.locator('.file-integrity > summary').first().click();
  const digest = await page.locator('.file-integrity .research-hash').first().innerText();
  const file = page
    .getByRole('region', { name: 'Evidence files', exact: true })
    .locator('tbody a[download]')
    .first();
  const href = await file.getAttribute('href');
  assert.ok(href);
  const response = await request.get(href);
  expect(response.status()).toBe(200);
  expect(
    createHash('sha256')
      .update(await response.body())
      .digest('hex'),
  ).toBe(digest);
  await page.getByText('Change study', { exact: true }).click();
  await page.getByLabel('Study', { exact: true }).selectOption('luna-effort');
  await page.reload();
  await expect(page.getByLabel('Study', { exact: true })).toHaveValue('luna-effort');
  await page.getByRole('tab', { name: 'Records', exact: true }).click();
  await page
    .getByRole('region', { name: 'Case index', exact: true })
    .locator('tbody a')
    .first()
    .click();
  await expect(page.getByRole('navigation', { name: 'On this page', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '← Back to Mem records', exact: true }).click();
  await expect(page.getByLabel('Study', { exact: true })).toHaveValue('luna-effort');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Mem case search and workload selection survive a detail round trip', async ({ page }) => {
  await page.goto('/benchmarks/memory?view=records&study=luna-effort');
  await page.getByLabel('Workload', { exact: true }).selectOption('writer');
  await expect(page.locator('.reference-record-count')).toHaveText('4 of 17 cases');
  await page.getByLabel('Find a case', { exact: true }).fill('writer');
  const index = page.getByRole('region', { name: 'Case index', exact: true });
  await expect(index.locator('tbody tr')).not.toHaveCount(0);
  const source = page.url();
  await index.locator('tbody a').first().click();
  await page.getByRole('link', { name: '← Back to Mem records', exact: true }).click();
  await expect(page).toHaveURL(source);
  await expect(page.getByLabel('Find a case', { exact: true })).toHaveValue('writer');
  await expect(page.getByLabel('Workload', { exact: true })).toHaveValue('writer');
  await page.getByLabel('Find a case', { exact: true }).fill('no such saved case');
  await expect(page.getByText('No cases match these filters.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('.reference-record-count')).toHaveText('17 of 17 cases');
});

test('a direct method anchor reveals the complete specification', async ({ page }) => {
  await page.goto('/benchmarks/intelligence?view=method#core-task-score');
  await expect(page.locator('#core-task-score')).toHaveAttribute('open', '');
  await expect(
    page.getByRole('heading', { name: 'Task-level score', exact: true }),
  ).toBeInViewport();
  await expect(page.getByText('Partial credit', { exact: true })).toBeVisible();
  await expect(page.locator('#core-efficiency')).not.toHaveAttribute('open');
});
