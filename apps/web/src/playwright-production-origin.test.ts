import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveProductionOrigin } from '../playwright-production-origin.ts';

void describe('resolveProductionOrigin', () => {
  void it('accepts an explicitly supplied HTTPS origin', () => {
    assert.equal(resolveProductionOrigin('https://aiq.wiki'), 'https://aiq.wiki');
    assert.equal(resolveProductionOrigin('https://aiq.wiki/'), 'https://aiq.wiki');
  });

  void it('rejects missing, non-HTTPS, credentialed, and non-origin targets', () => {
    for (const value of [
      undefined,
      '',
      'http://aiq.wiki',
      'https://user:password@aiq.wiki',
      'https://aiq.wiki/runs',
      'https://aiq.wiki?target=runs',
      'https://aiq.wiki#runs',
      'not-a-url',
    ]) {
      assert.throws(() => resolveProductionOrigin(value), /AIQ_PRODUCTION_ORIGIN/);
    }
  });
});
