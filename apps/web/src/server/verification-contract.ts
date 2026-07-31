import { createPublicKey, verify as verifySignature } from 'node:crypto';

import {
  isOfficialRunProvenance,
  isRunProvenance,
  runProvenanceEquals,
  type RunProvenance,
} from './run-provenance.ts';
import { canonicalJson, sha256Hex } from './submission-contract.ts';

export const MAX_VERIFICATION_BYTES = 4 * 1024 * 1024;
export const NORMALIZED_BATCH_SCHEMA = 'aiq.normalized-batch.v3';
export const VERIFIER_ATTESTATION_SCHEMA = 'aiq.verifier-attestation.v3';
export const VERIFIER_REJECTION_SCHEMA = 'aiq.verifier-rejection.v2';
export const MAX_VERIFICATION_JSON_DEPTH = 32;
export const MAX_VERIFICATION_JSON_NODES = 100_000;
export const MAX_VERIFICATION_OBJECT_PROPERTIES = 256;
export const MAX_VERIFICATION_ARRAY_ITEMS = 1_224;
export const MAX_VERIFICATION_STRING_LENGTH = 65_536;
export const MAX_VERIFICATION_PROPERTY_NAME_LENGTH = 256;

const digestPattern = /^sha256:(?!0{64}(?![\s\S]))[a-f0-9]{64}(?![\s\S])/;
const packageHashPattern = /^(?!0{64}(?![\s\S]))[a-f0-9]{64}(?![\s\S])/;
const publicKeyPattern = /^[a-f0-9]{64}(?![\s\S])/;
const nodeIdPattern = /^node_[a-f0-9]{64}(?![\s\S])/;
const runIdPattern = /^run_[a-f0-9]{64}(?![\s\S])/;
const reasonCodePattern = /^[a-z0-9_]{3,64}(?![\s\S])/;
const signaturePattern = /^[a-f0-9]{128}(?![\s\S])/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const utcTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z(?![\s\S])/;
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

const requestKeys = ['attestation', 'claim', 'stage'] as const;
const rejectionRequestKeys = ['claim', 'rejection'] as const;
const claimKeys = ['attempt', 'inbox_id', 'lease_token'] as const;
const stageKeys = [
  'benchmark_version',
  'capability_validation_digest',
  'content_hash',
  'finished_unix_ms',
  'matrix_batch_id',
  'normalization_digest',
  'package_sha256',
  'prompt_set_digest',
  'provenance',
  'region',
  'run_class',
  'runner_commit',
  'runs',
  'scheduled_unix_ms',
  'schema_version',
  'scoring_version',
  'signer',
  'started_unix_ms',
  'synthetic',
  'task_set_hash',
  'task_set_id',
  'task_set_version',
] as const;
const attestationKeys = [
  'benchmark_version',
  'capability_validation_digest',
  'content_hash',
  'matrix_batch_id',
  'normalization_digest',
  'observed_unix_ms',
  'package_sha256',
  'policy',
  'prompt_set_digest',
  'provenance',
  'replay_status',
  'schema_version',
  'scoring_version',
  'signature',
  'signature_algorithm',
  'signature_version',
  'synthetic',
  'task_set_hash',
  'verifier',
] as const;
const nodeKeys = ['node_id', 'public_key'] as const;
const rejectionKeys = [
  'matrix_batch_id',
  'observed_at',
  'package_sha256',
  'production',
  'reason_code',
  'reason_detail',
  'schema_version',
  'synthetic',
  'verifier_node_id',
] as const;

type JsonRecord = Record<string, unknown>;

export interface NormalizedStage extends Readonly<JsonRecord> {
  schema_version: typeof NORMALIZED_BATCH_SCHEMA;
  matrix_batch_id: string;
  package_sha256: string;
  content_hash: string;
  signer: { node_id: string; public_key: string };
  task_set_hash: string;
  capability_validation_digest: string | null;
  provenance: RunProvenance | null;
  run_class: 'official' | null;
  benchmark_version: string;
  prompt_set_digest: string;
  scoring_version: string;
  synthetic: boolean;
  runs: readonly unknown[];
  normalization_digest: string;
}

export interface VerifierAttestation extends Readonly<JsonRecord> {
  schema_version: typeof VERIFIER_ATTESTATION_SCHEMA;
  signature_algorithm: 'ed25519';
  signature_version: 'aiq.ed25519-jcs.v1';
  matrix_batch_id: string;
  package_sha256: string;
  content_hash: string;
  normalization_digest: string;
  task_set_hash: string;
  capability_validation_digest: string | null;
  provenance: RunProvenance | null;
  benchmark_version: string;
  prompt_set_digest: string;
  scoring_version: string;
  verifier: { node_id: string; public_key: string };
  observed_unix_ms: number;
  replay_status: 'evaluator_replayed' | 'commitments_verified';
  policy: 'production' | 'synthetic_test';
  synthetic: boolean;
  signature: string;
}

