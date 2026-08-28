import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyAggregateCostText,
  partitionProductionHistory,
} from '../browser-tests-production/production-acceptance-helpers.ts';

void describe('production acceptance helpers', () => {
  void it('classifies exact, bounded-range, and unavailable aggregate cost evidence', () => {
    assert.equal(classifyAggregateCostText('$12.48 72/72 task costs exact'), 'exact');
    assert.equal(
      classifyAggregateCostText('$1.24–$2.13 68/72 task costs exact · remainder bounded'),
      'range',
    );
    assert.equal(classifyAggregateCostText('Unavailable 0/72 task costs exact'), 'unavailable');
    assert.throws(() => classifyAggregateCostText('$1.00-$2.00'), /Invalid aggregate cost/);
    assert.throws(() => classifyAggregateCostText('Unavailable $0'), /Invalid aggregate cost/);
    assert.throws(() => classifyAggregateCostText(''), /Invalid aggregate cost/);
  });

  void it('finds the expected publication without treating appended history as current', () => {
    const expected = new Set(['/runs/current-a', '/runs/current-b']);
    assert.deepEqual(
      partitionProductionHistory(expected, [
        '/runs/current-a',
        '/runs/current-b',
        '/runs/historical-a',
      ]),
      {
        currentRunHrefs: ['/runs/current-a', '/runs/current-b'],
        historicalRunHrefs: ['/runs/historical-a'],
        missingCurrentRunHrefs: [],
      },
    );
    assert.deepEqual(partitionProductionHistory(expected, ['/runs/current-a']), {
      currentRunHrefs: ['/runs/current-a'],
      historicalRunHrefs: [],
      missingCurrentRunHrefs: ['/runs/current-b'],
    });
  });
});
