import { deepStrictEqual, notStrictEqual, strictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireObjectProperty(record: JsonObject, field: string): JsonObject {
  return requireObject(record[field], field);
}

function requireArrayProperty(record: JsonObject, field: string): unknown[] {
  return requireArray(record[field], field);
}

function requireObjectAt(values: readonly unknown[], index: number, label: string): JsonObject {
  return requireObject(values[index], `${label}[${String(index)}]`);
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const field of path.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[field];
  }
  return current;
}

function resolveReference(root: JsonObject, reference: string): JsonObject {
  if (!reference.startsWith('#/')) {
    throw new Error(`unsupported reference ${reference}`);
  }
  let value: unknown = root;
  for (const token of reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!isObject(value) || !(token in value)) {
      throw new Error(`unresolved reference ${reference}`);
    }
    value = value[token];
  }
  if (!isObject(value)) {
    throw new Error(`reference ${reference} does not resolve to a schema`);
  }
  return value;
}

function matchesSchema(value: unknown, schema: JsonObject, root: JsonObject): boolean {
  if (typeof schema.$ref === 'string') {
    return matchesSchema(value, resolveReference(root, schema.$ref), root);
  }
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((candidate) => isObject(candidate) && matchesSchema(value, candidate, root))
      .length !== 1
  ) {
    return false;
  }
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((candidate) => isObject(candidate) && matchesSchema(value, candidate, root))
  ) {
    return false;
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((candidate) => isObject(candidate) && matchesSchema(value, candidate, root))
  ) {
    return false;
  }
  if (isObject(schema.if)) {
    const conditionMatches = matchesSchema(value, schema.if, root);
    if (conditionMatches && isObject(schema.then) && !matchesSchema(value, schema.then, root)) {
      return false;
    }
    if (!conditionMatches && isObject(schema.else) && !matchesSchema(value, schema.else, root)) {
      return false;
    }
  }
  if (isObject(schema.not) && matchesSchema(value, schema.not, root)) {
    return false;
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return false;
  }
  if (isObject(schema.contains)) {
    const containsSchema = schema.contains;
    if (
      !Array.isArray(value) ||
      (() => {
        const matches = value.filter((item) => matchesSchema(item, containsSchema, root)).length;
        const minimum = typeof schema.minContains === 'number' ? schema.minContains : 1;
        const maximum =
          typeof schema.maxContains === 'number' ? schema.maxContains : Number.POSITIVE_INFINITY;
        return matches < minimum || matches > maximum;
      })()
    ) {
      return false;
    }
  }

  if (schema.type === 'null' && value !== null) {
    return false;
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    return false;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      return false;
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return false;
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return false;
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      return false;
    }
    if (
      typeof schema['x-aiq-maxUtf8Bytes'] === 'number' &&
      new TextEncoder().encode(value).byteLength > schema['x-aiq-maxUtf8Bytes']
    ) {
      return false;
    }
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isInteger(value)) ||
      (typeof schema.minimum === 'number' && value < schema.minimum) ||
      (typeof schema.maximum === 'number' && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
    ) {
      return false;
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return false;
    }
    if (
      (typeof schema.minItems === 'number' && value.length < schema.minItems) ||
      (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
    ) {
      return false;
    }
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      return false;
    }
    if (
      Array.isArray(schema['x-aiq-uniqueBy']) &&
      schema['x-aiq-uniqueBy'].some(
        (field) =>
          typeof field !== 'string' ||
          new Set(
            value.map((item) =>
              isObject(item) && typeof item[field] === 'string' ? item[field] : undefined,
            ),
          ).size !== value.length,
      )
    ) {
      return false;
    }
    if (Array.isArray(schema['x-aiq-uniqueTuple'])) {
      const paths = schema['x-aiq-uniqueTuple'];
      if (!paths.every((path): path is string => typeof path === 'string')) {
        return false;
      }
      if (
        new Set(value.map((item) => JSON.stringify(paths.map((path) => valueAtPath(item, path)))))
          .size !== value.length
      ) {
        return false;
      }
    }
    if (isObject(schema['x-aiq-distinctCount'])) {
      const path = schema['x-aiq-distinctCount'].path;
      const expected = schema['x-aiq-distinctCount'].equals;
      if (
        typeof path !== 'string' ||
        typeof expected !== 'number' ||
        new Set(value.map((item) => JSON.stringify(valueAtPath(item, path)))).size !== expected
      ) {
        return false;
      }
    }
    if (Array.isArray(schema.prefixItems)) {
      for (const [index, itemSchema] of schema.prefixItems.entries()) {
        if (
          index >= value.length ||
          !isObject(itemSchema) ||
          !matchesSchema(value[index], itemSchema, root)
        ) {
          return false;
        }
      }
      if (schema.items === false && value.length > schema.prefixItems.length) {
        return false;
      }
    } else if (schema.items === false && value.length > 0) {
      return false;
    }
    const items = schema.items;
    if (isObject(items) && !value.every((item) => matchesSchema(item, items, root))) {
      return false;
    }
  }

  const hasObjectKeywords =
    schema.type === 'object' ||
    isObject(schema.properties) ||
    Array.isArray(schema.required) ||
    schema.additionalProperties !== undefined;
  if (hasObjectKeywords) {
    if (!isObject(value)) {
      return false;
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (
      Array.isArray(schema.required) &&
      schema.required.some((field) => typeof field === 'string' && !(field in value))
    ) {
      return false;
    }
    if (
      (typeof schema.minProperties === 'number' &&
        Object.keys(value).length < schema.minProperties) ||
      (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties)
    ) {
      return false;
    }
    if (isObject(schema.propertyNames)) {
      const propertyNamesSchema = schema.propertyNames;
      if (Object.keys(value).some((field) => !matchesSchema(field, propertyNamesSchema, root))) {
        return false;
      }
    }
    if (Array.isArray(schema['x-aiq-uriBinds'])) {
      const contentHash = value.content_hash;
      const kind = value.kind;
      const uri = value.uri;
      if (
        typeof contentHash !== 'string' ||
        typeof kind !== 'string' ||
        typeof uri !== 'string' ||
        uri !== `aiq-artifact://sha256/${contentHash.slice('sha256:'.length)}/${kind}`
      ) {
        return false;
      }
    }
    if (isObject(schema['x-aiq-saturatingSum'])) {
      const sourceName = schema['x-aiq-saturatingSum'].source;
      const targetName = schema['x-aiq-saturatingSum'].equals;
      const maximum = schema['x-aiq-saturatingSum'].maximum;
      const source = typeof sourceName === 'string' ? value[sourceName] : undefined;
      const target = typeof targetName === 'string' ? value[targetName] : undefined;
      if (
        !isObject(source) ||
        typeof target !== 'number' ||
        typeof maximum !== 'number' ||
        Math.min(
          maximum,
          Object.values(source).reduce(
            (sum: number, item) => sum + (typeof item === 'number' ? item : Number.NaN),
            0,
          ),
        ) !== target
      ) {
        return false;
      }
    }
    for (const [field, fieldValue] of Object.entries(value)) {
      const propertySchema = properties[field];
      if (isObject(propertySchema)) {
        if (!matchesSchema(fieldValue, propertySchema, root)) {
          return false;
        }
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        isObject(schema.additionalProperties) &&
        !matchesSchema(fieldValue, schema.additionalProperties, root)
      ) {
        return false;
      }
    }
  }
  return true;
}

const hex = (value: number, width = 64) => value.toString(16).padStart(width, '0');
const sha256 = (value: number) => `sha256:${hex(value)}`;
const runId = (value: number) => `run_${hex(value)}`;
const resultId = (value: number) => `result_${hex(value)}`;
const nodeId = `node_${'a'.repeat(64)}`;
const publicKey = 'b'.repeat(64);
const syntheticSourceNodeId = 'node_synthetic_demo';
const catalogDigest = 'sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7';
const controlledGeneratedTaskTreeDigest =
  'sha256:e46f743a8f56b87cadcb4cd216a7b2ae679138a3259b42e8870a631f9ea31da4';

