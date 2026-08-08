import {
  ARTIFACT_KIND_MAX_BYTES,
  CAPABILITY_MARKER_BYTES,
  CAPABILITY_MARKER_DIGEST,
  type ArtifactKind,
} from './artifact-handler.ts';
import { AIQ_RUNNER_ARTIFACT_BUCKET, AIQ_SUBMISSION_PACKAGE_BUCKET } from './storage-buckets.ts';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_STORAGE_OBJECT_BYTES = 4 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const artifactKinds = new Set<ArtifactKind>([
  'evaluator-results.json',
  'capability-marker.txt',
  'final-response.txt',
  'stderr.txt',
  'stdout.jsonl',
  'workspace-manifest.json',
  'workspace-snapshot.json',
]);

export type StorageLifecycleObject =
  | Readonly<{
      objectType: 'submission_package';
      artifactKind: null;
      bucket: string;
      path: string;
      digest: string;
      bytes: number;
    }>
  | Readonly<{
      objectType: 'runner_artifact';
      artifactKind: ArtifactKind;
      bucket: string;
      path: string;
      digest: string;
      bytes: number;
    }>;

export interface StorageRegistrationRpcArguments {
  supplied_object_type: StorageLifecycleObject['objectType'];
  supplied_artifact_kind: ArtifactKind | null;
  supplied_bucket: string;
  supplied_path: string;
  supplied_sha256: string;
  supplied_bytes: number;
  supplied_retention_class: 'ephemeral_30d';
  supplied_expires_at: string;
}

export type StorageRegistrationRpc = (
  functionName: 'aiq_register_storage_object',
  parameters: StorageRegistrationRpcArguments,
) => Promise<Readonly<{ data: unknown; error: unknown }>>;

function isValidObject(object: StorageLifecycleObject): boolean {
  if (
    !digestPattern.test(object.digest) ||
    !Number.isSafeInteger(object.bytes) ||
    object.bytes < 1 ||
    object.bytes > MAX_STORAGE_OBJECT_BYTES
  ) {
    return false;
  }
  if (object.objectType === 'submission_package') {
    return (
      object.bucket === AIQ_SUBMISSION_PACKAGE_BUCKET &&
      object.artifactKind === null &&
      object.path === `sha256/${object.digest}`
    );
  }
  if (
    object.artifactKind === 'capability-marker.txt' &&
    (object.digest !== CAPABILITY_MARKER_DIGEST ||
      object.bytes !== CAPABILITY_MARKER_BYTES.byteLength)
  ) {
    return false;
  }
  return (
    object.objectType === 'runner_artifact' &&
    object.bucket === AIQ_RUNNER_ARTIFACT_BUCKET &&
    artifactKinds.has(object.artifactKind) &&
    object.bytes <= ARTIFACT_KIND_MAX_BYTES[object.artifactKind] &&
    object.path === `sha256/${object.digest}/${object.artifactKind}`
  );
}

function registrationFailure(): Error {
  return new Error('Storage lifecycle registration failed.');
}

export async function registerStorageObject({
  object,
  rpc,
  now = () => new Date(),
}: Readonly<{
  object: StorageLifecycleObject;
  rpc: StorageRegistrationRpc;
  now?: () => Date;
}>): Promise<string> {
  try {
    if (!isValidObject(object)) throw registrationFailure();
    const nowMilliseconds = now().getTime();
    const expiresAtMilliseconds = nowMilliseconds + THIRTY_DAYS_MS;
    if (
      !Number.isSafeInteger(nowMilliseconds) ||
      nowMilliseconds < 0 ||
      !Number.isSafeInteger(expiresAtMilliseconds)
    ) {
      throw registrationFailure();
    }
    const result = await rpc('aiq_register_storage_object', {
      supplied_object_type: object.objectType,
      supplied_artifact_kind: object.artifactKind,
      supplied_bucket: object.bucket,
      supplied_path: object.path,
      supplied_sha256: object.digest,
      supplied_bytes: object.bytes,
      supplied_retention_class: 'ephemeral_30d',
      supplied_expires_at: new Date(expiresAtMilliseconds).toISOString(),
    });
    if (result.error || typeof result.data !== 'string' || !uuidPattern.test(result.data)) {
      throw registrationFailure();
    }
    return result.data;
  } catch {
    throw registrationFailure();
  }
}
