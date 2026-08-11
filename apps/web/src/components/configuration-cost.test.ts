import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { configurationWorkbenchFixture } from './configuration-workbench.fixture.ts';
import {
  describeConfigurationCost,
  formatConfigurationCost,
  resolveConfigurationCost,
} from './configuration-cost.ts';

void describe('configuration cost presentation', () => {
  void it('preserves a verifier-recomputed exact total', () => {
    const candidate = configurationWorkbenchFixture({
      id: 'exact',
      cost: 1_250_000_000,
    });
    const cost = resolveConfigurationCost(candidate.row);
    assert.deepEqual(cost, {
      kind: 'exact',
      lowerUsdNanos: 1_250_000_000,
      upperUsdNanos: 1_250_000_000,
      pricedResultCount: 72,
      resultCount: 72,
    });
    assert.equal(formatConfigurationCost(cost), '$1.25');
  });

  void it('turns aggregate long-context ambiguity into an honest published-rate range', () => {
    const candidate = configurationWorkbenchFixture({ id: 'bounded', boundedCost: true });
    const cost = resolveConfigurationCost(candidate.row);
    assert.deepEqual(cost, {
      kind: 'bounded',
      lowerUsdNanos: 3_075_000_000,
      upperUsdNanos: 5_400_000_000,
      pricedResultCount: 61,
      resultCount: 72,
    });
    assert.equal(formatConfigurationCost(cost), '$3.08–$5.40');
    assert.equal(describeConfigurationCost(cost), '61/72 task costs exact · remainder bounded');
  });

  void it('keeps genuinely missing provider usage unavailable instead of fabricating zero', () => {
    const candidate = configurationWorkbenchFixture({ id: 'missing' });
    const cost = resolveConfigurationCost(candidate.row);
    assert.equal(cost.kind, 'unavailable');
    assert.equal(formatConfigurationCost(cost), 'Unavailable');
    assert.equal(describeConfigurationCost(cost), 'Provider token usage unavailable');
  });
});
