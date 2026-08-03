// JSON values are narrowed only after closed-schema validation at each command boundary.
// oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  buildCatalog,
  FIXED_MODEL_MATRIX_IDENTITIES,
  MODEL_EXECUTION_ID_MAPPING,
  RELEASE_GATE_POLICY,
  evaluateReleaseGate,
  releaseAuthorityDigest,
  releaseAuthoritySigningBytes,
  releaseAdmissionSigningBytes,
  releaseCellEvidenceBindingDigest,
  releaseEvidenceDigest,
  releaseEvidenceModelMatrixDigest,
  releaseEvidenceSourceDigest,
  releaseGateResultDigest,
  runtimePinnedReleaseGateTrustRoot,
  releaseModelIdMappingDigest,
  promotionReceiptSigningBytes,
  promotionReceiptIssuedAtIsCausal,
  verifyPromotionReceipt,
  type ReleaseGateAuthority,
  type ReleaseGateAdmission,
  type ReleaseGateEvidence,
  type ReleaseGateRawCell,
  type ReleaseGateTrustPolicy,
  type ReleaseGateTrustRoot,
  type PromotionReceipt,
} from './generate-benchmark-catalog.ts';

type JsonObject = Record<string, unknown>;

const MAX_LIFECYCLE_OUTPUT_BYTES = 256 * 1024 * 1024;

interface ReleasedManifest {
  readonly schema_version: 'aiq.released-manifest.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly release_status: 'released_by_verified_receipt';
  readonly candidate_catalog_release_identity_digest: string;
  readonly task_metadata_identity_digest: string;
  readonly receipt_digest: string;
  readonly released_at: string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Value is not canonical JSON.');
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

async function readJsonObject(path: string): Promise<JsonObject> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 256 * 1024 * 1024) {
    throw new Error(`${path} is not a bounded regular input file.`);
  }
  const source = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(source);
  if (!isObject(parsed)) throw new TypeError(`${path} must contain a JSON object.`);
  const canonical = canonicalJson(parsed);
  if (source !== canonical && source !== `${canonical}\n`) {
    throw new Error(`${path} must contain canonical JSON bytes.`);
  }
  return parsed;
}

async function readSchemaObject(path: string): Promise<JsonObject> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
    throw new Error(`${path} is not a bounded regular schema file.`);
  }
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isObject(parsed)) throw new TypeError(`${path} must contain a JSON object.`);
  return parsed;
}

function decodeCanonicalBase64(value: string, expectedLength: number): Buffer | undefined {
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === expectedLength && decoded.toString('base64') === value
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function errnoIs(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sameFileIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireLifecycleOutputMetadata(metadata: Stats, expectedSize?: number): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > MAX_LIFECYCLE_OUTPUT_BYTES ||
    (expectedSize !== undefined && metadata.size !== expectedSize)
  ) {
    throw new Error('Lifecycle output must be a bounded single-link mode-0600 regular file.');
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  const parent = dirname(resolve(path));
  const parentHandle = await open(parent, constants.O_RDONLY);
  try {
    await parentHandle.sync();
  } finally {
    await parentHandle.close();
  }
}

async function verifyExistingLifecycleOutput(path: string, expected: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error('Existing lifecycle output cannot be opened without following links.', {
      cause: error,
    });
  }
  try {
    const before = await handle.stat();
    requireLifecycleOutputMetadata(before);
    const observed = await handle.readFile();
    const after = await handle.stat();
    const pathMetadata = await lstat(path);
    requireLifecycleOutputMetadata(after);
    requireLifecycleOutputMetadata(pathMetadata);
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(before, pathMetadata) ||
      before.size !== expected.length ||
      after.size !== expected.length ||
      pathMetadata.size !== expected.length ||
      !observed.equals(expected)
    ) {
      throw new Error('Existing lifecycle output conflicts with the expected canonical bytes.');
    }
  } finally {
    await handle.close();
  }
}

