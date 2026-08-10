/* oxlint-disable typescript/no-unsafe-type-assertion -- Every assertion follows adjacent runtime shape validation. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

type LifecycleMode = 'delete' | 'reconcile';

export interface LifecycleConfiguration {
  origin: string;
  secretKey: string;
  packageBucket: string;
  artifactBucket: string;
  mode: LifecycleMode;
  batchSize: number;
  leaseSeconds: number;
  graceSeconds: number;
  maximumObjects: number;
  requestTimeoutMs: number;
}

interface ClaimedObject {
  object_id: string;
  object_type: 'submission_package' | 'runner_artifact';
  artifact_kind: string | null;
  bucket_name: string;
  object_path: string;
  content_sha256: string;
  byte_size: number;
  lease_token: string;
  lease_expires_at: string;
  attempt: number;
}

interface RegistryObject {
  object_id: string;
  object_path: string;
  content_sha256: string;
  byte_size: number;
  lifecycle_state: string;
  legal_hold: boolean;
  active_references: number;
}

interface ReconciliationEvent {
  object_path: string;
  mismatch_type: 'storage_only' | 'registry_only' | 'identity_mismatch';
}

interface StorageListEntry {
  name: string;
  id?: string | null;
  created_at?: string;
  metadata?: { size?: number } | null;
}

interface ObservedObject {
  path: string;
  createdAt: string | undefined;
  bytes: number;
}

const AIQ_SUBMISSION_PACKAGE_BUCKET = 'aiq-submission-packages';
const AIQ_RUNNER_ARTIFACT_BUCKET = 'aiq-runner-artifacts';
const digestPattern = /^[0-9a-f]{64}(?![\s\S])/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;
const artifactKinds = new Set([
  'evaluator-results.json',
  'final-response.txt',
  'speed-observation.json',
  'stderr.txt',
  'stdout.jsonl',
  'workspace-manifest.json',
  'workspace-snapshot.json',
]);

function integerSetting(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  assert.match(value, /^(0|[1-9][0-9]*)(?![\s\S])/, `${name} must be a canonical integer`);
  const parsed = Number(value);
  assert.ok(
    Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `${name} is out of range`,
  );
  return parsed;
}

export function readLifecycleConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): LifecycleConfiguration {
  const rawUrl = environment.SUPABASE_URL;
  const secretKey = environment.SUPABASE_SECRET_KEY;
  const packageBucket = environment.AIQ_SUBMISSION_PACKAGE_BUCKET;
  const artifactBucket = environment.AIQ_RUNNER_ARTIFACT_BUCKET;
  assert.ok(
    rawUrl && secretKey && packageBucket && artifactBucket,
    'Storage lifecycle configuration is incomplete',
  );
  assert.equal(rawUrl, rawUrl.trim(), 'SUPABASE_URL must not contain surrounding whitespace');
  const url = new URL(rawUrl);
  const insecureLoopback = environment.AIQ_STORAGE_ALLOW_INSECURE_LOOPBACK === 'true';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert.ok(
    url.protocol === 'https:' || (url.protocol === 'http:' && insecureLoopback && loopback),
    'SUPABASE_URL must use HTTPS unless explicit insecure loopback mode is enabled',
  );
  assert.ok(
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'SUPABASE_URL must be an origin',
  );
  assert.equal(
    packageBucket,
    AIQ_SUBMISSION_PACKAGE_BUCKET,
    `AIQ_SUBMISSION_PACKAGE_BUCKET must be ${AIQ_SUBMISSION_PACKAGE_BUCKET}`,
  );
  assert.equal(
    artifactBucket,
    AIQ_RUNNER_ARTIFACT_BUCKET,
    `AIQ_RUNNER_ARTIFACT_BUCKET must be ${AIQ_RUNNER_ARTIFACT_BUCKET}`,
  );
  assert.equal(
    secretKey,
    secretKey.trim(),
    'SUPABASE_SECRET_KEY must not contain surrounding whitespace',
  );
  assert.ok(isSecretKey(secretKey), 'SUPABASE_SECRET_KEY is not a secret key');
  const modeValue = environment.AIQ_STORAGE_LIFECYCLE_MODE;
  assert.ok(
    modeValue === 'delete' || modeValue === 'reconcile',
    'AIQ_STORAGE_LIFECYCLE_MODE must be set explicitly to delete or reconcile',
  );
  return {
    origin: url.origin,
    secretKey,
    packageBucket,
    artifactBucket,
    mode: modeValue,
    batchSize: integerSetting(environment, 'AIQ_STORAGE_LIFECYCLE_BATCH_SIZE', 50, 1, 100),
    leaseSeconds: integerSetting(environment, 'AIQ_STORAGE_LIFECYCLE_LEASE_SECONDS', 300, 30, 900),
    graceSeconds: integerSetting(
      environment,
      'AIQ_STORAGE_RECONCILIATION_GRACE_SECONDS',
      86_400,
      3600,
      2_592_000,
    ),
    maximumObjects: integerSetting(
      environment,
      'AIQ_STORAGE_RECONCILIATION_MAX_OBJECTS',
      10_000,
      1,
      100_000,
    ),
    requestTimeoutMs: integerSetting(
      environment,
      'AIQ_STORAGE_REQUEST_TIMEOUT_MS',
      10_000,
      1000,
      30_000,
    ),
  };
}

function isSecretKey(value: string): boolean {
  return /^sb_secret_[A-Za-z0-9_-]{20,}(?![\s\S])/.test(value);
}

async function fetchWithDeadline(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  return fetchImplementation(input, {
    ...init,
    signal: AbortSignal.timeout(configuration.requestTimeoutMs),
  });
}

function serviceHeaders(configuration: LifecycleConfiguration): Record<string, string> {
  return {
    apikey: configuration.secretKey,
    'content-type': 'application/json',
  };
}

async function boundedJson(response: Response, context: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${context}_${response.status}`);
  const text = await response.text();
  assert.ok(text.length <= 4 * 1024 * 1024, `${context}_response_too_large`);
  return text.length === 0 ? null : JSON.parse(text);
}

async function rpc(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  name: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await fetchWithDeadline(
    configuration,
    fetchImplementation,
    `${configuration.origin}/rest/v1/rpc/${name}`,
    {
      method: 'POST',
      headers: serviceHeaders(configuration),
      body: JSON.stringify(parameters),
    },
  );
  return boundedJson(response, `rpc_${name}`);
}

function records(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), 'RPC result must be an array');
  return value.map((item) => {
    assert.ok(
      typeof item === 'object' && item !== null && !Array.isArray(item),
      'RPC row is invalid',
    );
    return item as Record<string, unknown>;
  });
}

function claimedObject(value: Record<string, unknown>): ClaimedObject {
  assert.ok(
    typeof value.object_id === 'string' &&
      uuidPattern.test(value.object_id) &&
      (value.object_type === 'submission_package' || value.object_type === 'runner_artifact') &&
      (value.artifact_kind === null || typeof value.artifact_kind === 'string') &&
      typeof value.bucket_name === 'string' &&
      (value.bucket_name === AIQ_SUBMISSION_PACKAGE_BUCKET ||
        value.bucket_name === AIQ_RUNNER_ARTIFACT_BUCKET) &&
      typeof value.object_path === 'string' &&
      typeof value.content_sha256 === 'string' &&
      digestPattern.test(value.content_sha256) &&
      typeof value.byte_size === 'number' &&
      Number.isSafeInteger(value.byte_size) &&
      value.byte_size >= 1 &&
      typeof value.lease_token === 'string' &&
      uuidPattern.test(value.lease_token) &&
      typeof value.lease_expires_at === 'string' &&
      !Number.isNaN(Date.parse(value.lease_expires_at)) &&
      typeof value.attempt === 'number' &&
      Number.isSafeInteger(value.attempt) &&
      value.attempt >= 1,
    'Storage deletion claim is invalid',
  );
  return value as unknown as ClaimedObject;
}

function expectedObjectPath(object: ClaimedObject, configuration: LifecycleConfiguration): boolean {
  if (object.object_type === 'submission_package') {
    return (
      object.bucket_name === configuration.packageBucket &&
      object.artifact_kind === null &&
      object.object_path === `sha256/${object.content_sha256}`
    );
  }
  return (
    object.bucket_name === configuration.artifactBucket &&
    typeof object.artifact_kind === 'string' &&
    artifactKinds.has(object.artifact_kind) &&
    object.object_path === `sha256/${object.content_sha256}/${object.artifact_kind}`
  );
}

async function deleteObject(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  object: ClaimedObject,
): Promise<'deleted' | 'not_found'> {
  assert.ok(
    expectedObjectPath(object, configuration),
    'Claimed object is outside the configured allowlist',
  );
  const response = await fetchWithDeadline(
    configuration,
    fetchImplementation,
    `${configuration.origin}/storage/v1/object/${encodeURIComponent(object.bucket_name)}`,
    {
      method: 'DELETE',
      headers: serviceHeaders(configuration),
      body: JSON.stringify({ prefixes: [object.object_path] }),
    },
  );
  if (response.status === 404) return 'not_found';
  if (!response.ok) throw new Error(`storage_delete_${response.status}`);
  await response.arrayBuffer();
  return 'deleted';
}

function sanitizedError(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(error.message))
    return error.message;
  return 'storage_delete_failed';
}

export async function runDeletion(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch = fetch,
): Promise<Record<string, number | string>> {
  let claimed = 0;
  let deleted = 0;
  let notFound = 0;
  let retried = 0;
  let rejected = 0;
  while (claimed < configuration.batchSize) {
    // Claim only the object that will be processed next. A lease for a later
    // object must not age while earlier Storage and acknowledgement requests run.
    const claimRows = records(
      // oxlint-disable-next-line no-await-in-loop -- Each bounded claim starts a fresh lease.
      await rpc(configuration, fetchImplementation, 'aiq_claim_storage_deletions', {
        max_rows: 1,
        requested_lease_seconds: configuration.leaseSeconds,
      }),
    );
    assert.ok(claimRows.length <= 1, 'Storage deletion claim exceeded the requested bound');
    const claim = claimRows[0];
    if (!claim) break;
    const object = claimedObject(claim);
    claimed += 1;
    try {
      if (!expectedObjectPath(object, configuration)) {
        rejected += 1;
        // oxlint-disable-next-line no-await-in-loop -- Retry state belongs to this exact rejected claim.
        await rpc(configuration, fetchImplementation, 'aiq_retry_storage_deletion', {
          target_object_id: object.object_id,
          supplied_lease_token: object.lease_token,
          supplied_error_code: 'object_outside_allowlist',
        });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Each claim must be acknowledged before the one-shot exits.
      const outcome = await deleteObject(configuration, fetchImplementation, object);
      const acknowledgement = {
        target_object_id: object.object_id,
        supplied_lease_token: object.lease_token,
        supplied_outcome: outcome,
      };
      try {
        // oxlint-disable-next-line no-await-in-loop -- Acknowledgement preserves deletion identity.
        await rpc(configuration, fetchImplementation, 'aiq_ack_storage_deletion', acknowledgement);
      } catch {
        // The database may have committed an acknowledgement whose HTTP response
        // was lost. Retry the exact operation so its idempotent result wins before
        // this worker attempts to return the still-live claim to retry state.
        // oxlint-disable-next-line no-await-in-loop -- This is one bounded exact retry.
        await rpc(configuration, fetchImplementation, 'aiq_ack_storage_deletion', acknowledgement);
      }
      if (outcome === 'deleted') deleted += 1;
      else notFound += 1;
    } catch (error) {
      retried += 1;
      // oxlint-disable-next-line no-await-in-loop -- Retry state belongs to this exact claim.
      await rpc(configuration, fetchImplementation, 'aiq_retry_storage_deletion', {
        target_object_id: object.object_id,
        supplied_lease_token: object.lease_token,
        supplied_error_code: sanitizedError(error),
      });
    }
  }
  return {
    event: 'aiq_storage_lifecycle',
    claimed,
    deleted,
    not_found: notFound,
    retried,
    rejected,
  };
}

function storageEntries(value: unknown): StorageListEntry[] {
  assert.ok(Array.isArray(value), 'Storage list result is invalid');
  return value.map((entry) => {
    assert.ok(
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      'Storage list entry is invalid',
    );
    const candidate = entry as Record<string, unknown>;
    assert.ok(
      typeof candidate.name === 'string' &&
        !candidate.name.includes('/') &&
        (candidate.id === null || typeof candidate.id === 'string'),
      'Storage list name is invalid',
    );
    return candidate as unknown as StorageListEntry;
  });
}

async function listPage(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  bucket: string,
  prefix: string,
  offset: number,
): Promise<StorageListEntry[]> {
  const response = await fetchWithDeadline(
    configuration,
    fetchImplementation,
    `${configuration.origin}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
    {
      method: 'POST',
      headers: serviceHeaders(configuration),
      body: JSON.stringify({
        prefix,
        limit: 1000,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      }),
    },
  );
  return storageEntries(await boundedJson(response, 'storage_list'));
}

async function listPrefix(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  bucket: string,
  prefix: string,
): Promise<StorageListEntry[]> {
  const result: StorageListEntry[] = [];
  for (let offset = 0; ; offset += 1000) {
    // oxlint-disable-next-line no-await-in-loop -- Supabase Storage list pagination is sequential.
    const page = await listPage(configuration, fetchImplementation, bucket, prefix, offset);
    result.push(...page);
    assert.ok(
      result.length <= configuration.maximumObjects,
      'Storage reconciliation object limit exceeded',
    );
    if (page.length < 1000) return result;
  }
}

async function listStorageObjects(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  bucket: string,
  artifactBucket: boolean,
): Promise<ObservedObject[]> {
  const root = await listPrefix(configuration, fetchImplementation, bucket, '');
  assert.ok(
    root.every((entry) => entry.name === 'sha256' && entry.id === null),
    'Storage bucket contains an unexpected top-level entry',
  );
  const firstLevel = await listPrefix(configuration, fetchImplementation, bucket, 'sha256');
  if (!artifactBucket) {
    assert.ok(
      firstLevel.every(
        (entry) =>
          digestPattern.test(entry.name) &&
          typeof entry.id === 'string' &&
          Number.isSafeInteger(entry.metadata?.size) &&
          (entry.metadata?.size ?? 0) > 0 &&
          (entry.metadata?.size ?? 0) <= 4_194_304,
      ),
      'package bucket contains a noncanonical object',
    );
    return firstLevel.map((entry) => ({
      path: `sha256/${entry.name}`,
      createdAt: entry.created_at,
      bytes: entry.metadata?.size ?? 0,
    }));
  }
  const result: ObservedObject[] = [];
  for (const directory of firstLevel) {
    assert.match(
      directory.name,
      digestPattern,
      'artifact bucket contains a noncanonical digest directory',
    );
    assert.equal(directory.id, null, 'artifact digest entry must be a directory');
    // oxlint-disable-next-line no-await-in-loop -- Each content-addressed directory is independently bounded.
    const children = await listPrefix(
      configuration,
      fetchImplementation,
      bucket,
      `sha256/${directory.name}`,
    );
    for (const child of children) {
      assert.ok(
        artifactKinds.has(child.name) &&
          typeof child.id === 'string' &&
          Number.isSafeInteger(child.metadata?.size) &&
          (child.metadata?.size ?? 0) > 0 &&
          (child.metadata?.size ?? 0) <= 4_194_304,
        'artifact bucket contains a noncanonical artifact kind',
      );
      result.push({
        path: `sha256/${directory.name}/${child.name}`,
        createdAt: child.created_at,
        bytes: child.metadata?.size ?? 0,
      });
      assert.ok(
        result.length <= configuration.maximumObjects,
        'Storage reconciliation object limit exceeded',
      );
    }
  }
  return result;
}

function registryObject(value: Record<string, unknown>): RegistryObject {
  assert.ok(
    typeof value.object_id === 'string' &&
      uuidPattern.test(value.object_id) &&
      typeof value.object_path === 'string' &&
      typeof value.content_sha256 === 'string' &&
      digestPattern.test(value.content_sha256) &&
      typeof value.byte_size === 'number' &&
      Number.isSafeInteger(value.byte_size) &&
      typeof value.lifecycle_state === 'string' &&
      typeof value.legal_hold === 'boolean' &&
      typeof value.active_references === 'number' &&
      Number.isSafeInteger(value.active_references),
    'Storage registry row is invalid',
  );
  return value as unknown as RegistryObject;
}

async function listRegistry(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  bucket: string,
): Promise<RegistryObject[]> {
  const result: RegistryObject[] = [];
  let afterPath: string | null = null;
  for (;;) {
    const page: RegistryObject[] = records(
      // oxlint-disable-next-line no-await-in-loop -- Keyset pagination is sequential.
      await rpc(configuration, fetchImplementation, 'aiq_list_storage_registry', {
        supplied_bucket: bucket,
        after_path: afterPath,
        max_rows: 1000,
      }),
    ).map(registryObject);
    result.push(...page);
    assert.ok(
      result.length <= configuration.maximumObjects,
      'Storage registry object limit exceeded',
    );
    if (page.length < 1000) return result;
    afterPath = page.at(-1)?.object_path ?? null;
  }
}

async function recordMismatch(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  bucket: string,
  path: string,
  mismatch: 'storage_only' | 'registry_only' | 'identity_mismatch',
  detail: string,
  eligibleAfter: string | null,
): Promise<void> {
  await rpc(configuration, fetchImplementation, 'aiq_record_storage_reconciliation', {
    supplied_bucket: bucket,
    supplied_path: path,
    supplied_mismatch_type: mismatch,
    supplied_detail_code: detail,
    supplied_eligible_after: eligibleAfter,
  });
}

async function promoteStorageOrphan(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  bucket: string,
  object: ObservedObject,
  artifact: boolean,
): Promise<boolean> {
  const parts = object.path.split('/');
  const digest = parts[1] ?? '';
  const artifactKind = artifact ? (parts[2] ?? null) : null;
  const promoted: unknown = await rpc(
    configuration,
    fetchImplementation,
    'aiq_promote_storage_orphan',
    {
      supplied_object_type: artifact ? 'runner_artifact' : 'submission_package',
      supplied_artifact_kind: artifactKind,
      supplied_bucket: bucket,
      supplied_path: object.path,
      supplied_sha256: digest,
      supplied_bytes: object.bytes,
    },
  );
  assert.ok(promoted === null || (typeof promoted === 'string' && uuidPattern.test(promoted)));
  return promoted !== null;
}

function reconciliationEvent(value: Record<string, unknown>): ReconciliationEvent {
  assert.ok(
    typeof value.object_path === 'string' &&
      /^sha256\/[0-9a-f]{64}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?(?![\s\S])/.test(
        value.object_path,
      ) &&
      (value.mismatch_type === 'storage_only' ||
        value.mismatch_type === 'registry_only' ||
        value.mismatch_type === 'identity_mismatch'),
    'Storage reconciliation row is invalid',
  );
  return value as unknown as ReconciliationEvent;
}

async function listReconciliationEvents(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  bucket: string,
): Promise<ReconciliationEvent[]> {
  const result: ReconciliationEvent[] = [];
  let afterPath: string | null = null;
  let afterMismatchType: string | null = null;
  for (;;) {
    const page: ReconciliationEvent[] = records(
      // oxlint-disable-next-line no-await-in-loop -- Keyset pagination is sequential.
      await rpc(configuration, fetchImplementation, 'aiq_list_storage_reconciliation', {
        supplied_bucket: bucket,
        after_path: afterPath,
        after_mismatch_type: afterMismatchType,
        max_rows: 1000,
      }),
    ).map(reconciliationEvent);
    result.push(...page);
    assert.ok(
      result.length <= configuration.maximumObjects,
      'Storage reconciliation event limit exceeded',
    );
    if (page.length < 1000) return result;
    const last: ReconciliationEvent | undefined = page.at(-1);
    afterPath = last?.object_path ?? null;
    afterMismatchType = last?.mismatch_type ?? null;
  }
}

async function resolveMismatch(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch,
  bucket: string,
  path: string,
): Promise<number> {
  const result: unknown = await rpc(
    configuration,
    fetchImplementation,
    'aiq_resolve_storage_reconciliation',
    { supplied_bucket: bucket, supplied_path: path },
  );
  assert.ok(typeof result === 'number' && Number.isSafeInteger(result) && result >= 0);
  return result;
}

export async function runReconciliation(
  configuration: LifecycleConfiguration,
  fetchImplementation: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<Record<string, number | string>> {
  let storageOnly = 0;
  let promoted = 0;
  let registryOnly = 0;
  let identityMismatch = 0;
  let resolved = 0;
  for (const [bucket, isArtifact] of [
    [configuration.packageBucket, false],
    [configuration.artifactBucket, true],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- Buckets have separate bounded inventories.
    const [storage, registry, reconciliation] = await Promise.all([
      listStorageObjects(configuration, fetchImplementation, bucket, isArtifact),
      listRegistry(configuration, fetchImplementation, bucket),
      listReconciliationEvents(configuration, fetchImplementation, bucket),
    ]);
    const storageByPath = new Map(storage.map((object) => [object.path, object]));
    const registryByPath = new Map(registry.map((object) => [object.object_path, object]));
    for (const object of storage) {
      const registered = registryByPath.get(object.path);
      if (!registered) {
        storageOnly += 1;
        const observed = object.createdAt ? Date.parse(object.createdAt) : now.getTime();
        const base = Number.isNaN(observed) ? now.getTime() : observed;
        // oxlint-disable-next-line no-await-in-loop -- Each durable mismatch has an exact identity.
        await recordMismatch(
          configuration,
          fetchImplementation,
          bucket,
          object.path,
          'storage_only',
          'unregistered_object',
          new Date(base + configuration.graceSeconds * 1000).toISOString(),
        );
        if (
          // oxlint-disable-next-line no-await-in-loop -- Promotion is gated by the locked durable grace event.
          await promoteStorageOrphan(configuration, fetchImplementation, bucket, object, isArtifact)
        )
          promoted += 1;
      } else if (registered.lifecycle_state === 'deleted') {
        identityMismatch += 1;
        // oxlint-disable-next-line no-await-in-loop -- Each durable mismatch has an exact identity.
        await recordMismatch(
          configuration,
          fetchImplementation,
          bucket,
          object.path,
          'identity_mismatch',
          'deleted_object_present',
          null,
        );
      } else if (object.bytes !== registered.byte_size) {
        identityMismatch += 1;
        // oxlint-disable-next-line no-await-in-loop -- Each durable mismatch has an exact identity.
        await recordMismatch(
          configuration,
          fetchImplementation,
          bucket,
          object.path,
          'identity_mismatch',
          'byte_size_mismatch',
          null,
        );
      } else {
        // oxlint-disable-next-line no-await-in-loop -- Parity resolves prior durable observations for this exact identity.
        resolved += await resolveMismatch(configuration, fetchImplementation, bucket, object.path);
      }
    }
    for (const object of registry) {
      if (object.lifecycle_state !== 'deleted' && !storageByPath.has(object.object_path)) {
        registryOnly += 1;
        // oxlint-disable-next-line no-await-in-loop -- Each durable mismatch has an exact identity.
        await recordMismatch(
          configuration,
          fetchImplementation,
          bucket,
          object.object_path,
          'registry_only',
          'object_missing',
          null,
        );
      }
    }
    for (const event of reconciliation) {
      const registered = registryByPath.get(event.object_path);
      if (
        !storageByPath.has(event.object_path) &&
        (!registered || registered.lifecycle_state === 'deleted')
      ) {
        // oxlint-disable-next-line no-await-in-loop -- Resolution is durable for this exact stale event identity.
        resolved += await resolveMismatch(
          configuration,
          fetchImplementation,
          bucket,
          event.object_path,
        );
      }
    }
  }
  return {
    event: 'aiq_storage_reconciliation',
    storage_only: storageOnly,
    promoted,
    registry_only: registryOnly,
    identity_mismatch: identityMismatch,
    resolved,
  };
}

export async function runLifecycle(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImplementation: typeof fetch = fetch,
): Promise<Record<string, number | string>> {
  const configuration = readLifecycleConfiguration(environment);
  return configuration.mode === 'delete'
    ? runDeletion(configuration, fetchImplementation)
    : runReconciliation(configuration, fetchImplementation);
}

async function main(): Promise<void> {
  try {
    const metrics = await runLifecycle();
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'aiq_storage_lifecycle_failed', error_code: sanitizedError(error) })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
