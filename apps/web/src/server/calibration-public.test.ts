import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { PUBLIC_VIEW_NAMES, SeedAiqRepository } from '../data/repository.ts';

/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests inspect checked-in JSON as adversarial unknown records. */

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

void describe('public calibration evidence boundary', () => {
  void it('publishes separate exact schemas and one non-secret calibration fixture', () => {
    const files = [
      'calibration-run-v3.schema.json',
      'calibration-score-report-v1.schema.json',
      'calibration-verified-stage-v1.schema.json',
      'calibration-verifier-attestation-v1.schema.json',
      'calibration-result-package-v3.schema.json',
    ];
    for (const file of files) {
      const schema = readJson(`../../../../benchmarks/schema/${file}`);
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.equal(schema.additionalProperties, false);
      assert.ok(Array.isArray(schema.required));
    }
    const fixture = readJson(
      '../../../../benchmarks/fixtures/calibration-result-package-v3.example.json',
    );
    assert.equal(fixture.payload_type, 'aiq.calibration-run.v3');
    assert.equal(fixture.claimed_trust, 'untrusted');
    const payload = fixture.payload as Record<string, unknown>;
    assert.equal(payload.official_eligible, false);
    assert.equal(
      (payload.provenance as Record<string, unknown>).catalog_digest,
      'sha256:050ab6937b4e84aad0fc72a3d4489bd2d8dfe70d2bc35d196bd47b5a2cc80d4a',
    );
  });

  void it('keeps calibration public reads separate and excludes private material', async () => {
    assert.deepEqual(
      [
        PUBLIC_VIEW_NAMES.calibrationRuns,
        PUBLIC_VIEW_NAMES.calibrationResults,
        PUBLIC_VIEW_NAMES.calibrationScores,
      ],
      ['public_calibration_runs', 'public_calibration_results', 'public_calibration_scores'],
    );
    const repository = new SeedAiqRepository();
    const page = await repository.listCalibrationRunPage();
    const run = page.runs[0];
    assert.ok(run);
    assert.equal(run.official, false);
    assert.equal(run.rankingEligible, false);
    assert.equal(run.synthetic, true);
    const detail = await repository.getCalibrationRun(run.id, {
      modelFamily: 'sol',
      reasoningEffort: 'low',
    });
    const serialized = JSON.stringify(detail);
    assert.equal(detail?.results[0]?.outcome, 'correct');
    assert.equal(detail?.results[0]?.executionStatus, 'completed');
    for (const forbidden of [
      'signature',
      'package_sha256',
      'content_hash',
      'artifact',
      'response',
      'envelope',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});
