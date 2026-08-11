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
    const globalStyles = source('../app/globals.css');
    const coarsePointerRules = styles.match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(coarsePointerRules, /\.chart-switch button/);
    assert.match(coarsePointerRules, /\.chart-controls select/);
    assert.match(coarsePointerRules, /\.range-tabs a/);
    assert.match(coarsePointerRules, /\.workbench-filter-options button/);
    assert.match(coarsePointerRules, /\.workbench-configuration-options button/);
    assert.match(coarsePointerRules, /\.workbench-table thead th > button/);
    assert.match(coarsePointerRules, /min-height: 44px/);
    assert.match(
      globalStyles,
      /@media \(pointer: coarse\) \{[\s\S]+\.theme-control button[\s\S]+min-height: 44px/,
    );
  });

  void it('qualifies the efficiency frontier in the chart legend', () => {
    const workbench = source('./configuration-workbench-chart.tsx');
    assert.match(workbench, /Pareto frontier/);
    assert.match(workbench, /AIQ remains independent/);
  });

  void it('uses one accessible ECharts surface for the three-metric decision map', () => {
    const workbench = source('./configuration-workbench-view.tsx');
    const chart = source('./configuration-workbench-chart.tsx');
    assert.match(workbench, /Decision map/);
    assert.doesNotMatch(workbench, /configuration-three-chart|3D/);
    assert.match(chart, /Three-metric decision map/);
    assert.match(chart, /Cost range/);
    assert.match(chart, /bubbleSize/);
    assert.match(chart, /EChartsChart/);
  });

  void it('focuses chart points directly and sorts through interactive table headings', () => {
    const workbench = source('./configuration-workbench-view.tsx');
    const chart = source('./configuration-workbench-chart.tsx');
    const chartSurface = source('./echarts-chart.tsx');
    assert.doesNotMatch(workbench, />Highlight</);
    assert.doesNotMatch(workbench, />Order</);
    assert.match(workbench, /aria-sort=/);
    assert.match(workbench, /updateOrder\(order\)/);
    assert.match(chart, /onDataPointClick=\{focusPoint\}/);
    assert.match(chart, /onBlankClick=\{clearFocus\}/);
    assert.match(chartSurface, /instance\.on\('click', pointClick\)/);
    assert.match(chartSurface, /instance\.getZr\(\)\.on\('click', blankClick\)/);
  });

  void it('states that connected trend observations are not interpolated', () => {
    const trend = source('./trend-explorer.tsx');
    assert.match(trend, /connected observations; no interpolation/);
    assert.match(trend, /they do not interpolate or estimate\s+values\s+between\s+dates/);
    assert.match(trend, /connectNulls: false/);
    assert.match(trend, /smooth: false/);
  });
});
