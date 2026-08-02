import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AIQ_CORE_V1_CATALOG_IDENTITY_SHA256,
  COMMAND_EXECUTION_DISCLOSURE,
  DOMAINS,
  RELEASE_GATE_POLICY,
  PREDECESSOR_CATALOG,
  assertCatalogInvariants,
  buildCatalog,
  catalogIdentityDigest,
  evaluateReleaseGate as evaluateReleaseGateWithAuthority,
  releaseEvidenceSourceDigest,
  releaseEvidenceModelMatrixDigest,
  type Catalog,
  type CatalogTask,
  type ReleaseGateEvidence,
  type ReleaseGateAuthority,
} from './generate-benchmark-catalog.ts';

type JsonSchema = Record<string, unknown>;

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new RangeError(message);
  return value;
}

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

function catalogJson(catalog: Catalog): JsonSchema {
  return parseJsonObject(JSON.stringify(catalog));
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

interface ScoreProfile {
  readonly mean: number;
  readonly model_step?: number;
  readonly repeat_step?: number;
}

function buildReleaseEvidence(
  profiles: ReadonlyMap<string, ScoreProfile> = new Map(),
  repeatIds: readonly string[] = ['repeat-1', 'repeat-2', 'repeat-3'],
): ReleaseGateEvidence {
  const catalog = buildCatalog();
  const modelIds = Array.from({ length: 17 }, (_, index) => `model-${String(index + 1)}`);
  const rawCells = repeatIds.flatMap((repeatId, repeatIndex) =>
    catalog.tasks.flatMap(({ task_id: taskId, domain }) => {
      const profile = profiles.get(taskId) ?? { mean: 0.5 };
      const modelStep = profile.model_step ?? 0.006;
      const repeatStep = profile.repeat_step ?? 0.005;
      return modelIds.map((modelId, modelIndex) => ({
        repeat_id: repeatId,
        task_id: taskId,
        domain,
        model_id: modelId,
        status: 'completed' as const,
        score: profile.mean + (modelIndex - 8) * modelStep + (repeatIndex - 1) * repeatStep,
      }));
    }),
  );
  const pairs = repeatIds.flatMap((repeatId) =>
    modelIds.map((modelId) => ({
      repeat_id: repeatId,
      model_id: modelId,
      reference_score: 0.4,
      challenge_score: 0.43,
    })),
  );
  const pairedContrasts = RELEASE_GATE_POLICY.predeclared_contrasts.map(
    ({ contrast_id: contrastId }, contrastIndex) => ({
      contrast_id: contrastId,
      reference_variant_digest: `sha256:${(['c', 'e', '1'][contrastIndex] ?? '0').repeat(64)}`,
      challenge_variant_digest: `sha256:${(['d', 'f', '2'][contrastIndex] ?? '0').repeat(64)}`,
      pairs: pairs.map((pair) => ({
        repeat_id: pair.repeat_id,
        model_id: pair.model_id,
        reference_score: pair.reference_score + contrastIndex * 0.05,
        challenge_score: pair.challenge_score + contrastIndex * 0.05,
      })),
    }),
  );
  return {
    schema_version: 'aiq.release-gate-evidence.v1',
    release_identity: 'aiq-core/1.0.2',
    catalog_identity_digest: catalog.identity_commitment.digest,
    corpus_commitment_digest: `sha256:${'a'.repeat(64)}`,
    model_matrix_digest: releaseEvidenceModelMatrixDigest(modelIds),
    source_observations_digest: releaseEvidenceSourceDigest(rawCells, pairedContrasts),
    repeat_ids: repeatIds,
    raw_cells: rawCells,
    paired_contrasts: pairedContrasts,
  };
}

function buildReleaseAuthority(): ReleaseGateAuthority {
  const catalog = buildCatalog();
  const modelIds = Array.from({ length: 17 }, (_, index) => `model-${String(index + 1)}`);
  return {
    release_identity: 'aiq-core/1.0.2',
    catalog_identity_digest: catalog.identity_commitment.digest,
    corpus_commitment_digest: `sha256:${'a'.repeat(64)}`,
    model_matrix_digest: releaseEvidenceModelMatrixDigest(modelIds),
    contrast_bindings: RELEASE_GATE_POLICY.predeclared_contrasts.map(
      ({ contrast_id: contrastId }, contrastIndex) => ({
        contrast_id: contrastId,
        reference_variant_digest: `sha256:${(['c', 'e', '1'][contrastIndex] ?? '0').repeat(64)}`,
        challenge_variant_digest: `sha256:${(['d', 'f', '2'][contrastIndex] ?? '0').repeat(64)}`,
      }),
    ),
  };
}

function evaluateReleaseGate(evidence: ReleaseGateEvidence) {
  return evaluateReleaseGateWithAuthority(evidence, buildReleaseAuthority());
}

function replaceRawCells(
  evidence: ReleaseGateEvidence,
  rawCells: ReleaseGateEvidence['raw_cells'],
): ReleaseGateEvidence {
  return {
    ...evidence,
    source_observations_digest: releaseEvidenceSourceDigest(rawCells, evidence.paired_contrasts),
    raw_cells: rawCells,
  };
}

function replacePairedContrasts(
  evidence: ReleaseGateEvidence,
  pairedContrasts: ReleaseGateEvidence['paired_contrasts'],
): ReleaseGateEvidence {
  return {
    ...evidence,
    source_observations_digest: releaseEvidenceSourceDigest(evidence.raw_cells, pairedContrasts),
    paired_contrasts: pairedContrasts,
  };
}

function contrastPairsAtLowerBound(
  pairs: ReleaseGateEvidence['paired_contrasts'][number]['pairs'],
  meanDifferenceAiQ: number,
) {
  const deviationAiQ = (3 * Math.sqrt(pairs.length)) / 2.128;
  return pairs.map((pair, pairIndex) => {
    const differenceAiQ =
      pairIndex === pairs.length - 1
        ? meanDifferenceAiQ
        : meanDifferenceAiQ + (pairIndex % 2 === 0 ? deviationAiQ : -deviationAiQ);
    return {
      ...pair,
      reference_score: 0.5,
      challenge_score: 0.5 + differenceAiQ / 100,
    };
  });
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
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [index, itemSchema] of prefixItems.entries()) {
      if (!isJsonObject(itemSchema) || !matchesSchema(value[index], itemSchema, root)) {
        return false;
      }
    }
    const items = schema.items;
    if (items === false) {
      return value.length <= prefixItems.length;
    }
    const remainingItems = value.slice(prefixItems.length);
    return (
      items === undefined ||
      (isJsonObject(items) && remainingItems.every((item) => matchesSchema(item, items, root)))
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

await test('the frozen identity commitment covers tasks and the release policy', () => {
  const catalog = buildCatalog();

  strictEqual(catalog.identity_commitment.algorithm, 'sha256');
  strictEqual(
    catalog.identity_commitment.scope,
    'ordered_full_task_metadata_release_policy_and_predecessor',
  );
  strictEqual(
    catalog.identity_commitment.digest,
    catalogIdentityDigest(catalog.tasks, catalog.release_gate_policy, catalog.predecessor_catalog),
  );
  strictEqual(catalog.identity_commitment.digest, AIQ_CORE_V1_CATALOG_IDENTITY_SHA256);
  strictEqual(
    catalogIdentityDigest(
      catalog.tasks,
      {
        ...catalog.release_gate_policy,
        predeclared_contrasts: catalog.release_gate_policy.predeclared_contrasts.toReversed(),
      },
      catalog.predecessor_catalog,
    ) === catalog.identity_commitment.digest,
    false,
  );

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

await test('the current catalog binds the redesigned task and scorer release 1.0.2', () => {
  const catalog = buildCatalog();

  strictEqual(catalog.task_set_version, '1.0.2');
  for (const task of catalog.tasks) {
    strictEqual(task.task_version, '1.0.2', task.task_id);
    strictEqual(task.evaluator.scorer_version, '1.0.2', task.task_id);
    strictEqual(
      task.input_contract.content_handle,
      `aiq-controlled-task://aiq-core/1.0.2/${task.task_id}`,
      task.task_id,
    );
  }

  const first = catalog.tasks[0];
  if (first === undefined) {
    throw new Error('Catalog must contain a task.');
  }
  throws(
    () => assertCatalogInvariants(replaceFirstTask(catalog, { ...first, task_version: '1.0.0' })),
    /current AIQ Core catalog requires/,
  );
});

await test('provisional difficulty labels do not determine execution budgets', () => {
  const tasks = new Map(buildCatalog().tasks.map((task) => [task.task_id, task]));
  strictEqual(tasks.get('coding-01')?.difficulty, 'easy');
  strictEqual(tasks.get('coding-02')?.difficulty, 'medium');
  strictEqual(tasks.get('coding-07')?.difficulty, 'hard');
  deepStrictEqual(tasks.get('coding-01')?.budget, tasks.get('coding-02')?.budget);
  deepStrictEqual(tasks.get('coding-02')?.budget, tasks.get('coding-07')?.budget);
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

  strictEqual(catalog.status, 'candidate_requires_controlled_release_gate');
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
    'partial_low',
    'partial_high',
    'near_miss',
    'paired_contrast',
    'adversarial_format',
    'empty',
    'timeout',
  ];

  for (const task of catalog.tasks) {
    deepStrictEqual(Object.keys(task.evaluator.acceptance_fixture_commitments), expectedClasses);
    strictEqual(task.evaluator.execution_protocol, 'aiq.evaluator-protocol.v1');
    strictEqual(task.evaluator.binding_requirement, 'controlled_hidden_task_required');
    strictEqual(task.provenance.origin, 'calibration_driven_redesign');
    strictEqual(task.provenance.predecessor_task_version, '1.0.1');
    strictEqual(task.leakage_review.status, 'public_design_versioned_private_content_required');
    strictEqual(task.leakage_review.notes.includes(task.task_id), true);
    strictEqual(
      task.leakage_review.notes.includes('pass the deterministic corpus tests before a real run.'),
      true,
    );
    strictEqual(/^[a-z_]+-cluster-[0-9]{2}$/u.test(task.cluster_id), true);
  }
});

await test('all 72 designs declare a material 1.0.2 middle-discrimination revision', () => {
  const catalog = buildCatalog();
  const revisionCounts = new Map<string, number>();
  const taskSpecificDeltas = new Set<string>();

  strictEqual(catalog.distribution.difficulty_role.includes('provisional, non-ordinal'), true);
  deepStrictEqual(catalog.predecessor_catalog, PREDECESSOR_CATALOG);
  for (const task of catalog.tasks) {
    revisionCounts.set(
      task.design_revision.kind,
      (revisionCounts.get(task.design_revision.kind) ?? 0) + 1,
    );
    strictEqual(task.design_revision.supersedes_task_version, '1.0.1', task.task_id);
    strictEqual(task.design_revision.controlled_corpus_requirements.length, 4, task.task_id);
    strictEqual(
      task.design_revision.task_specific_delta.includes(
        requireValue(task.evaluator.pass_conditions[0], 'Task must have a first pass condition.'),
      ),
      true,
    );
    taskSpecificDeltas.add(task.design_revision.task_specific_delta);
    strictEqual(task.summary.includes('deterministic partial credit'), true, task.task_id);
    strictEqual(task.evaluator.scoring_contract.components.length, 4, task.task_id);
    strictEqual(
      task.evaluator.scoring_contract.components.reduce(
        (sum, component) => sum + component.weight_basis_points,
        0,
      ),
      10_000,
      task.task_id,
    );
    strictEqual(task.evaluator.pass_conditions.length >= 4, true, task.task_id);
  }

  deepStrictEqual(Object.fromEntries(revisionCounts), {
    retargeted: 27,
    rebalanced: 25,
    replacement: 20,
  });
  strictEqual(taskSpecificDeltas.size, 72);
});

await test('the preregistered release policy gates identity without claiming evidence', () => {
  const catalog = buildCatalog();
  const passingEvidence = buildReleaseEvidence();

  deepStrictEqual(catalog.release_gate_policy, RELEASE_GATE_POLICY);
  strictEqual(catalog.release_gate_policy.state, 'preregistered_not_evaluated');
  deepStrictEqual(evaluateReleaseGate(passingEvidence), { passed: true, failures: [] });

  for (const invalidEvidence of [
    { ...passingEvidence, catalog_identity_digest: `sha256:${'f'.repeat(64)}` },
    { ...passingEvidence, corpus_commitment_digest: 'missing' },
    { ...passingEvidence, model_matrix_digest: `sha256:${'f'.repeat(64)}` },
    { ...passingEvidence, repeat_ids: ['repeat-1', 'repeat-1', 'repeat-3'] },
    { ...passingEvidence, source_observations_digest: `sha256:${'f'.repeat(64)}` },
    { ...passingEvidence, raw_cells: passingEvidence.raw_cells.slice(1) },
  ] as const) {
    strictEqual(evaluateReleaseGate(invalidEvidence).failures.includes('invalid_evidence'), true);
  }
  const authority = buildReleaseAuthority();
  const firstAuthorityBinding = requireValue(
    authority.contrast_bindings[0],
    'Authority must contain the first contrast binding.',
  );
  for (const invalidAuthority of [
    { ...authority, catalog_identity_digest: `sha256:${'f'.repeat(64)}` },
    { ...authority, corpus_commitment_digest: `sha256:${'f'.repeat(64)}` },
    { ...authority, model_matrix_digest: `sha256:${'f'.repeat(64)}` },
    {
      ...authority,
      contrast_bindings: authority.contrast_bindings.map((binding, index) =>
        index === 1
          ? {
              contrast_id: binding.contrast_id,
              challenge_variant_digest: binding.challenge_variant_digest,
              reference_variant_digest: firstAuthorityBinding.reference_variant_digest,
            }
          : binding,
      ),
    },
  ] as const) {
    strictEqual(
      evaluateReleaseGateWithAuthority(passingEvidence, invalidAuthority).failures.includes(
        'invalid_evidence',
      ),
      true,
    );
  }

  const infrastructureCells = passingEvidence.raw_cells.map((cell, index) =>
    index === 0 ? { ...cell, status: 'infrastructure_failure' as const, score: null } : cell,
  );
  strictEqual(
    evaluateReleaseGate(replaceRawCells(passingEvidence, infrastructureCells)).failures.includes(
      'infrastructure_failures',
    ),
    true,
  );
  const evaluatorCells = passingEvidence.raw_cells.map((cell, index) =>
    index === 0 ? { ...cell, status: 'evaluator_failure' as const, score: null } : cell,
  );
  strictEqual(
    evaluateReleaseGate(replaceRawCells(passingEvidence, evaluatorCells)).failures.includes(
      'evaluator_failures',
    ),
    true,
  );

  const insufficientContrasts = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, index) =>
      index === 0
        ? {
            ...contrast,
            pairs: contrast.pairs.map((pair) => ({ ...pair, challenge_score: 0.429 })),
          }
        : contrast,
    ),
  );
  strictEqual(
    evaluateReleaseGate(insufficientContrasts).failures.includes('paired_contrasts'),
    true,
  );
  const uncertainContrast = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, contrastIndex) =>
      contrastIndex === 0
        ? {
            ...contrast,
            pairs: contrast.pairs.map((pair, pairIndex) => ({
              ...pair,
              challenge_score: pairIndex % 2 === 0 ? 0.6 : 0.26,
            })),
          }
        : contrast,
    ),
  );
  strictEqual(evaluateReleaseGate(uncertainContrast).failures.includes('paired_contrasts'), true);
  const zeroLowerBound = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, index) =>
      index === 0 ? { ...contrast, pairs: contrastPairsAtLowerBound(contrast.pairs, 3) } : contrast,
    ),
  );
  strictEqual(evaluateReleaseGate(zeroLowerBound).failures.includes('paired_contrasts'), true);
  const positiveLowerBound = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, index) =>
      index === 0
        ? { ...contrast, pairs: contrastPairsAtLowerBound(contrast.pairs, 3.000_001) }
        : contrast,
    ),
  );
  strictEqual(evaluateReleaseGate(positiveLowerBound).failures.includes('paired_contrasts'), false);
  strictEqual(
    evaluateReleaseGate(
      replacePairedContrasts(passingEvidence, [
        requireValue(passingEvidence.paired_contrasts[0], 'First contrast is required.'),
        requireValue(passingEvidence.paired_contrasts[0], 'First contrast is required.'),
        requireValue(passingEvidence.paired_contrasts[2], 'Third contrast is required.'),
      ]),
    ).failures.includes('paired_contrasts'),
    true,
  );

  const unstableEvidence = buildReleaseEvidence(
    new Map(
      catalog.tasks.map(({ task_id: taskId }) => [
        taskId,
        { mean: 0.5, model_step: 0.006, repeat_step: 0.051 },
      ]),
    ),
  );
  const unstableResult = evaluateReleaseGate(unstableEvidence);
  strictEqual(unstableResult.failures.includes('stability_aggregate_sd'), true);
  strictEqual(unstableResult.failures.includes('stability_cell_range'), true);

  const exactSdEvidence = buildReleaseEvidence(
    new Map(
      catalog.tasks.map(({ task_id: taskId }) => [
        taskId,
        { mean: 0.5, model_step: 0.02, repeat_step: 0.02 },
      ]),
    ),
  );
  strictEqual(
    evaluateReleaseGate(exactSdEvidence).failures.includes('stability_aggregate_sd'),
    false,
  );
  const exactRangeEvidence = buildReleaseEvidence(
    new Map(
      catalog.tasks.map(({ task_id: taskId }) => [
        taskId,
        { mean: 0.5, model_step: 0.04, repeat_step: 0.05 },
      ]),
    ),
  );
  strictEqual(
    evaluateReleaseGate(exactRangeEvidence).failures.includes('stability_cell_range'),
    false,
  );

  const antiReliableCells = passingEvidence.raw_cells.map((cell) =>
    cell.repeat_id === 'repeat-2' && cell.score !== null
      ? { ...cell, score: 1 - cell.score }
      : cell,
  );
  strictEqual(
    evaluateReleaseGate(replaceRawCells(passingEvidence, antiReliableCells)).failures.includes(
      'stability_icc',
    ),
    true,
  );

  const modelOffsets = Array.from({ length: 17 }, (_, index) => (index - 8) * 0.006);
  const targetVariance =
    (catalog.tasks.length * modelOffsets.reduce((sum, value) => sum + value ** 2, 0)) /
    (catalog.tasks.length * modelOffsets.length - 1);
  const repeatStepAtIccBoundary = Math.sqrt(targetVariance / 3);
  const iccBoundaryProfiles = new Map(
    catalog.tasks.map(({ task_id: taskId }) => [
      taskId,
      { mean: 0.5, model_step: 0.006, repeat_step: repeatStepAtIccBoundary },
    ]),
  );
  strictEqual(
    evaluateReleaseGate(buildReleaseEvidence(iccBoundaryProfiles)).failures.includes(
      'stability_icc',
    ),
    false,
  );
  const belowIccProfiles = new Map(
    [...iccBoundaryProfiles].map(([taskId, profile]) => [
      taskId,
      { ...profile, repeat_step: repeatStepAtIccBoundary * 1.001 },
    ]),
  );
  strictEqual(
    evaluateReleaseGate(buildReleaseEvidence(belowIccProfiles)).failures.includes('stability_icc'),
    true,
  );

  const twoRepeatEvidence = buildReleaseEvidence(new Map(), ['repeat-1', 'repeat-2']);
  strictEqual(evaluateReleaseGate(twoRepeatEvidence).failures.includes('stability_repeats'), true);

  const invalidScoreCells = passingEvidence.raw_cells.map((cell, index) =>
    index === 0 ? { ...cell, score: Number.NaN } : cell,
  );
  strictEqual(
    evaluateReleaseGate({
      ...passingEvidence,
      source_observations_digest: releaseEvidenceSourceDigest(
        invalidScoreCells,
        passingEvidence.paired_contrasts,
      ),
      raw_cells: invalidScoreCells,
    }).failures.includes('invalid_evidence'),
    true,
  );
});

