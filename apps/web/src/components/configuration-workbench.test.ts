import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { configurationWorkbenchFixture } from './configuration-workbench.fixture.ts';
import {
  encodeWorkbenchSelection,
  filterConfigurationWorkbenchRows,
  orderConfigurationWorkbenchRows,
  readConfigurationWorkbenchState,
  summarizeConfigurationWorkbench,
} from './configuration-workbench.ts';

const rows = [
  configurationWorkbenchFixture({
    id: 'sol-low',
    modelFamily: 'Sol',
    reasoningTier: 'low',
    score: 88,
    duration: 120,
    cost: 500,
  }),
  configurationWorkbenchFixture({
    id: 'terra-medium',
    modelFamily: 'Terra',
    reasoningTier: 'medium',
    score: 80,
    duration: 90,
    cost: 300,
  }),
  configurationWorkbenchFixture({
    id: 'luna-high',
    modelFamily: 'Luna',
    reasoningTier: 'high',
    score: 75,
    duration: 70,
  }),
  configurationWorkbenchFixture({
    id: 'sol-high',
    modelFamily: 'Sol',
    reasoningTier: 'high',
    score: 60,
    duration: 200,
    cost: 700,
  }),
] as const;

void describe('configuration workbench state', () => {
  void it('defaults to every configuration and a duration view', () => {
    const state = readConfigurationWorkbenchState(new URLSearchParams(), rows);
    assert.deepEqual(state.families, ['Sol', 'Terra', 'Luna']);
    assert.deepEqual(state.reasoningTiers, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual(
      state.configurationIds,
      rows.map(({ entry }) => entry.id),
    );
    assert.equal(state.view, 'duration');
    assert.equal(state.focusId, null);
    assert.equal(filterConfigurationWorkbenchRows(rows, state).length, 4);
  });

  void it('combines family, reasoning, cost, frontier, and custom selection filters', () => {
    const state = readConfigurationWorkbenchState(
      new URLSearchParams(
        'compareFamilies=Sol,Terra&compareReasoning=low,medium&compareConfigs=sol-low,terra-medium&compareCost=estimated&compareFrontier=only',
      ),
      rows,
    );
    assert.deepEqual(
      filterConfigurationWorkbenchRows(rows, state).map(({ entry }) => entry.id),
      ['sol-low', 'terra-medium'],
    );
  });

  void it('preserves an explicit empty selection and ignores invalid URL values', () => {
    const state = readConfigurationWorkbenchState(
      new URLSearchParams(
        'compareFamilies=unknown&compareReasoning=none&compareConfigs=none&compareView=invalid&compareFocus=unknown',
      ),
      rows,
    );
    assert.deepEqual(state.families, ['Sol', 'Terra', 'Luna']);
    assert.deepEqual(state.reasoningTiers, []);
    assert.deepEqual(state.configurationIds, []);
    assert.equal(state.view, 'duration');
    assert.equal(state.focusId, null);
    assert.equal(filterConfigurationWorkbenchRows(rows, state).length, 0);
  });

  void it('encodes defaults compactly and keeps deterministic canonical order', () => {
    const allowed = rows.map(({ entry }) => entry.id);
    assert.equal(encodeWorkbenchSelection(allowed, allowed), null);
    assert.equal(encodeWorkbenchSelection([], allowed), 'none');
    assert.equal(encodeWorkbenchSelection(['luna-high', 'sol-low'], allowed), 'sol-low,luna-high');
  });

  void it('orders and summarizes only the filtered rows without combining score and usage', () => {
    const visible = rows.slice(0, 3);
    assert.deepEqual(
      orderConfigurationWorkbenchRows(visible, 'time').map(({ entry }) => entry.id),
      ['luna-high', 'terra-medium', 'sol-low'],
    );
    assert.deepEqual(
      orderConfigurationWorkbenchRows(visible, 'family').map(({ entry }) => entry.id),
      ['sol-low', 'terra-medium', 'luna-high'],
    );
    const summary = summarizeConfigurationWorkbench(rows, visible);
    assert.equal(summary.highestAbility?.entry.id, 'sol-low');
    assert.equal(summary.shortestTime?.entry.id, 'luna-high');
    assert.equal(summary.lowestCost?.entry.id, 'terra-medium');
    assert.equal(summary.costMeasuredCount, 2);
    assert.equal(summary.visibleCount, 3);
    assert.equal(summary.totalCount, 4);
  });
});
