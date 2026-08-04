import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests preserve raw adversarial header values that Fetch normalizes or rejects. */

import {
  artifactResolveRpcError,
  ArtifactResolveNotAvailableError,
  ArtifactResolveUpstreamUnavailableError,
  handleArtifactResolve,
  type ArtifactResolveDependencies,
  type ResolvedArtifact,
} from './artifact-resolve-handler.ts';

const token = 'verifier-token';
const inboxId = '223e4567-e89b-42d3-a456-426614174000';
const leaseToken = '123e4567-e89b-42d3-a456-426614174000';
const digest = 'a'.repeat(64);
const kind = 'workspace-manifest.json';

function request(
  authorization = `Bearer ${token}`,
  body: unknown = {
    inbox_id: inboxId,
    lease_token: leaseToken,
    kind,
    digest,
  },
): Request {
  return new Request('http://localhost/api/artifacts/resolve', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function requestWithRawContentLength(value: string): Request {
  const base = request();
  return {
    arrayBuffer: () => base.arrayBuffer(),
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-length' ? value : base.headers.get(name);
      },
    },
  } as Request;
}

function resolved(overrides: Readonly<Record<string, unknown>> = {}) {
  return [
    {
      object_bucket: 'private-artifacts',
      object_key: `sha256/${digest}/${kind}`,
      artifact_kind: kind,
      content_sha256: digest,
      byte_size: 321,
      lease_expires_at: '2026-07-25T12:05:00Z',
      ...overrides,
    },
  ];
}

function dependencies(
  overrides: Partial<ArtifactResolveDependencies> = {},
): ArtifactResolveDependencies {
  return {
    configured: true,
    expectedToken: token,
    resolve: async () => resolved(),
    createSignedUrl: async () => 'https://storage.invalid/signed',
    now: () => Date.parse('2026-07-25T12:04:00Z'),
    ...overrides,
  };
}

