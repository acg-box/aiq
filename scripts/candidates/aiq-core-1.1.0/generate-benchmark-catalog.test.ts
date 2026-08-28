import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  assertDecisionManifest,
  buildCatalog,
  buildCatalogFrom,
  parseDecisionManifest,
  type CandidateDecisionManifest,
} from './generate-benchmark-catalog.ts';

type JsonObject = Record<string, unknown>;

const candidateRoot = new URL('../../../benchmarks/candidates/aiq-core-1.1.0/', import.meta.url);
const repositoryRoot = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
const revisedTaskIds = [
  'tool-use-01',
  'tool-use-02',
  'tool-use-03',
  'tool-use-04',
  'tool-use-05',
  'tool-use-06',
  'tool-use-07',
] as const;
const receiptFields = [
  'schema_version',
  'task_id',
  'tool_contract_id',
  'command_sha256',
  'input_sha256',
  'output_sha256',
  'invocation_count',
  'receipt_sha256',
] as const;
const predecessorUndisclosedReceiptFields = [
  'tool_contract_id',
  'command_sha256',
  'input_sha256',
  'output_sha256',
] as const;
const requiredInvocations = {
  'tool-use-01': 1,
  'tool-use-02': 1,
  'tool-use-03': 2,
  'tool-use-04': 1,
  'tool-use-05': 2,
  'tool-use-06': 2,
  'tool-use-07': 2,
} as const;
const reviewIssueCodes = [
  'ACCEPTANCE_SEMANTICS_INVALID',
  'BEHAVIORAL_COVERAGE_GAP',
  'CROSS_TASK_CONSTRUCT_DUPLICATION',
  'HIDDEN_OUTPUT_SCHEMA',
  'KEYWORD_ONLY_EVALUATOR',
  'PUBLIC_PRIVATE_CONSTRUCT_MISMATCH',
  'PUBLIC_SEMANTIC_CONTAMINATION',
  'TOOL_EVIDENCE_UNBOUND',
] as const;
const issueCounts = {
  ACCEPTANCE_SEMANTICS_INVALID: 0,
  BEHAVIORAL_COVERAGE_GAP: 0,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 0,
  HIDDEN_OUTPUT_SCHEMA: 7,
  KEYWORD_ONLY_EVALUATOR: 0,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7,
  PUBLIC_SEMANTIC_CONTAMINATION: 0,
  TOOL_EVIDENCE_UNBOUND: 0,
} as const;
const mechanisms = {
  HIDDEN_OUTPUT_SCHEMA: 'complete_receipt_contract_disclosure',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'public_private_receipt_contract_alignment',
} as const;
const falsifiers = {
  HIDDEN_OUTPUT_SCHEMA: 'inject_receipt_field_schema_or_transport_mismatch',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'change_private_receipt_contract_only',
} as const;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((entry, index) => jsonObject(entry, `${label}[${String(index)}]`));
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${label} must be a string array.`);
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError(`${label} must be a string array.`);
    output.push(item);
  }
  return output;
}

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new TypeError(`${label} is missing.`);
  return value;
}

async function decisions(): Promise<CandidateDecisionManifest> {
  const value: unknown = JSON.parse(
    await readFile(new URL('design-decisions.json', candidateRoot), 'utf8'),
  );
  return parseDecisionManifest(value);
}

function taskIds(): string[] {
  return objectArray(buildCatalog().tasks, 'candidate tasks').map((task) => String(task.task_id));
}

function assertNoPrivatePayloadKeys(value: unknown, path = 'root'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoPrivatePayloadKeys(child, `${path}[${String(index)}]`));
    return;
  }
  if (!isJsonObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    strictEqual(
      ['prompt', 'expected_output', 'fixture_data', 'evaluator_source', 'private_path'].includes(
        key,
      ),
      false,
      `${path} contains private payload key ${key}`,
    );
    assertNoPrivatePayloadKeys(child, `${path}.${key}`);
  }
}

function expectInvalidReceiptMutation(
  manifest: CandidateDecisionManifest,
  mutate: (receipt: JsonObject) => void,
): void {
  const clone: unknown = structuredClone(manifest);
  const root = jsonObject(clone, 'manifest clone');
  const clonedDecisions = objectArray(root.decisions, 'cloned decisions');
  const firstTool = clonedDecisions.find((decision) => decision.task_id === 'tool-use-01');
  if (firstTool === undefined) throw new TypeError('tool-use-01 decision is missing.');
  const contract = jsonObject(firstTool.candidate_3_contract, 'candidate.3 contract');
  const receipt = jsonObject(contract.receipt_contract, 'receipt contract');
  mutate(receipt);
  throws(() => parseDecisionManifest(clone), /receipt contract|fields are invalid/u);
}

await test('the generated candidate.3 public source is deterministic', async () => {
  const catalog = buildCatalog();

  deepStrictEqual(
    JSON.parse(await readFile(new URL('catalog.json', candidateRoot), 'utf8')),
    catalog,
  );
  strictEqual(catalog.schema_version, 'aiq.catalog.v2');
  strictEqual(catalog.task_set_version, '1.1.0');
  strictEqual(catalog.scoring_version, '1.0.6');
  strictEqual(catalog.status, 'frozen_candidate');
  strictEqual(
    jsonObject(catalog.candidate_identity, 'candidate identity').candidate_id,
    'aiq-core/1.1.0-candidate.3',
  );
});

await test('candidate.2 is exact rejected non-sealable predecessor evidence', async () => {
  const manifest = await decisions();

  deepStrictEqual(manifest.predecessor_candidate, {
    candidate_id: 'aiq-core/1.1.0-candidate.2',
    disposition: 'rejected_nonsealable_predecessor_evidence',
    merge_commit: '1d6898012bcb4c9fbf4db2389872ae416a14c633',
    change_commit: 'a156fbcf419a66c196327271509a5d47f1680fef',
    source_tree: 'cdfa3ecc92e1095f631a54af23daff74203ab944',
    aggregate_review_sha256:
      'sha256:70dd654906bb669a5bca46c2cf7dcda59adf15ad05e5223eed5f1b0a0564a74f',
    review_receipt_raw_sha256:
      'sha256:8de2ed2dd3ff32eca9fae0faf0c7b38a3675f89e91b2024aaf008eb06f77e74a',
    catalog_sha256: 'sha256:ba8fb315938c1c4c81592956b1157af145b577673929be2987d6e8fe212186f4',
    accepted_tasks: 65,
    rejected_tasks: 7,
    semantic_retention_rule: 'only_review_approved_tasks_may_retain_candidate_2_semantics',
  });
});

await test('the predecessor review selects exactly 65 retained and seven revised tasks', async () => {
  const manifest = await decisions();
  const retained = manifest.decisions.filter((decision) => decision.decision === 'retained');
  const revised = manifest.decisions
    .filter((decision) => decision.decision === 'revised')
    .map((decision) => decision.task_id);

  strictEqual(retained.length, 65);
  deepStrictEqual(revised.toSorted(), revisedTaskIds.toSorted());
  for (const decision of manifest.decisions) {
    strictEqual(
      decision.decision === 'retained',
      decision.candidate_2_review.verdict === 'approved',
    );
    strictEqual(
      decision.decision === 'retained',
      decision.candidate_2_review.issue_codes.length === 0,
    );
  }
});

await test('retained and revised decisions preserve the exact ten-domain distribution', async () => {
  const manifest = await decisions();
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');
  const expected = {
    coding: { retained: 8, revised: 0, tasks: 8 },
    debugging: { retained: 8, revised: 0, tasks: 8 },
    repository_understanding: { retained: 7, revised: 0, tasks: 7 },
    data_processing: { retained: 8, revised: 0, tasks: 8 },
    retrieval_verification: { retained: 7, revised: 0, tasks: 7 },
    documentation_communication: { retained: 7, revised: 0, tasks: 7 },
    planning_execution: { retained: 7, revised: 0, tasks: 7 },
    tool_use: { retained: 0, revised: 7, tasks: 7 },
    instruction_following: { retained: 6, revised: 0, tasks: 6 },
    reliability_recovery: { retained: 7, revised: 0, tasks: 7 },
  } as const;
  const observed = Object.fromEntries(
    Object.keys(expected).map((domain) => [domain, { retained: 0, revised: 0, tasks: 0 }]),
  );

  for (const [index, task] of tasks.entries()) {
    const decision = requiredAt(manifest.decisions, index, 'task decision');
    const counts = jsonObject(observed[String(task.domain)], 'domain counts');
    counts.tasks = Number(counts.tasks) + 1;
    counts[decision.decision] = Number(counts[decision.decision]) + 1;
  }
  deepStrictEqual(observed, expected);
});

await test('every task has one candidate.3 binding and one unique within-domain cluster', async () => {
  const manifest = await decisions();
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');

  assertDecisionManifest(manifest, taskIds());
  strictEqual(new Set(manifest.decisions.map((decision) => decision.cluster_id)).size, 72);
  strictEqual(
    new Set(manifest.decisions.map((decision) => decision.candidate_3_contract.construct_id)).size,
    72,
  );
  for (const [index, task] of tasks.entries()) {
    const decision = requiredAt(manifest.decisions, index, 'task decision');
    const design = jsonObject(task.design_revision, 'design revision');
    const contract = decision.candidate_3_contract.response_contract;
    strictEqual(task.task_id, decision.task_id);
    strictEqual(task.cluster_id, decision.cluster_id);
    strictEqual(/^[a-z_]+-cluster-[0-9]{2}$/u.test(decision.cluster_id), true);
    strictEqual(design.supersedes_candidate_id, 'aiq-core/1.1.0-candidate.2');
    strictEqual(design.supersedes_task_version, '1.1.0');
    deepStrictEqual(design.candidate_2_review, decision.candidate_2_review);
    deepStrictEqual(design.candidate_3_contract, decision.candidate_3_contract);
    strictEqual(contract.locations.length > 0, true);
    for (const field of [...contract.required_fields, ...contract.optional_fields]) {
      strictEqual(typeof contract.field_semantics[field], 'string');
      strictEqual(typeof contract.field_types[field], 'string');
    }
  }
});

await test('all fourteen predecessor issue closures have exact mechanisms and falsifiers', async () => {
  const manifest = await decisions();

  deepStrictEqual(manifest.issue_code_counts, issueCounts);
  strictEqual(
    manifest.decisions.reduce(
      (count, decision) => count + decision.candidate_2_review.issue_codes.length,
      0,
    ),
    14,
  );
  for (const issueCode of reviewIssueCodes) {
    const affected = manifest.decisions.filter((decision) =>
      decision.candidate_2_review.issue_codes.includes(issueCode),
    );
    strictEqual(affected.length, issueCounts[issueCode]);
    if (issueCounts[issueCode] === 0) continue;
    if (issueCode !== 'HIDDEN_OUTPUT_SCHEMA' && issueCode !== 'PUBLIC_PRIVATE_CONSTRUCT_MISMATCH') {
      throw new TypeError(`unsupported candidate.3 issue code ${issueCode}`);
    }
    for (const decision of affected) {
      strictEqual(
        decision.candidate_3_contract.mechanism_classes.includes(mechanisms[issueCode]),
        true,
      );
      strictEqual(decision.candidate_3_contract.falsifiers.includes(falsifiers[issueCode]), true);
    }
  }
});

await test('all seven public tool contracts disclose the complete receipt schema and binding', async () => {
  const manifest = await decisions();
  const catalogTasks = new Map(
    objectArray(buildCatalog().tasks, 'candidate tasks').map((task) => [task.task_id, task]),
  );

  for (const taskId of revisedTaskIds) {
    const decision = manifest.decisions.find((candidate) => candidate.task_id === taskId);
    if (decision === undefined) throw new TypeError(`${taskId} decision is missing.`);
    const receipt = jsonObject(
      decision.candidate_3_contract.receipt_contract,
      `${taskId} receipt contract`,
    );
    deepStrictEqual(receipt.required_fields, receiptFields);
    deepStrictEqual(receipt.optional_fields, []);
    deepStrictEqual(receipt.predecessor_undisclosed_fields, predecessorUndisclosedReceiptFields);
    strictEqual(receipt.location, 'receipt.json');
    strictEqual(receipt.transport, 'workspace_file');
    strictEqual(receipt.producer, 'supplied_local_tool');
    strictEqual(receipt.additional_fields, 'forbidden');
    strictEqual(receipt.key_order, 'not_significant');
    strictEqual(receipt.required_invocations, requiredInvocations[taskId]);
    const types = jsonObject(receipt.field_types, 'receipt field types');
    const semantics = jsonObject(receipt.field_semantics, 'receipt field semantics');
    const producers = jsonObject(receipt.field_producers, 'receipt field producers');
    const verification = jsonObject(receipt.field_verification, 'receipt field verification');
    for (const field of receiptFields) {
      strictEqual(types[field], field === 'invocation_count' ? 'integer' : 'string');
      strictEqual(typeof semantics[field], 'string');
      strictEqual(String(semantics[field]).length >= 20, true);
      strictEqual(producers[field], 'supplied_local_tool');
      strictEqual(typeof verification[field], 'string');
    }
    const runner = jsonObject(receipt.runner_binding, 'runner binding');
    deepStrictEqual(runner.automatic_fields, ['steps', 'total_calls', 'by_tool.command_execution']);
    deepStrictEqual(runner.receipt_fields_automatic, []);
    strictEqual(runner.transport, 'evaluator_input.tool_evidence');
    strictEqual(runner.producer, 'runner');
    strictEqual(
      /sha256:[0-9a-f]{64}/u.test(JSON.stringify(receipt)),
      false,
      `${taskId} discloses a private expected digest`,
    );
    const catalogTask = jsonObject(catalogTasks.get(taskId), `${taskId} catalog task`);
    deepStrictEqual(
      jsonObject(catalogTask.design_revision, 'design revision').candidate_3_contract,
      decision.candidate_3_contract,
    );
  }
});

await test('receipt schema negatives fail for every field, type, producer, transport, digest, and extra key', async () => {
  const manifest = await decisions();

  for (const field of receiptFields) {
    expectInvalidReceiptMutation(manifest, (receipt) => {
      receipt.required_fields = stringArray(receipt.required_fields, 'required fields').filter(
        (candidate) => candidate !== field,
      );
    });
    expectInvalidReceiptMutation(manifest, (receipt) => {
      const types = jsonObject(receipt.field_types, 'field types');
      types[field] = field === 'invocation_count' ? 'string' : 'integer';
    });
  }
  expectInvalidReceiptMutation(manifest, (receipt) => {
    receipt.producer = 'runner';
  });
  expectInvalidReceiptMutation(manifest, (receipt) => {
    const producers = jsonObject(receipt.field_producers, 'field producers');
    producers.command_sha256 = 'runner';
  });
  expectInvalidReceiptMutation(manifest, (receipt) => {
    receipt.transport = 'final_response';
  });
  expectInvalidReceiptMutation(manifest, (receipt) => {
    const canonicalization = jsonObject(receipt.canonicalization, 'canonicalization');
    canonicalization.output_sha256 = 'raw_file_bytes';
  });
  expectInvalidReceiptMutation(manifest, (receipt) => {
    receipt.unannounced_secret_field = 'forbidden';
  });
});

await test('fixture authority and frozen pending lifecycle remain exact with no deadlines', () => {
  const catalog = buildCatalog();
  const tasks = objectArray(catalog.tasks, 'candidate tasks');
  const state = jsonObject(catalog.candidate_state, 'candidate state');
  const required = ['gold', 'alternate_correct', 'partial', 'adversarial_format', 'empty'];
  const forbiddenDeadlineFields = [
    'timeout_ms',
    'timeout_seconds',
    'deadline_ms',
    'deadline_seconds',
    'max_elapsed_ms',
    'max_duration_ms',
    'scenario_timeout_ms',
  ];

  deepStrictEqual(state.semantic_decision_counts, { retained: 65, revised: 7 });
  deepStrictEqual(state.issue_closure_counts, issueCounts);
  strictEqual(state.predecessor_review_status, 'complete_rejected_nonsealable');
  for (const status of [
    'independent_review_status',
    'seal_status',
    'calibration_status',
    'qualification_status',
    'release_status',
    'activation_status',
    'deployment_status',
    'production_acceptance_status',
  ]) {
    strictEqual(state[status], 'pending');
  }
  strictEqual(state.active, false);
  strictEqual(state.production_publishable, false);
  for (const task of tasks) {
    deepStrictEqual(task.budget, { wall_seconds: null, max_steps: null, max_tool_calls: null });
    const fixtures = jsonObject(
      jsonObject(task.evaluator, 'evaluator').acceptance_fixture_commitments,
      'fixtures',
    );
    for (const fixtureClass of required) {
      strictEqual(jsonObject(fixtures[fixtureClass], fixtureClass).applicability, 'required');
    }
    deepStrictEqual(fixtures.timeout, { applicability: 'not_applicable', handle: null });
    const serialized = JSON.stringify(task);
    for (const field of forbiddenDeadlineFields) strictEqual(serialized.includes(field), false);
  }
});

await test('the weighted binary task scorer formula remains exactly 1.0.6', async () => {
  const predecessor = jsonObject(
    JSON.parse(
      await readFile(
        new URL('../../../benchmarks/candidates/aiq-core-1.0.7/catalog.json', import.meta.url),
        'utf8',
      ),
    ),
    'production catalog',
  );
  const predecessorTasks = objectArray(predecessor.tasks, 'production tasks');
  const candidateTasks = objectArray(buildCatalog().tasks, 'candidate tasks');

  for (const [index, task] of candidateTasks.entries()) {
    const candidateEvaluator = jsonObject(task.evaluator, 'candidate evaluator');
    const productionEvaluator = jsonObject(
      requiredAt(predecessorTasks, index, 'production task').evaluator,
      'production evaluator',
    );
    deepStrictEqual(candidateEvaluator.scoring_contract, productionEvaluator.scoring_contract);
    strictEqual(candidateEvaluator.scorer_version, '1.0.6');
  }
});

await test('missing, duplicate, reordered, or review-incompatible decisions fail closed', async () => {
  const manifest = await decisions();
  const ids = taskIds();
  const missing: CandidateDecisionManifest = {
    ...manifest,
    decisions: manifest.decisions.filter((_, index) => index !== 1),
  };
  throws(
    () => assertDecisionManifest(missing, ids),
    /decision-manifest authority|ordered explicit/u,
  );

  const first = requiredAt(manifest.decisions, 0, 'first decision');
  const duplicated: CandidateDecisionManifest = {
    ...manifest,
    decisions: manifest.decisions.map((decision, index) => (index === 1 ? first : decision)),
  };
  throws(() => buildCatalogFrom(duplicated), /ordered explicit retained\/revised decision/u);

  const second = requiredAt(manifest.decisions, 1, 'second decision');
  const reordered: CandidateDecisionManifest = {
    ...manifest,
    decisions: [second, first, ...manifest.decisions.slice(2)],
  };
  throws(() => buildCatalogFrom(reordered), /ordered explicit retained\/revised decision/u);
});

await test('candidate schemas bind candidate.3 identity and complete receipt contracts', async () => {
  const catalogSchema = jsonObject(
    JSON.parse(await readFile(new URL('catalog.schema.json', candidateRoot), 'utf8')),
    'catalog schema',
  );
  const taskSchema = jsonObject(
    JSON.parse(await readFile(new URL('task.schema.json', candidateRoot), 'utf8')),
    'task schema',
  );
  const catalogProperties = jsonObject(catalogSchema.properties, 'catalog properties');
  const taskProperties = jsonObject(taskSchema.properties, 'task properties');
  const definitions = jsonObject(catalogSchema.$defs, 'catalog definitions');
  const taskDefinition = jsonObject(definitions.task, 'task definition');
  const taskDefinitionProperties = jsonObject(taskDefinition.properties, 'task properties');
  const designRevision = jsonObject(taskDefinitionProperties.design_revision, 'design revision');
  const serialized = JSON.stringify(designRevision);

  deepStrictEqual(catalogProperties.schema_version, { const: 'aiq.catalog.v2' });
  deepStrictEqual(catalogProperties.task_set_version, { const: '1.1.0' });
  deepStrictEqual(catalogProperties.status, { const: 'frozen_candidate' });
  deepStrictEqual(taskProperties.task_version, { const: '1.1.0' });
  deepStrictEqual(taskProperties.scorer_version, { const: '1.0.6' });
  strictEqual(serialized.includes('candidate_2_review'), true);
  strictEqual(serialized.includes('candidate_3_contract'), true);
  strictEqual(serialized.includes('receipt_contract'), true);
  strictEqual(serialized.includes('predecessor_undisclosed_fields'), true);
});

await test('tracked candidate source contains no private payload or local authoring path', async () => {
  const manifest = await decisions();
  const catalog = buildCatalog();
  assertNoPrivatePayloadKeys(manifest);
  assertNoPrivatePayloadKeys(catalog);

  const tracked = spawnSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  strictEqual(tracked.status, 0);
  const userAbsolutePrefix = ['/', 'Users', '/'].join('');
  const privateAuthoringFragment = ['.local', 'share', 'aiq', 'authoring'].join('/');
  await Promise.all(
    tracked.stdout
      .split('\0')
      .filter(Boolean)
      .map(async (path) => {
        const bytes = await readFile(join(repositoryRoot, path));
        if (bytes.includes(0)) return;
        const text = bytes.toString('utf8');
        strictEqual(text.includes(userAbsolutePrefix), false, `${path} contains a local path`);
        strictEqual(
          text.includes(privateAuthoringFragment),
          false,
          `${path} contains a private authoring path`,
        );
      }),
  );
});
