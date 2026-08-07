import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  trendIntervalData,
  trendIntervalLineShapes,
  trendIntervalXOffset,
} from './trend-interval-layout.ts';

void describe('trend interval layout', () => {
  void it('keeps interval data partitioned by series identity', () => {
    const points = [
      {
        entryId: 'sol-low',
        recordedAt: '2026-08-01T00:00:00.000Z',
        intervalLow: 41,
        intervalHigh: 49,
      },
      {
        entryId: 'terra-medium',
        recordedAt: '2026-08-01T00:00:00.000Z',
        intervalLow: 52,
        intervalHigh: 61,
      },
    ];

    assert.deepEqual(trendIntervalData(points, 'sol-low'), [
      [Date.parse('2026-08-01T00:00:00.000Z'), 41, 49],
    ]);
    assert.deepEqual(trendIntervalData(points, 'terra-medium'), [
      [Date.parse('2026-08-01T00:00:00.000Z'), 52, 61],
    ]);
  });

  void it('uses the matching grouped-bar center and fails closed without one', () => {
    const layout = [{ offsetCenter: -9 }, { offsetCenter: 9 }];

    assert.equal(trendIntervalXOffset('bar', 0, layout), -9);
    assert.equal(trendIntervalXOffset('bar', 1, layout), 9);
    assert.equal(trendIntervalXOffset('bar', 2, layout), null);
    assert.equal(trendIntervalXOffset('bar', 0, [{ offsetCenter: Number.NaN }]), null);
    assert.equal(trendIntervalXOffset('line', 1, undefined), 0);
  });

  void it('applies the same series offset to the interval stem and both caps', () => {
    assert.deepEqual(trendIntervalLineShapes([100, 80], [100, 40], -7), [
      { x1: 93, y1: 80, x2: 93, y2: 40 },
      { x1: 90.5, y1: 80, x2: 95.5, y2: 80 },
      { x1: 90.5, y1: 40, x2: 95.5, y2: 40 },
    ]);
  });
});
