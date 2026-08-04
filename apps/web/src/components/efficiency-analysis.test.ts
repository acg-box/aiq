import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paretoEfficientKeys } from './efficiency-analysis.ts';

void describe('efficiency frontier analysis', () => {
  void it('finds nondominated points only inside the same comparison group', () => {
    const frontier = paretoEfficientKeys([
      { key: 'fast-high', comparisonGroup: 'batch-a', x: 1, y: 90 },
      { key: 'slow-low', comparisonGroup: 'batch-a', x: 2, y: 80 },
      { key: 'slow-high', comparisonGroup: 'batch-a', x: 2, y: 95 },
      { key: 'other-binding', comparisonGroup: 'batch-b', x: 3, y: 70 },
    ]);

    assert.deepEqual([...frontier].toSorted(), ['fast-high', 'other-binding', 'slow-high']);
  });

  void it('keeps tied points without inventing a winner', () => {
    const frontier = paretoEfficientKeys([
      { key: 'left', comparisonGroup: 'same', x: 1, y: 90 },
      { key: 'right', comparisonGroup: 'same', x: 1, y: 90 },
    ]);

    assert.deepEqual([...frontier].toSorted(), ['left', 'right']);
  });
});