await test('release thresholds accept exact task-count limits and reject one-step violations', () => {
  const catalog = buildCatalog();
  const tasksByDomain = DOMAINS.map((domain) =>
    catalog.tasks.filter((task) => task.domain === domain),
  );
  const floorIds = new Set(
    tasksByDomain
      .slice(0, 7)
      .map((tasks) => requireValue(tasks[0], 'Each domain must have a first task.').task_id),
  );
  const ceilingIds = new Set(
    tasksByDomain
      .slice(3)
      .map((tasks) => requireValue(tasks[1], 'Each domain must have a second task.').task_id),
  );
  const midIds = new Set<string>();
  for (const tasks of tasksByDomain) {
    for (const task of tasks) {
      if (!floorIds.has(task.task_id) && !ceilingIds.has(task.task_id) && midIds.size < 43) {
        midIds.add(task.task_id);
      }
    }
  }
  for (const tasks of tasksByDomain) {
    const required = Math.ceil(tasks.length / 2);
    const present = tasks.filter((task) => midIds.has(task.task_id)).length;
    for (const task of tasks) {
      if (
        tasks.filter((candidate) => midIds.has(candidate.task_id)).length >= required ||
        floorIds.has(task.task_id) ||
        ceilingIds.has(task.task_id)
      ) {
        continue;
      }
      midIds.add(task.task_id);
    }
    strictEqual(tasks.filter((task) => midIds.has(task.task_id)).length >= present, true);
  }
  while (midIds.size > 43) {
    const removable = [...midIds].find((taskId) => {
      const task = requireValue(
        catalog.tasks.find((candidate) => candidate.task_id === taskId),
        'Mid-band task must exist in the catalog.',
      );
      const domainTasks = requireValue(
        tasksByDomain[DOMAINS.indexOf(task.domain)],
        'Task domain must have a task list.',
      );
      return (
        domainTasks.filter((candidate) => midIds.has(candidate.task_id)).length >
        Math.ceil(domainTasks.length / 2)
      );
    });
    if (removable === undefined) break;
    midIds.delete(removable);
  }
  strictEqual(midIds.size, 43);

  const invariantIds = new Set([...midIds].slice(0, 14));
  const profiles = new Map<string, ScoreProfile>();
  for (const task of catalog.tasks) {
    const meanScore = floorIds.has(task.task_id)
      ? 0.1
      : ceilingIds.has(task.task_id)
        ? 0.9
        : midIds.has(task.task_id)
          ? 0.5
          : 0.15;
    profiles.set(task.task_id, {
      mean: meanScore,
      model_step: invariantIds.has(task.task_id) ? 0.0025 : 0.006,
      repeat_step: 0.005,
    });
  }
  const boundaryEvidence = buildReleaseEvidence(profiles);
  deepStrictEqual(evaluateReleaseGate(boundaryEvidence), { passed: true, failures: [] });

  const firstGapId = requireValue(
    catalog.tasks.find(
      (task) =>
        !floorIds.has(task.task_id) && !ceilingIds.has(task.task_id) && !midIds.has(task.task_id),
    ),
    'Boundary fixture requires a gap task.',
  ).task_id;
  const firstNonInvariantMid = requireValue(
    [...midIds].find((taskId) => !invariantIds.has(taskId)),
    'Boundary fixture requires a non-invariant mid-band task.',
  );
  for (const [failure, taskId, profile] of [
    ['floor_tasks', firstGapId, { mean: 0.1 }],
    ['ceiling_tasks', firstGapId, { mean: 0.9 }],
    ['mid_band_tasks', firstNonInvariantMid, { mean: 0.15 }],
    [
      'invariant_tasks',
      firstNonInvariantMid,
      { mean: 0.5, model_step: 0.0025, repeat_step: 0.005 },
    ],
  ] as const) {
    const changedProfiles = new Map(profiles);
    changedProfiles.set(taskId, profile);
    strictEqual(
      evaluateReleaseGate(buildReleaseEvidence(changedProfiles)).failures.includes(failure),
      true,
      failure,
    );
  }
});