async function unlinkCreatedLifecycleOutput(
  path: string,
  identity: { readonly dev: number; readonly ino: number },
): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.isFile() && current.nlink === 1 && sameFileIdentity(current, identity)) {
      await unlink(path);
      await syncParentDirectory(path);
    }
  } catch (error) {
    if (!errnoIs(error, 'ENOENT')) throw error;
  }
}

/** Creates one durable canonical lifecycle output or verifies an exact prior result. */
export async function writeJsonCreateOrVerify(path: string, value: unknown): Promise<void> {
  const expected = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (expected.length > MAX_LIFECYCLE_OUTPUT_BYTES) {
    throw new Error('Lifecycle output exceeds its byte limit.');
  }
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (errnoIs(error, 'EEXIST')) {
      await verifyExistingLifecycleOutput(path, expected);
      return;
    }
    throw error;
  }

  const created = await handle.stat();
  try {
    if (!created.isFile() || created.nlink !== 1 || created.size !== 0) {
      throw new Error('New lifecycle output is not a single-link empty regular file.');
    }
    await handle.chmod(0o600);
    const privateCreated = await handle.stat();
    requireLifecycleOutputMetadata(privateCreated, 0);
    if (!sameFileIdentity(created, privateCreated)) {
      throw new Error('Lifecycle output changed identity while permissions were set.');
    }
    await handle.writeFile(expected);
    await handle.sync();
    const completed = await handle.stat();
    const pathMetadata = await lstat(path);
    requireLifecycleOutputMetadata(completed, expected.length);
    requireLifecycleOutputMetadata(pathMetadata, expected.length);
    if (!sameFileIdentity(created, completed) || !sameFileIdentity(created, pathMetadata)) {
      throw new Error('Lifecycle output changed identity while it was created.');
    }
    await syncParentDirectory(path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkCreatedLifecycleOutput(path, created);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing ${name}.`);
  return value;
}

function privateKeyFromEnvironment(args: readonly string[]) {
  const environmentName = option(args, '--key-env');
  if (!/^[A-Z][A-Z0-9_]*$/u.test(environmentName)) {
    throw new Error('--key-env must name an uppercase environment variable.');
  }
  const keySource = process.env[environmentName];
  if (keySource === undefined || keySource.length === 0) {
    throw new Error(`Environment variable ${environmentName} is not set.`);
  }
  const key = createPrivateKey(keySource);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be Ed25519.');
  return key;
}

function resolveReference(root: JsonObject, reference: string): JsonObject {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported schema reference: ${reference}`);
  let value: unknown = root;
  for (const segment of reference.slice(2).split('/')) {
    if (!isObject(value)) throw new Error(`Invalid schema reference: ${reference}`);
    value = value[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  if (!isObject(value)) throw new Error(`Invalid schema reference: ${reference}`);
  return value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

export function matchesSchema(value: unknown, schema: JsonObject, root: JsonObject): boolean {
  if (typeof schema.$ref === 'string')
    return matchesSchema(value, resolveReference(root, schema.$ref), root);
  if ('const' in schema && canonicalJson(value) !== canonicalJson(schema.const)) return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))
  )
    return false;
  const declaredTypes = typeof schema.type === 'string' ? [schema.type] : schema.type;
  if (
    Array.isArray(declaredTypes) &&
    !declaredTypes.some((type) => typeof type === 'string' && matchesType(value, type))
  )
    return false;
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value))
      return false;
    if (
      schema.format === 'date-time' &&
      (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    )
      return false;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map(canonicalJson)).size !== value.length)
      return false;
    if (
      Array.isArray(schema.prefixItems) &&
      schema.prefixItems
        .slice(0, value.length)
        .some((item, index) => isObject(item) && !matchesSchema(value[index], item, root))
    )
      return false;
    if (
      isObject(schema.items) &&
      value
        .slice(Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0)
        .some((item) => !matchesSchema(item, schema.items as JsonObject, root))
    )
      return false;
    if (
      schema.items === false &&
      Array.isArray(schema.prefixItems) &&
      value.length > schema.prefixItems.length
    )
      return false;
  }
  if (isObject(value)) {
    if (
      Array.isArray(schema.required) &&
      schema.required.some((key) => typeof key === 'string' && !(key in value))
    )
      return false;
    const properties = schema.properties;
    if (
      schema.additionalProperties === false &&
      isObject(properties) &&
      Object.keys(value).some((key) => !(key in properties))
    )
      return false;
    if (
      isObject(properties) &&
      Object.entries(properties).some(
        ([key, child]) =>
          key in value && isObject(child) && !matchesSchema(value[key], child, root),
      )
    )
      return false;
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((item) => isObject(item) && matchesSchema(value, item, root))
  )
    return false;
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((item) => isObject(item) && matchesSchema(value, item, root)).length !== 1
  )
    return false;
  if (isObject(schema.if)) {
    const branch = matchesSchema(value, schema.if, root) ? schema.then : schema.else;
    if (isObject(branch) && !matchesSchema(value, branch, root)) return false;
  }
  return true;
}

