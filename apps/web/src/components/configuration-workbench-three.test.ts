import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { configurationWorkbenchFixture } from './configuration-workbench.fixture.ts';
import {
  createConfigurationThreeScale,
  projectConfigurationThreePoint,
  resolveConfigurationThreePoints,
} from './configuration-workbench-three.ts';

const row = (id: string, score: number, duration: number | null, cost: number | null) =>
  configurationWorkbenchFixture({ id, score, duration, cost });

void describe('configuration 3D evidence', () => {
  void it('requires real ability, time, and cost without filling missing evidence', () => {
    const points = resolveConfigurationThreePoints([
      row('complete', 80, 100, 2_000_000_000),
      row('missing-cost', 90, 100, null),
      row('missing-time', 70, null, 1_000_000_000),
    ]);
    assert.deepEqual(
      points.map(({ id }) => id),
      ['complete'],
    );
  });

  void it('uses stable full-evidence time and cost extents with a fixed 0–100 AIQ axis', () => {
    const points = resolveConfigurationThreePoints([
      row('low', 25, 100, 1_000_000_000),
      row('high', 75, 300, 5_000_000_000),
    ]);
    const scale = createConfigurationThreeScale(points);
    assert.ok(scale);
    const [lowPoint, highPoint] = points;
    assert.ok(lowPoint);
    assert.ok(highPoint);
    const low = projectConfigurationThreePoint(lowPoint, scale);
    const high = projectConfigurationThreePoint(highPoint, scale);
    assert.deepEqual([low.x, low.y, low.z], [-1, -0.5, -1]);
    assert.deepEqual([high.x, high.y, high.z], [1, 0.5, 1]);
  });

  void it('centers a constant auxiliary axis instead of dividing by zero', () => {
    const points = resolveConfigurationThreePoints([
      row('one', 50, 100, 1_000_000_000),
      row('two', 60, 100, 1_000_000_000),
    ]);
    const scale = createConfigurationThreeScale(points);
    assert.ok(scale);
    assert.deepEqual(
      points.map((point) => {
        const projected = projectConfigurationThreePoint(point, scale);
        return [projected.x, projected.z];
      }),
      [
        [0, 0],
        [0, 0],
      ],
    );
  });
});
