import { hasValidBearerToken } from './submission-handler.ts';
import { ARTIFACT_KIND_MAX_BYTES } from './artifact-handler.ts';

const MAX_RESOLVE_REQUEST_BYTES = 8 * 1024;
const artifactKindMaxBytes: Readonly<Record<string, number>> = ARTIFACT_KIND_MAX_BYTES;
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const allowedKinds = new Set([
  'evaluator-results.json',
  'final-response.txt',
  'stderr.txt',
  'stdout.jsonl',
  'workspace-manifest.json',
  'workspace-snapshot.json',
]);

export interface ResolvedArtifact {
  bucket: string;
  key: string;
  kind: string;
  digest: string;
  bytes: number;
  leaseExpiresAt: string;
}

export interface ArtifactResolveDependencies {
  configured: boolean;
  expectedToken: string;
  resolve(inboxId: string, leaseToken: string, kind: string, digest: string): Promise<unknown>;
  createSignedUrl(artifact: ResolvedArtifact, expiresInSeconds: number): Promise<string>;
  now?(): number;
}

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (
    length &&
    (!/^(0|[1-9][0-9]*)(?![\s\S])/.test(length) || Number(length) > MAX_RESOLVE_REQUEST_BYTES)
  ) {
    throw new Error('invalid length');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_RESOLVE_REQUEST_BYTES) throw new Error('too large');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function mapResolved(value: unknown, kind: string, digest: string): ResolvedArtifact {
  let candidate = value;
  if (Array.isArray(value)) {
    const values: readonly unknown[] = value;
    candidate = values[0];
  }
  if (
    !isRecord(candidate) ||
    typeof candidate.object_bucket !== 'string' ||
    candidate.object_bucket.length === 0 ||
    typeof candidate.object_key !== 'string' ||
    candidate.object_key !== `sha256/${digest}/${kind}` ||
    candidate.artifact_kind !== kind ||
    candidate.content_sha256 !== digest ||
    typeof candidate.byte_size !== 'number' ||
    !Number.isSafeInteger(candidate.byte_size) ||
    candidate.byte_size < 1 ||
    candidate.byte_size > (artifactKindMaxBytes[kind] ?? 0) ||
    typeof candidate.lease_expires_at !== 'string' ||
    Number.isNaN(Date.parse(candidate.lease_expires_at))
  ) {
    throw new Error('invalid resolution');
  }
  return {
    bucket: candidate.object_bucket,
    key: candidate.object_key,
    kind,
    digest,
    bytes: candidate.byte_size,
    leaseExpiresAt: candidate.lease_expires_at,
  };
}

export async function handleArtifactResolve(
  request: Request,
  dependencies: ArtifactResolveDependencies,
): Promise<Response> {
  if (!dependencies.configured) {
    return json(503, { error: 'ARTIFACT_RESOLVE_SERVICE_UNAVAILABLE' });
  }
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
    Object.keys(body).toSorted().join(',') !== 'digest,inbox_id,kind,lease_token' ||
    typeof body.inbox_id !== 'string' ||
    !uuidPattern.test(body.inbox_id) ||
    typeof body.lease_token !== 'string' ||
    !uuidPattern.test(body.lease_token) ||
    typeof body.kind !== 'string' ||
    !allowedKinds.has(body.kind) ||
    typeof body.digest !== 'string' ||
    !digestPattern.test(body.digest)
  ) {
    return json(400, { error: 'INVALID_ARTIFACT_REFERENCE' });
  }
  let artifact: ResolvedArtifact;
  try {
    artifact = mapResolved(
      await dependencies.resolve(body.inbox_id, body.lease_token, body.kind, body.digest),
      body.kind,
      body.digest,
    );
  } catch {
    return json(404, { error: 'ARTIFACT_NOT_AVAILABLE_FOR_CLAIM' });
  }
  const now = dependencies.now?.() ?? Date.now();
  const leaseRemaining = Math.floor((Date.parse(artifact.leaseExpiresAt) - now) / 1000);
  if (leaseRemaining < 1) {
    return json(409, { error: 'CLAIM_LEASE_EXPIRED' });
  }
  const expiresIn = Math.min(120, leaseRemaining);
  try {
    const signedUrl = await dependencies.createSignedUrl(artifact, expiresIn);
    return json(200, {
      artifact: {
        kind: artifact.kind,
        content_sha256: artifact.digest,
        bytes: artifact.bytes,
        url: signedUrl,
        url_expires_in_seconds: expiresIn,
      },
    });
  } catch {
    return json(502, { error: 'ARTIFACT_URL_FAILED' });
  }
}
