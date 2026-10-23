import { createHash } from 'node:crypto';

import { canonicalJson, hasExactKeys, isRecord } from './wire-json.ts';

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

const prefixedDigestPattern = /^sha256:(?!0{64}(?![\s\S]))[a-f0-9]{64}(?![\s\S])/;
const checkIdPattern = /^[A-Za-z0-9._-]{1,128}(?![\s\S])/;
export function isArtifactKind(value: string): value is ArtifactKind {
  return Object.hasOwn(ARTIFACT_KIND_MAX_BYTES, value);
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
