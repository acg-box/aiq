import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { canonicalJson } from './submission-contract.ts';
import {
  SPEED_CREDIT_RATE_CARD_VERSION,
  SPEED_OBSERVATION_SCHEMA_VERSION,
  validateSpeedObservation,
} from './speed-observation-contract.ts';
import { handleSpeedObservation } from './speed-observation-handler.ts';

/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests intentionally mutate adversarial JSON values. */

const token = 'runner-speed-token';

function sha(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function fixture(): Record<string, unknown> {
  const model = { family: 'luna', reasoning_effort: 'low' };
  const response = Array.from({ length: 400 }, (_, index) => index + 1).join(',');
  const prompt =
    'Return exactly the comma-separated integers from 1 through 400, inclusive, in ascending order. Use no spaces, no markdown, no commentary, and no trailing punctuation.';
  const trial = (mode: 'normal' | 'fast', suffix: string, credits: number) => ({
    trial_id: `speed_trial_${suffix.repeat(64)}`,
    observed_at: 'unix-ms:1786395600000',
    model,
    mode,
    trial_index: 0,
    status: 'completed',
    elapsed_ms: 1_000,
    ttft_ms: null,
    post_first_token_output_tps_millis: null,
    aggregate_output_tps_millis: 5_000,
    tokens: { input: 10, cached_input: 0, output: 5, total: 15 },
    tool_usage: { steps: 1, total_calls: 0, by_tool: {} },
    estimated_credits_nanos: credits,
    response_sha256: sha(response),
    artifacts: [],
    failure: null,
  });
  const identity = {
    schema_version: SPEED_OBSERVATION_SCHEMA_VERSION,
    observed_at: 'unix-ms:1786395600000',
    trials_per_mode: 1,
    prompt_sha256: sha(prompt),
    runner_executable_sha256: `sha256:${'1'.repeat(64)}`,
    codex_executable_sha256: `sha256:${'2'.repeat(64)}`,
    codex_code_mode_host_sha256: `sha256:${'3'.repeat(64)}`,
    credit_rate_card_version: SPEED_CREDIT_RATE_CARD_VERSION,
    catalog: {
      status: 'available',
      codex_version: 'codex-cli 0.147.0',
      catalog_sha256: `sha256:${'4'.repeat(64)}`,
      unavailable_reason: null,
    },
    capabilities: [
      { model, mode: 'normal', status: 'available', reason: 'live_catalog_advertised' },
      { model, mode: 'fast', status: 'available', reason: 'live_catalog_advertised' },
    ],
    unavailable_metrics: [
      {
        metric: 'ttft_ms',
        reason: 'current_codex_jsonl_has_no_first_token_timestamp',
      },
      {
        metric: 'post_first_token_output_tps_millis',
        reason: 'current_codex_jsonl_has_no_first_token_timestamp',
      },
    ],
    trials: [trial('normal', 'a', 200_000), trial('fast', 'b', 500_000)],
  };
  const contentSha256 = sha(canonicalJson(identity));
  return {
    ...identity,
    batch_id: `speed_${contentSha256.slice('sha256:'.length)}`,
    content_sha256: contentSha256,
  };
}

function request(batch: Record<string, unknown>, authorization = `Bearer ${token}`): Request {
  const bytes = Buffer.from(canonicalJson(batch), 'utf8');
  return new Request('https://aiq.wiki/api/observations/speed', {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
      'content-length': String(bytes.byteLength),
      'idempotency-key': String(batch.batch_id),
    },
    body: bytes,
  });
}

void describe('speed observation contract', () => {
  void it('accepts complete Normal/Fast auxiliary evidence and rejects cost tampering', () => {
    const valid = fixture();
    assert.equal(validateSpeedObservation(valid).ok, true);

    const tampered = structuredClone(valid);
    const trials = tampered.trials as Record<string, unknown>[];
    trials[1] = { ...trials[1], estimated_credits_nanos: 1 };
    assert.deepEqual(validateSpeedObservation(tampered), {
      ok: false,
      code: 'INVALID_SPEED_OBSERVATION',
      message: 'The Normal/Fast observation does not match the current auxiliary contract.',
    });
  });

  void it('authenticates, stores, registers, and idempotently records one canonical batch', async () => {
    const batch = fixture();
    const events: string[] = [];
    const response = await handleSpeedObservation(request(batch), {
      configured: true,
      expectedToken: token,
      async storeObservation(observation) {
        events.push('store');
        return {
          bucket: 'aiq-runner-artifacts',
          key: `sha256/${observation.storageSha256}/speed-observation.json`,
          digest: observation.storageSha256,
          bytes: observation.canonicalBytes.byteLength,
        };
      },
      async registerStoredObject() {
        events.push('register');
        return '11111111-1111-4111-8111-111111111111';
      },
      async recordObservation() {
        events.push('record');
        return 'accepted';
      },
    });

    assert.equal(response.status, 201);
    assert.deepEqual(events, ['store', 'register', 'record']);
    assert.deepEqual(await response.json(), {
      status: 'accepted',
      batch_id: batch.batch_id,
      scoring_impact: 'none',
    });
  });

  void it('rejects an invalid bearer before reading or mutating the batch', async () => {
    const response = await handleSpeedObservation(request(fixture(), 'Bearer wrong'), {
      configured: true,
      expectedToken: token,
      async storeObservation() {
        throw new Error('must not run');
      },
      async registerStoredObject() {
        throw new Error('must not run');
      },
      async recordObservation() {
        throw new Error('must not run');
      },
    });

    assert.equal(response.status, 401);
  });
});