const SCHEMA_DIRECTORY = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../../benchmarks/schema',
);

async function validateSchema(value: JsonObject, filename: string): Promise<void> {
  const loadedSchema = await readSchemaObject(resolve(SCHEMA_DIRECTORY, filename));
  let schema = loadedSchema;
  if (filename === 'release-gate-authority.schema.json') {
    const admissionSchema = await readSchemaObject(
      resolve(SCHEMA_DIRECTORY, 'release-gate-admission.schema.json'),
    );
    const properties = loadedSchema.properties;
    const loadedDefinitions = loadedSchema.$defs;
    const admissionDefinitions = admissionSchema.$defs;
    if (!isObject(properties) || !isObject(loadedDefinitions) || !isObject(admissionDefinitions)) {
      throw new Error('Release-authority schemas are malformed.');
    }
    schema = {
      ...loadedSchema,
      properties: { ...properties, admission: admissionSchema },
      $defs: { ...loadedDefinitions, ...admissionDefinitions },
    };
  }
  if (!matchesSchema(value, schema, schema)) throw new Error(`Input does not match ${filename}.`);
}

function keyFingerprint(privateKey: ReturnType<typeof createPrivateKey>): string {
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return `sha256:${createHash('sha256').update(publicKey).digest('hex')}`;
}

function assertTrustedPrivateKey(
  privateKey: ReturnType<typeof createPrivateKey>,
  keyId: string,
  trustPolicy: ReleaseGateTrustPolicy,
  role: 'authority' | 'promotion',
): void {
  const signers =
    role === 'authority' ? trustPolicy.authority_signers : trustPolicy.promotion_signers;
  const signer = signers.find(({ key_id: candidate }) => candidate === keyId);
  if (signer === undefined || signer.public_key_fingerprint !== keyFingerprint(privateKey)) {
    throw new Error(`The ${role} key does not match the trusted key_id and fingerprint.`);
  }
}

