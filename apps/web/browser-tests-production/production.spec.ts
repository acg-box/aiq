import { expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test';

/* oxlint-disable no-await-in-loop -- Production reads stay serial to bound load on the public origin. */

interface ProductionFixtures {
  blockedWriteRequests: string[];
}

const allowedMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

const test = base.extend<ProductionFixtures>({
  blockedWriteRequests: [
    async ({ context }, use) => {
      const blocked: string[] = [];
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (!allowedMethods.has(request.method())) {
          blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      await use(blocked);
      expect(blocked, 'the production acceptance path must not issue write requests').toEqual([]);
    },
    { auto: true },
  ],
});

async function expectPublishedPage(
  page: Page,
  expectedOrigin: string,
  path: string,
  heading?: string,
) {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `${path} response status`).toBe(200);
  expect(new URL(page.url()).origin).toBe(expectedOrigin);
  const mainHeading = page.locator('main h1');
  await expect(mainHeading).toBeVisible();
  if (heading) await expect(mainHeading).toContainText(heading);
  await expect(page.getByText('Published evidence', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Mixed evidence', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No published evidence', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Published evidence unavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Demo values are synthetic seed data', { exact: false })).toHaveCount(
    0,
  );
  await expect(page.getByText('public data', { exact: true })).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page, testInfo: TestInfo) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${testInfo.project.name} document width ${dimensions.scrollWidth} exceeds ${dimensions.clientWidth}`,
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectTransparentEfficiency(rows: Locator) {
  await expect(rows).toHaveCount(17);
  for (const row of await rows.all()) {
    const cells = row.getByRole('cell');
    await expect(cells).toHaveCount(4);

    const duration = (await cells.nth(0).innerText()).trim();
    expect(duration).toMatch(/^(?:Unavailable|\d+(?:\.\d+)? (?:s|min|h) summed)/);
    expect(duration).toMatch(/\d+\/72 retained/);
    expect(duration).toMatch(/concurrency 17/);

    const cost = (await cells.nth(1).innerText()).trim();
    expect(cost).toMatch(/^(?:Unavailable|\$\d+\.\d{4})/);
    expect(cost).toMatch(/\d+\/72 priced · (?:estimated|unavailable [a-z ]+)/);
    if (cost.startsWith('Unavailable')) expect(cost).not.toContain('$0');

    const tokens = (await cells.nth(2).innerText()).trim();
    expect(tokens).toMatch(/input (?:[\d,]+|unavailable) \((?:\d+\/72 \(\d+\.\d%\)|unavailable)\)/);
    expect(tokens).toMatch(/cached input (?:[\d,]+|unavailable)/);
    expect(tokens).toMatch(/cache-write input (?:[\d,]+|unavailable)/);
    expect(tokens).toMatch(/output (?:[\d,]+|unavailable)/);
    expect(tokens).toMatch(/reasoning (?:[\d,]+|unavailable)/);
    expect(tokens).toMatch(/total (?:[\d,]+|unavailable)/);

    const trust = (await cells.nth(3).innerText()).trim();
    expect(trust).toMatch(/^72 results · \d+ attempted · \d+ adapter-invoked · concurrency 17/);
    expect(trust).toContain('Pricing:');
  }
}

test('production publishes exactly one complete 17-by-72 Official matrix', async ({
  baseURL,
  page,
}, testInfo) => {
  expect(baseURL).toBeDefined();
  const expectedOrigin = new URL(baseURL ?? '').origin;
  await expectPublishedPage(page, expectedOrigin, '/', 'A score is only useful');
  await expectNoDocumentOverflow(page, testInfo);

  const leaderboard = page.getByRole('region', {
    name: 'Descriptively ordered public index table',
  });
  const leaderboardRows = leaderboard.locator('tbody tr');
  await expect(leaderboardRows).toHaveCount(17);
  const configurations = new Set<string>();
  const runHrefs = new Set<string>();

  for (const row of await leaderboardRows.all()) {
    const cells = row.getByRole('cell');
    await expect(cells).toHaveCount(9);
    configurations.add((await row.getByRole('rowheader').innerText()).trim());

    const score = Number((await cells.nth(0).innerText()).trim());
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    await expect(cells.nth(2)).toHaveText('72');
    await expect(cells.nth(3)).toHaveText('100.0%');
    await expect(cells.nth(5)).not.toHaveText('—');
    await expect(cells.nth(6)).toHaveText('Official · 72/72');
    await expect(cells.nth(7)).toHaveText('Published');

    const href = await cells.nth(8).getByRole('link', { name: 'Inspect' }).getAttribute('href');
    expect(href).toMatch(/^\/runs\/[A-Za-z0-9._:-]+$/);
    runHrefs.add(href ?? '');
  }

  expect(configurations.size).toBe(17);
  expect(runHrefs.size).toBe(17);

  const efficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await expect(efficiency).toContainText('Signed matrix batch wall-clock');
  await expect(efficiency).toContainText('count once across all 17 configurations');
  await expect(efficiency).toContainText('TTFT and TPS are unavailable and are not inferred');
  await expectTransparentEfficiency(efficiency.locator('tbody tr'));

  const historyHrefs = new Set<string>();
  let historyPath: string | null = '/runs';
  for (let pageNumber = 0; historyPath !== null && pageNumber < 3; pageNumber += 1) {
    await expectPublishedPage(
      page,
      expectedOrigin,
      historyPath,
      'Every public run stays inspectable',
    );
    const historyRows = page
      .getByRole('region', { name: 'Public run history' })
      .locator('tbody tr');
    const hrefs = await historyRows
      .getByRole('link', { name: 'Inspect run' })
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    for (const href of hrefs) historyHrefs.add(href);

    const older = page.getByRole('link', { name: 'Older runs' });
    historyPath = (await older.count()) === 0 ? null : await older.getAttribute('href');
  }
  expect(historyHrefs).toEqual(runHrefs);

  let resultCount = 0;
  for (const href of runHrefs) {
    await expectPublishedPage(page, expectedOrigin, href);
    await expect(page.getByText('Official', { exact: true })).toBeVisible();
    await expect(page.getByText('Completeness:', { exact: false })).toContainText(
      '72 valid results',
    );
    const results = page.locator('.task-list > article');
    await expect(results).toHaveCount(72);
    resultCount += await results.count();

    for (const text of await results.allTextContents()) {
      expect(text).toMatch(/Codex adapter elapsed: (?:unavailable|[\d,]+ ms · [a-z-]+)/);
      expect(text).toMatch(
        /Tokens: input (?:[\d,]+|unavailable) · cached input (?:[\d,]+|unavailable) · cache-write input (?:[\d,]+|unavailable) · output (?:[\d,]+|unavailable) · reasoning (?:[\d,]+|unavailable) · total (?:[\d,]+|unavailable)/,
      );
      expect(text).toMatch(
        /API-equivalent cost: (?:\$\d+\.\d{6}|unavailable [a-z ]+) · token evidence (?:[a-z-]+|unavailable) · cost evidence (?:[a-z-]+|unavailable)/,
      );
    }
  }
  expect(resultCount).toBe(1_224);
});

test('production method, trends, and radar preserve transparent evidence semantics', async ({
  baseURL,
  page,
}, testInfo) => {
  expect(baseURL).toBeDefined();
  const expectedOrigin = new URL(baseURL ?? '').origin;
  await expectPublishedPage(
    page,
    expectedOrigin,
    '/method',
    'Transparent scoring, version by version',
  );
  await expect(
    page.getByRole('heading', { name: '72 tasks · 10 equally weighted domains' }),
  ).toBeVisible();
  await expect(
    page.getByText('displays as unavailable, never zero', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('Signed matrix-stage start and finish times', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'official OpenAI API pricing documentation' }),
  ).toHaveAttribute('href', 'https://developers.openai.com/api/docs/pricing');

  await expectPublishedPage(
    page,
    expectedOrigin,
    '/trends?range=all',
    'The past remains part of the record',
  );
  await expect(page.getByRole('img', { name: 'AIQ score history' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Trend series' }).getByRole('listitem')).toHaveCount(
    17,
  );
  await expect(
    page.getByRole('heading', { name: 'Time and API-equivalent cost by retained point' }),
  ).toBeVisible();
  await expectTransparentEfficiency(
    page.getByRole('region', { name: 'Official model efficiency' }).locator('tbody tr'),
  );

  await expectPublishedPage(page, expectedOrigin, '/radar', 'Know the runner behind the result');
  await expect(page.locator('.node-card')).not.toHaveCount(0);
  await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Latest signed capability record', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText('Latest signed observation record', { exact: true }).first(),
  ).toBeVisible();
  await expectNoDocumentOverflow(page, testInfo);
});
