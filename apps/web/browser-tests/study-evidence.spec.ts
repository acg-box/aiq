import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openStudyEvidence, selectTheme } from './workspace-helpers.ts';

function monitorErrors(page: Page) {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') failures.push(message.text());
  });
  page.on('pageerror', (error) => failures.push(error.message));
  return failures;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
}

async function intelligenceLink(page: Page) {
  const direct = page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('link', { name: 'AI Intelligence', exact: true });
  if (await direct.isVisible()) return direct;
  const menu = page.getByRole('button', { name: 'Open benchmark navigation', exact: true });
  await menu.click();
  return page
    .getByRole('dialog', { name: 'Benchmark navigation', exact: true })
    .getByRole('link', { name: 'AI Intelligence', exact: true });
}

test('peer boards share one navigation and the mobile menu restores focus', async ({
  page,
}, testInfo) => {
  const failures = monitorErrors(page);
  await page.goto('/');
  const directory = page.getByRole('region', { name: 'Benchmark boards', exact: true });
  await expect(directory.getByRole('rowheader')).toHaveText([
    'AI Intelligence',
    'Harness Rank',
    'Mem',
  ]);
  await directory.getByRole('link', { name: 'Mem', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mem', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Leaderboard', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab')).toHaveText(['Data', 'Leaderboard', 'Method', 'Records']);
  const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  await expect(navigation.getByRole('link', { name: 'Mem', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await (await intelligenceLink(page)).click();
  await expect(page.getByRole('heading', { name: 'AI Intelligence', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Core navigation' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Core workspace/ })).toHaveCount(0);
  if (testInfo.project.name === 'mobile-chromium') {
    const opener = page.getByRole('button', { name: 'Open benchmark navigation' });
    await opener.click();
    await expect(page.getByRole('dialog', { name: 'Benchmark navigation' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute('aria-expanded', 'false');
  }
  await page.screenshot({ path: testInfo.outputPath('intelligence.png'), fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await noOverflow(page);
  expect(failures).toEqual([]);
});

test('Mem filters, result evidence, case records and originals keep the same workspace', async ({
  page,
  request,
}, testInfo) => {
  const failures = monitorErrors(page);
  await page.goto('/benchmarks/memory');
  await selectTheme(page, 'light');
  await expect(page.getByLabel('Study', { exact: true }).locator('option')).toHaveText([
    'Luna / DeepSeek Flash 1017',
    'Luna reasoning effort',
    'Native memory systems',
  ]);
  const native = page.getByRole('region', {
    name: 'October 15 · native retrieval results',
    exact: true,
  });
  await expect(native.getByRole('row')).toHaveCount(3);
  await native.getByRole('button', { name: 'Settled cost', exact: true }).click();
  await expect(native.locator('tbody tr').first()).toContainText('RAGFlow rc1');
  const opened = await openStudyEvidence(page, 'OpenViking');
  const evidence = opened.content;
  await expect(evidence).toContainText('11/13');
  await expect(evidence).toContainText('0.5.0');
  await evidence.getByText('Configuration & original record', { exact: true }).click();
  const original = evidence.getByRole('link', { name: /Open original/ });
  const href = await original.getAttribute('href');
  assert.ok(href);
  const response = await request.get(href);
  expect(href).toContain(
    createHash('sha256')
      .update(await response.body())
      .digest('hex'),
  );
  const summary: unknown = await response.json();
  expect(summary).toHaveProperty('products.openviking');
  expect(summary).toHaveProperty('products.ragflow');
  expect(summary).not.toHaveProperty('products.elf');
  expect((await request.get(href.replace('/evidence/studies/', '/evidence/elf/'))).status()).toBe(
    404,
  );
  await page.screenshot({ path: testInfo.outputPath('memory-evidence.png'), fullPage: false });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await opened.close();
  await expect(native.locator('tbody tr').first()).toContainText('RAGFlow rc1');

  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Study', { exact: true }).selectOption('luna-effort');
  await page.getByLabel('Test', { exact: true }).selectOption('writer');
  const writer = page.getByRole('region', { name: 'Writer · 4 inputs results', exact: true });
  await expect(writer).toContainText('$0.000709');
  await page.reload();
  await expect(page.getByLabel('Study', { exact: true })).toHaveValue('luna-effort');
  await expect(page.getByLabel('Test', { exact: true })).toHaveValue('writer');
  await page.getByRole('link', { name: 'Test method', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Method', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByRole('navigation', { name: 'On this page', exact: true })
    .getByRole('link', { name: 'Versions', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Compared versions' })).toContainText('gpt-6-luna');
  await page.getByRole('tab', { name: 'Records', exact: true }).click();
  await page.getByLabel('Workload', { exact: true }).selectOption('all');
  const cases = page.getByRole('region', { name: 'Case index', exact: true });
  await cases.locator('a[href*="/records/luna-effort/post-memory-1-1?"]').click();
  await expect(
    page.getByRole('heading', { name: /For the next outage on Cobalt/, level: 1 }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Luna low', exact: true }).first().click();
  await expect(
    page.getByText('Low cites handle :22, which is absent.', { exact: false }),
  ).toBeVisible();
  const detailViews = page.getByRole('navigation', { name: 'Board views' });
  await expect(detailViews.getByRole('link', { name: 'Records', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(await detailViews.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
    false,
  );
  await page.getByRole('link', { name: '← Back to Mem records', exact: true }).click();
  await expect(page.getByLabel('Study', { exact: true })).toHaveValue('luna-effort');
  await page.getByRole('tab', { name: 'Leaderboard', exact: true }).click();
  await expect(page.getByLabel('Test', { exact: true })).toHaveValue('writer');
  await expect(writer).toContainText('$0.000709');
  await page.screenshot({ path: testInfo.outputPath('memory-filtered.png'), fullPage: false });
  await selectTheme(page, 'dark');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('memory-dark.png'), fullPage: false });
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Study files', exact: true })).toBeVisible();
  await expect(page.getByLabel('Study', { exact: true })).toHaveValue('luna-effort');
  await page.getByRole('tab', { name: 'Data', exact: true }).press('End');
  await expect(page.getByRole('tab', { name: 'Records', exact: true })).toBeFocused();
  await page.getByRole('tab', { name: 'Records', exact: true }).press('Home');
  await expect(page.getByRole('tab', { name: 'Data', exact: true })).toBeFocused();
  await page.getByRole('tab', { name: 'Data', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Leaderboard', exact: true })).toBeFocused();
  await expect(page.getByLabel('Test', { exact: true })).toHaveValue('writer');
  await noOverflow(page);
  expect(failures).toEqual([]);
});

test('retired entries are removed and current views retain their publication and study scope', async ({
  page,
  request,
}) => {
  const retiredPaths = [
    '/core',
    '/compare',
    '/trends',
    '/runs',
    '/method',
    '/studies',
    '/studies/native-memory',
    '/calibrations',
    '/radar',
  ];
  const retiredResponses = await Promise.all(retiredPaths.map((path) => request.get(path)));
  for (const [index, response] of retiredResponses.entries()) {
    const path = retiredPaths[index];
    expect(response.status(), path).toBe(404);
    expect(response.headers().location).toBeUndefined();
  }
  await page.goto('/benchmarks/intelligence?model=Sol');
  await expect(
    page.getByRole('heading', { name: 'No Official results in this preview.', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await page.locator('#core-versions > summary').click();
  await expect(page.getByText('1.1.0 · 72 tasks in 10 domains', { exact: true })).toBeVisible();
  await page.goto('/benchmarks/memory?study=native-memory');
  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Test', { exact: true }).selectOption('nightly');
  const nightly = page.getByRole('region', {
    name: 'October 20 · version check results',
    exact: true,
  });
  await expect(nightly.getByRole('row')).toHaveCount(2);
  await expect(nightly).toContainText('11/13');
  await expect(nightly).not.toContainText('OpenViking');
  await noOverflow(page);
});

test('native cases distinguish version protocols and keep all retained observations in alphabetical order', async ({
  page,
  request,
}, testInfo) => {
  await page.goto('/benchmarks/memory/records/native-memory/post-memory-1-0');
  await expect(
    page
      .getByRole('navigation', { name: 'On this page', exact: true })
      .locator('a[href^="#case-observation-"]'),
  ).toHaveText(['OpenViking', 'RAGFlow nightly', 'RAGFlow rc1']);
  await expect(page.locator('main')).not.toContainText('ELF');
  await expect(page.locator('.case-main-finding')).toContainText(
    'OpenViking omits the current STREAM-1-286 decision',
  );
  await page
    .getByRole('navigation', { name: 'On this page', exact: true })
    .getByRole('link', { name: 'OpenViking', exact: true })
    .click();
  await page
    .locator('#case-observation-0')
    .getByText('Original files · 3 source records', { exact: true })
    .click();
  await Promise.all(
    ['answers', 'contexts'].map(async (directory) => {
      const path = `${directory}/openviking-formal-post-memory-1-0.json`;
      await expect(
        page.locator('#case-observation-0').getByRole('link', {
          name: `${path} · 2026-10-15-native-kb-memory`,
          exact: true,
        }),
      ).toHaveText(path);
    }),
  );
  await page
    .getByRole('navigation', { name: 'On this page', exact: true })
    .getByRole('link', { name: 'Originals', exact: true })
    .click();
  const originals = page.locator('#case-protocol');
  await expect(
    originals.getByRole('link', { name: 'formal-method.json', exact: true }),
  ).toBeVisible();
  await expect(originals.getByRole('link', { name: 'oracle.json', exact: true })).toBeVisible();
  await Promise.all(
    ['2026-10-15-native-kb-memory', 'ragflow-nightly-20261020'].map(async (bundle) => {
      const protocol = originals.getByRole('link', {
        name: `protocol.json · ${bundle}`,
        exact: true,
      });
      await expect(protocol).toBeVisible();
      await expect(protocol.locator('..')).toContainText(bundle);
      const href = await protocol.getAttribute('href');
      assert.ok(href?.startsWith('/evidence/studies/'));
      const response = await request.get(href);
      expect(response.status()).toBe(200);
      expect(href).toContain(
        createHash('sha256')
          .update(await response.body())
          .digest('hex'),
      );
    }),
  );
  await originals.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('native-case-protocols.png') });
  await noOverflow(page);
});
