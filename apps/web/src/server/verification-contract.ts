import { createPublicKey, verify as verifySignature } from 'node:crypto';

import {
  isOfficialRunProvenance,
  isRunProvenance,
  runProvenanceEquals,
  type RunProvenance,
} from './run-provenance.ts';
import { canonicalJson, sha256Hex } from './submission-contract.ts';

export const MAX_VERIFICATION_BYTES = 4 * 1024 * 1024;
export const NORMALIZED_BATCH_SCHEMA = 'aiq.normalized-batch.v4';
export const VERIFIER_ATTESTATION_SCHEMA = 'aiq.verifier-attestation.v4';
export const CALIBRATION_VERIFIED_STAGE_SCHEMA = 'aiq.calibration-verified-stage.v2';
export const CALIBRATION_VERIFIER_ATTESTATION_SCHEMA = 'aiq.calibration-verifier-attestation.v2';
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
const identifierPattern = /^[A-Za-z0-9._-]{1,160}(?![\s\S])/;
const calibrationScoreKeys = [
  'binary_micro_diagnostic',
  'completion_bounds',
  'coverage',
  'descriptive_status',
  'difficulty_coverage',
  'domains',
  'duplicate_results',
  'latent_ability',
  'measurement_version',
  'model',
  'official_eligible',
  'quality_score',
  'ranking_eligible',
  'rule',
  'run_class',
  'schema_version',
  'scoring_version',
  'task_resampling_sensitivity_interval',
] as const;
const calibrationVerifiedScoreKeys = ['efficiency', 'model', 'score'] as const;
const efficiencyKeys = [
  'estimated_cost_tasks',
  'median_observed_wall_ms',
  'model',
  'observed_wall_tasks',
  'p95_observed_wall_ms',
  'provider_token_coverage',
  'provider_token_totals',
  'schema_version',
  'selected_tasks',
  'standard_api_equivalent_usd_nanos',
  'total_observed_wall_ms',
] as const;
const tokenCoverageKeys = [
  'cache_write_input_tasks',
  'cached_input_tasks',
  'input_tasks',
  'output_tasks',
  'reasoning_tasks',
  'selected_tasks',
  'total_tasks',
] as const;
const resultEfficiencyKeys = [
  'cost_evidence_level',
  'cost_status',
  'model',
  'observed_wall_ms',
  'provider_tokens',
  'provider_tokens_evidence_level',
  'provider_tokens_source',
  'source_result_id',
  'standard_api_equivalent_usd_nanos',
  'task_id',
  'wall_time_evidence_level',
] as const;
const pricingKeys = [
  'as_of',
  'currency',
  'formula',
  'hosted_tool_fees_included',
  'limitation',
  'method',
  'processing_tier',
  'rates',
  'source',
  'version',
] as const;
const rateKeys = [
  'cache_write_input_usd_nanos_per_token',
  'cached_input_usd_nanos_per_token',
  'input_usd_nanos_per_token',
  'model',
  'output_usd_nanos_per_token',
] as const;
const pricingFormula =
  '(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again';
const pricingLimitation =
  'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing';
const maxShortContextInputTokens = 272_000;
const pricingRates = [
  ['gpt-5.6-sol', 5_000, 500, 6_250, 30_000],
  ['gpt-5.6-terra', 2_000, 200, 2_500, 12_000],
  ['gpt-5.6-luna', 200, 20, 250, 1_200],
] as const;
const tokenKeys = [
  'cache_write_input',
  'cached_input',
  'input',
  'output',
  'reasoning',
  'total',
] as const;
const modelKeys = ['family', 'reasoning_effort'] as const;
const artifactKeys = ['bytes', 'content_hash', 'kind', 'uri'] as const;
const modelOrder = [
  'sol:low',
  'sol:medium',
  'sol:high',
  'sol:xhigh',
  'sol:max',
  'sol:ultra',
  'terra:low',
  'terra:medium',
  'terra:high',
  'terra:xhigh',
  'terra:max',
  'terra:ultra',
  'luna:low',
  'luna:medium',
  'luna:high',
  'luna:xhigh',
  'luna:max',
] as const;

