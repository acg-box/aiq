import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests preserve raw adversarial header values that Fetch normalizes or rejects. */

import {
  ARTIFACT_KIND_MAX_BYTES,
  handleArtifactUpload,
  isCanonicalEvaluatorResultsBundle,
  MAX_EVALUATOR_RESULTS_BYTES,
  type ArtifactObjectIdentity,
  type ArtifactUploadDependencies,
} from './artifact-handler.ts';
import { canonicalJson } from './submission-contract.ts';

const token = 'runner-token';
const runId = `run_${'a'.repeat(64)}`;
const bytes = Buffer.from('artifact evidence');
const digest = createHash('sha256').update(bytes).digest('hex');

function evaluatorResult(checkCount = 1): Record<string, unknown> {
  return {
    schema_version: 'aiq.evaluator-result.v3',
    outcome: 'correct',
    score: 1,
    checks: Array.from({ length: checkCount }, (_, index) => ({
      check_id: `check_${index}`,
      weight: 1,
      passed: true,
      failure_class: 'none',
      evidence_digest: `sha256:${((index % 15) + 1).toString(16).repeat(64)}`,
    })),
    raw_stdout_sha256: `sha256:${'a'.repeat(64)}`,
  };
}

function evaluatorBundle(checkCount = 1, result = evaluatorResult(checkCount)): Buffer {
  return Buffer.from(
    canonicalJson({
      schema_version: 'aiq.evaluator-results.v1',
      results: [result, null],
    }),
  );
}

function request(body: Buffer = bytes, overrides: Readonly<Record<string, string>> = {}): Request {
  return new Request('http://localhost/api/artifacts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-length': String(body.byteLength),
      'content-type': 'application/octet-stream',
      'idempotency-key': runId,
      'x-aiq-artifact-kind': 'stdout.jsonl',
      'x-aiq-artifact-sha256': digest,
      'x-aiq-artifact-bytes': String(body.byteLength),
      ...overrides,
    },
    body: body.toString('utf8'),
  });
}

function identity(): ArtifactObjectIdentity {
  return {
    runId,
    kind: 'stdout.jsonl',
    digest,
    bytes: bytes.byteLength,
    bucket: 'aiq-runner-artifacts',
    key: `sha256/${digest}/stdout.jsonl`,
  };
}

function requestWithRawHeader(name: string, value: string): Request {
  const base = request();
  return {
    body: base.body,
    headers: {
      get(headerName: string) {
        return headerName.toLowerCase() === name ? value : base.headers.get(headerName);
      },
    },
  } as Request;
}

function dependencies(
  overrides: Partial<ArtifactUploadDependencies> = {},
): ArtifactUploadDependencies {
  return {
    configured: true,
    expectedToken: token,
    storeArtifact: async () => ({ disposition: 'stored', identity: identity() }),
    registerStoredObject: async () => {},
    recordArtifact: async () => 'accepted',
    ...overrides,
  };
}