void describe('verifier artifact resolution', () => {
  void it('authorizes before parsing the request', async () => {
    let resolves = 0;
    const response = await handleArtifactResolve(
      request('Bearer wrong', '{'),
      dependencies({
        resolve: async () => {
          resolves += 1;
        },
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(resolves, 0);
  });

  void it('signs exact claim-bound capability stdout and stderr RPC responses', async () => {
    for (const capabilityKind of ['stdout.jsonl', 'stderr.txt']) {
      let observedResolve: readonly string[] = [];
      let observedArtifact: ResolvedArtifact | undefined;
      let observedExpiry = 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each capability artifact has independent RPC and signing observations.
      const response = await handleArtifactResolve(
        request(`Bearer ${token}`, {
          inbox_id: inboxId,
          lease_token: leaseToken,
          kind: capabilityKind,
          digest,
        }),
        dependencies({
          resolve: async (...parameters) => {
            observedResolve = parameters;
            return resolved({
              object_key: `sha256/${digest}/${capabilityKind}`,
              artifact_kind: capabilityKind,
            });
          },
          createSignedUrl: async (artifact, expiry) => {
            observedArtifact = artifact;
            observedExpiry = expiry;
            return `https://storage.invalid/${capabilityKind}`;
          },
        }),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(observedResolve, [inboxId, leaseToken, capabilityKind, digest]);
      assert.deepEqual(observedArtifact, {
        bucket: 'private-artifacts',
        key: `sha256/${digest}/${capabilityKind}`,
        kind: capabilityKind,
        digest,
        bytes: 321,
        leaseExpiresAt: '2026-07-25T12:05:00Z',
      });
      assert.equal(observedExpiry, 60);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each one-shot response body is asserted in its owning capability case.
      assert.deepEqual(await response.json(), {
        artifact: {
          kind: capabilityKind,
          content_sha256: digest,
          bytes: 321,
          url: `https://storage.invalid/${capabilityKind}`,
          url_expires_in_seconds: 60,
        },
      });
    }
  });

  void it('permits a claim-bound workspace replay snapshot', async () => {
    const snapshotKind = 'workspace-snapshot.json';
    const response = await handleArtifactResolve(
      request(`Bearer ${token}`, {
        inbox_id: inboxId,
        lease_token: leaseToken,
        kind: snapshotKind,
        digest,
      }),
      dependencies({
        resolve: async () =>
          resolved({
            object_key: `sha256/${digest}/${snapshotKind}`,
            artifact_kind: snapshotKind,
          }),
      }),
    );

    assert.equal(response.status, 200);
    assert.match(await response.text(), /workspace-snapshot\.json/);
  });

  void it('permits only an exactly resolved claim-bound evaluator bundle', async () => {
    const bundleKind = 'evaluator-results.json';
    const response = await handleArtifactResolve(
      request(`Bearer ${token}`, {
        inbox_id: inboxId,
        lease_token: leaseToken,
        kind: bundleKind,
        digest,
      }),
      dependencies({
        resolve: async () =>
          resolved({
            object_key: `sha256/${digest}/${bundleKind}`,
            artifact_kind: bundleKind,
            byte_size: 3_948_544,
          }),
      }),
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /evaluator-results\.json/);

    const oversized = await handleArtifactResolve(
      request(`Bearer ${token}`, {
        inbox_id: inboxId,
        lease_token: leaseToken,
        kind: bundleKind,
        digest,
      }),
      dependencies({
        resolve: async () =>
          resolved({
            object_key: `sha256/${digest}/${bundleKind}`,
            artifact_kind: bundleKind,
            byte_size: 3_948_545,
          }),
      }),
    );
    assert.equal(oversized.status, 404);
  });

  void it('fails closed for an expired lease', async () => {
    const response = await handleArtifactResolve(
      request(),
      dependencies({ now: () => Date.parse('2026-07-25T12:05:01Z') }),
    );
    assert.equal(response.status, 409);
    assert.match(await response.text(), /CLAIM_LEASE_EXPIRED/);
  });

  void it('rejects an upstream path substitution', async () => {
    const response = await handleArtifactResolve(
      request(),
      dependencies({ resolve: async () => resolved({ object_key: '../secret' }) }),
    );
    assert.equal(response.status, 404);
  });

  void it('rejects upstream kind, digest, and byte substitutions', async () => {
    for (const override of [
      { artifact_kind: 'stdout.jsonl' },
      { content_sha256: 'b'.repeat(64) },
      { byte_size: 0 },
      { byte_size: 3.5 },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each adversarial response is independent.
      const response = await handleArtifactResolve(
        request(),
        dependencies({ resolve: async () => resolved(override) }),
      );
      assert.equal(response.status, 404);
    }
  });

  void it('keeps denied and unbound evidence private while upstream failures stay retryable', async () => {
    const denied = artifactResolveRpcError({
      code: '42501',
      message: 'private detail must not escape',
    });
    const invalid = artifactResolveRpcError({ code: '22023' });
    const unavailable = artifactResolveRpcError({
      code: 'PGRST000',
      message: 'private endpoint and token must not escape',
    });

    assert.ok(denied instanceof ArtifactResolveNotAvailableError);
    assert.ok(invalid instanceof ArtifactResolveNotAvailableError);
    assert.ok(unavailable instanceof ArtifactResolveUpstreamUnavailableError);
    assert.doesNotMatch(String(denied), /private detail/i);
    assert.doesNotMatch(String(unavailable), /private|endpoint|token/i);

    const deniedResponse = await handleArtifactResolve(
      request(),
      dependencies({ resolve: async () => Promise.reject(denied) }),
    );
    const unboundResponse = await handleArtifactResolve(
      request(),
      dependencies({ resolve: async () => [] }),
    );
    const unavailableResponse = await handleArtifactResolve(
      request(),
      dependencies({ resolve: async () => Promise.reject(unavailable) }),
    );

    assert.equal(deniedResponse.status, 404);
    assert.deepEqual(await deniedResponse.json(), {
      error: 'ARTIFACT_NOT_AVAILABLE_FOR_CLAIM',
    });
    assert.equal(unboundResponse.status, 404);
    assert.deepEqual(await unboundResponse.json(), {
      error: 'ARTIFACT_NOT_AVAILABLE_FOR_CLAIM',
    });
    assert.equal(unavailableResponse.status, 503);
    assert.deepEqual(await unavailableResponse.json(), {
      error: 'ARTIFACT_RESOLVE_UPSTREAM_UNAVAILABLE',
    });
  });

  void it('rejects line terminators after exact claim-bound artifact identifiers', async () => {
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each adversarial body is independent.
      const response = await handleArtifactResolve(
        request(`Bearer ${token}`, {
          inbox_id: `${inboxId}${suffix}`,
          lease_token: leaseToken,
          kind,
          digest: `${digest}${suffix}`,
        }),
        dependencies(),
      );
      assert.equal(response.status, 400);
    }
  });

  void it('rejects line terminators after the artifact-resolution content-length header', async () => {
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each raw header case owns a one-shot request body.
      const response = await handleArtifactResolve(
        requestWithRawContentLength(`1${suffix}`),
        dependencies(),
      );
      assert.equal(response.status, 400);
    }
  });

  void it('does not return metadata when signed URL creation fails', async () => {
    const response = await handleArtifactResolve(
      request(),
      dependencies({
        createSignedUrl: async () => {
          throw new Error('storage unavailable');
        },
      }),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'ARTIFACT_URL_FAILED' });
  });
});