export async function assembleReleaseEvidence(
  authority: ReleaseGateAuthority,
  observations: Omit<
    ReleaseGateEvidence,
    | 'admission_digest'
    | 'authority_digest'
    | 'execution_plan_digest'
    | 'model_id_mapping_digest'
    | 'raw_cells'
    | 'schema_version'
    | 'source_observations_digest'
  > & {
    readonly schema_version:
      | 'aiq.release-gate-evidence.v1'
      | 'aiq.release-gate-source-observations.v1';
    readonly raw_cells: readonly Omit<
      ReleaseGateRawCell,
      'cell_evidence_binding_digest' | 'universe_slot'
    >[];
  },
  fixedEvidenceSchema?: JsonObject,
): Promise<ReleaseGateEvidence> {
  assertAdmissionPlan(authority.admission);
  const expectedObservationKeys = [
    'catalog_release_identity_digest',
    'collected_at',
    'corpus_commitment_digest',
    'model_matrix_digest',
    'paired_contrasts',
    'raw_cells',
    'release_identity',
    'repeat_ids',
    'schema_version',
    'task_metadata_identity_digest',
  ];
  if (
    !isObject(observations) ||
    canonicalJson(Object.keys(observations).toSorted()) !==
      canonicalJson(expectedObservationKeys.toSorted())
  ) {
    throw new Error('Observations must contain only the closed pre-assembly fields.');
  }
  const expectedCellKeys = [
    'attempts',
    'components',
    'domain',
    'evaluator_digest',
    'model_id',
    'repeat_id',
    'reported_score',
    'result_digest',
    'result_package_digest',
    'status',
    'task_id',
    'verification_digest',
    'verification_status',
  ];
  const rawCells = observations.raw_cells.map((cell, index): ReleaseGateRawCell => {
    if (
      !isObject(cell) ||
      canonicalJson(Object.keys(cell).toSorted()) !== canonicalJson(expectedCellKeys.toSorted())
    ) {
      throw new Error('Each observation cell must omit derived slot and binding fields.');
    }
    const unsignedCell = { universe_slot: index + 1, ...cell };
    return {
      ...unsignedCell,
      cell_evidence_binding_digest:
        cell.status === 'completed' ? releaseCellEvidenceBindingDigest(unsignedCell) : null,
    };
  });
  const evidence: ReleaseGateEvidence = {
    ...observations,
    schema_version: 'aiq.release-gate-evidence.v1',
    raw_cells: rawCells,
    admission_digest: authority.admission_digest,
    execution_plan_digest: authority.execution_plan_digest,
    model_id_mapping_digest: authority.model_id_mapping_digest,
    authority_digest: releaseAuthorityDigest(authority),
    source_observations_digest: releaseEvidenceSourceDigest(
      rawCells,
      observations.paired_contrasts,
    ),
  };
  if (fixedEvidenceSchema === undefined) {
    await validateSchema(evidence as unknown as JsonObject, 'release-gate-evidence.schema.json');
  } else if (
    !matchesSchema(evidence as unknown as JsonObject, fixedEvidenceSchema, fixedEvidenceSchema)
  ) {
    throw new Error('Input does not match release-gate-evidence.schema.json.');
  }
  assertAdmissionCompleteness(authority, evidence);
  const contractResult = evaluateReleaseGate(
    evidence,
    authority,
    {
      schema_version: 'aiq.release-gate-trust.v1',
      release_identity: 'aiq-core/1.0.2',
      authority_signers: [],
      promotion_signers: [],
    },
    {
      schema_version: 'aiq.release-gate-trust-root.v1',
      release_identity: 'aiq-core/1.0.2',
      trust_policy_digest: `sha256:${'f'.repeat(64)}`,
    },
  );
  if (contractResult.failures.includes('invalid_evidence')) {
    throw new Error('Observations violate the signed admission or release-evidence contract.');
  }
  return evidence;
}

