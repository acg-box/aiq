import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

import { AIQ_CORE_SCORING_VERSION } from '../aiq-core-contract.ts';
import { isOfficialRunProvenance, isRunProvenance, type RunProvenance } from './run-provenance.ts';

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, typescript/restrict-template-expressions -- Exact validators narrow untrusted JSON one field at a time. */

export const MAX_RAW_SUBMISSION_BYTES = 4 * 1024 * 1024;
export const MAX_SIGNED_PACKAGE_BYTES = 3_948_544;
export const RESULT_PACKAGE_SCHEMA = 'aiq.result-package.v3';
export const RUN_PAYLOAD_TYPE = 'aiq.run.v3';
export const CALIBRATION_RUN_PAYLOAD_TYPE = 'aiq.calibration-run.v3';
export const RESULT_SCHEMA = 'aiq.result.v2';
export const OFFICIAL_SCORING_VERSION = AIQ_CORE_SCORING_VERSION;
export const EVALUATOR_RESULTS_ARTIFACT_MAX_BYTES = 3_948_544;
export const MAX_RESULTS = 1_224;
export const MAX_MODELS = 17;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 100_000;
export const MAX_OBJECT_PROPERTIES = 256;
export const MAX_ARRAY_ITEMS = 1_224;
export const MAX_STRING_LENGTH = 65_536;
export const MAX_PROPERTY_NAME_LENGTH = 256;

const runKeyPattern = /^run_[a-f0-9]{64}(?![\s\S])/;
const contentHashPattern = /^sha256:(?!0{64}(?![\s\S]))[a-f0-9]{64}(?![\s\S])/;
const publicKeyPattern = /^[a-f0-9]{64}(?![\s\S])/;
const nodeIdPattern = /^node_[a-f0-9]{64}(?![\s\S])/;
const signaturePattern = /^[a-f0-9]{128}(?![\s\S])/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const topLevelKeys = [
  'claimed_trust',
  'content_hash',
  'idempotency_key',
  'payload',
  'payload_type',
  'schema_version',
  'signature',
  'signer',
] as const;
const signerKeys = ['node_id', 'public_key'] as const;
const artifactReferenceKeys = ['bytes', 'content_hash', 'kind', 'uri'] as const;
const taskResultKeys = [
  'artifacts',
  'evaluation',
  'evaluator_result_sha256',
  'evaluator_stdout_sha256',
  'failure',
  'latency',
  'model',
  'provenance',
  'response',
  'response_sha256',
  'result_id',
  'run_id',
  'schema_version',
  'status',
  'task_hash',
  'task_id',
  'task_score',
  'task_version',
  'tool_usage',
  'workspace_manifest',
] as const;
const runPayloadKeys = [
  'capability_validation',
  'evaluator_results_artifact',
  'execution_concurrency',
  'finished_unix_ms',
  'models',
  'provenance',
  'results',
  'run_id',
  'schedule_slot',
  'schema_version',
  'scoring_version',
  'started_unix_ms',
  'synthetic',
  'task_set_hash',
] as const;
const calibrationRunPayloadKeys = [
  'capability_validation',
  'classification',
  'evaluator_results_artifact',
  'execution_concurrency',
  'finished_unix_ms',
  'models',
  'official_eligible',
  'provenance',
  'results',
  'run_id',
  'schedule_slot',
  'schema_version',
  'scoring_version',
  'started_unix_ms',
  'task_ids',
  'task_set_hash',
] as const;
const scheduleSlotKeys = ['local_date', 'local_time', 'occurrence', 'timezone'] as const;
const modelConfigKeys = ['family', 'reasoning_effort'] as const;
const resultFailureKeys = ['exit_code', 'kind', 'message', 'retryable'] as const;
const latencyKeys = ['wall_ms'] as const;
const toolUsageKeys = ['by_tool', 'steps', 'total_calls'] as const;
const resultProvenanceKeys = [
  'codex_version',
  'local_trust',
  'node_id',
  'observed_at',
  'runner_version',
  'synthetic',
] as const;
const capabilityReportKeys = [
  'authentication_probe',
  'cli_probe',
  'manifest_issues',
  'models',
  'node_id',
  'schema_version',
] as const;
const cliProbeKeys = ['failure', 'status', 'version'] as const;
const authenticationProbeKeys = ['failure', 'mode', 'status'] as const;
const capabilityEntryKeys = ['model', 'probe', 'reason', 'status'] as const;
const configurationProbeKeys = [
  'artifacts',
  'codex_version',
  'evidence_digest',
  'failure',
  'observed_at',
  'result_digest',
  'result_preview',
  'status',
] as const;
const adapterFailureKeys = [
  'artifacts',
  'exit_code',
  'kind',
  'message',
  'stderr',
  'stderr_truncated',
  'stdout_truncated',
] as const;

const modelMatrix = [
  ['sol', 'low'],
  ['sol', 'medium'],
  ['sol', 'high'],
  ['sol', 'xhigh'],
  ['sol', 'max'],
  ['sol', 'ultra'],
  ['terra', 'low'],
  ['terra', 'medium'],
  ['terra', 'high'],
  ['terra', 'xhigh'],
  ['terra', 'max'],
  ['terra', 'ultra'],
  ['luna', 'low'],
  ['luna', 'medium'],
  ['luna', 'high'],
  ['luna', 'xhigh'],
  ['luna', 'max'],
] as const;
const modelMatrixKeys = modelMatrix.map(([family, effort]) => `${family}:${effort}`);
const identifierPattern = /^[A-Za-z0-9._-]+(?![\s\S])/;
const unixMillisPattern = /^unix-ms:[0-9]{1,39}(?![\s\S])/;
const resultIdPattern = /^result_[a-f0-9]{64}(?![\s\S])/;
const safeAsciiPattern = /^[\x20-\x21\x23-\x5b\x5d-\x7e]+(?![\s\S])/;
const scheduleSlotValidity = new Map<string, boolean>();

export interface ContentAddressedArtifactReference<Kind extends string> {
  readonly kind: Kind;
  readonly content_hash: string;
  readonly uri: string;
  readonly bytes: number;
}

export type EvaluatorResultsArtifactReference =
  ContentAddressedArtifactReference<'evaluator-results.json'>;

export type ResultArtifactReference = ContentAddressedArtifactReference<
  'stdout.jsonl' | 'stderr.txt' | 'final-response.txt' | 'workspace-snapshot.json'
>;

export type WorkspaceManifestArtifactReference =
  ContentAddressedArtifactReference<'workspace-manifest.json'>;

