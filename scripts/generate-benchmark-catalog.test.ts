import { deepStrictEqual, match, strictEqual, throws } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AIQ_CORE_V1_TASK_IDENTITY_SHA256,
  COMMAND_EXECUTION_DISCLOSURE,
  DOMAINS,
  HISTORICAL_PREDECESSOR_GENERATOR,
  assertCatalogInvariants,
  buildCatalog,
  taskIdentityDigest,
  type Catalog,
  type CatalogTask,
} from './generate-benchmark-catalog.ts';

type JsonSchema = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(source: string): JsonSchema {
  const value: unknown = JSON.parse(source);
  if (!isJsonObject(value)) {
    throw new TypeError('Expected a JSON object.');
  }
  return value;
}

function objectProperty(record: JsonSchema, field: string): JsonSchema {
  const value = record[field];
  if (!isJsonObject(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
  return value;
}

function arrayProperty(record: JsonSchema, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array.`);
  }
  return value;
}

function replaceFirstAllowedTools(catalog: Catalog, allowedTools: readonly string[]): Catalog {
  const [firstTask, ...remainingTasks] = catalog.tasks;
  if (firstTask === undefined) {
    throw new RangeError('Catalog must contain a task.');
  }
  return {
    ...catalog,
    tasks: [{ ...firstTask, allowed_tools: allowedTools }, ...remainingTasks],
  };
}

function replaceFirstTask(catalog: Catalog, task: CatalogTask): Catalog {
  const [, ...remainingTasks] = catalog.tasks;

  return { ...catalog, tasks: [task, ...remainingTasks] };
}

function resolveReference(root: JsonSchema, reference: string): JsonSchema {
  let value: unknown = root;
  for (const segment of reference.replace(/^#\//, '').split('/')) {
    if (!isJsonObject(value)) {
      throw new TypeError(`Schema reference ${reference} does not resolve to an object.`);
    }
    value = value[segment];
  }
  if (!isJsonObject(value)) {
    throw new TypeError(`Schema reference ${reference} does not resolve to an object.`);
  }
  return value;
}

function matchesSchema(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  if (typeof schema.$ref === 'string') {
    return matchesSchema(value, resolveReference(root, schema.$ref), root);
  }
  if (Array.isArray(schema.oneOf)) {
    return (
      schema.oneOf.filter(
        (candidate) => isJsonObject(candidate) && matchesSchema(value, candidate, root),
      ).length === 1
    );
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every(
      (candidate) => isJsonObject(candidate) && matchesSchema(value, candidate, root),
    )
  ) {
    return false;
  }
  if (isJsonObject(schema.if)) {
    const conditionMatches = matchesSchema(value, schema.if, root);
    if (conditionMatches && isJsonObject(schema.then) && !matchesSchema(value, schema.then, root)) {
      return false;
    }
    if (
      !conditionMatches &&
      isJsonObject(schema.else) &&
      !matchesSchema(value, schema.else, root)
    ) {
      return false;
    }
  }
  if (isJsonObject(schema.not) && matchesSchema(value, schema.not, root)) {
    return false;
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return false;
  }

  const hasObjectKeywords =
    schema.type === 'object' ||
    isJsonObject(schema.properties) ||
    Array.isArray(schema.required) ||
    schema.additionalProperties !== undefined;
  if (hasObjectKeywords) {
    if (!isJsonObject(value)) {
      return false;
    }
    const object = value;
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    if (
      Array.isArray(schema.required) &&
      schema.required.some((field) => typeof field === 'string' && !(field in object))
    ) {
      return false;
    }
    for (const [field, fieldValue] of Object.entries(object)) {
      const propertySchema = properties[field];
      if (isJsonObject(propertySchema)) {
        if (!matchesSchema(fieldValue, propertySchema, root)) {
          return false;
        }
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        isJsonObject(schema.additionalProperties) &&
        !matchesSchema(fieldValue, schema.additionalProperties, root)
      ) {
        return false;
      }
    }
    return true;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return false;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return false;
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return false;
    }
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      return false;
    }
    const contains = schema.contains;
    if (isJsonObject(contains) && !value.some((item) => matchesSchema(item, contains, root))) {
      return false;
    }
    const items = schema.items;
    return (
      items === undefined ||
      (isJsonObject(items) && value.every((item) => matchesSchema(item, items, root)))
    );
  }

  if (schema.type === 'string') {
    return (
      typeof value === 'string' &&
      (typeof schema.minLength !== 'number' || value.length >= schema.minLength) &&
      (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength) &&
      (typeof schema.pattern !== 'string' || new RegExp(schema.pattern).test(value))
    );
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value)) &&
      (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
      (typeof schema.maximum !== 'number' || value <= schema.maximum)
    );
  }

  if (schema.type === 'boolean') {
    return typeof value === 'boolean';
  }
  if (schema.type === 'null') {
    return value === null;
  }
  return true;
}

await test('the catalog contains the fixed 72-task distribution', () => {
  const catalog = buildCatalog();

  assertCatalogInvariants(catalog);
  strictEqual(catalog.distribution.total, 72);
  strictEqual(catalog.tasks.length, 72);
  strictEqual(
    Object.values(catalog.distribution.domains).reduce((sum, value) => sum + value, 0),
    72,
  );
  deepStrictEqual(catalog.distribution.difficulties, { easy: 12, medium: 48, hard: 12 });
  deepStrictEqual(Object.keys(catalog.distribution.domains), [...DOMAINS]);
  deepStrictEqual(catalog.distribution.domain_difficulty.coding, {
    easy: 1,
    medium: 5,
    hard: 2,
  });
  deepStrictEqual(catalog.distribution.domain_difficulty.instruction_following, {
    easy: 1,
    medium: 4,
    hard: 1,
  });
});

await test('the frozen identity commitment covers ordered full task metadata', () => {
  const catalog = buildCatalog();

  strictEqual(catalog.identity_commitment.algorithm, 'sha256');
  strictEqual(catalog.identity_commitment.scope, 'ordered_full_task_metadata');
  strictEqual(catalog.identity_commitment.digest, taskIdentityDigest(catalog.tasks));
  strictEqual(catalog.identity_commitment.digest, AIQ_CORE_V1_TASK_IDENTITY_SHA256);

  const first = catalog.tasks[0];
  const second = catalog.tasks[1];
  if (first === undefined || second === undefined) {
    throw new RangeError('Catalog must contain at least two tasks.');
  }
  const reordered: Catalog = {
    ...catalog,
    tasks: [second, first, ...catalog.tasks.slice(2)],
  };
  throws(() => assertCatalogInvariants(reordered), /identity commitment does not match/);
});

await test('the historical predecessor catalog binds task release 1.0.1 to scorer 1.0.0', () => {
  const catalog = buildCatalog();

  strictEqual(catalog.task_set_version, '1.0.1');
  for (const task of catalog.tasks) {
    strictEqual(task.task_version, '1.0.1', task.task_id);
    strictEqual(task.evaluator.scorer_version, '1.0.0', task.task_id);
    strictEqual(
      task.input_contract.content_handle,
      `aiq-controlled-task://aiq-core/1.0.1/${task.task_id}`,
      task.task_id,
    );
  }

  const first = catalog.tasks[0];
  if (first === undefined) {
    throw new Error('Catalog must contain a task.');
  }
  throws(
    () => assertCatalogInvariants(replaceFirstTask(catalog, { ...first, task_version: '1.0.0' })),
    /historical AIQ Core predecessor catalog requires/,
  );
});

