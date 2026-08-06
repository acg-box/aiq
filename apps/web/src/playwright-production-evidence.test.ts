import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ProductionEfficiencyEvidence,
  productionPageEvidenceExpectation,
  validateProductionEfficiencyEvidence,
  validateProductionPageEvidence,
  validateProductionTaskCostEvidence,
} from '../playwright-production-evidence.ts';

const covered = (count: number) => ({
  valueAvailable: true,
  coverageCount: count,
  coveragePercent: Number(((100 * count) / 72).toFixed(1)),
});
const unavailable = {
  valueAvailable: false,
  coverageCount: null,
  coveragePercent: null,
};

function evidence(
  overrides: Partial<ProductionEfficiencyEvidence> = {},
): ProductionEfficiencyEvidence {
  return {
    resultCount: 72,
    attemptedCount: 72,
    invokedCount: 72,
    elapsedObservedCount: 72,
    durationEvidenceLevel: 'runner-observed',
    tokenObservedCount: 72,
    tokenEvidenceLevel: 'verifier-recomputed',
    tokenCategories: [...Array.from({ length: 5 }, () => covered(72)), unavailable],
    pricedCount: 72,
    costStatus: 'estimated',
    costUsd: 12.3456,
    costEvidenceLevel: 'verifier-recomputed',
    ...overrides,
  };
}

const publishedPageEvidence = (label: string) => ({ label, state: 'Published evidence' });
const emptyPageEvidence = (label: string) => ({ label, state: 'No published evidence' });

void describe('production efficiency evidence', () => {
  void it('accepts complete, partial, and unavailable evidence', () => {
    assert.doesNotThrow(() => validateProductionEfficiencyEvidence(evidence()));
    assert.doesNotThrow(() =>
      validateProductionEfficiencyEvidence(
        evidence({
          tokenObservedCount: 36,
          tokenCategories: Array.from({ length: 6 }, () => covered(36)),
          pricedCount: 0,
          costStatus: 'unavailable-missing-usage',
          costUsd: null,
          costEvidenceLevel: null,
        }),
      ),
    );
    assert.doesNotThrow(() =>
      validateProductionEfficiencyEvidence(
        evidence({
          tokenCategories: [
            ...Array.from({ length: 4 }, () => covered(72)),
            unavailable,
            unavailable,
          ],
        }),
      ),
    );
    assert.doesNotThrow(() =>
      validateProductionEfficiencyEvidence(
        evidence({
          costStatus: 'unavailable-context-band',
          costUsd: null,
          costEvidenceLevel: null,
        }),
      ),
    );
    assert.doesNotThrow(() =>
      validateProductionEfficiencyEvidence(
        evidence({
          elapsedObservedCount: 0,
          durationEvidenceLevel: null,
          tokenObservedCount: 0,
          tokenEvidenceLevel: null,
          tokenCategories: Array.from({ length: 6 }, () => unavailable),
          pricedCount: 0,
          costStatus: 'unavailable-missing-usage',
          costUsd: null,
          costEvidenceLevel: null,
        }),
      ),
    );
  });

  void it('rejects negative, incoherent, and malformed evidence', () => {
    for (const invalid of [
      evidence({ invokedCount: 73 }),
      evidence({ elapsedObservedCount: -1 }),
      evidence({
        tokenObservedCount: 36,
        tokenCategories: [covered(37), ...Array.from({ length: 5 }, () => covered(36))],
      }),
      evidence({
        tokenCategories: [unavailable, ...Array.from({ length: 5 }, () => covered(72))],
      }),
      evidence({ costUsd: -0.01 }),
      evidence({ pricedCount: 71 }),
      evidence({
        tokenCategories: [
          covered(71),
          ...Array.from({ length: 3 }, () => covered(72)),
          unavailable,
          unavailable,
        ],
      }),
      evidence({ costStatus: 'unavailable-missing-usage', costUsd: null }),
      evidence({ tokenEvidenceLevel: null }),
    ]) {
      assert.throws(
        () => validateProductionEfficiencyEvidence(invalid),
        /Invalid production efficiency evidence/,
      );
    }
  });

  void it('requires all four pricing inputs for an estimated aggregate', () => {
    for (let pricingInputIndex = 0; pricingInputIndex < 4; pricingInputIndex += 1) {
      const tokenCategories = [
        ...Array.from({ length: 4 }, () => covered(72)),
        unavailable,
        unavailable,
      ];
      tokenCategories[pricingInputIndex] = unavailable;
      assert.throws(
        () => validateProductionEfficiencyEvidence(evidence({ tokenCategories })),
        /Invalid production efficiency evidence/,
      );
    }
  });

  void it('enforces per-task cost and evidence relationships', () => {
    for (const valid of [
      {
        costStatus: 'estimated',
        costUsdNanos: 650_000,
        tokenEvidenceLevel: 'verifier-recomputed',
        costEvidenceLevel: 'verifier-recomputed',
      },
      {
        costStatus: 'unavailable-context-band',
        costUsdNanos: null,
        tokenEvidenceLevel: 'verifier-recomputed',
        costEvidenceLevel: null,
      },
      {
        costStatus: 'unavailable-missing-usage',
        costUsdNanos: null,
        tokenEvidenceLevel: null,
        costEvidenceLevel: null,
      },
    ]) {
      assert.doesNotThrow(() => validateProductionTaskCostEvidence(valid));
    }

    for (const invalid of [
      {
        costStatus: 'estimated',
        costUsdNanos: 650_000,
        tokenEvidenceLevel: null,
        costEvidenceLevel: null,
      },
      {
        costStatus: 'unavailable-context-band',
        costUsdNanos: null,
        tokenEvidenceLevel: 'verifier-recomputed',
        costEvidenceLevel: 'verifier-recomputed',
      },
      {
        costStatus: 'unavailable-missing-usage',
        costUsdNanos: 0,
        tokenEvidenceLevel: null,
        costEvidenceLevel: null,
      },
      {
        costStatus: 'unavailable-missing-usage',
        costUsdNanos: null,
        tokenEvidenceLevel: 'verifier-recomputed',
        costEvidenceLevel: null,
      },
    ]) {
      assert.throws(
        () => validateProductionTaskCostEvidence(invalid),
        /Invalid production efficiency evidence/,
      );
    }
  });
});

