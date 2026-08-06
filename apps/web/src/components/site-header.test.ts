import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const sourceUrl = new URL('./site-header.tsx', import.meta.url);

void describe('site header More navigation', () => {
  void it('keeps the native details and summary disclosure structure', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /<details ref={moreMenuRef} className="site-more">/);
    assert.match(source, /<summary[\s\S]+aria-label="More pages"[\s\S]+<DotsThreeIcon/);
    assert.doesNotMatch(source, /role="menu"|role="menuitem"/);
  });

  void it('closes on Escape and restores focus to the summary', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /event\.key !== 'Escape' \|\| !moreMenu\.open/);
    assert.match(source, /event\.preventDefault\(\);\s*moreMenu\.open = false;/);
    assert.match(source, /moreMenu\.querySelector\('summary'\)\?\.focus\(\)/);
  });

  void it('closes on outside pointer interaction and removes document listeners', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /event\.target instanceof Node &&\s*!moreMenu\.contains\(event\.target\)/);
    assert.match(source, /document\.addEventListener\('pointerdown', handlePointerDown\)/);
    assert.match(source, /document\.removeEventListener\('pointerdown', handlePointerDown\)/);
    assert.match(source, /document\.removeEventListener\('keydown', handleKeyDown\)/);
  });

  void it('closes for submenu selection and completed route changes', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /onNavigate={\(\) => {[\s\S]+moreMenuRef\.current\.open = false;/);
    assert.match(
      source,
      /useEffect\(\(\) => {[\s\S]+moreMenuRef\.current\.open = false;\s*}, \[pathname\]\)/,
    );
  });
});
