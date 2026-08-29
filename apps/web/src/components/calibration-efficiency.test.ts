import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';

import ts from 'typescript-compiler-api';

import { type CalibrationMetricEvidence, calibrationMetricValue } from './calibration-metric.ts';

type TestMetric = 'cost' | 'time';
type TestElement = Readonly<{
  type: unknown;
  props: Readonly<Record<string, unknown>>;
}>;

const TEST_REACT_URL = 'test:calibration-react';
let metricState: TestMetric = 'cost';

const testGlobal = globalThis as typeof globalThis & {
  aiqCalibrationUseState?: (
    initial: TestMetric,
  ) => readonly [TestMetric, (next: TestMetric | ((current: TestMetric) => TestMetric)) => void];
};

testGlobal.aiqCalibrationUseState = (initial) => {
  if (metricState !== 'cost' && metricState !== 'time') metricState = initial;
  return [
    metricState,
    (next) => {
      metricState = typeof next === 'function' ? next(metricState) : next;
    },
  ];
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react' && context.parentURL?.endsWith('/calibration-efficiency.tsx')) {
      return { shortCircuit: true, url: TEST_REACT_URL };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === TEST_REACT_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function useState(initial) { return globalThis.aiqCalibrationUseState(initial); }',
      };
    }
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

const { CalibrationEfficiency } = await import('./calibration-efficiency.tsx');

function isTestElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function collectElements(value: unknown): readonly TestElement[] {
  if (Array.isArray(value)) return value.flatMap(collectElements);
  if (!isTestElement(value)) return [];
  return [value, ...collectElements(value.props.children)];
}

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  return isTestElement(value) ? textContent(value.props.children) : '';
}

function isNoArgumentHandler(value: unknown): value is () => void {
  return typeof value === 'function';
}

function renderCalibration(): readonly TestElement[] {
  return collectElements(
    CalibrationEfficiency({ scores: [], scoringVersion: null, executionContext: new Map() }),
  );
}

function score(overrides: Partial<CalibrationMetricEvidence> = {}): CalibrationMetricEvidence {
  return {
    observedMedianWallMs: 12_345,
    observedTimeCoveragePercent: 100,
    costEstimatorStatus: 'estimated',
    tokenUsageCoveragePercent: 100,
    standardApiEquivalentUsdNanos: 1_250_000_000,
    ...overrides,
  };
}

void describe('calibration efficiency metric units', () => {
  void it('converts covered median adapter time from milliseconds to seconds', () => {
    assert.equal(calibrationMetricValue(score(), 'time'), 12.345);
  });

  void it('keeps time unavailable without complete observation coverage', () => {
    assert.equal(
      calibrationMetricValue(score({ observedTimeCoveragePercent: 99.9 }), 'time'),
      null,
    );
    assert.equal(calibrationMetricValue(score({ observedMedianWallMs: null }), 'time'), null);
  });

  void it('converts covered API-equivalent cost from nanos to dollars', () => {
    assert.equal(calibrationMetricValue(score(), 'cost'), 1.25);
  });
});

void describe('calibration efficiency interaction', () => {
  const source = readFileSync(new URL('./calibration-efficiency.tsx', import.meta.url), 'utf8');

  void it('uses one metric-switched scatter while retaining both table metrics', () => {
    assert.match(source, /aria-labelledby="calibration-metric-label"/);
    assert.match(source, /aria-pressed=\{metric === 'cost'\}/);
    assert.match(source, /aria-pressed=\{metric === 'time'\}/);
    assert.equal(source.match(/<Scatter/g)?.length, 1);
    assert.match(source, /Observed Codex adapter elapsed time/);
    assert.match(source, /Estimated Standard API equivalent token cost/);
  });

  void it('updates the heading, pressed state, and plotted metric when the toggle changes', () => {
    metricState = 'cost';
    const costElements = renderCalibration();
    const costHeading = costElements.find((element) => element.type === 'h2');
    const observedTimeButton = costElements.find(
      (element) => element.type === 'button' && textContent(element) === 'Observed time',
    );
    const costScatter = costElements.find(
      (element) => typeof element.type === 'function' && element.type.name === 'Scatter',
    );

    assert.equal(
      textContent(costHeading),
      'Descriptive quality versus estimated Standard API-equivalent token cost',
    );
    assert.equal(observedTimeButton?.props['aria-pressed'], false);
    assert.equal(costScatter?.props.metric, 'cost');

    const selectObservedTime = observedTimeButton?.props.onClick;
    assert.equal(typeof selectObservedTime, 'function');
    if (isNoArgumentHandler(selectObservedTime)) selectObservedTime();

    const timeElements = renderCalibration();
    const timeHeading = timeElements.find((element) => element.type === 'h2');
    const selectedTimeButton = timeElements.find(
      (element) => element.type === 'button' && textContent(element) === 'Observed time',
    );
    const timeScatter = timeElements.find(
      (element) => typeof element.type === 'function' && element.type.name === 'Scatter',
    );

    assert.equal(
      textContent(timeHeading),
      'Descriptive quality versus median observed cell adapter elapsed time',
    );
    assert.equal(selectedTimeButton?.props['aria-pressed'], true);
    assert.equal(timeScatter?.props.metric, 'time');
  });
});