const requestKeys = ['attestation', 'claim', 'stage'] as const;
const rejectionRequestKeys = ['claim', 'rejection'] as const;
const claimKeys = ['attempt', 'inbox_id', 'lease_token'] as const;
const stageKeys = [
  'benchmark_version',
  'capability_validation_digest',
  'content_hash',
  'efficiency',
  'execution_concurrency',
  'finished_unix_ms',
  'matrix_batch_id',
  'normalization_digest',
  'package_sha256',
  'pricing',
  'prompt_set_digest',
  'provenance',
  'region',
  'result_efficiency',
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
const calibrationStageKeys = [
  'benchmark_version',
  'capability_validation_digest',
  'classification',
  'content_hash',
  'evaluator_results_artifact',
  'execution_concurrency',
  'finished_unix_ms',
  'model_selection_digest',
  'models',
  'official_eligible',
  'package_sha256',
  'pricing',
  'prompt_set_digest',
  'provenance',
  'ranking_eligible',
  'region',
  'result_efficiency',
  'run_class',
  'run_id',
  'runner',
  'runner_commit',
  'scheduled_unix_ms',
  'schema_version',
  'score_reports_digest',
  'scores',
  'scoring_version',
  'stage_digest',
  'started_unix_ms',
  'task_ids',
  'task_selection_digest',
  'task_set_hash',
  'task_set_id',
  'task_set_version',
  'telemetry_digest',
  'trust',
] as const;
const calibrationAttestationKeys = [
  'capability_validation_digest',
  'classification',
  'content_hash',
  'execution_concurrency',
  'model_selection_digest',
  'observed_unix_ms',
  'official_eligible',
  'package_sha256',
  'ranking_eligible',
  'replay_status',
  'run_class',
  'run_id',
  'runner',
  'schema_version',
  'score_reports_digest',
  'scoring_version',
  'signature',
  'signature_algorithm',
  'signature_version',
  'stage_digest',
  'task_selection_digest',
  'task_set_hash',
  'telemetry_digest',
  'trust',
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
  execution_concurrency: number;
  efficiency: readonly unknown[];
  result_efficiency: readonly unknown[];
  pricing: Readonly<JsonRecord>;
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

export interface CalibrationVerifiedStage extends Readonly<JsonRecord> {
  schema_version: typeof CALIBRATION_VERIFIED_STAGE_SCHEMA;
  run_id: string;
  package_sha256: string;
  content_hash: string;
  runner: { node_id: string; public_key: string };
  classification: 'local_calibration_non_official';
  run_class: 'calibration';
  official_eligible: false;
  ranking_eligible: false;
  trust: 'untrusted';
  task_set_hash: string;
  task_selection_digest: string;
  model_selection_digest: string;
  score_reports_digest: string;
  telemetry_digest: string;
  capability_validation_digest: string;
  provenance: RunProvenance & { run_class: 'calibration' };
  scoring_version: string;
  execution_concurrency: number;
  task_ids: readonly string[];
  models: readonly unknown[];
  scores: readonly unknown[];
  result_efficiency: readonly unknown[];
  pricing: Readonly<JsonRecord>;
  stage_digest: string;
}

export interface CalibrationVerifierAttestation extends Readonly<JsonRecord> {
  schema_version: typeof CALIBRATION_VERIFIER_ATTESTATION_SCHEMA;
  signature_algorithm: 'ed25519';
  signature_version: 'aiq.ed25519-jcs.v1';
  run_id: string;
  package_sha256: string;
  content_hash: string;
  stage_digest: string;
  runner: { node_id: string; public_key: string };
  verifier: { node_id: string; public_key: string };
  classification: 'local_calibration_non_official';
  run_class: 'calibration';
  official_eligible: false;
  ranking_eligible: false;
  trust: 'untrusted';
  task_set_hash: string;
  task_selection_digest: string;
  model_selection_digest: string;
  score_reports_digest: string;
  telemetry_digest: string;
  capability_validation_digest: string;
  scoring_version: string;
  execution_concurrency: number;
  observed_unix_ms: number;
  replay_status: 'evaluator_replayed';
  signature: string;
}

export interface ValidatedCalibrationVerification {
  claim: VerificationClaim;
  stage: CalibrationVerifiedStage;
  attestation: CalibrationVerifierAttestation;
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
  | { kind: 'calibration_verification'; verification: ValidatedCalibrationVerification }
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

function modelKey(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, modelKeys) ||
    typeof value.family !== 'string' ||
    typeof value.reasoning_effort !== 'string'
  )
    return null;
  const key = `${value.family}:${value.reasoning_effort}`;
  return modelOrder.some((candidate) => candidate === key) ? key : null;
}

function isCalibrationScore(
  value: unknown,
  expectedModel: unknown,
  scoringVersion: string,
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, calibrationScoreKeys) &&
    value.schema_version === 'aiq.calibration-score-report.v2' &&
    value.run_class === 'calibration' &&
    value.scoring_version === scoringVersion &&
    value.measurement_version === '2.0.0' &&
    value.official_eligible === false &&
    value.ranking_eligible === false &&
    typeof value.descriptive_status === 'string' &&
    ['complete_fixture', 'conditional_observed', 'coverage_only', 'not_applicable'].includes(
      value.descriptive_status,
    ) &&
    modelKey(value.model) !== null &&
    modelKey(value.model) === modelKey(expectedModel) &&
    typeof value.rule === 'string' &&
    Buffer.byteLength(value.rule, 'utf8') <= 4_096 &&
    Number.isSafeInteger(value.duplicate_results) &&
    Number(value.duplicate_results) >= 0
  );
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isProviderTokens(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).toSorted();
  return (
    keys.every((key) => tokenKeys.some((candidate) => candidate === key)) &&
    Object.values(value).every(isSafeCount)
  );
}

function isUnavailableContextBandUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeCount(value.input) &&
    isSafeCount(value.cached_input) &&
    isSafeCount(value.cache_write_input) &&
    isSafeCount(value.output) &&
    value.input > maxShortContextInputTokens
  );
}

function isCalibrationEfficiency(
  value: unknown,
  expectedModel: unknown,
  selectedTasks: number,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, efficiencyKeys)) return false;
  if (
    !isRecord(value.provider_token_coverage) ||
    !hasExactKeys(value.provider_token_coverage, tokenCoverageKeys)
  )
    return false;
  const coverage = value.provider_token_coverage;
  return (
    value.schema_version === 'aiq.calibration-efficiency.v1' &&
    modelKey(value.model) === modelKey(expectedModel) &&
    value.selected_tasks === selectedTasks &&
    isSafeCount(value.observed_wall_tasks) &&
    value.observed_wall_tasks <= selectedTasks &&
    (value.total_observed_wall_ms === null || isSafeCount(value.total_observed_wall_ms)) &&
    (value.median_observed_wall_ms === null || isSafeCount(value.median_observed_wall_ms)) &&
    (value.p95_observed_wall_ms === null || isSafeCount(value.p95_observed_wall_ms)) &&
    ((value.observed_wall_tasks === 0 &&
      value.total_observed_wall_ms === null &&
      value.median_observed_wall_ms === null &&
      value.p95_observed_wall_ms === null) ||
      (value.observed_wall_tasks > 0 &&
        value.total_observed_wall_ms !== null &&
        value.median_observed_wall_ms !== null &&
        value.p95_observed_wall_ms !== null)) &&
    isProviderTokens(value.provider_token_totals) &&
    tokenCoverageKeys.every(
      (key) => isSafeCount(coverage[key]) && coverage[key] <= selectedTasks,
    ) &&
    coverage.selected_tasks === selectedTasks &&
    isSafeCount(value.estimated_cost_tasks) &&
    value.estimated_cost_tasks <= selectedTasks &&
    (value.standard_api_equivalent_usd_nanos === null ||
      isSafeCount(value.standard_api_equivalent_usd_nanos)) &&
    (value.estimated_cost_tasks === selectedTasks ||
      value.standard_api_equivalent_usd_nanos === null)
  );
}

