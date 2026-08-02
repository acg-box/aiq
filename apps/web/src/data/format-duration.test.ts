import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatHumanDuration, formatTaskDuration } from './format-duration.ts';

void describe('human duration formatting', () => {
  void it('uses seconds for short cells and minutes or hours for aggregate elapsed time', () => {
    assert.equal(formatTaskDuration(12_345), '12.3 s');
    assert.equal(formatHumanDuration(90_000), '1.5 min');
    assert.equal(formatHumanDuration(7_200_000), '2.0 h');
  });
});
