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
    assert.match(coarsePointerRules, /\.configuration-three-actions button/);
    assert.match(coarsePointerRules, /\.configuration-three-focus button/);
    assert.match(coarsePointerRules, /\.workbench-configuration-options label/);
    assert.match(coarsePointerRules, /min-height: 44px/);
    assert.match(
      globalStyles,
      /@media \(pointer: coarse\) \{[\s\S]+\.theme-control button[\s\S]+min-height: 44px/,
    );
  });

  void it('qualifies the efficiency frontier in the chart legend', () => {
    const workbench = source('./configuration-workbench-chart.tsx');
    assert.match(workbench, /Pareto frontier/);
    assert.match(workbench, /AIQ stays on its own axis/);
  });

  void it('renders 3D only on demand without a continuous animation loop', () => {
    const workbench = source('./configuration-workbench-view.tsx');
    const three = source('./configuration-three-chart.tsx');
    assert.match(workbench, /dynamic\(/);
    assert.match(workbench, /configuration-three-chart/);
    assert.doesNotMatch(three, /requestAnimationFrame/);
    assert.match(three, /canCreateWebGlContext/);
    assert.match(three, /Keyboard 3D view controls/);
    assert.match(three, /controls\.rotateLeft/);
    assert.match(three, /controls\.dollyIn/);
    assert.match(three, /webglcontextlost/);
    assert.match(three, /3D is unavailable in this browser/);
    assert.match(three, /renderer\.setPixelRatio\(Math\.min\([^,]+, 1\.75\)\)/);
  });

  void it('states that connected trend observations are not interpolated', () => {
    const trend = source('./trend-explorer.tsx');
    assert.match(trend, /connected observations; no interpolation/);
    assert.match(trend, /they do not interpolate or estimate\s+values\s+between\s+dates/);
    assert.match(trend, /connectNulls: false/);
    assert.match(trend, /smooth: false/);
  });
});
