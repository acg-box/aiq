import { expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test';

import {
  type ProductionEfficiencyEvidence,
  validateProductionEfficiencyEvidence,
} from '../playwright-production-evidence.ts';

/* oxlint-disable no-await-in-loop -- Production reads stay serial to bound load on the public origin. */

interface ProductionFixtures {
  blockedWriteRequests: string[];
}

const allowedMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const expectedBenchmarkVersion = 'aiq-core@1.0.2';
const expectedScoringVersion = '1.0.2';
const expectedCorpusRelease = 'corpus_2026.07.29';
const expectedCatalogDigest =
  'sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937';
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const matrixBatchPattern = /^run_[0-9a-f]{64}$/;

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

function numericAttribute(row: Locator, name: string): Promise<number> {
  return row.getAttribute(name).then((value) => {
    expect(value, `${name} must be present`).not.toBeNull();
    const parsed = Number(value);
    expect(Number.isSafeInteger(parsed), `${name} must be an integer`).toBe(true);
    return parsed;
  });
}

function nullableEvidence(value: string | null): string | null {
  return value === 'unavailable' ? null : (value?.replaceAll('_', '-') ?? null);
}

function parseTokenCategory(text: string, label: string) {
  const prefix = label === 'input' ? '^' : '';
  const match = new RegExp(
    `${prefix}${label} ([\\d,]+|unavailable) \\((\\d+/72 \\(\\d+\\.\\d%\\)|unavailable)\\)`,
  ).exec(text);
  expect(match, `${label} token evidence must be visible`).not.toBeNull();
  const value = match?.[1];
  const coverage = match?.[2];
  if (coverage === 'unavailable') {
    return { valueAvailable: value !== 'unavailable', coverageCount: null, coveragePercent: null };
  }
  const coverageMatch = /^(\d+)\/72 \((\d+\.\d)%\)$/.exec(coverage ?? '');
  expect(coverageMatch, `${label} coverage must be canonical`).not.toBeNull();
  return {
    valueAvailable: value !== 'unavailable',
    coverageCount: Number(coverageMatch?.[1]),
    coveragePercent: Number(coverageMatch?.[2]),
  };
}

async function efficiencyEvidenceFromRow(row: Locator): Promise<ProductionEfficiencyEvidence> {
  const cells = row.getByRole('cell');
  const costText = (await cells.nth(1).innerText()).trim();
  const costMatch = /^(?:\$(\d+\.\d{4})|Unavailable)/.exec(costText);
  expect(costMatch, 'cost value or unavailable status must be visible').not.toBeNull();
  const tokenText = (await cells.nth(2).innerText()).trim();
  return {
    resultCount: 72,
    attemptedCount: await numericAttribute(row, 'data-attempted-result-count'),
    invokedCount: await numericAttribute(row, 'data-invoked-result-count'),
    elapsedObservedCount: await numericAttribute(row, 'data-elapsed-observed-result-count'),
    durationEvidenceLevel: nullableEvidence(await row.getAttribute('data-duration-evidence-level')),
    tokenObservedCount: await numericAttribute(row, 'data-token-observed-result-count'),
    tokenEvidenceLevel: nullableEvidence(await row.getAttribute('data-token-usage-evidence-level')),
    tokenCategories: [
      parseTokenCategory(tokenText, 'input'),
      parseTokenCategory(tokenText, 'cached input'),
      parseTokenCategory(tokenText, 'cache-write input'),
      parseTokenCategory(tokenText, 'output'),
      parseTokenCategory(tokenText, 'reasoning'),
      parseTokenCategory(tokenText, 'total'),
    ],
    pricedCount: await numericAttribute(row, 'data-priced-result-count'),
    costStatus: (await row.getAttribute('data-cost-estimator-status'))?.replaceAll('_', '-') ?? '',
    costUsd: costMatch?.[1] ? Number(costMatch[1]) : null,
    costEvidenceLevel: nullableEvidence(await row.getAttribute('data-cost-evidence-level')),
  };
}

async function expectTransparentEfficiency(rows: Locator, expectVariants = false) {
  await expect(rows).toHaveCount(17);
  const runIds: string[] = [];
  const batchIds = new Set<string>();
  const tokenCounts = new Set<number>();
  const durationCounts = new Set<number>();
  const costStatuses = new Set<string>();
  for (const row of await rows.all()) {
    const cells = row.getByRole('cell');
    await expect(cells).toHaveCount(4);

    const runId = await row.getAttribute('data-run-id');
    const batchId = await row.getAttribute('data-matrix-batch-id');
    expect(runId).toMatch(/^run[-_][A-Za-z0-9._:-]+$/);
    expect(batchId).toMatch(matrixBatchPattern);
    runIds.push(runId ?? '');
    batchIds.add(batchId ?? '');

    const duration = (await cells.nth(0).innerText()).trim();
    expect(duration).toMatch(/^(?:Unavailable|\d+(?:\.\d+)? (?:s|min|h) summed)/);
    expect(duration).toMatch(/(?:\d+\/72 retained|median unavailable)/);
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

    const evidence = await efficiencyEvidenceFromRow(row);
    validateProductionEfficiencyEvidence(evidence);
    tokenCounts.add(evidence.tokenObservedCount);
    durationCounts.add(evidence.elapsedObservedCount);
    costStatuses.add(evidence.costStatus);
  }
  expect(new Set(runIds).size).toBe(17);
  expect(batchIds.size).toBe(1);
  if (expectVariants) {
    expect(tokenCounts).toEqual(new Set([0, 36, 72]));
    expect(durationCounts).toEqual(new Set([0, 72]));
    expect(costStatuses).toEqual(new Set(['estimated', 'unavailable-missing-usage']));
  }
  return { batchId: [...batchIds][0] ?? '', runIds };
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
  const signedBatchRecords = efficiency.locator('.formula-note > p[title]');
  await expect(signedBatchRecords).toHaveCount(1);
  const signedBatchId = await signedBatchRecords.getAttribute('title');
  expect(signedBatchId).toMatch(matrixBatchPattern);
  const overviewEfficiency = await expectTransparentEfficiency(
    efficiency.locator('tbody tr'),
    testInfo.config.metadata.productionEvidenceVariants === true,
  );
  expect(overviewEfficiency.batchId).toBe(signedBatchId);
  expect(new Set(overviewEfficiency.runIds)).toEqual(
    new Set([...runHrefs].map((href) => href.slice('/runs/'.length))),
  );

  const historyHrefs: string[] = [];
  const historyPages: Array<{ path: string; hrefs: string[] }> = [];
  const visitedHistoryPaths = new Set<string>();
  let historyPath: string | null = '/runs';
  let reachedOldestBoundary = false;
  for (let pageNumber = 0; historyPath !== null && pageNumber < 3; pageNumber += 1) {
    expect(visitedHistoryPaths.has(historyPath), 'run-history cursor cycle').toBe(false);
    visitedHistoryPaths.add(historyPath);
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
    expect(new Set(hrefs).size, 'duplicate run within one history page').toBe(hrefs.length);
    for (const href of hrefs) {
      expect(historyHrefs, `overlapping run-history page: ${href}`).not.toContain(href);
      historyHrefs.push(href);
    }
    historyPages.push({ path: historyPath, hrefs });

    const older = page.getByRole('link', { name: 'Older runs' });
    if ((await older.count()) === 0) {
      reachedOldestBoundary = true;
      historyPath = null;
    } else {
      historyPath = await older.getAttribute('href');
    }
  }
  expect(reachedOldestBoundary, 'run history must have a terminal Older boundary').toBe(true);
  expect(historyPages.map(({ hrefs }) => hrefs.length)).toEqual([10, 7]);
  expect(historyHrefs).toHaveLength(17);
  const expectedHistoryHrefs = Array.from(runHrefs);
  expectedHistoryHrefs.sort();
  expect(historyHrefs).toEqual(expectedHistoryHrefs);

  for (let index = historyPages.length - 1; index > 0; index -= 1) {
    const newer = page.getByRole('link', { name: 'Newer runs' });
    await expect(newer).toBeVisible();
    const newerPath = await newer.getAttribute('href');
    await expectPublishedPage(
      page,
      expectedOrigin,
      newerPath ?? '',
      'Every public run stays inspectable',
    );
    const newerHrefs = await page
      .getByRole('region', { name: 'Public run history' })
      .getByRole('link', { name: 'Inspect run' })
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    expect(newerHrefs).toEqual(historyPages[index - 1]?.hrefs);
  }
  await expect(page.getByRole('link', { name: 'Newer runs' })).toHaveCount(0);

  let resultCount = 0;
  const provenance = {
    benchmark: new Set<string>(),
    scoring: new Set<string>(),
    corpusRelease: new Set<string>(),
    corpusCommitment: new Set<string>(),
    catalog: new Set<string>(),
    taskSet: new Set<string>(),
    promptSet: new Set<string>(),
  };
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

    const provenancePanel = page.locator('.provenance-panel');
    const readProvenance = async (label: string) =>
      (
        await provenancePanel
          .locator(':scope > div')
          .filter({ has: page.getByText(label, { exact: true }) })
          .locator('code')
          .innerText()
      ).trim();
    provenance.benchmark.add(await readProvenance('Benchmark'));
    provenance.scoring.add(await readProvenance('Scoring'));
    provenance.corpusRelease.add(await readProvenance('Corpus release'));
    provenance.corpusCommitment.add(await readProvenance('Corpus commitment'));
    provenance.catalog.add(await readProvenance('Catalog digest'));
    provenance.taskSet.add(await readProvenance('Task-set digest'));
    provenance.promptSet.add(await readProvenance('Prompt set'));
  }
  expect(resultCount).toBe(1_224);
  expect(provenance.benchmark).toEqual(new Set([expectedBenchmarkVersion]));
  expect(provenance.scoring).toEqual(new Set([expectedScoringVersion]));
  expect(provenance.corpusRelease).toEqual(new Set([expectedCorpusRelease]));
  expect(provenance.catalog).toEqual(new Set([expectedCatalogDigest]));
  expect(provenance.corpusCommitment.size).toBe(1);
  expect([...provenance.corpusCommitment][0]).toMatch(digestPattern);
  expect(provenance.taskSet.size).toBe(1);
  expect([...provenance.taskSet][0]).toMatch(digestPattern);
  expect(provenance.promptSet).toEqual(provenance.taskSet);
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
