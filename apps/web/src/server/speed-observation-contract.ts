import { createHash } from 'node:crypto';

import { canonicalJson } from './submission-contract.ts';

export const SPEED_OBSERVATION_SCHEMA_VERSION = 'aiq.speed-observation-batch.v1';
export const SPEED_CREDIT_RATE_CARD_VERSION = 'openai-codex-rate-card-2026-08-10';
export const MAX_SPEED_OBSERVATION_BYTES = 4 * 1024 * 1024;

const sha256Pattern = /^sha256:[0-9a-f]{64}(?![\s\S])/;
const nonzeroSha256Pattern = /^sha256:(?!0{64}(?![\s\S]))[0-9a-f]{64}(?![\s\S])/;
const batchPattern = /^speed_[0-9a-f]{64}(?![\s\S])/;
const trialPattern = /^speed_trial_[0-9a-f]{64}(?![\s\S])/;
const observedAtPattern = /^unix-ms:[1-9][0-9]*(?![\s\S])/;
const artifactUriPattern =
  /^aiq-artifact:\/\/sha256\/[0-9a-f]{64}\/[a-z0-9][a-z0-9.-]{0,127}(?![\s\S])/;
const modelFamilies = ['sol', 'terra', 'luna'] as const;
const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const speedModes = ['normal', 'fast'] as const;
const capabilityStatuses = ['available', 'unsupported', 'unavailable'] as const;
const expectedUnavailableMetrics = [
  {
    metric: 'ttft_ms',
    reason: 'current_codex_jsonl_has_no_first_token_timestamp',
  },
  {
    metric: 'post_first_token_output_tps_millis',
    reason: 'current_codex_jsonl_has_no_first_token_timestamp',
  },
] as const;

type ModelFamily = (typeof modelFamilies)[number];
type ReasoningEffort = (typeof reasoningEfforts)[number];
export type SpeedMode = (typeof speedModes)[number];

function isListed<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

export interface SpeedModelConfig {
  family: ModelFamily;
  reasoning_effort: ReasoningEffort;
}

interface SpeedTrialRecord extends Record<string, unknown> {
  trial_id: string;
  model: SpeedModelConfig;
  mode: SpeedMode;
}

export interface ValidatedSpeedObservation {
  readonly batch: Record<string, unknown>;
  readonly batchId: string;
  readonly contentSha256: string;
  readonly observedUnixMs: number;
  readonly canonicalBytes: Uint8Array;
  readonly storageSha256: string;
}

export type SpeedObservationValidation =
  | { readonly ok: true; readonly observation: ValidatedSpeedObservation }
  | { readonly ok: false; readonly code: 'INVALID_SPEED_OBSERVATION'; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const sorted = expected.toSorted();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || isSafeInteger(value);
}

function isModelConfig(value: unknown): value is SpeedModelConfig {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['family', 'reasoning_effort']) &&
    isListed(value.family, modelFamilies) &&
    isListed(value.reasoning_effort, reasoningEfforts) &&
    !(value.family === 'luna' && value.reasoning_effort === 'ultra')
  );
}

function modelKey(model: SpeedModelConfig): string {
  return `${model.family}:${model.reasoning_effort}`;
}

function isArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['bytes', 'content_hash', 'kind', 'uri']) &&
    (value.kind === 'stdout.jsonl' || value.kind === 'stderr.txt') &&
    typeof value.content_hash === 'string' &&
    sha256Pattern.test(value.content_hash) &&
    typeof value.uri === 'string' &&
    artifactUriPattern.test(value.uri) &&
    isSafeInteger(value.bytes, 1) &&
    value.uri ===
      `aiq-artifact://sha256/${value.content_hash.slice('sha256:'.length)}/${value.kind}`
  );
}

function isProviderTokens(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    'input',
    'cached_input',
    'cache_write_input',
    'output',
    'reasoning',
    'total',
  ]);
  return Object.keys(value).every((key) => allowed.has(key) && isSafeInteger(value[key]));
}

function isToolUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['by_tool', 'steps', 'total_calls']) &&
    isSafeInteger(value.steps) &&
    value.total_calls === 0 &&
    isRecord(value.by_tool) &&
    Object.keys(value.by_tool).length === 0
  );
}

function isFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['exit_code', 'kind', 'message']) &&
    typeof value.kind === 'string' &&
    /^[a-z][a-z_]{0,63}(?![\s\S])/.test(value.kind) &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    value.message.length <= 512 &&
    (value.exit_code === null || isSafeInteger(value.exit_code))
  );
}

function creditRates(family: ModelFamily): readonly [bigint, bigint, bigint] {
  if (family === 'sol') return [125_000n, 12_500n, 750_000n];
  if (family === 'terra') return [50_000n, 5_000n, 300_000n];
  return [5_000n, 500n, 30_000n];
}

