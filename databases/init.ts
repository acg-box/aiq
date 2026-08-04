import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

const CATALOG_IDENTITY = 'sha256:0e315fe2bbcf0efe59ddcd69173addf89ef0fb281ec3ef523234bdc01b3d66a1';
const CATALOG_RELEASE_IDENTITY =
  'sha256:0dd4f11c49a1e295a75e6ca1e3b7b4f9c38e0160b9eda75ca75a47703e47f80d';
const TASK_SET_IDENTITY = 'sha256:1a7a8e5f37efeb03cf3a2a92a94370ef67ec3b7a6eb385bd5ec3c844713afb0e';
const REVIEWED_TASK_COMMITMENTS_IDENTITY =
  'sha256:8db63304fee2483f48d70af7581589438432a3455945238ae90527c32a83df1e';
const EVALUATOR_IDENTITY =
  'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c';
const DIGEST_PATTERN = /^sha256:(?!0{64}(?![\s\S]))[0-9a-f]{64}(?![\s\S])/;
const HEX_PATTERN = /^(?!0{64}(?![\s\S]))[0-9a-f]{64}(?![\s\S])/;
const RELEASE_ID_PATTERN = /^corpus_[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?(?![\s\S])/;
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .·_/@()+-]{0,159}(?![\s\S])/;
const MAX_REFERENCE_BYTES = 2_000_000;
const MAX_PSQL_OUTPUT_BYTES = 65_536;
const CORPUS_SCHEMA_ID = 'https://aiq.wiki/schema/corpus-commitment-v2.schema.json';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export const EXPECTED_MODEL_CONFIGS = [
  ...EFFORTS.map((reasoning_effort, index) => ({
    model_config_id: `sol-${reasoning_effort}`,
    provider: 'openai',
    model_family: 'sol',
    provider_model_id: 'gpt-5.6-sol',
    reasoning_effort,
    display_name: `Sol · ${reasoning_effort}`,
    matrix_order: index + 1,
  })),
  ...EFFORTS.map((reasoning_effort, index) => ({
    model_config_id: `terra-${reasoning_effort}`,
    provider: 'openai',
    model_family: 'terra',
    provider_model_id: 'gpt-5.6-terra',
    reasoning_effort,
    display_name: `Terra · ${reasoning_effort}`,
    matrix_order: index + 7,
  })),
  ...EFFORTS.slice(0, 5).map((reasoning_effort, index) => ({
    model_config_id: `luna-${reasoning_effort}`,
    provider: 'openai',
    model_family: 'luna',
    provider_model_id: 'gpt-5.6-luna',
    reasoning_effort,
    display_name: `Luna · ${reasoning_effort}`,
    matrix_order: index + 13,
  })),
] as const;

const NODE_ROLES = ['runner', 'verifier', 'publisher'] as const;
type NodeRole = (typeof NODE_ROLES)[number];

interface ValidatedNode {
  readonly role: NodeRole;
  readonly node_id: string;
  readonly display_name: string;
  readonly key_fingerprint: string;
  readonly public_key: string;
  readonly trust_tier: 'trusted_verified' | 'independently_reproduced';
  readonly operator_class: 'official' | 'verifier';
  readonly capabilities: readonly string[];
  readonly source: string;
  readonly provenance: string;
}

interface ValidatedReference {
  readonly corpusCommitmentSha256: string;
  readonly taskSetIdentitySha256: string;
  readonly evaluatorIdentitySha256: string;
  readonly releaseId: string;
  readonly publishedAt: string;
  readonly taskBindings: readonly JsonObject[];
  readonly nodes: readonly ValidatedNode[];
}

export interface InitializationReceipt {
  readonly schema_version: 'aiq.production-initialization-receipt.v1';
  readonly initialized: true;
  readonly scoring_version: '1.0.3';
  readonly catalog_identity_sha256: string;
  readonly catalog_release_identity_sha256: string;
  readonly corpus_commitment_sha256: string;
  readonly corpus_release_id: string;
  readonly task_set_identity_sha256: string;
  readonly evaluator_identity_sha256: string;
  readonly task_count: 72;
  readonly model_config_count: 17;
  readonly public_node_count: 3;
  readonly private_table_count: 40;
  readonly forced_rls_table_count: 40;
  readonly public_view_count: 12;
  readonly security_invoker_view_count: 12;
  readonly hardened_gateway_role_count: 2;
  readonly node_ids: Readonly<Record<NodeRole, string>>;
}

export interface PreparedInitialization {
  readonly sql: string;
  readonly receipt: InitializationReceipt;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!DIGEST_PATTERN.test(result)) throw new Error(`${label} must be a non-placeholder digest`);
  return result;
}

function safeText(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SAFE_TEXT_PATTERN.test(result)) throw new Error(`${label} is not public-safe text`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label);
  const parsed = new Date(result);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString() !== result
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function documentDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function resolveSchemaReference(root: JsonObject, reference: string): JsonObject {
  if (!reference.startsWith('#/')) throw new Error('corpus schema contains an external reference');
  let current: unknown = root;
  for (const encoded of reference.slice(2).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    current = object(current, 'corpus schema reference')[key];
  }
  return object(current, `corpus schema reference ${reference}`);
}

