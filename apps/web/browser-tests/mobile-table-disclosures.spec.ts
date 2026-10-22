import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Locator } from '@playwright/test';

async function fits(page: Page, table: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sizes = await table.evaluate((element) => {
    const region = element.parentElement;
    if (!region) throw new Error('Table region is missing');
    return {
      table: element.getBoundingClientRect().width,
      region: region.clientWidth,
      scroll: region.scrollWidth,
    };
  });
  expect(sizes.table).toBeLessThanOrEqual(sizes.region + 1);
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.region + 1);
}

async function headingsFit(table: Locator) {
  const layout = await table.locator('thead .table-column-heading').evaluateAll((headings) =>
    headings
      .filter((heading) => heading.getBoundingClientRect().width > 0)
      .flatMap((heading) => {
        const cell = heading.closest('th');
        if (!cell) throw new Error('Heading cell is missing');
        const cellBox = cell.getBoundingClientRect();
        const icon = heading.querySelector('svg')?.getBoundingClientRect();
        return [...heading.querySelectorAll('.table-heading-title, .table-heading-unit')].map(
          (text) => {
            const range = document.createRange();
            range.selectNodeContents(text);
            const box = range.getBoundingClientRect();
            return {
              text: text.textContent,
              lines: range.getClientRects().length,
              withinCell: box.left >= cellBox.left && box.right <= cellBox.right + 1,
              clearOfIcon:
                !icon ||
                box.right <= icon.left + 1 ||
                box.bottom <= icon.top ||
                box.top >= icon.bottom,
            };
          },
        );
      }),
  );
  expect(layout.length).toBeGreaterThan(0);
  for (const line of layout) {
    expect(line.lines, line.text).toBe(1);
    expect(line.withinCell, line.text).toBe(true);
    expect(line.clearOfIcon, line.text).toBe(true);
  }
}

function metricNames(region: Locator) {
  return region
    .getByRole('table', { name: 'Same-test comparison' })
    .getByRole('columnheader')
    .allTextContents();
}

function settledCostValue(region: Locator) {
  return region
    .getByRole('table', { name: 'Same-test comparison' })
    .locator('[aria-current="true"] [role="cell"]')
    .last();
}

