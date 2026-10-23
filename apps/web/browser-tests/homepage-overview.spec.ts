import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('a homepage evidence shortcut shows progress without changing its button width', async ({
  page,
}) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/benchmarks/memory*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('view') === 'data') await ready;
    await route.continue();
  });
  await page.goto('/');
  const data = page
    .getByRole('navigation', { name: 'Mem evidence views', exact: true })
    .getByRole('link', { name: 'Data', exact: true });
  const width = (await data.boundingBox())?.width;
  try {
    await data.click();
    await expect(data.locator('[data-pending]')).toBeVisible();
    await expect(data.locator('[data-pending]')).toHaveCSS('opacity', '1');
    expect((await data.boundingBox())?.width).toBe(width);
  } finally {
    release();
  }
  await expect(page.getByRole('tab', { name: 'Data', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Study files', exact: true })).toBeVisible();
});

test('the homepage shows available comparisons and leads directly to their evidence', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  const directory = page.getByRole('region', { name: 'Benchmark boards', exact: true });
  await expect(directory.getByRole('rowheader')).toHaveText([
    'AI Intelligence',
    'Harness Rank',
    'Mem',
  ]);
  const memory = directory
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Mem', exact: true }) });
  await expect(
    memory.getByRole('list', { name: 'Native memory answer preview', exact: true }),
  ).toContainText('11/13');
  await expect(memory.getByRole('listitem')).toHaveCount(2);
  await expect(memory).not.toContainText('ELF');
  await expect(memory).toContainText('6 comparisons');
  const harness = directory
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Harness Rank', exact: true }) });
  await expect(harness).toContainText('Design only · no measured attempts');
  await expect(harness).toContainText('24 task specifications');
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const intelligence = directory
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'AI Intelligence', exact: true }) });
  await intelligence.getByRole('link', { name: 'Records', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Records', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('navigation', { name: 'Evidence registers', exact: true }),
  ).toContainText('Calibration records');
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(
    page.getByRole('link', { name: /Task catalogue.*JSON/u, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Evidence registers', exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