function assertAdmissionCompleteness(
  authority: ReleaseGateAuthority,
  evidence: ReleaseGateEvidence,
): void {
  const admission = authority.admission;
  const repeatIds = admission.repeat_schedule.map(({ repeat_id: repeatId }) => repeatId);
  if (canonicalJson(evidence.repeat_ids) !== canonicalJson(repeatIds)) {
    throw new Error('Evidence repeats do not exactly match the signed admission.');
  }
  const expectedCellKeys = repeatIds.flatMap((repeatId) =>
    admission.observation_universe.task_ids.flatMap((taskId) =>
      admission.observation_universe.model_ids.map(
        (modelId) => `${repeatId}\u0000${taskId}\u0000${modelId}`,
      ),
    ),
  );
  const observedCellKeys = evidence.raw_cells.map(
    ({ repeat_id: repeatId, task_id: taskId, model_id: modelId }) =>
      `${repeatId}\u0000${taskId}\u0000${modelId}`,
  );
  if (canonicalJson(observedCellKeys) !== canonicalJson(expectedCellKeys)) {
    throw new Error('Raw cells are missing, duplicated, reordered, or outside the admission.');
  }
  const expectedPairKeys = repeatIds.flatMap((repeatId) =>
    admission.observation_universe.model_ids.map((modelId) => `${repeatId}\u0000${modelId}`),
  );
  if (
    evidence.paired_contrasts.length !== admission.contrast_bindings.length ||
    evidence.paired_contrasts.some((contrast, index) => {
      const binding = admission.contrast_bindings[index];
      return (
        binding === undefined ||
        contrast.contrast_id !== binding.contrast_id ||
        contrast.reference_variant_digest !== binding.reference_variant_digest ||
        contrast.challenge_variant_digest !== binding.challenge_variant_digest ||
        canonicalJson(
          contrast.pairs.map(
            ({ repeat_id: repeatId, model_id: modelId }) => `${repeatId}\u0000${modelId}`,
          ),
        ) !== canonicalJson(expectedPairKeys)
      );
    })
  ) {
    throw new Error(
      'Contrast observations are missing, duplicated, reordered, or outside the admission.',
    );
  }
}

function expectedArmOrder(repeatIndex: number): readonly string[] {
  return RELEASE_GATE_POLICY.predeclared_contrasts.flatMap(({ contrast_id: contrastId }) =>
    repeatIndex % 2 === 0
      ? [`${contrastId}:reference`, `${contrastId}:challenge`]
      : [`${contrastId}:challenge`, `${contrastId}:reference`],
  );
}

function assertAdmissionPlan(admission: ReleaseGateAdmission): void {
  const catalog = buildCatalog();
  const repeatIds = admission.repeat_schedule.map(({ repeat_id: repeatId }) => repeatId);
  const taskIds = catalog.tasks.map(({ task_id: taskId }) => taskId);
  const modelIds = admission.model_matrix.configurations.map(({ model_id: modelId }) => modelId);
  const expectedModelIds = FIXED_MODEL_MATRIX_IDENTITIES.map(({ model_id: modelId }) => modelId);
  if (
    admission.catalog_release_identity_digest !== catalog.catalog_release_identity.digest ||
    admission.task_metadata_identity_digest !== catalog.task_metadata_identity.digest ||
    !Number.isFinite(Date.parse(admission.issued_at)) ||
    Date.parse(admission.issued_at) >= Date.parse(admission.collection_not_before) ||
    Date.parse(admission.collection_not_before) >= Date.parse(admission.collection_not_after) ||
    repeatIds.length !== 3 ||
    new Set(repeatIds).size !== repeatIds.length ||
    admission.repeat_schedule.some(
      ({ scheduled_at: scheduledAt, contrast_arm_order: armOrder }, index) =>
        Date.parse(scheduledAt) < Date.parse(admission.collection_not_before) ||
        Date.parse(scheduledAt) > Date.parse(admission.collection_not_after) ||
        canonicalJson(armOrder) !== canonicalJson(expectedArmOrder(index)),
    ) ||
    canonicalJson(admission.observation_universe.task_ids) !== canonicalJson(taskIds) ||
    canonicalJson(admission.observation_universe.model_ids) !== canonicalJson(expectedModelIds) ||
    canonicalJson(modelIds) !== canonicalJson(expectedModelIds) ||
    canonicalJson(
      admission.model_matrix.configurations.map(
        ({ model_id: canonicalModelId, execution_model_id: executionModelId }) => ({
          canonical_model_id: canonicalModelId,
          execution_model_id: executionModelId,
        }),
      ),
    ) !== canonicalJson(MODEL_EXECUTION_ID_MAPPING) ||
    admission.model_matrix.digest !==
      releaseEvidenceModelMatrixDigest(admission.model_matrix.configurations) ||
    admission.model_id_mapping_digest !== releaseModelIdMappingDigest() ||
    admission.observation_universe.raw_cell_count !== 72 * 17 * 3 ||
    admission.observation_universe.contrast_pair_count !== 3 * 17 * 3 ||
    admission.observation_universe.contrast_observation_count !== 3 * 2 * 17 * 3 ||
    canonicalJson(admission.contrast_bindings.map(({ contrast_id: contrastId }) => contrastId)) !==
      canonicalJson(
        RELEASE_GATE_POLICY.predeclared_contrasts.map(({ contrast_id: contrastId }) => contrastId),
      ) ||
    new Set(
      admission.contrast_bindings.flatMap(
        ({ reference_variant_digest: reference, challenge_variant_digest: challenge }) => [
          reference,
          challenge,
        ],
      ),
    ).size !== 6
  ) {
    throw new Error('Admission plan does not match the immutable candidate universe and policy.');
  }
}

