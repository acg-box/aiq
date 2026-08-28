import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
const approvedTaskIds = [
  'coding-01',
  'coding-02',
  'coding-03',
  'coding-04',
  'coding-06',
  'coding-08',
  'data-processing-01',
  'data-processing-03',
  'data-processing-06',
  'data-processing-07',
  'debugging-02',
  'debugging-04',
  'debugging-05',
  'debugging-07',
  'documentation-communication-02',
  'instruction-following-01',
  'instruction-following-05',
  'reliability-recovery-04',
  'reliability-recovery-06',
  'reliability-recovery-07',
] as const;
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
  ACCEPTANCE_SEMANTICS_INVALID: 4,
  BEHAVIORAL_COVERAGE_GAP: 5,
  CROSS_TASK_CONSTRUCT_DUPLICATION: 4,
  HIDDEN_OUTPUT_SCHEMA: 36,
  KEYWORD_ONLY_EVALUATOR: 6,
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 25,
  PUBLIC_SEMANTIC_CONTAMINATION: 3,
  TOOL_EVIDENCE_UNBOUND: 7,
} as const;
const mechanisms = {
  ACCEPTANCE_SEMANTICS_INVALID: 'class_specific_semantic_replay',
  BEHAVIORAL_COVERAGE_GAP: 'executable_transition_and_invariant_coverage',
  CROSS_TASK_CONSTRUCT_DUPLICATION: 'unique_construct_redesign',
  HIDDEN_OUTPUT_SCHEMA: 'explicit_response_contract',
  KEYWORD_ONLY_EVALUATOR: 'structured_semantic_evaluation',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'single_construct_binding',
  PUBLIC_SEMANTIC_CONTAMINATION: 'first_principles_private_regeneration',
  TOOL_EVIDENCE_UNBOUND: 'runner_event_and_content_receipt_binding',
} as const;
const falsifiers = {
  ACCEPTANCE_SEMANTICS_INVALID: 'swap_or_collapse_acceptance_class_outcomes',
  BEHAVIORAL_COVERAGE_GAP: 'remove_one_claimed_transition_or_error_path',
  CROSS_TASK_CONSTRUCT_DUPLICATION: 'force_two_tasks_to_share_one_construct_id',
  HIDDEN_OUTPUT_SCHEMA: 'inject_an_unannounced_required_field',
  KEYWORD_ONLY_EVALUATOR: 'replace_semantic_checks_with_lexical_presence',
  PUBLIC_PRIVATE_CONSTRUCT_MISMATCH: 'change_private_construct_binding_only',
  PUBLIC_SEMANTIC_CONTAMINATION: 'reinsert_a_rejected_identifier_hash',
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
  const output: JsonObject[] = [];
  for (const [index, entry] of value.entries()) {
    output.push(jsonObject(entry, `${label}[${String(index)}]`));
  }
  return output;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a string array.`);
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

await test('the generated candidate.2 public source is deterministic', async () => {
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
    'aiq-core/1.1.0-candidate.2',
  );
});

await test('candidate.1 is exact rejected non-sealable predecessor evidence', async () => {
  const manifest = await decisions();

  deepStrictEqual(manifest.predecessor_candidate, {
    candidate_id: 'aiq-core/1.1.0-candidate.1',
    disposition: 'rejected_nonsealable_superseded_evidence',
    merge_commit: 'c3358404e247be575929e65b8c557b8bfa831889',
    change_commit: '1db9431ef3696c2f377ac741aad70094803d9987',
    source_tree: 'ad6e528adfb3f22597eaa9f32b03bc71e57e34ad',
    aggregate_review_sha256:
      'sha256:4420248576150192a516be9ffe9c43a25112a58baf7c4a5519b0db6bca1dac45',
    catalog_sha256: 'sha256:a8e4f6f0f0effc1fddbfe320b2efaeaf20b9121f723a1abbeca4c7fc513563c7',
    accepted_tasks: 20,
    rejected_tasks: 52,
    semantic_retention_rule: 'only_review_approved_tasks_may_retain_candidate_1_semantics',
  });
});

await test('the review receipt selects exactly 20 semantic-retained and 52 revised tasks', async () => {
  const manifest = await decisions();
  const retained = manifest.decisions
    .filter((decision) => decision.decision === 'retained')
    .map((decision) => decision.task_id);
  const revised = manifest.decisions.filter((decision) => decision.decision === 'revised');

  deepStrictEqual(retained.toSorted(), approvedTaskIds.toSorted());
  strictEqual(revised.length, 52);
  for (const decision of manifest.decisions) {
    strictEqual(
      decision.decision === 'retained',
      decision.candidate_1_review.verdict === 'approved',
    );
    strictEqual(
      decision.decision === 'retained',
      decision.candidate_1_review.issue_codes.length === 0,
    );
  }
});

await test('retained and revised decisions preserve the exact ten-domain distribution', async () => {
  const manifest = await decisions();
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');
  const expected = {
    coding: { retained: 6, revised: 2, tasks: 8 },
    debugging: { retained: 4, revised: 4, tasks: 8 },
    repository_understanding: { retained: 0, revised: 7, tasks: 7 },
    data_processing: { retained: 4, revised: 4, tasks: 8 },
    retrieval_verification: { retained: 0, revised: 7, tasks: 7 },
    documentation_communication: { retained: 1, revised: 6, tasks: 7 },
    planning_execution: { retained: 0, revised: 7, tasks: 7 },
    tool_use: { retained: 0, revised: 7, tasks: 7 },
    instruction_following: { retained: 2, revised: 4, tasks: 6 },
    reliability_recovery: { retained: 3, revised: 4, tasks: 7 },
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

await test('every task has one candidate.2 binding, structural contract, and honest unique cluster', async () => {
  const manifest = await decisions();
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');

  assertDecisionManifest(manifest, taskIds());
  strictEqual(new Set(manifest.decisions.map((decision) => decision.cluster_id)).size, 72);
  strictEqual(
    new Set(manifest.decisions.map((decision) => decision.candidate_2_contract.construct_id)).size,
    72,
  );
  for (const [index, task] of tasks.entries()) {
    const decision = requiredAt(manifest.decisions, index, 'task decision');
    const design = jsonObject(task.design_revision, 'design revision');
    const contract = decision.candidate_2_contract.response_contract;
    strictEqual(task.task_id, decision.task_id);
    strictEqual(task.cluster_id, decision.cluster_id);
    strictEqual(/^[a-z_]+-cluster-[0-9]{2}$/u.test(decision.cluster_id), true);
    for (const tag of stringArray(task.tags, 'task tags')) {
      strictEqual(/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(tag), true);
    }
    strictEqual(design.supersedes_candidate_id, 'aiq-core/1.1.0-candidate.1');
    deepStrictEqual(design.candidate_1_review, decision.candidate_1_review);
    deepStrictEqual(design.candidate_2_contract, decision.candidate_2_contract);
    strictEqual(contract.locations.length > 0, true);
    strictEqual(contract.required_fields.length > 0, true);
    for (const location of contract.locations) {
      strictEqual(location.startsWith('/'), false);
      strictEqual(location.split('/').includes('..'), false);
    }
    for (const field of [...contract.required_fields, ...contract.optional_fields]) {
      strictEqual(typeof contract.field_semantics[field], 'string');
    }
  }
});

await test('all rejected issue codes have complete mechanisms and independent falsifiers', async () => {
  const manifest = await decisions();

  deepStrictEqual(manifest.issue_code_counts, issueCounts);
  for (const issueCode of reviewIssueCodes) {
    const expectedCount = issueCounts[issueCode];
    const affected = manifest.decisions.filter((decision) =>
      decision.candidate_1_review.issue_codes.includes(issueCode),
    );
    strictEqual(affected.length, expectedCount);
    for (const decision of affected) {
      strictEqual(
        decision.candidate_2_contract.mechanism_classes.includes(mechanisms[issueCode]),
        true,
      );
      strictEqual(decision.candidate_2_contract.falsifiers.includes(falsifiers[issueCode]), true);
    }
  }
});

await test('synthetic negatives fail every remediation-class contract', async () => {
  const manifest = await decisions();
  const ids = taskIds();

  for (const issueCode of reviewIssueCodes) {
    const clone: unknown = structuredClone(manifest);
    const root = jsonObject(clone, 'manifest clone');
    const clonedDecisions = objectArray(root.decisions, 'cloned decisions');
    const target = clonedDecisions.find((decision) =>
      stringArray(
        jsonObject(decision.candidate_1_review, 'review').issue_codes,
        'issue codes',
      ).includes(issueCode),
    );
    if (target === undefined) throw new TypeError(`missing task for ${issueCode}`);
    const contract = jsonObject(target.candidate_2_contract, 'candidate.2 contract');

    if (issueCode === 'HIDDEN_OUTPUT_SCHEMA') {
      const response = jsonObject(contract.response_contract, 'response contract');
      const fields = stringArray(response.required_fields, 'required fields');
      Reflect.set(response, 'required_fields', [...fields, 'unannounced_secret_field']);
    } else if (
      issueCode === 'PUBLIC_PRIVATE_CONSTRUCT_MISMATCH' ||
      issueCode === 'CROSS_TASK_CONSTRUCT_DUPLICATION'
    ) {
      const first = jsonObject(requiredAt(clonedDecisions, 0, 'first decision'), 'first decision');
      const firstContract = jsonObject(first.candidate_2_contract, 'first contract');
      Reflect.set(contract, 'construct_id', firstContract.construct_id);
    } else if (issueCode === 'BEHAVIORAL_COVERAGE_GAP') {
      Reflect.set(contract, 'coverage_claims', []);
    } else if (issueCode === 'ACCEPTANCE_SEMANTICS_INVALID') {
      const fixture = jsonObject(contract.fixture_applicability, 'fixture applicability');
      Reflect.set(fixture, 'partial', 'not_applicable');
    } else if (issueCode === 'TOOL_EVIDENCE_UNBOUND' || issueCode === 'KEYWORD_ONLY_EVALUATOR') {
      const values = stringArray(contract.mechanism_classes, 'mechanism classes');
      Reflect.set(
        contract,
        'mechanism_classes',
        values.filter((value) => value !== mechanisms[issueCode]),
      );
    } else {
      const values = stringArray(contract.falsifiers, 'falsifiers');
      Reflect.set(
        contract,
        'falsifiers',
        values.filter((value) => value !== falsifiers[issueCode]),
      );
    }

    throws(
      () => assertDecisionManifest(parseDecisionManifest(clone), ids),
      /decision-manifest authority|ordered explicit retained\/revised decision/u,
    );
  }
});

await test('fixture authority is exact and natural completion has no deadlines', () => {
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

  deepStrictEqual(state.semantic_decision_counts, { retained: 20, revised: 52 });
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
    deepStrictEqual(task.budget, {
      wall_seconds: null,
      max_steps: null,
      max_tool_calls: null,
    });
    const evaluator = jsonObject(task.evaluator, 'evaluator');
    const fixtures = jsonObject(evaluator.acceptance_fixture_commitments, 'fixtures');
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
    'predecessor catalog',
  );
  const predecessorTasks = objectArray(predecessor.tasks, 'predecessor tasks');
  const candidateTasks = objectArray(buildCatalog().tasks, 'candidate tasks');

  for (const [index, task] of candidateTasks.entries()) {
    const candidateEvaluator = jsonObject(task.evaluator, 'candidate evaluator');
    const predecessorEvaluator = jsonObject(
      requiredAt(predecessorTasks, index, 'predecessor task').evaluator,
      'predecessor evaluator',
    );
    deepStrictEqual(candidateEvaluator.scoring_contract, predecessorEvaluator.scoring_contract);
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

await test('candidate schemas bind candidate.2 identity and public remediation contracts', async () => {
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
  const designRevision = jsonObject(
    taskDefinitionProperties.design_revision,
    'design revision schema',
  );

  deepStrictEqual(catalogProperties.schema_version, { const: 'aiq.catalog.v2' });
  deepStrictEqual(catalogProperties.task_set_version, { const: '1.1.0' });
  deepStrictEqual(catalogProperties.status, { const: 'frozen_candidate' });
  deepStrictEqual(taskProperties.task_version, { const: '1.1.0' });
  deepStrictEqual(taskProperties.scorer_version, { const: '1.0.6' });
  strictEqual(JSON.stringify(designRevision).includes('candidate_1_review'), true);
  strictEqual(JSON.stringify(designRevision).includes('candidate_2_contract'), true);
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
        strictEqual(
          text.includes(userAbsolutePrefix),
          false,
          `${path} contains a local absolute path`,
        );
        strictEqual(
          text.includes(privateAuthoringFragment),
          false,
          `${path} contains a private authoring path`,
        );
      }),
  );
});