export interface ValidatedVerification {
  claim: VerificationClaim;
  stage: NormalizedStage;
  attestation: VerifierAttestation;
}

export interface VerificationClaim extends Readonly<JsonRecord> {
  inbox_id: string;
  lease_token: string;
  attempt: number;
}

export interface VerifierRejection extends Readonly<JsonRecord> {
  schema_version: typeof VERIFIER_REJECTION_SCHEMA;
  matrix_batch_id: string;
  package_sha256: string;
  observed_at: string;
  production: boolean;
  reason_code: string;
  reason_detail: string;
  synthetic: boolean;
  verifier_node_id: string;
}

export type ValidatedVerificationOperation =
  | { kind: 'verification'; verification: ValidatedVerification }
  | { kind: 'rejection'; claim: VerificationClaim; rejection: VerifierRejection };

export type VerificationValidationResult =
  | { ok: true; operation: ValidatedVerificationOperation }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Readonly<JsonRecord>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isVerificationClaim(value: unknown): value is VerificationClaim {
  return (
    isRecord(value) &&
    hasExactKeys(value, claimKeys) &&
    typeof value.inbox_id === 'string' &&
    uuidPattern.test(value.inbox_id) &&
    typeof value.lease_token === 'string' &&
    uuidPattern.test(value.lease_token) &&
    typeof value.attempt === 'number' &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt >= 1
  );
}

function isNode(value: unknown): value is { node_id: string; public_key: string } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, nodeKeys) ||
    typeof value.node_id !== 'string' ||
    !nodeIdPattern.test(value.node_id) ||
    typeof value.public_key !== 'string' ||
    !publicKeyPattern.test(value.public_key)
  ) {
    return false;
  }
  return value.node_id === `node_${sha256Hex(Buffer.from(value.public_key, 'hex'))}`;
}

function isDigestOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && digestPattern.test(value));
}

function isRunProvenanceOrNull(value: unknown): value is RunProvenance | null {
  return value === null || isRunProvenance(value);
}

function isSafeUnixMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isValidUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = utcTimestampPattern.exec(value);
  if (!match) {
    return false;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (monthLengths[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

export function isVerificationJsonWithinBounds(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (
      !entry ||
      ++nodes > MAX_VERIFICATION_JSON_NODES ||
      entry.depth > MAX_VERIFICATION_JSON_DEPTH
    ) {
      return false;
    }
    if (typeof entry.value === 'string') {
      if (entry.value.length > MAX_VERIFICATION_STRING_LENGTH || !entry.value.isWellFormed()) {
        return false;
      }
    } else if (
      typeof entry.value === 'number' &&
      (!Number.isFinite(entry.value) ||
        (Number.isInteger(entry.value) && !Number.isSafeInteger(entry.value)))
    ) {
      return false;
    }
    if (Array.isArray(entry.value)) {
      if (entry.value.length > MAX_VERIFICATION_ARRAY_ITEMS) {
        return false;
      }
      for (const item of entry.value) {
        stack.push({ value: item, depth: entry.depth + 1 });
      }
    } else if (isRecord(entry.value)) {
      const entries = Object.entries(entry.value);
      if (entries.length > MAX_VERIFICATION_OBJECT_PROPERTIES) {
        return false;
      }
      for (const [key, item] of entries) {
        if (key.length > MAX_VERIFICATION_PROPERTY_NAME_LENGTH || !key.isWellFormed()) {
          return false;
        }
        stack.push({ value: item, depth: entry.depth + 1 });
      }
    }
  }
  return true;
}

function hasValidStageShape(value: JsonRecord): value is NormalizedStage {
  return (
    hasExactKeys(value, stageKeys) &&
    value.schema_version === NORMALIZED_BATCH_SCHEMA &&
    typeof value.matrix_batch_id === 'string' &&
    runIdPattern.test(value.matrix_batch_id) &&
    typeof value.package_sha256 === 'string' &&
    packageHashPattern.test(value.package_sha256) &&
    typeof value.content_hash === 'string' &&
    digestPattern.test(value.content_hash) &&
    isNode(value.signer) &&
    typeof value.task_set_id === 'string' &&
    typeof value.task_set_version === 'string' &&
    typeof value.task_set_hash === 'string' &&
    digestPattern.test(value.task_set_hash) &&
    isDigestOrNull(value.capability_validation_digest) &&
    isRunProvenanceOrNull(value.provenance) &&
    (value.run_class === null || value.run_class === 'official') &&
    typeof value.benchmark_version === 'string' &&
    typeof value.prompt_set_digest === 'string' &&
    digestPattern.test(value.prompt_set_digest) &&
    typeof value.scoring_version === 'string' &&
    typeof value.runner_commit === 'string' &&
    typeof value.region === 'string' &&
    typeof value.synthetic === 'boolean' &&
    Array.isArray(value.runs) &&
    value.runs.length === 17 &&
    isSafeUnixMilliseconds(value.scheduled_unix_ms) &&
    isSafeUnixMilliseconds(value.started_unix_ms) &&
    isSafeUnixMilliseconds(value.finished_unix_ms) &&
    value.finished_unix_ms >= value.started_unix_ms &&
    typeof value.normalization_digest === 'string' &&
    digestPattern.test(value.normalization_digest)
  );
}

function hasValidAttestationShape(value: JsonRecord): value is VerifierAttestation {
  return (
    hasExactKeys(value, attestationKeys) &&
    value.schema_version === VERIFIER_ATTESTATION_SCHEMA &&
    value.signature_algorithm === 'ed25519' &&
    value.signature_version === 'aiq.ed25519-jcs.v1' &&
    typeof value.matrix_batch_id === 'string' &&
    runIdPattern.test(value.matrix_batch_id) &&
    typeof value.package_sha256 === 'string' &&
    packageHashPattern.test(value.package_sha256) &&
    typeof value.content_hash === 'string' &&
    digestPattern.test(value.content_hash) &&
    typeof value.normalization_digest === 'string' &&
    digestPattern.test(value.normalization_digest) &&
    typeof value.task_set_hash === 'string' &&
    digestPattern.test(value.task_set_hash) &&
    isDigestOrNull(value.capability_validation_digest) &&
    isRunProvenanceOrNull(value.provenance) &&
    typeof value.benchmark_version === 'string' &&
    typeof value.prompt_set_digest === 'string' &&
    digestPattern.test(value.prompt_set_digest) &&
    typeof value.scoring_version === 'string' &&
    isNode(value.verifier) &&
    isSafeUnixMilliseconds(value.observed_unix_ms) &&
    (value.replay_status === 'evaluator_replayed' ||
      value.replay_status === 'commitments_verified') &&
    (value.policy === 'production' || value.policy === 'synthetic_test') &&
    typeof value.synthetic === 'boolean' &&
    typeof value.signature === 'string' &&
    signaturePattern.test(value.signature) &&
    value.signature !== '0'.repeat(128)
  );
}

function hasValidRejectionShape(value: JsonRecord): value is VerifierRejection {
  return (
    hasExactKeys(value, rejectionKeys) &&
    value.schema_version === VERIFIER_REJECTION_SCHEMA &&
    typeof value.matrix_batch_id === 'string' &&
    runIdPattern.test(value.matrix_batch_id) &&
    typeof value.package_sha256 === 'string' &&
    packageHashPattern.test(value.package_sha256) &&
    isValidUtcTimestamp(value.observed_at) &&
    typeof value.production === 'boolean' &&
    typeof value.reason_code === 'string' &&
    reasonCodePattern.test(value.reason_code) &&
    typeof value.reason_detail === 'string' &&
    Buffer.byteLength(value.reason_detail, 'utf8') <= 4_096 &&
    typeof value.synthetic === 'boolean' &&
    value.production === !value.synthetic &&
    typeof value.verifier_node_id === 'string' &&
    nodeIdPattern.test(value.verifier_node_id)
  );
}

function stageDigest(stage: Readonly<JsonRecord>): string {
  const unsigned = Object.fromEntries(
    Object.entries(stage).filter(([key]) => key !== 'normalization_digest'),
  );
  return `sha256:${sha256Hex(canonicalJson(unsigned))}`;
}

function hasValidCapabilityEvidencePolicy(stage: NormalizedStage): boolean {
  return stage.synthetic
    ? stage.capability_validation_digest === null
    : stage.capability_validation_digest !== null;
}

function hasValidProvenancePolicy(
  stage: NormalizedStage,
  attestation: VerifierAttestation,
): boolean {
  if (stage.synthetic) {
    return stage.run_class === null && stage.provenance === null && attestation.provenance === null;
  }
  return (
    stage.run_class === 'official' &&
    isOfficialRunProvenance(stage.provenance) &&
    isOfficialRunProvenance(attestation.provenance) &&
    stage.provenance.task_set_digest === stage.task_set_hash &&
    stage.provenance.preflight_digest === stage.capability_validation_digest &&
    stage.provenance.prompt_digest === stage.prompt_set_digest
  );
}

function hasValidIdentitySeparation(
  stage: NormalizedStage,
  attestation: VerifierAttestation,
): boolean {
  if (stage.synthetic) {
    return true;
  }
  return attestation.verifier.node_id !== stage.signer.node_id;
}

function bindingsMatch(stage: NormalizedStage, attestation: VerifierAttestation): boolean {
  return (
    attestation.matrix_batch_id === stage.matrix_batch_id &&
    attestation.package_sha256 === stage.package_sha256 &&
    attestation.content_hash === stage.content_hash &&
    attestation.normalization_digest === stage.normalization_digest &&
    attestation.task_set_hash === stage.task_set_hash &&
    attestation.capability_validation_digest === stage.capability_validation_digest &&
    runProvenanceEquals(stage.provenance, attestation.provenance) &&
    attestation.benchmark_version === stage.benchmark_version &&
    attestation.prompt_set_digest === stage.prompt_set_digest &&
    attestation.scoring_version === stage.scoring_version &&
    attestation.synthetic === stage.synthetic &&
    attestation.policy === (stage.synthetic ? 'synthetic_test' : 'production') &&
    (stage.synthetic || attestation.replay_status === 'evaluator_replayed')
  );
}

function hasValidAttestationSignature(attestation: VerifierAttestation): boolean {
  const unsigned = Object.fromEntries(
    Object.entries(attestation).filter(([key]) => key !== 'signature'),
  );
  try {
    const key = createPublicKey({
      key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(attestation.verifier.public_key, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      key,
      Buffer.from(attestation.signature, 'hex'),
    );
  } catch {
    return false;
  }
}

export function validateVerification(value: unknown): VerificationValidationResult {
  if (!isRecord(value) || !isVerificationJsonWithinBounds(value)) {
    return {
      ok: false,
      code: 'INVALID_VERIFICATION',
      message: 'The request must be bounded JCS-compatible JSON.',
    };
  }
  if (hasExactKeys(value, rejectionRequestKeys)) {
    if (
      !isVerificationClaim(value.claim) ||
      !isRecord(value.rejection) ||
      !hasValidRejectionShape(value.rejection)
    ) {
      return {
        ok: false,
        code: 'INVALID_VERIFICATION_REJECTION',
        message: 'The verifier rejection shape or environment policy is invalid.',
      };
    }
    return {
      ok: true,
      operation: { kind: 'rejection', claim: value.claim, rejection: value.rejection },
    };
  }
  if (!hasExactKeys(value, requestKeys)) {
    return {
      ok: false,
      code: 'INVALID_VERIFICATION',
      message:
        'The request must contain a claim with stage and attestation, or claim and rejection.',
    };
  }
  if (
    !isVerificationClaim(value.claim) ||
    !isRecord(value.stage) ||
    !hasValidStageShape(value.stage) ||
    !isRecord(value.attestation) ||
    !hasValidAttestationShape(value.attestation)
  ) {
    return {
      ok: false,
      code: 'INVALID_VERIFICATION',
      message: 'The normalized stage or verifier attestation shape is invalid.',
    };
  }

  const stage: NormalizedStage = value.stage;
  const attestation: VerifierAttestation = value.attestation;
  if (!hasValidCapabilityEvidencePolicy(stage)) {
    return {
      ok: false,
      code: 'INVALID_CAPABILITY_EVIDENCE_POLICY',
      message:
        'Synthetic stages require null capability evidence; production stages require a digest.',
    };
  }
  if (!hasValidProvenancePolicy(stage, attestation)) {
    return {
      ok: false,
      code: 'INVALID_PROVENANCE_POLICY',
      message:
        'Synthetic verification requires null run class and provenance; production verification requires Official aiq.run-provenance.v2 commitments.',
    };
  }
  if (!hasValidIdentitySeparation(stage, attestation)) {
    return {
      ok: false,
      code: 'INVALID_IDENTITY_SEPARATION',
      message: 'Runner/package signer and verifier identities must be distinct.',
    };
  }
  if (stageDigest(stage) !== stage.normalization_digest) {
    return {
      ok: false,
      code: 'INVALID_NORMALIZATION_DIGEST',
      message: 'normalization_digest does not match the canonical normalized stage.',
    };
  }
  if (!bindingsMatch(stage, attestation)) {
    return {
      ok: false,
      code: 'ATTESTATION_BINDING_MISMATCH',
      message: 'The attestation is not bound to the normalized stage.',
    };
  }
  if (!hasValidAttestationSignature(attestation)) {
    return {
      ok: false,
      code: 'INVALID_ATTESTATION_SIGNATURE',
      message: 'The verifier signature is invalid.',
    };
  }
  return {
    ok: true,
    operation: {
      kind: 'verification',
      verification: { claim: value.claim, stage, attestation },
    },
  };
}