export function issuePromotionReceipt(
  evidence: ReleaseGateEvidence,
  authority: ReleaseGateAuthority,
  trustPolicy: ReleaseGateTrustPolicy,
  trustRoot: ReleaseGateTrustRoot,
  keyId: string,
  issuedAt: string,
  privateKey: ReturnType<typeof createPrivateKey>,
): PromotionReceipt {
  const result = evaluateReleaseGate(evidence, authority, trustPolicy, trustRoot);
  if (!result.passed) throw new Error(`Release gate failed: ${result.failures.join(', ')}`);
  if (!promotionReceiptIssuedAtIsCausal(issuedAt, evidence.collected_at)) {
    throw new Error(
      '--issued-at must be a canonical ISO timestamp that does not precede evidence collection.',
    );
  }
  const catalog = buildCatalog();
  const unsigned: PromotionReceipt = {
    schema_version: 'aiq.promotion-receipt.v1',
    signature_domain: 'aiq.promotion-receipt.v1',
    signature_encoding: 'aiq.sorted-key-json.v1',
    release_identity: 'aiq-core/1.0.2',
    candidate_catalog_release_identity_digest: catalog.catalog_release_identity.digest,
    task_metadata_identity_digest: catalog.task_metadata_identity.digest,
    authority_digest: releaseAuthorityDigest(authority),
    evidence_digest: releaseEvidenceDigest(evidence),
    gate_result_digest: releaseGateResultDigest(result),
    promotion_state: 'released',
    issued_at: issuedAt,
    signer: { key_id: keyId, algorithm: 'ed25519' },
    signature: '',
  };
  return {
    ...unsigned,
    signature: sign(null, promotionReceiptSigningBytes(unsigned), privateKey).toString('base64'),
  };
}

function buildReleasedManifest(receipt: PromotionReceipt): ReleasedManifest {
  return {
    schema_version: 'aiq.released-manifest.v1',
    release_identity: 'aiq-core/1.0.2',
    release_status: 'released_by_verified_receipt',
    candidate_catalog_release_identity_digest: receipt.candidate_catalog_release_identity_digest,
    task_metadata_identity_digest: receipt.task_metadata_identity_digest,
    receipt_digest: digest(receipt),
    released_at: receipt.issued_at,
  };
}

async function lifecycleContext(args: readonly string[]) {
  const authorityJson = await readJsonObject(option(args, '--authority'));
  const evidenceJson = await readJsonObject(option(args, '--evidence'));
  const { trustPolicy, trustRoot } = await runtimePinnedTrust(args);
  await validateSchema(authorityJson, 'release-gate-authority.schema.json');
  await validateSchema(evidenceJson, 'release-gate-evidence.schema.json');
  const authority = authorityJson as unknown as ReleaseGateAuthority;
  await validateSchema(
    authority.admission as unknown as JsonObject,
    'release-gate-admission.schema.json',
  );
  return {
    authority,
    evidence: evidenceJson as unknown as ReleaseGateEvidence,
    trustPolicy,
    trustRoot,
  };
}

