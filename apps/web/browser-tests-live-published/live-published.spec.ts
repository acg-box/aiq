/* eslint-disable no-await-in-loop -- Each drawer must open and close before the next row can receive focus. */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test as base } from '@playwright/test';
import scorerGeneratedFixture from '../../../benchmarks/fixtures/aiq-2.0-test-generated-public.json' with { type: 'json' };
import { AIQ_CORE_SCORING_VERSION } from '../src/aiq-core-contract.ts';
interface LivePublishedFixtures {
  runtimeFailures: string[];
}
const test = base.extend<LivePublishedFixtures>({
  runtimeFailures: [
    async ({ page }, use) => {
      const failures: string[] = [];
      const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === 'error') failures.push(`console: ${message.text()}`);
      };
      const onPageError = (error: Error) => failures.push(`page: ${error.message}`);
      page.on('console', onConsole);
      page.on('pageerror', onPageError);
      await use(failures);
      expect.soft(failures, 'unexpected browser console or page errors').toEqual([]);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
    { auto: true },
  ],
});

const calibrationRunId = `run_${'8'.repeat(64)}`;
const subsetCalibrationRunId = `run_${'7'.repeat(64)}`;
function expectNoStore(response: { headers(): Record<string, string> }) {
  expect(response.headers()['cache-control']).toContain('no-store');
}

