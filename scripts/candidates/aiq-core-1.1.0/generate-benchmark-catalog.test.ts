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
const predecessorUndisclosedReceiptFields = [] as const;
const requiredCommand = 'node bin/task-tool.mjs';
const requiredCommandSha256 =
  'sha256:6763cc80f8294b52c6494f1c9891e41a8e3cd1c466ca622377c59643a0466319';
const requiredInvocations = {
  'tool-use-01': 1,
  'tool-use-02': 1,
  'tool-use-03': 1,
  'tool-use-04': 1,
  'tool-use-05': 1,
  'tool-use-06': 1,
  'tool-use-07': 1,
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
  BEHAVIORAL_COVERAGE_GAP: 7,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 0,
  HIDDEN_OUTPUT_SCHEMA: 0,
  KEYWORD_ONLY_EVALUATOR: 0,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7,
  PUBLIC_SEMANTIC_CONTAMINATION: 0,
  TOOL_EVIDENCE_UNBOUND: 7,
} as const;
const mechanisms = {
  BEHAVIORAL_COVERAGE_GAP: 'executable_transition_and_invariant_coverage',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'public_private_receipt_contract_alignment',
  TOOL_EVIDENCE_UNBOUND: 'runner_event_and_content_receipt_binding',
} as const;
const falsifiers = {
  BEHAVIORAL_COVERAGE_GAP: 'remove_one_claimed_transition_or_error_path',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'change_private_receipt_contract_only',
  TOOL_EVIDENCE_UNBOUND: 'remove_runner_evidence_or_break_receipt_digest_binding',
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
  const contract = jsonObject(firstTool.candidate_4_contract, 'candidate.4 contract');
  const receipt = jsonObject(contract.receipt_contract, 'receipt contract');
  mutate(receipt);
  throws(() => parseDecisionManifest(clone), /receipt contract|fields are invalid/u);
}

await test('the generated candidate.4 public source is deterministic', async () => {
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
    'aiq-core/1.1.0-candidate.4',
  );
});

