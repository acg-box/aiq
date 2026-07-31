import { hasValidBearerToken } from './submission-handler.ts';

const MAX_CLAIM_REQUEST_BYTES = 8 * 1024;
const DEFAULT_LEASE_SECONDS = 300;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 900;
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;

export interface VerifierClaim {
  inboxId: string;
  idempotencyKey: string;
  packageSha256: string;
  bodyBytes: number;
  objectBucket: string;
  objectKey: string;
  objectContentSha256: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attempt: number;
}

export interface VerifierClaimDependencies {
  configured: boolean;
  expectedToken: string;
  claim(leaseSeconds: number): Promise<unknown>;
  renew(inboxId: string, leaseToken: string, leaseSeconds: number): Promise<unknown>;
  createSignedObjectUrl(claim: VerifierClaim, expiresInSeconds: number): Promise<string>;
  now?(): number;
  acknowledge(
    inboxId: string,
    leaseToken: string,
    disposition: 'completed' | 'retry',
  ): Promise<unknown>;
}

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (
      !/^(0|[1-9][0-9]*)(?![\s\S])/.test(contentLength) ||
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_CLAIM_REQUEST_BYTES
    ) {
      throw new Error('invalid length');
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_CLAIM_REQUEST_BYTES) {
    throw new Error('too large');
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function mapClaim(value: unknown): VerifierClaim | null {
  if (!Array.isArray(value)) throw new Error('invalid claim');
  const values: readonly unknown[] = value;
  if (values.length === 0) return null;
  if (values.length !== 1) throw new Error('invalid claim');
  const candidate = values[0];
  if (
    !isRecord(candidate) ||
    typeof candidate.inbox_id !== 'string' ||
    !uuidPattern.test(candidate.inbox_id) ||
    typeof candidate.idempotency_key !== 'string' ||
    !/^run_[a-f0-9]{64}(?![\s\S])/.test(candidate.idempotency_key) ||
    typeof candidate.package_sha256 !== 'string' ||
    !digestPattern.test(candidate.package_sha256) ||
    typeof candidate.body_bytes !== 'number' ||
    !Number.isSafeInteger(candidate.body_bytes) ||
    typeof candidate.object_bucket !== 'string' ||
    typeof candidate.object_key !== 'string' ||
    typeof candidate.object_content_sha256 !== 'string' ||
    candidate.object_content_sha256 !== candidate.package_sha256 ||
    typeof candidate.lease_token !== 'string' ||
    !uuidPattern.test(candidate.lease_token) ||
    typeof candidate.lease_expires_at !== 'string' ||
    Number.isNaN(Date.parse(candidate.lease_expires_at)) ||
    typeof candidate.attempt !== 'number' ||
    !Number.isSafeInteger(candidate.attempt)
  ) {
    throw new Error('invalid claim');
  }
  return {
    inboxId: candidate.inbox_id,
    idempotencyKey: candidate.idempotency_key,
    packageSha256: candidate.package_sha256,
    bodyBytes: candidate.body_bytes,
    objectBucket: candidate.object_bucket,
    objectKey: candidate.object_key,
    objectContentSha256: candidate.object_content_sha256,
    leaseToken: candidate.lease_token,
    leaseExpiresAt: candidate.lease_expires_at,
    attempt: candidate.attempt,
  };
}

function mapRenewal(
  value: unknown,
  expectedInboxId: string,
  expectedLeaseToken: string,
): Readonly<{ leaseExpiresAt: string; attempt: number }> {
  let candidate = value;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error('invalid renewal');
    candidate = value[0];
  }
  if (
    !isRecord(candidate) ||
    candidate.inbox_id !== expectedInboxId ||
    candidate.lease_token !== expectedLeaseToken ||
    typeof candidate.lease_expires_at !== 'string' ||
    Number.isNaN(Date.parse(candidate.lease_expires_at)) ||
    typeof candidate.attempt !== 'number' ||
    !Number.isSafeInteger(candidate.attempt) ||
    candidate.attempt < 1
  ) {
    throw new Error('invalid renewal');
  }
  return {
    leaseExpiresAt: candidate.lease_expires_at,
    attempt: candidate.attempt,
  };
}