function scorerGeneratedAggregate(id: string) {
  const row = scorerGeneratedFixture.leaderboard.find((candidate) => candidate.matrix_id === id);
  if (!row) throw new Error(`Missing generated aggregate: ${id}`);
  return row;
}
test('the board renders the scorer-owned 17-configuration publication and exact run evidence', async ({
  page,
}) => {
  await page.goto('/');
  const preview = page
    .getByRole('region', { name: 'Benchmark boards', exact: true })
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'AI Intelligence', exact: true }) });
  await expect(preview).toContainText('17 Official configurations');
  await expect(
    preview.getByRole('list', { name: 'Recorded ability preview', exact: true }).locator('li'),
  ).toHaveCount(3);
  await preview.getByRole('link', { name: 'AI Intelligence', exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true }).locator('option')).toHaveText([
    'All',
    'Luna',
    'Sol',
    'Terra',
  ]);
  const table = page.getByRole('region', { name: 'Core leaderboard', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(17);
  for (const expected of scorerGeneratedFixture.leaderboard) {
    const row = table.locator(`tr[data-configuration="${expected.matrix_id}"]`);
    await expect(row).toContainText(expected.score.toFixed(3));
    await row.getByRole('button', { name: /^Details: Evidence for / }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText(expected.run_id);
    await drawer.getByText('Run identity & original JSON', { exact: true }).click();
    await expect(
      drawer.getByRole('link', { name: 'Open complete run evidence', exact: true }),
    ).toHaveAttribute(
      'href',
      `/benchmarks/intelligence/records/${expected.run_id}?return=${encodeURIComponent('/benchmarks/intelligence')}`,
    );
    await page.keyboard.press('Escape');
  }
  await expect(page.getByLabel('Model', { exact: true })).not.toBeVisible();
  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Model', { exact: true }).selectOption('Terra');
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await page.getByLabel('Effort', { exact: true }).selectOption('medium');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Records', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Core result records' }).locator('tbody tr'),
  ).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Details: Evidence for Terra medium', exact: true })
    .click();
  await page.getByRole('dialog').getByText('Run identity & original JSON', { exact: true }).click();
  const completeRun = page.getByRole('link', { name: 'Open complete run evidence', exact: true });
  await expect(completeRun).toHaveAttribute(
    'href',
    `/benchmarks/intelligence/records/${scorerGeneratedAggregate('terra-medium').run_id}?return=${encodeURIComponent('/benchmarks/intelligence?model=Terra&effort=medium&view=records')}`,
  );
  await completeRun.click();
  await page.getByRole('link', { name: '← Back to records', exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('Terra');
  await expect(page.getByLabel('Effort', { exact: true })).toHaveValue('medium');
  await expect(page.getByRole('tab', { name: 'Records', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test('the visual leaderboard keeps exact scorer intervals and one scale after filtering', async ({
  page,
}) => {
  await page.goto('/benchmarks/intelligence');
  const notes = page.locator('.table-notes[aria-label="AI Intelligence results notes"]');
  await expect(notes).not.toHaveAttribute('open');
  await expect(notes.locator('.table-notes-content')).not.toBeVisible();
  await notes.locator('summary').click();
  await expect(notes.locator('.table-notes-content')).toBeVisible();
  await expect(notes).toContainText('relative to all 17 configurations');
  await expect(notes).toContainText('not a human IQ norm');
  await notes.locator('summary').click();
  await expect(notes.locator('.table-notes-content')).not.toBeVisible();
  const table = page.getByRole('region', { name: 'Core leaderboard', exact: true });
  await expect(page.locator('.comparison-reading-key')).toContainText(
    'Strict pass: fully correct outcomes.',
  );
  await expect(page.getByRole('link', { name: 'How scoring works', exact: true })).toHaveAttribute(
    'href',
    '/benchmarks/intelligence?view=method',
  );
  await expect(table.locator('tbody tr')).toHaveCount(17);
  await expect(table.locator('.core-interval-mark')).toHaveCount(17);
  await expect(
    page.getByRole('region', { name: 'Core performance chart', exact: true }),
  ).toHaveCount(0);
  const expected = scorerGeneratedAggregate('terra-medium');
  const row = table.locator(`tr[data-configuration="${expected.matrix_id}"]`);
  const mark = row.locator('.core-interval-mark');
  await expect(row).toContainText(expected.score.toFixed(3));
  await expect(mark).toHaveAttribute('data-low', String(expected.score_ci_low));
  await expect(mark).toHaveAttribute('data-high', String(expected.score_ci_high));
  await expect(mark).toHaveAttribute('data-value', String(expected.score));
  const beforeFiltering = await mark.locator('.core-interval-line').getAttribute('d');
  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Model', { exact: true }).selectOption('Terra');
  await page.getByLabel('Effort', { exact: true }).selectOption('medium');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(mark.locator('.core-interval-line')).toHaveAttribute('d', beforeFiltering ?? '');
  await page.reload();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const detailsToggle = table.getByRole('button', {
    name: 'Details for Terra medium',
    exact: true,
  });
  await detailsToggle.click();
  const details = table.getByRole('region', { name: 'Terra medium details', exact: true });
  await expect(details).toContainText(expected.run_id);
  await expect(details).toContainText(
    `${(expected.strict_pass_low * 100).toFixed(1)}–${(expected.strict_pass_high * 100).toFixed(1)}%`,
  );
  const measurements = await table.locator('table').evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    available: element.parentElement?.clientWidth ?? 0,
  }));
  expect(measurements.width).toBeLessThanOrEqual(measurements.available + 1);
  await detailsToggle.click();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(17);
  await expect(mark.locator('.core-interval-line')).toHaveAttribute('d', beforeFiltering ?? '');
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(table).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /Task catalogue.*JSON/u, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Calibration records', exact: true })).toHaveCount(0);
});
test('the model-effort matrix keeps all results and filters the ranking on desktop and mobile', async ({
  page,
}) => {
  const expected = scorerGeneratedAggregate('terra-medium');
  const expectedRank =
    1 + scorerGeneratedFixture.leaderboard.filter((entry) => entry.score > expected.score).length;
  for (const width of [1536, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/benchmarks/intelligence');
    const matrix = page.getByRole('table', {
      name: 'Recorded ability by model and reasoning effort',
      exact: true,
    });
    const ranking = page.getByRole('region', { name: 'Core leaderboard', exact: true });
    const notes = page.locator('.table-notes[aria-label="AI Intelligence matrix notes"]');
    await expect(notes).not.toHaveAttribute('open');
    await expect(notes.locator('.table-notes-content')).not.toBeVisible();
    expect((await notes.locator('..').boundingBox())?.height).toBeLessThan(44);
    await notes.locator('summary').click();
    await expect(notes.locator('.table-notes-content')).toBeVisible();
    await expect(notes).toContainText('All 17 configurations stay visible');
    await notes.locator('summary').click();
    await expect(matrix.getByRole('columnheader')).toHaveText(['Effort', 'Luna', 'Sol', 'Terra']);
    await expect(matrix.getByRole('rowheader')).toHaveText([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    await expect(matrix.getByRole('link')).toHaveCount(17);
    await expect(ranking.locator('tbody tr')).toHaveCount(17);
    const entry = ranking.locator(`tr[data-configuration="${expected.matrix_id}"]`);
    const interval = entry.locator('.core-interval-line');
    const geometry = await interval.getAttribute('d');
    const subjectColor = await interval.evaluate((mark) => getComputedStyle(mark).stroke);
    const familyColors = await ranking
      .locator('.core-interval-line')
      .evaluateAll((marks) => marks.map((mark) => getComputedStyle(mark).stroke));
    expect(new Set(familyColors).size).toBe(3);
    const cell = matrix.getByRole('link', {
      name: `Compare Terra medium · ability ${expected.score.toFixed(3)}`,
      exact: true,
    });
    await cell.click();
    await expect(ranking.locator('tbody tr')).toHaveCount(1);
    await expect(entry).toHaveAttribute('data-rank', String(expectedRank));
    await expect(interval).toHaveAttribute('d', geometry ?? '');
    expect(await interval.evaluate((mark) => getComputedStyle(mark).stroke)).toBe(subjectColor);
    await expect(cell).toHaveAttribute('aria-current', 'location');
    expect(await cell.evaluate((link) => getComputedStyle(link).outlineColor)).not.toBe(
      subjectColor,
    );
    await expect(matrix.getByRole('link')).toHaveCount(17);
    const heading = page.getByRole('heading', { name: 'Practical task results', exact: true });
    await expect(heading).toBeFocused();
    if (width === 320) {
      // Compact notes can bring the page to its scroll end before the heading reaches the top.
      // Keep the selected result and its notes visible together.
      await expect(heading).toBeInViewport({ ratio: 1 });
      await expect(entry).toBeInViewport({ ratio: 1 });
      await expect(
        page.locator('.table-notes[aria-label="AI Intelligence results notes"] > summary'),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await page
          .locator('.board-tabs')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(
        await entry.locator('.core-strict').evaluate((strictCell) => {
          const bounds = strictCell.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(strictCell);
          return Array.from(range.getClientRects()).every(
            (text) => text.left >= bounds.left && text.right <= bounds.right,
          );
        }),
      ).toBe(true);
    }
    await page.reload();
    await expect(ranking.locator('tbody tr')).toHaveCount(1);
    expect(await interval.evaluate((mark) => getComputedStyle(mark).stroke)).toBe(subjectColor);
    await expect(cell).toHaveAttribute('aria-current', 'location');
    await page.getByRole('tab', { name: 'Records', exact: true }).click();
    await expect(matrix).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Core result records', exact: true }).locator('tbody tr'),
    ).toHaveCount(1);
    await page.getByRole('tab', { name: 'Leaderboard', exact: true }).click();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(ranking.locator('tbody tr')).toHaveCount(17);
    await expect(matrix.locator('[aria-current]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
});

test('a partial Terra-only calibration derives a valid default and reports its selected subset', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const returnTo = '/benchmarks/intelligence?model=Terra&effort=medium&view=records';
  await page.goto(returnTo);
  await page.getByRole('link', { name: 'Calibration records', exact: true }).click();
  const register = page.getByRole('region', { name: 'Public calibration register' });
  await expect(register.getByRole('row')).toHaveCount(3);
  await expect(register).toContainText('1 models × 5 tasks');
  await expect(
    register.getByRole('link', { name: 'Inspect calibration' }).first(),
  ).toBeInViewport();
  await register.getByRole('link', { name: 'Inspect calibration' }).first().click();

  await expect(page).toHaveURL(
    `/benchmarks/intelligence/calibrations/${subsetCalibrationRunId}?${new URLSearchParams({ return: `/benchmarks/intelligence/calibrations?${new URLSearchParams({ return: returnTo })}` })}`,
  );
  await expect(page.getByText('Current filter', { exact: true }).locator('..')).toContainText(
    'terra · medium',
  );
  await expect(page.getByRole('status', { name: 'Calibration result count' })).toContainText(
    'Showing 5 of 5 result cells',
  );
  await expect(page.getByLabel('Model and reasoning configuration').locator('option')).toHaveCount(
    1,
  );
  await expect(page.getByRole('button', { name: 'Show 5-task subset' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Calibration results' }).getByRole('row'),
  ).toHaveCount(6);
  await page.getByRole('button', { name: 'Show 5-task subset', exact: true }).click();
  await expect(
    page.getByRole('link', { name: '← Back to calibrations', exact: true }),
  ).toHaveAttribute(
    'href',
    `/benchmarks/intelligence/calibrations?${new URLSearchParams({ return: returnTo })}`,
  );
  await page.getByRole('link', { name: '← Back to calibrations', exact: true }).click();
  await page.getByRole('link', { name: '← Back to records', exact: true }).click();
  await page.getByRole('tab', { name: 'Leaderboard', exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('Terra');
  await expect(page.getByLabel('Effort', { exact: true })).toHaveValue('medium');

  const absentConfiguration = await request.get(
    `/benchmarks/intelligence/calibrations/${subsetCalibrationRunId}?configuration=sol%3Alow`,
  );
  expect(absentConfiguration.status()).toBe(404);
  expectNoStore(absentConfiguration);

  const absentRun = await request.get(
    `/benchmarks/intelligence/calibrations/run_${'6'.repeat(64)}`,
  );
  expect(absentRun.status()).toBe(404);
  expectNoStore(absentRun);
});

test('full calibration detail keeps one run and one selected-task subset bounded', async ({
  page,
  request,
}, testInfo) => {
  await page.goto(`/benchmarks/intelligence/calibrations/${calibrationRunId}`);
  await expect(page).toHaveURL(`/benchmarks/intelligence/calibrations/${calibrationRunId}`);
  await expect(page.getByText('Current filter', { exact: true }).locator('..')).toContainText(
    'sol · low',
  );
  await expect(page.getByRole('status', { name: 'Calibration result count' })).toContainText(
    'Showing 72 of 1,224 result cells',
  );
  const selector = page.getByLabel('Model and reasoning configuration');
  await expect(selector.locator('option')).toHaveCount(17);
  const results = page.getByRole('region', { name: 'Calibration results' });
  await expect(results.getByRole('row')).toHaveCount(73);
  await expect(page.locator('.calibration-chart svg')).toHaveCount(1);
  await expect(page.locator('.calibration-chart canvas')).toHaveCount(0);
  const workspaceIntegrity = results
    .getByRole('row')
    .filter({ hasText: 'aiq-v1-calibration-task-01' });
  await expect(workspaceIntegrity).toContainText('invalid');
  await expect(workspaceIntegrity).toContainText('workspace_integrity');
  await expect(workspaceIntegrity).toContainText(
    'Benchmark infrastructure invalidated this result; an audited rerun is required.',
  );
  await expect(workspaceIntegrity).toContainText('8.0 s');
  await expect(workspaceIntegrity).toContainText('$0.000650');
  const contextBandResult = results
    .getByRole('row')
    .filter({ hasText: 'aiq-v1-calibration-task-02' });
  await expect(contextBandResult).toContainText('Unavailable');
  await expect(contextBandResult).toContainText('unavailable context band');
  await expect(contextBandResult).toContainText(
    'a result above 272000 aggregate input tokens is therefore unpriced',
  );

  await selector.selectOption('terra:medium');
  await page.getByRole('button', { name: 'Show 72-task subset' }).click();
  await expect(page).toHaveURL(
    `/benchmarks/intelligence/calibrations/${calibrationRunId}?configuration=terra%3Amedium`,
  );
  await expect(page.getByText('Current filter', { exact: true }).locator('..')).toContainText(
    'terra · medium',
  );
  await expect(results.getByRole('row')).toHaveCount(73);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.calibration-chart').scrollIntoViewIfNeeded();
    const chartBounds = await page.locator('.calibration-chart').boundingBox();
    const captionBounds = await page.locator('.calibration-plot figcaption').boundingBox();
    expect(chartBounds?.width).toBeGreaterThan(width === 390 ? 300 : 900);
    expect(captionBounds?.y).toBeGreaterThanOrEqual(
      (chartBounds?.y ?? 0) + (chartBounds?.height ?? 0),
    );
    await page.screenshot({ path: testInfo.outputPath(`calibration-colors-${width}.png`) });
  }

  const invalid = await request.get(
    `/benchmarks/intelligence/calibrations/${calibrationRunId}?configuration=luna%3Aultra`,
  );
  expect(invalid.status()).toBe(404);
  expectNoStore(invalid);
});

test('the published run exposes complete task and provenance evidence', async ({
  page,
}, testInfo) => {
  await page.goto(
    `/benchmarks/intelligence/records/${scorerGeneratedAggregate('sol-ultra').run_id}`,
  );
  await expect(page.locator('.task-list > article')).toHaveCount(72);
  await page.locator('details.run-evidence-notes > summary').click();
  await expect(page.getByText('Official', { exact: true })).toBeVisible();
  await expect(page.getByText('Correct', { exact: true }).locator('..')).toContainText('0');
  await expect(page.getByText('Partial', { exact: true }).locator('..')).toContainText('71');
  await expect(page.getByText('Incorrect', { exact: true }).locator('..')).toContainText('1');
  await expect(
    page.locator('.run-stats').getByText('Runtime issue', { exact: true }).locator('..'),
  ).toContainText('0');
  const provenance = page.locator('#run-provenance');
  await provenance.locator(':scope > summary').click();
  await expect(provenance).toContainText('corpus_test-generated-aiq-core-1.1.0');
  await expect(provenance).toContainText(`sha256:${'9'.repeat(64)}`);
  await expect(provenance.getByText('Not published', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Time, token coverage, and cost' })).toBeVisible();
  await page.getByText('Timing scope', { exact: true }).click();
  await expect(
    page.getByText('Neither value is isolated model latency.', { exact: false }),
  ).toBeVisible();
  const efficiency = page.getByRole('region', { name: 'Official model efficiency' });
  await expect(efficiency).toContainText('1.6 h');
  await expect(efficiency).toContainText('unavailable missing usage');
  await expect(efficiency).not.toContainText('$0');
  const taskResults = page.locator('.task-list > article');
  await page.locator('#run-task-outcomes > summary').click();
  await taskResults.first().getByText('Explanation and usage', { exact: true }).click();
  await expect(taskResults.first()).toContainText('Codex adapter elapsed:');
  await expect(taskResults.first()).toContainText('Tokens: input 1,361');
  await expect(taskResults.first()).toContainText('total unavailable');
  await expect(taskResults.first()).toContainText(
    'Estimated Standard API-equivalent cost: $0.020968 · token evidence verifier-recomputed · cost evidence verifier-recomputed',
  );
  const evaluatorOutcomes = taskResults.filter({
    hasText: 'The evaluator rejected the response.',
  });
  await expect(evaluatorOutcomes).toHaveCount(1);
  await expect(evaluatorOutcomes.first()).toContainText('Published outcome');
  await expect(evaluatorOutcomes.first()).toContainText('incorrect · completed');
  await expect(evaluatorOutcomes.first()).not.toContainText('EXPLANATION_NOT_PUBLISHED');
  await expect(taskResults.filter({ hasText: 'runtime_issue' })).toHaveCount(0);

  await page.goto(
    `/benchmarks/intelligence/records/${scorerGeneratedAggregate('luna-max').run_id}`,
  );
  await page.locator('details.run-evidence-notes > summary').click();
  await expect(page.getByText('Correct', { exact: true }).locator('..')).toContainText('2');
  await expect(page.getByText('Partial', { exact: true }).locator('..')).toContainText('70');
  await expect(page.getByText('Incorrect', { exact: true }).locator('..')).toContainText('0');
  await page.locator('details.run-evidence-notes > summary').click();
  for (const width of [1440, 820, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`run-detail-${width}.png`),
      fullPage: false,
    });
    if (width <= 820) {
      const efficiencyTable = page.locator('.official-efficiency-table');
      await efficiencyTable.getByRole('button', { name: /^Details for / }).click();
      const rowDetails = efficiencyTable.getByRole('region');
      await expect(
        rowDetails.locator('dt').filter({ hasText: /^Provider tokens\s*total reported$/ }),
      ).toBeVisible();
      await expect(rowDetails.locator(':scope > .row-detail-context')).not.toHaveAttribute('open');
      expect((await rowDetails.boundingBox())?.height).toBeLessThan(350);
      await rowDetails.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`efficiency-expanded-${width}.png`) });
      await rowDetails.locator('.row-detail-context >summary').first().click();
      await expect(rowDetails.locator('dt').filter({ hasText: /^Input tokens/ })).toBeVisible();
      await rowDetails.locator('.row-detail-context >summary').first().click();
      const efficiencySizes = await efficiencyTable.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        available: element.parentElement?.clientWidth ?? 0,
        scroll: element.parentElement?.scrollWidth ?? 0,
      }));
      expect(efficiencySizes.width).toBeLessThanOrEqual(efficiencySizes.available + 1);
      expect(efficiencySizes.scroll).toBeLessThanOrEqual(efficiencySizes.available + 1);
      await expect(efficiencyTable.getByRole('columnheader')).toHaveText([
        /Model\s*effort/,
        /Adapter time\s*cell sum/,
        /API cost\s*USD estimate/,
        'Details',
      ]);
      await efficiencyTable.getByRole('button', { name: /^Details for / }).click();
      const domains = page.getByRole('region', { name: 'Run domain summary', exact: true });
      expect(await domains.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await domains.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`run-domains-${width}.png`),
        fullPage: false,
      });
    }
  }
});

test('the frozen definition and published runner records retain their versions and provenance', async ({
  page,
}) => {
  await page.goto('/benchmarks/intelligence?view=method');
  const sections = page.getByRole('navigation', { name: 'On this page', exact: true });
  await sections.getByRole('link', { name: 'Scope', exact: true }).click();
  await expect(page.getByText('aiq-core@1.1.0', { exact: true })).toBeVisible();
  await expect(page.getByText(AIQ_CORE_SCORING_VERSION, { exact: true })).toBeVisible();
  await sections.getByRole('link', { name: 'Time & cost', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'official OpenAI API pricing documentation' }),
  ).toHaveAttribute('href', 'https://developers.openai.com/api/docs/pricing');
  await expect(
    page.getByRole('link', {
      name: 'Prompts above 272,000 input tokens use 2× input and 1.5× output rates',
    }),
  ).toHaveAttribute('href', 'https://developers.openai.com/api/docs/pricing');
  await expect(page.getByText('displays a published-rate range', { exact: false })).toBeVisible();
  await sections.getByRole('link', { name: 'Domains', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Domain coverage', exact: true })).toBeVisible();
  await expect(
    page.getByText('72 tasks · 10 equally weighted domains', { exact: true }),
  ).toBeVisible();

  await page.goto('/benchmarks/intelligence/verification');
  await page.locator('details.radar-node-details > summary').click();
  await expect(page.getByText('Registry trust: trusted verified', { exact: true })).toBeVisible();
  await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('ready · signature verified', { exact: true })).toBeVisible();
  await expect(page.getByText('Sequence / signature').locator('..')).toContainText('42 / verified');
  await expect(page.getByText('Receiver-verified trusted', { exact: true })).toBeVisible();
});

test('the readiness route reports successful bounded loopback dependency probes', async ({
  request,
}) => {
  const response = await request.get('/api/readiness');
  expect(response.status()).toBe(200);
  expectNoStore(response);
  expect(await response.json()).toMatchObject({
    state: 'local_dependencies_ready',
    scope_ready: true,
    mode: 'non_production',
    checks: {
      runtime_mode: 'non_production',
      configuration: 'valid',
      dependencies: 'available',
    },
  });
});
