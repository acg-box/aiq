import { createHash } from 'node:crypto';

import { hasValidBearerToken } from './request-auth.ts';
import {
  ARTIFACT_KIND_MAX_BYTES,
  CAPABILITY_MARKER_BYTES,
  isArtifactKind,
  isCanonicalEvaluatorResultsBundle,
  type ArtifactReceipt,
  type ArtifactObjectIdentity,
} from './artifact-contract.ts';
import { readBoundedBody } from './bounded-body.ts';

export interface ArtifactUploadDependencies {
  configured: boolean;
  expectedToken: string;
  storeArtifact(
    rawBytes: Uint8Array,
    receipt: ArtifactReceipt,
  ): Promise<{
    disposition: 'stored' | 'duplicate' | 'conflict';
    identity: ArtifactObjectIdentity;
  }>;
  registerStoredObject(identity: ArtifactObjectIdentity): Promise<void>;
  recordArtifact(identity: ArtifactObjectIdentity): Promise<'accepted' | 'duplicate'>;
  signalReconciliation?(identity: ArtifactObjectIdentity, reason: string): void;
}

const digestPattern = /^[a-f0-9]{64}(?![\s\S])/;
const runPattern = /^run_[a-f0-9]{64}(?![\s\S])/;

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function parseCanonicalSize(value: string | null): number | null {
  if (!value || !/^(0|[1-9][0-9]*)(?![\s\S])/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedBinary(
  request: Request,
  expectedBytes: number,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!request.body) return null;
  try {
    const bytes = await readBoundedBody(request.body, Math.min(expectedBytes, maxBytes));
    return bytes?.byteLength === expectedBytes ? bytes : null;
  } catch {
    return null;
  }
}

export async function handleArtifactUpload(
  request: Request,
  dependencies: ArtifactUploadDependencies,
): Promise<Response> {
  if (!dependencies.configured) {
    return json(503, { error: 'ARTIFACT_SERVICE_UNAVAILABLE' });
  }
  if (!hasValidBearerToken(request.headers.get('authorization'), dependencies.expectedToken)) {
    return json(401, { error: 'UNAUTHORIZED' });
  }

  const runId = request.headers.get('idempotency-key');
  const kind = request.headers.get('x-aiq-artifact-kind');
  const digest = request.headers.get('x-aiq-artifact-sha256');
  const declaredBytes = parseCanonicalSize(request.headers.get('x-aiq-artifact-bytes'));
  const contentLength = parseCanonicalSize(request.headers.get('content-length'));
  const mediaType = request.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim();
  if (
    !runId ||
    !runPattern.test(runId) ||
    !kind ||
    !isArtifactKind(kind) ||
    !digest ||
    !digestPattern.test(digest) ||
    declaredBytes === null ||
    contentLength === null ||
    declaredBytes !== contentLength ||
    declaredBytes < 1 ||
    mediaType !== 'application/octet-stream'
  ) {
    return json(400, { error: 'INVALID_ARTIFACT_HEADERS' });
  }
  const artifactKind = kind;
  const maxBytes = ARTIFACT_KIND_MAX_BYTES[artifactKind];
  if (declaredBytes > maxBytes) {
    return json(413, { error: 'ARTIFACT_TOO_LARGE', max_bytes: maxBytes });
  }

  const rawBytes = await readBoundedBinary(request, declaredBytes, maxBytes);
  if (!rawBytes) return json(400, { error: 'ARTIFACT_SIZE_MISMATCH' });
  if (artifactKind === 'evaluator-results.json' && !isCanonicalEvaluatorResultsBundle(rawBytes)) {
    return json(400, { error: 'INVALID_EVALUATOR_RESULTS_BUNDLE' });
  }
  if (
    artifactKind === 'capability-marker.txt' &&
    !Buffer.from(rawBytes).equals(CAPABILITY_MARKER_BYTES)
  ) {
    return json(400, { error: 'INVALID_CAPABILITY_MARKER' });
  }
  const observedDigest = createHash('sha256').update(rawBytes).digest('hex');
  if (observedDigest !== digest) {
    return json(400, { error: 'ARTIFACT_DIGEST_MISMATCH' });
  }
  const receipt: ArtifactReceipt = {
    runId,
    kind: artifactKind,
    digest,
    bytes: declaredBytes,
  };

  let stored: Awaited<ReturnType<ArtifactUploadDependencies['storeArtifact']>>;
  try {
    stored = await dependencies.storeArtifact(rawBytes, receipt);
  } catch {
    return json(502, { error: 'ARTIFACT_OBJECT_UPLOAD_FAILED' });
  }
  if (
    stored.identity.runId !== runId ||
    stored.identity.kind !== artifactKind ||
    stored.identity.digest !== digest ||
    stored.identity.bytes !== declaredBytes
  ) {
    dependencies.signalReconciliation?.(stored.identity, 'object_identity_mismatch');
    return json(502, { error: 'ARTIFACT_OBJECT_IDENTITY_MISMATCH' });
  }
  if (stored.disposition === 'conflict') {
    dependencies.signalReconciliation?.(stored.identity, 'immutable_object_conflict');
    return json(409, { error: 'ARTIFACT_IMMUTABLE_CONFLICT' });
  }

  try {
    await dependencies.registerStoredObject(stored.identity);
  } catch {
    dependencies.signalReconciliation?.(stored.identity, 'storage_registry_failed');
    return json(502, { error: 'ARTIFACT_STORAGE_REGISTRATION_FAILED_OBJECT_RETAINED' });
  }

  let recorded: 'accepted' | 'duplicate';
  try {
    recorded = await dependencies.recordArtifact(stored.identity);
  } catch {
    dependencies.signalReconciliation?.(stored.identity, 'metadata_record_failed');
    return json(502, { error: 'ARTIFACT_RECORD_FAILED_OBJECT_RETAINED' });
  }
  const duplicate = stored.disposition === 'duplicate' || recorded === 'duplicate';
  return json(duplicate ? 208 : 201, {
    status: duplicate ? 'duplicate' : 'stored',
    reference: `aiq-artifact://sha256/${digest}/${artifactKind}`,
    content_sha256: digest,
    bytes: declaredBytes,
  });
}
