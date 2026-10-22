import { expect, type Page } from '@playwright/test';

export async function selectTheme(page: Page, setting: 'dark' | 'light' | 'system') {
  const option = page.getByRole('button', {
    name: `Use ${setting === 'system' ? 'device' : setting} theme`,
    exact: true,
  });
  const openMenu = !(await option.isVisible());
  if (openMenu)
    await page.getByRole('button', { name: 'Open benchmark navigation', exact: true }).click();
  await option.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-setting', setting);
  if (openMenu)
    await page.getByRole('button', { name: 'Close benchmark navigation', exact: true }).click();
}

export async function openStudyEvidence(page: Page, profile: string) {
  const evidence = page.getByRole('button', { name: `Evidence for ${profile}`, exact: true });
  if (await evidence.isVisible()) {
    await evidence.click();
    const content = page.getByRole('dialog', { name: profile, exact: true });
    await expect(content).toBeVisible();
    return {
      content,
      motionTarget: content,
      close: async () => {
        await page.keyboard.press('Escape');
        await expect(content).not.toBeVisible();
        await expect(evidence).toBeFocused();
      },
    };
  }
  const trigger = page.getByRole('button', { name: `Details for ${profile}`, exact: true });
  await trigger.click();
  const content = page.getByRole('region', { name: `${profile} details`, exact: true });
  await expect(content).toBeVisible();
  return {
    content,
    motionTarget: trigger,
    close: async () => {
      await trigger.press('Enter');
      await expect(content).not.toBeVisible();
      await expect(trigger).toBeFocused();
    },
  };
}
