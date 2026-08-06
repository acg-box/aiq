/* oxlint-disable typescript/no-base-to-string, typescript/no-unsafe-type-assertion -- Test doubles receive standard fetch URL/body values. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readLifecycleConfiguration,
  runDeletion,
  runLifecycle,
  runReconciliation,
  type LifecycleConfiguration,
} from './storage-object-lifecycle.ts';

const packageDigest = 'a'.repeat(64);
const missingDigest = 'b'.repeat(64);
const artifactDigest = 'c'.repeat(64);
const objectId = '11111111-1111-4111-8111-111111111111';
const leaseToken = '22222222-2222-4222-8222-222222222222';

const environment = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_service_role_key_that_is_long_enough',
  AIQ_SUBMISSION_PACKAGE_BUCKET: 'aiq-submission-packages',
  AIQ_RUNNER_ARTIFACT_BUCKET: 'aiq-runner-artifacts',
  AIQ_STORAGE_LIFECYCLE_MODE: 'delete',
};

function configuration(overrides: Partial<LifecycleConfiguration> = {}): LifecycleConfiguration {
  return { ...readLifecycleConfiguration(environment), ...overrides };
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

void test('configuration requires the two canonical private buckets and bounded worker settings', () => {
  assert.equal(readLifecycleConfiguration(environment).mode, 'delete');
  assert.throws(
    () =>
      readLifecycleConfiguration({
        ...environment,
        AIQ_STORAGE_LIFECYCLE_MODE: undefined,
      }),
    /must be set explicitly/,
  );
  assert.equal(
    readLifecycleConfiguration({
      ...environment,
      AIQ_STORAGE_LIFECYCLE_MODE: 'reconcile',
    }).mode,
    'reconcile',
  );
  assert.throws(
    () =>
      readLifecycleConfiguration({
        ...environment,
        SUPABASE_URL: 'https://user:pass@example.com/path',
      }),
    /origin/,
  );
  assert.throws(
    () =>
      readLifecycleConfiguration({
        ...environment,
        AIQ_RUNNER_ARTIFACT_BUCKET: 'aiq-submission-packages',
      }),
    /must be aiq-runner-artifacts/,
  );
  assert.throws(
    () =>
      readLifecycleConfiguration({
        ...environment,
        AIQ_SUBMISSION_PACKAGE_BUCKET: 'unrelated-private-bucket',
      }),
    /must be aiq-submission-packages/,
  );
  assert.throws(
    () => readLifecycleConfiguration({ ...environment, AIQ_STORAGE_LIFECYCLE_BATCH_SIZE: '101' }),
    /out of range/,
  );
  assert.throws(
    () => readLifecycleConfiguration({ ...environment, SUPABASE_URL: 'http://attacker.invalid' }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      readLifecycleConfiguration({
        ...environment,
        SUPABASE_SECRET_KEY: 'publishable-key-that-is-long-enough',
      }),
    /secret key/,
  );
  assert.equal(
    readLifecycleConfiguration({
      ...environment,
      SUPABASE_URL: 'http://127.0.0.1:54321',
      AIQ_STORAGE_ALLOW_INSECURE_LOOPBACK: 'true',
    }).origin,
    'http://127.0.0.1:54321',
  );
});

void test('missing lifecycle mode fails before any network request', async () => {
  let requests = 0;
  const fetchImplementation: typeof fetch = async () => {
    requests += 1;
    return response([]);
  };

  await assert.rejects(
    runLifecycle(
      {
        ...environment,
        AIQ_STORAGE_LIFECYCLE_MODE: undefined,
      },
      fetchImplementation,
    ),
    /must be set explicitly/,
  );
  assert.equal(requests, 0);
});

void test('deletion acknowledges success and idempotent not-found without exposing identity', async () => {
  const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const storageCalls: string[] = [];
  const claims = [
    {
      object_id: objectId,
      object_type: 'submission_package',
      artifact_kind: null,
      bucket_name: 'aiq-submission-packages',
      object_path: `sha256/${packageDigest}`,
      content_sha256: packageDigest,
      byte_size: 12,
      lease_token: leaseToken,
      lease_expires_at: '2026-07-26T12:05:00Z',
      attempt: 1,
    },
    {
      object_id: '33333333-3333-4333-8333-333333333333',
      object_type: 'runner_artifact',
      artifact_kind: 'stderr.txt',
      bucket_name: 'aiq-runner-artifacts',
      object_path: `sha256/${artifactDigest}/stderr.txt`,
      content_sha256: artifactDigest,
      byte_size: 4,
      lease_token: '44444444-4444-4444-8444-444444444444',
      lease_expires_at: '2026-07-26T12:05:00Z',
      attempt: 2,
    },
  ];
  let claimIndex = 0;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    assert.ok(init?.signal instanceof AbortSignal);
    if (url.pathname.endsWith('/rpc/aiq_claim_storage_deletions')) {
      assert.equal(body.max_rows, 1);
      const claim = claims[claimIndex];
      claimIndex += 1;
      return response(claim ? [claim] : []);
    }
    if (url.pathname.includes('/storage/v1/object/')) {
      storageCalls.push(url.pathname);
      return new Response('', { status: storageCalls.length === 1 ? 200 : 404 });
    }
    const name = url.pathname.split('/').at(-1) ?? '';
    rpcCalls.push({ name, body });
    return response('acknowledged');
  };
  const metrics = await runDeletion(configuration(), fetchImplementation);
  assert.deepEqual(metrics, {
    event: 'aiq_storage_lifecycle',
    claimed: 2,
    deleted: 1,
    not_found: 1,
    retried: 0,
    rejected: 0,
  });
  assert.deepEqual(
    rpcCalls.map((call) => call.name),
    ['aiq_ack_storage_deletion', 'aiq_ack_storage_deletion'],
  );
  assert.deepEqual(
    rpcCalls.map((call) => call.body.supplied_outcome),
    ['deleted', 'not_found'],
  );
  assert.ok(!JSON.stringify(metrics).includes('service-role-key'));
});

void test('deletion accepts the registered evaluator results artifact kind', async () => {
  let claimed = false;
  let deleteCalls = 0;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/aiq_claim_storage_deletions')) {
      if (claimed) return response([]);
      claimed = true;
      return response([
        {
          object_id: objectId,
          object_type: 'runner_artifact',
          artifact_kind: 'evaluator-results.json',
          bucket_name: 'aiq-runner-artifacts',
          object_path: `sha256/${artifactDigest}/evaluator-results.json`,
          content_sha256: artifactDigest,
          byte_size: 128,
          lease_token: leaseToken,
          lease_expires_at: '2026-07-26T12:05:00Z',
          attempt: 1,
        },
      ]);
    }
    if (url.pathname.includes('/storage/v1/object/')) {
      deleteCalls += 1;
      return new Response('', { status: 200 });
    }
    assert.ok(url.pathname.endsWith('/rpc/aiq_ack_storage_deletion'));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    assert.equal(body.supplied_outcome, 'deleted');
    return response('acknowledged');
  };

  const metrics = await runDeletion(configuration(), fetchImplementation);
  assert.equal(deleteCalls, 1);
  assert.deepEqual(metrics, {
    event: 'aiq_storage_lifecycle',
    claimed: 1,
    deleted: 1,
    not_found: 0,
    retried: 0,
    rejected: 0,
  });
});

void test('deletion rejects out-of-allowlist claims and records bounded retry state', async () => {
  const calls: string[] = [];
  let claimed = false;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_claim_storage_deletions')) {
      if (claimed) return response([]);
      claimed = true;
      return response([
        {
          object_id: objectId,
          object_type: 'submission_package',
          artifact_kind: null,
          bucket_name: 'aiq-runner-artifacts',
          object_path: `sha256/${packageDigest}`,
          content_sha256: packageDigest,
          byte_size: 12,
          lease_token: leaseToken,
          lease_expires_at: '2026-07-26T12:05:00Z',
          attempt: 1,
        },
      ]);
    }
    calls.push(url.pathname);
    assert.equal(body.supplied_error_code, 'object_outside_allowlist');
    return response('2026-07-26T12:01:00Z');
  };
  const metrics = await runDeletion(configuration(), fetchImplementation);
  assert.equal(metrics.rejected, 1);
  assert.deepEqual(calls, ['/rest/v1/rpc/aiq_retry_storage_deletion']);
});

void test('deletion converts upstream failures to sanitized durable retry codes', async () => {
  const errors: unknown[] = [];
  let claimed = false;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_claim_storage_deletions')) {
      if (claimed) return response([]);
      claimed = true;
      return response([
        {
          object_id: objectId,
          object_type: 'submission_package',
          artifact_kind: null,
          bucket_name: 'aiq-submission-packages',
          object_path: `sha256/${packageDigest}`,
          content_sha256: packageDigest,
          byte_size: 12,
          lease_token: leaseToken,
          lease_expires_at: '2026-07-26T12:05:00Z',
          attempt: 1,
        },
      ]);
    }
    if (url.pathname.includes('/storage/v1/object/'))
      return new Response('secret upstream body', { status: 503 });
    errors.push(body.supplied_error_code);
    return response('2026-07-26T12:01:00Z');
  };
  const metrics = await runDeletion(configuration(), fetchImplementation);
  assert.equal(metrics.retried, 1);
  assert.deepEqual(errors, ['storage_delete_503']);
});

void test('deletion claims each object only after the prior lease is acknowledged', async () => {
  const sequence: string[] = [];
  let claimCount = 0;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_claim_storage_deletions')) {
      sequence.push(`claim:${String(claimCount + 1)}`);
      assert.equal(body.max_rows, 1);
      const digest = claimCount === 0 ? packageDigest : missingDigest;
      const claim = {
        object_id: claimCount === 0 ? objectId : '33333333-3333-4333-8333-333333333333',
        object_type: 'submission_package',
        artifact_kind: null,
        bucket_name: 'aiq-submission-packages',
        object_path: `sha256/${digest}`,
        content_sha256: digest,
        byte_size: 12,
        lease_token: claimCount === 0 ? leaseToken : '44444444-4444-4444-8444-444444444444',
        lease_expires_at: `2026-07-26T12:0${String(claimCount + 1)}:00Z`,
        attempt: 1,
      };
      claimCount += 1;
      return response([claim]);
    }
    if (url.pathname.includes('/storage/v1/object/')) {
      sequence.push(`delete:${String(claimCount)}`);
      return new Response('', { status: 200 });
    }
    if (url.pathname.endsWith('/rpc/aiq_ack_storage_deletion')) {
      sequence.push(`ack:${String(claimCount)}`);
      return response('acknowledged');
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };

  const metrics = await runDeletion(configuration({ batchSize: 2 }), fetchImplementation);
  assert.deepEqual(sequence, ['claim:1', 'delete:1', 'ack:1', 'claim:2', 'delete:2', 'ack:2']);
  assert.equal(metrics.claimed, 2);
  assert.equal(metrics.deleted, 2);
});

void test('deletion repeats the exact acknowledgement after its committed response is lost', async () => {
  let claimPending = true;
  let acknowledgementCommitted = false;
  const acknowledgements: Array<Record<string, unknown>> = [];
  let retryCalls = 0;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_claim_storage_deletions')) {
      if (!claimPending) return response([]);
      claimPending = false;
      return response([
        {
          object_id: objectId,
          object_type: 'submission_package',
          artifact_kind: null,
          bucket_name: 'aiq-submission-packages',
          object_path: `sha256/${packageDigest}`,
          content_sha256: packageDigest,
          byte_size: 12,
          lease_token: leaseToken,
          lease_expires_at: '2026-07-26T12:05:00Z',
          attempt: 1,
        },
      ]);
    }
    if (url.pathname.includes('/storage/v1/object/')) return new Response('', { status: 200 });
    if (url.pathname.endsWith('/rpc/aiq_ack_storage_deletion')) {
      acknowledgements.push(body);
      if (!acknowledgementCommitted) {
        acknowledgementCommitted = true;
        throw new Error('response_lost_after_commit');
      }
      return response('idempotent');
    }
    if (url.pathname.endsWith('/rpc/aiq_retry_storage_deletion')) {
      retryCalls += 1;
      return response('2026-07-26T12:01:00Z');
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };

  const metrics = await runDeletion(configuration(), fetchImplementation);
  assert.equal(metrics.deleted, 1);
  assert.equal(metrics.retried, 0);
  assert.equal(retryCalls, 0);
  assert.equal(acknowledgements.length, 2);
  assert.deepEqual(acknowledgements[0], acknowledgements[1]);
});

void test('deletion returns the claim to retry only after both exact acknowledgements fail', async () => {
  let claimPending = true;
  let acknowledgementCalls = 0;
  const retryCodes: unknown[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_claim_storage_deletions')) {
      if (!claimPending) return response([]);
      claimPending = false;
      return response([
        {
          object_id: objectId,
          object_type: 'submission_package',
          artifact_kind: null,
          bucket_name: 'aiq-submission-packages',
          object_path: `sha256/${packageDigest}`,
          content_sha256: packageDigest,
          byte_size: 12,
          lease_token: leaseToken,
          lease_expires_at: '2026-07-26T12:05:00Z',
          attempt: 1,
        },
      ]);
    }
    if (url.pathname.includes('/storage/v1/object/')) return new Response('', { status: 200 });
    if (url.pathname.endsWith('/rpc/aiq_ack_storage_deletion')) {
      acknowledgementCalls += 1;
      return response({ error: 'private detail' }, 503);
    }
    if (url.pathname.endsWith('/rpc/aiq_retry_storage_deletion')) {
      retryCodes.push(body.supplied_error_code);
      return response('2026-07-26T12:01:00Z');
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };

  const metrics = await runDeletion(configuration(), fetchImplementation);
  assert.equal(acknowledgementCalls, 2);
  assert.deepEqual(retryCodes, ['rpc_aiq_ack_storage_deletion_503']);
  assert.equal(metrics.deleted, 0);
  assert.equal(metrics.retried, 1);
});

void test('reconciliation records storage-only grace, registry-only, and identity mismatches without deleting', async () => {
  const mismatches: Array<Record<string, unknown>> = [];
  let deleteCalls = 0;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (init?.method === 'DELETE') {
      deleteCalls += 1;
      return response([]);
    }
    if (url.pathname.endsWith('/rpc/aiq_list_storage_registry')) {
      if (body.supplied_bucket === 'aiq-submission-packages') {
        return response([
          {
            object_id: objectId,
            object_path: `sha256/${missingDigest}`,
            content_sha256: missingDigest,
            byte_size: 9,
            lifecycle_state: 'active',
            legal_hold: true,
            active_references: 1,
          },
        ]);
      }
      return response([
        {
          object_id: '33333333-3333-4333-8333-333333333333',
          object_path: `sha256/${artifactDigest}/stderr.txt`,
          content_sha256: artifactDigest,
          byte_size: 3,
          lifecycle_state: 'active',
          legal_hold: false,
          active_references: 0,
        },
      ]);
    }
    if (url.pathname.endsWith('/rpc/aiq_list_storage_reconciliation')) return response([]);
    if (url.pathname.endsWith('/rpc/aiq_record_storage_reconciliation')) {
      mismatches.push(body);
      return response('55555555-5555-4555-8555-555555555555');
    }
    if (url.pathname.endsWith('/rpc/aiq_promote_storage_orphan')) {
      assert.deepEqual(body, {
        supplied_object_type: 'submission_package',
        supplied_artifact_kind: null,
        supplied_bucket: 'aiq-submission-packages',
        supplied_path: `sha256/${packageDigest}`,
        supplied_sha256: packageDigest,
        supplied_bytes: 12,
      });
      return response('66666666-6666-4666-8666-666666666666');
    }
    if (url.pathname.includes('/storage/v1/object/list/aiq-submission-packages')) {
      if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
      return response([
        {
          name: packageDigest,
          id: 'file',
          created_at: '2026-07-25T00:00:00Z',
          metadata: { size: 12 },
        },
      ]);
    }
    if (url.pathname.includes('/storage/v1/object/list/aiq-runner-artifacts')) {
      if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
      if (body.prefix === 'sha256') return response([{ name: artifactDigest, id: null }]);
      return response([
        {
          name: 'stderr.txt',
          id: 'file',
          created_at: '2026-07-25T00:00:00Z',
          metadata: { size: 4 },
        },
      ]);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const metrics = await runReconciliation(
    configuration({ mode: 'reconcile', graceSeconds: 3600 }),
    fetchImplementation,
    new Date('2026-07-26T00:00:00Z'),
  );
  assert.deepEqual(metrics, {
    event: 'aiq_storage_reconciliation',
    storage_only: 1,
    promoted: 1,
    registry_only: 1,
    identity_mismatch: 1,
    resolved: 0,
  });
  assert.equal(deleteCalls, 0);
  assert.deepEqual(
    mismatches
      .map((item) => item.supplied_mismatch_type)
      .toSorted((left, right) => String(left).localeCompare(String(right))),
    ['identity_mismatch', 'registry_only', 'storage_only'],
  );
  const storageOnly = mismatches.find((item) => item.supplied_mismatch_type === 'storage_only');
  assert.equal(storageOnly?.supplied_eligible_after, '2026-07-25T01:00:00.000Z');
});

void test('reconciliation rejects file and directory type confusion', async () => {
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_list_storage_registry')) return response([]);
    if (url.pathname.endsWith('/rpc/aiq_list_storage_reconciliation')) return response([]);
    if (url.pathname.includes('/storage/v1/object/list/aiq-submission-packages')) {
      if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
      return response([{ name: packageDigest, id: null, metadata: { size: 12 } }]);
    }
    if (url.pathname.includes('/storage/v1/object/list/aiq-runner-artifacts')) {
      if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
      return response([]);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  await assert.rejects(
    runReconciliation(configuration({ mode: 'reconcile' }), fetchImplementation),
    /package bucket contains a noncanonical object/,
  );
});

void test('reconciliation requires artifact digest directories and artifact files', async () => {
  for (const testCase of [
    { digestId: 'file', childId: 'file', error: /artifact digest entry must be a directory/ },
    { digestId: null, childId: null, error: /noncanonical artifact kind/ },
  ]) {
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (url.pathname.endsWith('/rpc/aiq_list_storage_registry')) return response([]);
      if (url.pathname.endsWith('/rpc/aiq_list_storage_reconciliation')) return response([]);
      if (url.pathname.includes('/storage/v1/object/list/aiq-submission-packages')) {
        if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
        return response([]);
      }
      if (url.pathname.includes('/storage/v1/object/list/aiq-runner-artifacts')) {
        if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
        if (body.prefix === 'sha256')
          return response([{ name: artifactDigest, id: testCase.digestId }]);
        return response([{ name: 'stderr.txt', id: testCase.childId, metadata: { size: 4 } }]);
      }
      throw new Error(`unexpected request ${url.pathname}`);
    };
    // oxlint-disable-next-line no-await-in-loop -- Each shape case has an isolated inventory.
    await assert.rejects(
      runReconciliation(configuration({ mode: 'reconcile' }), fetchImplementation),
      testCase.error,
    );
  }
});

void test('reconciliation fails closed on unexpected bucket paths', async () => {
  let durableWrites = 0;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_list_storage_registry')) return response([]);
    if (url.pathname.endsWith('/rpc/aiq_list_storage_reconciliation')) return response([]);
    if (url.pathname.endsWith('/rpc/aiq_record_storage_reconciliation')) {
      durableWrites += 1;
      return response('55555555-5555-4555-8555-555555555555');
    }
    if (
      url.pathname.includes('/storage/v1/object/list/aiq-submission-packages') &&
      body.prefix === ''
    ) {
      return response([{ name: 'unexpected', id: 'file' }]);
    }
    if (
      url.pathname.includes('/storage/v1/object/list/aiq-runner-artifacts') &&
      body.prefix === ''
    ) {
      return response([{ name: 'sha256', id: null }]);
    }
    if (url.pathname.includes('/storage/v1/object/list/aiq-runner-artifacts')) return response([]);
    throw new Error(`unexpected request ${url.pathname}`);
  };
  await assert.rejects(
    runReconciliation(configuration({ mode: 'reconcile' }), fetchImplementation),
    /unexpected top-level entry/,
  );
  assert.equal(durableWrites, 0);
});

void test('reconciliation resolves stale events after exact parity returns', async () => {
  const resolved: Array<Record<string, unknown>> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_list_storage_registry')) {
      return body.supplied_bucket === 'aiq-submission-packages'
        ? response([
            {
              object_id: objectId,
              object_path: `sha256/${packageDigest}`,
              content_sha256: packageDigest,
              byte_size: 12,
              lifecycle_state: 'active',
              legal_hold: false,
              active_references: 0,
            },
          ])
        : response([]);
    }
    if (url.pathname.endsWith('/rpc/aiq_list_storage_reconciliation')) return response([]);
    if (url.pathname.endsWith('/rpc/aiq_resolve_storage_reconciliation')) {
      resolved.push(body);
      return response(1);
    }
    if (url.pathname.includes('/storage/v1/object/list/aiq-submission-packages')) {
      if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
      return response([{ name: packageDigest, id: 'file', metadata: { size: 12 } }]);
    }
    if (url.pathname.includes('/storage/v1/object/list/aiq-runner-artifacts')) {
      if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
      return response([]);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const metrics = await runReconciliation(
    configuration({ mode: 'reconcile' }),
    fetchImplementation,
  );
  assert.equal(metrics.storage_only, 0);
  assert.equal(metrics.promoted, 0);
  assert.equal(metrics.resolved, 1);
  assert.deepEqual(resolved, [
    {
      supplied_bucket: 'aiq-submission-packages',
      supplied_path: `sha256/${packageDigest}`,
    },
  ]);
});

void test('reconciliation resolves events after both sides disappear or deletion is durable', async () => {
  const absentDigest = 'd'.repeat(64);
  const deletedDigest = 'e'.repeat(64);
  const resolvedPaths: string[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/rpc/aiq_list_storage_registry')) {
      return body.supplied_bucket === 'aiq-submission-packages'
        ? response([
            {
              object_id: objectId,
              object_path: `sha256/${deletedDigest}`,
              content_sha256: deletedDigest,
              byte_size: 12,
              lifecycle_state: 'deleted',
              legal_hold: false,
              active_references: 0,
            },
          ])
        : response([]);
    }
    if (url.pathname.endsWith('/rpc/aiq_list_storage_reconciliation')) {
      return body.supplied_bucket === 'aiq-submission-packages'
        ? response([
            { object_path: `sha256/${absentDigest}`, mismatch_type: 'storage_only' },
            { object_path: `sha256/${deletedDigest}`, mismatch_type: 'identity_mismatch' },
          ])
        : response([]);
    }
    if (url.pathname.endsWith('/rpc/aiq_resolve_storage_reconciliation')) {
      resolvedPaths.push(String(body.supplied_path));
      return response(1);
    }
    if (url.pathname.includes('/storage/v1/object/list/')) {
      if (body.prefix === '') return response([{ name: 'sha256', id: null }]);
      return response([]);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const metrics = await runReconciliation(
    configuration({ mode: 'reconcile' }),
    fetchImplementation,
  );
  assert.equal(metrics.resolved, 2);
  assert.deepEqual(resolvedPaths.toSorted(), [`sha256/${absentDigest}`, `sha256/${deletedDigest}`]);
});