void describe('runner artifact upload', () => {
  void it('checks authentication before artifact headers or body', async () => {
    let stores = 0;
    const response = await handleArtifactUpload(
      request(bytes, {
        authorization: 'Bearer wrong',
        'x-aiq-artifact-bytes': String(4 * 1024 * 1024 + 1),
      }),
      dependencies({
        storeArtifact: async () => {
          stores += 1;
          return { disposition: 'stored', identity: identity() };
        },
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(stores, 0);
  });

  void it('enforces the artifact-kind byte bound before reading', async () => {
    const response = await handleArtifactUpload(
      request(bytes, {
        'content-length': String(4 * 1024 * 1024 + 1),
        'x-aiq-artifact-bytes': String(4 * 1024 * 1024 + 1),
      }),
      dependencies(),
    );
    assert.equal(response.status, 413);

    const evaluatorResponse = await handleArtifactUpload(
      request(bytes, {
        'content-length': String(MAX_EVALUATOR_RESULTS_BYTES + 1),
        'x-aiq-artifact-bytes': String(MAX_EVALUATOR_RESULTS_BYTES + 1),
        'x-aiq-artifact-kind': 'evaluator-results.json',
      }),
      dependencies(),
    );
    assert.equal(evaluatorResponse.status, 413);
    assert.deepEqual(await evaluatorResponse.json(), {
      error: 'ARTIFACT_TOO_LARGE',
      max_bytes: MAX_EVALUATOR_RESULTS_BYTES,
    });
  });

  void it('accepts bounded workspace replay snapshots as private artifacts', async () => {
    const snapshotKind = 'workspace-snapshot.json' as const;
    const snapshotIdentity: ArtifactObjectIdentity = {
      runId,
      kind: snapshotKind,
      digest,
      bytes: bytes.byteLength,
      bucket: 'aiq-runner-artifacts',
      key: `sha256/${digest}/${snapshotKind}`,
    };
    const response = await handleArtifactUpload(
      request(bytes, { 'x-aiq-artifact-kind': snapshotKind }),
      dependencies({
        storeArtifact: async () => ({ disposition: 'stored', identity: snapshotIdentity }),
      }),
    );

    assert.equal(response.status, 201);
    assert.match(await response.text(), /workspace-snapshot\.json/);
  });

  void it('accepts only canonical bounded evaluator result bundles', async () => {
    const body = evaluatorBundle();
    const bundleDigest = createHash('sha256').update(body).digest('hex');
    const bundleKind = 'evaluator-results.json' as const;
    const bundleIdentity: ArtifactObjectIdentity = {
      runId,
      kind: bundleKind,
      digest: bundleDigest,
      bytes: body.byteLength,
      bucket: 'aiq-runner-artifacts',
      key: `sha256/${bundleDigest}/${bundleKind}`,
    };
    const response = await handleArtifactUpload(
      request(body, {
        'x-aiq-artifact-kind': bundleKind,
        'x-aiq-artifact-sha256': bundleDigest,
      }),
      dependencies({
        storeArtifact: async () => ({ disposition: 'stored', identity: bundleIdentity }),
      }),
    );

    assert.equal(response.status, 201);
    assert.equal(isCanonicalEvaluatorResultsBundle(body), true);
    assert.equal(
      isCanonicalEvaluatorResultsBundle(Buffer.from(` ${body.toString('utf8')}`)),
      false,
    );
    assert.equal(isCanonicalEvaluatorResultsBundle(evaluatorBundle(16)), true);
    assert.equal(isCanonicalEvaluatorResultsBundle(evaluatorBundle(17)), false);
    assert.equal(ARTIFACT_KIND_MAX_BYTES['evaluator-results.json'], MAX_EVALUATOR_RESULTS_BYTES);
  });

  void it('accepts the production evaluator result shape and schema-authorized omitted digest', () => {
    assert.equal(isCanonicalEvaluatorResultsBundle(evaluatorBundle(16)), true);

    const { raw_stdout_sha256: _omitted, ...withoutRawStdoutDigest } = evaluatorResult();
    assert.equal(
      isCanonicalEvaluatorResultsBundle(evaluatorBundle(1, withoutRawStdoutDigest)),
      true,
    );
  });

  void it('rejects missing base keys, malformed raw stdout digests, and extra result keys', () => {
    const { schema_version: _omitted, ...missingSchemaVersion } = evaluatorResult();
    assert.equal(
      isCanonicalEvaluatorResultsBundle(evaluatorBundle(1, missingSchemaVersion)),
      false,
    );

    for (const malformedDigest of [
      'a'.repeat(64),
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'0'.repeat(64)}`,
      null,
    ]) {
      assert.equal(
        isCanonicalEvaluatorResultsBundle(
          evaluatorBundle(1, {
            ...evaluatorResult(),
            raw_stdout_sha256: malformedDigest,
          }),
        ),
        false,
      );
    }

    const zeroEvidenceDigest = evaluatorResult();
    zeroEvidenceDigest.checks = [
      {
        check_id: 'check_0',
        weight: 1,
        passed: true,
        failure_class: 'none',
        evidence_digest: `sha256:${'0'.repeat(64)}`,
      },
    ];
    assert.equal(isCanonicalEvaluatorResultsBundle(evaluatorBundle(1, zeroEvidenceDigest)), false);

    assert.equal(
      isCanonicalEvaluatorResultsBundle(
        evaluatorBundle(1, { ...evaluatorResult(), unexpected: true }),
      ),
      false,
    );
  });

  void it('rejects malformed evaluator bundles before Storage', async () => {
    const body = evaluatorBundle(17);
    const bundleDigest = createHash('sha256').update(body).digest('hex');
    let stores = 0;
    const response = await handleArtifactUpload(
      request(body, {
        'x-aiq-artifact-kind': 'evaluator-results.json',
        'x-aiq-artifact-sha256': bundleDigest,
      }),
      dependencies({
        storeArtifact: async () => {
          stores += 1;
          return { disposition: 'stored', identity: identity() };
        },
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(stores, 0);
    assert.match(await response.text(), /INVALID_EVALUATOR_RESULTS_BUNDLE/);
  });

  void it('rejects a digest mismatch before Storage', async () => {
    let stores = 0;
    const response = await handleArtifactUpload(
      request(bytes, { 'x-aiq-artifact-sha256': 'b'.repeat(64) }),
      dependencies({
        storeArtifact: async () => {
          stores += 1;
          return { disposition: 'stored', identity: identity() };
        },
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(stores, 0);
    assert.match(await response.text(), /ARTIFACT_DIGEST_MISMATCH/);
  });

  void it('returns an idempotent exact duplicate without object identity', async () => {
    const calls: string[] = [];
    const response = await handleArtifactUpload(
      request(),
      dependencies({
        storeArtifact: async () => {
          calls.push('store');
          return { disposition: 'duplicate', identity: identity() };
        },
        registerStoredObject: async () => {
          calls.push('register');
        },
        recordArtifact: async () => {
          calls.push('record');
          return 'duplicate';
        },
      }),
    );
    assert.equal(response.status, 208);
    assert.deepEqual(calls, ['store', 'register', 'record']);
    const value = await response.text();
    assert.match(value, /"status":"duplicate"/);
    assert.match(value, new RegExp(`aiq-artifact://sha256/${digest}/stdout.jsonl`));
    assert.doesNotMatch(value, /aiq-runner-artifacts|object_path|bucket/);
  });

  void it('fails closed after Storage registration failure without metadata or secret disclosure', async () => {
    const calls: string[] = [];
    const response = await handleArtifactUpload(
      request(),
      dependencies({
        storeArtifact: async () => {
          calls.push('store');
          return { disposition: 'stored', identity: identity() };
        },
        registerStoredObject: async () => {
          calls.push('register');
          throw new Error('service-role-secret database detail');
        },
        recordArtifact: async () => {
          calls.push('record');
          return 'accepted';
        },
        signalReconciliation: (_identity, reason) => calls.push(`signal:${reason}`),
      }),
    );

    assert.equal(response.status, 502);
    assert.deepEqual(calls, ['store', 'register', 'signal:storage_registry_failed']);
    const body = await response.text();
    assert.match(body, /ARTIFACT_STORAGE_REGISTRATION_FAILED_OBJECT_RETAINED/);
    assert.doesNotMatch(body, /service-role-secret|database detail/);
  });

  void it('rejects an immutable changed object and signals reconciliation', async () => {
    const reasons: string[] = [];
    const response = await handleArtifactUpload(
      request(),
      dependencies({
        storeArtifact: async () => ({ disposition: 'conflict', identity: identity() }),
        signalReconciliation: (_identity, reason) => reasons.push(reason),
      }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(reasons, ['immutable_object_conflict']);
  });

  void it('rejects path-capable artifact kinds', async () => {
    const response = await handleArtifactUpload(
      request(bytes, { 'x-aiq-artifact-kind': '../stdout.jsonl' }),
      dependencies(),
    );
    assert.equal(response.status, 400);
    assert.match(await response.text(), /INVALID_ARTIFACT_HEADERS/);
  });

  void it('rejects line terminators after exact artifact header values', async () => {
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each suffix gets independent one-shot request bodies.
      const responses = await Promise.all([
        handleArtifactUpload(
          requestWithRawHeader('idempotency-key', `${runId}${suffix}`),
          dependencies(),
        ),
        handleArtifactUpload(
          requestWithRawHeader('x-aiq-artifact-sha256', `${digest}${suffix}`),
          dependencies(),
        ),
        handleArtifactUpload(
          requestWithRawHeader('x-aiq-artifact-bytes', `${bytes.byteLength}${suffix}`),
          dependencies(),
        ),
      ]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [400, 400, 400],
      );
    }
  });

  void it('reports retained-object reconciliation when metadata recording fails', async () => {
    const reasons: string[] = [];
    const response = await handleArtifactUpload(
      request(),
      dependencies({
        recordArtifact: async () => {
          throw new Error('database unavailable');
        },
        signalReconciliation: (_identity, reason) => reasons.push(reason),
      }),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(reasons, ['metadata_record_failed']);
    assert.match(await response.text(), /OBJECT_RETAINED/);
  });
});