await test('the public catalog contains metadata references, not hidden payloads', () => {
  const catalog = buildCatalog();

  for (const task of catalog.tasks) {
    strictEqual(task.visibility, 'hidden');
    strictEqual(task.input_contract.content_handle.startsWith('aiq-controlled-task://'), true);
    strictEqual(task.input_contract.content_handle.includes('supabase'), false);
    strictEqual('prompt' in task, false);
    strictEqual('expected' in task, false);
  }
});

await test('public metadata stays capability-neutral and matches scored behavior', () => {
  const tasks = new Map(buildCatalog().tasks.map((task) => [task.task_id, task]));
  const reliabilityIds = [
    'reliability-recovery-01',
    'reliability-recovery-03',
    'reliability-recovery-04',
    'reliability-recovery-07',
  ];
  for (const taskId of reliabilityIds) {
    const task = tasks.get(taskId);
    const text = `${task?.summary ?? ''} ${task?.evaluator.pass_conditions.join(' ') ?? ''}`;
    strictEqual(
      /\bunsupported\b|request retransmission|no winner|idempotency key is reused/iu.test(text),
      false,
      taskId,
    );
  }
  strictEqual(tasks.get('coding-04')?.input_contract.kind, 'library_function_patch');
  strictEqual(
    tasks
      .get('coding-08')
      ?.evaluator.pass_conditions.includes('Failed effects do not advance the checkpoint.'),
    true,
  );
  strictEqual(
    tasks
      .get('tool-use-05')
      ?.evaluator.pass_conditions.includes('The focused tests reject seeded behavioral mutants.'),
    true,
  );
  strictEqual(
    tasks
      .get('tool-use-06')
      ?.evaluator.pass_conditions.includes('The lineage artifact binds both exact frozen inputs.'),
    true,
  );
});

