import { hasValidBearerToken } from './submission-handler.ts';
import {
  MAX_SPEED_OBSERVATION_BYTES,
  validateSpeedObservation,
  type ValidatedSpeedObservation,
} from './speed-observation-contract.ts';
import { DuplicateJsonKeyError, parseJsonWithoutDuplicateKeys } from './strict-json.ts';

export interface SpeedObservationObjectIdentity {
  readonly bucket: string;
  readonly key: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface SpeedObservationDependencies {
  readonly configured: boolean;
  readonly expectedToken: string;
  storeObservation(observation: ValidatedSpeedObservation): Promise<SpeedObservationObjectIdentity>;
  registerStoredObject(identity: SpeedObservationObjectIdentity): Promise<string>;
  recordObservation(
    observation: ValidatedSpeedObservation,
    objectId: string,
    identity: SpeedObservationObjectIdentity,
  ): Promise<'accepted' | 'duplicate'>;
  signalReconciliation?(
    identity: SpeedObservationObjectIdentity,
    observation: ValidatedSpeedObservation,
    reason: string,
  ): void;
}

type BodyResult =
  | { readonly ok: true; readonly value: unknown; readonly rawBytes: Uint8Array }
  | { readonly ok: false; readonly status: number; readonly error: string };

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function canonicalContentLength(value: string | null): number | null {
  if (!value || !/^(0|[1-9][0-9]*)(?![\s\S])/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBody(request: Request): Promise<BodyResult> {
  const mediaType = request.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim();
  if (mediaType !== 'application/json') {
    return { ok: false, status: 400, error: 'INVALID_CONTENT_TYPE' };
  }
  const declared = canonicalContentLength(request.headers.get('content-length'));
  if (declared === null) return { ok: false, status: 400, error: 'INVALID_CONTENT_LENGTH' };
  if (declared > MAX_SPEED_OBSERVATION_BYTES) {
    return { ok: false, status: 413, error: 'BODY_TOO_LARGE' };
  }
  if (!request.body) return { ok: false, status: 400, error: 'INVALID_JSON' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Request streams are ordered.
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > declared || bytesRead > MAX_SPEED_OBSERVATION_BYTES) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel the active ordered stream.
        await reader.cancel();
        return { ok: false, status: 400, error: 'BODY_SIZE_MISMATCH' };
      }
      chunks.push(result.value);
    }
    if (bytesRead !== declared) {
      return { ok: false, status: 400, error: 'BODY_SIZE_MISMATCH' };
    }
    const rawBytes = new Uint8Array(Buffer.concat(chunks, bytesRead));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
    return { ok: true, value: parseJsonWithoutDuplicateKeys(text), rawBytes };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof DuplicateJsonKeyError ? 'DUPLICATE_JSON_KEY' : 'INVALID_JSON',
    };
  }
}

export async function handleSpeedObservation(
  request: Request,
  dependencies: SpeedObservationDependencies,
): Promise<Response> {
  if (!dependencies.configured) {
    return json(503, { error: 'SPEED_OBSERVATION_SERVICE_UNAVAILABLE' });
  }
  if (!hasValidBearerToken(request.headers.get('authorization'), dependencies.expectedToken)) {
    return json(401, { error: 'UNAUTHORIZED' });
  }
  const body = await readBody(request);
  if (!body.ok) return json(body.status, { error: body.error });
  const validation = validateSpeedObservation(body.value);
  if (!validation.ok) {
    return json(400, { error: validation.code, message: validation.message });
  }
  const observation = validation.observation;
  if (request.headers.get('idempotency-key') !== observation.batchId) {
    return json(400, { error: 'IDEMPOTENCY_KEY_MISMATCH' });
  }
  if (!Buffer.from(body.rawBytes).equals(Buffer.from(observation.canonicalBytes))) {
    return json(400, { error: 'NON_CANONICAL_JSON' });
  }

  let identity: SpeedObservationObjectIdentity;
  try {
    identity = await dependencies.storeObservation(observation);
  } catch {
    return json(502, { error: 'SPEED_OBSERVATION_OBJECT_UPLOAD_FAILED' });
  }
  if (
    identity.digest !== observation.storageSha256 ||
    identity.bytes !== observation.canonicalBytes.byteLength
  ) {
    dependencies.signalReconciliation?.(identity, observation, 'object_identity_mismatch');
    return json(502, { error: 'SPEED_OBSERVATION_OBJECT_IDENTITY_MISMATCH' });
  }

  let objectId: string;
  try {
    objectId = await dependencies.registerStoredObject(identity);
  } catch {
    dependencies.signalReconciliation?.(identity, observation, 'storage_registry_failed');
    return json(502, { error: 'SPEED_OBSERVATION_STORAGE_REGISTRATION_FAILED' });
  }

  try {
    const disposition = await dependencies.recordObservation(observation, objectId, identity);
    return json(disposition === 'duplicate' ? 208 : 201, {
      status: disposition,
      batch_id: observation.batchId,
      scoring_impact: 'none',
    });
  } catch {
    dependencies.signalReconciliation?.(identity, observation, 'database_record_failed');
    return json(502, { error: 'SPEED_OBSERVATION_RECORD_FAILED_OBJECT_RETAINED' });
  }
}