export async function handleVerifierClaim(
  request: Request,
  dependencies: VerifierClaimDependencies,
): Promise<Response> {
  if (!dependencies.configured) return json(503, { error: 'VERIFIER_CLAIM_SERVICE_UNAVAILABLE' });
  if (!hasValidBearerToken(request.headers.get('authorization'), dependencies.expectedToken)) {
    return json(401, { error: 'UNAUTHORIZED' });
  }
  let body: unknown;
  try {
    body = await readBody(request);
  } catch {
    return json(400, { error: 'INVALID_REQUEST' });
  }
  if (
    !isRecord(body) ||
    (body.action !== 'claim' && body.action !== 'ack' && body.action !== 'renew')
  ) {
    return json(400, { error: 'INVALID_REQUEST' });
  }
  if (body.action === 'renew') {
    if (
      Object.keys(body).toSorted().join(',') !== 'action,inbox_id,lease_seconds,lease_token' ||
      typeof body.inbox_id !== 'string' ||
      !uuidPattern.test(body.inbox_id) ||
      typeof body.lease_token !== 'string' ||
      !uuidPattern.test(body.lease_token) ||
      typeof body.lease_seconds !== 'number' ||
      !Number.isSafeInteger(body.lease_seconds) ||
      body.lease_seconds < MIN_LEASE_SECONDS ||
      body.lease_seconds > MAX_LEASE_SECONDS
    ) {
      return json(400, { error: 'INVALID_RENEWAL' });
    }
    let renewed: unknown;
    try {
      renewed = await dependencies.renew(body.inbox_id, body.lease_token, body.lease_seconds);
    } catch {
      return json(409, { error: 'CLAIM_RENEWAL_CONFLICT' });
    }
    try {
      const renewal = mapRenewal(renewed, body.inbox_id, body.lease_token);
      return json(200, {
        status: 'renewed',
        inbox_id: body.inbox_id,
        lease_token: body.lease_token,
        lease_expires_at: renewal.leaseExpiresAt,
        attempt: renewal.attempt,
      });
    } catch {
      return json(502, { error: 'CLAIM_RENEWAL_UPSTREAM_ERROR' });
    }
  }
  if (body.action === 'ack') {
    if (
      Object.keys(body).toSorted().join(',') !== 'action,disposition,inbox_id,lease_token' ||
      typeof body.inbox_id !== 'string' ||
      !uuidPattern.test(body.inbox_id) ||
      typeof body.lease_token !== 'string' ||
      !uuidPattern.test(body.lease_token) ||
      (body.disposition !== 'completed' && body.disposition !== 'retry')
    ) {
      return json(400, { error: 'INVALID_ACK' });
    }
    try {
      const disposition = await dependencies.acknowledge(
        body.inbox_id,
        body.lease_token,
        body.disposition,
      );
      if (disposition !== 'acknowledged' && disposition !== 'idempotent') {
        throw new Error('invalid ack');
      }
      return json(200, { status: disposition });
    } catch {
      return json(409, { error: 'CLAIM_ACK_CONFLICT' });
    }
  }
  if (!Object.keys(body).every((key) => key === 'action' || key === 'lease_seconds')) {
    return json(400, { error: 'INVALID_CLAIM' });
  }
  const leaseSeconds = body.lease_seconds ?? DEFAULT_LEASE_SECONDS;
  if (
    typeof leaseSeconds !== 'number' ||
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < MIN_LEASE_SECONDS ||
    leaseSeconds > MAX_LEASE_SECONDS
  ) {
    return json(400, { error: 'INVALID_LEASE' });
  }
  let claim: VerifierClaim | null;
  try {
    claim = mapClaim(await dependencies.claim(leaseSeconds));
  } catch {
    return json(502, { error: 'CLAIM_UPSTREAM_ERROR' });
  }
  if (!claim) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  const now = dependencies.now?.() ?? Date.now();
  const leaseRemaining = Math.floor((Date.parse(claim.leaseExpiresAt) - now) / 1_000);
  if (leaseRemaining < 1) {
    return json(409, { error: 'CLAIM_LEASE_EXPIRED' });
  }
  try {
    const expiresIn = Math.min(300, leaseSeconds, leaseRemaining);
    const objectUrl = await dependencies.createSignedObjectUrl(claim, expiresIn);
    return json(200, {
      claim: {
        inbox_id: claim.inboxId,
        idempotency_key: claim.idempotencyKey,
        package_sha256: claim.packageSha256,
        body_bytes: claim.bodyBytes,
        object_content_sha256: claim.objectContentSha256,
        lease_token: claim.leaseToken,
        lease_expires_at: claim.leaseExpiresAt,
        attempt: claim.attempt,
        object_url: objectUrl,
        object_url_expires_in_seconds: expiresIn,
      },
    });
  } catch {
    try {
      await dependencies.acknowledge(claim.inboxId, claim.leaseToken, 'retry');
    } catch {
      // The database lease expires without a heartbeat if release also fails.
    }
    return json(502, { error: 'CLAIM_OBJECT_URL_FAILED' });
  }
}