function isCalibrationVerifiedScore(
  value: unknown,
  expectedModel: unknown,
  scoringVersion: string,
  selectedTasks: number,
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, calibrationVerifiedScoreKeys) &&
    modelKey(value.model) === modelKey(expectedModel) &&
    isCalibrationScore(value.score, expectedModel, scoringVersion) &&
    isCalibrationEfficiency(value.efficiency, expectedModel, selectedTasks)
  );
}

function isResultEfficiency(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, resultEfficiencyKeys) &&
    typeof value.source_result_id === 'string' &&
    /^result_[a-f0-9]{64}(?![\s\S])/.test(value.source_result_id) &&
    typeof value.task_id === 'string' &&
    identifierPattern.test(value.task_id) &&
    modelKey(value.model) !== null &&
    (value.observed_wall_ms === null || isSafeCount(value.observed_wall_ms)) &&
    ((value.observed_wall_ms === null && value.wall_time_evidence_level === null) ||
      (value.observed_wall_ms !== null && value.wall_time_evidence_level === 'runner_observed')) &&
    isProviderTokens(value.provider_tokens) &&
    ((Object.keys(value.provider_tokens).length === 0 &&
      value.provider_tokens_source === null &&
      value.provider_tokens_evidence_level === null) ||
      (Object.keys(value.provider_tokens).length > 0 &&
        value.provider_tokens_source === 'provider_reported' &&
        value.provider_tokens_evidence_level === 'verifier_recomputed')) &&
    (value.standard_api_equivalent_usd_nanos === null ||
      isSafeCount(value.standard_api_equivalent_usd_nanos)) &&
    [
      'estimated',
      'unavailable_missing_usage',
      'unavailable_invalid_usage',
      'unavailable_context_band',
    ].includes(String(value.cost_status)) &&
    ((value.standard_api_equivalent_usd_nanos === null && value.cost_evidence_level === null) ||
      (value.standard_api_equivalent_usd_nanos !== null &&
        value.cost_evidence_level === 'verifier_recomputed')) &&
    ((value.cost_status === 'estimated' && value.standard_api_equivalent_usd_nanos !== null) ||
      (value.cost_status !== 'estimated' && value.standard_api_equivalent_usd_nanos === null)) &&
    (value.cost_status === 'unavailable_context_band') ===
      isUnavailableContextBandUsage(value.provider_tokens)
  );
}

function isPricing(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, pricingKeys) &&
    value.method === 'standard_api_equivalent_text_token_estimate' &&
    value.version === 'aiq.standard-api-equivalent-usd.v1' &&
    value.as_of === '2026-08-02' &&
    value.source === 'https://developers.openai.com/api/docs/pricing' &&
    value.currency === 'USD' &&
    value.processing_tier === 'standard' &&
    value.hosted_tool_fees_included === false &&
    value.formula === pricingFormula &&
    value.limitation === pricingLimitation &&
    Array.isArray(value.rates) &&
    value.rates.length === pricingRates.length &&
    value.rates.every((rate, index) => {
      const expected = pricingRates[index];
      return (
        expected !== undefined &&
        isRecord(rate) &&
        hasExactKeys(rate, rateKeys) &&
        rate.model === expected[0] &&
        rate.input_usd_nanos_per_token === expected[1] &&
        rate.cached_input_usd_nanos_per_token === expected[2] &&
        rate.cache_write_input_usd_nanos_per_token === expected[3] &&
        rate.output_usd_nanos_per_token === expected[4]
      );
    })
  );
}

function isEvaluatorResultsArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, artifactKeys) &&
    value.kind === 'evaluator-results.json' &&
    typeof value.content_hash === 'string' &&
    digestPattern.test(value.content_hash) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) >= 1 &&
    value.uri ===
      `aiq-artifact://sha256/${value.content_hash.slice('sha256:'.length)}/evaluator-results.json`
  );
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
    isSafeCount(value.execution_concurrency) &&
    value.execution_concurrency >= 1 &&
    value.execution_concurrency <= 32 &&
    Array.isArray(value.runs) &&
    value.runs.length === 17 &&
    Array.isArray(value.efficiency) &&
    value.efficiency.length === 17 &&
    value.efficiency.every((entry, index) =>
      isCalibrationEfficiency(
        entry,
        {
          family: modelOrder[index]?.split(':')[0],
          reasoning_effort: modelOrder[index]?.split(':')[1],
        },
        72,
      ),
    ) &&
    Array.isArray(value.result_efficiency) &&
    value.result_efficiency.length === 1_224 &&
    value.result_efficiency.every(isResultEfficiency) &&
    isPricing(value.pricing) &&
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

function hasValidCalibrationStageShape(value: JsonRecord): value is CalibrationVerifiedStage {
  if (
    !hasExactKeys(value, calibrationStageKeys) ||
    value.schema_version !== CALIBRATION_VERIFIED_STAGE_SCHEMA ||
    typeof value.run_id !== 'string' ||
    !runIdPattern.test(value.run_id) ||
    typeof value.package_sha256 !== 'string' ||
    !packageHashPattern.test(value.package_sha256) ||
    typeof value.content_hash !== 'string' ||
    !digestPattern.test(value.content_hash) ||
    !isNode(value.runner) ||
    value.classification !== 'local_calibration_non_official' ||
    value.run_class !== 'calibration' ||
    value.official_eligible !== false ||
    value.ranking_eligible !== false ||
    value.trust !== 'untrusted' ||
    typeof value.task_set_hash !== 'string' ||
    !digestPattern.test(value.task_set_hash) ||
    typeof value.task_selection_digest !== 'string' ||
    !digestPattern.test(value.task_selection_digest) ||
    typeof value.model_selection_digest !== 'string' ||
    !digestPattern.test(value.model_selection_digest) ||
    typeof value.score_reports_digest !== 'string' ||
    !digestPattern.test(value.score_reports_digest) ||
    typeof value.telemetry_digest !== 'string' ||
    !digestPattern.test(value.telemetry_digest) ||
    typeof value.capability_validation_digest !== 'string' ||
    !digestPattern.test(value.capability_validation_digest) ||
    !isRunProvenance(value.provenance) ||
    value.provenance.run_class !== 'calibration' ||
    !isEvaluatorResultsArtifact(value.evaluator_results_artifact) ||
    typeof value.scoring_version !== 'string' ||
    !identifierPattern.test(value.scoring_version) ||
    !isSafeCount(value.execution_concurrency) ||
    value.execution_concurrency < 1 ||
    value.execution_concurrency > 32 ||
    !Array.isArray(value.task_ids) ||
    value.task_ids.length < 1 ||
    value.task_ids.length > 72 ||
    value.task_ids.some(
      (taskId) => typeof taskId !== 'string' || !identifierPattern.test(taskId),
    ) ||
    new Set(value.task_ids).size !== value.task_ids.length ||
    !Array.isArray(value.models) ||
    value.models.length < 1 ||
    value.models.length > 17 ||
    !Array.isArray(value.scores) ||
    value.scores.length !== value.models.length ||
    !Array.isArray(value.result_efficiency) ||
    value.result_efficiency.length !== value.models.length * value.task_ids.length ||
    !value.result_efficiency.every(isResultEfficiency) ||
    !isPricing(value.pricing) ||
    typeof value.task_set_id !== 'string' ||
    !identifierPattern.test(value.task_set_id) ||
    typeof value.task_set_version !== 'string' ||
    !identifierPattern.test(value.task_set_version) ||
    typeof value.benchmark_version !== 'string' ||
    Buffer.byteLength(value.benchmark_version, 'utf8') < 1 ||
    Buffer.byteLength(value.benchmark_version, 'utf8') > 128 ||
    typeof value.prompt_set_digest !== 'string' ||
    !digestPattern.test(value.prompt_set_digest) ||
    typeof value.runner_commit !== 'string' ||
    !identifierPattern.test(value.runner_commit) ||
    typeof value.region !== 'string' ||
    !identifierPattern.test(value.region) ||
    !isSafeUnixMilliseconds(value.scheduled_unix_ms) ||
    !isSafeUnixMilliseconds(value.started_unix_ms) ||
    !isSafeUnixMilliseconds(value.finished_unix_ms) ||
    value.finished_unix_ms < value.started_unix_ms ||
    typeof value.stage_digest !== 'string' ||
    !digestPattern.test(value.stage_digest)
  )
    return false;

  let previous = -1;
  for (let index = 0; index < value.models.length; index += 1) {
    const key = modelKey(value.models[index]);
    const modelIndex = modelOrder.findIndex((candidate) => candidate === key);
    if (
      modelIndex <= previous ||
      !isCalibrationVerifiedScore(
        value.scores[index],
        value.models[index],
        value.scoring_version,
        value.task_ids.length,
      )
    )
      return false;
    previous = modelIndex;
  }
  for (let index = 0; index < value.result_efficiency.length; index += 1) {
    const result: unknown = value.result_efficiency[index];
    const modelIndex = Math.floor(index / value.task_ids.length);
    const taskIndex = index % value.task_ids.length;
    if (
      !isRecord(result) ||
      modelKey(result.model) !== modelKey(value.models[modelIndex]) ||
      result.task_id !== value.task_ids[taskIndex]
    )
      return false;
  }
  return (
    value.task_selection_digest === `sha256:${sha256Hex(canonicalJson(value.task_ids))}` &&
    value.model_selection_digest === `sha256:${sha256Hex(canonicalJson(value.models))}` &&
    value.score_reports_digest === `sha256:${sha256Hex(canonicalJson(value.scores))}` &&
    value.telemetry_digest === `sha256:${sha256Hex(canonicalJson(value.result_efficiency))}` &&
    value.provenance.task_set_digest === value.task_set_hash &&
    value.provenance.preflight_digest === value.capability_validation_digest &&
    value.provenance.prompt_digest === value.prompt_set_digest
  );
}

