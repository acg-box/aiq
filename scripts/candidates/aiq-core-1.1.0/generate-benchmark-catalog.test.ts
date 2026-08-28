import { createHash } from 'node:crypto';
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
const requiredCommand = 'node bin/task-tool.mjs';
const requiredCommandSha256 =
  'sha256:6763cc80f8294b52c6494f1c9891e41a8e3cd1c466ca622377c59643a0466319';
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
const predecessorReviewIssueCounts = {
  ACCEPTANCE_SEMANTICS_INVALID: 0,
  BEHAVIORAL_COVERAGE_GAP: 7,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 7,
  HIDDEN_OUTPUT_SCHEMA: 0,
  KEYWORD_ONLY_EVALUATOR: 0,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 7,
  PUBLIC_SEMANTIC_CONTAMINATION: 0,
  TOOL_EVIDENCE_UNBOUND: 0,
} as const;
const issueCounts = {
  ACCEPTANCE_SEMANTICS_INVALID: 0,
  BEHAVIORAL_COVERAGE_GAP: 7,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 7,
  HIDDEN_OUTPUT_SCHEMA: 7,
  KEYWORD_ONLY_EVALUATOR: 0,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 14,
  PUBLIC_SEMANTIC_CONTAMINATION: 0,
  TOOL_EVIDENCE_UNBOUND: 7,
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
  return value.map(String);
}

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new TypeError(`${label} is missing.`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(',')}}`;
  }
  throw new TypeError('unsupported canonical value');
}

function digestValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
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
  const contract = jsonObject(firstTool.candidate_5_contract, 'candidate.5 contract');
  const receipt = jsonObject(contract.receipt_contract, 'receipt contract');
  mutate(receipt);
  throws(() => parseDecisionManifest(clone), /receipt contract|fields are invalid/u);
}

await test('the generated candidate.5 public source is deterministic', async () => {
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
    'aiq-core/1.1.0-candidate.5',
  );
});

await test('candidate.4 is exact rejected non-sealable predecessor evidence', async () => {
  const manifest = await decisions();
  deepStrictEqual(manifest.predecessor_candidate, {
    candidate_id: 'aiq-core/1.1.0-candidate.4',
    disposition: 'rejected_nonsealable_predecessor_evidence',
    merge_commit: '3f724e35da8a507f8ee9110ead57e156b9cd3016',
    change_commit: '500560fe21273d4131b875cd246f5bab4ee9b4c0',
    source_tree: 'ede70e65dac52df779cee84cf1d8053d76e7f7bc',
    aggregate_review_sha256:
      'sha256:83d561c43323c1b6e4f9236571e8cf8b940980c950f0047543a3ef52a1bca777',
    review_receipt_raw_sha256:
      'sha256:a8bbeea77d72cd782ec48aed6a759ecad61740c17d72c1af81f6bf612ef9bca2',
    authoring_receipt_raw_sha256:
      'sha256:6a45401fab0e0a34a3823417fceb0952d81fedc0839c38f9dd4a2dc7464c72f8',
    construct_counterexample_sha256:
      'sha256:267e7240bf45e1a12f7112bd3469f3146ecf2dd7c0be6844c9b87b0a01d06281',
    catalog_sha256: 'sha256:6b42c7e2719ddf1019801dfe72ff66d1f453e98275cdd8468839400b8fcda1f2',
    accepted_tasks: 65,
    rejected_tasks: 7,
    semantic_retention_rule: 'only_review_approved_tasks_may_retain_candidate_4_semantics',
  });
  deepStrictEqual(manifest.immutable_rejected_predecessors, [
    'aiq-core/1.1.0-candidate.1',
    'aiq-core/1.1.0-candidate.2',
    'aiq-core/1.1.0-candidate.3',
    'aiq-core/1.1.0-candidate.4',
  ]);
  deepStrictEqual(manifest.retained_candidate_4_issue_closures, {
    candidate_id: 'aiq-core/1.1.0-candidate.4',
    successor_candidate_id: 'aiq-core/1.1.0-candidate.5',
    disposition: 'preserved_and_revalidated_predecessor_closures',
    closure_entries: 35,
    verified_at_predecessor_review: 21,
    reopened_at_predecessor_review: 14,
    issue_code_counts: {
      BEHAVIORAL_COVERAGE_GAP: 7,
      HIDDEN_OUTPUT_SCHEMA: 7,
      PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 14,
      TOOL_EVIDENCE_UNBOUND: 7,
    },
  });
});

await test('all exact candidate.4 review records aggregate to the bound predecessor review', async () => {
  const manifest = await decisions();
  const entries = manifest.decisions
    .map((decision) => ({
      path: `${decision.task_id}.json`,
      sha256: decision.candidate_4_review.record_sha256,
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const approved = manifest.decisions.filter(
    (decision) => decision.candidate_4_review.verdict === 'approved',
  );
  const rejected = manifest.decisions.filter(
    (decision) => decision.candidate_4_review.verdict === 'rejected',
  );
  strictEqual(entries.length, 72);
  strictEqual(new Set(entries.map((entry) => entry.sha256)).size, 72);
  strictEqual(approved.length, 65);
  deepStrictEqual(
    rejected.map((decision) => decision.task_id).toSorted(),
    revisedTaskIds.toSorted(),
  );
  strictEqual(
    digestValue({ schema_version: 'aiq.controlled-tree.v1', entries }),
    manifest.predecessor_candidate.aggregate_review_sha256,
  );
  for (const decision of manifest.decisions) {
    strictEqual(
      decision.decision === 'retained',
      decision.candidate_4_review.verdict === 'approved',
    );
    strictEqual(
      decision.decision === 'retained',
      decision.candidate_4_review.issue_codes.length === 0,
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

await test('every task has one candidate.5 binding and one unique within-domain cluster', async () => {
  const manifest = await decisions();
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');
  assertDecisionManifest(manifest, taskIds());
  strictEqual(new Set(manifest.decisions.map((decision) => decision.cluster_id)).size, 72);
  strictEqual(
    new Set(manifest.decisions.map((decision) => decision.candidate_5_contract.construct_id)).size,
    72,
  );
  for (const [index, task] of tasks.entries()) {
    const decision = requiredAt(manifest.decisions, index, 'task decision');
    const design = jsonObject(task.design_revision, 'design revision');
    strictEqual(task.task_id, decision.task_id);
    strictEqual(task.cluster_id, decision.cluster_id);
    strictEqual(/^[a-z_]+-cluster-[0-9]{2}$/u.test(decision.cluster_id), true);
    strictEqual(design.supersedes_candidate_id, 'aiq-core/1.1.0-candidate.4');
    deepStrictEqual(design.candidate_4_review, decision.candidate_4_review);
    deepStrictEqual(design.candidate_5_contract, decision.candidate_5_contract);
    if (decision.decision === 'retained') {
      deepStrictEqual(
        decision.candidate_5_contract.response_contract,
        decision.candidate_4_contract.response_contract,
      );
      deepStrictEqual(
        decision.candidate_5_contract.receipt_contract,
        decision.candidate_4_contract.receipt_contract,
      );
      strictEqual(
        decision.candidate_5_contract.mechanism_classes.includes(
          'candidate_4_approved_semantic_retention',
        ),
        true,
      );
    }
  }
});

await test('the 35 predecessor closures plus seven new cross-task closures total exactly 42', async () => {
  const manifest = await decisions();
  deepStrictEqual(manifest.issue_code_counts, issueCounts);
  deepStrictEqual(manifest.predecessor_review_issue_code_counts, predecessorReviewIssueCounts);
  strictEqual(
    manifest.decisions.reduce(
      (count, decision) => count + decision.candidate_4_review.issue_codes.length,
      0,
    ),
    21,
  );
  strictEqual(manifest.retained_candidate_4_issue_closures.closure_entries, 35);
  strictEqual(predecessorReviewIssueCounts.CROSS_TASK_CONSTRUCT_DUPLICATION, 7);
  strictEqual(
    manifest.retained_candidate_4_issue_closures.closure_entries +
      predecessorReviewIssueCounts.CROSS_TASK_CONSTRUCT_DUPLICATION,
    42,
  );
  for (const issueCode of reviewIssueCodes) {
    strictEqual(
      manifest.decisions.filter((decision) =>
        decision.candidate_4_review.issue_codes.includes(issueCode),
      ).length,
      predecessorReviewIssueCounts[issueCode],
    );
  }
});

await test('the seven revised constructs disclose distinct behavior contracts', async () => {
  const manifest = await decisions();
  const revised = manifest.decisions.filter((decision) => decision.decision === 'revised');
  const inputKinds = new Set<string>();
  const evaluatorKinds = new Set<string>();
  const shapeKinds = new Set<string>();
  const operationIds = new Set<string>();
  const behaviorSignatures = new Set<string>();
  const scenarioFieldShapes = new Set<string>();
  const resultFieldShapes = new Set<string>();
  for (const decision of revised) {
    const revision = decision.public_task_revision;
    const contract = decision.candidate_5_contract;
    if (
      revision === null ||
      contract.scenario_contract === null ||
      contract.operation_contract === null ||
      contract.semantic_result_contract === null
    ) {
      throw new TypeError(`${decision.task_id} revised contract is missing.`);
    }
    const taskSpecificFields = stringArray(
      contract.scenario_contract.task_specific_fields,
      'task-specific fields',
    );
    const consumes = stringArray(contract.operation_contract.consumes, 'operation consumes');
    const produces = stringArray(contract.operation_contract.produces, 'operation produces');
    const resultFields = stringArray(
      contract.semantic_result_contract.required_fields,
      'semantic result fields',
    );
    const signature = jsonObject(
      contract.operation_contract.behavior_signature,
      'behavior signature',
    );
    deepStrictEqual(consumes, taskSpecificFields);
    deepStrictEqual(produces, resultFields);
    deepStrictEqual(signature.metamorphic_basis, taskSpecificFields);
    strictEqual(taskSpecificFields.length >= 4, true);
    strictEqual(resultFields.length >= 5, true);
    strictEqual(revision.pass_conditions.includes(`Invoke exactly ${requiredCommand} once.`), true);
    strictEqual(
      revision.pass_conditions.some((condition) =>
        condition.includes(taskSpecificFields.join(', ')),
      ),
      true,
    );
    inputKinds.add(revision.input_contract_kind);
    evaluatorKinds.add(revision.evaluator_kind);
    shapeKinds.add(contract.response_contract.shape_kind);
    operationIds.add(String(contract.operation_contract.operation_id));
    behaviorSignatures.add(canonicalJson(signature));
    scenarioFieldShapes.add(canonicalJson(taskSpecificFields));
    resultFieldShapes.add(canonicalJson(resultFields));
  }
  strictEqual(revised.length, 7);
  for (const values of [
    inputKinds,
    evaluatorKinds,
    shapeKinds,
    operationIds,
    behaviorSignatures,
    scenarioFieldShapes,
    resultFieldShapes,
  ]) {
    strictEqual(values.size, 7);
  }
});

await test('all seven public tool contracts retain the complete receipt and command binding', async () => {
  const manifest = await decisions();
  const catalogTasks = new Map(
    objectArray(buildCatalog().tasks, 'candidate tasks').map((task) => [task.task_id, task]),
  );
  for (const taskId of revisedTaskIds) {
    const decision = manifest.decisions.find((candidate) => candidate.task_id === taskId);
    if (decision === undefined) throw new TypeError(`${taskId} decision is missing.`);
    const receipt = jsonObject(
      decision.candidate_5_contract.receipt_contract,
      `${taskId} receipt contract`,
    );
    deepStrictEqual(receipt.required_fields, receiptFields);
    deepStrictEqual(receipt.optional_fields, []);
    deepStrictEqual(receipt.predecessor_undisclosed_fields, []);
    strictEqual(receipt.schema_version, 'aiq.tool-receipt-contract.v2');
    strictEqual(receipt.location, 'receipt.json');
    strictEqual(receipt.transport, 'workspace_file');
    strictEqual(receipt.producer, 'supplied_local_tool');
    strictEqual(receipt.additional_fields, 'forbidden');
    strictEqual(receipt.key_order, 'not_significant');
    strictEqual(receipt.required_invocations, 1);
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
    strictEqual(String(semantics.tool_contract_id).includes('candidate.5'), true);
    const runner = jsonObject(receipt.runner_binding, 'runner binding');
    deepStrictEqual(runner.automatic_fields, [
      'steps',
      'total_calls',
      'by_tool.command_execution',
      'completed_command_sha256',
    ]);
    deepStrictEqual(receipt.tool_evidence_requirements, {
      exact_total_calls: 1,
      exact_calls_by_tool: { command_execution: 1 },
      required_completed_command_sha256: { [requiredCommandSha256]: 1 },
    });
    const catalogTask = jsonObject(catalogTasks.get(taskId), `${taskId} catalog task`);
    deepStrictEqual(
      jsonObject(catalogTask.design_revision, 'design revision').candidate_5_contract,
      decision.candidate_5_contract,
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
      jsonObject(receipt.field_types, 'field types')[field] =
        field === 'invocation_count' ? 'string' : 'integer';
    });
  }
  for (const mutate of [
    (receipt: JsonObject) => {
      receipt.producer = 'runner';
    },
    (receipt: JsonObject) => {
      jsonObject(receipt.field_producers, 'field producers').command_sha256 = 'runner';
    },
    (receipt: JsonObject) => {
      receipt.transport = 'final_response';
    },
    (receipt: JsonObject) => {
      jsonObject(receipt.canonicalization, 'canonicalization').output_sha256 = 'raw_file_bytes';
    },
    (receipt: JsonObject) => {
      receipt.required_command = 'substituted';
    },
    (receipt: JsonObject) => {
      receipt.required_command_sha256 = `sha256:${'0'.repeat(64)}`;
    },
    (receipt: JsonObject) => {
      jsonObject(receipt.tool_evidence_requirements, 'tool requirements').exact_total_calls = 2;
    },
    (receipt: JsonObject) => {
      receipt.unannounced_secret_field = 'forbidden';
    },
  ]) {
    expectInvalidReceiptMutation(manifest, mutate);
  }
});

await test('scenario, operation, and semantic-result contract drift fails closed', async () => {
  const manifest = await decisions();
  const clone = structuredClone(manifest);
  const decision = clone.decisions.find((candidate) => candidate.task_id === 'tool-use-01');
  if (
    decision === undefined ||
    decision.candidate_5_contract.scenario_contract === null ||
    decision.candidate_5_contract.operation_contract === null
  ) {
    throw new TypeError('tool-use-01 candidate.5 contract is missing.');
  }
  const scenario = decision.candidate_5_contract.scenario_contract as JsonObject;
  scenario.task_specific_fields = stringArray(
    scenario.task_specific_fields,
    'task-specific fields',
  ).slice(1);
  throws(() => parseDecisionManifest(clone), /scenario contract|fields are invalid/u);

  const operationClone = structuredClone(manifest);
  const operationDecision = operationClone.decisions.find(
    (candidate) => candidate.task_id === 'tool-use-01',
  );
  if (
    operationDecision === undefined ||
    operationDecision.candidate_5_contract.operation_contract === null
  ) {
    throw new TypeError('tool-use-01 operation contract is missing.');
  }
  (operationDecision.candidate_5_contract.operation_contract as JsonObject).consumes = [
    'requested_path',
    'owner_map',
    'proposed_changes',
    'wrong_field',
  ];
  throws(() => buildCatalogFrom(operationClone), /ordered explicit retained\/revised decision/u);
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
  deepStrictEqual(state.predecessor_review_issue_code_counts, predecessorReviewIssueCounts);
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

await test('candidate schemas bind candidate.5 identity and behavior-specific contracts', async () => {
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
  for (const field of [
    'candidate_4_review',
    'candidate_5_contract',
    'receipt_contract',
    'scenario_contract',
    'operation_contract',
    'semantic_result_contract',
    'metamorphic_basis',
    'completed_command_sha256',
  ]) {
    strictEqual(serialized.includes(field), true, `${field} is missing from the schema`);
  }
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
