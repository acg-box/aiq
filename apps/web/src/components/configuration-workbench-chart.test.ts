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

const { resolveWorkbenchPlotRows } = await import('./configuration-workbench-chart.tsx');

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

  void it('plots only explicit cost estimates without creating zeroes', () => {
    const rows = [row('one', 10, 1_000_000_000), row('two', 20, null)];
    assert.deepEqual(
      resolveWorkbenchPlotRows(rows, 'cost').map(({ entry, x }) => [entry.id, x]),
      [['one', 1]],
    );
  });
});