function hasValidCalibrationAttestationShape(
  value: JsonRecord,
): value is CalibrationVerifierAttestation {
  return (
    hasExactKeys(value, calibrationAttestationKeys) &&
    value.schema_version === CALIBRATION_VERIFIER_ATTESTATION_SCHEMA &&
    value.signature_algorithm === 'ed25519' &&
    value.signature_version === 'aiq.ed25519-jcs.v1' &&
    typeof value.run_id === 'string' &&
    runIdPattern.test(value.run_id) &&
    typeof value.package_sha256 === 'string' &&
    packageHashPattern.test(value.package_sha256) &&
    typeof value.content_hash === 'string' &&
    digestPattern.test(value.content_hash) &&
    typeof value.stage_digest === 'string' &&
    digestPattern.test(value.stage_digest) &&
    isNode(value.runner) &&
    isNode(value.verifier) &&
    value.runner.node_id !== value.verifier.node_id &&
    value.classification === 'local_calibration_non_official' &&
    value.run_class === 'calibration' &&
    value.official_eligible === false &&
    value.ranking_eligible === false &&
    value.trust === 'untrusted' &&
    typeof value.task_set_hash === 'string' &&
    digestPattern.test(value.task_set_hash) &&
    typeof value.task_selection_digest === 'string' &&
    digestPattern.test(value.task_selection_digest) &&
    typeof value.model_selection_digest === 'string' &&
    digestPattern.test(value.model_selection_digest) &&
    typeof value.score_reports_digest === 'string' &&
    digestPattern.test(value.score_reports_digest) &&
    typeof value.telemetry_digest === 'string' &&
    digestPattern.test(value.telemetry_digest) &&
    typeof value.capability_validation_digest === 'string' &&
    digestPattern.test(value.capability_validation_digest) &&
    typeof value.scoring_version === 'string' &&
    identifierPattern.test(value.scoring_version) &&
    isSafeCount(value.execution_concurrency) &&
    value.execution_concurrency >= 1 &&
    value.execution_concurrency <= 32 &&
    isSafeUnixMilliseconds(value.observed_unix_ms) &&
    value.replay_status === 'evaluator_replayed' &&
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

function calibrationBindingsMatch(
  stage: CalibrationVerifiedStage,
  attestation: CalibrationVerifierAttestation,
): boolean {
  return (
    attestation.run_id === stage.run_id &&
    attestation.package_sha256 === stage.package_sha256 &&
    attestation.content_hash === stage.content_hash &&
    attestation.stage_digest === stage.stage_digest &&
    attestation.runner.node_id === stage.runner.node_id &&
    attestation.runner.public_key === stage.runner.public_key &&
    attestation.classification === stage.classification &&
    attestation.run_class === stage.run_class &&
    attestation.official_eligible === stage.official_eligible &&
    attestation.ranking_eligible === stage.ranking_eligible &&
    attestation.trust === stage.trust &&
    attestation.task_set_hash === stage.task_set_hash &&
    attestation.task_selection_digest === stage.task_selection_digest &&
    attestation.model_selection_digest === stage.model_selection_digest &&
    attestation.score_reports_digest === stage.score_reports_digest &&
    attestation.telemetry_digest === stage.telemetry_digest &&
    attestation.capability_validation_digest === stage.capability_validation_digest &&
    attestation.scoring_version === stage.scoring_version &&
    attestation.execution_concurrency === stage.execution_concurrency
  );
}

function hasValidCalibrationAttestationSignature(
  attestation: CalibrationVerifierAttestation,
): boolean {
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
  if (!isVerificationClaim(value.claim) || !isRecord(value.stage) || !isRecord(value.attestation)) {
    return {
      ok: false,
      code: 'INVALID_VERIFICATION',
      message: 'The normalized stage or verifier attestation shape is invalid.',
    };
  }

  if (value.stage.schema_version === CALIBRATION_VERIFIED_STAGE_SCHEMA) {
    if (!hasValidCalibrationStageShape(value.stage)) {
      return {
        ok: false,
        code: 'INVALID_CALIBRATION_STAGE',
        message: 'The calibration stage shape is invalid.',
      };
    }
    if (!isRecord(value.attestation) || !hasValidCalibrationAttestationShape(value.attestation)) {
      return {
        ok: false,
        code: 'INVALID_CALIBRATION_ATTESTATION',
        message: 'The calibration attestation shape is invalid.',
      };
    }
    const calibrationStage = value.stage;
    const calibrationAttestation = value.attestation;
    const expectedStageDigest = `sha256:${sha256Hex(
      canonicalJson(
        Object.fromEntries(
          Object.entries(calibrationStage).filter(([key]) => key !== 'stage_digest'),
        ),
      ),
    )}`;
    if (calibrationStage.stage_digest !== expectedStageDigest) {
      return {
        ok: false,
        code: 'INVALID_CALIBRATION_STAGE_DIGEST',
        message: 'stage_digest does not match the canonical calibration stage.',
      };
    }
    if (!calibrationBindingsMatch(calibrationStage, calibrationAttestation)) {
      return {
        ok: false,
        code: 'CALIBRATION_ATTESTATION_BINDING_MISMATCH',
        message: 'The calibration attestation is not bound to the stage.',
      };
    }
    if (!hasValidCalibrationAttestationSignature(calibrationAttestation)) {
      return {
        ok: false,
        code: 'INVALID_CALIBRATION_ATTESTATION_SIGNATURE',
        message: 'The calibration verifier signature is invalid.',
      };
    }
    return {
      ok: true,
      operation: {
        kind: 'calibration_verification',
        verification: {
          claim: value.claim,
          stage: calibrationStage,
          attestation: calibrationAttestation,
        },
      },
    };
  }

  if (!hasValidStageShape(value.stage) || !hasValidAttestationShape(value.attestation)) {
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
        'Synthetic verification requires null run class and provenance; production verification requires Official aiq.run-provenance.v3 commitments.',
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