function expectedCredits(
  model: SpeedModelConfig,
  mode: SpeedMode,
  tokens: Record<string, number>,
): number | null {
  const input = tokens.input;
  const cached = tokens.cached_input ?? 0;
  const output = tokens.output;
  if (input === undefined || output === undefined || cached > input) return null;
  const [inputRate, cachedRate, outputRate] = creditRates(model.family);
  const base =
    BigInt(input - cached) * inputRate + BigInt(cached) * cachedRate + BigInt(output) * outputRate;
  const result = (base * BigInt(mode === 'fast' ? 25_000 : 10_000)) / 10_000n;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function expectedAggregateTps(tokens: Record<string, number>, elapsedMs: number): number | null {
  if (tokens.output === undefined || elapsedMs === 0) return null;
  const result = (BigInt(tokens.output) * 1_000_000n) / BigInt(elapsedMs);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function expectedResponseSha256(): string {
  const response = Array.from({ length: 400 }, (_, index) => index + 1).join(',');
  return `sha256:${createHash('sha256').update(response, 'utf8').digest('hex')}`;
}

function expectedPromptSha256(): string {
  const prompt =
    'Return exactly the comma-separated integers from 1 through 400, inclusive, in ascending order. Use no spaces, no markdown, no commentary, and no trailing punctuation.';
  return `sha256:${createHash('sha256').update(prompt, 'utf8').digest('hex')}`;
}

function isTrial(
  value: unknown,
  observedAt: string,
  trialsPerMode: number,
  available: ReadonlySet<string>,
): value is SpeedTrialRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'aggregate_output_tps_millis',
      'artifacts',
      'elapsed_ms',
      'estimated_credits_nanos',
      'failure',
      'mode',
      'model',
      'observed_at',
      'post_first_token_output_tps_millis',
      'response_sha256',
      'status',
      'tokens',
      'tool_usage',
      'trial_id',
      'trial_index',
      'ttft_ms',
    ]) ||
    typeof value.trial_id !== 'string' ||
    !trialPattern.test(value.trial_id) ||
    value.observed_at !== observedAt ||
    !isModelConfig(value.model) ||
    !isListed(value.mode, speedModes) ||
    !available.has(`${modelKey(value.model)}:${value.mode}`) ||
    !isSafeInteger(value.trial_index) ||
    value.trial_index >= trialsPerMode ||
    !isSafeInteger(value.elapsed_ms) ||
    value.ttft_ms !== null ||
    value.post_first_token_output_tps_millis !== null ||
    !isNullableSafeInteger(value.aggregate_output_tps_millis) ||
    !isProviderTokens(value.tokens) ||
    !isToolUsage(value.tool_usage) ||
    !isNullableSafeInteger(value.estimated_credits_nanos) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > 2 ||
    !value.artifacts.every(isArtifact)
  ) {
    return false;
  }
  if (value.aggregate_output_tps_millis !== expectedAggregateTps(value.tokens, value.elapsed_ms)) {
    return false;
  }
  if (value.estimated_credits_nanos !== expectedCredits(value.model, value.mode, value.tokens)) {
    return false;
  }
  const response = value.response_sha256;
  const expectedResponse = expectedResponseSha256();
  if (value.status === 'completed') {
    return response === expectedResponse && value.failure === null;
  }
  if (value.status === 'invalid_response') {
    return (
      typeof response === 'string' &&
      sha256Pattern.test(response) &&
      response !== expectedResponse &&
      value.failure === null
    );
  }
  return value.status === 'failed' && response === null && isFailure(value.failure);
}

function validateCatalog(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['catalog_sha256', 'codex_version', 'status', 'unavailable_reason'])
  ) {
    return false;
  }
  if (value.status === 'available') {
    return (
      typeof value.codex_version === 'string' &&
      value.codex_version.length > 0 &&
      value.codex_version.length <= 128 &&
      typeof value.catalog_sha256 === 'string' &&
      sha256Pattern.test(value.catalog_sha256) &&
      value.unavailable_reason === null
    );
  }
  return (
    value.status === 'unavailable' &&
    value.codex_version === null &&
    value.catalog_sha256 === null &&
    typeof value.unavailable_reason === 'string' &&
    /^[a-z][a-z_]{0,127}(?![\s\S])/.test(value.unavailable_reason)
  );
}

function validateCapabilities(
  value: unknown,
  catalogStatus: unknown,
): { readonly ok: true; readonly available: Set<string> } | { readonly ok: false } {
  if (!Array.isArray(value) || value.length < 2 || value.length > 34) return { ok: false };
  const seen = new Set<string>();
  const models = new Set<string>();
  const available = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['mode', 'model', 'reason', 'status']) ||
      !isModelConfig(entry.model) ||
      !isListed(entry.mode, speedModes) ||
      !isListed(entry.status, capabilityStatuses) ||
      typeof entry.reason !== 'string' ||
      !/^[a-z][a-z_]{0,127}(?![\s\S])/.test(entry.reason)
    ) {
      return { ok: false };
    }
    const model = modelKey(entry.model);
    const key = `${model}:${entry.mode}`;
    if (seen.has(key) || (catalogStatus === 'unavailable' && entry.status !== 'unavailable')) {
      return { ok: false };
    }
    seen.add(key);
    models.add(model);
    if (entry.status === 'available') available.add(key);
  }
  if ([...models].some((model) => !seen.has(`${model}:normal`) || !seen.has(`${model}:fast`))) {
    return { ok: false };
  }
  return { ok: true, available };
}