void describe('production page evidence', () => {
  void it('requires every embedded one-page evidence section and allows only Calibration empty', () => {
    const expectation = productionPageEvidenceExpectation('/');
    assert.doesNotThrow(() =>
      validateProductionPageEvidence(
        [
          publishedPageEvidence('Data provenance'),
          publishedPageEvidence('Official efficiency provenance'),
          publishedPageEvidence('Run archive provenance'),
          publishedPageEvidence('Comparison matrix provenance'),
          publishedPageEvidence('Benchmark method provenance'),
          publishedPageEvidence('Runner network provenance'),
          emptyPageEvidence('Calibration status'),
        ],
        expectation,
      ),
    );
    assert.throws(
      () =>
        validateProductionPageEvidence(
          [
            publishedPageEvidence('Data provenance'),
            publishedPageEvidence('Official efficiency provenance'),
            publishedPageEvidence('Run archive provenance'),
            publishedPageEvidence('Comparison matrix provenance'),
            publishedPageEvidence('Benchmark method provenance'),
            publishedPageEvidence('Runner network provenance'),
            emptyPageEvidence('Official efficiency status'),
          ],
          expectation,
        ),
      /Official efficiency status must not be empty/,
    );
  });

  void it('rejects unavailable, synthetic, or mixed secondary evidence', () => {
    const expectation = productionPageEvidenceExpectation('/');
    for (const note of [
      { label: 'Calibration status', state: 'Published evidence unavailable' },
      { label: 'Calibration provenance', state: 'Synthetic / seed data' },
      { label: 'Calibration provenance', state: 'Mixed evidence' },
    ]) {
      assert.throws(
        () =>
          validateProductionPageEvidence(
            [
              publishedPageEvidence('Data provenance'),
              publishedPageEvidence('Official efficiency provenance'),
              publishedPageEvidence('Run archive provenance'),
              publishedPageEvidence('Comparison matrix provenance'),
              publishedPageEvidence('Benchmark method provenance'),
              publishedPageEvidence('Runner network provenance'),
              note,
            ],
            expectation,
          ),
        /Invalid production page evidence/,
      );
    }
  });

  void it('requires run-detail Official efficiency to be published', () => {
    const expectation = productionPageEvidenceExpectation(`/runs/run_${'1'.repeat(64)}`);
    assert.doesNotThrow(() =>
      validateProductionPageEvidence(
        [
          publishedPageEvidence('Data provenance'),
          publishedPageEvidence('Official run efficiency provenance'),
        ],
        expectation,
      ),
    );
    for (const state of ['No published evidence', 'Published evidence unavailable']) {
      assert.throws(
        () =>
          validateProductionPageEvidence(
            [
              publishedPageEvidence('Data provenance'),
              { label: 'Official run efficiency status', state },
            ],
            expectation,
          ),
        /Invalid production page evidence/,
      );
    }
  });

  void it('requires every Official Trends evidence subject to be published', () => {
    const expectation = productionPageEvidenceExpectation('/trends?range=all');
    assert.doesNotThrow(() =>
      validateProductionPageEvidence(
        [
          publishedPageEvidence('Matrix entries provenance'),
          publishedPageEvidence('Trend points provenance'),
          publishedPageEvidence('Historical efficiency provenance'),
        ],
        expectation,
      ),
    );
    assert.throws(
      () =>
        validateProductionPageEvidence(
          [
            publishedPageEvidence('Matrix entries provenance'),
            { label: 'Trend points status', state: 'Published evidence unavailable' },
            emptyPageEvidence('Historical efficiency status'),
          ],
          expectation,
        ),
      /Invalid production page evidence/,
    );
  });

  void it('allows the separate calibration register to be explicitly empty', () => {
    const expectation = productionPageEvidenceExpectation('/calibrations');
    assert.doesNotThrow(() =>
      validateProductionPageEvidence(
        [emptyPageEvidence('Calibration register status')],
        expectation,
      ),
    );
  });
});
