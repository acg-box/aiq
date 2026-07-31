export const RUN_PROVENANCE_SCHEMA = 'aiq.run-provenance.v2';
export const FROZEN_CATALOG_DIGEST =
  'sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3';

const releaseIdPattern = /^corpus_[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?(?![\s\S])/;
const nonzeroDigestPattern = /^sha256:(?!0{64}(?![\s\S]))[a-f0-9]{64}(?![\s\S])/;
const provenanceKeys = [
  'catalog_digest',
  'codex_executable_digest',
  'corpus_commitment_sha256',
  'corpus_release_id',
  'environment_digest',
  'evaluator_digest',
  'harness_digest',
  'network_policy_digest',
  'permission_evidence_digest',
  'preflight_digest',
  'prompt_digest',
  'run_class',
  'runner_executable_digest',
  'runtime_digest',
  'schema_version',
  'source_manifest_digest',
  'task_set_digest',
  'tool_policy_digest',
] as const;
const digestKeys = [
  'catalog_digest',
  'codex_executable_digest',
  'corpus_commitment_sha256',
  'environment_digest',
  'evaluator_digest',
  'harness_digest',
  'network_policy_digest',
  'permission_evidence_digest',
  'preflight_digest',
  'prompt_digest',
  'runner_executable_digest',
  'runtime_digest',
  'source_manifest_digest',
  'task_set_digest',
  'tool_policy_digest',
] as const;

export interface RunProvenance extends Readonly<Record<string, unknown>> {
  schema_version: typeof RUN_PROVENANCE_SCHEMA;
  run_class: 'calibration' | 'official';
  corpus_release_id: string;
  corpus_commitment_sha256: string;
  catalog_digest: string;
  task_set_digest: string;
  evaluator_digest: string;
  runtime_digest: string;
  preflight_digest: string;
  harness_digest: string;
  prompt_digest: string;
  tool_policy_digest: string;
  network_policy_digest: string;
  environment_digest: string;
  source_manifest_digest: string;
  runner_executable_digest: string;
  codex_executable_digest: string;
  permission_evidence_digest: string;
}

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

export function isRunProvenance(value: unknown): value is RunProvenance {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, provenanceKeys) ||
    value.schema_version !== RUN_PROVENANCE_SCHEMA ||
    (value.run_class !== 'calibration' && value.run_class !== 'official') ||
    typeof value.corpus_release_id !== 'string' ||
    !releaseIdPattern.test(value.corpus_release_id)
  ) {
    return false;
  }
  if (
    !digestKeys.every(
      (key) => typeof value[key] === 'string' && nonzeroDigestPattern.test(value[key]),
    ) ||
    value.catalog_digest !== FROZEN_CATALOG_DIGEST
  ) {
    return false;
  }
  return true;
}

export function isOfficialRunProvenance(value: unknown): value is RunProvenance & {
  run_class: 'official';
} {
  return isRunProvenance(value) && value.run_class === 'official';
}

export function runProvenanceEquals(
  left: RunProvenance | null,
  right: RunProvenance | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return provenanceKeys.every((key) => left[key] === right[key]);
}