export interface SignedModelConfig {
  readonly family: 'sol' | 'terra' | 'luna';
  readonly reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
}

export interface SignedTaskResult {
  readonly schema_version: typeof RESULT_SCHEMA;
  readonly result_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly task_version: string;
  readonly task_hash: string;
  readonly model: SignedModelConfig;
  readonly status: 'completed' | 'failed' | 'unsupported' | 'unevaluated';
  readonly evaluation: 'correct' | 'partial' | 'incorrect' | 'not_evaluated';
  readonly task_score: number | null;
  readonly response: string | null;
  readonly response_sha256: string | null;
  readonly evaluator_result_sha256: string | null;
  readonly evaluator_stdout_sha256: string | null;
  readonly artifacts: readonly ResultArtifactReference[];
  readonly failure: Readonly<{
    kind:
      | 'spawn'
      | 'timeout'
      | 'unsupported_model'
      | 'authentication'
      | 'subscription_limit'
      | 'non_zero_exit'
      | 'capability_unavailable'
      | 'capability_validation_failed'
      | 'missing_evaluator'
      | 'missing_response'
      | 'evaluator_failure'
      | 'budget_exceeded'
      | 'output_truncated'
      | 'workspace_unavailable'
      | 'workspace_integrity';
    readonly message: string;
    readonly exit_code: number | null;
    readonly retryable: boolean;
  }> | null;
  readonly latency: Readonly<{ wall_ms: number }>;
  readonly tool_usage: Readonly<{
    readonly steps: number;
    readonly total_calls: number;
    readonly by_tool: Readonly<Record<string, number>>;
  }>;
  readonly workspace_manifest: WorkspaceManifestArtifactReference | null;
  readonly provenance: Readonly<{
    readonly node_id: string;
    readonly runner_version: string;
    readonly codex_version: string;
    readonly observed_at: string;
    readonly synthetic: boolean;
    readonly local_trust: 'trusted' | 'untrusted';
  }>;
}

export interface OfficialResultPackageEnvelope {
  readonly schema_version: typeof RESULT_PACKAGE_SCHEMA;
  readonly idempotency_key: string;
  readonly payload_type: typeof RUN_PAYLOAD_TYPE;
  readonly content_hash: string;
  readonly signer: {
    readonly node_id: string;
    readonly public_key: string;
  };
  readonly claimed_trust: 'trusted' | 'untrusted';
  readonly payload: Readonly<Record<string, unknown>> & {
    readonly schema_version: typeof RUN_PAYLOAD_TYPE;
    readonly run_id: string;
    readonly synthetic: boolean;
    readonly provenance: RunProvenance | null;
    readonly evaluator_results_artifact: EvaluatorResultsArtifactReference;
    readonly execution_concurrency: number;
    readonly models: readonly SignedModelConfig[];
    readonly results: readonly SignedTaskResult[];
  };
  readonly signature: string;
}

export interface CalibrationResultPackageEnvelope {
  readonly schema_version: typeof RESULT_PACKAGE_SCHEMA;
  readonly idempotency_key: string;
  readonly payload_type: typeof CALIBRATION_RUN_PAYLOAD_TYPE;
  readonly content_hash: string;
  readonly signer: { readonly node_id: string; readonly public_key: string };
  readonly claimed_trust: 'untrusted';
  readonly payload: Readonly<Record<string, unknown>> & {
    readonly schema_version: typeof CALIBRATION_RUN_PAYLOAD_TYPE;
    readonly official_eligible: false;
    readonly classification: 'local_calibration_non_official';
    readonly run_id: string;
    readonly provenance: RunProvenance & { readonly run_class: 'calibration' };
    readonly evaluator_results_artifact: EvaluatorResultsArtifactReference;
    readonly execution_concurrency: number;
    readonly models: readonly SignedModelConfig[];
    readonly task_ids: readonly string[];
    readonly results: readonly SignedTaskResult[];
  };
  readonly signature: string;
}

export type ResultPackageEnvelope =
  | OfficialResultPackageEnvelope
  | CalibrationResultPackageEnvelope;

function evaluatorResultsArtifactReference(
  value: unknown,
): EvaluatorResultsArtifactReference | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, artifactReferenceKeys) ||
    value.kind !== 'evaluator-results.json' ||
    typeof value.content_hash !== 'string' ||
    !contentHashPattern.test(value.content_hash) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > EVALUATOR_RESULTS_ARTIFACT_MAX_BYTES ||
    value.uri !==
      `aiq-artifact://sha256/${value.content_hash.slice('sha256:'.length)}/evaluator-results.json`
  ) {
    return null;
  }
  return {
    kind: 'evaluator-results.json',
    content_hash: value.content_hash,
    uri: value.uri,
    bytes: value.bytes,
  };
}

export interface ValidatedSubmission {
  schemaVersion: typeof RESULT_PACKAGE_SCHEMA;
  idempotencyKey: string;
  envelope: ResultPackageEnvelope;
}

export interface SubmissionReceipt {
  receivedAt: string;
  packageSha256: string;
  bodyBytes: number;
}

export interface SubmissionObjectIdentity {
  bucket: string;
  key: string;
  contentSha256: string;
  bytes: number;
}

export type ValidationResult =
  | { ok: true; submission: ValidatedSubmission }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isU32(value: unknown): value is number {
  return isSafeUnsignedInteger(value) && value <= 0xffff_ffff;
}

function isBoundedIdentifier(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    identifierPattern.test(value)
  );
}

function isBoundedSafeAscii(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    safeAsciiPattern.test(value)
  );
}

function modelKey(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, modelConfigKeys) ||
    typeof value.family !== 'string' ||
    typeof value.reasoning_effort !== 'string'
  ) {
    return null;
  }
  const key = `${value.family}:${value.reasoning_effort}`;
  return modelMatrixKeys.includes(key) ? key : null;
}

function isExactModelMatrix(value: unknown): value is readonly unknown[] {
  return (
    Array.isArray(value) &&
    value.length === modelMatrixKeys.length &&
    value.every((model, index) => modelKey(model) === modelMatrixKeys[index])
  );
}