function validateSchemaNode(
  root: JsonObject,
  schemaValue: unknown,
  value: unknown,
  path: string,
): void {
  if (schemaValue === false) throw new Error(`${path} is forbidden by the corpus schema`);
  if (schemaValue === true) return;
  const schema = object(schemaValue, 'corpus schema node');
  if (schema.$ref !== undefined) {
    validateSchemaNode(
      root,
      resolveSchemaReference(root, string(schema.$ref, 'corpus schema $ref')),
      value,
      path,
    );
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateSchemaNode(root, child, value, path);
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const child of schema.oneOf) {
      try {
        validateSchemaNode(root, child, value, path);
        matches += 1;
      } catch {
        // A oneOf branch that does not match is expected.
      }
    }
    if (matches !== 1) throw new Error(`${path} does not match exactly one corpus schema branch`);
  }
  if (
    schema.type !== undefined &&
    !schemaTypeMatches(value, string(schema.type, 'corpus schema type'))
  ) {
    throw new Error(`${path} has the wrong type`);
  }
  if (schema.const !== undefined && canonicalJson(value) !== canonicalJson(schema.const)) {
    throw new Error(`${path} does not match its fixed corpus value`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))
  ) {
    throw new Error(`${path} is outside the corpus schema enum`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new Error(`${path} is shorter than the corpus schema minimum`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new Error(`${path} exceeds the corpus schema maximum`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      throw new Error(`${path} does not match the corpus schema pattern`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new Error(`${path} has too few corpus items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new Error(`${path} has too many corpus items`);
    }
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => canonicalJson(item))).size !== value.length
    ) {
      throw new Error(`${path} contains duplicate corpus items`);
    }
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    prefixItems.forEach((child, index) => {
      if (index < value.length) {
        validateSchemaNode(root, child, value[index], `${path}[${String(index)}]`);
      }
    });
    for (let index = prefixItems.length; index < value.length; index += 1) {
      if (schema.items !== undefined) {
        validateSchemaNode(root, schema.items, value[index], `${path}[${String(index)}]`);
      }
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key !== 'string' || !Object.hasOwn(value, key)) {
          throw new Error(`${path} is missing a required corpus field`);
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        validateSchemaNode(root, child, value[key], `${path}.${key}`);
      }
    }
    const extraKeys = Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
    if (schema.additionalProperties === false && extraKeys.length > 0) {
      throw new Error(`${path} contains an unexpected corpus field`);
    }
    if (isObject(schema.additionalProperties)) {
      for (const key of extraKeys) {
        validateSchemaNode(root, schema.additionalProperties, value[key], `${path}.${key}`);
      }
    }
  }
}

function validateCorpusSchema(schemaValue: unknown, commitment: JsonObject): void {
  const schema = object(schemaValue, 'corpus commitment schema');
  if (
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    schema.$id !== CORPUS_SCHEMA_ID
  ) {
    throw new Error('checked-in corpus commitment schema authority is invalid');
  }
  validateSchemaNode(schema, schema, commitment, 'reference.corpus_commitment');
}

function validateCommitment(
  reference: JsonObject,
  catalog: JsonObject,
  corpusSchema: unknown,
  reviewedTaskCommitments: unknown,
): ValidatedReference {
  exactKeys(
    reference,
    ['schema_version', 'published_at', 'corpus_commitment', 'nodes'],
    'reference',
  );
  if (reference.schema_version !== 'aiq.production-reference.v1') {
    throw new Error('reference.schema_version must be aiq.production-reference.v1');
  }
  const commitment = object(reference.corpus_commitment, 'reference.corpus_commitment');
  validateCorpusSchema(corpusSchema, commitment);
  const commitmentSha256 = documentDigest(commitment);
  exactKeys(
    commitment,
    ['schema_version', 'release_id', 'controlled', 'synthetic', 'catalog', 'execution', 'tasks'],
    'reference.corpus_commitment',
  );
  if (
    commitment.schema_version !== 'aiq.corpus-commitment.v2' ||
    commitment.controlled !== true ||
    commitment.synthetic !== false
  ) {
    throw new Error('corpus commitment must be controlled, non-synthetic v2');
  }
  const releaseId = string(commitment.release_id, 'corpus commitment release_id');
  if (!RELEASE_ID_PATTERN.test(releaseId))
    throw new Error('corpus commitment release_id is invalid');
  const bindingCatalog = object(commitment.catalog, 'corpus commitment catalog');
  exactKeys(
    bindingCatalog,
    ['schema_version', 'task_set_id', 'task_set_version', 'identity_sha256', 'identity_scope'],
    'corpus commitment catalog',
  );
  if (
    bindingCatalog.schema_version !== 'aiq.catalog.v1' ||
    bindingCatalog.task_set_id !== 'aiq-core' ||
    bindingCatalog.task_set_version !== '1.0.3' ||
    bindingCatalog.identity_sha256 !== CATALOG_IDENTITY ||
    bindingCatalog.identity_scope !== 'ordered_full_task_metadata'
  ) {
    throw new Error('corpus commitment does not bind the fixed public catalog');
  }
  const execution = object(commitment.execution, 'corpus commitment execution');
  exactKeys(
    execution,
    [
      'harness_sha256',
      'runner_prompt_source_sha256',
      'declared_tool_policy_sha256',
      'declared_network_policy_sha256',
      'environment_sha256',
      'runtime_provenance',
    ],
    'corpus commitment execution',
  );
  for (const field of [
    'harness_sha256',
    'runner_prompt_source_sha256',
    'declared_tool_policy_sha256',
    'declared_network_policy_sha256',
    'environment_sha256',
  ]) {
    digest(execution[field], `corpus commitment execution ${field}`);
  }
  object(execution.runtime_provenance, 'corpus commitment runtime_provenance');
  const catalogTasks = array(catalog.tasks, 'catalog.tasks').map((item, index) =>
    object(item, `catalog.tasks[${String(index)}]`),
  );
  const taskBindings = array(commitment.tasks, 'corpus commitment tasks').map((item, index) =>
    object(item, `corpus commitment tasks[${String(index)}]`),
  );
  if (catalogTasks.length !== 72 || taskBindings.length !== 72) {
    throw new Error('corpus commitment must bind all 72 catalog tasks');
  }
  taskBindings.forEach((binding, index) => {
    exactKeys(
      binding,
      [
        'task_id',
        'task_version',
        'task_definition_sha256',
        'catalog_entry_sha256',
        'baseline_workspace_tree_sha256',
        'fixture_bundle_sha256',
        'evaluator_executable_sha256',
        'evaluator_runtime_kind',
        'evaluator_runtime_executable_sha256',
        'evaluator_configuration_sha256',
        'acceptance_suite_sha256',
        'leakage_review_sha256',
      ],
      `corpus commitment tasks[${String(index)}]`,
    );
    const task = catalogTasks[index];
    if (
      task === undefined ||
      binding.task_id !== task.task_id ||
      binding.task_version !== task.task_version ||
      digest(binding.catalog_entry_sha256, 'catalog_entry_sha256') !== documentDigest(task)
    ) {
      throw new Error(`corpus commitment task ${String(index)} is not ordered and exact`);
    }
    if (binding.evaluator_runtime_kind !== 'node') {
      throw new Error(`corpus commitment task ${String(index)} runtime is invalid`);
    }
    for (const field of [
      'task_definition_sha256',
      'baseline_workspace_tree_sha256',
      'fixture_bundle_sha256',
      'evaluator_executable_sha256',
      'evaluator_runtime_executable_sha256',
      'evaluator_configuration_sha256',
      'acceptance_suite_sha256',
      'leakage_review_sha256',
    ]) {
      digest(binding[field], `corpus commitment task ${String(index)} ${field}`);
    }
  });
  const taskSetIdentitySha256 = validateReviewedTaskCommitments(
    reviewedTaskCommitments,
    taskBindings,
  );
  const evaluatorIdentitySha256 = validateRuntimeProvenance(execution, catalogTasks, taskBindings);
  const nodes = validateNodes(reference.nodes);
  return {
    corpusCommitmentSha256: commitmentSha256,
    taskSetIdentitySha256,
    evaluatorIdentitySha256,
    releaseId,
    publishedAt: timestamp(reference.published_at, 'reference.published_at'),
    taskBindings,
    nodes,
  };
}

function validateReviewedTaskCommitments(
  value: unknown,
  taskBindings: readonly JsonObject[],
): string {
  const manifest = object(value, 'reviewed task commitments');
  exactKeys(
    manifest,
    ['schema_version', 'task_set_id', 'task_set_version', 'task_set_identity_sha256', 'tasks'],
    'reviewed task commitments',
  );
  if (
    manifest.schema_version !== 'aiq.production-task-commitments.v1' ||
    manifest.task_set_id !== 'aiq-core' ||
    manifest.task_set_version !== '1.0.3' ||
    digest(manifest.task_set_identity_sha256, 'reviewed task-set identity') !== TASK_SET_IDENTITY ||
    documentDigest(manifest) !== REVIEWED_TASK_COMMITMENTS_IDENTITY
  ) {
    throw new Error('reviewed task commitment authority is invalid');
  }
  const reviewedTasks = array(manifest.tasks, 'reviewed task commitments tasks').map(
    (item, index) => object(item, `reviewed task commitments tasks[${String(index)}]`),
  );
  if (reviewedTasks.length !== 72 || taskBindings.length !== 72) {
    throw new Error('reviewed task commitments must bind all 72 tasks');
  }
  const reviewedByTaskId = new Map<string, JsonObject>();
  reviewedTasks.forEach((reviewed, index) => {
    exactKeys(
      reviewed,
      ['task_id', 'task_definition_sha256', 'fixture_bundle_sha256'],
      `reviewed task commitments tasks[${String(index)}]`,
    );
    const taskId = string(reviewed.task_id, 'reviewed task_id');
    digest(reviewed.task_definition_sha256, 'reviewed task_definition_sha256');
    digest(reviewed.fixture_bundle_sha256, 'reviewed fixture_bundle_sha256');
    if (reviewedByTaskId.has(taskId)) {
      throw new Error(`reviewed task commitments duplicate task ${taskId}`);
    }
    reviewedByTaskId.set(taskId, reviewed);
  });
  const taskDefinitionIdentities = taskBindings.map((binding, index) => {
    const taskId = string(binding.task_id, 'corpus task_id');
    const reviewed = reviewedByTaskId.get(taskId);
    if (
      reviewed === undefined ||
      binding.task_definition_sha256 !== reviewed.task_definition_sha256 ||
      binding.fixture_bundle_sha256 !== reviewed.fixture_bundle_sha256
    ) {
      throw new Error(`corpus task ${String(index)} does not match the reviewed commitments`);
    }
    return string(reviewed.task_definition_sha256, 'reviewed task_definition_sha256');
  });
  if (new Set(taskDefinitionIdentities).size !== 72) {
    throw new Error('reviewed task definitions must have distinct content identities');
  }

  // Rust task_set_hash sorts TaskDefinition content hashes, then applies the
  // protocol RFC 8785 canonical hash to that string array.
  const derivedIdentity = documentDigest(taskDefinitionIdentities.toSorted());
  if (derivedIdentity !== TASK_SET_IDENTITY) {
    throw new Error('reviewed task commitments do not derive the native task-set identity');
  }
  return derivedIdentity;
}

function validateRuntimeProvenance(
  execution: JsonObject,
  catalogTasks: readonly JsonObject[],
  taskBindings: readonly JsonObject[],
): string {
  const runtime = object(execution.runtime_provenance, 'corpus commitment runtime_provenance');
  const operatingSystem = object(runtime.operating_system, 'runtime operating_system');
  const nodeRuntime = object(runtime.node_runtime, 'runtime node_runtime');
  const modelToolchain = object(runtime.model_toolchain, 'runtime model_toolchain');
  const evaluator = object(runtime.evaluator, 'runtime evaluator');
  const runner = object(runtime.runner, 'runtime runner');
  const sourceManifest = object(runner.source_manifest, 'runtime runner source_manifest');
  const sourceEntries = array(sourceManifest.entries, 'runtime runner source_manifest entries').map(
    (entry, index) => object(entry, `runtime runner source manifest entry ${String(index)}`),
  );
  const sourcePaths = sourceEntries.map((entry) =>
    string(entry.path, 'runtime runner source manifest path'),
  );

  if (
    sourcePaths.some((path, index) => {
      const previous = index > 0 ? sourcePaths[index - 1] : undefined;
      return previous !== undefined && previous >= path;
    }) ||
    documentDigest(sourceManifest) !== runner.source_manifest_sha256
  ) {
    throw new Error('runtime runner source manifest is not ordered or committed');
  }
  const runnerSource = sourceEntries.find(
    (entry) => entry.path === 'apps/aiq-runner/src/runner.rs',
  );
  if (runnerSource === undefined || execution.runner_prompt_source_sha256 !== runnerSource.sha256) {
    throw new Error('runtime runner prompt source commitment is invalid');
  }

  const commands = array(modelToolchain.commands, 'runtime model toolchain commands').map(
    (command, index) => object(command, `runtime model toolchain command ${String(index)}`),
  );
  const nodeCommand = commands[0];
  if (
    nodeCommand === undefined ||
    nodeCommand.name !== 'node' ||
    nodeCommand.executable_sha256 !== nodeRuntime.executable_sha256 ||
    nodeCommand.version !== nodeRuntime.version ||
    modelToolchain.platform !== operatingSystem.platform ||
    modelToolchain.architecture !== operatingSystem.architecture
  ) {
    throw new Error('runtime Node.js and model toolchain identities do not match');
  }

  const observedToolPolicy = documentDigest({
    protocol: 'aiq.tool-policy.v1',
    evidence_class: 'declared_policy_commitment',
    catalog: catalogTasks.map((task) => ({
      task_id: task.task_id,
      allowed_tools: task.allowed_tools,
    })),
    model_toolchain: modelToolchain,
  });
  const observedNetworkPolicy = documentDigest({
    protocol: 'aiq.network-policy.v1',
    evidence_class: 'declared_policy_commitment',
    codex_web_search: 'disabled_for_controlled_corpus',
    codex_mcp: 'disabled',
    evaluator_node_scenario: 'network_denied_by_node_permission_model',
  });

  if (
    execution.environment_sha256 !== documentDigest(runtime) ||
    execution.declared_tool_policy_sha256 !== observedToolPolicy ||
    execution.declared_network_policy_sha256 !== observedNetworkPolicy
  ) {
    throw new Error('corpus deterministic execution commitments are invalid');
  }

  const runtimeDigest = digest(nodeRuntime.executable_sha256, 'runtime node executable_sha256');
  const evaluatorDigest = digest(
    evaluator.executable_sha256,
    'runtime evaluator executable_sha256',
  );
  if (
    evaluatorDigest !== EVALUATOR_IDENTITY ||
    taskBindings.some(
      (binding) =>
        binding.evaluator_runtime_executable_sha256 !== runtimeDigest ||
        binding.evaluator_executable_sha256 !== EVALUATOR_IDENTITY,
    )
  ) {
    throw new Error('task evaluator identities do not match the reviewed runtime provenance');
  }
  return evaluatorDigest;
}

function validateNodes(value: unknown): ValidatedNode[] {
  const nodes = array(value, 'reference.nodes');
  if (nodes.length !== 3) throw new Error('reference must contain exactly three public nodes');
  const validated = nodes.map((item, index): ValidatedNode => {
    const node = object(item, `reference.nodes[${String(index)}]`);
    exactKeys(
      node,
      [
        'schema_version',
        'role',
        'node_id',
        'display_name',
        'key_fingerprint',
        'signature_algorithm',
        'public_key',
        'status',
        'trust_tier',
        'operator_class',
        'capabilities',
        'source',
        'signature_status',
        'provenance',
        'synthetic',
        'public_visible',
      ],
      `reference.nodes[${String(index)}]`,
    );
    const roleValue = string(node.role, 'node role');
    const role = NODE_ROLES.find((candidate) => candidate === roleValue);
    if (role === undefined) throw new Error('node role is invalid');
    const publicKey = string(node.public_key, 'node public_key');
    if (!HEX_PATTERN.test(publicKey)) throw new Error('node public_key is invalid');
    const derivedNodeId = `node_${createHash('sha256')
      .update(Buffer.from(publicKey, 'hex'))
      .digest('hex')}`;
    const fingerprint = `sha256:${createHash('sha256')
      .update(Buffer.from(publicKey, 'hex'))
      .digest('hex')}`;
    const expectedClass = role === 'verifier' ? 'verifier' : 'official';
    const expectedTier = role === 'verifier' ? 'independently_reproduced' : 'trusted_verified';
    const capabilities = array(node.capabilities, 'node capabilities').map((capability) =>
      string(capability, 'node capability'),
    );
    if (
      node.schema_version !== 'aiq.public-node-identity.v1' ||
      node.node_id !== derivedNodeId ||
      node.key_fingerprint !== fingerprint ||
      node.signature_algorithm !== 'ed25519' ||
      node.status !== 'active' ||
      node.trust_tier !== expectedTier ||
      node.operator_class !== expectedClass ||
      capabilities.length !== 1 ||
      capabilities[0] !== role ||
      node.signature_status !== 'verified' ||
      node.synthetic !== false ||
      node.public_visible !== true
    ) {
      throw new Error(`reference.nodes[${String(index)}] is not an approved ${role} identity`);
    }
    return {
      role,
      node_id: derivedNodeId,
      display_name: safeText(node.display_name, 'node display_name'),
      key_fingerprint: fingerprint,
      public_key: publicKey,
      trust_tier: expectedTier,
      operator_class: expectedClass,
      capabilities,
      source: safeText(node.source, 'node source'),
      provenance: safeText(node.provenance, 'node provenance'),
    };
  });
  if (
    new Set(validated.map(({ role }) => role)).size !== 3 ||
    new Set(validated.map(({ node_id }) => node_id)).size !== 3
  ) {
    throw new Error('public node roles and identities must be distinct');
  }
  return NODE_ROLES.map((role) => {
    const node = validated.find((candidate) => candidate.role === role);
    if (node === undefined) throw new Error(`reference is missing the ${role} node`);
    return node;
  });
}

function sqlLiteral(value: unknown): string {
  return `'${canonicalJson(value).replaceAll("'", "''")}'::jsonb`;
}

function orderedJsonLiteral(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::json`;
}

function scoringRows(reviewedAt: string): JsonObject[] {
  return [
    {
      scoring_version: '1.0.3',
      schema_version: 'aiq.score-snapshot.v1',
      benchmark_version: 'aiq-core@1.0.3',
      name: 'AIQ fixed-fixture score 1.0.3',
      fixed_fixture_estimand:
        'The unscaled mean of ten equally weighted domain means over the frozen 72-task fixture.',
      principles: [
        'Give each of the ten domains weight 0.1.',
        'Keep the frozen domain and difficulty quotas.',
        'Keep missing and invalid tasks in completion accounting and block Official publication.',
        'Classify complete synthetic fixtures as descriptive Synthetic Complete, never Official or ranking eligible.',
        'Treat attributable agent, model, tool, timeout, budget, and wrong-artifact failures as valid zero scores.',
        'Treat benchmark infrastructure failures as invalid and audit a rerun.',
      ],
      missing_policy:
        'Missing and invalid tasks block Official. Synthetic Complete and Provisional output use descriptive observed domain means and fixed-fixture completion bounds without ranking eligibility.',
      failure_policy_text:
        'Attributable failures are valid zero scores. Infrastructure failures are invalid and require an audited rerun.',
      confidence_policy:
        'The task-resampling interval uses finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction calibrated for this fixed benchmark fixture. It is a fixed-fixture calibrated sensitivity interval, not a universal confidence interval for model capability.',
      formula: {
        aggregate: 'mean_of_domain_means',
        coverage_multiplier: false,
        domain_weight: 0.1,
        official_valid_task_count: 72,
        official_covered_domain_count: 10,
        synthetic_complete: {
          covered_domain_count: 10,
          official_aiq: null,
          ranking_eligible: false,
          valid_task_count: 72,
        },
      },
      interval_method: {
        central_mass: 0.95,
        deviation_scale: 1.3,
        method: 'finite_cluster_calibrated_percentile_sensitivity_v1',
        samples: 10000,
        scope: 'fixed_fixture_calibrated_sensitivity',
        synthetic: false,
        universal_confidence_interval: false,
      },
      failure_policy: {
        attributable_failure_score: 0,
        infrastructure_failure_score: null,
        missing_blocks_official: true,
        provisional_ranked: false,
        synthetic_complete_ranked: false,
      },
      synthetic: false,
      is_published: true,
      published_at: reviewedAt,
    },
  ];
}

function referenceRows(
  catalog: JsonObject,
  reference: ValidatedReference,
): {
  scoring: JsonObject[];
  taskSets: JsonObject[];
  tasks: JsonObject[];
  models: JsonObject[];
  nodes: JsonObject[];
} {
  const catalogTasks = array(catalog.tasks, 'catalog.tasks').map((item) =>
    object(item, 'catalog task'),
  );
  const commitmentHex = reference.corpusCommitmentSha256.slice(7);
  return {
    scoring: scoringRows(reference.publishedAt),
    taskSets: [
      {
        task_set_id: 'aiq-core',
        task_set_version: '1.0.3',
        title: 'AIQ Core 72',
        task_count: 72,
        domain_count: 10,
        catalog_sha256: CATALOG_IDENTITY.slice(7),
        catalog_identity_scope: 'ordered_full_task_metadata',
        hidden_payload_commitment: commitmentHex,
        content_status: 'committed',
        is_published: true,
        published_at: reference.publishedAt,
        retired_at: null,
        metadata: {
          synthetic: false,
          corpus_release_id: reference.releaseId,
          corpus_commitment_schema: 'aiq.corpus-commitment.v2',
          corpus_commitment_sha256: reference.corpusCommitmentSha256,
          catalog_release_identity_sha256: CATALOG_RELEASE_IDENTITY,
          evaluator_identity_sha256: reference.evaluatorIdentitySha256,
          quota_policy: 'frozen_domain_by_difficulty',
        },
      },
    ],
    tasks: catalogTasks.map((task, index) => {
      const evaluator = object(task.evaluator, 'catalog task evaluator');
      const leakage = object(task.leakage_review, 'catalog task leakage_review');
      const binding = reference.taskBindings[index];
      if (binding === undefined) throw new Error('task binding is missing');
      return {
        task_set_id: 'aiq-core',
        task_set_version: '1.0.3',
        task_id: task.task_id,
        task_version: task.task_version,
        title: task.title,
        domain: task.domain,
        difficulty: task.difficulty,
        summary: task.summary,
        evaluator_kind: evaluator.kind,
        scorer_version: evaluator.scorer_version,
        allowed_tools: task.allowed_tools,
        budget: task.budget,
        tags: task.tags,
        catalog_ordinal: index + 1,
        full_public_metadata: task,
        fixture_commitment: string(binding.task_definition_sha256, 'task_definition_sha256').slice(
          7,
        ),
        hidden_content_ref: null,
        leakage_notes: leakage.notes,
        public_metadata: true,
      };
    }),
    models: EXPECTED_MODEL_CONFIGS.map((model) =>
      Object.assign({}, model, {
        expected_in_matrix: true,
        capability_status: 'unverified',
        provider_fingerprint: null,
        is_enabled: true,
      }),
    ),
    nodes: reference.nodes.map((node) => ({
      node_id: node.node_id,
      display_name: node.display_name,
      key_fingerprint: node.key_fingerprint,
      signature_algorithm: 'ed25519',
      public_key: node.public_key,
      status: 'active',
      trust_tier: node.trust_tier,
      operator_class: node.operator_class,
      capabilities: node.capabilities,
      source: node.source,
      signature_status: 'verified',
      provenance: node.provenance,
      synthetic: false,
      public_visible: true,
      registered_at: reference.publishedAt,
      last_seen_at: null,
      revoked_at: null,
      publisher_authorized: node.role === 'publisher',
      metadata: {
        synthetic: false,
        approved_role: node.role,
        corpus_release_id: reference.releaseId,
      },
    })),
  };
}

function insertSql(rows: ReturnType<typeof referenceRows>, publisherNodeId: string): string {
  return `
insert into aiq_private.aiq_scoring_versions (
  scoring_version, schema_version, benchmark_version, name, fixed_fixture_estimand,
  principles, missing_policy, failure_policy_text, confidence_policy, formula,
  interval_method, failure_policy, synthetic, is_published, published_at
)
select scoring_version, schema_version, benchmark_version, name, fixed_fixture_estimand,
  principles, missing_policy, failure_policy_text, confidence_policy, formula,
  interval_method, failure_policy, synthetic, is_published, published_at
from jsonb_to_recordset(${sqlLiteral(rows.scoring)}) as row(
  scoring_version text, schema_version text, benchmark_version text, name text,
  fixed_fixture_estimand text, principles text[], missing_policy text,
  failure_policy_text text, confidence_policy text, formula jsonb,
  interval_method jsonb, failure_policy jsonb, synthetic boolean,
  is_published boolean, published_at timestamptz
);

insert into aiq_private.aiq_task_sets (
  task_set_id, task_set_version, title, task_count, domain_count, catalog_sha256,
  catalog_identity_scope, hidden_payload_commitment, content_status, is_published,
  published_at, retired_at, metadata
)
select task_set_id, task_set_version, title, task_count, domain_count, catalog_sha256,
  catalog_identity_scope, hidden_payload_commitment, content_status, is_published,
  published_at, retired_at, metadata
from jsonb_to_recordset(${sqlLiteral(rows.taskSets)}) as row(
  task_set_id text, task_set_version text, title text, task_count integer,
  domain_count integer, catalog_sha256 text, catalog_identity_scope text,
  hidden_payload_commitment text, content_status text, is_published boolean,
  published_at timestamptz, retired_at timestamptz, metadata jsonb
);

insert into aiq_private.aiq_task_catalog (
  task_set_id, task_set_version, task_id, task_version, title, domain, difficulty,
  summary, evaluator_kind, scorer_version, allowed_tools, budget, tags,
  catalog_ordinal, full_public_metadata, fixture_commitment, hidden_content_ref,
  leakage_notes, public_metadata
)
select task_set_id, task_set_version, task_id, task_version, title, domain, difficulty,
  summary, evaluator_kind, scorer_version, allowed_tools, budget, tags,
  catalog_ordinal, full_public_metadata, fixture_commitment, hidden_content_ref,
  leakage_notes, public_metadata
from json_to_recordset(${orderedJsonLiteral(rows.tasks)}) as row(
  task_set_id text, task_set_version text, task_id text, task_version text,
  title text, domain text, difficulty text, summary text, evaluator_kind text,
  scorer_version text, allowed_tools jsonb, budget jsonb, tags text[],
  catalog_ordinal smallint, full_public_metadata json, fixture_commitment text,
  hidden_content_ref text, leakage_notes text, public_metadata boolean
);

insert into aiq_private.aiq_model_configs (
  model_config_id, provider, model_family, provider_model_id, reasoning_effort,
  display_name, matrix_order, expected_in_matrix, capability_status,
  provider_fingerprint, is_enabled
)
select model_config_id, provider, model_family, provider_model_id, reasoning_effort,
  display_name, matrix_order, expected_in_matrix, capability_status,
  provider_fingerprint, is_enabled
from jsonb_to_recordset(${sqlLiteral(rows.models)}) as row(
  model_config_id text, provider text, model_family text, provider_model_id text,
  reasoning_effort text, display_name text, matrix_order smallint,
  expected_in_matrix boolean, capability_status text, provider_fingerprint text,
  is_enabled boolean
);

insert into aiq_private.aiq_nodes (
  node_id, display_name, key_fingerprint, signature_algorithm, public_key, status,
  trust_tier, operator_class, capabilities, source, signature_status, provenance,
  synthetic, public_visible, registered_at, last_seen_at, revoked_at,
  publisher_authorized, metadata
)
select node_id, display_name, key_fingerprint, signature_algorithm, public_key,
  status::aiq_private.node_status, trust_tier::aiq_private.trust_tier,
  operator_class, capabilities, source, signature_status, provenance, synthetic,
  public_visible, registered_at, last_seen_at, revoked_at,
  publisher_authorized, metadata
from jsonb_to_recordset(${sqlLiteral(rows.nodes)}) as row(
  node_id text, display_name text, key_fingerprint text, signature_algorithm text,
  public_key text, status text, trust_tier text, operator_class text,
  capabilities text[], source text, signature_status text, provenance text,
  synthetic boolean, public_visible boolean, registered_at timestamptz,
  last_seen_at timestamptz, revoked_at timestamptz,
  publisher_authorized boolean, metadata jsonb
);

do $aiq_reference_check$
begin
  if (select count(*) from aiq_private.aiq_task_catalog) <> 72
    or (select count(*) from aiq_private.aiq_model_configs where expected_in_matrix) <> 17
    or (select count(*) from aiq_private.aiq_nodes where not synthetic and public_visible) <> 3
    or not aiq_private.frozen_catalog_identity_is_valid('aiq-core', '1.0.3', '1.0.3')
  then
    raise exception 'AIQ production reference initialization did not validate'
      using errcode = '23514';
  end if;
end
$aiq_reference_check$;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $aiq_readiness_check$
begin
  if coalesce((
    public.aiq_production_reference_status('${publisherNodeId}') ->> 'initialized'
  )::boolean, false) is distinct from true then
    raise exception 'AIQ production reference readiness did not validate'
      using errcode = '23514';
  end if;
end
$aiq_readiness_check$;

select public.aiq_production_reference_status('${publisherNodeId}')::text;
reset role;
`;
}

function schemaTransactionBody(schema: string): string {
  const lines = schema
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .split('\n');
  const nonempty = lines
    .map((line, index) => ({ line: line.trim().toLowerCase(), index }))
    .filter(({ line }) => line !== '');
  const first = nonempty[0];
  const last = nonempty.at(-1);

  if (
    first?.line !== 'begin;' ||
    last?.line !== 'commit;' ||
    nonempty
      .slice(1, -1)
      .some(({ line }) => line === 'begin;' || line === 'commit;' || line === 'rollback;')
  ) {
    throw new Error('schema.sql must have one standalone begin/commit transaction wrapper');
  }

  return lines
    .slice(first.index + 1, last.index)
    .join('\n')
    .trim();
}

export function prepareInitialization(
  schema: string,
  catalogValue: unknown,
  referenceValue: unknown,
  corpusSchemaValue: unknown,
  reviewedTaskCommitmentsValue: unknown,
): PreparedInitialization {
  const catalog = object(catalogValue, 'catalog');
  if (
    catalog.schema_version !== 'aiq.catalog.v1' ||
    catalog.task_set_id !== 'aiq-core' ||
    catalog.task_set_version !== '1.0.3' ||
    object(catalog.task_metadata_identity, 'catalog.task_metadata_identity').digest !==
      CATALOG_IDENTITY ||
    object(catalog.catalog_release_identity, 'catalog.catalog_release_identity').digest !==
      CATALOG_RELEASE_IDENTITY
  ) {
    throw new Error('checked-in catalog authority is invalid');
  }
  const reference = validateCommitment(
    object(referenceValue, 'reference'),
    catalog,
    corpusSchemaValue,
    reviewedTaskCommitmentsValue,
  );
  const rows = referenceRows(catalog, reference);
  const publisher = reference.nodes.find(({ role }) => role === 'publisher');
  if (publisher === undefined) throw new Error('publisher node is missing');
  const preflight = `do $aiq_greenfield_preflight$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'aiq_private')
    or exists (
      select 1 from pg_catalog.pg_roles
      where rolname in ('aiq_verifier', 'aiq_publisher')
    )
  then
    raise exception 'AIQ_GREENFIELD_REUSE_REJECTED'
      using errcode = '55000';
  end if;
end
$aiq_greenfield_preflight$;
`;
  const nodeIds: Record<NodeRole, string> = {
    runner: '',
    verifier: '',
    publisher: '',
  };
  for (const node of reference.nodes) nodeIds[node.role] = node.node_id;
  return {
    sql: `\\set ON_ERROR_STOP on
\\set VERBOSITY verbose
begin;
${preflight}
${schemaTransactionBody(schema)}
${insertSql(rows, publisher.node_id)}
commit;
`,
    receipt: {
      schema_version: 'aiq.production-initialization-receipt.v1',
      initialized: true,
      scoring_version: '1.0.3',
      catalog_identity_sha256: CATALOG_IDENTITY,
      catalog_release_identity_sha256: CATALOG_RELEASE_IDENTITY,
      corpus_commitment_sha256: reference.corpusCommitmentSha256,
      corpus_release_id: reference.releaseId,
      task_set_identity_sha256: reference.taskSetIdentitySha256,
      evaluator_identity_sha256: reference.evaluatorIdentitySha256,
      task_count: 72,
      model_config_count: 17,
      public_node_count: 3,
      private_table_count: 40,
      forced_rls_table_count: 40,
      public_view_count: 12,
      security_invoker_view_count: 12,
      hardened_gateway_role_count: 2,
      node_ids: nodeIds,
    },
  };
}

async function runPsql(
  command: string,
  databaseUrl: string,
  sql: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const childEnvironment: NodeJS.ProcessEnv = databaseConnectionEnvironment(databaseUrl);
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']) {
      if (environment[key] !== undefined) childEnvironment[key] = environment[key];
    }
    const child = spawn(
      command,
      ['-X', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1'],
      { env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PSQL_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', () => rejectPromise(new Error('psql could not start')));
    child.on('close', (code) => {
      if (outputBytes > MAX_PSQL_OUTPUT_BYTES || code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString('utf8');
        if (
          outputBytes <= MAX_PSQL_OUTPUT_BYTES &&
          /^ERROR:\s+55000:\s+AIQ_GREENFIELD_REUSE_REJECTED\s*$/m.test(diagnostic)
        ) {
          rejectPromise(
            new Error(
              'Initialization rejected because AIQ objects already exist. The rejected attempt made no changes. Verify the accepted backups, reset only the exact AIQ namespace, and retry greenfield initialization.',
            ),
          );
          return;
        }
        rejectPromise(
          new Error(
            'Fresh initialization did not complete. Inspect protected PostgreSQL logs, confirm that the transaction rolled back and the AIQ namespace is empty, then correct the inputs before retrying.',
          ),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(sql);
  });
}

export function databaseConnectionEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname === '' ||
    database === '' ||
    parsed.hash !== ''
  ) {
    throw new Error('AIQ_DATABASE_URL must contain one PostgreSQL connection URL');
  }

  const result: NodeJS.ProcessEnv = {
    PGHOST: parsed.hostname.replace(/^\[(.*)]$/, '$1'),
    PGDATABASE: database,
  };
  if (parsed.port !== '') result.PGPORT = parsed.port;
  if (parsed.username !== '') result.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password !== '') result.PGPASSWORD = decodeURIComponent(parsed.password);

  const queryEnvironment = new Map([
    ['application_name', 'PGAPPNAME'],
    ['channel_binding', 'PGCHANNELBINDING'],
    ['connect_timeout', 'PGCONNECT_TIMEOUT'],
    ['gssencmode', 'PGGSSENCMODE'],
    ['krbsrvname', 'PGKRBSRVNAME'],
    ['options', 'PGOPTIONS'],
    ['sslcert', 'PGSSLCERT'],
    ['sslcrl', 'PGSSLCRL'],
    ['sslcrldir', 'PGSSLCRLDIR'],
    ['sslkey', 'PGSSLKEY'],
    ['sslmode', 'PGSSLMODE'],
    ['sslnegotiation', 'PGSSLNEGOTIATION'],
    ['sslpassword', 'PGSSLPASSWORD'],
    ['sslrootcert', 'PGSSLROOTCERT'],
    ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
  ]);

  for (const [key, value] of parsed.searchParams) {
    const environmentName = queryEnvironment.get(key);
    if (environmentName === undefined || value === '') {
      throw new Error('AIQ_DATABASE_URL contains an unsupported connection option');
    }
    result[environmentName] = value;
  }

  return result;
}

function readinessPassed(output: string, expected: InitializationReceipt): boolean {
  for (const line of output.trim().split(/\r?\n/).toReversed()) {
    try {
      const value: unknown = JSON.parse(line);
      if (
        isObject(value) &&
        value.initialized === true &&
        value.task_set_identity_sha256 === expected.task_set_identity_sha256 &&
        value.task_set_identity_valid === true &&
        value.evaluator_identity_sha256 === expected.evaluator_identity_sha256 &&
        value.evaluator_identity_valid === true
      ) {
        return true;
      }
    } catch {
      // Ignore bounded psql status lines that are not JSON.
    }
  }
  return false;
}

export async function initializeDatabase(options: {
  readonly referencePath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly psqlCommand?: string;
  readonly repositoryRoot?: string;
}): Promise<InitializationReceipt> {
  const environment = options.environment ?? process.env;
  const databaseUrl = environment.AIQ_DATABASE_URL;
  if (
    databaseUrl === undefined ||
    !/^postgres(?:ql)?:\/\/[^\s]{1,2048}(?![\s\S])/.test(databaseUrl)
  ) {
    throw new Error('AIQ_DATABASE_URL must contain one PostgreSQL connection URL');
  }
  const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dirname, '..');
  const referenceBytes = await readFile(options.referencePath);
  if (referenceBytes.length === 0 || referenceBytes.length > MAX_REFERENCE_BYTES) {
    throw new Error('production reference file size is invalid');
  }
  let reference: unknown;
  try {
    reference = JSON.parse(referenceBytes.toString('utf8'));
  } catch {
    throw new Error('production reference file is not valid JSON');
  }
  const [schema, catalog, corpusSchema, reviewedTaskCommitments] = await Promise.all([
    readFile(resolve(repositoryRoot, 'databases/schema.sql'), 'utf8'),
    readFile(
      resolve(repositoryRoot, 'benchmarks/candidates/aiq-core-1.0.3/catalog.json'),
      'utf8',
    ).then((bytes) => JSON.parse(bytes) as unknown),
    readFile(
      resolve(repositoryRoot, 'benchmarks/schema/corpus-commitment-v2.schema.json'),
      'utf8',
    ).then((bytes) => JSON.parse(bytes) as unknown),
    readFile(
      resolve(repositoryRoot, 'databases/aiq-core-1.0.3-task-commitments.json'),
      'utf8',
    ).then((bytes) => JSON.parse(bytes) as unknown),
  ]);
  const prepared = prepareInitialization(
    schema,
    catalog,
    reference,
    corpusSchema,
    reviewedTaskCommitments,
  );
  const output = await runPsql(
    options.psqlCommand ?? 'psql',
    databaseUrl,
    prepared.sql,
    environment,
  );
  if (!readinessPassed(output, prepared.receipt)) {
    throw new Error(
      'Fresh initialization did not return a valid readiness result. Do not retry against the uncertain state. Inspect protected PostgreSQL logs and readiness, verify the accepted backups, and reset only the exact AIQ namespace before a greenfield retry.',
    );
  }
  return prepared.receipt;
}

function parseArguments(cliArguments: readonly string[]): {
  referencePath?: string;
  help: boolean;
} {
  if (cliArguments.length === 1 && cliArguments[0] === '--help') return { help: true };
  if (cliArguments.length === 0) return { help: false };
  if (
    cliArguments.length === 2 &&
    cliArguments[0] === '--reference' &&
    cliArguments[1] !== undefined &&
    cliArguments[1] !== '' &&
    !cliArguments[1].startsWith('--')
  ) {
    return { help: false, referencePath: cliArguments[1] };
  }
  throw new Error('Usage: node databases/init.ts --reference PATH');
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    const cliArguments = parseArguments(process.argv.slice(2));
    if (cliArguments.help) {
      process.stdout.write('Usage: node databases/init.ts --reference PATH\n');
    } else {
      const referencePath = cliArguments.referencePath ?? process.env.AIQ_PRODUCTION_REFERENCE;
      if (referencePath === undefined || referencePath === '') {
        throw new Error(
          'Supply --reference PATH or set AIQ_PRODUCTION_REFERENCE to the reference path',
        );
      }
      const receipt = await initializeDatabase({ referencePath });
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database initialization failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
