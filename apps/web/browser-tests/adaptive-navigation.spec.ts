/* eslint-disable no-await-in-loop -- Resize and route checks share one page and must remain sequential. */
import assert from 'node:assert/strict';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const boards = ['AI Intelligence', 'Harness Rank', 'Mem'];
const enlargedNavigation =
  '.workspace-desktop-navigation .workspace-boards a, .workspace-board-measure { font-size: 34px; }';

async function expectHeaderFits(page: Page) {
  await expect
    .poll(() =>
      page.locator('.workspace-desktop-navigation').evaluate((container) => {
        const bounds = container.getBoundingClientRect();
        const items = [
          ...container.querySelectorAll<HTMLElement>(':scope > nav > a, :scope > button'),
        ]
          .filter((item) => item.offsetWidth > 0)
          .map((item) => item.getBoundingClientRect());
        return items.every(
          (item, index) =>
            item.left >= bounds.left - 1 &&
            item.right <= bounds.right + 1 &&
            item.left >= (items[index - 1]?.right ?? bounds.left),
        );
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('compact navigation keeps only the current board while desktop fits peers to available space', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [id, title] of Object.entries({
    intelligence: 'AI Intelligence',
    harness: 'Harness Rank',
    memory: 'Mem',
  })) {
    await page.goto(`/benchmarks/${id}`);
    const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
    for (const width of [1440, 900, 861, 860, 640, 390, 320, 760, 1120]) {
      await page.setViewportSize({ width, height: 844 });
      await expectHeaderFits(page);
      const header = page.locator('.workspace-header');
      expect(
        await header.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeLessThanOrEqual(width <= 860 ? 54 : 58);
      if (width <= 860)
        await expect(header.getByRole('group', { name: 'Color theme', exact: true })).toHaveCount(
          0,
        );
      await expect(navigation.getByRole('link', { name: title, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(navigation.getByRole('link', { name: title, exact: true })).toBeVisible();
      if (width <= 860) await expect(navigation.getByRole('link')).toHaveText([title]);
      else await expect(navigation.getByRole('link')).toHaveText(boards);
      const visible = await navigation.getByRole('link').allTextContents();
      if (visible.length < boards.length) {
        const trigger = page.getByRole('button', {
          name: 'More benchmark navigation',
          exact: true,
        });
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Benchmark navigation', exact: true });
        const overflow = await dialog
          .getByRole('navigation', { name: 'More benchmarks', exact: true })
          .getByRole('link')
          .allTextContents();
        expect(overflow).toEqual(boards.filter((board) => !visible.includes(board)));
        expect(overflow).not.toContain(title);
        const bounds = await dialog.boundingBox();
        assert.ok(bounds);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      }
      if (id === 'memory' && [320, 1440].includes(width))
        await page.screenshot({ path: testInfo.outputPath(`navigation-${width}.png`) });
    }
  }
  expect(errors).toEqual([]);
});

test('font changes refit navigation and expanding an open menu restores the current board focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 844 });
  await page.goto('/benchmarks/memory');
  const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  await expect(navigation.getByRole('link')).toHaveCount(3);
  const largeType = await page.addStyleTag({
    content: enlargedNavigation,
  });
  await expect.poll(() => navigation.getByRole('link').count()).toBeLessThan(3);
  await expect(navigation.getByRole('link', { name: 'Mem', exact: true })).toBeVisible();
  await expectHeaderFits(page);
  await page.getByRole('button', { name: 'More benchmark navigation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Benchmark navigation', exact: true });
  await expect(dialog).toBeVisible();
  await largeType.evaluate((element: HTMLStyleElement) => element.remove());
  await page.setViewportSize({ width: 1440, height: 844 });
  await expect(dialog).not.toBeVisible();
  await expect(navigation.getByRole('link')).toHaveCount(3);
  await expect(navigation.getByRole('link', { name: 'Mem', exact: true })).toBeFocused();
  await expectHeaderFits(page);
});

test('More puts board destinations before compact utilities on mobile and desktop overflow', async ({
  page,
  browserName,
}, testInfo) => {
  for (const width of [320, 900]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/benchmarks/memory');
    if (width === 900) await page.addStyleTag({ content: enlargedNavigation });
    const trigger = page.getByRole('button', { name: 'More benchmark navigation', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Benchmark navigation', exact: true });
    const destinations = dialog.getByRole('navigation', { name: 'More benchmarks', exact: true });
    const utilities = dialog.getByRole('group', { name: 'Workspace utilities', exact: true });
    const theme = utilities.getByRole('group', { name: 'Color theme', exact: true });
    const links = utilities.getByRole('navigation', { name: 'Workspace information', exact: true });
    await expect(theme.getByRole('button')).toHaveText(['System', 'Light', 'Dark']);
    await expect(links.getByRole('link')).toHaveText(['About', 'GitHub ↗', 'Overview']);
    await expect(links.getByRole('link', { name: 'GitHub ↗', exact: true })).toHaveAttribute(
      'href',
      'https://github.com/acg-box/aiq',
    );
    const boardBounds = await destinations.boundingBox();
    const utilityBounds = await utilities.boundingBox();
    const themeBounds = await theme.boundingBox();
    const linkBounds = await links.boundingBox();
    const menuBounds = await dialog.boundingBox();
    assert.ok(boardBounds && utilityBounds && themeBounds && linkBounds && menuBounds);
    expect(utilityBounds.y).toBeGreaterThanOrEqual(boardBounds.y + boardBounds.height);
    expect(linkBounds.y).toBeGreaterThanOrEqual(themeBounds.y + themeBounds.height);
    expect(menuBounds.height).toBeLessThanOrEqual(250);
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width);
    await destinations.getByRole('link').last().focus();
    // WebKit uses Option-Tab to traverse all controls with its default keyboard preference.
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(
      theme.getByRole('button', { name: 'Use system theme', exact: true }),
    ).toBeFocused();
    await theme.getByRole('button', { name: 'Use light theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-setting', 'light');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`more-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  await page.getByRole('button', { name: 'More benchmark navigation', exact: true }).click();
  await page.setViewportSize({ width: 900, height: 240 });
  const shortMenu = page.getByRole('dialog', { name: 'Benchmark navigation', exact: true });
  const shortBounds = await shortMenu.boundingBox();
  assert.ok(shortBounds);
  expect(shortBounds.y + shortBounds.height).toBeLessThanOrEqual(240);
  expect(await shortMenu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await page
    .getByRole('dialog', { name: 'Benchmark navigation', exact: true })
    .getByRole('link', { name: 'About & definitions', exact: true })
    .click();
  await expect(page).toHaveURL('/about');
  await expect(
    page.getByRole('dialog', { name: 'Benchmark navigation', exact: true }),
  ).not.toBeVisible();
});

test('compact themes live in More and retain one setting across desktop, mobile and reload', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/benchmarks/memory');
  const header = page.locator('.workspace-header');
  const trigger = page.getByRole('button', { name: 'More benchmark navigation', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Benchmark navigation', exact: true });
  await expect(header.getByRole('group', { name: 'Color theme', exact: true })).toHaveCount(0);
  await trigger.click();
  await expect(dialog.getByRole('group', { name: 'Color theme', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 1440, height: 844 });
  await expect(dialog).not.toBeVisible();
  await expect(header.getByRole('button', { name: 'Use dark theme', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectHeaderFits(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(dialog.getByRole('button', { name: 'Use dark theme', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Use light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await trigger.click();
  await expect(
    dialog.getByRole('button', { name: 'Use light theme', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Use system theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-setting', 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expectHeaderFits(page);
});

test('an overflow selection becomes visible immediately and the menu supports Escape and touch dismissal', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/benchmarks/memory');
  await expectHeaderFits(page);
  await page.evaluate(() => window.scrollTo(0, 500));
  const trigger = page.getByRole('button', { name: 'More benchmark navigation', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Benchmark navigation', exact: true });
  expect(
    await page
      .locator('.workspace-header')
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBe(0);
  const menuBounds = await dialog.boundingBox();
  const headerBounds = await page.locator('.workspace-header').boundingBox();
  assert.ok(menuBounds && headerBounds);
  expect(menuBounds.y).toBeGreaterThanOrEqual(headerBounds.y + headerBounds.height);
  const destination = dialog
    .getByRole('navigation', { name: 'More benchmarks', exact: true })
    .getByRole('link')
    .first();
  const title = await destination.getAttribute('aria-label');
  const href = await destination.getAttribute('href');
  assert.ok(title);
  assert.ok(href);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('overflow-menu-320.png') });
  await destination.click();
  await expect(page).toHaveURL(href);
  await expect(dialog).not.toBeVisible();
  const current = page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('link', { name: title, exact: true });
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(current).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link'),
  ).toHaveText([title]);
  await expectHeaderFits(page);
  await trigger.click();
  await page.mouse.click(4, 150);
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
