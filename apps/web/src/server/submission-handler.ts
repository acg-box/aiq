import { createHash, timingSafeEqual } from 'node:crypto';

import {
  canonicalJson,
  mapEnqueueResult,
  MAX_RAW_SUBMISSION_BYTES,
  MAX_SIGNED_PACKAGE_BYTES,
  sha256Hex,
  validateSubmission,
  type SubmissionReceipt,
  type SubmissionObjectIdentity,
  type ValidatedSubmission,
} from './submission-contract.ts';
import { DuplicateJsonKeyError, parseJsonWithoutDuplicateKeys } from './strict-json.ts';

export interface SubmissionDependencies {
  configured: boolean;
  expectedToken: string;
  storePackage(rawBytes: Uint8Array, receipt: SubmissionReceipt): Promise<SubmissionObjectIdentity>;
  registerStoredObject(objectIdentity: SubmissionObjectIdentity): Promise<void>;
  enqueue(
    submission: ValidatedSubmission,
    receipt: SubmissionReceipt,
    objectIdentity: SubmissionObjectIdentity,
  ): Promise<unknown>;
  signalOrphan?(
    objectIdentity: SubmissionObjectIdentity,
    receipt: SubmissionReceipt,
    reason: string,
  ): void;
}

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function hasValidBearerToken(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ') || expectedToken.length === 0) {
    return false;
  }
  const suppliedToken = authorizationHeader.slice('Bearer '.length);
  return timingSafeEqual(tokenDigest(suppliedToken), tokenDigest(expectedToken));
}

type BodyResult =
  | {
      ok: true;
      value: unknown;
      canonicalBytes: Uint8Array;
      packageSha256: string;
      bodyBytes: number;
    }
  | { ok: false; code: string; message: string };

async function readBoundedJson(request: Request): Promise<BodyResult> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  const mediaType = contentType.split(';', 1)[0]?.trim();
  if (mediaType !== 'application/json') {
    return {
      ok: false,
      code: 'INVALID_CONTENT_TYPE',
      message: 'Content-Type must be application/json.',
    };
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (
      !/^(0|[1-9][0-9]*)(?![\s\S])/.test(contentLength) ||
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0
    ) {
      return {
        ok: false,
        code: 'INVALID_CONTENT_LENGTH',
        message: 'Content-Length must be a canonical nonnegative integer.',
      };
    }
    if (declaredBytes > MAX_RAW_SUBMISSION_BYTES) {
      return {
        ok: false,
        code: 'BODY_TOO_LARGE',
        message: `The request body must not exceed ${MAX_RAW_SUBMISSION_BYTES} bytes.`,
      };
    }
  }
  if (!request.body) {
    return { ok: false, code: 'INVALID_JSON', message: 'A JSON body is required.' };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A request stream must be read in order.
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytesRead += result.value.byteLength;
      if (bytesRead > MAX_RAW_SUBMISSION_BYTES) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel the active sequential reader.
        await reader.cancel();
        return {
          ok: false,
          code: 'BODY_TOO_LARGE',
          message: `The request body must not exceed ${MAX_RAW_SUBMISSION_BYTES} bytes.`,
        };
      }
      chunks.push(result.value);
    }
    const raw = Buffer.concat(chunks, bytesRead);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    const value = parseJsonWithoutDuplicateKeys(text);
    const canonicalText = canonicalJson(value);
    const canonicalBytes = Buffer.from(canonicalText, 'utf8');
    if (!raw.equals(canonicalBytes)) {
      return {
        ok: false,
        code: 'NON_CANONICAL_JSON',
        message: 'The JSON body must use its exact RFC 8785 canonical encoding.',
      };
    }
    if (canonicalBytes.byteLength > MAX_SIGNED_PACKAGE_BYTES) {
      return {
        ok: false,
        code: 'SIGNED_PACKAGE_TOO_LARGE',
        message: `The signed result package must not exceed ${MAX_SIGNED_PACKAGE_BYTES} bytes.`,
      };
    }
    return {
      ok: true,
      value,
      canonicalBytes,
      packageSha256: sha256Hex(canonicalBytes),
      bodyBytes: canonicalBytes.byteLength,
    };
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) {
      return {
        ok: false,
        code: 'DUPLICATE_JSON_KEY',
        message: 'The JSON body must not contain duplicate object keys.',
      };
    }
    return { ok: false, code: 'INVALID_JSON', message: 'The body must be valid UTF-8 JSON.' };
  }
}

