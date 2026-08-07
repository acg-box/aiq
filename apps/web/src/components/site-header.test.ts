import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const sourceUrl = new URL('./site-header.tsx', import.meta.url);

void describe('site header one-page navigation', () => {
  void it('exposes four direct workspace anchors without a secondary menu', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /\['Results', 'results'\]/);
    assert.match(source, /\['Trends', 'trends'\]/);
    assert.match(source, /\['Compare', 'compare'\]/);
    assert.match(source, /\['Evidence', 'runs'\]/);
    assert.match(source, /href={`\/#\$\{section\}`}/);
    assert.doesNotMatch(source, /site-more|DotsThreeIcon|<details/);
  });

  void it('tracks the visible workspace section for the active anchor', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /new IntersectionObserver/);
    assert.match(source, /\[data-workspace-section\]/);
    assert.match(source, /section\.dataset\.navSection/);
    assert.match(source, /navigationTarget\.current !== visibleSection/);
    assert.match(source, /setActiveSection\(visibleSection\)/);
    assert.match(source, /onClick=\{\(event\) =>/);
    assert.match(source, /activateNavigationTarget\(navigationSection\)/);
    assert.match(source, /document\.getElementById\(section\)/);
    assert.match(source, /section === 'trends' && pathname === '\/trends'/);
    assert.match(source, /section === 'compare' && pathname === '\/compare'/);
  });

  void it('registers streamed sections and removes observers on cleanup', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /new MutationObserver\(observeSections\)/);
    assert.match(source, /mutationObserver\.observe\(document\.body/);
    assert.match(source, /mutationObserver\.disconnect\(\)/);
    assert.match(source, /observer\.disconnect\(\)/);
  });

  void it('realigns late-streamed hash targets and cleans up timers and listeners', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /for \(const delay of \[180, 520, 1100, 2000\]\)/);
    assert.match(source, /section\.scrollIntoView\(\{ block: 'start' \}\)/);
    assert.match(source, /window\.addEventListener\('hashchange', alignToHash\)/);
    assert.match(source, /alignmentTimers\.forEach\(\(timer\) => window\.clearTimeout\(timer\)\)/);
    assert.match(source, /window\.removeEventListener\('hashchange', alignToHash\)/);
  });
});
