import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  registerStorageObject,
  type StorageLifecycleObject,
  type StorageRegistrationRpc,
  type StorageRegistrationRpcArguments,
} from './storage-lifecycle-registration.ts';

/* oxlint-disable typescript/no-unsafe-type-assertion -- One case deliberately crosses the typed boundary to verify runtime rejection. */

const digest = 'a'.repeat(64);
const objectId = '123e4567-e89b-42d3-a456-426614174000';
const fixedNow = new Date('2026-07-26T12:34:56.789Z');

function rpc(
  observed: Array<{
    functionName: string;
    parameters: StorageRegistrationRpcArguments;
  }>,
  result: Readonly<{ data: unknown; error: unknown }> = { data: objectId, error: null },
): StorageRegistrationRpc {
  return async (functionName, parameters) => {
    observed.push({ functionName, parameters });
    return result;
  };
}

void describe('Storage lifecycle registration', () => {
  void it('registers a canonical submission package for exactly 30 days', async () => {
    const observed: Array<{
      functionName: string;
      parameters: StorageRegistrationRpcArguments;
    }> = [];
    const registered = await registerStorageObject({
      object: {
        objectType: 'submission_package',
        artifactKind: null,
        bucket: 'aiq-submission-packages',
        path: `sha256/${digest}`,
        digest,
        bytes: 4_096,
      },
      rpc: rpc(observed),
      now: () => fixedNow,
    });

    assert.equal(registered, objectId);
    assert.deepEqual(observed, [
      {
        functionName: 'aiq_register_storage_object',
        parameters: {
          supplied_object_type: 'submission_package',
          supplied_artifact_kind: null,
          supplied_bucket: 'aiq-submission-packages',
          supplied_path: `sha256/${digest}`,
          supplied_sha256: digest,
          supplied_bytes: 4_096,
          supplied_retention_class: 'ephemeral_30d',
          supplied_expires_at: '2026-08-25T12:34:56.789Z',
        },
      },
    ]);
  });

  void it('registers a canonical runner artifact with its exact kind', async () => {
    const observed: Array<{
      functionName: string;
      parameters: StorageRegistrationRpcArguments;
    }> = [];
    await registerStorageObject({
      object: {
        objectType: 'runner_artifact',
        artifactKind: 'stdout.jsonl',
        bucket: 'aiq-runner-artifacts',
        path: `sha256/${digest}/stdout.jsonl`,
        digest,
        bytes: 512,
      },
      rpc: rpc(observed),
      now: () => fixedNow,
    });

    assert.equal(observed[0]?.parameters.supplied_object_type, 'runner_artifact');
    assert.equal(observed[0]?.parameters.supplied_artifact_kind, 'stdout.jsonl');
    assert.equal(observed[0]?.parameters.supplied_path, `sha256/${digest}/stdout.jsonl`);
  });

  void it('registers evaluator bundles only within their smaller proof budget', async () => {
    const observed: StorageRegistrationRpcArguments[] = [];
    await registerStorageObject({
      object: {
        objectType: 'runner_artifact',
        artifactKind: 'evaluator-results.json',
        bucket: 'aiq-runner-artifacts',
        path: `sha256/${digest}/evaluator-results.json`,
        digest,
        bytes: 3_948_544,
      },
      rpc: async (_functionName, parameters) => {
        observed.push(parameters);
        return { data: objectId, error: null };
      },
      now: () => fixedNow,
    });
    assert.equal(observed[0]?.supplied_artifact_kind, 'evaluator-results.json');

    await assert.rejects(
      registerStorageObject({
        object: {
          objectType: 'runner_artifact',
          artifactKind: 'evaluator-results.json',
          bucket: 'aiq-runner-artifacts',
          path: `sha256/${digest}/evaluator-results.json`,
          digest,
          bytes: 3_948_545,
        },
        rpc: async () => ({ data: objectId, error: null }),
      }),
      /Storage lifecycle registration failed/,
    );
  });

  void it('rejects invalid identities before RPC creation', async () => {
    const valid: StorageLifecycleObject = {
      objectType: 'submission_package',
      artifactKind: null,
      bucket: 'aiq-submission-packages',
      path: `sha256/${digest}`,
      digest,
      bytes: 1,
    };
    for (const object of [
      { ...valid, bucket: '../private' },
      { ...valid, bucket: 'unrelated-private-bucket' },
      { ...valid, path: `sha256/${digest}/other` },
      { ...valid, digest: `${digest}\n` },
      { ...valid, bytes: 0 },
      { ...valid, bytes: 4 * 1024 * 1024 + 1 },
      {
        objectType: 'runner_artifact',
        artifactKind: 'unexpected.txt',
        bucket: 'aiq-runner-artifacts',
        path: `sha256/${digest}/unexpected.txt`,
        digest,
        bytes: 1,
      } as unknown as StorageLifecycleObject,
    ]) {
      let calls = 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each adversarial object owns an independent RPC observation.
      await assert.rejects(
        registerStorageObject({
          object,
          rpc: async () => {
            calls += 1;
            return { data: objectId, error: null };
          },
          now: () => fixedNow,
        }),
        /^Error: Storage lifecycle registration failed\.$/,
      );
      assert.equal(calls, 0);
    }
  });

  void it('requires an exact UUID and always generalizes RPC failures', async () => {
    const object: StorageLifecycleObject = {
      objectType: 'submission_package',
      artifactKind: null,
      bucket: 'aiq-submission-packages',
      path: `sha256/${digest}`,
      digest,
      bytes: 1,
    };
    for (const failureRpc of [
      rpc([], { data: 'not-a-uuid', error: null }),
      rpc([], { data: `${objectId}\n`, error: null }),
      rpc([], { data: objectId.toUpperCase(), error: null }),
      rpc([], { data: objectId, error: { message: 'service-role-secret' } }),
      async () => {
        throw new Error('service-role-secret network detail');
      },
    ] satisfies StorageRegistrationRpc[]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each upstream failure must be checked independently.
      await assert.rejects(
        registerStorageObject({ object, rpc: failureRpc, now: () => fixedNow }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, 'Storage lifecycle registration failed.');
          assert.doesNotMatch(error.message, /service-role-secret|network detail/);
          return true;
        },
      );
    }
  });

  void it('rejects an invalid trusted clock without invoking the RPC', async () => {
    let calls = 0;
    await assert.rejects(
      registerStorageObject({
        object: {
          objectType: 'submission_package',
          artifactKind: null,
          bucket: 'aiq-submission-packages',
          path: `sha256/${digest}`,
          digest,
          bytes: 1,
        },
        rpc: async () => {
          calls += 1;
          return { data: objectId, error: null };
        },
        now: () => new Date(Number.NaN),
      }),
      /^Error: Storage lifecycle registration failed\.$/,
    );
    assert.equal(calls, 0);
  });
});
