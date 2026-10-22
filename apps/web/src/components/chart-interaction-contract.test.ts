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
    assert.match(coarsePointerRules, /min-height: 44px/);
    assert.match(
      globalStyles,
      /@media \(pointer: coarse\) \{[\s\S]+\.theme-control button[\s\S]+min-height: 44px/,
    );
  });

  void it('keeps unavailable TTFT subordinate to the paired transport evidence', () => {
    const speed = source('./speed-observation-explorer.tsx');

    assert.match(speed, /Paired configurations/);
    assert.match(speed, /TTFT is not shown/);
    assert.doesNotMatch(speed, /<dt>TTFT<\/dt>/);
  });

  void it('states that connected trend observations are not interpolated', () => {
    const trend = source('./trend-explorer.tsx');
    assert.match(trend, /connected observations; no interpolation/);
    assert.match(trend, /First published observation/);
    assert.match(trend, /chartMode = isSingleObservationDate \? 'bar' : mode/);
    assert.match(trend, /resolveConfigurationCost\(exactEfficiency\)/);
    assert.match(trend, /costEvidence\.upperUsdNanos/);
    assert.match(trend, /they do not interpolate or estimate\s+values\s+between\s+dates/);
    assert.match(trend, /connectNulls: false/);
    assert.match(trend, /smooth: false/);
  });
});
