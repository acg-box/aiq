import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const pageSourceUrl = new URL('./page.tsx', import.meta.url);

void describe('radar empty telemetry presentation', () => {
  void it('explains registered identities without repeating ambiguous empty records', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');
    assert.match(source, /Registered identity/);
    assert.match(source, /Radar telemetry not enabled · live state unknown/);
    assert.match(source, /Capability telemetry is not enabled for this identity/);
    assert.match(source, /Observation telemetry is not enabled for this identity/);
    assert.doesNotMatch(source, /No published record/);
  });
});