function isScheduleSlot(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, scheduleSlotKeys) ||
    typeof value.local_date !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?![\s\S])/.test(value.local_date) ||
    (value.occurrence !== 'day' && value.occurrence !== 'night') ||
    typeof value.local_time !== 'string' ||
    !/^(?:[01][0-9]|2[0-3]):[0-5][0-9](?![\s\S])/.test(value.local_time) ||
    typeof value.timezone !== 'string'
  ) {
    return false;
  }
  const [year, month, day] = value.local_date.split('-').map(Number);
  if (year === undefined || year === 0 || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }
  try {
    const cacheKey = `${value.local_date}\0${value.local_time}\0${value.timezone}`;
    const cached = scheduleSlotValidity.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: value.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const [hour, minute] = value.local_time.split(':').map(Number);
    const approximate = Date.UTC(year, month - 1, day, hour, minute);
    let matches = 0;
    for (
      let timestamp = approximate - 16 * 60 * 60 * 1_000;
      timestamp <= approximate + 16 * 60 * 60 * 1_000;
      timestamp += 60 * 1_000
    ) {
      if (timestamp < 0) {
        continue;
      }
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(timestamp))
          .filter(({ type }) => type !== 'literal')
          .map(({ type, value: part }) => [type, part]),
      );
      if (
        parts.year === String(year).padStart(4, '0') &&
        parts.month === String(month).padStart(2, '0') &&
        parts.day === String(day).padStart(2, '0') &&
        parts.hour === String(hour).padStart(2, '0') &&
        parts.minute === String(minute).padStart(2, '0')
      ) {
        matches += 1;
        if (matches > 1) {
          break;
        }
      }
    }
    const valid = matches === 1;
    scheduleSlotValidity.set(cacheKey, valid);
    return valid;
  } catch {
    return false;
  }
}

function artifactReference(
  value: unknown,
  allowedKinds: readonly string[],
  maximumBytes = 4 * 1024 * 1024,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, artifactReferenceKeys) &&
    typeof value.kind === 'string' &&
    allowedKinds.includes(value.kind) &&
    typeof value.content_hash === 'string' &&
    contentHashPattern.test(value.content_hash) &&
    isSafeUnsignedInteger(value.bytes) &&
    value.bytes >= 1 &&
    value.bytes <= maximumBytes &&
    value.uri ===
      `aiq-artifact://sha256/${value.content_hash.slice('sha256:'.length)}/${value.kind}`
  );
}

function validArtifactSet(
  artifacts: unknown,
  workspaceManifest: unknown,
  allowedKinds: readonly string[],
  maximum: number,
): artifacts is readonly Record<string, unknown>[] {
  if (!Array.isArray(artifacts) || artifacts.length > maximum) {
    return false;
  }
  const references = [...artifacts];
  if (workspaceManifest !== null) {
    references.push(workspaceManifest);
  }
  if (
    !artifacts.every((artifact) => artifactReference(artifact, allowedKinds)) ||
    (workspaceManifest !== null &&
      !artifactReference(workspaceManifest, ['workspace-manifest.json']))
  ) {
    return false;
  }
  const kinds = new Set<string>();
  const uris = new Set<string>();
  const hashes = new Map<string, number>();
  for (const reference of references) {
    if (!isRecord(reference)) {
      return false;
    }
    const kind = reference.kind as string;
    const uri = reference.uri as string;
    const hash = reference.content_hash as string;
    const bytes = reference.bytes as number;
    if (kinds.has(kind) || uris.has(uri) || (hashes.has(hash) && hashes.get(hash) !== bytes)) {
      return false;
    }
    kinds.add(kind);
    uris.add(uri);
    hashes.set(hash, bytes);
  }
  return true;
}

function isAdapterFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, adapterFailureKeys) &&
    [
      'spawn',
      'timeout',
      'unsupported',
      'authentication',
      'usage_limit',
      'non_zero_exit',
      'budget_exceeded',
      'output_truncated',
      'workspace_integrity',
    ].includes(value.kind as string) &&
    (value.exit_code === null ||
      (typeof value.exit_code === 'number' &&
        Number.isInteger(value.exit_code) &&
        value.exit_code >= -2_147_483_648 &&
        value.exit_code <= 2_147_483_647)) &&
    typeof value.stderr === 'string' &&
    Buffer.byteLength(value.stderr, 'utf8') <= 64 &&
    isBoundedSafeAscii(value.message, 128) &&
    typeof value.stdout_truncated === 'boolean' &&
    typeof value.stderr_truncated === 'boolean' &&
    validArtifactSet(value.artifacts, null, ['stdout.jsonl', 'stderr.txt'], 2)
  );
}

function isCapabilityReport(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, capabilityReportKeys) ||
    value.schema_version !== 'aiq.capability-validation.v2' ||
    typeof value.node_id !== 'string' ||
    !nodeIdPattern.test(value.node_id) ||
    !Array.isArray(value.manifest_issues) ||
    value.manifest_issues.length !== 0 ||
    !isRecord(value.cli_probe) ||
    !hasExactKeys(value.cli_probe, cliProbeKeys) ||
    value.cli_probe.status !== 'available' ||
    !isBoundedSafeAscii(value.cli_probe.version, 32) ||
    (value.cli_probe.failure !== null && !isAdapterFailure(value.cli_probe.failure)) ||
    !isRecord(value.authentication_probe) ||
    !hasExactKeys(value.authentication_probe, authenticationProbeKeys) ||
    value.authentication_probe.status !== 'available' ||
    value.authentication_probe.mode !== 'chatgpt_subscription' ||
    value.authentication_probe.failure !== null ||
    !Array.isArray(value.models) ||
    value.models.length !== modelMatrixKeys.length
  ) {
    return false;
  }
  const observedVersion = value.cli_probe.version;
  const seen = new Set<string>();
  for (const entry of value.models) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, capabilityEntryKeys) ||
      !['available', 'unsupported', 'unavailable'].includes(entry.status as string) ||
      !isBoundedSafeAscii(entry.reason, 128) ||
      !isRecord(entry.probe) ||
      !hasExactKeys(entry.probe, configurationProbeKeys)
    ) {
      return false;
    }
    const key = modelKey(entry.model);
    const probe = entry.probe;
    if (
      key === null ||
      seen.has(key) ||
      probe.codex_version !== observedVersion ||
      !['available', 'observed_unsupported', 'failed'].includes(probe.status as string) ||
      typeof probe.observed_at !== 'string' ||
      !unixMillisPattern.test(probe.observed_at) ||
      typeof probe.evidence_digest !== 'string' ||
      !contentHashPattern.test(probe.evidence_digest) ||
      (probe.result_preview !== null &&
        (typeof probe.result_preview !== 'string' ||
          Buffer.byteLength(probe.result_preview, 'utf8') > 64)) ||
      (probe.failure !== null && !isAdapterFailure(probe.failure)) ||
      !validArtifactSet(probe.artifacts, null, ['stdout.jsonl', 'stderr.txt'], 2)
    ) {
      return false;
    }
    const statusPair = `${entry.status}:${probe.status}`;
    if (
      ![
        'available:available',
        'unsupported:observed_unsupported',
        'unavailable:available',
        'unavailable:observed_unsupported',
        'unavailable:failed',
      ].includes(statusPair)
    ) {
      return false;
    }
    if (probe.status === 'available') {
      if (
        typeof probe.result_digest !== 'string' ||
        !contentHashPattern.test(probe.result_digest) ||
        typeof probe.result_preview !== 'string' ||
        probe.failure !== null
      ) {
        return false;
      }
      const stdout = probe.artifacts.find((artifact) => artifact.kind === 'stdout.jsonl');
      if (
        (stdout && stdout.content_hash !== probe.result_digest) ||
        (!stdout && `sha256:${sha256Hex(probe.result_preview)}` !== probe.result_digest)
      ) {
        return false;
      }
    } else if (
      probe.result_digest !== null ||
      probe.result_preview !== null ||
      probe.failure === null
    ) {
      return false;
    }
    const evidence = [
      entry.model,
      probe.codex_version,
      probe.observed_at,
      probe.status,
      probe.result_digest,
      probe.result_preview,
      probe.artifacts,
      probe.failure,
    ];
    if (`sha256:${sha256Hex(canonicalJson(evidence))}` !== probe.evidence_digest) {
      return false;
    }
    seen.add(key);
  }
  return modelMatrixKeys.every((key) => seen.has(key));
}

