import { createHash, timingSafeEqual } from 'node:crypto';

import {
  MAX_VERIFICATION_BYTES,
  validateVerification,
  type ValidatedVerification,
  type ValidatedCalibrationVerification,
  type VerificationClaim,
  type VerifierRejection,
} from './verification-contract.ts';
import { createBoundedSupabaseFetch, createVerificationSupabaseFetch } from './supabase-http.ts';

export const MAX_VERIFICATION_AUTHORIZATION_BYTES = 4_096;

export interface VerificationDependencies {
  configured: boolean;
  expectedToken: string;
  stage(verification: ValidatedVerification): Promise<unknown>;
  recordAttestation(verification: ValidatedVerification): Promise<void>;
  publish(verification: ValidatedVerification): Promise<void>;
  stageCalibration?(verification: ValidatedCalibrationVerification): Promise<unknown>;
  recordCalibrationAttestation?(verification: ValidatedCalibrationVerification): Promise<unknown>;
  publishCalibration?(verification: ValidatedCalibrationVerification): Promise<unknown>;
  reject(claim: VerificationClaim, rejection: VerifierRejection): Promise<void>;
}

export interface VerificationRpcFailureDiagnostic {
  event: 'aiq_verification_rpc_failed';
  function_name: string;
  code: string;
  message: string;
}

function boundedDiagnosticValue(value: unknown, maximumCharacters: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return Array.from(value.slice(0, maximumCharacters), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('');
}

export function verificationRpcFailureDiagnostic(
  functionName: string,
  error: { code?: string; message?: string } | undefined,
): VerificationRpcFailureDiagnostic {
  return {
    event: 'aiq_verification_rpc_failed',
    function_name: boundedDiagnosticValue(functionName, 128) ?? 'unknown',
    code: boundedDiagnosticValue(error?.code, 64) ?? 'REQUEST_FAILED',
    message: boundedDiagnosticValue(error?.message, 512) ?? 'The Supabase RPC request failed.',
  };
}

export function verificationRoleClientOptions(
  issueRoleToken: () => string,
  parentSignal?: AbortSignal,
) {
  return {
    accessToken: async () => issueRoleToken(),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: createBoundedSupabaseFetch(parentSignal) },
  };
}

export function verificationRpcRoleClientOptions(
  issueRoleToken: () => string,
  parentSignal?: AbortSignal,
) {
  return {
    accessToken: async () => issueRoleToken(),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: createVerificationSupabaseFetch(parentSignal) },
  };
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

export function hasValidVerificationBearerToken(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (
    !authorizationHeader?.startsWith('Bearer ') ||
    Buffer.byteLength(authorizationHeader, 'utf8') > MAX_VERIFICATION_AUTHORIZATION_BYTES ||
    expectedToken.length === 0 ||
    Buffer.byteLength(expectedToken, 'utf8') >
      MAX_VERIFICATION_AUTHORIZATION_BYTES - Buffer.byteLength('Bearer ', 'utf8')
  ) {
    return false;
  }
  return timingSafeEqual(
    tokenDigest(authorizationHeader.slice('Bearer '.length)),
    tokenDigest(expectedToken),
  );
}

type BodyResult = { ok: true; value: unknown } | { ok: false; code: string; message: string };

async function readBoundedJson(request: Request): Promise<BodyResult> {
  const mediaType = request.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim();
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
      declaredBytes < 0 ||
      declaredBytes > MAX_VERIFICATION_BYTES
    ) {
      return {
        ok: false,
        code: 'BODY_TOO_LARGE',
        message: `The request body must not exceed ${MAX_VERIFICATION_BYTES} bytes.`,
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
      if (bytesRead > MAX_VERIFICATION_BYTES) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel the active sequential reader.
        await reader.cancel();
        return {
          ok: false,
          code: 'BODY_TOO_LARGE',
          message: `The request body must not exceed ${MAX_VERIFICATION_BYTES} bytes.`,
        };
      }
      chunks.push(result.value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytesRead));
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: 'INVALID_JSON', message: 'The body must be valid UTF-8 JSON.' };
  }
}

export async function handleVerification(
  request: Request,
  dependencies: VerificationDependencies,
): Promise<Response> {
  if (!dependencies.configured) {
    return json(503, { error: 'VERIFICATION_SERVICE_UNAVAILABLE' });
  }
  if (
    !hasValidVerificationBearerToken(
      request.headers.get('authorization'),
      dependencies.expectedToken,
    )
  ) {
    return json(401, { error: 'UNAUTHORIZED' });
  }
  const body = await readBoundedJson(request);
  if (!body.ok) {
    return json(400, { error: body.code, message: body.message });
  }
  const validation = validateVerification(body.value);
  if (!validation.ok) {
    return json(400, { error: validation.code, message: validation.message });
  }
  if (validation.operation.kind === 'rejection') {
    try {
      await dependencies.reject(validation.operation.claim, validation.operation.rejection);
    } catch {
      return json(502, { error: 'VERIFICATION_UPSTREAM_ERROR' });
    }
    return json(200, {
      status: 'rejection_recorded_not_published',
      published: false,
      matrix_batch_id: validation.operation.rejection.matrix_batch_id,
      package_sha256: validation.operation.rejection.package_sha256,
    });
  }
  if (validation.operation.kind === 'calibration_verification') {
    const verification = validation.operation.verification;
    try {
      if (
        !dependencies.stageCalibration ||
        !dependencies.recordCalibrationAttestation ||
        !dependencies.publishCalibration
      )
        throw new Error('Calibration verification is not configured.');
      const stageResult = await dependencies.stageCalibration(verification);
      if (stageResult !== 'recorded' && stageResult !== 'duplicate')
        throw new Error('Invalid calibration stage disposition.');
      const attestationResult = await dependencies.recordCalibrationAttestation(verification);
      if (attestationResult !== 'recorded' && attestationResult !== 'duplicate')
        throw new Error('Invalid calibration attestation disposition.');
      const publishResult = await dependencies.publishCalibration(verification);
      if (publishResult !== 'published' && publishResult !== 'duplicate')
        throw new Error('Invalid calibration publish disposition.');
    } catch {
      return json(502, { error: 'VERIFICATION_UPSTREAM_ERROR' });
    }
    return json(200, {
      status: 'calibration_verified_published',
      official_eligible: false,
      ranking_eligible: false,
      run_id: verification.stage.run_id,
      package_sha256: verification.stage.package_sha256,
    });
  }
  const verification = validation.operation.verification;
  try {
    const stageResult = await dependencies.stage(verification);
    if (stageResult !== verification.stage.matrix_batch_id) {
      throw new Error('Stage RPC returned an unexpected batch identity.');
    }
    await dependencies.recordAttestation(verification);
    await dependencies.publish(verification);
  } catch {
    return json(502, { error: 'VERIFICATION_UPSTREAM_ERROR' });
  }
  return json(200, {
    status: 'verified_published',
    matrix_batch_id: verification.stage.matrix_batch_id,
    package_sha256: verification.stage.package_sha256,
  });
}