async function runtimePinnedTrust(args: readonly string[]): Promise<{
  readonly trustPolicy: ReleaseGateTrustPolicy;
  readonly trustRoot: ReleaseGateTrustRoot;
}> {
  const trustPolicyJson = await readJsonObject(option(args, '--trust-policy'));
  await validateSchema(trustPolicyJson, 'release-gate-trust-policy.schema.json');
  const trustPolicy = trustPolicyJson as unknown as ReleaseGateTrustPolicy;
  const trustRoot = runtimePinnedReleaseGateTrustRoot(trustPolicy);
  if (args.includes('--trust-root')) {
    throw new Error(
      '--trust-root is not accepted; the runtime independently pins the trust-policy digest.',
    );
  }
  return { trustPolicy, trustRoot };
}

export async function runCandidateReleaseCli(args: readonly string[]): Promise<void> {
  const [command] = args;
  if (command === 'schema-validate') {
    const schema = await readSchemaObject(option(args, '--schema'));
    const input = await readJsonObject(option(args, '--input'));
    if (!matchesSchema(input, schema, schema)) throw new Error('Input does not match the schema.');
    return;
  }
  if (command === 'sign-authority') {
    const input = await readJsonObject(option(args, '--input'));
    const { trustPolicy } = await runtimePinnedTrust(args);
    const admission = input.admission;
    if (!isObject(admission)) throw new Error('Authority must embed the signed admission.');
    await validateSchema(admission, 'release-gate-admission.schema.json');
    const admissionDocument = admission as unknown as ReleaseGateAdmission;
    assertAdmissionPlan(admissionDocument);
    const admissionSigner = trustPolicy.authority_signers.find(
      ({ key_id: keyId }) => keyId === admissionDocument.signer.key_id,
    );
    const admissionPublicKey =
      admissionSigner === undefined
        ? undefined
        : decodeCanonicalBase64(admissionSigner.public_key_spki_base64, 44);
    const admissionSignature = decodeCanonicalBase64(admissionDocument.signature, 64);
    if (
      admissionSigner === undefined ||
      admissionPublicKey === undefined ||
      admissionSignature === undefined ||
      !verify(
        null,
        releaseAdmissionSigningBytes(admissionDocument),
        createPublicKey({
          key: admissionPublicKey,
          format: 'der',
          type: 'spki',
        }),
        admissionSignature,
      )
    )
      throw new Error('Admission signature is not trusted.');
    const unsigned = { ...input, signature: '' } as unknown as ReleaseGateAuthority;
    await validateSchema(
      { ...input, signature: `${'A'.repeat(86)}==` },
      'release-gate-authority.schema.json',
    );
    const privateKey = privateKeyFromEnvironment(args);
    assertTrustedPrivateKey(privateKey, unsigned.signer.key_id, trustPolicy, 'authority');
    const signed = {
      ...unsigned,
      signature: sign(null, releaseAuthoritySigningBytes(unsigned), privateKey).toString('base64'),
    };
    await validateSchema(signed as unknown as JsonObject, 'release-gate-authority.schema.json');
    await writeJsonCreateOrVerify(option(args, '--output'), signed);
    return;
  }
  if (command === 'sign-admission') {
    const input = await readJsonObject(option(args, '--input'));
    const { trustPolicy } = await runtimePinnedTrust(args);
    const unsigned = { ...input, signature: '' } as unknown as ReleaseGateAdmission;
    await validateSchema(
      { ...input, signature: `${'A'.repeat(86)}==` },
      'release-gate-admission.schema.json',
    );
    assertAdmissionPlan(unsigned);
    const privateKey = privateKeyFromEnvironment(args);
    assertTrustedPrivateKey(privateKey, unsigned.signer.key_id, trustPolicy, 'authority');
    const signed = {
      ...unsigned,
      signature: sign(null, releaseAdmissionSigningBytes(unsigned), privateKey).toString('base64'),
    };
    await validateSchema(signed as unknown as JsonObject, 'release-gate-admission.schema.json');
    await writeJsonCreateOrVerify(option(args, '--output'), signed);
    return;
  }
  if (command === 'assemble') {
    const authorityJson = await readJsonObject(option(args, '--authority'));
    const observations = (await readJsonObject(
      option(args, '--observations'),
    )) as unknown as Parameters<typeof assembleReleaseEvidence>[1];
    await validateSchema(authorityJson, 'release-gate-authority.schema.json');
    const authority = authorityJson as unknown as ReleaseGateAuthority;
    await validateSchema(
      authority.admission as unknown as JsonObject,
      'release-gate-admission.schema.json',
    );
    const assembled = await assembleReleaseEvidence(authority, observations);
    assertAdmissionCompleteness(authority, assembled);
    const { trustPolicy, trustRoot } = await runtimePinnedTrust(args);
    const result = evaluateReleaseGate(assembled, authority, trustPolicy, trustRoot);
    if (
      result.failures.includes('invalid_authority') ||
      result.failures.includes('invalid_evidence')
    ) {
      throw new Error(`Admission or observations are invalid: ${result.failures.join(', ')}`);
    }
    await writeJsonCreateOrVerify(option(args, '--output'), assembled);
    return;
  }
  if (command === 'validate' || command === 'evaluate') {
    const context = await lifecycleContext(args);
    const result = evaluateReleaseGate(
      context.evidence,
      context.authority,
      context.trustPolicy,
      context.trustRoot,
    );
    if (command === 'validate') {
      if (!result.passed)
        throw new Error(`Release data is invalid or fails the gate: ${result.failures.join(', ')}`);
    } else {
      await validateSchema(result as unknown as JsonObject, 'release-gate-result.schema.json');
      await writeJsonCreateOrVerify(option(args, '--output'), result);
    }
    return;
  }
  if (command === 'issue-receipt') {
    const context = await lifecycleContext(args);
    const privateKey = privateKeyFromEnvironment(args);
    const keyId = option(args, '--key-id');
    assertTrustedPrivateKey(privateKey, keyId, context.trustPolicy, 'promotion');
    const receipt = issuePromotionReceipt(
      context.evidence,
      context.authority,
      context.trustPolicy,
      context.trustRoot,
      keyId,
      option(args, '--issued-at'),
      privateKey,
    );
    if (
      !verifyPromotionReceipt(
        receipt,
        context.evidence,
        context.authority,
        context.trustPolicy,
        context.trustRoot,
      )
    )
      throw new Error('New receipt failed immediate verification.');
    await validateSchema(receipt as unknown as JsonObject, 'promotion-receipt.schema.json');
    await writeJsonCreateOrVerify(option(args, '--output'), receipt);
    return;
  }
  if (command === 'release-manifest' || command === 'verify-manifest') {
    const context = await lifecycleContext(args);
    const receipt = (await readJsonObject(
      option(args, '--receipt'),
    )) as unknown as PromotionReceipt;
    await validateSchema(receipt as unknown as JsonObject, 'promotion-receipt.schema.json');
    if (
      !verifyPromotionReceipt(
        receipt,
        context.evidence,
        context.authority,
        context.trustPolicy,
        context.trustRoot,
      )
    )
      throw new Error('Receipt is invalid.');
    const expected = buildReleasedManifest(receipt);
    if (command === 'release-manifest') {
      await validateSchema(expected as unknown as JsonObject, 'released-manifest.schema.json');
      await writeJsonCreateOrVerify(option(args, '--output'), expected);
    } else {
      const manifest = await readJsonObject(option(args, '--manifest'));
      await validateSchema(manifest, 'released-manifest.schema.json');
      if (canonicalJson(manifest) !== canonicalJson(expected))
        throw new Error('Released manifest is invalid.');
    }
    return;
  }
  throw new Error(
    'Expected schema-validate, sign-admission, sign-authority, assemble, validate, evaluate, issue-receipt, release-manifest, or verify-manifest.',
  );
}

if (import.meta.main) {
  await runCandidateReleaseCli(process.argv.slice(2));
}