function isResultFailure(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, resultFailureKeys) &&
    [
      'spawn',
      'timeout',
      'unsupported_model',
      'authentication',
      'subscription_limit',
      'non_zero_exit',
      'capability_unavailable',
      'capability_validation_failed',
      'missing_evaluator',
      'missing_response',
      'evaluator_failure',
      'budget_exceeded',
      'output_truncated',
      'workspace_unavailable',
      'workspace_integrity',
    ].includes(value.kind as string) &&
    isBoundedSafeAscii(value.message, 128) &&
    (value.exit_code === null ||
      (typeof value.exit_code === 'number' &&
        Number.isInteger(value.exit_code) &&
        value.exit_code >= -2_147_483_648 &&
        value.exit_code <= 2_147_483_647)) &&
    typeof value.retryable === 'boolean'
  );
}

function isToolUsage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, toolUsageKeys) ||
    !isU32(value.steps) ||
    !isU32(value.total_calls) ||
    !isRecord(value.by_tool) ||
    Object.keys(value.by_tool).length > 4
  ) {
    return false;
  }
  let total = 0;
  for (const [kind, count] of Object.entries(value.by_tool)) {
    if (!isBoundedIdentifier(kind, 32) || !isU32(count)) {
      return false;
    }
    total = Math.min(0xffff_ffff, total + count);
  }
  return total === value.total_calls;
}

function isResultProvenance(
  value: unknown,
  synthetic: boolean,
  expectedNodeId: string | null,
  expectedCodexVersion: string | null,
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, resultProvenanceKeys) &&
    typeof value.node_id === 'string' &&
    nodeIdPattern.test(value.node_id) &&
    (expectedNodeId === null || value.node_id === expectedNodeId) &&
    isBoundedSafeAscii(value.runner_version, 32) &&
    isBoundedSafeAscii(value.codex_version, 32) &&
    (expectedCodexVersion === null || value.codex_version === expectedCodexVersion) &&
    value.synthetic === synthetic &&
    (value.local_trust === 'trusted' || value.local_trust === 'untrusted') &&
    typeof value.observed_at === 'string' &&
    (synthetic ? value.observed_at === 'synthetic' : unixMillisPattern.test(value.observed_at))
  );
}

function resultHasValidStatus(
  result: Record<string, unknown>,
  capabilityStatus: string | null,
): boolean {
  const failure = result.failure as Record<string, unknown> | null;
  if (result.status === 'completed') {
    const scoreValid =
      (result.evaluation === 'correct' && result.task_score === 1) ||
      (result.evaluation === 'incorrect' && result.task_score === 0) ||
      (result.evaluation === 'partial' &&
        typeof result.task_score === 'number' &&
        result.task_score > 0 &&
        result.task_score < 1);
    if (!scoreValid || failure !== null || typeof result.response !== 'string') {
      return false;
    }
  } else if (result.status === 'unevaluated') {
    if (
      result.evaluation !== 'not_evaluated' ||
      result.task_score !== null ||
      typeof result.response !== 'string' ||
      failure?.kind !== 'missing_evaluator'
    ) {
      return false;
    }
  } else if (result.status === 'unsupported') {
    if (
      result.evaluation !== 'not_evaluated' ||
      result.task_score !== null ||
      result.response !== null ||
      failure?.kind !== 'capability_unavailable' ||
      capabilityStatus !== 'unsupported'
    ) {
      return false;
    }
  } else if (result.status === 'failed') {
    if (result.evaluation !== 'not_evaluated' || failure === null) {
      return false;
    }
    const zeroScoreKinds = new Set([
      'timeout',
      'unsupported_model',
      'non_zero_exit',
      'missing_response',
      'budget_exceeded',
      'output_truncated',
    ]);
    const nullScoreKinds = new Set([
      'spawn',
      'authentication',
      'subscription_limit',
      'capability_validation_failed',
      'evaluator_failure',
      'workspace_unavailable',
      'workspace_integrity',
    ]);
    if (
      (zeroScoreKinds.has(failure.kind as string) && result.task_score !== 0) ||
      (nullScoreKinds.has(failure.kind as string) && result.task_score !== null) ||
      (!zeroScoreKinds.has(failure.kind as string) &&
        !nullScoreKinds.has(failure.kind as string)) ||
      (typeof result.response === 'string') !== (failure.kind === 'evaluator_failure')
    ) {
      return false;
    }
  } else {
    return false;
  }
  return !(
    (capabilityStatus === 'available' && result.status === 'unsupported') ||
    (capabilityStatus === 'unsupported' && result.status !== 'unsupported') ||
    (capabilityStatus === 'unavailable' &&
      (result.status !== 'failed' || failure?.kind !== 'capability_validation_failed'))
  );
}

