import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readContinuousObservationConfiguration,
  surroundingScheduledSlots,
} from './continuous-observation.ts';

void test('UTC schedule selects one exact 03:00 or 15:00 slot and the next 12-hour slot', () => {
  const beforeNight = surroundingScheduledSlots(new Date('2026-08-10T02:59:59.999Z'));
  assert.equal(beforeNight.latest.id, '2026-08-09T15-00Z');
  assert.equal(beforeNight.next.id, '2026-08-10T03-00Z');

  const atNight = surroundingScheduledSlots(new Date('2026-08-10T03:00:00.000Z'));
  assert.deepEqual(atNight.latest, {
    id: '2026-08-10T03-00Z',
    slotDate: '2026-08-10',
    occurrence: 'night',
    observedAt: 'unix-ms:1786330800000',
    timestampMs: 1_786_330_800_000,
  });
  assert.equal(atNight.next.id, '2026-08-10T15-00Z');

  const afterDay = surroundingScheduledSlots(new Date('2026-08-10T20:00:00.000Z'));
  assert.equal(afterDay.latest.id, '2026-08-10T15-00Z');
  assert.equal(afterDay.next.id, '2026-08-11T03-00Z');
  assert.equal(afterDay.next.timestampMs - afterDay.latest.timestampMs, 12 * 60 * 60 * 1000);
});

void test('configuration is exact, absolute, bounded, and contains no secret values', () => {
  const root = mkdtempSync(join(tmpdir(), 'aiq-continuous-config-'));
  const inputs = join(root, 'inputs');
  mkdirSync(inputs);
  const path = join(root, 'config.json');
  const document = {
    schema_version: 'aiq.continuous-observation-config.v1',
    release_root: inputs,
    source_root: inputs,
    observer_runner: join(inputs, 'runner'),
    state_root: join(root, 'state'),
    codex_auth_source: join(inputs, 'auth.json'),
    endpoint: 'https://aiq.wiki',
    official_jobs: 32,
    verifier_replay_jobs: 32,
    speed_jobs: 4,
    speed_trials: 5,
    production_reference_sha256: `sha256:${'a'.repeat(64)}`,
    build_receipt_sha256: `sha256:${'b'.repeat(64)}`,
  };
  writeFileSync(path, JSON.stringify(document));
  assert.deepEqual(readContinuousObservationConfiguration(path), document);
  writeFileSync(path, JSON.stringify({ ...document, endpoint: 'http://aiq.wiki' }));
  assert.throws(() => readContinuousObservationConfiguration(path), /HTTPS/);
  writeFileSync(path, JSON.stringify({ ...document, speed_trials: 11 }));
  assert.throws(() => readContinuousObservationConfiguration(path), /between 1 and 10/);
});