await test('the catalog does not declare live web search', () => {
  const catalog = buildCatalog();

  for (const task of catalog.tasks) {
    strictEqual(task.allowed_tools.includes('web_search'), false, task.task_id);
  }
});

await test('the versioned tool-use designs declare exact command execution evidence', () => {
  const catalog = buildCatalog();
  const expectedTaskIds = Array.from(
    { length: 7 },
    (_, index) => `tool-use-${String(index + 1).padStart(2, '0')}`,
  );
  const toolUseTasks = catalog.tasks.filter(({ domain }) => domain === 'tool_use');

  strictEqual(catalog.status, 'public_designs_versioned_private_content_required');
  deepStrictEqual(
    toolUseTasks.map(({ task_id: taskId }) => taskId),
    expectedTaskIds,
  );

  for (const task of catalog.tasks) {
    strictEqual(
      task.leakage_review.status,
      'public_design_versioned_private_content_required',
      task.task_id,
    );
    strictEqual(
      task.leakage_review.review_requirement,
      'private_corpus_tests_and_catalog_binding_required',
      task.task_id,
    );
    strictEqual(task.leakage_review.notes.includes('reviewed on 2026-07-29'), false, task.task_id);
    strictEqual(
      task.leakage_review.notes.includes(
        'must bind this exact catalog entry and pass the deterministic corpus tests before a real run',
      ),
      true,
      task.task_id,
    );

    const disclosureCount = task.evaluator.pass_conditions.filter(
      (condition) => condition === COMMAND_EXECUTION_DISCLOSURE,
    ).length;
    if (task.domain === 'tool_use') {
      deepStrictEqual(
        task.allowed_tools,
        ['filesystem_read', 'filesystem_write', 'command_execution'],
        task.task_id,
      );
      strictEqual(disclosureCount, 1, task.task_id);
      strictEqual(
        task.evaluator.pass_conditions.at(-1),
        COMMAND_EXECUTION_DISCLOSURE,
        task.task_id,
      );
    } else {
      strictEqual(task.allowed_tools.includes('command_execution'), false, task.task_id);
      strictEqual(disclosureCount, 0, task.task_id);
    }
  }
});

