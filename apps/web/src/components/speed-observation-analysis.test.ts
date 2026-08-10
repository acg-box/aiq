import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PublicSpeedObservation } from '../data/types.ts';
import { pairedSpeedupRows } from './speed-observation-analysis.ts';

function observation(
  entryId: string,
  mode: 'normal' | 'fast',
  medianElapsedMs: number | null,
): PublicSpeedObservation {
  return {
    batchId: `speed_${'a'.repeat(64)}`,
    observedAt: '2026-08-10T12:00:00.000Z',
    entryId,
    modelFamily: 'Sol',
    reasoningTier: 'low',
    mode,
    availabilityStatus: 'available',
    availabilityReason: null,
    trialsPerMode: 5,
    attemptedTrials: 5,
    completedTrials: 5,
    invalidResponseTrials: 0,
    failedTrials: 0,
    medianElapsedMs,
    p95ElapsedMs: medianElapsedMs,
    medianAggregateOutputTps: 10,
    estimatedCredits: 1,
    estimatedCreditSampleCount: 5,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 20,
    totalTokens: 30,
    medianAgentSteps: 1,
    medianToolCallCount: 0,
    medianTtftMs: null,
    ttftStatus: 'unavailable',
    medianPostFirstTokenOutputTps: null,
    postFirstTokenOutputTpsStatus: 'unavailable',
    catalogStatus: 'available',
    codexVersion: 'codex-cli 0.147.0',
    creditRateCardVersion: 'openai-codex-rate-card-2026-08-10',
    scoringImpact: 'none',
  };
}

void describe('Normal/Fast comparison analysis', () => {
  void it('computes only complete paired duration evidence', () => {
    const rows = pairedSpeedupRows([
      observation('sol-low', 'normal', 1_000),
      observation('sol-low', 'fast', 500),
      observation('sol-medium', 'normal', 2_000),
      observation('sol-medium', 'fast', null),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.entryId, 'sol-low');
    assert.equal(rows[0]?.speedup, 2);
  });
});
