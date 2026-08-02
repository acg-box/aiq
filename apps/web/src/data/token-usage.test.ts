import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { uncachedInputTokens } from './token-usage.ts';

void describe('provider token presentation', () => {
  void it('derives uncached input only from complete coherent counters', () => {
    assert.equal(uncachedInputTokens(100, 25, 10), 65);
    assert.equal(uncachedInputTokens(100, null, 10), null);
    assert.equal(uncachedInputTokens(10, 8, 8), null);
  });
});
