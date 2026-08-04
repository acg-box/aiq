import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  AIQ_CORE_CATALOG_RELEASE_IDENTITY,
  AIQ_CORE_RELEASE_IDENTITY,
  AIQ_CORE_SCORING_VERSION,
  AIQ_CORE_TASK_METADATA_IDENTITY,
  AIQ_CORE_TASK_SET_VERSION,
} from './aiq-core-contract.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), label);
  return value;
}

void describe('AIQ Core source-head contract', () => {
  void it('matches the checked-in active public catalog', () => {
    const parsed: unknown = JSON.parse(
      readFileSync(
        new URL('../../../benchmarks/candidates/aiq-core-1.0.3/catalog.json', import.meta.url),
        'utf8',
      ),
    );
    const catalog = record(parsed, 'catalog must be an object');
    const taskIdentity = record(
      catalog.task_metadata_identity,
      'task metadata identity must be an object',
    );
    const releaseIdentity = record(
      catalog.catalog_release_identity,
      'catalog release identity must be an object',
    );

    assert.equal(catalog.task_set_version, AIQ_CORE_TASK_SET_VERSION);
    assert.equal(catalog.scoring_version, AIQ_CORE_SCORING_VERSION);
    assert.equal(taskIdentity.digest, AIQ_CORE_TASK_METADATA_IDENTITY);
    assert.equal(releaseIdentity.release_identity, AIQ_CORE_RELEASE_IDENTITY);
    assert.equal(releaseIdentity.digest, AIQ_CORE_CATALOG_RELEASE_IDENTITY);
  });
});
