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
import {
  assertPrivateAuthoringResponseContract,
  assertSourceCounterexampleRejected,
  derivePrivateTaskResponseAuthority,
  RESPONSE_FIELD_TYPES,
} from './private-authoring-validator.ts';

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

function unknownArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
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

function taskFacingSemantics(task: JsonObject): JsonObject {
  return {
    task_id: task.task_id,
    task_version: task.task_version,
    title: task.title,
    summary: task.summary,
    input_contract: task.input_contract,
    cluster_id: task.cluster_id,
    allowed_tools: task.allowed_tools,
    budget: task.budget,
    evaluator: task.evaluator,
    tags: task.tags,
  };
}

function publicContractProjection(tasks: readonly JsonObject[]): JsonObject[] {
  return tasks.map((task) => ({
    task_facing: taskFacingSemantics(task),
    response_contract: jsonObject(
      jsonObject(
        jsonObject(task.design_revision, `${String(task.task_id)} design revision`)
          .candidate_5_contract,
        `${String(task.task_id)} candidate.5 contract`,
      ).response_contract,
      `${String(task.task_id)} response contract`,
    ),
  }));
}

function responseContract(
  manifest: CandidateDecisionManifest,
  taskId: string,
  generation = 'candidate_5_contract',
): JsonObject {
  const decision = manifest.decisions.find((candidate) => candidate.task_id === taskId);
  if (decision === undefined) throw new TypeError(`${taskId} decision is missing.`);
  return jsonObject(
    jsonObject(Reflect.get(decision, generation), `${taskId} ${generation}`).response_contract,
    `${taskId} response contract`,
  );
}

function differingResponsePaths(
  predecessor: readonly JsonObject[],
  candidate: readonly JsonObject[],
): string[] {
  const differences: string[] = [];
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (canonicalJson(left) === canonicalJson(right)) return;
    if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
      left.forEach((value, index) => visit(value, right[index], `${path}[${String(index)}]`));
      return;
    }
    if (isJsonObject(left) && isJsonObject(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].toSorted();
      for (const key of keys) visit(left[key], right[key], `${path}.${key}`);
      return;
    }
    differences.push(path);
  };
  for (const [index, current] of candidate.entries()) {
    const taskId = String(jsonObject(current.task_facing, 'task-facing projection').task_id);
    visit(predecessor[index], current, taskId);
  }
  return differences;
}

