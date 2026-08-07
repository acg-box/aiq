import { expect, type Page } from '@playwright/test';

import {
  productionPageEvidenceExpectation,
  validateProductionPageEvidence,
} from '../playwright-production-evidence.ts';

async function expectPublishedEvidenceLabel(page: Page, label: string): Promise<void> {
  const note = page.getByLabel(label, { exact: true });
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Published evidence');

  const disclosure = note.locator('xpath=ancestor::details[1]');
  if ((await disclosure.count()) === 1) {
    await expect(disclosure.locator(':scope > summary')).toBeVisible();
    return;
  }
  await expect(disclosure).toHaveCount(0);
  await expect(note).toBeVisible();
}

export async function expectProductionPageEvidence(page: Page, path: string): Promise<void> {
  const expectation = productionPageEvidenceExpectation(path);
  await Promise.all([
    ...expectation.requiredPublishedLabels.map((label) =>
      expectPublishedEvidenceLabel(page, label),
    ),
    expect(page.getByText('Published evidence unavailable', { exact: true })).toHaveCount(0),
    expect(page.getByText('Synthetic / seed data', { exact: true })).toHaveCount(0),
    expect(page.getByText('Mixed evidence', { exact: true })).toHaveCount(0),
  ]);
  const notes = await page.locator('.data-note').evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.getAttribute('aria-label') ?? '',
      state: element.querySelector('.eyebrow')?.textContent?.trim() ?? '',
    })),
  );
  validateProductionPageEvidence(notes, expectation);
}
