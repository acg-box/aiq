import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests preserve raw adversarial header values that Fetch normalizes or rejects. */

import { handleVerifierClaim, type VerifierClaimDependencies } from './verifier-claim-handler.ts';

const token = 'verifier-token';
const leaseToken = '123e4567-e89b-42d3-a456-426614174000';
const inboxId = '223e4567-e89b-42d3-a456-426614174000';
const digest = 'a'.repeat(64);
const claimRunId = `run_${'b'.repeat(64)}`;

function claimRow(): Readonly<Record<string, unknown>> {
  return {
    inbox_id: inboxId,
    idempotency_key: claimRunId,
    package_sha256: digest,
    body_bytes: 123,
    object_bucket: 'aiq-submission-packages',
    object_key: `sha256/${digest}`,
    object_content_sha256: digest,
    lease_token: leaseToken,
    lease_expires_at: '2026-07-25T12:05:00Z',
    attempt: 1,
  };
}

function request(body: string, authorization = `Bearer ${token}`): Request {
  return new Request('http://localhost/api/claims', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body,
  });
}

function requestWithRawContentLength(body: string, value: string): Request {
  const base = request(body);
  return {
    body: base.body,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-length' ? value : base.headers.get(name);
      },
    },
  } as Request;
}

function dependencies(
  overrides: Partial<VerifierClaimDependencies> = {},
): VerifierClaimDependencies {
  return {
    configured: true,
    expectedToken: token,
    claim: async () => [claimRow()],
    renew: async () => [
      {
        inbox_id: inboxId,
        lease_token: leaseToken,
        lease_expires_at: '2026-07-25T12:07:00Z',
        attempt: 1,
      },
    ],
    createSignedObjectUrl: async () => 'https://storage.invalid/signed',
    now: () => Date.parse('2026-07-25T12:03:00Z'),
    acknowledge: async () => 'acknowledged',
    ...overrides,
  };
}