for (const width of [320, 390]) {
  test(`Mem rows retain key values and disclose full metrics and original JSON at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/benchmarks/memory');
    const table = page.locator('.study-results-table');
    await expect(table.getByRole('columnheader')).toHaveText([
      /Profile\s*version/,
      /Complete\s*\+ bound answers/,
      /Cost\s*USD total/,
      'Details',
    ]);
    await expect(page.getByRole('button', { name: 'All metrics', exact: true })).toHaveCount(0);
    const toggle = table.getByRole('button', { name: 'Details for OpenViking', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await fits(page, table);
    await page.evaluate(() => document.fonts.ready);
    const notes = page.locator('.table-notes[aria-label="Memory comparison notes"]');
    await expect(notes).not.toHaveAttribute('open');
    await expect(notes.locator('.table-notes-content')).not.toBeVisible();
    expect((await notes.locator('..').boundingBox())?.height).toBeLessThan(44);
    await notes.locator('summary').press('Enter');
    await expect(notes.locator('.table-notes-content')).toBeVisible();
    await expect(notes).toContainText('rounded to 6 decimals');
    await expect(notes).toContainText('does not establish semantic entailment');
    await notes.locator('summary').press('Enter');
    await expect(notes.locator('.table-notes-content')).not.toBeVisible();
    expect((await table.locator('thead').boundingBox())?.height).toBeLessThan(70);
    await headingsFit(table);
    const costHeader = table.getByRole('button', { name: 'Settled cost', exact: true });
    await expect(costHeader.locator('svg')).toHaveCount(1);
    const initialHeadings = await table.locator('thead').boundingBox();
    await costHeader.click();
    await expect(costHeader.locator('svg')).toHaveCount(1);
    expect((await table.locator('thead').boundingBox())?.height).toBeCloseTo(
      initialHeadings?.height ?? 0,
      0,
    );
    await headingsFit(table);
    await fits(page, table);
    const profileLines = await table
      .getByRole('rowheader')
      .filter({ hasText: 'OpenViking' })
      .evaluate((element) => {
        const name = element.firstChild;
        if (!name) throw new Error('Profile name is missing');
        const range = document.createRange();
        range.selectNodeContents(name);
        return range.getClientRects().length;
      });
    expect(profileLines).toBe(1);
    const before = await table.boundingBox();
    if (!before) throw new Error('Comparison table is missing');
    await toggle.press('Enter');
    const details = table.getByRole('region', { name: 'OpenViking details', exact: true });
    await details.getByText('All recorded measures', { exact: true }).click();
    await expect(details).toContainText('30/30');
    await details.getByText('Configuration & original record', { exact: true }).click();
    await expect(details.getByRole('link', { name: /Open original.*↗/ })).toHaveAttribute(
      'href',
      /\.json$/,
    );
    await fits(page, table);
    expect((await table.boundingBox())?.width).toBeCloseTo(before.width, 0);
    const headers = table.locator('thead');
    expect((await headers.boundingBox())?.height).toBeLessThan(125);
    await page.screenshot({ path: testInfo.outputPath(`memory-expanded-${width}.png`) });
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toHaveCount(0);
    await page.locator('.results-sort-disclosure > summary').click();
    await page.getByLabel('Metric', { exact: true }).selectOption('quotes');
    await expect(page).toHaveURL(/metric=quotes/);
    await fits(page, table);

    await page.goto(
      '/benchmarks/memory/records/luna-effort/writer-orbit-conditional-zh?return=%2Fbenchmarks%2Fmemory%3Fview%3Drecords%26study%3Dluna-effort',
    );
    const input = page.locator('#case-question');
    await expect(input).not.toHaveAttribute('open');
    await input.locator('summary').click();
    await expect(input).toContainText('AUDIT-62');
    await input.locator('summary').click();
    await page
      .getByRole('navigation', { name: 'On this page' })
      .getByRole('link', { name: 'Luna low', exact: true })
      .click();
    const output = page.locator('#case-observation-0 .saved-output-disclosure');
    await expect(output).not.toHaveAttribute('open');
    await expect(output.locator('pre')).not.toBeVisible();
    await output.locator('summary').click();
    await expect(output.locator('pre')).toBeVisible();
    expect(
      await output.locator('pre').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await expect(
      page.getByRole('link', { name: '← Back to Mem records', exact: true }),
    ).toHaveAttribute('href', '/benchmarks/memory?view=records&study=luna-effort');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`Harness task and evidence tables expand in place at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/benchmarks/harness');
    const notes = page.locator('.table-notes[aria-label="Harness comparison notes"]');
    await fits(page, page.locator('.harness-scope-table'));
    await expect(notes).not.toHaveAttribute('open');
    await expect(notes.locator('.table-notes-content')).not.toBeVisible();
    expect((await notes.locator('..').boundingBox())?.height).toBeLessThan(44);
    await notes.locator('summary').click();
    await expect(notes.locator('.table-notes-content')).toBeVisible();
    await expect(notes).toContainText('runtime compatibility is unqualified');
    await notes.locator('summary').click();
    await expect(notes.locator('.table-notes-content')).not.toBeVisible();
    await page.goto('/benchmarks/harness?view=method&q=refund');
    const table = page.locator('.harness-task-table');
    await expect(table.getByRole('columnheader')).toHaveText([
      'Task',
      /Difficulty\s*estimated/,
      'Details',
    ]);
    await headingsFit(table);
    const toggle = table.getByRole('button', {
      name: 'Details for Ledger refund accounting',
      exact: true,
    });
    await toggle.click();
    const detail = table.getByRole('region', {
      name: 'Ledger refund accounting details',
      exact: true,
    });
    const acceptance = detail.locator('.row-detail-context');
    await expect(acceptance).not.toHaveAttribute('open');
    await expect(acceptance.getByText('Accounting', { exact: true })).not.toBeVisible();
    await acceptance.locator('summary').click();
    await expect(acceptance.getByText('Accounting', { exact: true })).toBeVisible();
    await expect(acceptance).toContainText('minor units');
    await expect(detail).toContainText('Python');
    await fits(page, table);
    expect((await table.locator('thead').boundingBox())?.height).toBeLessThan(90);
    await page.screenshot({ path: testInfo.outputPath(`harness-expanded-${width}.png`) });
    await detail
      .getByRole('button', { name: 'Review Ledger refund accounting', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Ledger refund accounting', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(detail).toHaveCount(0);
    const families = page.locator('.harness-family-table');
    await families.getByRole('button', { name: 'Details for Bug repair', exact: true }).click();
    await fits(page, families);
    const budget = page.locator('.harness-budget-table');
    await expect(budget.getByRole('columnheader')).toHaveText([
      'Allocation',
      /Ceiling\s*USD proposed/,
      'Details',
    ]);
    await budget.getByRole('button', { name: 'Details for Main cohort', exact: true }).click();
    const allocation = budget.getByRole('region', { name: 'Main cohort details', exact: true });
    await expect(allocation).toContainText('216 scored attempts');
    await expect(allocation).toContainText('Unit cap');
    await fits(page, budget);
    await headingsFit(budget);
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await page.locator('.harness-evidence-requirements > summary').click();
    const artifacts = page.locator('.harness-artifact-table');
    const artifact = artifacts.getByRole('button', { name: /^Details for / }).first();
    await artifact.click();
    await expect(artifacts.getByRole('region')).toBeVisible();
    await fits(page, artifacts);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test(`AI calibration and domain tables disclose secondary measurements at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/benchmarks/intelligence/calibrations/run_${'c'.repeat(64)}`);
    const table = page.locator('.calibration-results-table');
    await expect(table.getByRole('columnheader')).toHaveText([
      /Task\s*version/,
      /Outcome\s*execution/,
      /Task score\s*0–1/,
      'Details',
    ]);
    await table.getByRole('button', { name: /^Details for / }).click();
    await expect(
      table
        .getByRole('region')
        .locator('dt')
        .filter({ hasText: /^Tokens\s*provider reported · total$/ }),
    ).toBeVisible();
    await fits(page, table);
    await headingsFit(table);
    expect((await table.locator('thead').boundingBox())?.height).toBeLessThan(110);
    const efficiency = page.locator('.calibration-efficiency-table');
    await efficiency.getByRole('button', { name: 'Details for sol low', exact: true }).click();
    await expect(efficiency.getByRole('region')).toContainText(
      'Untrusted · not Official · not ranking eligible',
    );
    await fits(page, efficiency);
    await expect(efficiency.getByRole('columnheader')).toHaveText([
      /Model\s*effort/,
      /Quality\s*0–100/,
      /Coverage\s*tasks \/ %/,
      'Details',
    ]);
    await headingsFit(efficiency);
    await page.screenshot({ path: testInfo.outputPath(`calibration-expanded-${width}.png`) });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.goto(
      '/benchmarks/intelligence/records/run-2026-07-22-sol-ultra?return=%2Fbenchmarks%2Fintelligence',
    );
    const domains = page.locator('.run-domain-table');
    await domains
      .getByRole('button', { name: /^Details for / })
      .first()
      .click();
    await expect(domains.getByRole('region')).toContainText('Runtime issue');
    await fits(page, domains);
    await headingsFit(domains);
    await page.locator('#run-task-outcomes > summary').click();
    const task = page.locator('.task-list > article').first();
    const taskDetails = task.locator('.task-evidence-details');
    await expect(taskDetails).not.toHaveAttribute('open');
    await expect(task.locator('footer')).not.toBeVisible();
    await taskDetails.locator('summary').click();
    await expect(task.locator('footer')).toBeVisible();
    await expect(taskDetails).toContainText('Codex adapter elapsed');
  });
}

/* eslint-disable no-await-in-loop -- A shared page must settle at each viewport before the next resize. */
test('Mem headings retain one title line and one unit line through tablet widths', async ({
  page,
}) => {
  for (const query of ['', '?study=luna-effort&test=writer']) {
    await page.goto(`/benchmarks/memory${query}`);
    await page.evaluate(() => document.fonts.ready);
    for (const width of [720, 760, 820, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const table = page.locator('.study-results-table');
      await fits(page, table);
      await headingsFit(table);
      expect((await table.locator('thead').boundingBox())?.height).toBeLessThan(75);
    }
  }
});
/* eslint-enable no-await-in-loop */

for (const width of [320, 820]) {
  test(`expanded Mem rows keep matching units, precision and comparable positions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/benchmarks/memory');
    const table = page.locator('.study-results-table');
    await table.getByRole('button', { name: 'Details for OpenViking', exact: true }).click();
    await table.getByRole('button', { name: 'Details for RAGFlow rc1', exact: true }).click();
    const first = table.getByRole('region', { name: 'OpenViking details', exact: true });
    const second = table.getByRole('region', { name: 'RAGFlow rc1 details', exact: true });
    expect(await metricNames(first)).toEqual(await metricNames(second));
    await expect(settledCostValue(first)).toHaveText('$0.024261');
    await expect(settledCostValue(second)).toHaveText('$0.006922');
    const firstCost = await settledCostValue(first).boundingBox();
    const secondCost = await settledCostValue(second).boundingBox();
    if (!firstCost || !secondCost) throw new Error('Expanded cost metrics are missing');
    expect(Math.abs(firstCost.x - secondCost.x)).toBeLessThan(1);
    const measures = first
      .locator('.row-detail-context')
      .filter({ hasText: 'All recorded measures' });
    const source = first
      .locator('.row-detail-context')
      .filter({ hasText: 'Configuration & original record' });
    await expect(measures).not.toHaveAttribute('open');
    await expect(source).not.toHaveAttribute('open');
    await expect(measures.locator('.table-row-facts')).not.toBeVisible();
    expect((await first.boundingBox())?.height).toBeLessThan(width === 320 ? 480 : 380);
    await fits(page, table);
    await measures.locator('summary').click();
    await expect(measures).toContainText('$0.024261415');
    await measures.locator('summary').click();
    await source.locator('summary').click();
    await expect(source).toContainText('0.5.0');
    await fits(page, table);
    await source.locator('summary').click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test(`Harness and AI row details keep compact measures before full context at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/benchmarks/harness?view=method&q=refund');
    const tasks = page.locator('.harness-task-table');
    await tasks
      .getByRole('button', { name: 'Details for Ledger refund accounting', exact: true })
      .click();
    const task = tasks.getByRole('region', {
      name: 'Ledger refund accounting details',
      exact: true,
    });
    await expect(task.locator('dt').filter({ hasText: /^Difficulty\s*estimated$/ })).toBeVisible();
    await expect(task.locator('.row-detail-context')).not.toHaveAttribute('open');
    expect((await task.boundingBox())?.height).toBeLessThan(280);
    await task.locator('.row-detail-context >summary').click();
    await expect(task.locator('.row-detail-context')).toContainText('minor units');
    await expect(task.locator('.row-detail-context')).toContainText('Regression');
    await fits(page, tasks);

    await page.goto(`/benchmarks/intelligence/calibrations/run_${'c'.repeat(64)}`);
    const results = page.locator('.calibration-results-table');
    await results.getByRole('button', { name: /^Details for / }).click();
    const result = results.getByRole('region');
    await expect(result.locator('dt').filter({ hasText: /^Task score\s*0–1$/ })).toBeVisible();
    await expect(
      result.locator('dt').filter({ hasText: /^API cost\s*USD estimate$/ }),
    ).toBeVisible();
    await expect(result.locator('.row-detail-context')).not.toHaveAttribute('open');
    expect((await result.boundingBox())?.height).toBeLessThan(320);
    await result.locator('.row-detail-context >summary').click();
    await expect(result.getByText('Uncached input', { exact: true })).toBeVisible();
    await fits(page, results);
    const efficiency = page.locator('.calibration-efficiency-table');
    await efficiency.getByRole('button', { name: 'Details for sol low', exact: true }).click();
    const metrics = efficiency.getByRole('region');
    await expect(metrics.locator('dt').filter({ hasText: /^Quality\s*0–100$/ })).toBeVisible();
    await expect(
      metrics.locator('dt').filter({ hasText: /^Token coverage\s*tasks \/ %$/ }),
    ).toBeVisible();
    await expect(
      metrics.getByText('Untrusted · not Official · not ranking eligible', { exact: true }),
    ).toBeVisible();
    expect((await metrics.boundingBox())?.height).toBeLessThan(width === 320 ? 380 : 300);
    await fits(page, efficiency);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test('desktop tables retain complete columns without mobile disclosure controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/benchmarks/memory');
  const table = page.locator('.study-results-table');
  await expect(table.getByRole('button', { name: 'Individual quotes', exact: true })).toBeVisible();
  await expect(
    table.getByRole('button', { name: 'Evidence for OpenViking', exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole('button', { name: 'Details for OpenViking', exact: true }),
  ).not.toBeVisible();
  await fits(page, table);
});

test('AI method and tablet evidence keep metric meanings visible without a scrolling table', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/benchmarks/intelligence?view=method');
  await page
    .getByRole('navigation', { name: 'On this page', exact: true })
    .getByRole('link', { name: 'Domains', exact: true })
    .click();
  const domains = page.locator('.core-domain-table');
  await expect(domains.getByRole('columnheader')).toHaveText([
    'Domain',
    /Tasks\s*design/,
    /Weight\s*%/,
  ]);
  await page.evaluate(() => document.fonts.ready);
  await fits(page, domains);
  await headingsFit(domains);
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto(`/benchmarks/intelligence/calibrations/run_${'c'.repeat(64)}`);
  const results = page.locator('.calibration-results-table');
  await expect(results.getByRole('columnheader', { name: /Task score\s*0–1/ })).toBeVisible();
  await fits(page, results);
  await headingsFit(results);
  const efficiency = page.locator('.calibration-efficiency-table');
  await expect(efficiency.getByRole('columnheader', { name: /Quality\s*0–100/ })).toBeVisible();
  await fits(page, efficiency);
  await headingsFit(efficiency);
  await efficiency.getByRole('button', { name: 'Details for sol low', exact: true }).click();
  await expect(
    efficiency
      .getByRole('region')
      .locator('dt')
      .filter({ hasText: /^API cost\s*USD estimate$/ }),
  ).toBeVisible();
  await page.goto('/benchmarks/memory?view=method');
  await page
    .getByRole('navigation', { name: 'On this page', exact: true })
    .getByRole('link', { name: 'Versions', exact: true })
    .click();
  await fits(page, page.locator('.benchmark-version-table'));
  await headingsFit(page.locator('.benchmark-version-table'));
  await page.goto('/benchmarks/memory?view=records');
  await fits(page, page.locator('.memory-record-table'));
  await headingsFit(page.locator('.memory-record-table'));
});

/* eslint-disable no-await-in-loop -- Verify the same historical records at each actual viewport. */
test('historical record controls and exact values fit phones, tablets, and desktops', async ({
  page,
}) => {
  for (const width of [320, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/benchmarks/intelligence?view=records&range=all');
    await page.getByText('Evidence notes and visible values', { exact: true }).click();
    const table = page.locator('.trend-values-table');
    await expect(table.getByRole('columnheader')).toHaveText([
      /Recorded\s*date/,
      /Series\s*configuration/,
      /(?:Ability|Quality)\s*0–100/,
      'Details',
    ]);
    await page.evaluate(() => document.fonts.ready);
    await fits(page, table);
    await headingsFit(table);
    await table
      .getByRole('button', { name: /^Details for / })
      .first()
      .click();
    const metrics = table.getByRole('region').locator('.table-row-facts').first();
    await expect(metrics.locator('dt').first()).toHaveText(/(?:Ability|Quality)\s*0–100/);
    await expect(metrics.locator('dd').first()).toHaveText(/^(?:\d+(?:\.\d+)?|—)$/);
    await expect(metrics).toContainText('Sample');
    await expect(metrics.locator('dt').filter({ hasText: 'Interval' })).toHaveText(
      /Interval\s*(?:conditional 95%|task-mix sensitivity)/,
    );
    await expect(metrics.locator('dt').filter({ hasText: 'Coverage' })).toHaveText(
      /Coverage\s*% of tasks/,
    );
    await expect(table.getByRole('region')).toContainText('API ceiling');
    await fits(page, table);
  }
});
/* eslint-enable no-await-in-loop */