function assertCommitmentSchemaMatchesCatalog(catalog: JsonObject, schema: JsonObject): void {
  const tasks = objectArray(catalog.tasks, 'catalog tasks');
  const observedIdentity = digestValue(tasks);
  const candidateIdentity = jsonObject(catalog.candidate_identity, 'candidate identity');
  const metadataIdentity = jsonObject(catalog.task_metadata_identity, 'task metadata identity');
  const schemaIdentity = jsonObject(
    jsonObject(
      jsonObject(
        jsonObject(schema.properties, 'commitment schema properties').catalog,
        'commitment catalog schema',
      ).properties,
      'commitment catalog properties',
    ).identity_sha256,
    'commitment catalog identity',
  ).const;
  strictEqual(candidateIdentity.task_metadata_digest, observedIdentity);
  strictEqual(metadataIdentity.digest, observedIdentity);
  strictEqual(schemaIdentity, observedIdentity);
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

function runPrivateAuthoringSourceCounterexample(
  label: string,
  responseContractValue: JsonObject,
  taskBytes: string,
  expectedEvidence: string,
): string {
  const validatorUrl = new URL('./private-authoring-validator.ts', import.meta.url).href;
  const source = `
    import { assertPrivateAuthoringResponseContract } from ${JSON.stringify(validatorUrl)};
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    const value = JSON.parse(input);
    assertPrivateAuthoringResponseContract(value.response_contract, value.task_bytes, value.label);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input: JSON.stringify({
      label,
      response_contract: responseContractValue,
      task_bytes: taskBytes,
    }),
  });
  return assertSourceCounterexampleRejected(label, child, expectedEvidence);
}

const privateFixtureDigest = `sha256:${'1'.repeat(64)}`;

function digestMap(paths: readonly string[]): JsonObject {
  return Object.fromEntries(paths.map((path) => [path, privateFixtureDigest]));
}

function completeWorkspacePolicy(options: {
  readonly allowlisted_files: readonly string[];
  readonly protected_files: readonly string[];
  readonly progress_files?: readonly string[];
  readonly required_changed_from_sha256?: readonly string[];
  readonly progress_changed_from_sha256?: readonly string[];
}): JsonObject {
  return {
    check_id: 'complete_workspace_policy',
    type: 'workspace_policy',
    weight: 0,
    hard_gate: true,
    allowlisted_files: options.allowlisted_files,
    expected_file_sha256: digestMap(options.protected_files),
    ...(options.progress_files === undefined ? {} : { progress_files: options.progress_files }),
    ...(options.required_changed_from_sha256 === undefined
      ? {}
      : { required_changed_from_sha256: digestMap(options.required_changed_from_sha256) }),
    ...(options.progress_changed_from_sha256 === undefined
      ? {}
      : { progress_changed_from_sha256: digestMap(options.progress_changed_from_sha256) }),
  };
}

function privateTaskBytes(prompt: string, checks: readonly JsonObject[]): string {
  return JSON.stringify({
    prompt,
    evaluator: { external: { configuration: { checks } } },
  });
}

interface PrivateSourceCase {
  readonly task_id: string;
  readonly response_mode: 'final_response' | 'workspace';
  readonly response_locations: readonly string[];
  readonly field_types: JsonObject;
  readonly task_bytes: string;
}

const privateSourceCases: readonly PrivateSourceCase[] = [
  {
    task_id: 'coding-01',
    response_mode: 'workspace',
    response_locations: ['src/task.mjs'],
    field_types: { module_exports: 'module' },
    task_bytes: privateTaskBytes('Update src/task.mjs and leave README.md unchanged.', [
      completeWorkspacePolicy({
        allowlisted_files: ['README.md', 'src/task.mjs'],
        protected_files: ['README.md'],
        required_changed_from_sha256: ['src/task.mjs'],
        progress_files: ['src/task.mjs'],
      }),
      {
        check_id: 'readme_fixture_unchanged',
        type: 'workspace_policy',
        weight: 0,
        expected_file_sha256: digestMap(['README.md']),
      },
      {
        check_id: 'behavior',
        type: 'node_scenario',
        weight: 1,
        source: "await import('./workspace/src/task.mjs');",
      },
    ]),
  },
  {
    task_id: 'data-processing-01',
    response_mode: 'workspace',
    response_locations: ['output/audit.md', 'output/normalized.csv', 'output/report.json'],
    field_types: { completed_artifacts: 'artifact' },
    task_bytes: privateTaskBytes(
      'Write output/audit.md, output/normalized.csv, and output/report.json.',
      [
        { check_id: 'golden_csv', type: 'csv', weight: 1, path: 'output/normalized.csv' },
        { check_id: 'report', type: 'json', weight: 1, path: 'output/report.json' },
        { check_id: 'audit', type: 'text', weight: 1, path: 'output/audit.md' },
        {
          check_id: 'fixtures_unchanged',
          type: 'workspace_policy',
          weight: 0,
          expected_file_sha256: digestMap(['input/export.csv']),
        },
        completeWorkspacePolicy({
          allowlisted_files: [
            'input/export.csv',
            'output/audit.md',
            'output/normalized.csv',
            'output/report.json',
          ],
          protected_files: ['input/export.csv'],
          progress_files: ['output/audit.md', 'output/normalized.csv', 'output/report.json'],
          progress_changed_from_sha256: [],
        }),
      ],
    ),
  },
  {
    task_id: 'debugging-02',
    response_mode: 'workspace',
    response_locations: ['src/task.mjs'],
    field_types: { module_exports: 'module' },
    task_bytes: privateTaskBytes(
      'Repair src/task.mjs while preserving the supplied repository contract.',
      [
        {
          check_id: 'behavior',
          type: 'node_scenario',
          weight: 1,
          source: "await import('./workspace/src/task.mjs');",
        },
        completeWorkspacePolicy({
          allowlisted_files: [
            'README.md',
            'package.json',
            'src/select.mjs',
            'src/interpolate.mjs',
            'src/task.mjs',
            'test/contract.test.mjs',
          ],
          protected_files: ['README.md', 'package.json', 'test/contract.test.mjs'],
          progress_files: [],
          progress_changed_from_sha256: ['src/interpolate.mjs', 'src/select.mjs', 'src/task.mjs'],
        }),
      ],
    ),
  },
  {
    task_id: 'documentation-communication-02',
    response_mode: 'workspace',
    response_locations: ['README.md'],
    field_types: { documentation: 'artifact' },
    task_bytes: privateTaskBytes('Write README.md and remove obsolete notes.md.', [
      { check_id: 'runtime_named', type: 'text', weight: 1, path: 'README.md' },
      {
        check_id: 'rough_notes_removed',
        type: 'node_scenario',
        weight: 1,
        source: "assert(!existsSync('workspace/notes.md'));",
      },
      completeWorkspacePolicy({
        allowlisted_files: ['README.md', 'config/example.env', 'notes.md', 'package.json'],
        protected_files: ['config/example.env', 'package.json'],
        progress_files: ['README.md'],
        progress_changed_from_sha256: [],
      }),
    ]),
  },
  {
    task_id: 'instruction-following-01',
    response_mode: 'final_response',
    response_locations: ['final_response'],
    field_types: { answer: 'string' },
    task_bytes: privateTaskBytes('Read brief.json and return the three requested values.', [
      completeWorkspacePolicy({
        allowlisted_files: ['brief.json'],
        protected_files: ['brief.json'],
      }),
      { check_id: 'sum', type: 'response_json', weight: 1 },
      { check_id: 'difference', type: 'response_json', weight: 1 },
      { check_id: 'label', type: 'response_json', weight: 1 },
    ]),
  },
  {
    task_id: 'reliability-recovery-04',
    response_mode: 'workspace',
    response_locations: ['recovery.record', 'submission-state.ini'],
    field_types: { completed_artifacts: 'artifact' },
    task_bytes: privateTaskBytes(
      'Write recovery.record and update submission-state.ini without changing protected inputs.',
      [
        {
          check_id: 'submission_confirmed',
          type: 'text',
          weight: 1,
          path: 'submission-state.ini',
        },
        completeWorkspacePolicy({
          allowlisted_files: [
            'lookup-receipt.ini',
            'policy.md',
            'recovery.record',
            'submission-state.ini',
          ],
          protected_files: ['lookup-receipt.ini', 'policy.md'],
          progress_files: ['recovery.record'],
          progress_changed_from_sha256: ['submission-state.ini'],
        }),
      ],
    ),
  },
  {
    task_id: 'debugging-04',
    response_mode: 'workspace',
    response_locations: ['src/task.ts'],
    field_types: { module_exports: 'module' },
    task_bytes: privateTaskBytes('Repair src/task.ts and preserve the supplied fixtures.', [
      completeWorkspacePolicy({
        allowlisted_files: ['README.md', 'package.json', 'src/task.ts', 'test/contract.test.ts'],
        protected_files: ['README.md', 'package.json', 'test/contract.test.ts'],
      }),
      {
        check_id: 'behavior',
        type: 'node_scenario',
        weight: 1,
        source: "await import('./workspace/src/task.ts');",
      },
    ]),
  },
] as const;

function privateResponseContract(sourceCase: PrivateSourceCase): JsonObject {
  return {
    transport: sourceCase.response_mode,
    locations: sourceCase.response_locations,
    field_types: sourceCase.field_types,
  };
}

await test('the generated candidate.20 public source is deterministic', async () => {
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
    'aiq-core/1.1.0-candidate.20',
  );
  strictEqual(
    jsonObject(catalog.candidate_identity, 'candidate identity').task_metadata_digest,
    'sha256:3580555315d49a62b28b6947491819276dca5b261ade802f10b33808569d1708',
  );
});

await test('candidate.20 uses the exact checked-in Node, npm, and TypeScript identities', async () => {
  const rootPackage = jsonObject(
    JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')),
    'root package',
  );
  const webPackage = jsonObject(
    JSON.parse(await readFile(join(repositoryRoot, 'apps/web/package.json'), 'utf8')),
    'Web package',
  );
  const lock = jsonObject(
    JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8')),
    'package lock',
  );
  const packages = jsonObject(lock.packages, 'locked packages');
  const rootDevelopment = jsonObject(rootPackage.devDependencies, 'root development dependencies');
  const webDevelopment = jsonObject(webPackage.devDependencies, 'Web development dependencies');
  const npm = spawnSync('npm', ['--version'], { cwd: repositoryRoot, encoding: 'utf8' });

  strictEqual((await readFile(join(repositoryRoot, '.node-version'), 'utf8')).trim(), '24.18.0');
  strictEqual(process.version, 'v24.18.0');
  strictEqual(rootPackage.packageManager, 'npm@11.17.0');
  strictEqual(npm.status, 0);
  strictEqual(npm.stdout.trim(), '11.17.0');
  strictEqual(rootDevelopment.typescript, '7.0.2');
  strictEqual(webDevelopment.typescript, '5.9.3');
  strictEqual(webDevelopment['typescript-compiler-api'], 'npm:typescript@~5.9.0');
  strictEqual(jsonObject(packages['node_modules/typescript'], 'root TypeScript').version, '7.0.2');
  strictEqual(
    jsonObject(packages['apps/web/node_modules/typescript'], 'Web TypeScript').version,
    '5.9.3',
  );
  strictEqual(
    jsonObject(packages['node_modules/typescript-compiler-api'], 'compiler API alias').version,
    '5.9.3',
  );
});

await test('candidate.20 active delivery runbooks match the 1.1.0 v3 and 13-view owners', async () => {
  const rootReadme = await readFile(join(repositoryRoot, 'README.md'), 'utf8');
  const benchmarkReadme = await readFile(join(repositoryRoot, 'benchmarks/README.md'), 'utf8');
  const databaseReadme = await readFile(join(repositoryRoot, 'databases/README.md'), 'utf8');

  strictEqual(rootReadme.includes('13 canonical public view names'), true);
  strictEqual(rootReadme.includes('AIQ Core `1.1.0` v3 corpus commitment'), true);
  strictEqual(
    rootReadme.includes(
      'Official means a complete, non-synthetic 17-by-72 run with valid task-set\n`1.1.0`',
    ),
    true,
  );
  strictEqual(
    benchmarkReadme.includes('The final `aiq.corpus-commitment.v3` document will bind the `1.1.0`'),
    true,
  );
  strictEqual(databaseReadme.includes('13 canonical AIQ public view'), true);
  strictEqual(databaseReadme.includes('exposes 13 security-invoker public views'), true);
  strictEqual(rootReadme.includes('12 canonical public view names'), false);
  strictEqual(databaseReadme.includes('12 canonical public views'), false);
  strictEqual(databaseReadme.includes('12 security-invoker public views'), false);
});

await test('candidate.19 is exact rejected calibration evidence and candidate.1 through .19 stay immutable', async () => {
  const manifest = await decisions();
  deepStrictEqual(manifest.predecessor_candidate, {
    candidate_id: 'aiq-core/1.1.0-candidate.19',
    disposition: 'rejected_calibration_tool_use_domain_facility_above_policy_ceiling',
    source_commit: 'd33d92000d032957dbd14024291cc7266bee243b',
    source_tree: 'f587996b58b2b34eea5f278240d17d0c2eecd937',
    catalog_canonical_sha256:
      'sha256:7bbb59699bfde0171098a4e711c48311fae6989348057e5acce3fa87061e675e',
    catalog_entry_bindings_sha256:
      'sha256:04ec64d2250351cb861c9fdb10b9b1e2b2deef6eeb62df5d256579d564da0254',
    task_metadata_sha256: 'sha256:459e1608a51d2a35286d6480df83e69cb4395d6e1a1062aa4410c2e0fdb92105',
    public_contract_projection_sha256:
      'sha256:0a374048519db653e99f3bef5eb691cc7a5c1923aa2c21640ebbcf70aa321df5',
    task_facing_semantics_sha256:
      'sha256:36633afa4103ddb893a6aef5df07653604c7410d4ac215baca4687db93fb5e54',
    task_semantics: 'candidate_19_complete_calibration_preserved_as_rejected_evidence',
    task_issue_closure_entries: 42,
    semantic_retention_rule: 'candidate_19_preserved_immutable; only tool-use-02 response semantics advance',
  });
  deepStrictEqual(manifest.immutable_rejected_predecessors, [
    'aiq-core/1.1.0-candidate.1',
    'aiq-core/1.1.0-candidate.2',
    'aiq-core/1.1.0-candidate.3',
    'aiq-core/1.1.0-candidate.4',
    'aiq-core/1.1.0-candidate.5',
    'aiq-core/1.1.0-candidate.6',
    'aiq-core/1.1.0-candidate.7',
    'aiq-core/1.1.0-candidate.8',
    'aiq-core/1.1.0-candidate.9',
    'aiq-core/1.1.0-candidate.10',
    'aiq-core/1.1.0-candidate.11',
    'aiq-core/1.1.0-candidate.12',
    'aiq-core/1.1.0-candidate.13',
    'aiq-core/1.1.0-candidate.14',
    'aiq-core/1.1.0-candidate.15',
    'aiq-core/1.1.0-candidate.16',
    'aiq-core/1.1.0-candidate.17',
    'aiq-core/1.1.0-candidate.18',
    'aiq-core/1.1.0-candidate.19',
  ]);
});

await test('all exact candidate.4 task-review records remain bound as historical evidence', async () => {
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
    'sha256:83d561c43323c1b6e4f9236571e8cf8b940980c950f0047543a3ef52a1bca777',
  );
  for (const decision of manifest.decisions) {
    strictEqual(
      decision.predecessor_decision === 'retained',
      decision.candidate_4_review.verdict === 'approved',
    );
    strictEqual(
      decision.predecessor_decision === 'retained',
      decision.candidate_4_review.issue_codes.length === 0,
    );
    strictEqual(decision.decision, 'retained');
  }
});

await test('candidate.20 retains public tasks while preserving candidate.5 design history', async () => {
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
    counts[decision.predecessor_decision] = Number(counts[decision.predecessor_decision]) + 1;
    strictEqual(decision.decision, 'retained');
  }
  deepStrictEqual(observed, expected);
});

await test('every task has one candidate.20 identity and only tool-use-02 changes candidate.19 semantics', async () => {
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
    strictEqual(design.supersedes_candidate_id, 'aiq-core/1.1.0-candidate.19');
    strictEqual(design.decision, task.task_id === 'tool-use-02' ? 'revised' : 'retained');
    strictEqual(design.predecessor_decision, decision.predecessor_decision);
    deepStrictEqual(design.candidate_4_review, decision.candidate_4_review);
    deepStrictEqual(design.candidate_5_contract, decision.candidate_5_contract);
    if (task.task_id !== 'tool-use-02') {
      strictEqual(digestValue(taskFacingSemantics(task)), decision.candidate_5_task_facing_semantics_sha256);
    } else {
      const response = jsonObject(design.candidate_20_response_contract, 'candidate.20 response contract');
      strictEqual(response.transport, 'final_response');
      deepStrictEqual(response.locations, ['final_response']);
    }
    if (decision.predecessor_decision === 'retained') {
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
  strictEqual(
    digestValue(tasks.map(taskFacingSemantics)),
    'sha256:bfa0ac6d29c1d1d40b186df28c90a042ad24f6e205b095d5c976fadd5ce01556',
  );
  strictEqual(
    digestValue(
      manifest.decisions.map((decision) => ({
        task_id: decision.task_id,
        catalog_entry_sha256: decision.candidate_5_catalog_entry_sha256,
      })),
    ),
    'sha256:c37b87e8458209826164c48e74d0292c426be9b0c60dc18e664253a22bc7a95c',
  );
});

await test('candidate.9 to candidate.10 changes only the two rejected public contract fields', () => {
  const tasks = structuredClone(objectArray(buildCatalog().tasks, 'candidate tasks'));
  const toolUse = tasks.find((task) => task.task_id === 'tool-use-02');
  if (toolUse === undefined) throw new TypeError('tool-use-02 is missing.');
  const toolEvaluator = jsonObject(toolUse.evaluator, 'tool-use-02 evaluator');
  toolEvaluator.pass_conditions = stringArray(toolEvaluator.pass_conditions, 'tool-use-02 pass conditions').slice(0, -2);
  toolUse.tags = stringArray(toolUse.tags, 'tool-use-02 tags').slice(0, -2);
  const candidateProjection = publicContractProjection(tasks);
  const predecessorProjection = structuredClone(candidateProjection);
  const predecessorByTask = new Map(
    predecessorProjection.map((projection) => [
      String(jsonObject(projection.task_facing, 'task-facing projection').task_id),
      jsonObject(projection.response_contract, 'response contract'),
    ]),
  );
  const debugging = jsonObject(
    predecessorByTask.get('debugging-04'),
    'debugging-04 predecessor response contract',
  );
  debugging.locations = ['src/task.mjs'];
  const instruction = jsonObject(
    predecessorByTask.get('instruction-following-05'),
    'instruction-following-05 predecessor response contract',
  );
  jsonObject(instruction.field_types, 'instruction-following-05 field types').calculation_note =
    'undefined';

  strictEqual(
    digestValue(predecessorProjection),
    'sha256:f0f7063ef897b8f848d7171b298673840d0b70a8c2370f6e12924438aa1fdc59',
  );
  strictEqual(
    digestValue(candidateProjection),
    'sha256:817a113ad4bd1e823c31b093d197fe26860a00c0a7cec5c1dd7383b89256e45a',
  );
  deepStrictEqual(differingResponsePaths(predecessorProjection, candidateProjection).toSorted(), [
    'debugging-04.response_contract.locations[0]',
    'instruction-following-05.response_contract.field_types.calculation_note',
  ]);
});

await test('candidate.20 changes only tool-use-02 response and evaluator semantics from candidate.19', () => {
  const tasks = objectArray(buildCatalog().tasks, 'candidate tasks');
  const historical = structuredClone(tasks);
  const toolUse = historical.find((task) => task.task_id === 'tool-use-02');
  if (toolUse === undefined) throw new TypeError('tool-use-02 is missing.');
  const evaluator = jsonObject(toolUse.evaluator, 'tool-use-02 evaluator');
  evaluator.pass_conditions = stringArray(evaluator.pass_conditions, 'tool-use-02 pass conditions').slice(0, -2);
  toolUse.tags = stringArray(toolUse.tags, 'tool-use-02 tags').slice(0, -2);
  strictEqual(
    digestValue(publicContractProjection(historical)),
    'sha256:817a113ad4bd1e823c31b093d197fe26860a00c0a7cec5c1dd7383b89256e45a',
  );
  strictEqual(
    digestValue(
      historical.map((task) => ({
        task_id: task.task_id,
        allowed_tools: task.allowed_tools,
        evaluator: task.evaluator,
        fixture_profile: jsonObject(task.input_contract, 'input contract').fixture_profile,
        candidate_5_contract: jsonObject(task.design_revision, 'design revision')
          .candidate_5_contract,
      })),
    ),
    'sha256:869c9bf222b351ebc78aa17f94b11d1f1964b908f2b97dfbcaa15a5584ee05e5',
  );
  const debugging = jsonObject(
    jsonObject(
      jsonObject(
        tasks.find((task) => task.task_id === 'debugging-04')?.design_revision,
        'debugging-04 design revision',
      ).candidate_5_contract,
      'debugging-04 contract',
    ).response_contract,
    'debugging-04 response contract',
  );
  const instruction = jsonObject(
    jsonObject(
      jsonObject(
        tasks.find((task) => task.task_id === 'instruction-following-05')?.design_revision,
        'instruction-following-05 design revision',
      ).candidate_5_contract,
      'instruction-following-05 contract',
    ).response_contract,
    'instruction-following-05 response contract',
  );
  deepStrictEqual(debugging.locations, ['src/task.ts']);
  strictEqual(
    jsonObject(instruction.field_types, 'instruction-following-05 field types').calculation_note,
    'string',
  );
});

await test('schema-owned response types and task-owned locations reject candidate.9 mutations', async () => {
  const manifest = await decisions();
  const catalogTasks = objectArray(buildCatalog().tasks, 'candidate tasks');
  const allowed = new Set<string>(RESPONSE_FIELD_TYPES);
  for (const task of catalogTasks) {
    const design = jsonObject(task.design_revision, `${String(task.task_id)} design`);
    const contract = jsonObject(
      jsonObject(design.candidate_5_contract, `${String(task.task_id)} candidate.5 contract`)
        .response_contract,
      `${String(task.task_id)} response contract`,
    );
    for (const type of Object.values(jsonObject(contract.field_types, 'response field types'))) {
      strictEqual(allowed.has(String(type)), true, `${String(task.task_id)} uses ${String(type)}`);
    }
  }

  const locationMutation = structuredClone(manifest);
  responseContract(locationMutation, 'debugging-04').locations = ['src/task.mjs'];
  throws(
    () => buildCatalogFrom(locationMutation),
    /response locations do not match task-owned source/u,
  );

  const synchronizedLocationMutation = structuredClone(manifest);
  for (const generation of [
    'candidate_3_contract',
    'candidate_4_contract',
    'candidate_5_contract',
  ]) {
    responseContract(synchronizedLocationMutation, 'coding-01', generation).locations = [
      'README.md',
    ];
  }
  throws(
    () => buildCatalogFrom(synchronizedLocationMutation),
    /response locations do not match task-owned source/u,
  );

  const synchronizedModeMutation = structuredClone(manifest);
  for (const generation of [
    'candidate_3_contract',
    'candidate_4_contract',
    'candidate_5_contract',
  ]) {
    const contract = responseContract(
      synchronizedModeMutation,
      'instruction-following-01',
      generation,
    );
    contract.transport = 'workspace';
    contract.locations = ['result.json'];
  }
  throws(
    () => buildCatalogFrom(synchronizedModeMutation),
    /response mode does not match task-owned source/u,
  );

  const typeMutation = structuredClone(manifest);
  jsonObject(
    responseContract(typeMutation, 'instruction-following-05').field_types,
    'instruction-following-05 field types',
  ).calculation_note = 'undefined';
  throws(() => buildCatalogFrom(typeMutation), /schema-owned enum/u);
});

await test('private task bytes derive the production response shapes directly', () => {
  for (const sourceCase of privateSourceCases) {
    deepStrictEqual(
      assertPrivateAuthoringResponseContract(
        privateResponseContract(sourceCase),
        sourceCase.task_bytes,
        sourceCase.task_id,
      ),
      {
        response_mode: sourceCase.response_mode,
        response_locations: sourceCase.response_locations,
      },
    );
  }
});

await test('private response authority mutations fail closed at the byte-derived owner', () => {
  const sourceByTask = new Map(
    privateSourceCases.map((sourceCase) => [sourceCase.task_id, sourceCase]),
  );
  const requiredSource = (taskId: string): PrivateSourceCase => {
    const sourceCase = sourceByTask.get(taskId);
    if (sourceCase === undefined) throw new TypeError(`${taskId} private source case is missing.`);
    return sourceCase;
  };
  const mutateTask = (
    sourceCase: PrivateSourceCase,
    mutate: (checks: JsonObject[]) => void,
  ): string => {
    const task: unknown = JSON.parse(sourceCase.task_bytes);
    const root = jsonObject(task, `${sourceCase.task_id} private task`);
    const evaluator = jsonObject(root.evaluator, `${sourceCase.task_id} evaluator`);
    const external = jsonObject(evaluator.external, `${sourceCase.task_id} external evaluator`);
    const configuration = jsonObject(
      external.configuration,
      `${sourceCase.task_id} evaluator configuration`,
    );
    const checks = objectArray(configuration.checks, `${sourceCase.task_id} checks`);
    mutate(checks);
    configuration.checks = checks;
    return JSON.stringify(root);
  };

  const coding = requiredSource('coding-01');
  throws(
    () =>
      assertPrivateAuthoringResponseContract(
        { ...privateResponseContract(coding), locations: ['README.md'] },
        coding.task_bytes,
        'protected README response mutation',
      ),
    /response locations do not match task-owned source/u,
  );
  for (const [label, taskBytes] of [
    [
      'missing complete policy',
      mutateTask(coding, (checks) => {
        const index = checks.findIndex((check) => check.check_id === 'complete_workspace_policy');
        checks.splice(index, 1);
      }),
    ],
    [
      'duplicate complete policy',
      mutateTask(coding, (checks) => {
        const complete = checks.find((check) => check.check_id === 'complete_workspace_policy');
        if (complete === undefined) throw new TypeError('complete policy is missing');
        checks.push(structuredClone(complete));
      }),
    ],
  ] as const) {
    throws(
      () =>
        assertPrivateAuthoringResponseContract(privateResponseContract(coding), taskBytes, label),
      /exactly one complete workspace policy/u,
    );
  }
  const nonHardComplete = mutateTask(coding, (checks) => {
    const complete = checks.find((check) => check.check_id === 'complete_workspace_policy');
    if (complete === undefined) throw new TypeError('complete policy is missing');
    complete.hard_gate = false;
  });
  throws(
    () =>
      assertPrivateAuthoringResponseContract(
        privateResponseContract(coding),
        nonHardComplete,
        'non-hard complete policy',
      ),
    /complete workspace policy must be a hard gate/u,
  );

  const data = requiredSource('data-processing-01');
  const reboundTarget = mutateTask(data, (checks) => {
    const report = checks.find((check) => check.check_id === 'report');
    if (report === undefined) throw new TypeError('report check is missing');
    report.path = 'input/export.csv';
  });
  throws(
    () =>
      assertPrivateAuthoringResponseContract(
        privateResponseContract(data),
        reboundTarget,
        'protected evaluator target mutation',
      ),
    /evaluator target paths must be mutable and allowlisted/u,
  );

  const debugging = requiredSource('debugging-02');
  const protectedChangeEvidence = mutateTask(debugging, (checks) => {
    const complete = checks.find((check) => check.check_id === 'complete_workspace_policy');
    if (complete === undefined) throw new TypeError('complete policy is missing');
    complete.progress_changed_from_sha256 = digestMap(['README.md']);
  });
  throws(
    () =>
      assertPrivateAuthoringResponseContract(
        privateResponseContract(debugging),
        protectedChangeEvidence,
        'protected change-evidence mutation',
      ),
    /progress_changed_from_sha256 files must be mutable and allowlisted/u,
  );

  const finalResponse = requiredSource('instruction-following-01');
  throws(
    () =>
      assertPrivateAuthoringResponseContract(
        {
          ...privateResponseContract(finalResponse),
          transport: 'workspace',
          locations: ['result.json'],
        },
        finalResponse.task_bytes,
        'wrong final-response mode',
      ),
    /response mode does not match task-owned source/u,
  );
  throws(
    () =>
      assertPrivateAuthoringResponseContract(
        privateResponseContract(coding),
        JSON.stringify({ prompt: 'incomplete', evaluator: {} }),
        'incomplete private source',
      ),
    /external evaluator|must be an object/u,
  );
  throws(
    () => derivePrivateTaskResponseAuthority(new Uint8Array([0xff]), 'invalid UTF-8 source'),
    /UTF-8/u,
  );
});

await test('candidate.9 private counterexamples retain bounded child diagnostics', () => {
  const debugging = privateSourceCases.find((sourceCase) => sourceCase.task_id === 'debugging-04');
  if (debugging === undefined) throw new TypeError('debugging-04 private source case is missing.');
  const locationDiagnosticValue: unknown = JSON.parse(
    runPrivateAuthoringSourceCounterexample(
      'debugging-04 candidate.9 location',
      {
        ...privateResponseContract(debugging),
        locations: ['src/task.mjs'],
      },
      debugging.task_bytes,
      'response locations do not match task-owned source',
    ),
  );
  const locationDiagnostic = jsonObject(locationDiagnosticValue, 'location diagnostic');
  deepStrictEqual(
    {
      label: locationDiagnostic.label,
      child_status: locationDiagnostic.child_status,
      signal: locationDiagnostic.signal,
      error: locationDiagnostic.error,
    },
    {
      label: 'debugging-04 candidate.9 location',
      child_status: 1,
      signal: null,
      error: null,
    },
  );
  strictEqual(String(locationDiagnostic.stderr).includes('task-owned source'), true);

  const typeDiagnosticValue: unknown = JSON.parse(
    runPrivateAuthoringSourceCounterexample(
      'instruction-following-05 candidate.9 type',
      {
        ...privateResponseContract(debugging),
        field_types: { calculation_note: 'undefined' },
      },
      debugging.task_bytes,
      'schema-owned enum',
    ),
  );
  const typeDiagnostic = jsonObject(typeDiagnosticValue, 'type diagnostic');
  strictEqual(typeDiagnostic.child_status, 1);
  strictEqual(typeDiagnostic.signal, null);
  strictEqual(typeDiagnostic.error, null);
  strictEqual(String(typeDiagnostic.stderr).includes('schema-owned enum'), true);

  const boundedValue: unknown = JSON.parse(
    assertSourceCounterexampleRejected(
      'bounded diagnostic',
      { status: 1, signal: null, stdout: `expected rejection ${'x'.repeat(4_096)}`, stderr: '' },
      'expected rejection',
    ),
  );
  const bounded = jsonObject(boundedValue, 'bounded diagnostic');
  strictEqual(String(bounded.stdout).endsWith('[truncated]'), true);
  throws(
    () =>
      assertSourceCounterexampleRejected(
        'retry must not become success',
        { status: 0, signal: null, stdout: 'retry succeeded', stderr: '' },
        'rejected',
      ),
    /did not fail through its validator/u,
  );
});

await test('the 42 task closures remain distinct from all six source-only closures', async () => {
  const manifest = await decisions();
  deepStrictEqual(manifest.task_issue_code_counts, issueCounts);
  deepStrictEqual(manifest.retained_candidate_5_task_issue_closures.issue_code_counts, issueCounts);
  strictEqual(
    manifest.decisions.reduce(
      (count, decision) => count + decision.candidate_4_review.issue_codes.length,
      0,
    ),
    21,
  );
  strictEqual(manifest.retained_candidate_5_task_issue_closures.closure_entries, 42);
  strictEqual(manifest.source_integrity_closure.counts_toward_task_issue_closures, false);
  strictEqual(
    manifest.source_integrity_closure.issue_code,
    'QUALIFICATION_EVIDENCE_BRIDGE_UNAUTHENTICATED',
  );
  strictEqual(
    manifest.source_end_to_end_validation_closure.counts_toward_task_issue_closures,
    false,
  );
  deepStrictEqual(manifest.source_end_to_end_validation_closure, {
    issue_code: 'CANDIDATE_VALIDATION_CONTEXT_DROPPED_AFTER_PREPARATION',
    scope: 'completed_run_recovery_and_package_validation',
    status: 'closed_in_candidate_8',
    counts_toward_task_issue_closures: false,
    diagnosis_task_identity: '01a04b9e-903b-72d2-9819-8b0c2fde6336',
    predecessor_candidate_id: 'aiq-core/1.1.0-candidate.7',
    failure_class: 'candidate_provenance_routed_to_active_validator_after_model_work',
    repair: 'provenance_bound_in_process_validation_context',
    regression: 'candidate_completed_recovery_package_and_active_rejection_suite',
  });
  deepStrictEqual(manifest.package_input_validation_closure, {
    issue_code: 'CANDIDATE_PACKAGE_VALIDATION_AUTHORITY_DERIVED_FROM_SAVED_RUN',
    scope: 'candidate_package_input_and_signed_payload_validation',
    status: 'closed_in_candidate_9',
    counts_toward_task_issue_closures: false,
    diagnosis_task_identity: '01a04786-3f39-7852-a41b-fb57bd73dfad',
    predecessor_candidate_id: 'aiq-core/1.1.0-candidate.8',
    failure_class: 'saved_calibration_selected_its_own_candidate_validation_context',
    repair: 'independent_tasks_corpus_and_source_bound_through_package_serialization',
    regression: 'candidate_package_input_mismatch_and_current_byte_identity_suite',
  });
  deepStrictEqual(manifest.node_runtime_correction_closure, {
    issue_code: 'CANDIDATE_NODE_RUNTIME_IDENTITY_DRIFT',
    scope: 'private_authoring_build_and_readback_runtime',
    status: 'closed_in_candidate_9',
    counts_toward_task_issue_closures: false,
    diagnosis_task_identity: '01a04c55-70b2-7943-89e1-e18e78f0f9ed',
    predecessor_candidate_id: 'aiq-core/1.1.0-candidate.8',
    expected_node_version: 'v24.18.0',
    predecessor_observed_node_version: 'v24.19.0',
    repair: 'checked_in_node_version_enforced_at_private_build_and_readback',
    regression: 'candidate_private_build_and_readback_runtime_mismatch_suite',
  });
  deepStrictEqual(manifest.public_response_contract_validation_closure, {
    issue_code: 'PUBLIC_RESPONSE_CONTRACT_SOURCE_OR_SCHEMA_DRIFT',
    scope: 'catalog_response_locations_and_field_types',
    status: 'closed_in_candidate_10',
    counts_toward_task_issue_closures: false,
    predecessor_candidate_id: 'aiq-core/1.1.0-candidate.9',
    rejected_location: 'debugging-04:src/task.mjs',
    corrected_location: 'debugging-04:src/task.ts',
    rejected_field_type: 'instruction-following-05:calculation_note:undefined',
    corrected_field_type: 'instruction-following-05:calculation_note:string',
    repair: 'schema_owned_response_types_and_task_owned_source_locations',
    regression: 'generic_catalog_mutation_and_private_source_counterexample_suite',
  });
  deepStrictEqual(manifest.response_source_authority_closure, {
    issue_code: 'PRIVATE_RESPONSE_SOURCE_OWNER_MISIDENTIFIED',
    scope: 'private_authoring_response_source_derivation',
    status: 'closed_in_candidate_12',
    counts_toward_task_issue_closures: false,
    predecessor_candidate_id: 'aiq-core/1.1.0-candidate.11',
    failure_class:
      'protected_hashes_treated_as_outputs_and_final_mode_inferred_from_policy_absence',
    repair: 'derive_response_mode_and_mutable_locations_from_existing_serialized_task_owner',
    regression: 'production_shaped_private_derivation_and_real_72_task_integration',
  });
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
  const revised = manifest.decisions.filter(
    (decision) => decision.predecessor_decision === 'revised',
  );
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
  deepStrictEqual(state.semantic_decision_counts, { retained: 72, revised: 0 });
  deepStrictEqual(state.predecessor_design_decision_counts, { retained: 65, revised: 7 });
  deepStrictEqual(state.task_issue_closure_counts, issueCounts);
  strictEqual(state.predecessor_review_status, 'completed_approved_but_calibration_rejected');
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
  const staleIdentity: unknown = structuredClone(manifest);
  jsonObject(staleIdentity, 'stale candidate identity').candidate_id =
    'aiq-core/1.1.0-candidate.15';
  throws(() => parseDecisionManifest(staleIdentity), /Candidate decision manifest identity/u);
  const missing: CandidateDecisionManifest = {
    ...manifest,
    decisions: manifest.decisions.filter((_, index) => index !== 1),
  };
  throws(
    () => assertDecisionManifest(missing, ids),
    /decision-manifest authority|ordered explicit|response authority is missing or unordered/u,
  );
  const first = requiredAt(manifest.decisions, 0, 'first decision');
  const duplicated: CandidateDecisionManifest = {
    ...manifest,
    decisions: manifest.decisions.map((decision, index) => (index === 1 ? first : decision)),
  };
  throws(
    () => buildCatalogFrom(duplicated),
    /ordered explicit retained\/revised decision|response authority is missing or unordered/u,
  );
  const second = requiredAt(manifest.decisions, 1, 'second decision');
  const reordered: CandidateDecisionManifest = {
    ...manifest,
    decisions: [second, first, ...manifest.decisions.slice(2)],
  };
  throws(
    () => buildCatalogFrom(reordered),
    /ordered explicit retained\/revised decision|response authority is missing or unordered/u,
  );
});

await test('candidate schemas bind candidate.20 identity and independent source authority', async () => {
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
  const designProperties = jsonObject(designRevision.properties, 'design properties');
  const currentContract = jsonObject(
    designProperties.candidate_5_contract,
    'candidate.5 contract schema',
  );
  const currentContractProperties = jsonObject(
    currentContract.properties,
    'candidate.5 contract properties',
  );
  const responseSchema = jsonObject(
    currentContractProperties.response_contract,
    'response contract schema',
  );
  const responseProperties = jsonObject(responseSchema.properties, 'response properties');
  const fieldTypes = jsonObject(responseProperties.field_types, 'response field types schema');
  deepStrictEqual(
    jsonObject(fieldTypes.additionalProperties, 'response field type values').enum,
    RESPONSE_FIELD_TYPES,
  );
  deepStrictEqual(catalogProperties.schema_version, { const: 'aiq.catalog.v2' });
  deepStrictEqual(catalogProperties.task_set_version, { const: '1.1.0' });
  deepStrictEqual(catalogProperties.status, { const: 'frozen_candidate' });
  strictEqual(
    JSON.stringify(catalogProperties.candidate_state).includes(
      'source_end_to_end_validation_closure',
    ),
    true,
  );
  strictEqual(
    JSON.stringify(catalogProperties.candidate_state).includes('response_source_authority_closure'),
    true,
  );
  strictEqual(catalogProperties.task_response_authority !== undefined, true);
  strictEqual(
    JSON.stringify(catalogProperties.candidate_state).includes('package_input_validation_closure'),
    true,
  );
  strictEqual(
    JSON.stringify(catalogProperties.candidate_state).includes('node_runtime_correction_closure'),
    true,
  );
  strictEqual(
    JSON.stringify(catalogProperties.candidate_state).includes(
      'public_response_contract_validation_closure',
    ),
    true,
  );
  deepStrictEqual(taskProperties.task_version, { const: '1.1.0' });
  deepStrictEqual(taskProperties.scorer_version, { const: '1.0.6' });
  for (const field of [
    'candidate_4_review',
    'candidate_5_contract',
    'task_response_authority',
    'predecessor_decision',
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

await test('qualification schemas bind predeclaration to replay-verified candidate evidence', async () => {
  const schemaRoot = new URL('../../../benchmarks/schema/', import.meta.url);
  const manifest = jsonObject(
    JSON.parse(
      await readFile(
        new URL('benchmark-qualification-manifest-v3.schema.json', schemaRoot),
        'utf8',
      ),
    ),
    'qualification manifest schema',
  );
  const artifact = jsonObject(
    JSON.parse(
      await readFile(new URL('benchmark-qualification-v3.schema.json', schemaRoot), 'utf8'),
    ),
    'qualification artifact schema',
  );
  const stage = jsonObject(
    JSON.parse(
      await readFile(new URL('calibration-verified-stage-v2.schema.json', schemaRoot), 'utf8'),
    ),
    'calibration stage schema',
  );
  const manifestProperties = jsonObject(manifest.properties, 'manifest properties');
  const child = jsonObject(
    jsonObject(manifest.$defs, 'manifest definitions').predeclaredChild,
    'manifest child',
  );
  const childRequired = stringArray(child.required, 'manifest child required fields');
  const manifestDefinitions = jsonObject(manifest.$defs, 'manifest definitions');
  const candidate = jsonObject(manifestDefinitions.candidate, 'manifest candidate');
  const candidateRequired = stringArray(candidate.required, 'manifest candidate fields');
  const policy = jsonObject(manifestDefinitions.policy, 'manifest policy');
  const policyRequired = stringArray(policy.required, 'manifest policy fields');

  deepStrictEqual(manifestProperties.schema_version, {
    const: 'aiq.benchmark-qualification-manifest.v3',
  });
  strictEqual(manifestProperties.children, undefined);
  deepStrictEqual(childRequired, ['child_id', 'source_run_id', 'verifier']);
  strictEqual(childRequired.includes('source_run_digest'), false);
  strictEqual(childRequired.includes('verifier_attestation_digest'), false);
  for (const field of [
    'task_metadata_digest',
    'harness_digest',
    'prompt_digest',
    'tool_policy_digest',
    'network_policy_digest',
    'environment_digest',
  ]) {
    strictEqual(candidateRequired.includes(field), true, `${field} must be predeclared`);
  }
  deepStrictEqual(policyRequired, [
    'version',
    'required_tasks',
    'required_models',
    'required_completed_cells',
  ]);
  const requiredModels = jsonObject(manifestDefinitions.requiredModels, 'required models');
  const requiredModelItems = unknownArray(requiredModels.prefixItems, 'required model items');
  deepStrictEqual(
    requiredModelItems.map(
      (item, index) =>
        jsonObject(
          jsonObject(
            unknownArray(
              jsonObject(item, `required model ${String(index)}`).allOf,
              'model rules',
            )[1],
            'model family rule',
          ).properties,
          'model family properties',
        ).family,
    ),
    [{ const: 'sol' }, { const: 'terra' }, { const: 'luna' }],
  );
  for (const stale of [
    'required_matrices',
    'minimum_median_rank_spearman',
    'maximum_configuration_mean_shift',
    'informative_facility_min',
  ]) {
    strictEqual(jsonObject(policy.properties, 'policy properties')[stale], undefined);
  }

  const artifactProperties = jsonObject(artifact.properties, 'artifact properties');
  const claims = jsonObject(artifactProperties.claims, 'artifact claims');
  const claimProperties = jsonObject(claims.properties, 'claim properties');
  deepStrictEqual(claimProperties.method_version, {
    const: 'aiq.single-replay-verified-complete-family-matrix-qualification.v1',
  });
  deepStrictEqual(claimProperties.completed_cells, { const: 216 });
  for (const stale of [
    'matrices',
    'pairwise',
    'median_configuration_rank_spearman',
    'configurations',
    'comparison_group_method',
    'comparison_groups',
    'violations',
  ]) {
    strictEqual(claimProperties[stale], undefined, `${stale} must not remain`);
  }
  const artifactDefinitions = jsonObject(artifact.$defs, 'artifact definitions');
  const scope = jsonObject(artifactDefinitions.scope, 'artifact claim scope');
  const scopeProperties = jsonObject(scope.properties, 'artifact claim scope properties');
  const excluded = jsonObject(scopeProperties.excludes, 'excluded claims');
  deepStrictEqual(unknownArray(excluded.prefixItems, 'excluded claim items'), [
    { const: 'prediction_interval' },
    { const: 'spearman_correlation' },
    { const: 'run_variance' },
    { const: 'precise_ranking' },
  ]);
  const artifactChild = jsonObject(artifactDefinitions.child, 'artifact child');
  const artifactChildRequired = stringArray(artifactChild.required, 'artifact child fields');
  for (const field of [
    'source_package_sha256',
    'source_package_content_hash',
    'runner',
    'verifier',
    'verifier_attestation_digest',
    'run_provenance_digest',
    'matrix_digest',
  ]) {
    strictEqual(artifactChildRequired.includes(field), true, `${field} must be bound after replay`);
  }

  const stageProperties = jsonObject(stage.properties, 'stage properties');
  strictEqual(stageProperties.qualification_projection !== undefined, true);
  const stageDefinitions = jsonObject(stage.$defs, 'stage definitions');
  const projection = jsonObject(
    stageDefinitions.qualificationProjection,
    'qualification projection',
  );
  const projectionProperties = jsonObject(projection.properties, 'projection properties');
  deepStrictEqual(projectionProperties.candidate_id, {
    const: 'aiq-core/1.1.0-candidate.20',
  });
  deepStrictEqual(projectionProperties.disposition, { const: 'accepted' });
  deepStrictEqual(projectionProperties.synthetic, { const: false });
  const cells = jsonObject(projectionProperties.cells, 'projection cells');
  strictEqual(cells.minItems, 216);
  strictEqual(cells.maxItems, 216);
});

await test('catalog, commitment validator schema, and stale mutations share one identity boundary', async () => {
  const catalog = buildCatalog();
  const commitmentSchema = jsonObject(
    JSON.parse(
      await readFile(
        new URL('../../../benchmarks/schema/corpus-commitment-v3.schema.json', import.meta.url),
        'utf8',
      ),
    ),
    'commitment schema',
  );
  assertCommitmentSchemaMatchesCatalog(catalog, commitmentSchema);

  for (const staleIdentity of [
    'sha256:c5d0eae839ac6fba23b6225a61accf249e90842090bc0c108e49c99fe319ef4e',
    'sha256:e613b92fe5fc8847b883a3ea3e7acaafaf0e3cca953bdbc8f29910a1ad75654c',
    'sha256:790894c76532c7e836d547289b09de13fdcf72c356d2e5f41262d9e73d8395eb',
    'sha256:2fef66003c0d803bc834e694e7622334f3a928e5b723d00c7df116965ece28b2',
    'sha256:06995f8c1c08067a4b79a5cbba7d0d9467bf0f4234ebd50b33ea9b2b8c9fae80',
    'sha256:5380334c44bd297dc05020961bd6ae5433e840288a03b8afc02c483cc62c0a95',
    'sha256:cfac96630c9efe3153d80ed43effd6e541bef751e1e7f766a52cfb2910fa3fc4',
    'sha256:393cb2563b2161ccb42dd5a50ea63a7827f4d5c485ca0a98103e80eef3d0fbe6',
    'sha256:26b488595379ca9a7da6a44603a881431b78a6e146b536e9aa0c820272e5b147',
    'sha256:7ea2202e1ac3efee9a83a33c4323487bdb1f5d32cdf46ee4c60aaac53471c927',
  ]) {
    const staleSchema = structuredClone(commitmentSchema);
    const catalogProperties = jsonObject(
      jsonObject(jsonObject(staleSchema.properties, 'schema properties').catalog, 'catalog schema')
        .properties,
      'catalog properties',
    );
    jsonObject(catalogProperties.identity_sha256, 'catalog identity').const = staleIdentity;
    throws(
      () => assertCommitmentSchemaMatchesCatalog(catalog, staleSchema),
      /Expected values to be strictly equal/u,
    );

    const staleCatalog = structuredClone(catalog);
    jsonObject(staleCatalog.candidate_identity, 'candidate identity').task_metadata_digest =
      staleIdentity;
    throws(
      () => assertCommitmentSchemaMatchesCatalog(staleCatalog, commitmentSchema),
      /Expected values to be strictly equal/u,
    );
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