await test('every task publishes structured evidence and acceptance commitments', () => {
  const catalog = buildCatalog();
  const expectedClasses = [
    'gold',
    'alternate_correct',
    'partial',
    'adversarial_format',
    'empty',
    'timeout',
  ];

  for (const task of catalog.tasks) {
    deepStrictEqual(Object.keys(task.evaluator.acceptance_fixture_commitments), expectedClasses);
    strictEqual(task.evaluator.execution_protocol, 'aiq.evaluator-protocol.v1');
    strictEqual(task.evaluator.binding_requirement, 'controlled_hidden_task_required');
    strictEqual(task.provenance.origin, 'original_benchmark_design');
    strictEqual(task.leakage_review.status, 'public_design_versioned_private_content_required');
    strictEqual(task.leakage_review.notes.includes(task.task_id), true);
    strictEqual(
      task.leakage_review.notes.includes('pass the deterministic corpus tests before a real run.'),
      true,
    );
    strictEqual(/^[a-z_]+-cluster-[0-9]{2}$/u.test(task.cluster_id), true);
  }
});

await test('semantic dependencies share conservative cross-domain clusters', () => {
  const tasks = new Map(buildCatalog().tasks.map((task) => [task.task_id, task]));

  strictEqual(tasks.get('coding-08')?.cluster_id, tasks.get('reliability-recovery-02')?.cluster_id);
  strictEqual(
    tasks.get('instruction-following-02')?.cluster_id,
    tasks.get('instruction-following-06')?.cluster_id,
  );
  strictEqual(
    tasks.get('instruction-following-02')?.cluster_id,
    tasks.get('tool-use-05')?.cluster_id,
  );
  strictEqual(
    tasks.get('retrieval-verification-01')?.cluster_id,
    tasks.get('retrieval-verification-07')?.cluster_id,
  );
});

await test('catalog invariants reject unknown tools and mixed none', () => {
  const source = buildCatalog();
  const unknown = replaceFirstAllowedTools(source, ['shell']);
  throws(() => assertCatalogInvariants(unknown), /invalid allowed-tools policy/);

  const webSearch = replaceFirstAllowedTools(source, ['web_search']);
  throws(() => assertCatalogInvariants(webSearch), /invalid allowed-tools policy/);

  const mixedNone = replaceFirstAllowedTools(source, ['none', 'filesystem_read']);
  throws(() => assertCatalogInvariants(mixedNone), /invalid allowed-tools policy/);
});

await test('catalog invariants freeze the exact tool-use execution policy and disclosure', () => {
  const source = buildCatalog();
  const replaceToolUse = (taskId: string, update: (task: CatalogTask) => CatalogTask): Catalog => ({
    ...source,
    tasks: source.tasks.map((task) => (task.task_id === taskId ? update(task) : task)),
  });

  for (const allowedTools of [
    ['filesystem_read', 'filesystem_write'],
    ['command_execution', 'filesystem_read', 'filesystem_write'],
    ['filesystem_read', 'filesystem_write', 'command_execution', 'web_search'],
  ] as const) {
    throws(
      () =>
        assertCatalogInvariants(
          replaceToolUse('tool-use-01', (task) => ({ ...task, allowed_tools: allowedTools })),
        ),
      /invalid allowed-tools policy/,
    );
  }

  const missingDisclosure = replaceToolUse('tool-use-01', (task) => ({
    ...task,
    evaluator: {
      ...task.evaluator,
      pass_conditions: task.evaluator.pass_conditions.filter(
        (condition) => condition !== COMMAND_EXECUTION_DISCLOSURE,
      ),
    },
  }));
  throws(
    () => assertCatalogInvariants(missingDisclosure),
    /invalid command-execution evidence disclosure/,
  );
});