void describe('verifier claim gateway', () => {
  void it('authorizes before reading a malformed body', async () => {
    let claimCalls = 0;
    const response = await handleVerifierClaim(
      request('{', 'Bearer wrong'),
      dependencies({
        claim: async () => {
          claimCalls += 1;
        },
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(claimCalls, 0);
  });

  void it('claims one package and returns bounded signed access with digest metadata', async () => {
    let leaseSeconds = 0;
    let signedUrlSeconds = 0;
    const response = await handleVerifierClaim(
      request(JSON.stringify({ action: 'claim', lease_seconds: 120 })),
      dependencies({
        claim: async (observed) => {
          leaseSeconds = observed;
          return dependencies().claim(observed);
        },
        createSignedObjectUrl: async (_claim, observed) => {
          signedUrlSeconds = observed;
          return 'https://storage.invalid/signed';
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(leaseSeconds, 120);
    assert.equal(signedUrlSeconds, 120);
    const value = await response.text();
    assert.match(value, new RegExp(`"package_sha256":"${digest}"`));
    assert.match(value, new RegExp(`"object_content_sha256":"${digest}"`));
    assert.match(value, /"object_url_expires_in_seconds":120/);
    assert.doesNotMatch(value, /"object_bucket"|"object_key"/);
  });

  void it('caps package signed access at the database lease remainder', async () => {
    let signedUrlSeconds = 0;
    const response = await handleVerifierClaim(
      request(JSON.stringify({ action: 'claim', lease_seconds: 300 })),
      dependencies({
        now: () => Date.parse('2026-07-25T12:04:15Z'),
        createSignedObjectUrl: async (_claim, observed) => {
          signedUrlSeconds = observed;
          return 'https://storage.invalid/signed';
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(signedUrlSeconds, 45);
    assert.match(await response.text(), /"object_url_expires_in_seconds":45/);
  });

  void it('fails closed without signing when the database lease is expired', async () => {
    let signedUrlCalls = 0;
    const response = await handleVerifierClaim(
      request(JSON.stringify({ action: 'claim' })),
      dependencies({
        now: () => Date.parse('2026-07-25T12:05:00Z'),
        createSignedObjectUrl: async () => {
          signedUrlCalls += 1;
          return 'https://storage.invalid/signed';
        },
      }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'CLAIM_LEASE_EXPIRED' });
    assert.equal(signedUrlCalls, 0);
  });

  void it('returns no work without inventing a heartbeat', async () => {
    const response = await handleVerifierClaim(
      request(JSON.stringify({ action: 'claim' })),
      dependencies({ claim: async () => [] }),
    );
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });

  void it('fails closed when the claim RPC returns more than one row', async () => {
    let signedUrlCalls = 0;
    const response = await handleVerifierClaim(
      request(JSON.stringify({ action: 'claim' })),
      dependencies({
        claim: async () => [claimRow(), claimRow()],
        createSignedObjectUrl: async () => {
          signedUrlCalls += 1;
          return 'https://storage.invalid/signed';
        },
      }),
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'CLAIM_UPSTREAM_ERROR' });
    assert.equal(signedUrlCalls, 0);
  });

  void it('fails closed when the claim RPC returns a scalar envelope', async () => {
    const invalidUpstreams: readonly unknown[] = [claimRow(), null];
    const observations = await Promise.all(
      invalidUpstreams.map(async (invalidUpstream) => {
        let signedUrlCalls = 0;
        const response = await handleVerifierClaim(
          request(JSON.stringify({ action: 'claim' })),
          dependencies({
            claim: async () => invalidUpstream,
            createSignedObjectUrl: async () => {
              signedUrlCalls += 1;
              return 'https://storage.invalid/signed';
            },
          }),
        );
        return { response, body: await response.text(), signedUrlCalls };
      }),
    );

    for (const { response, body, signedUrlCalls } of observations) {
      assert.equal(response.status, 502);
      assert.equal(body, '{"error":"CLAIM_UPSTREAM_ERROR"}');
      assert.equal(signedUrlCalls, 0);
    }
  });

  void it('releases the lease when signed URL creation fails', async () => {
    const acknowledgements: string[] = [];
    const response = await handleVerifierClaim(
      request(JSON.stringify({ action: 'claim' })),
      dependencies({
        createSignedObjectUrl: async () => {
          throw new Error('storage unavailable');
        },
        acknowledge: async (_inbox, _lease, disposition) => {
          acknowledgements.push(disposition);
          return 'acknowledged';
        },
      }),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(acknowledgements, ['retry']);
  });

  void it('supports retry/completed acknowledgement and rejects stale leases', async () => {
    const responses = await Promise.all(
      (['retry', 'completed'] as const).map((disposition) =>
        handleVerifierClaim(
          request(
            JSON.stringify({
              action: 'ack',
              inbox_id: inboxId,
              lease_token: leaseToken,
              disposition,
            }),
          ),
          dependencies(),
        ),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    const stale = await handleVerifierClaim(
      request(
        JSON.stringify({
          action: 'ack',
          inbox_id: inboxId,
          lease_token: leaseToken,
          disposition: 'retry',
        }),
      ),
      dependencies({
        acknowledge: async () => {
          throw new Error('stale lease');
        },
      }),
    );
    assert.equal(stale.status, 409);
  });

  void it('rejects an invalid acknowledgement inbox ID before calling the database', async () => {
    let acknowledgeCalls = 0;
    const response = await handleVerifierClaim(
      request(
        JSON.stringify({
          action: 'ack',
          inbox_id: 'not-a-uuid',
          lease_token: leaseToken,
          disposition: 'completed',
        }),
      ),
      dependencies({
        acknowledge: async () => {
          acknowledgeCalls += 1;
          return 'acknowledged';
        },
      }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_ACK' });
    assert.equal(acknowledgeCalls, 0);
  });

  void it('renews the exact active lease without changing its identity or attempt', async () => {
    const observed: unknown[] = [];
    const response = await handleVerifierClaim(
      request(
        JSON.stringify({
          action: 'renew',
          inbox_id: inboxId,
          lease_token: leaseToken,
          lease_seconds: 120,
        }),
      ),
      dependencies({
        renew: async (...parameters) => {
          observed.push(...parameters);
          return dependencies().renew(parameters[0], parameters[1], parameters[2]);
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(observed, [inboxId, leaseToken, 120]);
    assert.deepEqual(await response.json(), {
      status: 'renewed',
      inbox_id: inboxId,
      lease_token: leaseToken,
      lease_expires_at: '2026-07-25T12:07:00Z',
      attempt: 1,
    });
  });

  void it('fails renewal closed for invalid requests, stale leases, and mismatched results', async () => {
    let renewCalls = 0;
    const invalidRequests = [
      { action: 'renew', inbox_id: inboxId, lease_token: leaseToken, lease_seconds: 29 },
      { action: 'renew', inbox_id: inboxId, lease_token: leaseToken, lease_seconds: 901 },
      { action: 'renew', inbox_id: 'not-a-uuid', lease_token: leaseToken, lease_seconds: 30 },
      {
        action: 'renew',
        inbox_id: inboxId,
        lease_token: leaseToken,
        lease_seconds: 30,
        extra: true,
      },
    ];
    const invalidResponses = await Promise.all(
      invalidRequests.map((invalidRequest) =>
        handleVerifierClaim(
          request(JSON.stringify(invalidRequest)),
          dependencies({
            renew: async () => {
              renewCalls += 1;
            },
          }),
        ),
      ),
    );
    assert.deepEqual(
      invalidResponses.map((response) => response.status),
      [400, 400, 400, 400],
    );
    assert.equal(renewCalls, 0);

    const stale = await handleVerifierClaim(
      request(
        JSON.stringify({
          action: 'renew',
          inbox_id: inboxId,
          lease_token: leaseToken,
          lease_seconds: 30,
        }),
      ),
      dependencies({
        renew: async () => {
          throw new Error('stale lease');
        },
      }),
    );
    assert.equal(stale.status, 409);

    const mismatched = await handleVerifierClaim(
      request(
        JSON.stringify({
          action: 'renew',
          inbox_id: inboxId,
          lease_token: leaseToken,
          lease_seconds: 30,
        }),
      ),
      dependencies({
        renew: async () => [
          {
            inbox_id: inboxId,
            lease_token: '323e4567-e89b-42d3-a456-426614174000',
            lease_expires_at: '2026-07-25T12:07:00Z',
            attempt: 1,
          },
        ],
      }),
    );
    assert.equal(mismatched.status, 502);
  });

  void it('rejects invalid leases and mismatched object identity', async () => {
    const invalidLease = await handleVerifierClaim(
      request(JSON.stringify({ action: 'claim', lease_seconds: 901 })),
      dependencies(),
    );
    const invalidIdentity = await handleVerifierClaim(
      request(JSON.stringify({ action: 'claim' })),
      dependencies({
        claim: async () => [
          {
            ...claimRow(),
            object_content_sha256: 'c'.repeat(64),
          },
        ],
      }),
    );
    assert.equal(invalidLease.status, 400);
    assert.equal(invalidIdentity.status, 502);
  });

  void it('rejects line terminators after exact lease, digest, and run identifiers', async () => {
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each adversarial request is independent.
      const invalidLease = await handleVerifierClaim(
        request(
          JSON.stringify({
            action: 'renew',
            inbox_id: `${inboxId}${suffix}`,
            lease_token: leaseToken,
            lease_seconds: 30,
          }),
        ),
        dependencies(),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each adversarial upstream row is independent.
      const invalidClaim = await handleVerifierClaim(
        request(JSON.stringify({ action: 'claim' })),
        dependencies({
          claim: async () => [
            {
              ...claimRow(),
              idempotency_key: `${claimRunId}${suffix}`,
              package_sha256: `${digest}${suffix}`,
            },
          ],
        }),
      );
      assert.equal(invalidLease.status, 400);
      assert.equal(invalidClaim.status, 502);
    }
  });

  void it('rejects line terminators after the claim content-length header', async () => {
    const body = JSON.stringify({ action: 'claim' });
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each raw header case owns a one-shot request body.
      const response = await handleVerifierClaim(
        requestWithRawContentLength(body, `${Buffer.byteLength(body)}${suffix}`),
        dependencies(),
      );
      assert.equal(response.status, 400);
    }
  });
});