function validateTaskResult(
  value: unknown,
  run: Record<string, unknown>,
  capabilityByModel: ReadonlyMap<string, string>,
  signerNodeId: string,
): { taskId: string; taskVersion: string; taskHash: string; model: string } | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, taskResultKeys) ||
    value.schema_version !== RESULT_SCHEMA ||
    typeof value.result_id !== 'string' ||
    !resultIdPattern.test(value.result_id) ||
    value.run_id !== run.run_id ||
    !isBoundedIdentifier(value.task_id, 64) ||
    !isBoundedIdentifier(value.task_version, 32) ||
    typeof value.task_hash !== 'string' ||
    !contentHashPattern.test(value.task_hash)
  ) {
    return null;
  }
  const key = modelKey(value.model);
  const report = run.capability_validation;
  const expectedNodeId =
    isRecord(report) && typeof report.node_id === 'string' ? report.node_id : signerNodeId;
  const cliProbe = isRecord(report) && isRecord(report.cli_probe) ? report.cli_probe : null;
  const expectedVersion =
    cliProbe && typeof cliProbe.version === 'string' ? cliProbe.version : null;
  if (
    key === null ||
    !modelMatrixKeys.includes(key) ||
    (value.failure !== null && !isResultFailure(value.failure)) ||
    !isRecord(value.latency) ||
    !hasExactKeys(value.latency, latencyKeys) ||
    !isSafeUnsignedInteger(value.latency.wall_ms) ||
    !isToolUsage(value.tool_usage) ||
    !isResultProvenance(
      value.provenance,
      run.synthetic === true,
      expectedNodeId,
      expectedVersion,
    ) ||
    expectedNodeId !== signerNodeId ||
    (value.response !== null &&
      (typeof value.response !== 'string' || Buffer.byteLength(value.response, 'utf8') > 64)) ||
    !validArtifactSet(
      value.artifacts,
      value.workspace_manifest,
      ['stdout.jsonl', 'stderr.txt', 'final-response.txt', 'workspace-snapshot.json'],
      4,
    ) ||
    !resultHasValidStatus(value, capabilityByModel.get(key) ?? null)
  ) {
    return null;
  }
  const artifacts = value.artifacts;
  const failure = value.failure;
  const executionAttempted =
    run.synthetic !== true &&
    !['capability_unavailable', 'capability_validation_failed', 'workspace_unavailable'].includes(
      failure?.kind as string,
    );
  const snapshots = artifacts.filter(
    (artifact) => artifact.kind === 'workspace-snapshot.json',
  ).length;
  const workspaceIntegrity = failure?.kind === 'workspace_integrity';
  if (
    (executionAttempted &&
      !workspaceIntegrity &&
      (snapshots !== 1 || value.workspace_manifest === null)) ||
    (workspaceIntegrity &&
      (snapshots > 1 || (value.workspace_manifest !== null) !== (snapshots === 1))) ||
    (!executionAttempted && (snapshots !== 0 || value.workspace_manifest !== null))
  ) {
    return null;
  }
  if (value.response === null) {
    if (value.response_sha256 !== null) {
      return null;
    }
  } else {
    if (
      typeof value.response_sha256 !== 'string' ||
      !contentHashPattern.test(value.response_sha256)
    ) {
      return null;
    }
    const responseArtifact = artifacts.find((artifact) => artifact.kind === 'final-response.txt');
    if (
      (responseArtifact && responseArtifact.content_hash !== value.response_sha256) ||
      (!responseArtifact && `sha256:${sha256Hex(value.response)}` !== value.response_sha256)
    ) {
      return null;
    }
  }
  if (
    (value.status === 'completed' &&
      (typeof value.evaluator_result_sha256 !== 'string' ||
        !contentHashPattern.test(value.evaluator_result_sha256))) ||
    (value.status !== 'completed' && value.evaluator_result_sha256 !== null)
  ) {
    return null;
  }
  if (
    (value.evaluator_stdout_sha256 !== null &&
      (typeof value.evaluator_stdout_sha256 !== 'string' ||
        !contentHashPattern.test(value.evaluator_stdout_sha256))) ||
    (value.status === 'completed' &&
      run.synthetic !== true &&
      value.evaluator_stdout_sha256 === null) ||
    (value.status !== 'completed' && value.evaluator_stdout_sha256 !== null)
  ) {
    return null;
  }
  const unhashed = { ...value, result_id: '' };
  if (value.result_id !== `result_${sha256Hex(canonicalJson(unhashed))}`) {
    return null;
  }
  return {
    taskId: value.task_id,
    taskVersion: value.task_version,
    taskHash: value.task_hash,
    model: key,
  };
}

function validateOfficialRunPayload(
  payload: Record<string, unknown>,
  signerNodeId: string,
): boolean {
  if (
    payload.schema_version !== RUN_PAYLOAD_TYPE ||
    !isScheduleSlot(payload.schedule_slot) ||
    typeof payload.task_set_hash !== 'string' ||
    !contentHashPattern.test(payload.task_set_hash) ||
    payload.scoring_version !== OFFICIAL_SCORING_VERSION ||
    !isExactModelMatrix(payload.models) ||
    !isSafeUnsignedInteger(payload.started_unix_ms) ||
    !isSafeUnsignedInteger(payload.finished_unix_ms) ||
    payload.finished_unix_ms < payload.started_unix_ms ||
    !isSafeUnsignedInteger(payload.execution_concurrency) ||
    payload.execution_concurrency < 1 ||
    payload.execution_concurrency > 32 ||
    typeof payload.synthetic !== 'boolean' ||
    !Array.isArray(payload.results) ||
    payload.results.length !== MAX_RESULTS
  ) {
    return false;
  }
  const capabilityByModel = new Map<string, string>();
  if (payload.synthetic) {
    if (payload.capability_validation !== null || payload.provenance !== null) {
      return false;
    }
  } else {
    if (
      !isCapabilityReport(payload.capability_validation) ||
      !isOfficialRunProvenance(payload.provenance) ||
      payload.provenance.task_set_digest !== payload.task_set_hash ||
      payload.provenance.preflight_digest !==
        `sha256:${sha256Hex(canonicalJson(payload.capability_validation))}`
    ) {
      return false;
    }
    for (const entry of payload.capability_validation.models as readonly Record<
      string,
      unknown
    >[]) {
      const key = modelKey(entry.model);
      if (key) {
        capabilityByModel.set(key, entry.status as string);
      }
    }
  }
  if (evaluatorResultsArtifactReference(payload.evaluator_results_artifact) === null) {
    return false;
  }
  const metadata = new Map<string, { version: string; hash: string }>();
  const pairs = new Set<string>();
  for (const result of payload.results) {
    const validated = validateTaskResult(result, payload, capabilityByModel, signerNodeId);
    if (!validated) {
      return false;
    }
    const existing = metadata.get(validated.taskId);
    if (
      existing &&
      (existing.version !== validated.taskVersion || existing.hash !== validated.taskHash)
    ) {
      return false;
    }
    metadata.set(validated.taskId, {
      version: validated.taskVersion,
      hash: validated.taskHash,
    });
    const pair = `${validated.taskId}\0${validated.model}`;
    if (pairs.has(pair)) {
      return false;
    }
    pairs.add(pair);
  }
  if (metadata.size !== 72) {
    return false;
  }
  const hashes = [...metadata.values()].map(({ hash }) => hash).toSorted();
  if (`sha256:${sha256Hex(canonicalJson(hashes))}` !== payload.task_set_hash) {
    return false;
  }
  for (const taskId of metadata.keys()) {
    if (modelMatrixKeys.some((key) => !pairs.has(`${taskId}\0${key}`))) {
      return false;
    }
  }
  const runIdentity = {
    schema_version: 'aiq.run-identity.v1',
    slot: payload.schedule_slot,
    task_set_hash: payload.task_set_hash,
    models: payload.models,
    scoring_version: payload.scoring_version,
  };
  if (payload.synthetic) {
    return payload.run_id === `run_${sha256Hex(canonicalJson(runIdentity))}`;
  }
  const provenance = payload.provenance as RunProvenance;
  const classifiedIdentity = {
    schema_version: 'aiq.run-identity.v3',
    run_class: 'official',
    slot: payload.schedule_slot,
    task_set_hash: payload.task_set_hash,
    corpus_commitment_sha256: provenance.corpus_commitment_sha256,
    models: payload.models,
    scoring_version: OFFICIAL_SCORING_VERSION,
  };
  return payload.run_id === `run_${sha256Hex(canonicalJson(classifiedIdentity))}`;
}