await test('generated catalog matches the published catalog schema', async () => {
  const schema = parseJsonObject(await readFile('benchmarks/schema/catalog.schema.json', 'utf8'));
  const catalog = buildCatalog();
  const taskSchema = resolveReference(schema, '#/$defs/task');
  const publicTaskSchema = parseJsonObject(
    await readFile('benchmarks/schema/task.schema.json', 'utf8'),
  );
  const exampleNames = (await readdir('benchmarks/examples/tasks')).filter((name) =>
    name.endsWith('.json'),
  );

  strictEqual(matchesSchema(catalog, schema, schema), true);

  for (const task of catalog.tasks) {
    strictEqual(matchesSchema(task, taskSchema, schema), true, `${task.task_id} must match`);
  }
  await Promise.all(
    exampleNames.map(async (name) => {
      const task: unknown = JSON.parse(
        await readFile(join('benchmarks/examples/tasks', name), 'utf8'),
      );
      strictEqual(
        matchesSchema(task, publicTaskSchema, publicTaskSchema),
        true,
        `${name} must match`,
      );
    }),
  );

  strictEqual(catalog.tasks.length + exampleNames.length, 82);
});

await test('task schemas bind command execution to an explicit filesystem scope', async () => {
  const catalogSchema = parseJsonObject(
    await readFile('benchmarks/schema/catalog.schema.json', 'utf8'),
  );
  const catalogTaskSchema = resolveReference(catalogSchema, '#/$defs/task');
  const catalogTask = buildCatalog().tasks.find(({ domain }) => domain === 'tool_use');
  if (catalogTask === undefined) {
    throw new Error('Catalog must contain a tool-use task.');
  }

  strictEqual(
    matchesSchema(
      { ...catalogTask, allowed_tools: ['command_execution'] },
      catalogTaskSchema,
      catalogSchema,
    ),
    false,
  );
  strictEqual(
    matchesSchema(
      {
        ...catalogTask,
        allowed_tools: ['filesystem_read', 'command_execution'],
      },
      catalogTaskSchema,
      catalogSchema,
    ),
    true,
  );

  const taskSchema = parseJsonObject(await readFile('benchmarks/schema/task.schema.json', 'utf8'));
  const publicTask = parseJsonObject(
    await readFile('benchmarks/examples/tasks/public-example-tool-use.json', 'utf8'),
  );

  strictEqual(
    matchesSchema({ ...publicTask, allowed_tools: ['command_execution'] }, taskSchema, taskSchema),
    false,
  );
  strictEqual(
    matchesSchema(
      {
        ...publicTask,
        allowed_tools: ['filesystem_write', 'command_execution'],
      },
      taskSchema,
      taskSchema,
    ),
    true,
  );
});

await test('catalog machine tokens, versions, fixtures, and acceptance handles are exact', async () => {
  const schema = parseJsonObject(await readFile('benchmarks/schema/catalog.schema.json', 'utf8'));
  const source = buildCatalog();
  const first = source.tasks[0];
  if (first === undefined) {
    throw new Error('Catalog must contain a task.');
  }

  const invalidTasks: CatalogTask[] = [
    { ...first, task_id: `${first.task_id}\n` },
    { ...first, cluster_id: `${first.cluster_id}\r\n` },
    { ...first, task_version: '01.0.0' },
    { ...first, tags: [`${first.tags[0] ?? 'tag'}\u2028`] },
    {
      ...first,
      input_contract: { ...first.input_contract, kind: `${first.input_contract.kind}\u2029` },
    },
    {
      ...first,
      input_contract: {
        ...first.input_contract,
        fixture_profile: `aiq-fixture://${first.task_id}/v2`,
      },
    },
    {
      ...first,
      input_contract: {
        ...first.input_contract,
        content_handle: `aiq-controlled-task://other/1.0.1/${first.task_id}`,
      },
    },
    {
      ...first,
      evaluator: { ...first.evaluator, kind: `${first.evaluator.kind}\n` },
    },
    {
      ...first,
      evaluator: { ...first.evaluator, scorer_version: '1.0.0-beta' },
    },
    {
      ...first,
      evaluator: {
        ...first.evaluator,
        acceptance_fixture_commitments: {
          ...first.evaluator.acceptance_fixture_commitments,
          gold: {
            ...first.evaluator.acceptance_fixture_commitments.gold,
            handle: `aiq-acceptance://${first.task_id}/v1/golden`,
          },
        },
      },
    },
  ];

  for (const task of invalidTasks) {
    strictEqual(matchesSchema(replaceFirstTask(source, task), schema, schema), false);
  }
});

