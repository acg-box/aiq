import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { selectTheme } from './workspace-helpers.ts';

function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function expectFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
}

test('Harness Rank is a peer board and preserves draft selections without invented results', async ({
  page,
}, testInfo) => {
  const errors = observeErrors(page);
  await page.goto('/');
  await expect(
    page.getByRole('region', { name: 'Benchmark boards', exact: true }).getByRole('rowheader'),
  ).toHaveText(['AI Intelligence', 'Harness Rank', 'Mem']);
  await page
    .getByRole('region', { name: 'Benchmark boards', exact: true })
    .getByRole('link', { name: 'Harness Rank', exact: true })
    .click();
  await expect(page).toHaveURL('/benchmarks/harness');
  await expect(page).toHaveTitle('Harness Rank · AIQ');
  await expect(page.getByRole('heading', { name: 'Harness Rank', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Board coverage' })).toContainText('No measurements');
  const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const titles = await navigation.getByRole('link').allTextContents();
  expect(titles).toEqual(
    ['AI Intelligence', 'Harness Rank', 'Mem'].filter((title) => titles.includes(title)),
  );
  await expect(navigation.getByRole('link', { name: 'Harness Rank', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('heading', { name: 'No measured combinations', exact: true }),
  ).toBeVisible();
  const scope = page.getByRole('region', { name: 'V1 harness scope', exact: true });
  await expect(scope.locator('tbody tr')).toHaveCount(3);
  await expect(scope.getByRole('rowheader')).toHaveText(['Codex', 'Hermes', 'Pi']);
  await expect(page.getByLabel('Harness', { exact: true }).locator('option')).toHaveText([
    'All in V1',
    'Codex',
    'Hermes',
    'Pi',
  ]);
  await expect(page.getByLabel('Comparison', { exact: true })).toHaveValue('same-model');
  await expect(scope.getByRole('cell', { name: 'Not run', exact: true })).toHaveCount(3);
  await expect(page.getByRole('columnheader', { name: 'Rank', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Task success / 95% interval' })).toHaveCount(
    0,
  );
  expect(await scope.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('harness-leaderboard.png'), fullPage: false });

  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Comparison', { exact: true }).selectOption('model-harness');
  await page.getByLabel('Harness', { exact: true }).selectOption('hermes');
  await page.getByLabel('Task family', { exact: true }).selectOption('repair');
  await expect(scope.locator('tbody tr')).toHaveCount(1);
  await expect(scope.getByRole('rowheader')).toHaveText('Hermes');
  await page.getByRole('tab', { name: 'Records', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No trial records', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Comparison', { exact: true })).toHaveValue('model-harness');
  await expect(page.getByLabel('Harness', { exact: true })).toHaveValue('hermes');
  await expect(page.getByLabel('Task family', { exact: true })).toHaveValue('repair');
  await page.getByRole('link', { name: 'Required evidence and protocol →', exact: true }).click();
  const artifacts = page.getByRole('region', { name: 'Planned evidence artifacts', exact: true });
  await expect(artifacts.locator('.harness-artifact-path')).toHaveText([
    'grade.json',
    'repository.diff',
    'accounting.json',
    'manifest.json',
    'answer.md',
    'config.json',
    'transport.jsonl',
    'originals/',
    'attempt.json',
    'task.json',
  ]);
  await expect(
    page.getByText('No attempt artifacts have been collected.', { exact: false }),
  ).toBeVisible();
  const download = page.getByRole('link', { name: /Task set and protocol.*JSON/u, exact: true });
  await expect(download).toHaveAttribute('href', '/api/benchmarks/harness/protocol');
  await page.getByRole('tab', { name: 'Leaderboard', exact: true }).click();
  await expect(page.getByLabel('Harness', { exact: true })).toHaveValue('hermes');
  await expect(
    page.getByRole('heading', { name: 'No measured combinations', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear comparison filters', exact: true }).click();
  await expect(scope.getByRole('rowheader')).toHaveText(['Codex', 'Hermes', 'Pi']);
  await expect(page.getByLabel('Comparison', { exact: true })).toHaveValue('same-model');
  await expect(page.getByLabel('Task family', { exact: true })).toHaveValue('all');
  await expect(page.getByRole('button', { name: 'Clear comparison filters' })).toHaveCount(0);
  await page.reload();
  await expect(scope.getByRole('rowheader')).toHaveText(['Codex', 'Hermes', 'Pi']);
  await expectFits(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('the draft method and documentation remain legible at 320 pixels in both themes', async ({
  page,
}, testInfo) => {
  const errors = observeErrors(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/benchmarks/harness?view=method');
  await expect(
    page.getByRole('heading', { name: 'Study protocol · draft 0.3.0', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Details for Archive extraction containment', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Details: Review Archive extraction containment', exact: true })
    .click();
  const taskDialog = page.getByRole('dialog', {
    name: 'Archive extraction containment',
    exact: true,
  });
  await expect(taskDialog).toBeVisible();
  await expectFits(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('harness-task-320.png'), fullPage: false });
  await page.getByRole('button', { name: 'Close task specification', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Planned task families', exact: true }).getByRole('row'),
  ).toHaveCount(5);
  await expect(
    page.getByText('Three fresh attempts per task and harness', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Proposed budget', exact: true }).getByRole('row'),
  ).toHaveCount(6);
  await expect(
    page.getByText('USD 534 inference + USD 50 compute = USD 584 maximum cash before tax.', {
      exact: false,
    }),
  ).toBeVisible();
  await expectFits(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('harness-method-320.png'), fullPage: false });
  await page.getByRole('region', { name: 'Proposed budget', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('harness-budget-320.png'), fullPage: false });
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Protocol sources', exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Task set and protocol.*JSON/u, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Trial data has not been collected.', { exact: false }),
  ).toBeVisible();
  await selectTheme(page, 'dark');
  await expectFits(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('harness-data-320-dark.png'),
    fullPage: false,
  });
  const artifacts = page.getByRole('region', { name: 'Planned evidence artifacts', exact: true });
  await expect(artifacts).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse tasks →', exact: true })).toBeVisible();
  await page.locator('.harness-evidence-requirements > summary').click();
  await expect(artifacts.getByRole('row')).toHaveCount(11);
  await expect(artifacts.getByRole('rowheader').first()).toContainText('Acceptance results');
  await artifacts.getByRole('button', { name: 'Details for grade.json', exact: true }).click();
  await expect(
    artifacts.getByRole('region', { name: 'grade.json details', exact: true }),
  ).toContainText('Three binary requirement-gate results with assertion evidence');
  await artifacts.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('harness-artifacts-320-dark.png'),
    fullPage: false,
  });
  await expectFits(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('tab', { name: 'Method', exact: true }).click();
  await page.getByText('Documentation review and evidence contract', { exact: true }).click();
  const sources = page.getByRole('region', { name: 'Harness documentation review', exact: true });
  await expect(
    sources.getByRole('link', { name: 'Official configuration docs ↗', exact: true }),
  ).toHaveCount(3);
  await expect(
    page.getByRole('region', { name: 'Planned evidence artifacts', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', {
      name: 'Required evidence files and preservation policy →',
      exact: true,
    }),
  ).toHaveAttribute('href', '/benchmarks/harness?view=data#harness-artifacts');
  await expectFits(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('task specifications filter, survive reload, and expose concrete acceptance without results', async ({
  page,
}, testInfo) => {
  const errors = observeErrors(page);
  await page.goto('/benchmarks/harness?view=method');
  const table = page.getByRole('region', { name: 'Planned task specifications', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(24);
  await expect(table.getByRole('rowheader').first()).toContainText('Archive exclusion rules');
  await expect(page.getByLabel('Task family', { exact: true }).locator('option')).toHaveText([
    'All families',
    'Bug repair',
    'Feature work',
    'Local workflow',
    'Refactor and migration',
  ]);
  await expect(
    page.getByLabel('Estimated difficulty', { exact: true }).locator('option'),
  ).toHaveText(['All levels', 'Basic', 'Medium', 'Hard']);
  await page.screenshot({ path: testInfo.outputPath('harness-tasks.png'), fullPage: false });
  await page.getByLabel('Task family', { exact: true }).selectOption('workflow');
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await page.getByLabel('Estimated difficulty', { exact: true }).selectOption('hard');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('Stack', { exact: true }).selectOption('TypeScript');
  await page.reload();
  await expect(page.getByLabel('Task family', { exact: true })).toHaveValue('workflow');
  await expect(page.getByLabel('Estimated difficulty', { exact: true })).toHaveValue('hard');
  await expect(page.getByLabel('Stack', { exact: true })).toHaveValue('TypeScript');
  if ((page.viewportSize()?.width ?? 1_440) < 500) await selectTheme(page, 'dark');
  const review = page.getByRole('button', {
    name: 'Details: Review Export resume and deduplication',
    exact: true,
  });
  if (!(await review.isVisible()))
    await table
      .getByRole('button', { name: 'Details for Export resume and deduplication', exact: true })
      .click();
  await review.click();
  const dialog = page.getByRole('dialog', { name: 'Export resume and deduplication', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Task specification · not run', { exact: true })).toBeVisible();
  await expect(dialog.locator('.harness-task-gates > li')).toHaveCount(3);
  await dialog.locator('.acceptance-gate > summary').first().click();
  await expect(dialog.locator('.acceptance-gate[open] p')).toBeVisible();
  await expect(dialog.getByText('Resume consistency', { exact: true })).toBeVisible();
  await expect(dialog.locator('.task-gate-id')).toHaveText([
    'export-resume-g1',
    'export-resume-g2',
    'export-resume-g3',
  ]);
  await expect(dialog).toContainText(
    'normal completion within the shared time, token, and cost limits',
  );
  await expect(dialog).toContainText(
    'Workspace, reference solution, and grader are not built or validated.',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('harness-task-details.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(review).toBeFocused();
  await review.click();
  await dialog.getByRole('link', { name: 'Required evidence files →', exact: true }).click();
  await expect(page).toHaveURL(
    /view=data.*workload=workflow.*difficulty=hard.*stack=TypeScript#harness-artifacts$/,
  );
  await expect(
    page.getByRole('heading', { name: 'Required evidence files', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel('Task family', { exact: true })).toHaveValue('workflow');
  await expect(page.getByLabel('Estimated difficulty', { exact: true })).toHaveValue('hard');
  await expect(page.getByLabel('Stack', { exact: true })).toHaveValue('TypeScript');
  await page.getByLabel('Stack', { exact: true }).selectOption('Go');
  await expect(table).toContainText('No task specifications match these filters.');
  await page.getByRole('button', { name: 'Reset filters for tasks', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(24);
  await expectFits(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('tab', { name: 'Leaderboard', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No measured combinations', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Review 24 task specifications', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(24);
  expect(errors).toEqual([]);
});