function validateCalibrationRunPayload(
  payload: Record<string, unknown>,
  signerNodeId: string,
): boolean {
  if (
    payload.schema_version !== CALIBRATION_RUN_PAYLOAD_TYPE ||
    payload.official_eligible !== false ||
    payload.classification !== 'local_calibration_non_official' ||
    !isScheduleSlot(payload.schedule_slot) ||
    typeof payload.task_set_hash !== 'string' ||
    !contentHashPattern.test(payload.task_set_hash) ||
    payload.scoring_version !== OFFICIAL_SCORING_VERSION ||
    !Array.isArray(payload.models) ||
    payload.models.length < 1 ||
    payload.models.length > MAX_MODELS ||
    !Array.isArray(payload.task_ids) ||
    payload.task_ids.length < 1 ||
    payload.task_ids.length > 72 ||
    !isSafeUnsignedInteger(payload.started_unix_ms) ||
    !isSafeUnsignedInteger(payload.finished_unix_ms) ||
    payload.finished_unix_ms < payload.started_unix_ms ||
    !isSafeUnsignedInteger(payload.execution_concurrency) ||
    payload.execution_concurrency < 1 ||
    payload.execution_concurrency > 32 ||
    !Array.isArray(payload.results) ||
    payload.results.length !== payload.models.length * payload.task_ids.length ||
    !isCapabilityReport(payload.capability_validation) ||
    !isRunProvenance(payload.provenance) ||
    payload.provenance.run_class !== 'calibration' ||
    payload.provenance.task_set_digest !== payload.task_set_hash ||
    payload.provenance.preflight_digest !==
      `sha256:${sha256Hex(canonicalJson(payload.capability_validation))}` ||
    payload.capability_validation.node_id !== signerNodeId
  ) {
    return false;
  }

  const selectedModels: string[] = [];
  let previousModelIndex = -1;
  for (const model of payload.models) {
    const key = modelKey(model);
    const index = key === null ? -1 : modelMatrixKeys.indexOf(key);
    if (key === null || index <= previousModelIndex) return false;
    selectedModels.push(key);
    previousModelIndex = index;
  }
  const taskIds: string[] = [];
  for (const taskId of payload.task_ids) {
    if (!isBoundedIdentifier(taskId, 64)) return false;
    taskIds.push(taskId);
  }
  if (new Set(taskIds).size !== taskIds.length) return false;

  const capabilityByModel = new Map<string, string>();
  for (const entry of payload.capability_validation.models as readonly Record<string, unknown>[]) {
    const key = modelKey(entry.model);
    if (key) capabilityByModel.set(key, entry.status as string);
  }
  if (selectedModels.some((key) => !capabilityByModel.has(key))) return false;
  if (evaluatorResultsArtifactReference(payload.evaluator_results_artifact) === null) return false;

  const selectedTaskIds = new Set(taskIds);
  const metadata = new Map<string, { version: string; hash: string }>();
  const pairs = new Set<string>();
  const validationContext = { ...payload, synthetic: false };
  for (const [index, result] of payload.results.entries()) {
    const validated = validateTaskResult(
      result,
      validationContext,
      capabilityByModel,
      signerNodeId,
    );
    const expectedModel = selectedModels[Math.floor(index / taskIds.length)];
    const expectedTaskId = taskIds[index % taskIds.length];
    if (
      !validated ||
      validated.model !== expectedModel ||
      validated.taskId !== expectedTaskId ||
      !selectedTaskIds.has(validated.taskId) ||
      !selectedModels.includes(validated.model)
    ) {
      return false;
    }
    const existing = metadata.get(validated.taskId);
    if (
      existing &&
      (existing.version !== validated.taskVersion || existing.hash !== validated.taskHash)
    ) {
      return false;
    }
    metadata.set(validated.taskId, { version: validated.taskVersion, hash: validated.taskHash });
    const pair = `${validated.taskId}\0${validated.model}`;
    if (pairs.has(pair)) return false;
    pairs.add(pair);
  }
  if (metadata.size !== taskIds.length) return false;
  for (const taskId of taskIds) {
    if (selectedModels.some((key) => !pairs.has(`${taskId}\0${key}`))) return false;
  }
  const hashes: string[] = [];
  for (const taskId of taskIds) {
    const hash = metadata.get(taskId)?.hash;
    if (hash === undefined) return false;
    hashes.push(hash);
  }
  if (
    `sha256:${sha256Hex(canonicalJson(hashes.toSorted((left, right) => left.localeCompare(right))))}` !==
    payload.task_set_hash
  ) {
    return false;
  }
  const provenance = payload.provenance;
  const classifiedIdentity = {
    schema_version: 'aiq.run-identity.v3',
    run_class: 'calibration',
    slot: payload.schedule_slot,
    task_set_hash: payload.task_set_hash,
    corpus_commitment_sha256: provenance.corpus_commitment_sha256,
    models: payload.models,
    scoring_version: OFFICIAL_SCORING_VERSION,
  };
  return payload.run_id === `run_${sha256Hex(canonicalJson(classifiedIdentity))}`;
}