await test('generated predecessor catalog byte-matches the historical checked-in artifact', async () => {
  const published = await readFile('benchmarks/catalog/aiq-core-v1.json', 'utf8');
  strictEqual(published, `${JSON.stringify(buildCatalog(), undefined, 2)}\n`);
});

await test('the historical predecessor command cannot regenerate active authority', () => {
  strictEqual(HISTORICAL_PREDECESSOR_GENERATOR, true);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./generate-benchmark-catalog.ts', import.meta.url))],
    { encoding: 'utf8' },
  );
  strictEqual(result.status, 1);
  match(result.stderr, /historical-only[\s\S]*active AIQ Core 1\.0\.2 catalog/u);
});

await test('published task schema accepts examples and rejects shared negative fixtures', async () => {
  const schema = parseJsonObject(await readFile('benchmarks/schema/task.schema.json', 'utf8'));
  strictEqual(schema.$id, 'https://aiq.wiki/schema/task.v2.json');
  strictEqual(
    objectProperty(objectProperty(schema, 'properties'), 'schema_version').const,
    'aiq.task.v2',
  );
  const exampleNames = (await readdir('benchmarks/examples/tasks')).filter((name) =>
    name.endsWith('.json'),
  );
  await Promise.all(
    exampleNames.map(async (name) => {
      const task: unknown = JSON.parse(
        await readFile(join('benchmarks/examples/tasks', name), 'utf8'),
      );
      strictEqual(matchesSchema(task, schema, schema), true, `${name} must match the schema`);
    }),
  );

  const negativeNames = (await readdir('benchmarks/fixtures/tasks')).filter((name) =>
    name.endsWith('.json'),
  );
  await Promise.all(
    negativeNames.map(async (name) => {
      const task: unknown = JSON.parse(
        await readFile(join('benchmarks/fixtures/tasks', name), 'utf8'),
      );
      strictEqual(matchesSchema(task, schema, schema), false, `${name} must fail the schema`);
    }),
  );
});

