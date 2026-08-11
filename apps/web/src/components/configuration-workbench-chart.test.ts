import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';

import ts from 'typescript';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    };
  },
});

import { configurationWorkbenchFixture } from './configuration-workbench.fixture.ts';

const { resolveWorkbenchPlotRows, resolveWorkbenchXAxisBounds } =
  await import('./configuration-workbench-chart.tsx');

const row = (id: string, duration: number | null, cost: number | null) =>
  configurationWorkbenchFixture({ id, duration, cost });

void describe('configuration workbench plot evidence', () => {
  void it('keeps all complete time observations', () => {
    const rows = [row('one', 10, 1_000_000_000), row('two', 20, null), row('three', null, null)];
    assert.deepEqual(
      resolveWorkbenchPlotRows(rows, 'duration').map(({ entry, x }) => [entry.id, x]),
      [
        ['one', 10],
        ['two', 20],
      ],
    );
  });

  void it('plots exact and bounded cost evidence without creating zeroes', () => {
    const rows = [
      row('one', 10, 1_000_000_000),
      configurationWorkbenchFixture({ id: 'bounded', duration: 20, boundedCost: true }),
      row('missing', 30, null),
    ];
    assert.deepEqual(
      resolveWorkbenchPlotRows(rows, 'cost').map(({ entry, x }) => [entry.id, x]),
      [
        ['one', 1],
        ['bounded', 5.4],
      ],
    );
  });

  void it('keeps every timed row in the decision map and carries cost evidence separately', () => {
    const rows = [
      row('exact', 10, 1_000_000_000),
      configurationWorkbenchFixture({ id: 'bounded', duration: 20, boundedCost: true }),
      row('missing', 30, null),
    ];
    assert.deepEqual(
      resolveWorkbenchPlotRows(rows, 'decision').map(({ entry, x, cost }) => [
        entry.id,
        x,
        cost.kind,
      ]),
      [
        ['exact', 10, 'exact'],
        ['bounded', 20, 'bounded'],
        ['missing', 30, 'unavailable'],
      ],
    );
  });

  void it('zooms time comparisons to observed values but keeps cost anchored at zero', () => {
    const rows = [row('short', 12 * 60_000, 1_000_000_000), row('long', 23 * 60_000, null)];
    const durationPoints = resolveWorkbenchPlotRows(rows, 'duration');
    const [durationMinimum, durationMaximum] = resolveWorkbenchXAxisBounds(
      durationPoints,
      'duration',
    );
    assert.ok(durationMinimum > 0);
    assert.ok(durationMinimum < 12 * 60_000);
    assert.ok(durationMaximum > 23 * 60_000);

    const costPoints = resolveWorkbenchPlotRows(rows, 'cost');
    const [costMinimum, costMaximum] = resolveWorkbenchXAxisBounds(costPoints, 'cost');
    assert.equal(costMinimum, 0);
    assert.ok(costMaximum > 1);
  });
});