await test('release domain-share limits cover 6-, 7-, and 8-task domains', () => {
  const catalog = buildCatalog();
  for (const domain of ['instruction_following', 'repository_understanding', 'coding'] as const) {
    const domainTasks = catalog.tasks.filter((task) => task.domain === domain);
    const maximumExtreme = Math.floor(domainTasks.length * 0.3);
    const minimumMid = Math.ceil(domainTasks.length * 0.5);
    for (const [score, label] of [
      [0.1, 'floor'],
      [0.9, 'ceiling'],
    ] as const) {
      const allowedProfiles = new Map<string, ScoreProfile>();
      for (const task of domainTasks.slice(0, maximumExtreme)) {
        allowedProfiles.set(task.task_id, { mean: score });
      }
      strictEqual(
        evaluateReleaseGate(buildReleaseEvidence(allowedProfiles)).failures.includes(
          `domain_${label}:${domain}`,
        ),
        false,
      );
      allowedProfiles.set(
        requireValue(domainTasks[maximumExtreme], 'Domain must contain the boundary task.').task_id,
        { mean: score },
      );
      strictEqual(
        evaluateReleaseGate(buildReleaseEvidence(allowedProfiles)).failures.includes(
          `domain_${label}:${domain}`,
        ),
        true,
      );
    }
    const exactMid = new Map<string, ScoreProfile>();
    for (const task of domainTasks) exactMid.set(task.task_id, { mean: 0.15 });
    for (const task of domainTasks.slice(0, minimumMid)) {
      exactMid.set(task.task_id, { mean: 0.5 });
    }
    strictEqual(
      evaluateReleaseGate(buildReleaseEvidence(exactMid)).failures.includes(
        `domain_mid_band:${domain}`,
      ),
      false,
    );
    const insufficientMid = new Map<string, ScoreProfile>();
    for (const task of domainTasks) {
      insufficientMid.set(task.task_id, { mean: 0.15 });
    }
    for (const task of domainTasks.slice(0, minimumMid - 1)) {
      insufficientMid.set(task.task_id, { mean: 0.5 });
    }
    strictEqual(
      evaluateReleaseGate(buildReleaseEvidence(insufficientMid)).failures.includes(
        `domain_mid_band:${domain}`,
      ),
      true,
    );
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

await test('catalog schema rejects repeated contrasts, repeated components, and wrong weights', async () => {
  const schema = parseJsonObject(await readFile('benchmarks/schema/catalog.schema.json', 'utf8'));
  const catalog = buildCatalog();

  const repeatedContrast = catalogJson(catalog);
  const contrastList = arrayProperty(
    objectProperty(repeatedContrast, 'release_gate_policy'),
    'predeclared_contrasts',
  );
  contrastList[1] = structuredClone(contrastList[0]);
  strictEqual(matchesSchema(repeatedContrast, schema, schema), false);

  const repeatedComponent = catalogJson(catalog);
  const firstTask = arrayProperty(repeatedComponent, 'tasks')[0];
  if (!isJsonObject(firstTask)) throw new TypeError('First task must be an object.');
  const components = arrayProperty(
    objectProperty(objectProperty(firstTask, 'evaluator'), 'scoring_contract'),
    'components',
  );
  components[1] = structuredClone(components[0]);
  strictEqual(matchesSchema(repeatedComponent, schema, schema), false);

  const wrongWeight = catalogJson(catalog);
  const weightedTask = arrayProperty(wrongWeight, 'tasks')[0];
  if (!isJsonObject(weightedTask)) throw new TypeError('First task must be an object.');
  const weightedComponents = arrayProperty(
    objectProperty(objectProperty(weightedTask, 'evaluator'), 'scoring_contract'),
    'components',
  );
  const weightedComponent = weightedComponents[0];
  if (!isJsonObject(weightedComponent)) throw new TypeError('Component must be an object.');
  weightedComponent.weight_basis_points = 2999;
  strictEqual(matchesSchema(wrongWeight, schema, schema), false);
});

await test('release evidence schema accepts raw cells and rejects aggregate or identity shortcuts', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-evidence.schema.json', 'utf8'),
  );
  const evidence = buildReleaseEvidence();
  strictEqual(matchesSchema(evidence, schema, schema), true);
  strictEqual('tasks' in evidence, false);
  strictEqual('stability' in evidence, false);
  strictEqual('infrastructure_failures' in evidence, false);

  for (const invalid of [
    { ...evidence, catalog_identity_digest: `sha256:${'f'.repeat(64)}` },
    { ...evidence, repeat_ids: ['repeat-1', 'repeat-1', 'repeat-3'] },
    { ...evidence, raw_cells: evidence.raw_cells.slice(1) },
    {
      ...evidence,
      paired_contrasts: [
        requireValue(evidence.paired_contrasts[0], 'First contrast is required.'),
        requireValue(evidence.paired_contrasts[0], 'First contrast is required.'),
        requireValue(evidence.paired_contrasts[2], 'Third contrast is required.'),
      ],
    },
  ]) {
    strictEqual(matchesSchema(invalid, schema, schema), false);
  }
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
        content_handle: `aiq-controlled-task://other/1.0.2/${first.task_id}`,
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
            handle: `aiq-acceptance://${first.task_id}/v2/golden`,
          },
        },
      },
    },
  ];

  for (const task of invalidTasks) {
    strictEqual(matchesSchema(replaceFirstTask(source, task), schema, schema), false);
  }
});

await test('generated catalog byte-matches the checked-in artifact', async () => {
  const published = await readFile('benchmarks/catalog/aiq-core-v1.json', 'utf8');
  strictEqual(published, `${JSON.stringify(buildCatalog(), undefined, 2)}\n`);
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
    'aiq-controlled-fixture://aiq-core/1.0.2/coding-1',
    'aiq-controlled-fixture://other/1.0.2/coding-01',
    'aiq-controlled-acceptance://aiq-core/1.0.1/coding-01',
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
