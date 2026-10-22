import { expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test';

import {
  type ProductionEfficiencyEvidence,
  validateProductionEfficiencyEvidence,
  validateProductionTaskCostEvidence,
} from '../playwright-production-evidence.ts';
import { validateProductionExpectedIdentity } from '../playwright-production-identity.ts';
import { expectProductionPageEvidence } from './production-page-evidence.ts';

/* oxlint-disable no-await-in-loop -- Production reads stay serial to bound load on the public origin. */

interface ProductionFixtures {
  blockedWriteRequests: string[];
}

const allowedMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
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
  await expect(page.locator('main h1').first()).toBeVisible();
  if (heading) {
    const expectedHeading = page.getByRole('heading', { name: heading });
    await expect(expectedHeading).toHaveCount(1);
    await expectedHeading.scrollIntoViewIfNeeded();
    await expect(expectedHeading).toBeVisible();
  }
  await expectProductionPageEvidence(page, path);
  await expect(page.getByText('Demo values are synthetic seed data', { exact: false })).toHaveCount(
    0,
  );
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
  const executionConcurrencies = new Set<number>();
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
    const durationConcurrency = /concurrency (\d+)/.exec(duration);
    expect(durationConcurrency, 'duration must show execution concurrency').not.toBeNull();

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
    const trustConcurrency =
      /^72 results · \d+ attempted · \d+ adapter-invoked · concurrency (\d+)/.exec(trust);
    expect(trustConcurrency, 'trust evidence must show execution concurrency').not.toBeNull();
    const executionConcurrency = Number(trustConcurrency?.[1]);
    expect(executionConcurrency).toBeGreaterThanOrEqual(1);
    expect(executionConcurrency).toBeLessThanOrEqual(32);
    expect(Number(durationConcurrency?.[1])).toBe(executionConcurrency);
    executionConcurrencies.add(executionConcurrency);
    expect(trust).toContain('Pricing:');

    const evidence = await efficiencyEvidenceFromRow(row);
    validateProductionEfficiencyEvidence(evidence);
    tokenCounts.add(evidence.tokenObservedCount);
    durationCounts.add(evidence.elapsedObservedCount);
    costStatuses.add(evidence.costStatus);
  }
  expect(new Set(runIds).size).toBe(17);
  expect(batchIds.size).toBe(1);
  expect(executionConcurrencies.size).toBe(1);
  if (expectVariants) {
    expect(tokenCounts).toEqual(new Set([0, 36, 72]));
    expect(durationCounts).toEqual(new Set([0, 72]));
    expect(costStatuses).toEqual(
      new Set(['estimated', 'unavailable-context-band', 'unavailable-missing-usage']),
    );
  }
  return { batchId: [...batchIds][0] ?? '', runIds };
}

