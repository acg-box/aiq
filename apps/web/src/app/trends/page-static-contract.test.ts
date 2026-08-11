import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const pageSourceUrl = new URL('./page.tsx', import.meta.url);
const workspaceStylesUrl = new URL('../workspace.css', import.meta.url);

void describe('trend-page evidence hierarchy', () => {
  void it('names a single date as a snapshot instead of implying a time series', async () => {
    const pageSource = await readFile(pageSourceUrl, 'utf8');

    assert.match(pageSource, /const observationCount = new Set/);
    assert.match(pageSource, /isSingleObservation \? 'Latest AIQ snapshot' : 'AIQ over time'/);
    assert.match(pageSource, /trend lines begin after the next Official cycle/);
  });

  void it('keeps repeated source provenance behind a compact disclosure', async () => {
    const [pageSource, workspaceStyles] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(workspaceStylesUrl, 'utf8'),
    ]);

    assert.match(pageSource, /<details className="evidence-status-disclosure"/);
    assert.match(pageSource, /open=\{evidenceNeedsAttention\}/);
    assert.match(pageSource, /state === 'empty' \|\| state === 'unavailable'/);
    assert.match(pageSource, /Evidence availability/);
    assert.match(pageSource, /4 sources/);
    assert.match(workspaceStyles, /\.evidence-status-disclosure > summary/);
    assert.match(workspaceStyles, /\.evidence-status-grid \{[\s\S]+grid-template-columns:/);
  });
});