function hasValidEnvelopeSignature(envelope: Readonly<Record<string, unknown>>): boolean {
  const signer = envelope.signer;
  const signature = envelope.signature;
  if (
    !isRecord(signer) ||
    typeof signer.public_key !== 'string' ||
    !publicKeyPattern.test(signer.public_key) ||
    typeof signature !== 'string' ||
    !signaturePattern.test(signature)
  ) {
    return false;
  }
  const unsigned = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== 'signature'),
  );
  try {
    const key = createPublicKey({
      key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(signer.public_key, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      key,
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

function validateComplexity(root: unknown): ValidationResult | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) {
      break;
    }
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      return {
        ok: false,
        code: 'JSON_COMPLEXITY_EXCEEDED',
        message: `The JSON body must not exceed ${MAX_JSON_NODES} values.`,
      };
    }
    if (entry.depth > MAX_JSON_DEPTH) {
      return {
        ok: false,
        code: 'JSON_COMPLEXITY_EXCEEDED',
        message: `The JSON body must not exceed ${MAX_JSON_DEPTH} levels.`,
      };
    }
    if (typeof entry.value === 'string') {
      if (entry.value.length > MAX_STRING_LENGTH || !entry.value.isWellFormed()) {
        return {
          ok: false,
          code: 'JSON_COMPLEXITY_EXCEEDED',
          message: `JSON strings must be valid Unicode and not exceed ${MAX_STRING_LENGTH} characters.`,
        };
      }
    } else if (
      typeof entry.value === 'number' &&
      (!Number.isFinite(entry.value) ||
        (Number.isInteger(entry.value) && !Number.isSafeInteger(entry.value)))
    ) {
      return {
        ok: false,
        code: 'INVALID_JCS_NUMBER',
        message: 'JSON numbers must be finite and integers must stay in the safe JCS range.',
      };
    }
    if (Array.isArray(entry.value)) {
      if (entry.value.length > MAX_ARRAY_ITEMS) {
        return {
          ok: false,
          code: 'JSON_COMPLEXITY_EXCEEDED',
          message: `JSON arrays must not exceed ${MAX_ARRAY_ITEMS} items.`,
        };
      }
      for (const value of entry.value) {
        stack.push({ value, depth: entry.depth + 1 });
      }
    } else if (isRecord(entry.value)) {
      const entries = Object.entries(entry.value);
      if (entries.length > MAX_OBJECT_PROPERTIES) {
        return {
          ok: false,
          code: 'JSON_COMPLEXITY_EXCEEDED',
          message: `JSON objects must not exceed ${MAX_OBJECT_PROPERTIES} properties.`,
        };
      }
      for (const [key, value] of entries) {
        if (key.length > MAX_PROPERTY_NAME_LENGTH || !key.isWellFormed()) {
          return {
            ok: false,
            code: 'JSON_COMPLEXITY_EXCEEDED',
            message: `JSON property names must be valid Unicode and not exceed ${MAX_PROPERTY_NAME_LENGTH} characters.`,
          };
        }
        stack.push({ value, depth: entry.depth + 1 });
      }
    }
  }
  return null;
}