await test('task schema keeps human text multiline and rejects unsafe machine fields', async () => {
  const schema = parseJsonObject(await readFile('benchmarks/schema/task.schema.json', 'utf8'));
  const task = parseJsonObject(
    await readFile('benchmarks/examples/tasks/public-example-coding.json', 'utf8'),
  );
  strictEqual(task.schema_version, 'aiq.task.v2');
  strictEqual(matchesSchema({ ...task, schema_version: 'aiq.task.v1' }, schema, schema), false);
  const multiline = structuredClone(task);

  multiline.title = 'A multiline\npublic title';
  multiline.prompt = 'Line one.\nLine two.';
  multiline.leakage_notes = ['Reviewed line one.\nReviewed line two.'];

  strictEqual(matchesSchema(multiline, schema, schema), true);

  for (const [field, value] of [
    ['task_id', `${String(task.task_id)}\n`],
    ['task_id', `${String(task.task_id)}\r\n`],
    ['task_id', `${String(task.task_id)}\u2028`],
    ['task_id', `${String(task.task_id)}\u2029`],
    ['task_version', '01.0.0'],
    ['scorer_version', '1.0.0-beta'],
    ['cluster_id', 'coding-cluster-1'],
  ] as const) {
    const changed = structuredClone(task);
    changed[field] = value;
    strictEqual(matchesSchema(changed, schema, schema), false, `${field} must be rejected`);
  }

  for (const reference of [
    'repo://',
    'repo:///absolute',
    'repo://.',
    'repo://./file',
    'repo://dir/.',
    'repo://dir/..',
    'repo://dir//file',
    'repo://dir/',
    'repo://dir\\file',
    `repo://fixture.json\n`,
    `repo://fixture.json\r\n`,
    `repo://fixture.json\u2028`,
    `repo://fixture.json\u2029`,
    'aiq-controlled-fixture://aiq-core/1.0.1/coding-1',
    'aiq-controlled-fixture://other/1.0.1/coding-01',
    'aiq-controlled-acceptance://aiq-core/1.0.0/coding-01',
  ]) {
    const changed = structuredClone(task);
    changed.fixture_refs = [reference];
    strictEqual(matchesSchema(changed, schema, schema), false, `${reference} must be rejected`);
  }

  const invalidTag = structuredClone(task);
  invalidTag.tags = [`${String(arrayProperty(task, 'tags')[0])}\n`];
  strictEqual(matchesSchema(invalidTag, schema, schema), false);

  const invalidKind = structuredClone(task);
  objectProperty(invalidKind, 'evaluator').kind = 'exact_match\n';
  strictEqual(matchesSchema(invalidKind, schema, schema), false);

  const externalSchema = resolveReference(schema, '#/$defs/externalEvaluator');
  const external: JsonSchema = {
    protocol_version: 'aiq.evaluator-input.v2',
    scorer_version: '1.0.0',
    executable_ref: 'bin/evaluator',
    executable_digest: `sha256:${'a'.repeat(64)}`,
    runtime_kind: 'node',
    runtime_executable_digest: `sha256:${'c'.repeat(64)}`,
    configuration_digest: `sha256:${'b'.repeat(64)}`,
    timeout_ms: 1_000,
    max_input_bytes: 1_024,
    max_output_bytes: 1_024,
  };

  strictEqual(matchesSchema(external, externalSchema, schema), true);
  const configuredChecks = Array.from({ length: 16 }, (_, index) => ({
    check_id: `check_${String(index + 1)}`,
    type: 'text',
    weight: 1,
  }));
  strictEqual(
    matchesSchema(
      { ...external, configuration: { checks: configuredChecks } },
      externalSchema,
      schema,
    ),
    true,
  );
  strictEqual(
    matchesSchema(
      {
        ...external,
        configuration: {
          checks: [...configuredChecks, { check_id: 'check_17', type: 'text', weight: 1 }],
        },
      },
      externalSchema,
      schema,
    ),
    false,
  );
  for (const version of ['01.0.0', '1.00.0', '1.0.00', '1.0.0-beta']) {
    const changed = { ...external, scorer_version: version };
    strictEqual(matchesSchema(changed, externalSchema, schema), false);
  }
  for (const field of ['runtime_kind', 'runtime_executable_digest'] as const) {
    const changed = { ...external };
    delete changed[field];
    strictEqual(matchesSchema(changed, externalSchema, schema), false);
  }
  strictEqual(
    matchesSchema({ ...external, runtime_kind: 'python' }, externalSchema, schema),
    false,
  );
  strictEqual(
    matchesSchema(
      { ...external, runtime_executable_digest: `sha256:${'C'.repeat(64)}` },
      externalSchema,
      schema,
    ),
    false,
  );
  strictEqual(
    matchesSchema(
      { ...external, runtime_digest: external.runtime_executable_digest },
      externalSchema,
      schema,
    ),
    false,
  );

  const hiddenTask = structuredClone(task);
  hiddenTask.visibility = 'hidden';
  hiddenTask.catalog_entry_digest = `sha256:${'d'.repeat(64)}`;
  hiddenTask.evaluator = { kind: 'external_command', external };
  strictEqual(matchesSchema(hiddenTask, schema, schema), true);
  delete hiddenTask.catalog_entry_digest;
  strictEqual(matchesSchema(hiddenTask, schema, schema), false);
  hiddenTask.catalog_entry_digest = `sha256:${'D'.repeat(64)}`;
  strictEqual(matchesSchema(hiddenTask, schema, schema), false);
});