const matrix = [
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

const domains = [
  'coding',
  'debugging',
  'repository_understanding',
  'data_processing',
  'retrieval_verification',
  'documentation_communication',
  'planning_execution',
  'tool_use',
  'instruction_following',
  'reliability_recovery',
] as const;

const domainCounts = [8, 8, 7, 8, 7, 7, 7, 7, 6, 7] as const;

function score(model: { family: string; reasoning_effort: string }): JsonObject {
  return {
    schema_version: 'aiq.score-report.v2',
    scoring_version: '1.0.5',
    measurement_version: '2.0.0',
    model,
    tier: 'synthetic_complete',
    score: null,
    quality_score: 100,
    latent_ability: null,
    ranking_eligible: false,
    completion_bounds: { lower: 100, upper: 100 },
    task_resampling_sensitivity_interval: {
      method: 'finite_cluster_calibrated_percentile_sensitivity_v1',
      lower: 100,
      upper: 100,
      central_mass: 0.95,
      samples: 10_000,
      seed: 71_783_153_620_529,
    },
    binary_micro_diagnostic: {
      sample_size: 72,
      successes: 72,
      proportion: 1,
      wilson_lower: 0.949,
      wilson_upper: 1,
    },
    coverage: {
      expected_tasks: 72,
      valid_tasks: 72,
      invalid_tasks: 0,
      missing_tasks: 0,
      not_applicable_tasks: 0,
      expected_domains: 10,
      covered_domains: 10,
    },
    difficulty_coverage: {
      easy: { expected_tasks: 12, valid_tasks: 12 },
      medium: { expected_tasks: 48, valid_tasks: 48 },
      hard: { expected_tasks: 12, valid_tasks: 12 },
    },
    duplicate_results: 0,
    domains: domains.map((domain, index) => ({
      domain,
      expected_tasks: domainCounts[index],
      valid_tasks: domainCounts[index],
      invalid_tasks: 0,
      missing_tasks: 0,
      not_applicable_tasks: 0,
      zero_failure_tasks: 0,
      score: 1,
    })),
    rule: "AIQ measurement 2.0: the Official ranking score is 100 × the Rasch fractional MAP estimate's predicted success probability on an average calibrated task. The latent estimate uses jointly estimated item difficulties and model locations from the complete 17-configuration by 72-task calibration matrix, with weak N(0, 3²) priors and a centered item scale; it reports theta, observed information, and standard error. The theta and score Wald interval is conditional on the released item bank and excludes item-bank calibration uncertainty. The raw equal-domain fixed-fixture mean remains a criterion-referenced diagnostic and is not the ranking score. The strict-pass diagnostic is strict successes divided by all attributable tasks with a valid semantic task score; partial scores are non-passes and remain in this denominator, while missing, infrastructure-invalid, and unscored tasks are excluded. Its Wilson interval uses the same denominator. Official requires non-synthetic 72/72 coverage, 10/10 domains, a complete calibration matrix, and a passed calibration release gate. A complete synthetic fixture is descriptive, has no Official AIQ, and is not ranking eligible. Provisional requires at least 60/72 and at least four valid tasks per domain, is conditional, and is not ranking eligible. Lower coverage publishes no estimate. The task-resampling interval is finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction; it is a fixed-fixture calibrated sensitivity interval for task-mix sensitivity, not a universal confidence interval for model capability. Time and cost remain separate measures.",
  };
}

function normalizedResult(
  model: { family: string; reasoning_effort: string },
  modelIndex: number,
  taskIndex: number,
): JsonObject {
  return {
    schema_version: 'aiq.normalized-result.v1',
    source_result_id: resultId(modelIndex * 72 + taskIndex + 1),
    matrix_batch_id: runId(1),
    run_id: runId(modelIndex + 2),
    task_id: `task-${String(taskIndex + 1).padStart(2, '0')}`,
    task_version: '1.0.5',
    task_hash: sha256(taskIndex + 1),
    domain: domains[taskIndex % domains.length],
    scorer_version: '1.0.5',
    model,
    source_status: 'completed',
    source_evaluation: 'correct',
    outcome: 'correct',
    task_score: 1,
    failure_responsibility: null,
    failure: null,
    response: 'synthetic response',
    response_sha256: sha256(taskIndex + 100),
    evaluator_stdout_sha256: null,
    artifacts: [],
    latency: { wall_ms: 1 },
    tool_usage: { steps: 1, total_calls: 0, by_tool: {} },
    provenance: {
      node_id: syntheticSourceNodeId,
      runner_version: '0.1.0',
      codex_version: 'synthetic-not-invoked',
      observed_at: 'synthetic',
      synthetic: true,
      local_trust: 'untrusted',
    },
  };
}

function resultEfficiency(
  model: { family: string; reasoning_effort: string },
  modelIndex: number,
  taskIndex: number,
): JsonObject {
  return {
    source_result_id: resultId(modelIndex * 72 + taskIndex + 1),
    task_id: `task-${String(taskIndex + 1).padStart(2, '0')}`,
    model,
    observed_wall_ms: 1,
    wall_time_evidence_level: 'runner_observed',
    provider_tokens: {},
    provider_tokens_source: null,
    provider_tokens_evidence_level: null,
    standard_api_equivalent_usd_nanos: null,
    cost_status: 'unavailable_missing_usage',
    cost_evidence_level: null,
  };
}

function efficiency(model: { family: string; reasoning_effort: string }): JsonObject {
  return {
    schema_version: 'aiq.calibration-efficiency.v1',
    model,
    selected_tasks: 72,
    observed_wall_tasks: 72,
    total_observed_wall_ms: 72,
    median_observed_wall_ms: 1,
    p95_observed_wall_ms: 1,
    provider_token_totals: {},
    provider_token_coverage: {
      selected_tasks: 72,
      input_tasks: 0,
      cached_input_tasks: 0,
      cache_write_input_tasks: 0,
      output_tasks: 0,
      reasoning_tasks: 0,
      total_tasks: 0,
    },
    estimated_cost_tasks: 0,
    standard_api_equivalent_usd_nanos: null,
  };
}

function pricing(): JsonObject {
  return {
    method: 'standard_api_equivalent_text_token_estimate',
    version: 'aiq.standard-api-equivalent-usd.v1',
    as_of: '2026-08-02',
    source: 'https://developers.openai.com/api/docs/pricing',
    currency: 'USD',
    processing_tier: 'standard',
    rates: [
      {
        model: 'gpt-5.6-sol',
        input_usd_nanos_per_token: 5_000,
        cached_input_usd_nanos_per_token: 500,
        cache_write_input_usd_nanos_per_token: 6_250,
        output_usd_nanos_per_token: 30_000,
      },
      {
        model: 'gpt-5.6-terra',
        input_usd_nanos_per_token: 2_000,
        cached_input_usd_nanos_per_token: 200,
        cache_write_input_usd_nanos_per_token: 2_500,
        output_usd_nanos_per_token: 12_000,
      },
      {
        model: 'gpt-5.6-luna',
        input_usd_nanos_per_token: 200,
        cached_input_usd_nanos_per_token: 20,
        cache_write_input_usd_nanos_per_token: 250,
        output_usd_nanos_per_token: 1_200,
      },
    ],
    formula:
      '(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again',
    hosted_tool_fees_included: false,
    limitation:
      'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing',
  };
}

function normalizedBatch(): JsonObject {
  return {
    schema_version: 'aiq.normalized-batch.v3',
    matrix_batch_id: runId(1),
    package_sha256: 'c'.repeat(64),
    content_hash: sha256(2),
    signer: { node_id: nodeId, public_key: publicKey },
    task_set_id: 'aiq-core',
    task_set_version: '1.0.5',
    task_set_hash: sha256(3),
    capability_validation_digest: null,
    provenance: null,
    run_class: null,
    benchmark_version: 'aiq-core@1.0.5',
    prompt_set_digest: sha256(4),
    scoring_version: '1.0.5',
    runner_commit: 'd'.repeat(40),
    region: 'local-test',
    scheduled_unix_ms: 0,
    started_unix_ms: 1,
    finished_unix_ms: 2,
    synthetic: true,
    runs: matrix.map(([family, reasoning_effort], modelIndex) => {
      const model = { family, reasoning_effort };
      return {
        schema_version: 'aiq.normalized-model-run.v1',
        run_id: runId(modelIndex + 2),
        matrix_batch_id: runId(1),
        model_config_id: `${family}-${reasoning_effort}`,
        model,
        score: score(model),
        results: Array.from({ length: 72 }, (_, taskIndex) =>
          normalizedResult(model, modelIndex, taskIndex),
        ),
      };
    }),
    execution_concurrency: 17,
    result_efficiency: matrix.flatMap(([family, reasoning_effort], modelIndex) => {
      const model = { family, reasoning_effort };
      return Array.from({ length: 72 }, (_, taskIndex) =>
        resultEfficiency(model, modelIndex, taskIndex),
      );
    }),
    efficiency: matrix.map(([family, reasoning_effort]) =>
      efficiency({ family, reasoning_effort }),
    ),
    pricing: pricing(),
    normalization_digest: sha256(5),
  };
}

function runProvenance(): JsonObject {
  return {
    schema_version: 'aiq.run-provenance.v2',
    run_class: 'official',
    corpus_release_id: 'corpus_fixture',
    corpus_commitment_sha256: sha256(10),
    catalog_digest: catalogDigest,
    task_set_digest: sha256(3),
    evaluator_digest: sha256(11),
    runtime_digest: sha256(12),
    preflight_digest: sha256(13),
    harness_digest: sha256(14),
    prompt_digest: sha256(4),
    tool_policy_digest: sha256(15),
    network_policy_digest: sha256(16),
    environment_digest: sha256(17),
    source_manifest_digest: sha256(18),
    runner_executable_digest: sha256(19),
    codex_executable_digest: sha256(20),
    permission_evidence_digest: sha256(22),
  };
}

function capabilityValidation(): JsonObject {
  const version = 'codex fixture';
  return {
    schema_version: 'aiq.capability-validation.v2',
    node_id: nodeId,
    manifest_issues: [],
    cli_probe: {
      status: 'available',
      version,
      failure: null,
    },
    authentication_probe: {
      status: 'available',
      mode: 'chatgpt_subscription',
      failure: null,
    },
    models: matrix.map(([family, reasoning_effort], index) => ({
      model: { family, reasoning_effort },
      status: 'available',
      reason: 'active probe succeeded',
      probe: {
        status: 'available',
        codex_version: version,
        observed_at: 'unix-ms:1',
        result_digest: sha256(100 + index),
        result_preview: 'AIQ_PREFLIGHT_OK',
        artifacts: [],
        evidence_digest: sha256(200 + index),
        failure: null,
      },
    })),
  };
}

function productionBatch(): JsonObject {
  const batch = normalizedBatch();

  batch.synthetic = false;
  batch.capability_validation_digest = sha256(13);
  batch.provenance = runProvenance();
  batch.run_class = 'official';

  for (const runValue of requireArrayProperty(batch, 'runs')) {
    const run = requireObject(runValue, 'run');
    const report = requireObjectProperty(run, 'score');
    report.tier = 'official';
    report.score = report.quality_score;
    for (const resultValue of requireArrayProperty(run, 'results')) {
      const result = requireObject(resultValue, 'result');
      requireObjectProperty(result, 'provenance').synthetic = false;
    }
  }

  return batch;
}

function attestation(): JsonObject {
  return {
    schema_version: 'aiq.verifier-attestation.v3',
    signature_algorithm: 'ed25519',
    signature_version: 'aiq.ed25519-jcs.v1',
    matrix_batch_id: runId(1),
    package_sha256: 'c'.repeat(64),
    content_hash: sha256(2),
    normalization_digest: sha256(5),
    task_set_hash: sha256(3),
    capability_validation_digest: null,
    provenance: null,
    benchmark_version: 'aiq-core@1.0.5',
    prompt_set_digest: sha256(4),
    scoring_version: '1.0.5',
    verifier: { node_id: nodeId, public_key: publicKey },
    observed_unix_ms: 3,
    replay_status: 'commitments_verified',
    policy: 'synthetic_test',
    synthetic: true,
    signature: 'e'.repeat(128),
  };
}

function productionAttestation(): JsonObject {
  const value = attestation();

  value.synthetic = false;
  value.capability_validation_digest = sha256(13);
  value.provenance = runProvenance();
  value.policy = 'production';
  value.replay_status = 'evaluator_replayed';

  return value;
}

function rejection(): JsonObject {
  return {
    schema_version: 'aiq.verifier-rejection.v2',
    matrix_batch_id: runId(1),
    package_sha256: 'c'.repeat(64),
    observed_at: '2026-07-24T18:00:00.123456Z',
    production: false,
    reason_code: 'verification_failed',
    reason_detail: 'Synthetic verifier rejection contract fixture.',
    synthetic: true,
    verifier_node_id: nodeId,
  };
}

const parseSchema = async (path: string): Promise<JsonObject> => {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isObject(value)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return value;
};

await test('representative normalized Rust wire objects match both public schemas', async () => {
  const batchSchema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const attestationSchema = await parseSchema(
    'benchmarks/schema/verifier-attestation-v3.schema.json',
  );

  strictEqual(matchesSchema(normalizedBatch(), batchSchema, batchSchema), true);
  strictEqual(matchesSchema(attestation(), attestationSchema, attestationSchema), true);
});

await test('synthetic-complete scores are descriptive and never Official', async () => {
  const schema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const batch = normalizedBatch();
  const firstRun = requireObjectAt(requireArrayProperty(batch, 'runs'), 0, 'runs');
  const report = requireObjectProperty(firstRun, 'score');

  strictEqual(report.tier, 'synthetic_complete');
  strictEqual(report.score, null);
  strictEqual(report.quality_score, 100);
  strictEqual(report.ranking_eligible, false);
  strictEqual(matchesSchema(batch, schema, schema), true);

  const falseOfficial = structuredClone(batch);
  const falseOfficialRun = requireObjectAt(requireArrayProperty(falseOfficial, 'runs'), 0, 'runs');
  requireObjectProperty(falseOfficialRun, 'score').score = 100;
  strictEqual(matchesSchema(falseOfficial, schema, schema), false);

  const missingDescriptive = structuredClone(batch);
  const missingDescriptiveRun = requireObjectAt(
    requireArrayProperty(missingDescriptive, 'runs'),
    0,
    'runs',
  );
  requireObjectProperty(missingDescriptiveRun, 'score').quality_score = null;
  strictEqual(matchesSchema(missingDescriptive, schema, schema), false);

  const incompleteMutations: ReadonlyArray<readonly [string, (report: JsonObject) => void]> = [
    [
      'valid task count',
      (changedReport) => {
        requireObjectProperty(changedReport, 'coverage').valid_tasks = 71;
      },
    ],
    [
      'invalid task count',
      (changedReport) => {
        requireObjectProperty(changedReport, 'coverage').invalid_tasks = 1;
      },
    ],
    [
      'missing task count',
      (changedReport) => {
        requireObjectProperty(changedReport, 'coverage').missing_tasks = 1;
      },
    ],
    [
      'not-applicable task count',
      (changedReport) => {
        requireObjectProperty(changedReport, 'coverage').not_applicable_tasks = 1;
      },
    ],
    [
      'expected domain count',
      (changedReport) => {
        requireObjectProperty(changedReport, 'coverage').expected_domains = 9;
      },
    ],
    [
      'covered domain count',
      (changedReport) => {
        requireObjectProperty(changedReport, 'coverage').covered_domains = 9;
      },
    ],
    ['duplicate result count', (changedReport) => void (changedReport.duplicate_results = 1)],
    [
      'domain cardinality',
      (changedReport) => {
        requireArrayProperty(changedReport, 'domains').pop();
      },
    ],
    [
      'domain identity uniqueness',
      (changedReport) => {
        const changedDomains = requireArrayProperty(changedReport, 'domains');
        requireObjectAt(changedDomains, changedDomains.length - 1, 'domains').domain = 'coding';
      },
    ],
    [
      'complete domain status',
      (changedReport) => {
        requireObjectAt(
          requireArrayProperty(changedReport, 'domains'),
          0,
          'domains',
        ).missing_tasks = 1;
      },
    ],
    [
      'complete domain score',
      (changedReport) => {
        requireObjectAt(requireArrayProperty(changedReport, 'domains'), 0, 'domains').score = null;
      },
    ],
  ];

  for (const [label, mutate] of incompleteMutations) {
    const changed = structuredClone(batch);
    const changedRun = requireObjectAt(requireArrayProperty(changed, 'runs'), 0, 'runs');
    mutate(requireObjectProperty(changedRun, 'score'));
    strictEqual(matchesSchema(changed, schema, schema), false, label);
  }
});

await test('batch provenance rejects contradictory score tiers and permits partial synthetic tiers', async () => {
  const schema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');

  const syntheticOfficial = normalizedBatch();
  const syntheticOfficialRun = requireObjectAt(
    requireArrayProperty(syntheticOfficial, 'runs'),
    0,
    'runs',
  );
  const syntheticOfficialReport = requireObjectProperty(syntheticOfficialRun, 'score');
  syntheticOfficialReport.tier = 'official';
  syntheticOfficialReport.score = syntheticOfficialReport.quality_score;
  strictEqual(matchesSchema(syntheticOfficial, schema, schema), false);

  const productionSyntheticComplete = productionBatch();
  const productionSyntheticCompleteRun = requireObjectAt(
    requireArrayProperty(productionSyntheticComplete, 'runs'),
    0,
    'runs',
  );
  const productionSyntheticCompleteReport = requireObjectProperty(
    productionSyntheticCompleteRun,
    'score',
  );
  productionSyntheticCompleteReport.tier = 'synthetic_complete';
  productionSyntheticCompleteReport.score = null;
  strictEqual(matchesSchema(productionSyntheticComplete, schema, schema), false);

  for (const tier of ['provisional', 'coverage_only', 'not_applicable']) {
    const partialSynthetic = normalizedBatch();
    const partialSyntheticRun = requireObjectAt(
      requireArrayProperty(partialSynthetic, 'runs'),
      0,
      'runs',
    );
    const partialSyntheticReport = requireObjectProperty(partialSyntheticRun, 'score');
    partialSyntheticReport.tier = tier;
    if (tier !== 'provisional') {
      partialSyntheticReport.quality_score = null;
      partialSyntheticReport.completion_bounds = null;
      partialSyntheticReport.task_resampling_sensitivity_interval = null;
    }
    strictEqual(matchesSchema(partialSynthetic, schema, schema), true, tier);
  }
});

await test('the current corpus commitment has one direct state', async () => {
  const schema = await parseSchema('benchmarks/schema/corpus-commitment-v2.schema.json');
  const properties = requireObjectProperty(schema, 'properties');
  const fields = [
    'schema_version',
    'release_id',
    'controlled',
    'synthetic',
    'catalog',
    'execution',
    'tasks',
  ];

  deepStrictEqual(schema.required, fields);
  deepStrictEqual(Object.keys(properties), fields);
  strictEqual(
    requireObjectProperty(properties, 'schema_version').const,
    'aiq.corpus-commitment.v2',
  );
  strictEqual(
    requireObjectProperty(
      requireObjectProperty(requireObjectProperty(properties, 'catalog'), 'properties'),
      'task_set_version',
    ).const,
    '1.0.5',
  );
  strictEqual(schema.additionalProperties, false);

  for (const retiredField of ['release_status', 'lineage', 'review']) {
    strictEqual(retiredField in properties, false);
  }
});

await test('corpus runtime components keep stable fields and bounded diagnostics', async () => {
  const schema = await parseSchema('benchmarks/schema/corpus-commitment-v2.schema.json');
  const definitions = requireObjectProperty(schema, '$defs');
  const runtime = requireObjectProperty(definitions, 'runtimeProvenance');
  const runtimeProperties = requireObjectProperty(runtime, 'properties');
  const nodeRuntime = requireObjectProperty(runtimeProperties, 'node_runtime');
  const nodeProperties = requireObjectProperty(nodeRuntime, 'properties');
  const components = requireObjectProperty(nodeProperties, 'components');
  const componentProperties = requireObjectProperty(components, 'properties');

  deepStrictEqual(components.required, [
    'icu',
    'tz',
    'unicode',
    'v8',
    'modules',
    'openssl',
    'zlib',
  ]);
  deepStrictEqual(Object.keys(componentProperties), components.required);
  strictEqual(components.minProperties, 7);
  strictEqual(components.maxProperties, 64);
  strictEqual(
    requireObjectProperty(components, 'propertyNames').pattern,
    '^[a-z][a-z0-9_]{0,31}(?![\\s\\S])',
  );
  strictEqual(
    requireObjectProperty(components, 'additionalProperties').$ref,
    '#/$defs/additionalComponentVersion',
  );
  const additionalVersion = requireObjectProperty(definitions, 'additionalComponentVersion');
  strictEqual(additionalVersion.type, 'string');
  strictEqual(additionalVersion.maxLength, 80);
  strictEqual(additionalVersion.pattern, '^[A-Za-z0-9.+_-]{0,80}(?![\\s\\S])');
});

await test('public wire schemas bind only the active AIQ Core 1.0.5 release', async () => {
  const schemas = await Promise.all(
    [
      'benchmarks/schema/result-package-v3.schema.json',
      'benchmarks/schema/normalized-batch-v3.schema.json',
      'benchmarks/schema/verifier-attestation-v3.schema.json',
      'benchmarks/schema/corpus-commitment-v2.schema.json',
    ].map(parseSchema),
  );
  const resultPackage = requireObjectAt(schemas, 0, 'release schemas');
  const normalizedBatchSchema = requireObjectAt(schemas, 1, 'release schemas');
  const attestationSchema = requireObjectAt(schemas, 2, 'release schemas');
  const corpusCommitment = requireObjectAt(schemas, 3, 'release schemas');

  const resultPayload = requireObjectProperty(
    requireObjectProperty(resultPackage, 'properties'),
    'payload',
  );
  const resultPayloadProperties = requireObjectProperty(resultPayload, 'properties');
  strictEqual(requireObjectProperty(resultPayloadProperties, 'scoring_version').const, '1.0.5');
  const resultDefinitions = requireObjectProperty(resultPackage, '$defs');
  strictEqual(
    requireObjectProperty(
      requireObjectProperty(requireObjectProperty(resultDefinitions, 'taskResult'), 'properties'),
      'task_version',
    ).const,
    '1.0.5',
  );
  strictEqual(
    requireObjectProperty(
      requireObjectProperty(
        requireObjectProperty(resultDefinitions, 'runProvenance'),
        'properties',
      ),
      'catalog_digest',
    ).const,
    catalogDigest,
  );

  const normalizedProperties = requireObjectProperty(normalizedBatchSchema, 'properties');
  strictEqual(requireObjectProperty(normalizedProperties, 'task_set_id').const, 'aiq-core');
  strictEqual(requireObjectProperty(normalizedProperties, 'task_set_version').const, '1.0.5');
  strictEqual(
    requireObjectProperty(normalizedProperties, 'benchmark_version').const,
    'aiq-core@1.0.5',
  );
  strictEqual(requireObjectProperty(normalizedProperties, 'scoring_version').const, '1.0.5');
  const normalizedDefinitions = requireObjectProperty(normalizedBatchSchema, '$defs');
  strictEqual(
    requireObjectProperty(
      requireObjectProperty(
        requireObjectProperty(normalizedDefinitions, 'normalizedTaskResult'),
        'properties',
      ),
      'task_version',
    ).const,
    '1.0.5',
  );
  strictEqual(
    requireObjectProperty(
      requireObjectProperty(
        requireObjectProperty(normalizedDefinitions, 'normalizedTaskResult'),
        'properties',
      ),
      'scorer_version',
    ).const,
    '1.0.5',
  );
  strictEqual(
    requireObjectProperty(
      requireObjectProperty(
        requireObjectProperty(normalizedDefinitions, 'scoreReport'),
        'properties',
      ),
      'scoring_version',
    ).const,
    '1.0.5',
  );

  const attestationProperties = requireObjectProperty(attestationSchema, 'properties');
  strictEqual(
    requireObjectProperty(attestationProperties, 'benchmark_version').const,
    'aiq-core@1.0.5',
  );
  strictEqual(requireObjectProperty(attestationProperties, 'scoring_version').const, '1.0.5');

  const corpusProperties = requireObjectProperty(corpusCommitment, 'properties');
  const corpusCatalogProperties = requireObjectProperty(
    requireObjectProperty(corpusProperties, 'catalog'),
    'properties',
  );
  strictEqual(
    requireObjectProperty(corpusCatalogProperties, 'identity_sha256').const,
    catalogDigest,
  );
  const corpusDefinitions = requireObjectProperty(corpusCommitment, '$defs');
  strictEqual(
    requireObjectProperty(
      requireObjectProperty(requireObjectProperty(corpusDefinitions, 'task'), 'properties'),
      'task_version',
    ).const,
    '1.0.5',
  );
});

await test('normalized and attestation provenance conditionals enforce the full policy', async () => {
  const batchSchema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const attestationSchema = await parseSchema(
    'benchmarks/schema/verifier-attestation-v3.schema.json',
  );

  strictEqual(matchesSchema(productionBatch(), batchSchema, batchSchema), true);
  strictEqual(matchesSchema(productionAttestation(), attestationSchema, attestationSchema), true);

  for (const schema of [batchSchema, attestationSchema]) {
    const synthetic = schema === batchSchema ? normalizedBatch() : attestation();
    const production = schema === batchSchema ? productionBatch() : productionAttestation();

    const syntheticCapability = structuredClone(synthetic);
    syntheticCapability.capability_validation_digest = sha256(13);
    strictEqual(matchesSchema(syntheticCapability, schema, schema), false);

    const syntheticProvenance = structuredClone(synthetic);
    syntheticProvenance.provenance = runProvenance();
    strictEqual(matchesSchema(syntheticProvenance, schema, schema), false);

    if (schema === batchSchema) {
      const syntheticRunClass = structuredClone(synthetic);
      syntheticRunClass.run_class = 'official';
      strictEqual(matchesSchema(syntheticRunClass, schema, schema), false);
    }

    const missingCapability = structuredClone(production);
    missingCapability.capability_validation_digest = null;
    strictEqual(matchesSchema(missingCapability, schema, schema), false);

    const missingProvenance = structuredClone(production);
    missingProvenance.provenance = null;
    strictEqual(matchesSchema(missingProvenance, schema, schema), false);

    if (schema === batchSchema) {
      const missingRunClass = structuredClone(production);
      missingRunClass.run_class = null;
      strictEqual(matchesSchema(missingRunClass, schema, schema), false);
    }
  }
});

await test('all current run provenance digests are nonzero', async () => {
  const schemas = await Promise.all(
    [
      'benchmarks/schema/result-package-v3.schema.json',
      'benchmarks/schema/normalized-batch-v3.schema.json',
      'benchmarks/schema/verifier-attestation-v3.schema.json',
    ].map(parseSchema),
  );
  const provenanceFields = [
    'schema_version',
    'run_class',
    'corpus_release_id',
    'corpus_commitment_sha256',
    'catalog_digest',
    'task_set_digest',
    'evaluator_digest',
    'runtime_digest',
    'preflight_digest',
    'harness_digest',
    'prompt_digest',
    'tool_policy_digest',
    'network_policy_digest',
    'environment_digest',
    'source_manifest_digest',
    'runner_executable_digest',
    'codex_executable_digest',
    'permission_evidence_digest',
  ];
  const digestFields = [
    'corpus_commitment_sha256',
    'catalog_digest',
    'task_set_digest',
    'evaluator_digest',
    'runtime_digest',
    'preflight_digest',
    'harness_digest',
    'prompt_digest',
    'tool_policy_digest',
    'network_policy_digest',
    'environment_digest',
    'source_manifest_digest',
    'runner_executable_digest',
    'codex_executable_digest',
    'permission_evidence_digest',
  ];

  for (const schema of schemas) {
    const definitions = requireObjectProperty(schema, '$defs');
    const provenanceSchema = requireObjectProperty(definitions, 'runProvenance');
    const properties = requireObjectProperty(provenanceSchema, 'properties');

    deepStrictEqual(Object.keys(runProvenance()), provenanceFields);
    deepStrictEqual(provenanceSchema.required, provenanceFields);
    deepStrictEqual(Object.keys(properties), provenanceFields);
    strictEqual(provenanceSchema.additionalProperties, false);
    strictEqual(matchesSchema(runProvenance(), provenanceSchema, schema), true);

    for (const field of digestFields) {
      const changed = runProvenance();
      changed[field] = `sha256:${'0'.repeat(64)}`;
      strictEqual(
        matchesSchema(changed, provenanceSchema, schema),
        false,
        `${field} must reject the zero digest`,
      );
    }
  }

  for (const schema of schemas.slice(1)) {
    const provenanceSchema = requireObjectProperty(
      requireObjectProperty(schema, '$defs'),
      'runProvenance',
    );
    const changedCatalog = runProvenance();
    changedCatalog.catalog_digest = sha256(99);
    strictEqual(matchesSchema(changedCatalog, provenanceSchema, schema), false);
  }
});

await test('v3 public wire schemas reject zero content and package digests', async () => {
  const resultSchema = await parseSchema('benchmarks/schema/result-package-v3.schema.json');
  const resultPackage = requireObject(
    JSON.parse(await readFile('benchmarks/fixtures/result-package-v3.synthetic.json', 'utf8')),
    'result package fixture',
  );
  resultPackage.content_hash = `sha256:${'0'.repeat(64)}`;
  strictEqual(matchesSchema(resultPackage, resultSchema, resultSchema), false);

  const batchSchema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const batch = normalizedBatch();
  batch.package_sha256 = '0'.repeat(64);
  strictEqual(matchesSchema(batch, batchSchema, batchSchema), false);

  const attestationSchema = await parseSchema(
    'benchmarks/schema/verifier-attestation-v3.schema.json',
  );
  const attestationValue = attestation();
  attestationValue.package_sha256 = '0'.repeat(64);
  strictEqual(matchesSchema(attestationValue, attestationSchema, attestationSchema), false);

  const rejectionSchema = await parseSchema('benchmarks/schema/verifier-rejection-v2.schema.json');
  const rejectionValue = rejection();
  rejectionValue.package_sha256 = '0'.repeat(64);
  strictEqual(matchesSchema(rejectionValue, rejectionSchema, rejectionSchema), false);
});

await test('result package v3 schema accepts the golden fixture and rejects a noncurrent protocol', async () => {
  const schema = await parseSchema('benchmarks/schema/result-package-v3.schema.json');
  const fixtureValue: unknown = JSON.parse(
    await readFile('benchmarks/fixtures/result-package-v3.synthetic.json', 'utf8'),
  );
  const fixture = requireObject(fixtureValue, 'result package fixture');

  strictEqual(matchesSchema(fixture, schema, schema), true);

  const noncurrent = structuredClone(fixture);
  noncurrent.schema_version = 'aiq.result-package.v4';
  noncurrent.payload_type = 'aiq.run.v4';
  requireObjectProperty(noncurrent, 'payload').schema_version = 'aiq.run.v4';

  strictEqual(matchesSchema(noncurrent, schema, schema), false);

  for (const mutate of [
    (value: JsonObject) => {
      requireObjectProperty(requireObjectProperty(value, 'payload'), 'schedule_slot').unexpected =
        true;
    },
    (value: JsonObject) => {
      requireObjectAt(
        requireArrayProperty(requireObjectProperty(value, 'payload'), 'models'),
        0,
        'models',
      ).unexpected = true;
    },
    (value: JsonObject) => {
      requireObjectProperty(
        requireObjectAt(
          requireArrayProperty(requireObjectProperty(value, 'payload'), 'results'),
          0,
          'results',
        ),
        'tool_usage',
      ).unexpected = true;
    },
    (value: JsonObject) => {
      requireObjectProperty(
        requireObjectAt(
          requireArrayProperty(requireObjectProperty(value, 'payload'), 'results'),
          0,
          'results',
        ),
        'provenance',
      ).unexpected = true;
    },
  ]) {
    const unexpected = structuredClone(fixture);
    mutate(unexpected);
    strictEqual(matchesSchema(unexpected, schema, schema), false);
  }
});

await test('capability validation accepts the serialized workspace-integrity adapter failure', async () => {
  const schema = await parseSchema('benchmarks/schema/result-package-v3.schema.json');
  const report = capabilityValidation();
  const entry = requireObjectAt(requireArrayProperty(report, 'models'), 0, 'models');
  const probe = requireObjectProperty(entry, 'probe');

  entry.status = 'unavailable';
  entry.reason = 'workspace integrity evidence unavailable';
  probe.status = 'failed';
  probe.result_digest = null;
  probe.result_preview = null;
  probe.failure = {
    kind: 'workspace_integrity',
    exit_code: null,
    stderr: '',
    message: 'workspace integrity evidence unavailable',
    stdout_truncated: false,
    stderr_truncated: false,
    artifacts: [],
  };

  const reportSchema = resolveReference(schema, '#/$defs/capabilityValidationReport');
  strictEqual(matchesSchema(report, reportSchema, schema), true);

  const unknown = structuredClone(report);
  requireObjectProperty(
    requireObjectProperty(
      requireObjectAt(requireArrayProperty(unknown, 'models'), 0, 'models'),
      'probe',
    ),
    'failure',
  ).kind = 'unknown_adapter_failure';
  strictEqual(matchesSchema(unknown, reportSchema, schema), false);
});

await test('result submission schema rejects matrix, pair, status, byte, artifact, and tool mutations', async () => {
  const schema = await parseSchema('benchmarks/schema/result-package-v3.schema.json');
  const fixture = requireObject(
    JSON.parse(await readFile('benchmarks/fixtures/result-package-v3.synthetic.json', 'utf8')),
    'result package fixture',
  );
  const reject = (label: string, mutate: (value: JsonObject) => void) => {
    const changed = structuredClone(fixture);
    mutate(changed);
    strictEqual(matchesSchema(changed, schema, schema), false, label);
  };
  const results = (value: JsonObject) =>
    requireArrayProperty(requireObjectProperty(value, 'payload'), 'results');
  const firstResult = (value: JsonObject) => requireObjectAt(results(value), 0, 'results');

  reject('matrix order and uniqueness are exact', (value) => {
    const models = requireArrayProperty(requireObjectProperty(value, 'payload'), 'models');
    models[1] = structuredClone(models[0]);
  });
  reject('one result per task and model pair is required', (value) => {
    const values = results(value);
    const duplicate = structuredClone(requireObjectAt(values, 0, 'results'));
    duplicate.result_id = resultId(9_999);
    values[1] = duplicate;
  });
  reject('exactly 72 distinct task identities are required', (value) => {
    firstResult(value).task_id = 'extra-task';
  });
  reject('unknown result statuses are rejected', (value) => {
    firstResult(value).status = 'garbage';
  });
  reject('completed results require a response', (value) => {
    firstResult(value).response = null;
  });
  reject('tool totals equal the saturating by-tool sum', (value) => {
    requireObjectProperty(firstResult(value), 'tool_usage').total_calls = 1;
  });
  reject('result artifacts cannot use the workspace-manifest role', (value) => {
    requireArrayProperty(firstResult(value), 'artifacts').push({
      kind: 'workspace-manifest.json',
      content_hash: sha256(9_000),
      uri: `aiq-artifact://sha256/${hex(9_000)}/workspace-manifest.json`,
      bytes: 1,
    });
  });
  reject('artifact URIs bind the sibling digest and kind', (value) => {
    requireArrayProperty(firstResult(value), 'artifacts').push({
      kind: 'stdout.jsonl',
      content_hash: sha256(9_001),
      uri: `aiq-artifact://sha256/${hex(9_002)}/stdout.jsonl`,
      bytes: 1,
    });
  });
  reject('response limits count UTF-8 bytes', (value) => {
    firstResult(value).response = '😀'.repeat(17);
  });
  reject('runner versions reject escaped or multiline signed text', (value) => {
    requireObjectProperty(firstResult(value), 'provenance').runner_version = 'bad\nversion';
  });
});

await test('workspace integrity is a failed post-invocation result taxonomy', async () => {
  const resultSchema = await parseSchema('benchmarks/schema/result-package-v3.schema.json');
  const fixture = requireObject(
    JSON.parse(await readFile('benchmarks/fixtures/result-package-v3.synthetic.json', 'utf8')),
    'result package fixture',
  );
  const result = structuredClone(
    requireObjectAt(
      requireArrayProperty(requireObjectProperty(fixture, 'payload'), 'results'),
      0,
      'results',
    ),
  );
  result.status = 'failed';
  result.evaluation = 'not_evaluated';
  result.task_score = null;
  result.response = null;
  result.response_sha256 = null;
  result.evaluator_result_sha256 = null;
  result.failure = {
    kind: 'workspace_integrity',
    message: 'post-invocation workspace evidence could not be retained',
    exit_code: 0,
    retryable: true,
  };
  requireObjectProperty(result, 'provenance').synthetic = false;

  const taskResultSchema = resolveReference(resultSchema, '#/$defs/taskResult');
  strictEqual(matchesSchema(result, taskResultSchema, resultSchema), true);

  const retainedResponse = structuredClone(result);
  retainedResponse.response = 'must not survive workspace-integrity failure';
  retainedResponse.response_sha256 = sha256(9_003);
  strictEqual(matchesSchema(retainedResponse, taskResultSchema, resultSchema), false);

  const adapterOnlyFailure = structuredClone(result);
  requireObjectProperty(adapterOnlyFailure, 'failure').kind = 'usage_limit';
  strictEqual(matchesSchema(adapterOnlyFailure, taskResultSchema, resultSchema), false);

  const normalizedSchema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const normalized = normalizedResult({ family: 'sol', reasoning_effort: 'low' }, 0, 0);
  normalized.source_status = 'failed';
  normalized.source_evaluation = 'not_evaluated';
  normalized.outcome = 'invalid';
  normalized.task_score = null;
  normalized.failure_responsibility = 'benchmark_infrastructure';
  normalized.failure = structuredClone(result.failure);
  normalized.response = null;
  normalized.response_sha256 = null;
  requireObjectProperty(normalized, 'provenance').synthetic = false;

  strictEqual(
    matchesSchema(
      normalized,
      resolveReference(normalizedSchema, '#/$defs/normalizedTaskResult'),
      normalizedSchema,
    ),
    true,
  );
});

await test('evaluator results v1 schema accepts positional evidence and enforces check limits', async () => {
  const schema = await parseSchema('benchmarks/schema/evaluator-results-v1.schema.json');
  const fixtureValue: unknown = JSON.parse(
    await readFile('benchmarks/fixtures/evaluator-results-v1.synthetic.json', 'utf8'),
  );
  const fixture = requireObject(fixtureValue, 'evaluator results fixture');

  strictEqual(matchesSchema(fixture, schema, schema), true);
  const rawBound = structuredClone(fixture);
  requireObjectAt(requireArrayProperty(rawBound, 'results'), 0, 'results').raw_stdout_sha256 =
    sha256(91);
  strictEqual(matchesSchema(rawBound, schema, schema), true);
  requireObjectAt(requireArrayProperty(rawBound, 'results'), 0, 'results').raw_stdout_sha256 =
    `sha256:${'0'.repeat(64)}`;
  strictEqual(matchesSchema(rawBound, schema, schema), false);

  const unexpected = structuredClone(fixture);
  unexpected.unexpected = true;
  strictEqual(matchesSchema(unexpected, schema, schema), false);

  const wrongFailureClass = structuredClone(fixture);
  const wrongCheck = requireObjectAt(
    requireArrayProperty(
      requireObjectAt(requireArrayProperty(wrongFailureClass, 'results'), 0, 'results'),
      'checks',
    ),
    0,
    'checks',
  );
  wrongCheck.failure_class = 'value';
  strictEqual(matchesSchema(wrongFailureClass, schema, schema), false);

  const maximumChecks = structuredClone(fixture);
  const checks = requireArrayProperty(
    requireObjectAt(requireArrayProperty(maximumChecks, 'results'), 0, 'results'),
    'checks',
  );
  while (checks.length < 16) {
    checks.push({
      ...requireObjectAt(checks, 0, 'checks'),
      check_id: `check_${String(checks.length + 1)}`,
    });
  }
  strictEqual(matchesSchema(maximumChecks, schema, schema), true);

  const tooManyChecks = structuredClone(maximumChecks);
  requireArrayProperty(
    requireObjectAt(requireArrayProperty(tooManyChecks, 'results'), 0, 'results'),
    'checks',
  ).push({
    ...requireObjectAt(checks, 0, 'checks'),
    check_id: 'check_17',
  });
  strictEqual(matchesSchema(tooManyChecks, schema, schema), false);
});

await test('result submission provenance is explicit and calibration packages stay outside the endpoint', async () => {
  const schema = await parseSchema('benchmarks/schema/result-package-v3.schema.json');
  const fixture = requireObject(
    JSON.parse(await readFile('benchmarks/fixtures/result-package-v3.synthetic.json', 'utf8')),
    'result package fixture',
  );
  const payload = requireObjectProperty(fixture, 'payload');

  strictEqual(payload.provenance, null);

  const missing = structuredClone(fixture);
  delete requireObjectProperty(missing, 'payload').provenance;
  strictEqual(matchesSchema(missing, schema, schema), false);

  const syntheticObject = structuredClone(fixture);
  requireObjectProperty(syntheticObject, 'payload').provenance = runProvenance();
  strictEqual(matchesSchema(syntheticObject, schema, schema), false);

  const production = structuredClone(fixture);
  const productionPayload = requireObjectProperty(production, 'payload');
  productionPayload.synthetic = false;
  productionPayload.capability_validation = capabilityValidation();
  productionPayload.provenance = runProvenance();
  strictEqual(matchesSchema(production, schema, schema), true);

  const productionNull = structuredClone(production);
  requireObjectProperty(productionNull, 'payload').provenance = null;
  strictEqual(matchesSchema(productionNull, schema, schema), false);

  const calibration = structuredClone(production);
  calibration.payload_type = 'aiq.calibration-run.v3';
  const calibrationPayload = requireObjectProperty(calibration, 'payload');
  calibrationPayload.schema_version = 'aiq.calibration-run.v3';
  calibrationPayload.official_eligible = false;
  calibrationPayload.classification = 'local_calibration_non_official';
  const calibrationProvenance = runProvenance();
  calibrationProvenance.run_class = 'calibration';
  calibrationPayload.provenance = calibrationProvenance;
  calibrationPayload.task_ids = ['synthetic-01'];
  delete calibrationPayload.synthetic;
  strictEqual(matchesSchema(calibration, schema, schema), false);

  const productionCalibration = structuredClone(production);
  requireObjectProperty(productionCalibration, 'payload').provenance = calibrationProvenance;
  strictEqual(matchesSchema(productionCalibration, schema, schema), false);
});

await test('normalized batch schema enforces closed records and exact matrix cardinality', async () => {
  const schema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const batch = normalizedBatch();

  strictEqual(batch.execution_concurrency, 17);
  strictEqual(requireArrayProperty(batch, 'result_efficiency').length, 1_224);
  strictEqual(requireArrayProperty(batch, 'efficiency').length, 17);
  deepStrictEqual(requireObjectProperty(schema, 'x-aiq-limits'), {
    canonical_stage_bytes: 4_194_304,
    model_runs: 17,
    results_per_model_run: 72,
    execution_concurrency: 32,
    result_efficiency: 1_224,
    efficiency_aggregates: 17,
    result_response_preview_utf8_bytes: 1_024,
  });

  const missing = structuredClone(batch);
  delete missing.normalization_digest;
  strictEqual(matchesSchema(missing, schema, schema), false);

  const extra = structuredClone(batch);
  extra.unexpected = true;
  strictEqual(matchesSchema(extra, schema, schema), false);

  for (const count of [16, 18]) {
    const changed = structuredClone(batch);
    const runs = requireArrayProperty(changed, 'runs');
    changed.runs = runs.slice(0, count);
    if (count === 18) {
      const changedRuns = requireArrayProperty(changed, 'runs');
      changedRuns.push(requireObjectAt(changedRuns, 0, 'runs'));
    }
    strictEqual(matchesSchema(changed, schema, schema), false);
  }

  const child = structuredClone(batch);
  requireObjectAt(requireArrayProperty(child, 'runs'), 0, 'runs').unexpected = true;
  strictEqual(matchesSchema(child, schema, schema), false);

  const invalidEvidence = structuredClone(batch);
  requireObjectAt(
    requireArrayProperty(invalidEvidence, 'result_efficiency'),
    0,
    'result_efficiency',
  ).provider_tokens_source = 'runner_observed';
  strictEqual(matchesSchema(invalidEvidence, schema, schema), false);

  const wrongRateOrder = structuredClone(batch);
  requireArrayProperty(requireObjectProperty(wrongRateOrder, 'pricing'), 'rates').reverse();
  strictEqual(matchesSchema(wrongRateOrder, schema, schema), false);

  for (const concurrency of [0, 33, null]) {
    const changed = structuredClone(batch);
    changed.execution_concurrency = concurrency;
    strictEqual(matchesSchema(changed, schema, schema), false, `concurrency ${concurrency}`);
  }

  const duplicateSource = structuredClone(batch);
  const duplicateSourceResults = requireArrayProperty(duplicateSource, 'result_efficiency');
  requireObjectAt(duplicateSourceResults, 1, 'result_efficiency').source_result_id =
    requireObjectAt(duplicateSourceResults, 0, 'result_efficiency').source_result_id;
  strictEqual(matchesSchema(duplicateSource, schema, schema), false);

  const duplicateCell = structuredClone(batch);
  const duplicateCellResults = requireArrayProperty(duplicateCell, 'result_efficiency');
  const firstCell = requireObjectAt(duplicateCellResults, 0, 'result_efficiency');
  const secondCell = requireObjectAt(duplicateCellResults, 1, 'result_efficiency');
  secondCell.task_id = firstCell.task_id;
  secondCell.model = structuredClone(requireObjectProperty(firstCell, 'model'));
  strictEqual(matchesSchema(duplicateCell, schema, schema), false);

  const wrongEfficiencyOrder = structuredClone(batch);
  requireArrayProperty(wrongEfficiencyOrder, 'efficiency').reverse();
  strictEqual(matchesSchema(wrongEfficiencyOrder, schema, schema), false);
});

await test('normalized efficiency evidence preserves required and nullable authority fields', async () => {
  const schema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const batch = normalizedBatch();

  const nonInvoked = structuredClone(batch);
  const nonInvokedEvidence = requireObjectAt(
    requireArrayProperty(nonInvoked, 'result_efficiency'),
    0,
    'result_efficiency',
  );
  nonInvokedEvidence.observed_wall_ms = null;
  nonInvokedEvidence.wall_time_evidence_level = null;
  strictEqual(matchesSchema(nonInvoked, schema, schema), true);

  const partialUsage = structuredClone(batch);
  const partialUsageEvidence = requireObjectAt(
    requireArrayProperty(partialUsage, 'result_efficiency'),
    0,
    'result_efficiency',
  );
  partialUsageEvidence.provider_tokens = { input: 10 };
  partialUsageEvidence.provider_tokens_source = 'provider_reported';
  partialUsageEvidence.provider_tokens_evidence_level = 'verifier_recomputed';
  strictEqual(matchesSchema(partialUsage, schema, schema), true);

  const priced = structuredClone(batch);
  const pricedEvidence = requireObjectAt(
    requireArrayProperty(priced, 'result_efficiency'),
    0,
    'result_efficiency',
  );
  pricedEvidence.provider_tokens = {
    input: 10,
    cached_input: 2,
    cache_write_input: 1,
    output: 3,
    reasoning: 1,
    total: 13,
  };
  pricedEvidence.provider_tokens_source = 'provider_reported';
  pricedEvidence.provider_tokens_evidence_level = 'verifier_recomputed';
  pricedEvidence.standard_api_equivalent_usd_nanos = 126_250;
  pricedEvidence.cost_status = 'estimated';
  pricedEvidence.cost_evidence_level = 'verifier_recomputed';
  strictEqual(matchesSchema(priced, schema, schema), true);

  const contextBand = structuredClone(batch);
  const contextBandEvidence = requireObjectAt(
    requireArrayProperty(contextBand, 'result_efficiency'),
    0,
    'result_efficiency',
  );
  contextBandEvidence.provider_tokens = {
    input: 272_001,
    cached_input: 0,
    cache_write_input: 0,
    output: 1,
  };
  contextBandEvidence.provider_tokens_source = 'provider_reported';
  contextBandEvidence.provider_tokens_evidence_level = 'verifier_recomputed';
  contextBandEvidence.standard_api_equivalent_usd_nanos = null;
  contextBandEvidence.cost_status = 'unavailable_context_band';
  contextBandEvidence.cost_evidence_level = null;
  strictEqual(matchesSchema(contextBand, schema, schema), true);

  for (const [label, mutate] of [
    [
      'context-band status with a cost',
      (evidence: JsonObject) => {
        evidence.standard_api_equivalent_usd_nanos = 1;
      },
    ],
    [
      'context-band status with cost authority',
      (evidence: JsonObject) => {
        evidence.cost_evidence_level = 'verifier_recomputed';
      },
    ],
    [
      'context-band status at the short-context boundary',
      (evidence: JsonObject) => {
        requireObjectProperty(evidence, 'provider_tokens').input = 272_000;
      },
    ],
    [
      'context-band status without every required counter',
      (evidence: JsonObject) => {
        delete requireObjectProperty(evidence, 'provider_tokens').output;
      },
    ],
    [
      'long-context aggregate marked estimated',
      (evidence: JsonObject) => {
        evidence.standard_api_equivalent_usd_nanos = 1;
        evidence.cost_status = 'estimated';
        evidence.cost_evidence_level = 'verifier_recomputed';
      },
    ],
  ] as const) {
    const changed = structuredClone(contextBand);
    mutate(
      requireObjectAt(requireArrayProperty(changed, 'result_efficiency'), 0, 'result_efficiency'),
    );
    strictEqual(matchesSchema(changed, schema, schema), false, label);
  }

  for (const [label, mutate] of [
    [
      'observed time without authority',
      (evidence: JsonObject) => {
        evidence.wall_time_evidence_level = null;
      },
    ],
    [
      'null time with authority',
      (evidence: JsonObject) => {
        evidence.observed_wall_ms = null;
      },
    ],
    [
      'empty token evidence with authority',
      (evidence: JsonObject) => {
        evidence.provider_tokens_source = 'provider_reported';
      },
    ],
    [
      'partial counters marked estimated',
      (evidence: JsonObject) => {
        evidence.provider_tokens = { input: 10 };
        evidence.provider_tokens_source = 'provider_reported';
        evidence.provider_tokens_evidence_level = 'verifier_recomputed';
        evidence.standard_api_equivalent_usd_nanos = 1;
        evidence.cost_status = 'estimated';
        evidence.cost_evidence_level = 'verifier_recomputed';
      },
    ],
    [
      'cost without verifier authority',
      (evidence: JsonObject) => {
        evidence.provider_tokens = {
          input: 10,
          cached_input: 0,
          cache_write_input: 0,
          output: 1,
        };
        evidence.provider_tokens_source = 'provider_reported';
        evidence.provider_tokens_evidence_level = 'verifier_recomputed';
        evidence.standard_api_equivalent_usd_nanos = 1;
        evidence.cost_status = 'estimated';
      },
    ],
    [
      'unsafe integer',
      (evidence: JsonObject) => {
        evidence.observed_wall_ms = 9_007_199_254_740_992;
      },
    ],
    [
      'missing required field',
      (evidence: JsonObject) => {
        delete evidence.cost_status;
      },
    ],
    [
      'unexpected field',
      (evidence: JsonObject) => {
        evidence.unexpected = true;
      },
    ],
  ] as const) {
    const changed = structuredClone(batch);
    mutate(
      requireObjectAt(requireArrayProperty(changed, 'result_efficiency'), 0, 'result_efficiency'),
    );
    strictEqual(matchesSchema(changed, schema, schema), false, label);
  }
});

await test('normalized aggregate and pricing evidence retain their fixed contracts', async () => {
  const schema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const batch = normalizedBatch();

  strictEqual(matchesSchema(batch, schema, schema), true);

  for (const [label, mutate] of [
    [
      'zero observations with totals',
      (aggregate: JsonObject) => {
        aggregate.observed_wall_tasks = 0;
      },
    ],
    [
      'observations without totals',
      (aggregate: JsonObject) => {
        aggregate.total_observed_wall_ms = null;
      },
    ],
    [
      'partial estimates with total cost',
      (aggregate: JsonObject) => {
        aggregate.estimated_cost_tasks = 71;
        aggregate.standard_api_equivalent_usd_nanos = 1;
      },
    ],
    [
      'wrong selected count',
      (aggregate: JsonObject) => {
        aggregate.selected_tasks = 71;
      },
    ],
    [
      'coverage above selected count',
      (aggregate: JsonObject) => {
        requireObjectProperty(aggregate, 'provider_token_coverage').input_tasks = 73;
      },
    ],
    [
      'unexpected aggregate field',
      (aggregate: JsonObject) => {
        aggregate.unexpected = true;
      },
    ],
  ] as const) {
    const changed = structuredClone(batch);
    mutate(requireObjectAt(requireArrayProperty(changed, 'efficiency'), 0, 'efficiency'));
    strictEqual(matchesSchema(changed, schema, schema), false, label);
  }

  const missingPricing = structuredClone(batch);
  delete requireObjectProperty(missingPricing, 'pricing').limitation;
  strictEqual(matchesSchema(missingPricing, schema, schema), false);

  const extraPricing = structuredClone(batch);
  requireObjectProperty(extraPricing, 'pricing').unexpected = true;
  strictEqual(matchesSchema(extraPricing, schema, schema), false);

  for (const [field, value] of [
    ['source', 'https://developers.openai.com/api/docs/models/compare'],
    ['limitation', 'Standard API-equivalent comparison only.'],
  ] as const) {
    const changed = structuredClone(batch);
    requireObjectProperty(changed, 'pricing')[field] = value;
    strictEqual(matchesSchema(changed, schema, schema), false, field);
  }

  for (const rateIndex of [0, 1, 2]) {
    for (const field of [
      'input_usd_nanos_per_token',
      'cached_input_usd_nanos_per_token',
      'cache_write_input_usd_nanos_per_token',
      'output_usd_nanos_per_token',
    ]) {
      const changed = structuredClone(batch);
      const rate = requireObjectAt(
        requireArrayProperty(requireObjectProperty(changed, 'pricing'), 'rates'),
        rateIndex,
        'rates',
      );
      const value = rate[field];
      if (typeof value !== 'number') {
        throw new Error(`pricing rate ${String(rateIndex)} ${field} must be numeric`);
      }
      rate[field] = value + 1;
      strictEqual(matchesSchema(changed, schema, schema), false, `${String(rateIndex)} ${field}`);
    }
  }
});

await test('calibration stage pricing and context-band evidence mirror the normalized contract', async () => {
  const schema = await parseSchema('benchmarks/schema/calibration-verified-stage-v1.schema.json');
  const pricingSchema = resolveReference(schema, '#/$defs/pricing');
  const properties = requireObjectProperty(schema, 'properties');

  for (const [field, expected, changed] of [
    ['task_set_id', 'aiq-core', 'other'],
    ['task_set_version', '1.0.5', '1.0.4'],
    ['task_set_version', '1.0.5', '1.0.2'],
    ['benchmark_version', 'aiq-core@1.0.5', 'aiq-core@1.0.4'],
    ['benchmark_version', 'aiq-core@1.0.5', 'aiq-core@1.0.2'],
  ] as const) {
    const fieldSchema = requireObject(properties[field], `${field} schema`);
    strictEqual(matchesSchema(expected, fieldSchema, schema), true, `${field} current value`);
    strictEqual(matchesSchema(changed, fieldSchema, schema), false, `${field} stale value`);
  }

  strictEqual(matchesSchema(pricing(), pricingSchema, schema), true);

  for (const [field, value] of [
    ['source', 'https://developers.openai.com/api/docs/models/compare'],
    ['limitation', 'Standard API-equivalent comparison only.'],
  ] as const) {
    const changed = pricing();
    changed[field] = value;
    strictEqual(matchesSchema(changed, pricingSchema, schema), false, field);
  }

  for (const rateIndex of [0, 1, 2]) {
    for (const field of [
      'input_usd_nanos_per_token',
      'cached_input_usd_nanos_per_token',
      'cache_write_input_usd_nanos_per_token',
      'output_usd_nanos_per_token',
    ]) {
      const changed = pricing();
      const rate = requireObjectAt(requireArrayProperty(changed, 'rates'), rateIndex, 'rates');
      const value = rate[field];
      if (typeof value !== 'number') {
        throw new Error(`pricing rate ${String(rateIndex)} ${field} must be numeric`);
      }
      rate[field] = value + 1;
      strictEqual(
        matchesSchema(changed, pricingSchema, schema),
        false,
        `${String(rateIndex)} ${field}`,
      );
    }
  }

  const resultSchema = structuredClone(resolveReference(schema, '#/$defs/resultEfficiency'));
  requireObjectProperty(resultSchema, 'properties').model = { type: 'object' };
  const contextBand = resultEfficiency({ family: 'sol', reasoning_effort: 'low' }, 0, 0);
  contextBand.provider_tokens = {
    input: 272_001,
    cached_input: 0,
    cache_write_input: 0,
    output: 1,
  };
  contextBand.provider_tokens_source = 'provider_reported';
  contextBand.provider_tokens_evidence_level = 'verifier_recomputed';
  contextBand.standard_api_equivalent_usd_nanos = null;
  contextBand.cost_status = 'unavailable_context_band';
  contextBand.cost_evidence_level = null;

  strictEqual(matchesSchema(contextBand, resultSchema, schema), true);

  for (const [label, mutate] of [
    [
      'calibration context-band status with a cost',
      (evidence: JsonObject) => {
        evidence.standard_api_equivalent_usd_nanos = 1;
      },
    ],
    [
      'calibration context-band status with cost authority',
      (evidence: JsonObject) => {
        evidence.cost_evidence_level = 'verifier_recomputed';
      },
    ],
    [
      'calibration context-band status at the short-context boundary',
      (evidence: JsonObject) => {
        requireObjectProperty(evidence, 'provider_tokens').input = 272_000;
      },
    ],
    [
      'calibration long-context aggregate marked estimated',
      (evidence: JsonObject) => {
        evidence.standard_api_equivalent_usd_nanos = 1;
        evidence.cost_status = 'estimated';
        evidence.cost_evidence_level = 'verifier_recomputed';
      },
    ],
  ] as const) {
    const changed = structuredClone(contextBand);
    mutate(changed);
    strictEqual(matchesSchema(changed, resultSchema, schema), false, label);
  }
});

await test('verifier environment example binds the current public task release', async () => {
  const environment = requireObject(
    JSON.parse(await readFile('config/verifier-environment.example.json', 'utf8')),
    'verifier environment example',
  );

  strictEqual(environment.task_set_id, 'aiq-core');
  strictEqual(environment.task_set_version, '1.0.5');
  strictEqual(environment.benchmark_version, 'aiq-core@1.0.5');
  strictEqual(
    requireObjectProperty(environment, 'expected_provenance').catalog_digest,
    catalogDigest,
  );
  const runtimeTaskSetDigest = requireObjectProperty(
    environment,
    'expected_provenance',
  ).task_set_digest;
  strictEqual(runtimeTaskSetDigest, 'sha256:REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS');
  notStrictEqual(runtimeTaskSetDigest, controlledGeneratedTaskTreeDigest);
});

await test('normalized result and score schemas enforce exact payload fields and bounds', async () => {
  const schema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const batch = normalizedBatch();

  strictEqual(matchesSchema(batch, schema, schema), true);

  for (const count of [71, 73]) {
    const changed = structuredClone(batch);
    const firstRun = requireObjectAt(requireArrayProperty(changed, 'runs'), 0, 'runs');
    const results = requireArrayProperty(firstRun, 'results').slice(0, count);
    if (count === 73) {
      results.push(requireObjectAt(results, 0, 'results'));
    }
    firstRun.results = results;
    strictEqual(matchesSchema(changed, schema, schema), false);
  }

  const missingScoreField = structuredClone(batch);
  const firstMissingScoreRun = requireObjectAt(
    requireArrayProperty(missingScoreField, 'runs'),
    0,
    'runs',
  );
  delete requireObjectProperty(firstMissingScoreRun, 'score').coverage;
  strictEqual(matchesSchema(missingScoreField, schema, schema), false);

  const outOfRangeScore = structuredClone(batch);
  const firstOutOfRangeRun = requireObjectAt(
    requireArrayProperty(outOfRangeScore, 'runs'),
    0,
    'runs',
  );
  requireObjectAt(requireArrayProperty(firstOutOfRangeRun, 'results'), 0, 'results').task_score =
    1.01;
  strictEqual(matchesSchema(outOfRangeScore, schema, schema), false);

  const unknownResultField = structuredClone(batch);
  const firstUnknownFieldRun = requireObjectAt(
    requireArrayProperty(unknownResultField, 'runs'),
    0,
    'runs',
  );
  requireObjectAt(requireArrayProperty(firstUnknownFieldRun, 'results'), 0, 'results').extra = true;
  strictEqual(matchesSchema(unknownResultField, schema, schema), false);

  const invalidLunaModel = structuredClone(batch);
  requireObjectAt(requireArrayProperty(invalidLunaModel, 'runs'), 16, 'runs').model = {
    family: 'luna',
    reasoning_effort: 'ultra',
  };
  strictEqual(matchesSchema(invalidLunaModel, schema, schema), false);

  for (const [field, value] of [
    ['method', 'unversioned_bootstrap'],
    ['central_mass', 0.9],
    ['samples', 9_999],
    ['seed', 42],
  ] as const) {
    const changed = structuredClone(batch);
    const firstRun = requireObjectAt(requireArrayProperty(changed, 'runs'), 0, 'runs');
    const report = requireObjectProperty(firstRun, 'score');
    const interval = requireObjectProperty(report, 'task_resampling_sensitivity_interval');
    interval[field] = value;
    strictEqual(matchesSchema(changed, schema, schema), false, `${field} must be fixed`);
  }

  const staleRule = structuredClone(batch);
  requireObjectProperty(
    requireObjectAt(requireArrayProperty(staleRule, 'runs'), 0, 'runs'),
    'score',
  ).rule = 'AIQ v1 fixed-fixture score';
  strictEqual(matchesSchema(staleRule, schema, schema), false, 'rule must be fixed');

  const unknownScoreFieldCases: ReadonlyArray<
    readonly [string, (report: JsonObject) => JsonObject]
  > = [
    ['score report', (report) => report],
    ['completion bounds', (report) => requireObjectProperty(report, 'completion_bounds')],
    [
      'task resampling sensitivity interval',
      (report) => requireObjectProperty(report, 'task_resampling_sensitivity_interval'),
    ],
    [
      'binary micro diagnostic',
      (report) => requireObjectProperty(report, 'binary_micro_diagnostic'),
    ],
    ['coverage summary', (report) => requireObjectProperty(report, 'coverage')],
    [
      'difficulty coverage',
      (report) =>
        requireObjectProperty(requireObjectProperty(report, 'difficulty_coverage'), 'easy'),
    ],
    [
      'domain score',
      (report) => requireObjectAt(requireArrayProperty(report, 'domains'), 0, 'domains'),
    ],
  ];

  for (const [label, selectObject] of unknownScoreFieldCases) {
    const changed = structuredClone(batch);
    const firstRun = requireObjectAt(requireArrayProperty(changed, 'runs'), 0, 'runs');
    const report = requireObjectProperty(firstRun, 'score');
    selectObject(report).unexpected = true;
    strictEqual(matchesSchema(changed, schema, schema), false, `${label} rejects unknown fields`);
  }

  const extraDifficulty = structuredClone(batch);
  const extraDifficultyRun = requireObjectAt(
    requireArrayProperty(extraDifficulty, 'runs'),
    0,
    'runs',
  );
  const difficultyCoverage = requireObjectProperty(
    requireObjectProperty(extraDifficultyRun, 'score'),
    'difficulty_coverage',
  );
  difficultyCoverage.unexpected = structuredClone(
    requireObjectProperty(difficultyCoverage, 'easy'),
  );
  strictEqual(
    matchesSchema(extraDifficulty, schema, schema),
    false,
    'difficulty coverage map rejects unknown keys',
  );

  const emptyDifficulty = structuredClone(batch);
  const emptyDifficultyRun = requireObjectAt(
    requireArrayProperty(emptyDifficulty, 'runs'),
    0,
    'runs',
  );
  requireObjectProperty(requireObjectProperty(emptyDifficultyRun, 'score'), 'difficulty_coverage');
  requireObjectProperty(emptyDifficultyRun, 'score').difficulty_coverage = {};
  strictEqual(
    matchesSchema(emptyDifficulty, schema, schema),
    false,
    'difficulty coverage map rejects an empty object',
  );

  deepStrictEqual(requireObjectProperty(schema, 'x-aiq-limits').results_per_model_run, 72);
});

await test('normalized artifact addresses bind the supported kind and digest path', async () => {
  const schema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const batch = normalizedBatch();
  const firstRun = requireObjectAt(requireArrayProperty(batch, 'runs'), 0, 'runs');
  const firstResult = requireObjectAt(requireArrayProperty(firstRun, 'results'), 0, 'results');
  const digest = 'a'.repeat(64);

  firstResult.artifacts = [
    {
      kind: 'stdout.jsonl',
      content_hash: `sha256:${digest}`,
      uri: `aiq-artifact://sha256/${digest}/stdout.jsonl`,
      bytes: 1,
    },
  ];
  strictEqual(matchesSchema(batch, schema, schema), true);

  for (const [field, value] of [
    ['uri', `aiq-artifact://sha256/${digest}/stderr.txt`],
    ['uri', `aiq-artifact://sha256/${digest}/workspace-manifest.json`],
    ['uri', `aiq-artifact://sha256/${digest}/stdout.jsonl\n`],
    ['kind', 'workspace-manifest.json'],
    ['bytes', 4_194_305],
  ] as const) {
    const changed = structuredClone(batch);
    const changedRun = requireObjectAt(requireArrayProperty(changed, 'runs'), 0, 'runs');
    const changedResult = requireObjectAt(
      requireArrayProperty(changedRun, 'results'),
      0,
      'results',
    );
    requireObjectAt(requireArrayProperty(changedResult, 'artifacts'), 0, 'artifacts')[field] =
      value;
    strictEqual(matchesSchema(changed, schema, schema), false, `${field} must be rejected`);
  }

  const extra = structuredClone(batch);
  const extraRun = requireObjectAt(requireArrayProperty(extra, 'runs'), 0, 'runs');
  const extraResult = requireObjectAt(requireArrayProperty(extraRun, 'results'), 0, 'results');
  requireObjectAt(requireArrayProperty(extraResult, 'artifacts'), 0, 'artifacts').unexpected = true;
  strictEqual(matchesSchema(extra, schema, schema), false);
});

await test('score payload permits non-frozen task domain and difficulty coverage', async () => {
  const schema = await parseSchema('benchmarks/schema/normalized-batch-v3.schema.json');
  const batch = normalizedBatch();
  for (const runValue of requireArrayProperty(batch, 'runs')) {
    const run = requireObject(runValue, 'run');
    const report = requireObjectProperty(run, 'score');
    report.tier = 'coverage_only';
    report.score = null;
    report.quality_score = null;
    report.completion_bounds = null;
    report.task_resampling_sensitivity_interval = null;
    report.coverage = {
      ...requireObjectProperty(report, 'coverage'),
      expected_domains: 1,
      covered_domains: 1,
    };
    report.difficulty_coverage = {
      medium: { expected_tasks: 72, valid_tasks: 72 },
    };
    report.domains = [
      {
        domain: 'coding',
        expected_tasks: 72,
        valid_tasks: 72,
        invalid_tasks: 0,
        missing_tasks: 0,
        not_applicable_tasks: 0,
        zero_failure_tasks: 0,
        score: 1,
      },
    ];
    for (const resultValue of requireArrayProperty(run, 'results')) {
      const result = requireObject(resultValue, 'result');
      result.domain = 'coding';
    }
  }
  strictEqual(matchesSchema(batch, schema, schema), true);
});

await test('attestation schema rejects malformed digests, keys, signatures, and enums', async () => {
  const schema = await parseSchema('benchmarks/schema/verifier-attestation-v3.schema.json');
  const evaluatorReplay = attestation();
  evaluatorReplay.replay_status = 'evaluator_replayed';
  strictEqual(matchesSchema(evaluatorReplay, schema, schema), true);

  for (const [field, value] of [
    ['package_sha256', `sha256:${'a'.repeat(64)}`],
    ['content_hash', 'a'.repeat(64)],
    ['signature', 'A'.repeat(128)],
    ['replay_status', 'reproduced'],
    ['replay_status', 'verified'],
    ['policy', 'test'],
    ['observed_unix_ms', 9007199254740992],
  ] as const) {
    const changed = attestation();
    changed[field] = value;
    strictEqual(matchesSchema(changed, schema, schema), false, `${field} must be rejected`);
  }

  const badKey = attestation();
  requireObjectProperty(badKey, 'verifier').public_key = 'f'.repeat(63);
  strictEqual(matchesSchema(badKey, schema, schema), false);

  const extra = attestation();
  extra.unexpected = true;
  strictEqual(matchesSchema(extra, schema, schema), false);
});

await test('attestation policy accepts only publishable replay outcomes', async () => {
  const schema = await parseSchema('benchmarks/schema/verifier-attestation-v3.schema.json');

  for (const [fixture, policy, replayStatus, accepted] of [
    [productionAttestation(), 'production', 'evaluator_replayed', true],
    [productionAttestation(), 'production', 'commitments_verified', false],
    [productionAttestation(), 'production', 'failed', false],
    [productionAttestation(), 'synthetic_test', 'evaluator_replayed', false],
    [attestation(), 'synthetic_test', 'commitments_verified', true],
    [attestation(), 'synthetic_test', 'evaluator_replayed', true],
    [attestation(), 'synthetic_test', 'failed', false],
    [attestation(), 'production', 'evaluator_replayed', false],
  ] as const) {
    fixture.policy = policy;
    fixture.replay_status = replayStatus;
    strictEqual(matchesSchema(fixture, schema, schema), accepted);
  }
});

await test('workspace snapshot paths use the same exact file and directory grammar as Rust', async () => {
  const schema = await parseSchema('benchmarks/schema/workspace-snapshot-v1.schema.json');
  const snapshot: JsonObject = {
    schema_version: 'aiq.workspace-snapshot.v1',
    manifest_sha256: sha256(1),
    entries: [
      { path: 'dir', kind: 'directory' },
      {
        path: 'dir/file',
        kind: 'file',
        bytes: 1,
        sha256: sha256(2),
        content_hex: '00',
      },
      {
        path: 'file',
        kind: 'file',
        bytes: 1,
        sha256: sha256(3),
        content_hex: '01',
      },
    ],
  };

  strictEqual(matchesSchema(snapshot, schema, schema), true);

  for (const path of [
    '.',
    './file',
    'dir/.',
    'dir/',
    '..',
    '../file',
    'dir/../file',
    'dir//file',
    '/absolute',
    'NUL',
    'con.txt',
    'COM1.json',
    'Lpt9',
    'trailing.',
    'a'.repeat(256),
    'file\n',
    'file\r\n',
    'file\u2028',
    'file\u2029',
  ]) {
    const changed = structuredClone(snapshot);
    requireObjectAt(requireArrayProperty(changed, 'entries'), 1, 'entries').path = path;
    strictEqual(matchesSchema(changed, schema, schema), false, `${JSON.stringify(path)} rejected`);
  }

  const directoryDepthBoundary = structuredClone(snapshot);
  requireObjectAt(requireArrayProperty(directoryDepthBoundary, 'entries'), 0, 'entries').path =
    Array.from({ length: 64 }, () => 'd').join('/');
  strictEqual(matchesSchema(directoryDepthBoundary, schema, schema), true);

  const excessiveDirectoryDepth = structuredClone(snapshot);
  requireObjectAt(requireArrayProperty(excessiveDirectoryDepth, 'entries'), 0, 'entries').path =
    Array.from({ length: 65 }, () => 'd').join('/');
  strictEqual(matchesSchema(excessiveDirectoryDepth, schema, schema), false);

  const fileDepthBoundary = structuredClone(snapshot);
  requireObjectAt(requireArrayProperty(fileDepthBoundary, 'entries'), 1, 'entries').path =
    Array.from({ length: 65 }, () => 'f').join('/');
  strictEqual(matchesSchema(fileDepthBoundary, schema, schema), true);

  const tooManyEntries = structuredClone(snapshot);
  tooManyEntries.entries = Array.from({ length: 4097 }, (_, index) => ({
    path: `f${String(index).padStart(4, '0')}`,
    kind: 'file',
    bytes: 0,
    sha256: sha256(index + 10),
    content_hex: '',
  }));
  strictEqual(matchesSchema(tooManyEntries, schema, schema), false);

  const oversizedFile = structuredClone(snapshot);
  requireObjectAt(requireArrayProperty(oversizedFile, 'entries'), 1, 'entries').bytes = 1_398_102;
  strictEqual(matchesSchema(oversizedFile, schema, schema), false);
});

await test('rejection schema enforces exact identity, policy, and reason fields', async () => {
  const schema = await parseSchema('benchmarks/schema/verifier-rejection-v2.schema.json');

  strictEqual(matchesSchema(rejection(), schema, schema), true);
  for (const [field, value] of [
    ['schema_version', 'aiq.verifier-rejection.v1'],
    ['matrix_batch_id', 'run_invalid'],
    ['package_sha256', `sha256:${'a'.repeat(64)}`],
    ['observed_at', '2026-07-24T14:00:00-04:00'],
    ['reason_code', 'UPPERCASE'],
    ['verifier_node_id', 'node_invalid'],
  ] as const) {
    const changed = rejection();
    changed[field] = value;
    strictEqual(matchesSchema(changed, schema, schema), false, `${field} must be rejected`);
  }

  const mixedPolicy = rejection();
  mixedPolicy.production = true;
  strictEqual(matchesSchema(mixedPolicy, schema, schema), false);

  const extra = rejection();
  extra.unexpected = true;
  strictEqual(matchesSchema(extra, schema, schema), false);
});