export function validateSubmission(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { ok: false, code: 'INVALID_BODY', message: 'The JSON body must be an object.' };
  }
  const complexity = validateComplexity(value);
  if (complexity) {
    return complexity;
  }
  if (!hasExactKeys(value, topLevelKeys)) {
    return {
      ok: false,
      code: 'INVALID_ENVELOPE',
      message: 'The result-package envelope has missing or extra fields.',
    };
  }
  if (value.schema_version !== RESULT_PACKAGE_SCHEMA) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      message: `schema_version must be ${RESULT_PACKAGE_SCHEMA}.`,
    };
  }
  if (typeof value.idempotency_key !== 'string' || !runKeyPattern.test(value.idempotency_key)) {
    return {
      ok: false,
      code: 'INVALID_IDEMPOTENCY_KEY',
      message: 'idempotency_key must be run_ followed by 64 lowercase hexadecimal characters.',
    };
  }
  if (
    value.payload_type !== RUN_PAYLOAD_TYPE &&
    value.payload_type !== CALIBRATION_RUN_PAYLOAD_TYPE
  ) {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD_TYPE',
      message: `payload_type must be ${RUN_PAYLOAD_TYPE} or ${CALIBRATION_RUN_PAYLOAD_TYPE}.`,
    };
  }
  if (typeof value.content_hash !== 'string' || !contentHashPattern.test(value.content_hash)) {
    return {
      ok: false,
      code: 'INVALID_CONTENT_HASH',
      message: 'content_hash must be sha256: followed by 64 lowercase hexadecimal characters.',
    };
  }
  if (!isRecord(value.signer) || !hasExactKeys(value.signer, signerKeys)) {
    return {
      ok: false,
      code: 'INVALID_SIGNER',
      message: 'signer must contain only node_id and public_key.',
    };
  }
  if (
    typeof value.signer.public_key !== 'string' ||
    !publicKeyPattern.test(value.signer.public_key) ||
    typeof value.signer.node_id !== 'string' ||
    !nodeIdPattern.test(value.signer.node_id)
  ) {
    return {
      ok: false,
      code: 'INVALID_SIGNER',
      message: 'signer fields must use canonical lowercase hexadecimal formats.',
    };
  }
  if (`node_${sha256Hex(Buffer.from(value.signer.public_key, 'hex'))}` !== value.signer.node_id) {
    return {
      ok: false,
      code: 'INVALID_SIGNER',
      message: 'signer.node_id does not match signer.public_key.',
    };
  }
  if (value.claimed_trust !== 'trusted' && value.claimed_trust !== 'untrusted') {
    return {
      ok: false,
      code: 'INVALID_TRUST_CLAIM',
      message: 'claimed_trust must be trusted or untrusted.',
    };
  }
  if (!isRecord(value.payload)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'payload must be an object.' };
  }
  const calibration = value.payload_type === CALIBRATION_RUN_PAYLOAD_TYPE;
  if (
    !(calibration
      ? hasExactKeys(value.payload, calibrationRunPayloadKeys)
      : hasExactKeys(value.payload, runPayloadKeys)) ||
    (calibration && value.claimed_trust !== 'untrusted')
  ) {
    return {
      ok: false,
      code: calibration ? 'INVALID_CALIBRATION_ADMISSION' : 'INVALID_PAYLOAD',
      message: calibration
        ? 'Calibration packages require the exact v3 shape and untrusted handling.'
        : 'payload must be an object.',
    };
  }
  if (
    value.payload.schema_version !== value.payload_type ||
    value.payload.run_id !== value.idempotency_key ||
    (!calibration && typeof value.payload.synthetic !== 'boolean') ||
    !Array.isArray(value.payload.results)
  ) {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD',
      message: 'payload is not an exact semantically valid aiq.run.v3 RunRecord.',
    };
  }
  let provenance: RunProvenance | null;
  if (calibration) {
    if (
      !isRunProvenance(value.payload.provenance) ||
      value.payload.provenance.run_class !== 'calibration'
    ) {
      return {
        ok: false,
        code: 'INVALID_PROVENANCE',
        message: 'Calibration runs require exact calibration aiq.run-provenance.v2 commitments.',
      };
    }
    provenance = value.payload.provenance;
  } else if (value.payload.synthetic) {
    if (value.payload.provenance !== null) {
      return {
        ok: false,
        code: 'INVALID_PROVENANCE',
        message:
          'Synthetic runs require null provenance; non-synthetic runs require exact Official aiq.run-provenance.v2 commitments.',
      };
    }
    provenance = null;
  } else if (isOfficialRunProvenance(value.payload.provenance)) {
    provenance = value.payload.provenance;
  } else {
    return {
      ok: false,
      code: 'INVALID_PROVENANCE',
      message:
        'Synthetic runs require null provenance; non-synthetic runs require exact Official aiq.run-provenance.v2 commitments.',
    };
  }
  if (
    !(calibration
      ? validateCalibrationRunPayload(value.payload, value.signer.node_id)
      : validateOfficialRunPayload(value.payload, value.signer.node_id))
  ) {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD',
      message: 'payload is not an exact semantically valid aiq.run.v3 RunRecord.',
    };
  }
  const evaluatorResultsArtifact = evaluatorResultsArtifactReference(
    value.payload.evaluator_results_artifact,
  );
  if (evaluatorResultsArtifact === null) {
    return {
      ok: false,
      code: 'INVALID_EVALUATOR_RESULTS_BINDING',
      message: 'The evaluator-results artifact reference is invalid.',
    };
  }
  const expectedContentHash = `sha256:${sha256Hex(canonicalJson(value.payload))}`;
  if (value.content_hash !== expectedContentHash) {
    return {
      ok: false,
      code: 'INVALID_CONTENT_HASH',
      message: 'content_hash does not match the canonical payload JSON.',
    };
  }
  if (typeof value.signature !== 'string' || !signaturePattern.test(value.signature)) {
    return {
      ok: false,
      code: 'INVALID_SIGNATURE',
      message: 'signature must contain 128 lowercase hexadecimal characters.',
    };
  }
  if (!hasValidEnvelopeSignature(value)) {
    return {
      ok: false,
      code: 'INVALID_SIGNATURE',
      message: 'signature does not authenticate the canonical result-package envelope.',
    };
  }
  return {
    ok: true,
    submission: {
      schemaVersion: RESULT_PACKAGE_SCHEMA,
      idempotencyKey: value.idempotency_key,
      envelope: {
        schema_version: RESULT_PACKAGE_SCHEMA,
        idempotency_key: value.idempotency_key,
        payload_type: value.payload_type,
        content_hash: value.content_hash,
        signer: {
          node_id: value.signer.node_id,
          public_key: value.signer.public_key,
        },
        claimed_trust: value.claimed_trust,
        payload: {
          ...value.payload,
          schema_version: value.payload_type,
          run_id: value.idempotency_key,
          provenance,
          evaluator_results_artifact: evaluatorResultsArtifact,
          models: value.payload.models as readonly SignedModelConfig[],
          results: value.payload.results as readonly SignedTaskResult[],
        } as ResultPackageEnvelope['payload'],
        signature: value.signature,
      } as ResultPackageEnvelope,
    },
  };
}

export type EnqueueDisposition =
  | { status: 'accepted'; inboxId: string; objectRecorded: boolean }
  | { status: 'duplicate'; inboxId: string; objectRecorded: boolean }
  | { status: 'conflict'; inboxId: string; objectRecorded: boolean }
  | { status: 'invalid-upstream-response'; inboxId: null; objectRecorded: false };

export function createEnqueueRpcArguments(
  submission: ValidatedSubmission,
  receipt: SubmissionReceipt,
  objectIdentity: SubmissionObjectIdentity,
): {
  envelope: ResultPackageEnvelope;
  request_context: Readonly<Record<string, string | number>>;
  object_identity: Readonly<Record<string, string | number>>;
} {
  return {
    envelope: submission.envelope,
    request_context: {
      source: 'aiq-web',
      received_at: receipt.receivedAt,
      idempotency_key: submission.idempotencyKey,
      package_sha256: receipt.packageSha256,
      body_bytes: receipt.bodyBytes,
    },
    object_identity: {
      bucket: objectIdentity.bucket,
      key: objectIdentity.key,
      content_sha256: objectIdentity.contentSha256,
      bytes: objectIdentity.bytes,
    },
  };
}

export function mapEnqueueResult(value: unknown): EnqueueDisposition {
  if (!Array.isArray(value) || value.length !== 1) {
    return { status: 'invalid-upstream-response', inboxId: null, objectRecorded: false };
  }
  const candidate = value[0];
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, ['disposition', 'inbox_id', 'object_recorded'])
  ) {
    return { status: 'invalid-upstream-response', inboxId: null, objectRecorded: false };
  }
  const disposition = candidate.disposition;
  const inboxId = candidate.inbox_id;
  const objectRecorded = candidate.object_recorded;
  if (
    (disposition === 'accepted' || disposition === 'duplicate' || disposition === 'conflict') &&
    typeof inboxId === 'string' &&
    uuidPattern.test(inboxId) &&
    typeof objectRecorded === 'boolean'
  ) {
    return {
      status: disposition,
      inboxId,
      objectRecorded,
    };
  }
  return { status: 'invalid-upstream-response', inboxId: null, objectRecorded: false };
}
