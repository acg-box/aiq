import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const pageSourceUrl = new URL('./page.tsx', import.meta.url);
const workspaceStylesUrl = new URL('../workspace.css', import.meta.url);

void describe('run-history responsive contract', () => {
  void it('turns the four-column run table into compact mobile records', async () => {
    const [pageSource, workspaceStyles] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(workspaceStylesUrl, 'utf8'),
    ]);

    for (const label of ['Started', 'Configuration', 'AIQ, time, and cost', 'Evidence']) {
      assert.match(pageSource, new RegExp(`data-label="${label}"`));
    }
    assert.match(pageSource, />AIQ, time, and cost</);
    assert.match(
      workspaceStyles,
      /@media \(max-width: 760px\)[\s\S]+grid-template-areas:[\s\S]+'configuration started'[\s\S]+'score score'[\s\S]+'evidence evidence'/,
    );
    assert.match(workspaceStyles, /\.run-history td\.run-history-evidence \{[\s\S]+display: flex;/);
    assert.match(
      workspaceStyles,
      /\.run-history-primary,[\s\S]+\.run-history-context dl \{[\s\S]+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
  });
});
