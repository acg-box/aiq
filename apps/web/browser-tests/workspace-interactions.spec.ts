import { openStudyEvidence } from './workspace-helpers.ts';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('a slow board navigation has visible progress until the destination is ready', async ({
  page,
}) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/benchmarks/intelligence*', async (route) => {
    await ready;
    await route.continue();
  });
  await page.goto('/benchmarks/harness');
  const menu = page.getByRole('button', { name: 'More benchmark navigation', exact: true });
  const direct = page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('link', { name: 'AI Intelligence', exact: true });
  const usesMenu = !(await direct.isVisible());
  if (usesMenu) await menu.click();
  const target = usesMenu
    ? page
        .getByRole('dialog', { name: 'Benchmark navigation', exact: true })
        .getByRole('link', { name: 'AI Intelligence', exact: true })
    : direct;
  const restingWidth = (await target.boundingBox())?.width;
  try {
    await target.click();
    await expect(target.locator('[data-pending]')).toBeVisible();
    await expect(target.locator('[data-pending]')).toHaveCSS('opacity', '1');
    expect((await target.boundingBox())?.width).toBe(restingWidth);
    if (usesMenu)
      await expect(
        page.getByRole('dialog', { name: 'Benchmark navigation', exact: true }),
      ).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'AI Intelligence', exact: true })).toBeVisible();
  if (usesMenu)
    await expect(
      page.getByRole('dialog', { name: 'Benchmark navigation', exact: true }),
    ).not.toBeVisible();
});

test('workspace interactions preserve search, browser history, and light dismissal', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/benchmarks/harness?view=method');
  const tasks = page.getByRole('region', { name: 'Planned task specifications', exact: true });
  const search = page.getByRole('searchbox', { name: 'Search task specifications', exact: true });
  await search.fill('refund');
  await expect(tasks.locator('tbody tr')).toHaveCount(1);
  await expect(tasks).toContainText('Ledger refund accounting');
  await page.getByLabel('Task family', { exact: true }).selectOption('feature');
  await expect(tasks).toContainText('No task specifications match these filters.');
  await page.getByRole('button', { name: 'Reset filters for tasks', exact: true }).click();
  await expect(tasks.locator('tbody tr')).toHaveCount(24);
  await expect(search).toHaveValue('');
  await page.goBack();
  await expect(search).toHaveValue('refund');
  await expect(page.getByLabel('Task family', { exact: true })).toHaveValue('feature');
  await page.goBack();
  await expect(page.getByLabel('Task family', { exact: true })).toHaveValue('all');
  await expect(tasks.locator('tbody tr')).toHaveCount(1);
  const trigger = page.getByRole('button', {
    name: 'Details: Review Ledger refund accounting',
    exact: true,
  });
  if (!(await trigger.isVisible()))
    await page
      .getByRole('button', { name: 'Details for Ledger refund accounting', exact: true })
      .click();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Ledger refund accounting', exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Acceptance gates · all three must pass', exact: true }),
  ).toBeVisible();
  await dialog.getByText('Full task and output contract', { exact: true }).click();
  await expect(dialog).toContainText('Deduplicate events by event_id.');
  await page.screenshot({ path: testInfo.outputPath('workspace-task-sheet.png'), fullPage: false });
  await page.mouse.click(2, 120);
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(search).toHaveValue('refund');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('reduced motion keeps navigation, filters, and details usable', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/benchmarks/memory');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe(
    'auto',
  );
  const opened = await openStudyEvidence(page, 'OpenViking');
  const dialog = opened.content;
  await expect(dialog).toBeVisible();
  expect(
    await opened.motionTarget.evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe('0s');
  await opened.close();
  const menu = page.getByRole('button', { name: 'More benchmark navigation', exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    const navigation = page.getByRole('dialog', { name: 'Benchmark navigation', exact: true });
    await expect(navigation).toBeVisible();
    await page.mouse.click((page.viewportSize()?.width ?? 390) - 2, 120);
    await expect(navigation).not.toBeVisible();
    await expect(menu).toBeFocused();
  }
  await page.locator('.comparison-filters > summary').click();
  await page.getByLabel('Study', { exact: true }).selectOption('luna-effort');
  await page.getByLabel('Test', { exact: true }).selectOption('writer');
  await page.getByRole('tab', { name: 'Data', exact: true }).press('End');
  await expect(page.getByRole('tab', { name: 'Records', exact: true })).toBeFocused();
  await page.getByRole('tab', { name: 'Leaderboard', exact: true }).click();
  await expect(page.getByLabel('Test', { exact: true })).toHaveValue('writer');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('workspace-memory.png'), fullPage: false });
});