export async function handleSubmission(
  request: Request,
  dependencies: SubmissionDependencies,
): Promise<Response> {
  if (!dependencies.configured) {
    return json(503, { error: 'SUBMISSION_SERVICE_UNAVAILABLE' });
  }
  if (!hasValidBearerToken(request.headers.get('authorization'), dependencies.expectedToken)) {
    return json(401, { error: 'UNAUTHORIZED' });
  }
  const idempotencyHeader = request.headers.get('idempotency-key');
  if (!idempotencyHeader || !/^run_[a-f0-9]{64}(?![\s\S])/.test(idempotencyHeader)) {
    return json(400, {
      error: 'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must be run_ followed by 64 lowercase hexadecimal characters.',
    });
  }
  const body = await readBoundedJson(request);
  if (!body.ok) {
    const status =
      body.code === 'BODY_TOO_LARGE' || body.code === 'SIGNED_PACKAGE_TOO_LARGE' ? 413 : 400;
    return json(status, { error: body.code, message: body.message });
  }
  const validation = validateSubmission(body.value);
  if (!validation.ok) {
    return json(400, { error: validation.code, message: validation.message });
  }
  if (idempotencyHeader !== validation.submission.idempotencyKey) {
    return json(400, {
      error: 'IDEMPOTENCY_KEY_MISMATCH',
      message: 'Idempotency-Key must match the signed result package.',
    });
  }
  const receipt = {
    receivedAt: new Date().toISOString(),
    packageSha256: body.packageSha256,
    bodyBytes: body.bodyBytes,
  };
  let objectIdentity: SubmissionObjectIdentity;
  try {
    objectIdentity = await dependencies.storePackage(body.canonicalBytes, receipt);
  } catch {
    return json(502, { error: 'SUBMISSION_OBJECT_UPLOAD_FAILED' });
  }
  if (
    objectIdentity.contentSha256 !== receipt.packageSha256 ||
    objectIdentity.bytes !== receipt.bodyBytes
  ) {
    dependencies.signalOrphan?.(objectIdentity, receipt, 'object_identity_mismatch');
    return json(502, { error: 'SUBMISSION_OBJECT_IDENTITY_MISMATCH' });
  }
  try {
    await dependencies.registerStoredObject(objectIdentity);
  } catch {
    dependencies.signalOrphan?.(objectIdentity, receipt, 'storage_registry_failed');
    return json(502, { error: 'SUBMISSION_STORAGE_REGISTRATION_FAILED_OBJECT_RETAINED' });
  }
  let upstreamResult: unknown;
  try {
    upstreamResult = await dependencies.enqueue(validation.submission, receipt, objectIdentity);
  } catch {
    dependencies.signalOrphan?.(objectIdentity, receipt, 'metadata_enqueue_failed');
    return json(502, { error: 'SUBMISSION_ENQUEUE_FAILED_OBJECT_RETAINED' });
  }
  const disposition = mapEnqueueResult(upstreamResult);
  if (disposition.status === 'invalid-upstream-response') {
    dependencies.signalOrphan?.(objectIdentity, receipt, 'queue_response_invalid');
    return json(502, { error: 'SUBMISSION_ENQUEUE_FAILED_OBJECT_RETAINED' });
  }
  if (!disposition.objectRecorded) {
    dependencies.signalOrphan?.(objectIdentity, receipt, 'queue_object_not_recorded');
  }
  if (disposition.status === 'conflict') {
    return json(409, {
      status: 'conflict',
      inbox_id: disposition.inboxId,
      verification_status: 'unverified',
    });
  }
  if (!disposition.objectRecorded) {
    return json(502, { error: 'SUBMISSION_ENQUEUE_FAILED_OBJECT_RETAINED' });
  }
  const duplicate = disposition.status === 'duplicate';
  return json(duplicate ? 208 : 202, {
    status: duplicate ? 'duplicate_unverified' : 'queued_unverified',
    inbox_id: disposition.inboxId,
    verification_status: 'unverified',
  });
}
