import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatScientificScoreContextHtml } from './scientific-score-context.ts';

void describe('scientific score context', () => {
  void it('keeps sample, coverage, execution state, scoring, and provenance together', () => {
    assert.equal(
      formatScientificScoreContextHtml({
        sampleSize: 72,
        coverage: '98.6%',
        runtime: '2 issues',
        missing: '1',
        status: 'official',
        scoringVersion: '1.0.3',
        provenance: 'published',
      }),
      'score n=72 · coverage 98.6%<br/>runtime 2 issues · missing 1<br/>status official · scoring 1.0.3 · published',
    );
  });

  void it('states unavailable aggregate execution evidence instead of inventing zero', () => {
    const context = formatScientificScoreContextHtml({
      sampleSize: 1,
      coverage: '100.0%',
      runtime: 'adapter invoked 0/0 attempted',
      missing: 'unavailable in aggregate',
      status: 'conditional observed',
      scoringVersion: '1.0.3',
      provenance: 'synthetic',
    });

    assert.match(context, /missing unavailable in aggregate/);
    assert.doesNotMatch(context, /missing 0/);
  });
});
