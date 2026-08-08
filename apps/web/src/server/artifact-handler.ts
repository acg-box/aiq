import { createHash } from 'node:crypto';

import { hasValidBearerToken } from './submission-handler.ts';
import { canonicalJson } from './submission-contract.ts';

export const MAX_EVALUATOR_RESULTS_BYTES = 3_948_544;
export const CAPABILITY_MARKER_BYTES = Buffer.from('AIQ_CAPABILITY_COMMAND_AND_WRITE_V1\n');
export const CAPABILITY_MARKER_DIGEST = createHash('sha256')
  .update(CAPABILITY_MARKER_BYTES)
  .digest('hex');

export const ARTIFACT_KIND_MAX_BYTES = {
  'evaluator-results.json': MAX_EVALUATOR_RESULTS_BYTES,
  'capability-marker.txt': CAPABILITY_MARKER_BYTES.byteLength,
  'final-response.txt': 4 * 1024 * 1024,
  'stderr.txt': 4 * 1024 * 1024,
  'stdout.jsonl': 4 * 1024 * 1024,
  'workspace-manifest.json': 4 * 1024 * 1024,
  'workspace-snapshot.json': 4 * 1024 * 1024,
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_KIND_MAX_BYTES;

export interface ArtifactReceipt {
  runId: string;
  kind: ArtifactKind;
  digest: string;
  bytes: number;
}

export interface ArtifactObjectIdentity extends ArtifactReceipt {
  bucket: string;
  key: string;
}

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
const prefixedDigestPattern = /^sha256:(?!0{64}(?![\s\S]))[a-f0-9]{64}(?![\s\S])/;
const checkIdPattern = /^[A-Za-z0-9._-]{1,128}(?![\s\S])/;
const runPattern = /^run_[a-f0-9]{64}(?![\s\S])/;

function isArtifactKind(value: string): value is ArtifactKind {
  return Object.hasOwn(ARTIFACT_KIND_MAX_BYTES, value);
}

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).toSorted();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEvaluatorCheck(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['check_id', 'evidence_digest', 'failure_class', 'passed', 'weight']) ||
    typeof value.check_id !== 'string' ||
    !checkIdPattern.test(value.check_id) ||
    typeof value.weight !== 'number' ||
    !Number.isSafeInteger(value.weight) ||
    value.weight < 0 ||
    value.weight > 0xffff_ffff ||
    typeof value.passed !== 'boolean' ||
    (value.failure_class !== 'none' &&
      value.failure_class !== 'value' &&
      value.failure_class !== 'structural') ||
    value.passed !== (value.failure_class === 'none') ||
    typeof value.evidence_digest !== 'string' ||
    !prefixedDigestPattern.test(value.evidence_digest)
  ) {
    return false;
  }
  return true;
}

function isEvaluatorResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      Object.hasOwn(value, 'raw_stdout_sha256')
        ? ['checks', 'outcome', 'raw_stdout_sha256', 'schema_version', 'score']
        : ['checks', 'outcome', 'schema_version', 'score'],
    ) &&
    value.schema_version === 'aiq.evaluator-result.v3' &&
    (value.outcome === 'correct' || value.outcome === 'partial' || value.outcome === 'incorrect') &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= 1 &&
    (!Object.hasOwn(value, 'raw_stdout_sha256') ||
      (typeof value.raw_stdout_sha256 === 'string' &&
        prefixedDigestPattern.test(value.raw_stdout_sha256))) &&
    Array.isArray(value.checks) &&
    value.checks.length >= 1 &&
    value.checks.length <= 16 &&
    value.checks.every(isEvaluatorCheck) &&
    new Set(value.checks.map((check) => (isRecord(check) ? check.check_id : Symbol('invalid'))))
      .size === value.checks.length &&
    value.checks.some((check) => isRecord(check) && Number(check.weight) > 0)
  );
}

export function isCanonicalEvaluatorResultsBundle(rawBytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
    const value: unknown = JSON.parse(text);
    return (
      isRecord(value) &&
      hasExactKeys(value, ['results', 'schema_version']) &&
      value.schema_version === 'aiq.evaluator-results.v1' &&
      Array.isArray(value.results) &&
      value.results.length <= 1_224 &&
      value.results.every((result) => result === null || isEvaluatorResult(result)) &&
      text === canonicalJson(value)
    );
  } catch {
    return false;
  }
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
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Request streams are sequential.
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > maxBytes || bytesRead > expectedBytes) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel the active sequential reader.
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    return null;
  }
  if (bytesRead !== expectedBytes) return null;
  return new Uint8Array(Buffer.concat(chunks, bytesRead));
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