await test('candidate.3 is exact rejected non-sealable predecessor evidence', async () => {
  const manifest = await decisions();

  deepStrictEqual(manifest.predecessor_candidate, {
    candidate_id: 'aiq-core/1.1.0-candidate.3',
    disposition: 'rejected_nonsealable_predecessor_evidence',
    merge_commit: '613a0eb896a83fb46fa94bcca61d41228126c632',
    change_commit: '4f5c09be7aeb7e1e9e74e3417f943649af2265e2',
    source_tree: 'f16cb16b499fbf942ad0b62344d6146a366fa4bf',
    aggregate_review_sha256:
      'sha256:1fcb289cd97d17ce8bed1cb9ec14c2fa3167c56159c180d293b62593dec02bd2',
    review_receipt_raw_sha256:
      'sha256:000c7d54e67eef9145d3032edb71d80f90a496ba93f98f0d549e451b52a34974',
    skeptical_counterexample_sha256:
      'sha256:7d6cc76b149529e2aab7f1c751d84815aa3b044ef4c5ddbab760c7d5c236f903',
    catalog_sha256: 'sha256:706718b614c503ac6efafe564834f41a46df78809e12198f3eb2002202c08dbf',
    accepted_tasks: 65,
    rejected_tasks: 7,
    semantic_retention_rule: 'only_review_approved_tasks_may_retain_candidate_3_semantics',
  });
  deepStrictEqual(manifest.immutable_rejected_predecessors, [
    'aiq-core/1.1.0-candidate.1',
    'aiq-core/1.1.0-candidate.2',
    'aiq-core/1.1.0-candidate.3',
  ]);
  deepStrictEqual(manifest.retained_candidate_2_issue_closures, {
    candidate_id: 'aiq-core/1.1.0-candidate.2',
    successor_candidate_id: 'aiq-core/1.1.0-candidate.3',
    disposition: 'valid_immutable_predecessor_closures',
    closure_entries: 14,
    issue_code_counts: {
      HIDDEN_OUTPUT_SCHEMA: 7,
      PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7,
    },
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
      decision.candidate_3_review.verdict === 'approved',
    );
    strictEqual(
      decision.decision === 'retained',
      decision.candidate_3_review.issue_codes.length === 0,
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

await test('every task has one candidate.4 binding and one unique within-domain cluster', async () => {
  const manifest = await decisions();
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');

  assertDecisionManifest(manifest, taskIds());
  strictEqual(new Set(manifest.decisions.map((decision) => decision.cluster_id)).size, 72);
  strictEqual(
    new Set(manifest.decisions.map((decision) => decision.candidate_4_contract.construct_id)).size,
    72,
  );
  for (const [index, task] of tasks.entries()) {
    const decision = requiredAt(manifest.decisions, index, 'task decision');
    const design = jsonObject(task.design_revision, 'design revision');
    const contract = decision.candidate_4_contract.response_contract;
    strictEqual(task.task_id, decision.task_id);
    strictEqual(task.cluster_id, decision.cluster_id);
    strictEqual(/^[a-z_]+-cluster-[0-9]{2}$/u.test(decision.cluster_id), true);
    strictEqual(design.supersedes_candidate_id, 'aiq-core/1.1.0-candidate.3');
    strictEqual(design.supersedes_task_version, '1.1.0');
    deepStrictEqual(design.candidate_3_review, decision.candidate_3_review);
    deepStrictEqual(design.candidate_4_contract, decision.candidate_4_contract);
    strictEqual(decision.candidate_4_contract.construct_id.includes('candidate2'), false);
    if (decision.decision === 'retained') {
      strictEqual(
        decision.candidate_4_contract.mechanism_classes.includes(
          'candidate_3_approved_semantic_retention',
        ),
        true,
      );
      strictEqual(
        decision.candidate_4_contract.mechanism_classes.includes(
          'candidate_4_catalog_source_rebinding',
        ),
        true,
      );
    }
    strictEqual(contract.locations.length > 0, true);
    for (const field of [...contract.required_fields, ...contract.optional_fields]) {
      strictEqual(typeof contract.field_semantics[field], 'string');
      strictEqual(typeof contract.field_types[field], 'string');
    }
  }
});

await test('the fourteen candidate.2 closures remain and all twenty-one candidate.3 closures are exact', async () => {
  const manifest = await decisions();

  deepStrictEqual(manifest.issue_code_counts, issueCounts);
  strictEqual(
    manifest.decisions.reduce(
      (count, decision) => count + decision.candidate_3_review.issue_codes.length,
      0,
    ),
    21,
  );
  strictEqual(
    manifest.decisions.reduce(
      (count, decision) => count + decision.candidate_2_review.issue_codes.length,
      0,
    ),
    14,
  );
  strictEqual(
    manifest.decisions.filter((decision) =>
      decision.candidate_2_review.issue_codes.includes('HIDDEN_OUTPUT_SCHEMA'),
    ).length,
    7,
  );
  strictEqual(
    manifest.decisions.filter((decision) =>
      decision.candidate_2_review.issue_codes.includes('PUBLIC_PRIVATE_CONSTRUCT_MISMATCH'),
    ).length,
    7,
  );
  for (const issueCode of reviewIssueCodes) {
    const affected = manifest.decisions.filter((decision) =>
      decision.candidate_3_review.issue_codes.includes(issueCode),
    );
    strictEqual(affected.length, issueCounts[issueCode]);
    if (issueCounts[issueCode] === 0) continue;
    const mechanism = Object.entries(mechanisms).find(([code]) => code === issueCode)?.[1];
    const falsifier = Object.entries(falsifiers).find(([code]) => code === issueCode)?.[1];

    if (mechanism === undefined || falsifier === undefined) {
      throw new TypeError(`unsupported candidate.4 issue code ${issueCode}`);
    }
    for (const decision of affected) {
      strictEqual(decision.candidate_4_contract.mechanism_classes.includes(mechanism), true);
      strictEqual(decision.candidate_4_contract.falsifiers.includes(falsifier), true);
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
      decision.candidate_4_contract.receipt_contract,
      `${taskId} receipt contract`,
    );
    deepStrictEqual(receipt.required_fields, receiptFields);
    deepStrictEqual(receipt.optional_fields, []);
    deepStrictEqual(receipt.predecessor_undisclosed_fields, predecessorUndisclosedReceiptFields);
    strictEqual(receipt.schema_version, 'aiq.tool-receipt-contract.v2');
    strictEqual(receipt.location, 'receipt.json');
    strictEqual(receipt.transport, 'workspace_file');
    strictEqual(receipt.producer, 'supplied_local_tool');
    strictEqual(receipt.additional_fields, 'forbidden');
    strictEqual(receipt.key_order, 'not_significant');
    strictEqual(receipt.required_invocations, requiredInvocations[taskId]);
    strictEqual(receipt.required_command, requiredCommand);
    strictEqual(receipt.required_command_sha256, requiredCommandSha256);
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
    strictEqual(String(semantics.tool_contract_id).includes('candidate.4'), true);
    const runner = jsonObject(receipt.runner_binding, 'runner binding');
    deepStrictEqual(runner.automatic_fields, [
      'steps',
      'total_calls',
      'by_tool.command_execution',
      'completed_command_sha256',
    ]);
    deepStrictEqual(runner.receipt_fields_automatic, []);
    strictEqual(runner.transport, 'evaluator_input.tool_evidence');
    strictEqual(runner.producer, 'runner');
    deepStrictEqual(receipt.tool_evidence_requirements, {
      exact_total_calls: 1,
      exact_calls_by_tool: { command_execution: 1 },
      required_completed_command_sha256: { [requiredCommandSha256]: 1 },
    });
    strictEqual(
      jsonObject(receipt.canonicalization, 'receipt canonicalization').command_sha256,
      'raw_file_bytes',
    );
    const catalogTask = jsonObject(catalogTasks.get(taskId), `${taskId} catalog task`);
    deepStrictEqual(
      jsonObject(catalogTask.design_revision, 'design revision').candidate_4_contract,
      decision.candidate_4_contract,
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
    receipt.required_command = 'substituted';
  });
  expectInvalidReceiptMutation(manifest, (receipt) => {
    receipt.required_command_sha256 = `sha256:${'0'.repeat(64)}`;
  });
  expectInvalidReceiptMutation(manifest, (receipt) => {
    const requirements = jsonObject(
      receipt.tool_evidence_requirements,
      'tool evidence requirements',
    );
    requirements.exact_total_calls = 2;
  });
  expectInvalidReceiptMutation(manifest, (receipt) => {
    const requirements = jsonObject(
      receipt.tool_evidence_requirements,
      'tool evidence requirements',
    );
    jsonObject(requirements.required_completed_command_sha256, 'required digest')[
      requiredCommandSha256
    ] = 2;
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

await test('candidate schemas bind candidate.4 identity and complete receipt contracts', async () => {
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
  strictEqual(serialized.includes('candidate_3_review'), true);
  strictEqual(serialized.includes('candidate_4_contract'), true);
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