test('case return restores filters, the selected finding, scroll, and focus', async ({ page }) => {
  await page.goto(
    '/benchmarks/memory?view=records&study=luna-effort&test=writer&metric=time&metricOrder=desc&caseSearch=project&caseKind=all',
  );
  const title = "Who is the appointed budget owner for Ivo's Cobalt project as of August 22?";
  const finding = page.getByRole('button', { name: `Recorded finding for ${title}`, exact: true });
  await finding.click();
  const link = page.getByRole('link', { name: title, exact: true });
  await link.scrollIntoViewIfNeeded();
  const origin = await page.evaluate(() => ({ href: location.href, y: scrollY }));
  await link.click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Luna low', exact: true })
    .click();
  await page
    .locator('#case-observation-0 summary')
    .filter({ hasText: 'Complete saved output' })
    .click();
  await page.getByRole('link', { name: '← Back to Mem records', exact: true }).click();
  await expect(page).toHaveURL(origin.href);
  await expect(finding).toHaveAttribute('aria-expanded', 'true');
  await expect(link).toBeFocused();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(origin.y, 0);
  await expect(page.getByRole('searchbox', { name: 'Find a case' })).toHaveValue('project');
});

test('mobile reference tabs keep an expanded result at its reading position', async ({ page }) => {
  test.skip(
    (page.viewportSize()?.width ?? 1200) > 760,
    'Inline details are the mobile table view.',
  );
  await page.goto('/benchmarks/memory?study=luna-effort&test=writer&metric=time&metricOrder=desc');
  const opened = await openStudyEvidence(page, 'Luna low');
  await opened.content
    .locator('summary')
    .filter({ hasText: 'Configuration & original record' })
    .click();
  await opened.content
    .getByRole('link', { name: 'Open original metrics.json ↗', exact: true })
    .scrollIntoViewIfNeeded();
  const origin = await page.evaluate(() => ({ href: location.href, y: scrollY }));
  const expected = new URL(origin.href);
  expected.searchParams.set('view', 'leaderboard');
  async function visitRecords(waitForDestination: boolean) {
    // Tap the sticky tab without scrolling its original flow box into view.
    const records = page.getByRole('tab', { name: 'Records', exact: true });
    const tab = await records.boundingBox();
    if (!tab) throw new Error('The Records tab must be visible.');
    await page.mouse.click(tab.x + tab.width / 2, tab.y + tab.height / 2);
    if (waitForDestination) await expect(records).toHaveAttribute('aria-selected', 'true');
    const back = await page.getByRole('tab', { name: 'Leaderboard', exact: true }).boundingBox();
    if (!back) throw new Error('The Leaderboard tab must be visible.');
    await page.mouse.click(back.x + back.width / 2, back.y + back.height / 2);
    await expect(page).toHaveURL(expected.href);
    await expect(page.locator('.board-tabs [data-pending]')).toHaveCount(0);
    await expect(opened.content).toBeVisible();
    await expect(
      opened.content.locator('details').filter({ hasText: 'Configuration & original record' }),
    ).toHaveAttribute('open', '');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(origin.y, 0);
  }
  await visitRecords(false);
  await visitRecords(true);
  await opened.content
    .getByRole('button', { name: 'Close details for Luna low', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Details for Luna low', exact: true }),
  ).toBeFocused();
});

test('evidence requirements return restores the open task and its reading position', async ({
  page,
}) => {
  await page.goto('/benchmarks/harness?harness=codex&workload=repair');
  await page.locator('.comparison-filters > summary').click();
  const trigger = page.getByRole('button', {
    name: /Ledger refund accounting/u,
  });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Ledger refund accounting', exact: true });
  await dialog.locator('summary').filter({ hasText: 'Full task and output contract' }).click();
  const evidenceLink = dialog.getByRole('link', { name: 'Required evidence files →', exact: true });
  await evidenceLink.scrollIntoViewIfNeeded();
  const origin = await page.evaluate(() => ({
    href: location.href,
    y: scrollY,
    top: document.querySelector('dialog[open]')?.scrollTop,
  }));
  await evidenceLink.click();
  await expect(
    page.getByRole('heading', { name: 'Required evidence files', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(origin.href);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator('summary').filter({ hasText: 'Full task and output contract' }).locator('..'),
  ).toHaveAttribute('open', '');
  await expect(evidenceLink).toBeFocused();
  await expect
    .poll(() => dialog.evaluate((element) => element.scrollTop))
    .toBeCloseTo(origin.top ?? 0, 0);
  await dialog.getByRole('button', { name: 'Close task specification', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(origin.y, 0);
});
