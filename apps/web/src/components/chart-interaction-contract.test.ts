import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8');
}

void describe('analytical chart interaction contracts', () => {
  void it('sets restrained enter and update animation and disables duration for reduced motion', () => {
    const chart = source('./echarts-chart.tsx');
    assert.match(chart, /animationDuration: motionEnabled \? 260 : 0/);
    assert.match(chart, /animationDurationUpdate: motionEnabled \? 180 : 0/);
    assert.match(chart, /animationEasing: 'cubicOut'/);
    assert.match(chart, /animationEasingUpdate: 'cubicOut'/);
  });

  void it('keeps primary chart and theme targets at least 44px for coarse pointers', () => {
    const styles = source('../app/workspace.css');
    const coarsePointerRules = styles.match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(coarsePointerRules, /\.chart-switch button/);
    assert.match(coarsePointerRules, /\.chart-controls select/);
    assert.match(coarsePointerRules, /\.range-tabs a/);
    assert.match(coarsePointerRules, /\.theme-control button/);
    assert.match(coarsePointerRules, /min-height: 44px/);
  });

  void it('qualifies the efficiency frontier in the chart legend', () => {
    const efficiency = source('./efficiency-plot.tsx');
    assert.match(efficiency, /Frontier · descriptive within matching bindings/);
  });

  void it('states that connected trend observations are not interpolated', () => {
    const trend = source('./trend-explorer.tsx');
    assert.match(trend, /connected observations; no interpolation/);
    assert.match(trend, /they do not interpolate or estimate\s+values\s+between dates/);
    assert.match(trend, /connectNulls: false/);
    assert.match(trend, /smooth: false/);
  });
});
