import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const pageSourceUrl = new URL('./page.tsx', import.meta.url);
const workspaceStylesUrl = new URL('../workspace.css', import.meta.url);

void describe('run-history responsive contract', () => {
  void it('turns the four-column run table into labelled mobile records', async () => {
    const [pageSource, workspaceStyles] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(workspaceStylesUrl, 'utf8'),
    ]);

    for (const label of ['Started', 'Configuration', 'Scientific summary', 'Evidence']) {
      assert.match(pageSource, new RegExp(`data-label="${label}"`));
    }
    assert.match(workspaceStyles, /@media \(max-width: 760px\)[\s\S]+\.run-history td::before/);
    assert.match(workspaceStyles, /content: attr\(data-label\);/);
    assert.match(
      workspaceStyles,
      /@media \(max-width: 360px\)[\s\S]+\.run-history-primary,[\s\S]+grid-template-columns: 1fr;/,
    );
  });
});