test('production publishes the exact current complete 17-by-72 Official matrix', async ({
  baseURL,
  page,
}, testInfo) => {
  test.slow();
  const expectedIdentity = validateProductionExpectedIdentity(
    testInfo.config.metadata.productionExpectedIdentity,
  );
  expect(baseURL).toBeDefined();
  const expectedOrigin = new URL(baseURL ?? '').origin;
  await expectPublishedPage(page, expectedOrigin, '/benchmarks/intelligence', 'AI Intelligence');
  await expectNoDocumentOverflow(page, testInfo);
  const leaderboard = page.getByRole('region', { name: 'Core leaderboard', exact: true });
  const leaderboardRows = leaderboard.locator('tbody tr');
  await expect(leaderboardRows).toHaveCount(17);
  const configurations = new Set<string>();
  const runHrefs = new Set<string>();
  for (const row of await leaderboardRows.all()) {
    const id = await row.getAttribute('data-configuration');
    expect(id).toMatch(/^(?:sol|terra|luna)-(?:low|medium|high|xhigh|max|ultra)$/);
    configurations.add(id ?? '');
    const ability = row.locator('.core-ability');
    const score = Number((await ability.innerText()).split('\n')[0]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    await expect(ability.locator('.core-interval')).not.toHaveText('');
    await row.getByRole('button', { name: /^Evidence for / }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByText('Run identity & original JSON', { exact: true }).click();
    const href = await drawer
      .getByRole('link', { name: 'Open complete run evidence', exact: true })
      .getAttribute('href');
    const target = new URL(href ?? '', expectedOrigin);
    expect(target.origin).toBe(expectedOrigin);
    expect(target.pathname).toMatch(/^\/benchmarks\/intelligence\/records\/run_[a-f0-9]{64}$/);
    expect(target.searchParams.get('return')).toBe('/benchmarks/intelligence');
    runHrefs.add(target.pathname);
    await page.keyboard.press('Escape');
  }
  expect(configurations.size).toBe(17);
  expect(runHrefs.size).toBe(17);
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  const efficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await efficiency
    .getByLabel('Official efficiency notes', { exact: true })
    .locator('summary')
    .click();
  await expect(efficiency).toContainText('Signed matrix batch wall-clock');
  await expect(efficiency).toContainText('count once across all 17 configurations');
  await expect(efficiency).toContainText('TTFT and TPS are unavailable and are not inferred');
  const signedBatchRecords = efficiency.locator('.table-notes-content > p[title]');
  await expect(signedBatchRecords).toHaveCount(1);
  const signedBatchId = await signedBatchRecords.getAttribute('title');
  expect(signedBatchId).toMatch(matrixBatchPattern);
  expect(signedBatchId).toBe(expectedIdentity.matrixBatchId);
  const overviewEfficiency = await expectTransparentEfficiency(
    efficiency.locator('tbody tr'),
    testInfo.config.metadata.productionEvidenceVariants === true,
  );
  expect(overviewEfficiency.batchId).toBe(signedBatchId);
  expect(new Set(overviewEfficiency.runIds)).toEqual(
    new Set([...runHrefs].map((href) => href.slice('/benchmarks/intelligence/records/'.length))),
  );

  await page.getByRole('tab', { name: 'Records', exact: true }).click();
  const recordRows = page.getByRole('region', { name: 'Core result records' }).locator('tbody tr');
  await expect(recordRows).toHaveCount(17);
  const recordIds = await recordRows.evaluateAll((rows) =>
    rows.map((row) => `/benchmarks/intelligence/records/${row.getAttribute('data-run-id')}`),
  );
  expect(new Set(recordIds)).toEqual(runHrefs);

  let resultCount = 0;
  let pricedCostSubtotalUsdNanos = 0n;
  const taskCostStatuses = new Map<string, number>([
    ['estimated', 0],
    ['unavailable-context-band', 0],
    ['unavailable-missing-usage', 0],
  ]);
  const provenance = {
    benchmark: new Set<string>(),
    scoring: new Set<string>(),
    runnerCommit: new Set<string>(),
    corpusRelease: new Set<string>(),
    corpusCommitment: new Set<string>(),
    catalog: new Set<string>(),
    taskSet: new Set<string>(),
    promptSet: new Set<string>(),
  };
  for (const href of runHrefs) {
    await expectPublishedPage(page, expectedOrigin, href);
    await page.locator('details.run-evidence-notes > summary').click();
    await expect(page.getByText('Official', { exact: true })).toBeVisible();
    await expect(page.getByText('Valid results', { exact: true }).locator('..')).toContainText(
      '72/72',
    );
    const results = page.locator('.task-list > article');
    await expect(results).toHaveCount(72);
    resultCount += await results.count();

    const resultEvidence = await results.evaluateAll((articles) =>
      articles.map((article) => ({
        text: article.textContent ?? '',
        tokenEvidenceLevel: article.getAttribute('data-token-evidence-level'),
        costStatus: article.getAttribute('data-cost-estimator-status'),
        costEvidenceLevel: article.getAttribute('data-cost-evidence-level'),
        costUsdNanos: article.getAttribute('data-standard-api-equivalent-usd-nanos'),
      })),
    );
    for (const result of resultEvidence) {
      const text = result.text;
      expect(result.tokenEvidenceLevel).not.toBeNull();
      expect(result.costStatus).not.toBeNull();
      expect(result.costEvidenceLevel).not.toBeNull();
      expect(result.costUsdNanos).not.toBeNull();
      expect(text).toMatch(/Codex adapter elapsed: (?:unavailable|[\d,]+ ms · [a-z-]+)/);
      expect(text).toMatch(
        /Tokens: input (?:[\d,]+|unavailable) · cached input (?:[\d,]+|unavailable) · cache-write input (?:[\d,]+|unavailable) · output (?:[\d,]+|unavailable) · reasoning (?:[\d,]+|unavailable) · total unavailable/,
      );
      const costStatus = result.costStatus?.replaceAll('_', '-') ?? '';
      const costUsdNanos =
        result.costUsdNanos === 'unavailable' ? null : Number(result.costUsdNanos);
      if (result.costUsdNanos !== null && result.costUsdNanos !== 'unavailable') {
        expect(result.costUsdNanos).toMatch(/^(?:0|[1-9][0-9]*)$/);
        pricedCostSubtotalUsdNanos += BigInt(result.costUsdNanos);
      }
      const tokenEvidenceLevel = nullableEvidence(result.tokenEvidenceLevel);
      const costEvidenceLevel = nullableEvidence(result.costEvidenceLevel);
      validateProductionTaskCostEvidence({
        costStatus,
        costUsdNanos,
        tokenEvidenceLevel,
        costEvidenceLevel,
      });
      taskCostStatuses.set(costStatus, (taskCostStatuses.get(costStatus) ?? 0) + 1);
      const visibleCost =
        costUsdNanos === null
          ? costStatus.replaceAll('-', ' ')
          : `$${(costUsdNanos / 1_000_000_000).toFixed(6)}`;
      expect(text).toContain(
        `API-equivalent cost: ${visibleCost} · token evidence ${tokenEvidenceLevel ?? 'unavailable'} · cost evidence ${costEvidenceLevel ?? 'unavailable'}`,
      );
    }

    await page.locator('#run-provenance > summary').click();
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
    provenance.runnerCommit.add(await readProvenance('Runner commit'));
    provenance.corpusRelease.add(await readProvenance('Corpus release'));
    provenance.corpusCommitment.add(await readProvenance('Corpus commitment'));
    provenance.catalog.add(await readProvenance('Catalog digest'));
    provenance.taskSet.add(await readProvenance('Task-set digest'));
    provenance.promptSet.add(await readProvenance('Prompt set'));
  }
  expect(resultCount).toBe(1_224);
  expect(taskCostStatuses).toEqual(
    new Map([
      ['estimated', expectedIdentity.estimatedCostResultCount],
      ['unavailable-context-band', expectedIdentity.unavailableContextBandResultCount],
      ['unavailable-missing-usage', expectedIdentity.unavailableMissingUsageResultCount],
    ]),
  );
  expect(pricedCostSubtotalUsdNanos).toBe(BigInt(expectedIdentity.pricedCostSubtotalUsdNanos));
  expect(provenance.benchmark).toEqual(new Set([expectedIdentity.benchmarkVersion]));
  expect(provenance.scoring).toEqual(new Set([expectedIdentity.scoringVersion]));
  expect(provenance.runnerCommit).toEqual(new Set([expectedIdentity.runnerCommit]));
  expect(provenance.corpusRelease).toEqual(new Set([expectedIdentity.corpusReleaseId]));
  expect(provenance.corpusCommitment).toEqual(new Set([expectedIdentity.corpusCommitment]));
  expect(provenance.catalog).toEqual(new Set([expectedIdentity.catalogDigest]));
  expect(provenance.taskSet).toEqual(new Set([expectedIdentity.taskSetDigest]));
  expect(provenance.promptSet).toEqual(new Set([expectedIdentity.promptSetDigest]));
});

test('production method, trends, and radar preserve transparent evidence semantics', async ({
  baseURL,
  page,
}, testInfo) => {
  const expectedIdentity = validateProductionExpectedIdentity(
    testInfo.config.metadata.productionExpectedIdentity,
  );
  expect(baseURL).toBeDefined();
  const expectedOrigin = new URL(baseURL ?? '').origin;
  await expectPublishedPage(
    page,
    expectedOrigin,
    '/benchmarks/intelligence?view=method',
    'How AIQ is scored',
  );
  const sections = page.getByRole('navigation', { name: 'On this page', exact: true });
  await sections.getByRole('link', { name: 'Scope', exact: true }).click();
  await expect(page.getByText(expectedIdentity.benchmarkVersion, { exact: true })).toBeVisible();
  await expect(page.getByText(expectedIdentity.scoringVersion, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Frozen Core task catalogue', exact: true }),
  ).toHaveAttribute(
    'href',
    'https://github.com/acg-box/aiq/blob/e12a22c794d4610c6131199743fe2bc0c43ed7be/benchmarks/candidates/aiq-core-1.1.0/catalog.json',
  );
  await sections.getByRole('link', { name: 'Domains', exact: true }).click();
  await expect(
    page.getByText('72 tasks · 10 equally weighted domains', { exact: true }),
  ).toBeVisible();
  await sections.getByRole('link', { name: 'Time & cost', exact: true }).click();
  await expect(page.getByText('displays a published-rate range', { exact: false })).toBeVisible();
  await expect(page.getByText('remains unavailable, never zero', { exact: false })).toBeVisible();
  await expect(
    page.getByText('Signed matrix-stage start and finish times', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'official OpenAI API pricing documentation' }),
  ).toHaveAttribute('href', 'https://developers.openai.com/api/docs/pricing');

  const isLocalContractMock = testInfo.config.metadata.productionEvidenceVariants === true;
  await expectPublishedPage(
    page,
    expectedOrigin,
    '/benchmarks/intelligence?view=records&range=all',
    isLocalContractMock ? 'Latest AIQ snapshot' : 'AIQ over time',
  );
  const visibleSeries = page.getByRole('list', { name: 'Visible trend series' });
  if (isLocalContractMock) {
    await expect(
      page.getByRole('img', { name: /AIQ \(0–100\) first-observation snapshot/ }),
    ).toBeVisible();
    await expect(visibleSeries).toHaveCount(0);
  } else {
    await expect(page.getByRole('img', { name: /AIQ \(0–100\) history\. Lines/ })).toBeVisible();
    await expect(visibleSeries.getByRole('listitem')).toHaveCount(17);
    await expect(page.locator('.trend-legend-note')).toContainText(
      `17 published series · scoring ${expectedIdentity.scoringVersion} · connected observations; no interpolation`,
    );
  }
  await page.getByText('Evidence notes and visible values', { exact: true }).click();
  await expect(page.getByRole('note')).toContainText(
    'Showing 17 configurations in alphabetical family order',
  );
  await expect(page.getByRole('note')).toContainText(
    'Family and reasoning are explicit filters, not point-estimate cutoffs.',
  );
  const trendValues = page.getByRole('region', { name: 'Visible trend values' });
  const trendRows = trendValues.locator('tbody > tr:not(.row-expanded)');
  if (isLocalContractMock) {
    await expect(trendRows).toHaveCount(17);
  } else {
    expect(await trendRows.count()).toBeGreaterThan(17);
    const seriesCounts = new Map<string, number>();
    for (const seriesId of await trendRows.getByRole('rowheader').allInnerTexts()) {
      seriesCounts.set(seriesId, (seriesCounts.get(seriesId) ?? 0) + 1);
    }
    expect(seriesCounts.size).toBe(17);
    expect([...seriesCounts.values()].every((count) => count >= 2)).toBe(true);
  }
  const compact = await trendRows
    .first()
    .getByRole('button', { name: /^Details for / })
    .isVisible();
  if (!compact) {
    for (const heading of ['Coverage', 'Runtime', 'Missing', 'Adapter time', 'API ceiling']) {
      await expect(trendValues.getByRole('columnheader', { name: heading })).toBeVisible();
    }
  }
  for (const row of await trendRows.all()) {
    if (compact) {
      const toggle = row.getByRole('button', { name: /^Details for / });
      await toggle.click();
      const details = row.locator('xpath=following-sibling::tr[1]').getByRole('region');
      await details.locator('.row-detail-context > summary').click();
      const fact = (name: string) =>
        details
          .locator('dt')
          .filter({ hasText: new RegExp(`^${name}\\b`) })
          .locator('..')
          .locator('dd');
      await expect(fact('Run')).not.toHaveText('Unavailable');
      await expect(fact('Coverage')).not.toHaveText('Unavailable');
      await expect(fact('Runtime issues')).not.toHaveText('Unavailable');
      await expect(fact('Missing')).toHaveText(/^\d+$/);
      await expect(fact('Adapter time')).toHaveText(/^(?:Unavailable|\d+(?:\.\d+)? (?:s|min|h))$/);
      await expect(fact('API ceiling')).toHaveText(
        /^(?:Unavailable|\$\d+\.\d{2,4}(?:–\$\d+\.\d{2,4})?)$/,
      );
      await toggle.click();
    } else {
      const cells = row.getByRole('cell');
      await expect(cells.nth(5)).not.toHaveText('Unavailable');
      await expect(cells.nth(6)).not.toHaveText('Unavailable');
      await expect(cells.nth(7)).not.toHaveText('Unavailable');
      await expect(cells.nth(8)).toHaveText(/^\d+$/);
      await expect(cells.nth(9)).toHaveText(/^(?:Unavailable|\d+(?:\.\d+)? (?:s|min|h))$/);
      await expect(cells.nth(10)).toHaveText(
        /^(?:Unavailable|\$\d+\.\d{2,4}(?:–\$\d+\.\d{2,4})?)$/,
      );
    }
  }

  await expectPublishedPage(
    page,
    expectedOrigin,
    '/benchmarks/intelligence/verification',
    'Runner network',
  );
  await page.locator('details.radar-node-details > summary').click();
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