function validateUnavailableMetrics(value: unknown): boolean {
  return canonicalJson(value) === canonicalJson(expectedUnavailableMetrics);
}

function identityDocument(batch: Record<string, unknown>): Record<string, unknown> {
  const { batch_id: _batchId, content_sha256: _contentSha256, ...identity } = batch;
  return identity;
}

export function validateSpeedObservation(value: unknown): SpeedObservationValidation {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'batch_id',
        'capabilities',
        'catalog',
        'codex_code_mode_host_sha256',
        'codex_executable_sha256',
        'content_sha256',
        'credit_rate_card_version',
        'observed_at',
        'prompt_sha256',
        'runner_executable_sha256',
        'schema_version',
        'trials',
        'trials_per_mode',
        'unavailable_metrics',
      ]) ||
      value.schema_version !== SPEED_OBSERVATION_SCHEMA_VERSION ||
      typeof value.batch_id !== 'string' ||
      !batchPattern.test(value.batch_id) ||
      typeof value.observed_at !== 'string' ||
      !observedAtPattern.test(value.observed_at) ||
      !isSafeInteger(value.trials_per_mode, 1) ||
      value.trials_per_mode > 10 ||
      typeof value.prompt_sha256 !== 'string' ||
      value.prompt_sha256 !== expectedPromptSha256() ||
      typeof value.runner_executable_sha256 !== 'string' ||
      !nonzeroSha256Pattern.test(value.runner_executable_sha256) ||
      typeof value.codex_executable_sha256 !== 'string' ||
      !nonzeroSha256Pattern.test(value.codex_executable_sha256) ||
      typeof value.codex_code_mode_host_sha256 !== 'string' ||
      !nonzeroSha256Pattern.test(value.codex_code_mode_host_sha256) ||
      value.credit_rate_card_version !== SPEED_CREDIT_RATE_CARD_VERSION ||
      typeof value.content_sha256 !== 'string' ||
      !sha256Pattern.test(value.content_sha256) ||
      !validateCatalog(value.catalog) ||
      !validateUnavailableMetrics(value.unavailable_metrics)
    ) {
      throw new Error('metadata');
    }
    const capabilities = validateCapabilities(
      value.capabilities,
      isRecord(value.catalog) ? value.catalog.status : undefined,
    );
    if (!capabilities.ok || !Array.isArray(value.trials) || value.trials.length > 340) {
      throw new Error('capabilities');
    }
    const seenTrials = new Set<string>();
    const coverage = new Map<string, number>();
    for (const trial of value.trials) {
      if (
        !isTrial(trial, value.observed_at, value.trials_per_mode, capabilities.available) ||
        seenTrials.has(trial.trial_id)
      ) {
        throw new Error('trials');
      }
      seenTrials.add(trial.trial_id);
      const key = `${modelKey(trial.model)}:${trial.mode}`;
      coverage.set(key, (coverage.get(key) ?? 0) + 1);
    }
    if (
      coverage.size !== capabilities.available.size ||
      [...coverage.values()].some((count) => count !== value.trials_per_mode)
    ) {
      throw new Error('coverage');
    }
    const contentSha256 = `sha256:${createHash('sha256')
      .update(canonicalJson(identityDocument(value)), 'utf8')
      .digest('hex')}`;
    if (
      value.content_sha256 !== contentSha256 ||
      value.batch_id !== `speed_${contentSha256.slice('sha256:'.length)}`
    ) {
      throw new Error('identity');
    }
    const canonicalBytes = Buffer.from(canonicalJson(value), 'utf8');
    if (canonicalBytes.byteLength > MAX_SPEED_OBSERVATION_BYTES) throw new Error('size');
    const observedUnixMs = Number(value.observed_at.slice('unix-ms:'.length));
    if (!Number.isSafeInteger(observedUnixMs) || observedUnixMs <= 0) throw new Error('time');
    return {
      ok: true,
      observation: {
        batch: value,
        batchId: value.batch_id,
        contentSha256,
        observedUnixMs,
        canonicalBytes,
        storageSha256: createHash('sha256').update(canonicalBytes).digest('hex'),
      },
    };
  } catch {
    return {
      ok: false,
      code: 'INVALID_SPEED_OBSERVATION',
      message: 'The Normal/Fast observation does not match the current auxiliary contract.',
    };
  }
}
