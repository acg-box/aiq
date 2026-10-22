import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base } from '@playwright/test';
import coreCatalogue from '../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json' with { type: 'json' };
import { harnessPlan } from '../src/benchmarks/harness-plan.ts';
import { listStudies, studyEvidence } from '../src/studies/repository.ts';

/* oxlint-disable no-await-in-loop -- Bound public-origin load with serial, read-only requests. */
const test = base.extend<{ readOnly: void }>({
  readOnly: [
    async ({ context, page }, use) => {
      const writes: string[] = [];
      const errors: string[] = [];
      await context.route('**/*', async (route) => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
          writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await use();
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

for (const [board, title] of [
  ['intelligence', 'AI Intelligence'],
  ['harness', 'Harness Rank'],
  ['memory', 'Mem'],
] as const) {
  for (const view of ['data', 'leaderboard', 'method', 'records']) {
    test(`${title} ${view} is usable on the public site`, async ({ page }) => {
      const response = await page.goto(`/benchmarks/${board}?view=${view}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      const tab = page.getByRole('tab', { name: view, exact: false });
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (view === 'leaderboard') {
        await expect(page.locator('main')).not.toContainText('Synthetic seed');
        await expect(page.locator('main')).not.toContainText('ELF');
      }
    });
  }
}

for (const [path, title] of [
  ['/about', 'Read the evidence, then decide.'],
  ['/benchmarks/intelligence/calibrations', 'Calibration evidence'],
  ['/benchmarks/intelligence/verification', 'Runner network'],
] as const) {
  test(`${path} is usable on the public site`, async ({ page }) => {
    expect((await page.goto(path))?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test('homepage links to each peer and retired pages stay removed', async ({ page, request }) => {
  expect((await page.goto('/'))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  for (const title of ['AI Intelligence', 'Harness Rank', 'Mem']) {
    await expect(page.getByRole('rowheader', { name: title, exact: true })).toBeVisible();
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const path of ['/core', '/studies', '/runs', '/method', '/compare', '/trends', '/radar']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain('https://aiq.wiki/benchmarks/harness');
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Disallow: /api/');
});

test('every retained case and original file is served intact', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'HTTP content is viewport-independent.');
  for (const [path, expected] of [
    ['/api/benchmarks/harness/protocol', harnessPlan],
    ['/api/benchmarks/intelligence/catalog', coreCatalogue],
  ] as const) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(await response.json(), path).toEqual(expected);
  }
  const files = new Map<string, string>();
  for (const study of listStudies()) {
    for (const item of study.cases) {
      const path = `/benchmarks/memory/records/${study.id}/${item.id}`;
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(await response.text()).toContain('case-comparison');
    }
    for (const file of studyEvidence(study)) files.set(file.href, file.sha256);
  }
  for (const [path, digest] of files) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(
      createHash('sha256')
        .update(await response.body())
        .digest('hex'),
      path,
    ).toBe(digest);
  }
});
