import { openStudyEvidence } from './workspace-helpers.ts';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('Mem charts keep measured values, missingness and workload selection with the table', async ({
  page,
}) => {
  const failures: string[] = [];
  const speculativeRoutes: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin === new URL(page.url()).origin &&
      request.headers()['next-router-prefetch'] === '1'
    )
      speculativeRoutes.push(`${url.pathname}${url.search}`);
  });
  await page.goto('/');
  const previewColors = await page
    .getByRole('list', { name: 'Native memory answer preview', exact: true })
    .locator('.home-ratio-track > span')
    .evaluateAll((marks) => marks.map((mark) => getComputedStyle(mark).backgroundColor));
  await page.goto('/benchmarks/memory?study=native-memory');
  await expect(page.getByRole('tab', { name: 'Leaderboard', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const charts = page.getByRole('region', { name: 'Study performance charts', exact: true });
  await expect(
    page
      .getByRole('region', { name: 'October 15 · native retrieval results', exact: true })
      .locator('tbody tr'),
  ).toHaveCount(2);
  const quality = charts.getByRole('list', { name: 'Complete + bound by profile', exact: true });
  await expect(quality.locator('li')).toHaveText(['OpenViking11/13', 'RAGFlow rc111/13']);
  const qualityColors = await quality
    .locator('.comparison-track > span')
    .evaluateAll((marks) => marks.map((mark) => getComputedStyle(mark).backgroundColor));
  const costColors = await charts
    .getByRole('list', { name: 'Settled cost by profile', exact: true })
    .locator('.comparison-track > span')
    .evaluateAll((marks) => marks.map((mark) => getComputedStyle(mark).backgroundColor));
  expect(new Set(qualityColors).size).toBe(2);
  expect(qualityColors).toEqual(costColors);
  expect(qualityColors).toEqual(previewColors);
  const selectedColor = await page
    .getByRole('tab', { name: 'Leaderboard', exact: true })
    .evaluate((tab) => getComputedStyle(tab).color);
  expect(qualityColors).not.toContain(selectedColor);
  await expect(quality.locator('[data-profile="openviking"]')).toHaveAttribute(
    'data-value',
    String(11 / 13),
  );
  await expect(charts.getByRole('heading', { name: 'Mean time', exact: true })).toHaveCount(0);
  await expect(charts).toContainText('Time: withheld from comparison.');
  await expect(
    charts.getByRole('list', { name: 'Settled cost by profile', exact: true }),
  ).toContainText('$0.024261');

  const overview = page.getByRole('table', { name: 'Memory comparison overview', exact: true });
  await expect(overview.locator('tbody tr')).toHaveCount(6);
  await expect(overview.getByRole('rowheader')).toHaveText([
    'Readers · fixed-context replay → Luna / DeepSeek Flash 1017',
    'Readers · fixed-context replay → Luna reasoning effort',
    'Systems · native retrieval → Native memory systems Viewing',
    'Systems · nightly version check → Native memory systems',
    'Writers · extraction replay → Luna / DeepSeek Flash 1017',
    'Writers · extraction replay → Luna reasoning effort',
  ]);
  await expect(overview.locator('tbody tr').nth(0)).toContainText('DeepSeek Flash 101711/13');
  await expect(overview.locator('tbody tr').nth(0)).toContainText('$0.004811–$0.019369');
  await expect(overview.locator('tbody tr').nth(4)).toContainText('Quality not measured');
  const selected = overview.locator('a[aria-current="location"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAccessibleName(
    /Systems · native retrieval → Native memory systems(?: Viewing)?$/u,
  );
  await expect(page.getByLabel('Study', { exact: true })).not.toBeVisible();
  await overview
    .getByRole('link', {
      name: /Readers · fixed-context replay → Luna reasoning effort(?: Viewing)?$/u,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Readers · fixed-context replay', exact: true }),
  ).toBeFocused();
  await expect(quality.locator('li')).toHaveText([
    'Luna low10/13',
    'Luna medium11/13',
    'Luna none11/13',
  ]);
  const effortFills = await quality.locator('.comparison-track > span').evaluateAll((marks) =>
    marks.map((mark) => ({
      color: getComputedStyle(mark).backgroundColor,
      texture: getComputedStyle(mark).backgroundImage,
    })),
  );
  expect(new Set(effortFills.map((fill) => fill.color)).size).toBe(1);
  expect(new Set(effortFills.map((fill) => fill.texture)).size).toBe(3);
  await expect(selected).toHaveAccessibleName(
    /Readers · fixed-context replay → Luna reasoning effort(?: Viewing)?$/u,
  );
  await expect(overview.locator('tbody tr')).toHaveCount(6);
  await page.goBack();
  await expect(quality.locator('li')).toHaveCount(2);
  await expect(quality).toContainText('OpenViking11/13');
  await expect(selected).toHaveAccessibleName(
    /Systems · native retrieval → Native memory systems(?: Viewing)?$/u,
  );
  const jump = page.getByRole('link', { name: 'Selected comparison ↓', exact: true });
  if (await jump.isVisible()) {
    await jump.click();
    await expect(
      page.getByRole('heading', { name: 'Systems · native retrieval', exact: true }),
    ).toBeFocused();
    await page.getByRole('link', { name: '↑ All comparisons', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'All memory comparisons', exact: true }),
    ).toBeFocused();
  } else {
    const overviewBounds = await overview.boundingBox();
    const detailBounds = await page.locator('.memory-detail').boundingBox();
    if (!overviewBounds || !detailBounds) throw new Error('Comparison workspace is not visible');
    expect(detailBounds.x).toBeGreaterThan(overviewBounds.x + overviewBounds.width);
    const scrollBefore = await page.evaluate(() => scrollY);
    await overview
      .getByRole('link', {
        name: /Readers · fixed-context replay → Luna reasoning effort(?: Viewing)?$/u,
        exact: true,
      })
      .click();
    await expect(quality).toContainText('Luna low10/13');
    expect(await page.evaluate(() => scrollY)).toBe(scrollBefore);
  }
  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Study', { exact: true }).selectOption('luna-deepseek');
  await expect(charts.locator('.comparison-plot')).toHaveCount(3);
  await expect(quality.locator('li')).toHaveText(['DeepSeek Flash 101711/13', 'Luna medium11/13']);
  await expect(charts).toContainText('5.05 s');
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const overviewCells = await overview
    .locator('tbody tr')
    .first()
    .locator(':scope > th, :scope > td')
    .evaluateAll((cells) =>
      cells.map((cell) => {
        const bounds = cell.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y };
      }),
    );
  expect(overviewCells[1]?.x).toBeGreaterThan(overviewCells[0]?.x ?? 0);
  expect(overviewCells[1]?.y).toBe(overviewCells[0]?.y);
  await page.getByLabel('Test', { exact: true }).selectOption('writer');
  await expect(charts).toContainText('Semantic writer quality was not measured.');
  await expect(quality).toHaveCount(0);
  await expect(charts.locator('.comparison-plot')).toHaveCount(2);
  await expect(charts).toContainText('$0.001142');
  const writer = page.getByRole('region', {
    name: 'Writer · 3 paired inputs results',
    exact: true,
  });
  await expect(writer).toContainText('$0.001142');
  await page.reload();
  await expect(selected).toHaveAccessibleName(
    /Writers · extraction replay → Luna \/ DeepSeek Flash 1017(?: Viewing)?$/u,
  );
  await expect(page.getByLabel('Study', { exact: true })).toHaveValue('luna-deepseek');
  await expect(page.getByLabel('Test', { exact: true })).toHaveValue('writer');
  await expect(writer.locator('tbody tr')).toHaveCount(2);
  await charts.getByRole('link', { name: 'Results & evidence ↓', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Results and evidence', exact: true }),
  ).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Leaderboard', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const opened = await openStudyEvidence(page, 'Luna medium');
  await opened.content.getByText('All recorded measures', { exact: true }).click();
  await expect(opened.content.locator('.table-row-facts').first()).toContainText(
    /Inputs\s*per profile\s*3/,
  );
  await opened.close();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(charts).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Study files', exact: true })).toBeVisible();
  await expect(page.getByLabel('Test', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Leaderboard', exact: true }).click();
  await expect(page.getByLabel('Test', { exact: true })).toHaveValue('writer');
  await expect(
    page.getByRole('region', { name: 'Writer · 3 paired inputs results', exact: true }),
  ).toContainText('$0.001142');
  expect(failures).toEqual([]);
  expect(speculativeRoutes).toEqual([]);
});

test('Harness task matrix opens actual acceptance gates and preserves the absence of measurements', async ({
  page,
}) => {
  await page.goto('/benchmarks/harness');
  const matrix = page.getByRole('region', { name: 'Harness task matrix', exact: true });
  await expect(matrix).toContainText('24 task specifications');
  await expect(matrix).toContainText('no measured attempts');
  await expect(matrix.getByRole('list')).toHaveCount(4);
  await expect(matrix.getByRole('button')).toHaveCount(24);
  await expect(matrix.locator('.task-matrix-legend')).toContainText('Basic (6)');
  await expect(matrix.locator('.task-matrix-legend')).toContainText('Medium (12)');
  await expect(matrix.locator('.task-matrix-legend')).toContainText('Hard (6)');
  const review = matrix.getByRole('button', {
    name: /Cache expiration boundary/u,
  });
  await review.click();
  const dialog = page.getByRole('dialog', { name: 'Cache expiration boundary', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.harness-task-gates > li')).toHaveCount(3);
  await expect(dialog).toContainText('cache-expiry');
  await expect(dialog).toContainText(
    'Workspace, reference solution, and grader are not built or validated.',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(review).toBeFocused();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Harness leaderboard', exact: true }),
  ).toContainText('No measured combinations');
  await expect(page.getByLabel('Task family', { exact: true })).not.toBeVisible();
  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Task family', { exact: true }).selectOption({ label: 'Bug repair' });
  await expect(matrix).toContainText('6 task specifications');
  await expect(matrix.getByRole('list')).toHaveCount(1);
  await expect(matrix.getByRole('button')).toHaveCount(6);
  await expect(matrix.getByRole('listitem').first()).toContainText(
    'Archive extraction containment',
  );
  await page.reload();
  await expect(matrix.getByRole('button')).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await matrix.getByRole('link', { name: 'Full task catalogue', exact: true }).click();
  await expect(page.getByLabel('Search task specifications', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Task family', { exact: true })).not.toHaveValue('all');
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(matrix).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /Task set and protocol.*JSON/u, exact: true }),
  ).toBeVisible();
});
