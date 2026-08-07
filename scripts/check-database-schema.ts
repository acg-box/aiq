import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const privateTableCount = 40;
const publicViewCount = 12;
const hardenedGatewayRoleCount = 2;
const evidencePrivateTables = [
  'efficiency_pricing_methods',
  'efficiency_official_models',
  'calibration_verification_stages',
  'calibration_runs',
  'aiq_publication_storage_evidence',
  'calibration_model_scores',
  'calibration_task_results',
  'calibration_verification_audit',
  'calibration_publications',
] as const;
const corePublicViews = [
  'public_distributed_radar',
  'public_leaderboard',
  'public_model_matrix',
  'public_nodes',
  'public_run_results',
  'public_runs',
  'public_scoring_versions',
  'public_task_coverage',
] as const;
const evidencePublicViews = [
  'public_calibration_runs',
  'public_model_efficiency',
  'public_calibration_results',
  'public_calibration_scores',
] as const;
const publicViews = [...corePublicViews, ...evidencePublicViews] as const;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Expected a JSON object.');
  }
  return value;
}

function unknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a JSON array.');
  return Array.from(value, (item: unknown) => item);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function checkSecurityDefinerSearchPaths(schema: string): void {
  const starts = [...schema.matchAll(/^create function /gm)].map(({ index }) => index);
  assert.ok(starts.length >= 114, 'The schema function inventory is incomplete.');
  for (const [position, start] of starts.entries()) {
    const end = starts[position + 1] ?? schema.length;
    const definition = schema.slice(start, end);
    if (/security\s+definer/i.test(definition)) {
      assert.match(
        definition,
        /set search_path to ''/i,
        'Each security-definer function must set an empty search path.',
      );
    }
  }
}

function sqlSection(schema: string, start: string, endMarkers: readonly string[]): string {
  const startIndex = schema.indexOf(start);
  assert.notEqual(startIndex, -1, `The schema is missing ${start}.`);
  const endIndexes = endMarkers
    .map((marker) => schema.indexOf(marker, startIndex + start.length))
    .filter((index) => index >= 0);
  const endIndex = endIndexes.length > 0 ? Math.min(...endIndexes) : schema.length;
  return schema.slice(startIndex, endIndex);
}

function checkActivePublicReadVersionFilters(schema: string): void {
  const coreViewEnd = ['\n--\n-- Name:'];
  const calibrationViewEnd = [
    '\nCREATE VIEW public.',
    '\nalter table aiq_private.calibration_runs',
  ];
  const sections = new Map([
    [
      'public_leaderboard',
      sqlSection(schema, 'create view public.public_leaderboard', coreViewEnd),
    ],
    [
      'public_run_results',
      sqlSection(schema, 'create view public.public_run_results', coreViewEnd),
    ],
    ['public_runs', sqlSection(schema, 'create view public.public_runs', coreViewEnd)],
    [
      'public_scoring_versions',
      sqlSection(schema, 'create view public.public_scoring_versions', coreViewEnd),
    ],
    [
      'public_task_coverage',
      sqlSection(schema, 'create view public.public_task_coverage', coreViewEnd),
    ],
    [
      'public_trend_points',
      sqlSection(schema, 'create function public.public_trend_points', coreViewEnd),
    ],
    [
      'public_calibration_runs',
      sqlSection(schema, 'CREATE VIEW public.public_calibration_runs', calibrationViewEnd),
    ],
    [
      'public_calibration_results',
      sqlSection(schema, 'CREATE VIEW public.public_calibration_results', calibrationViewEnd),
    ],
    [
      'public_calibration_scores',
      sqlSection(schema, 'CREATE VIEW public.public_calibration_scores', calibrationViewEnd),
    ],
    [
      'public_model_efficiency',
      sqlSection(schema, 'CREATE VIEW public.public_model_efficiency', calibrationViewEnd),
    ],
  ]);

  const runFilters = [
    /run\.task_set_id\s*=\s*'aiq-core'/,
    /run\.task_set_version\s*=\s*'1\.0\.6'/,
    /run\.benchmark_version\s*=\s*'aiq-core@1\.0\.6'/,
    /run\.scoring_version\s*=\s*'1\.0\.6'/,
  ];
  for (const viewName of [
    'public_leaderboard',
    'public_run_results',
    'public_runs',
    'public_model_efficiency',
  ]) {
    const section = sections.get(viewName);
    assert.ok(section, `The schema checker is missing ${viewName}.`);
    for (const filter of runFilters) {
      assert.match(section, filter, `${viewName} must expose only the active AIQ 1.0.6 tuple.`);
    }
  }

  const leaderboard = sections.get('public_leaderboard');
  assert.ok(leaderboard);
  assert.match(
    leaderboard,
    /score\.scoring_version\s*=\s*'1\.0\.6'/,
    'public_leaderboard must bind its snapshot to the active scoring version.',
  );

  const scoringVersions = sections.get('public_scoring_versions');
  assert.ok(scoringVersions);
  assert.match(scoringVersions, /benchmark_version\s*=\s*'aiq-core@1\.0\.6'/);
  assert.match(scoringVersions, /scoring_version\s*=\s*'1\.0\.6'/);

  const taskCoverage = sections.get('public_task_coverage');
  assert.ok(taskCoverage);
  assert.match(taskCoverage, /scoring\.benchmark_version\s*=\s*'aiq-core@1\.0\.6'/);
  assert.match(taskCoverage, /scoring\.scoring_version\s*=\s*'1\.0\.6'/);

  const trend = sections.get('public_trend_points');
  assert.ok(trend);
  assert.ok(
    (trend.match(/run\.task_set_id\s*=\s*'aiq-core'/g) ?? []).length >= 2,
    'public_trend_points must filter both its range bounds and observations to AIQ 1.0.6.',
  );

  for (const viewName of [
    'public_calibration_runs',
    'public_calibration_results',
    'public_calibration_scores',
  ]) {
    const section = sections.get(viewName);
    assert.ok(section, `The schema checker is missing ${viewName}.`);
    assert.match(section, /run\.task_set_id\s*=\s*'aiq-core'/);
    assert.match(section, /run\.task_set_version\s*=\s*'1\.0\.6'/);
    assert.match(section, /run\.scoring_version\s*=\s*'1\.0\.6'/);
  }
}

function checkWorkspaceIntegrityFailureClassification(schema: string): void {
  const adapterValidator =
    schema.match(
      /create function aiq_private\.dto_adapter_failure_is_valid[\s\S]*?\n\$_\$;/i,
    )?.[0] ?? '';
  assert.match(
    adapterValidator,
    /'non_zero_exit','budget_exceeded','output_truncated','workspace_integrity'/,
    'The adapter-failure validator must accept workspace_integrity after paid execution.',
  );

  const resultValidator =
    schema.match(/create function aiq_private\.dto_result_is_valid[\s\S]*?\n\$_\$;/i)?.[0] ?? '';
  assert.match(
    resultValidator,
    /'missing_response','evaluator_failure','budget_exceeded','output_truncated',\s*'workspace_unavailable','workspace_integrity'\s*\)/,
    'The task-result validator must accept workspace_integrity as a failure kind.',
  );
  assert.match(
    resultValidator,
    /'evaluator_failure','workspace_unavailable','workspace_integrity'\s*\) and candidate -> 'task_score' <> 'null'::jsonb/,
    'A workspace_integrity failure must use the infrastructure null-score shape.',
  );
  assert.match(
    resultValidator,
    /if failure ->> 'kind' = 'workspace_integrity' then[\s\S]{0,1200}workspace_manifest[\s\S]{0,1200}workspace-snapshot\.json/,
    'An attempted workspace_integrity result must retain both workspace commitments or neither.',
  );

  const unattemptedSets = [
    ...schema.matchAll(
      /(?:in|not in)\s*\(\s*'capability_unavailable'\s*,\s*'capability_validation_failed'\s*,\s*'workspace_unavailable'(?<tail>[\s\S]*?)\)/g,
    ),
  ];
  assert.equal(
    unattemptedSets.length,
    9,
    'The database must retain all nine explicit pre-invocation or unattempted filters.',
  );
  for (const filter of unattemptedSets) {
    assert.equal(
      filter.groups?.tail?.trim() ?? '',
      '',
      'workspace_integrity is attempted and must not enter an unattempted filter.',
    );
  }

  const outcomeNormalizer =
    schema.match(
      /create function aiq_private\.normalized_outcome_from_source[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  assert.match(
    outcomeNormalizer,
    /'evaluator_failure', 'workspace_unavailable', 'workspace_integrity', 'missing_evaluator'/,
    'workspace_integrity must normalize to the invalid infrastructure outcome.',
  );
  const responsibilityNormalizer =
    schema.match(
      /create function aiq_private\.normalized_responsibility_from_source[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  assert.match(
    responsibilityNormalizer,
    /'evaluator_failure', 'workspace_unavailable', 'workspace_integrity', 'missing_evaluator'[\s\S]{0,80}'benchmark_infrastructure'/,
    'workspace_integrity must retain benchmark-infrastructure responsibility.',
  );
  assert.match(
    schema,
    /outcome='invalid'[\s\S]{0,100}failure_code in \(\s*'evaluator_failure','workspace_unavailable','workspace_integrity','missing_evaluator','spawn'/,
    'The calibration result constraint must accept the normalized workspace_integrity code.',
  );
}

function checkCurrentReleaseAndPricing(schema: string, syntheticDemo: string): void {
  const catalogDigest = '7548f78c0b4bae156e3c8ab257688dffd176b26234d0f7a52cb06a568f8c4ad1';
  const catalogReleaseDigest = '7d1eaaa03bf9f15f16290df1420a4ebcad64c24183066baf4c3f1b12d11bd46c';
  const evaluatorDigest = 'd4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c';
  const controlledTaskTreeDigest =
    '94a0796721f4c79a37206933e3e246249acc89759f700035899d10bcd8384e15';
  const predecessorCatalogDigest =
    'b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc';
  const immediatePredecessorCatalogDigest =
    '2b009bfe1c590898b143c13b264b738f950cbda5c42dae104aaf9dd63426a59e';
  const immediatePredecessorCatalogReleaseDigest =
    'f529aa9c7431f17e7b51ad8cc3524eea063edb154853b8ee49702cb0e9462279';
  const staleCatalogDigest = 'b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3';
  const databaseSources = `${schema}\n${syntheticDemo}`;

  assert.doesNotMatch(databaseSources, new RegExp(predecessorCatalogDigest));
  assert.doesNotMatch(databaseSources, new RegExp(immediatePredecessorCatalogDigest));
  assert.doesNotMatch(databaseSources, new RegExp(immediatePredecessorCatalogReleaseDigest));
  assert.doesNotMatch(databaseSources, new RegExp(staleCatalogDigest));
  assert.doesNotMatch(databaseSources, /aiq-core@1\.0\.0/);
  assert.doesNotMatch(databaseSources, /aiq-core@1\.0\.1/);
  assert.doesNotMatch(
    databaseSources,
    new RegExp(controlledTaskTreeDigest),
    'The controlled generated-task tree digest is not a runtime database task-set identity.',
  );
  assert.match(schema, new RegExp(`sha256:${catalogDigest}`));
  assert.match(schema, new RegExp(`catalog_sha256 =\\s*'${catalogDigest}'`));
  assert.match(
    schema,
    new RegExp(`catalog_release_identity_sha256' =\\s*'sha256:${catalogReleaseDigest}'`),
  );
  assert.match(schema, /task_set\.task_set_version = '1\.0\.6'/);
  assert.match(schema, /scoring\.scoring_version = '1\.0\.6'/);
  assert.match(schema, /scoring\.benchmark_version = 'aiq-core@1\.0\.6'/);
  assert.match(schema, new RegExp(`sha256:${evaluatorDigest}`));
  assert.match(syntheticDemo, /'aiq-core@1\.0\.6'/);
  assert.match(
    syntheticDemo,
    /package\.normalization_digest, package\.node_id, 'aiq-core', '1\.0\.6', '1\.0\.6'/,
  );

  const pricingValidator =
    schema.match(
      /create function aiq_private\.efficiency_pricing_v1_is_valid[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  for (const contract of [
    /https:\/\/developers\.openai\.com\/api\/docs\/pricing/,
    /'gpt-5\.6-sol'[\s\S]{0,240}5000[\s\S]{0,120}500[\s\S]{0,160}6250[\s\S]{0,120}30000/,
    /'gpt-5\.6-terra'[\s\S]{0,240}2000[\s\S]{0,120}200[\s\S]{0,160}2500[\s\S]{0,120}12000/,
    /'gpt-5\.6-luna'[\s\S]{0,240}200[\s\S]{0,120}20[\s\S]{0,160}250[\s\S]{0,120}1200/,
    /Standard short-context API-equivalent comparison only\.[\s\S]{0,320}272000 aggregate input tokens[\s\S]{0,220}Regional processing uplift and hosted tool fees are excluded\.[\s\S]{0,120}This is not actual subscription spend\.[\s\S]{0,120}https:\/\/developers\.openai\.com\/api\/docs\/pricing/,
  ]) {
    assert.match(
      pricingValidator,
      contract,
      'The fixed Standard short-context pricing record drifted.',
    );
  }

  const resultEfficiencyValidator =
    schema.match(
      /create function aiq_private\.result_efficiency_v1_is_valid[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  assert.match(
    resultEfficiencyValidator,
    /if input_tokens>272000\s*then return candidate->>'cost_status'='unavailable_context_band'/,
    'Aggregate input above the short-context boundary must be unpriced.',
  );
  assert.match(
    resultEfficiencyValidator,
    /\(candidate->>'cost_status'='estimated'\)[\s\S]{0,160}\(candidate->'standard_api_equivalent_usd_nanos'<>'null'::jsonb\)/,
    'Only estimated results can retain a cost.',
  );
  assert.match(
    resultEfficiencyValidator,
    /\(candidate->'standard_api_equivalent_usd_nanos'='null'::jsonb\)[\s\S]{0,160}\(candidate->'cost_evidence_level'='null'::jsonb\)/,
    'Unavailable costs must not retain cost authority.',
  );
}

function checkReviewedEvaluatorIdentity(schema: string): void {
  const evaluatorIdentity =
    'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c';
  const officialValidator =
    schema.match(
      /create function aiq_private\.dto_run_provenance_is_valid[\s\S]*?\n\$_\$;/i,
    )?.[0] ?? '';
  const stageMatcher =
    schema.match(
      /create function aiq_private\.run_provenance_v2_matches_stage[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  const catalogValidator =
    schema.match(
      /create function aiq_private\.frozen_catalog_identity_is_valid[\s\S]*?\n\$_\$;/i,
    )?.[0] ?? '';
  const readiness =
    schema.match(/create function public\.aiq_production_reference_status[\s\S]*?\n\$\$;/i)?.[0] ??
    '';
  const initializedExpression =
    readiness.match(/'initialized',[\s\S]*?'model_config_count'/)?.[0] ?? '';

  assert.match(
    officialValidator,
    new RegExp(`candidate ->> 'evaluator_digest' <>\\s*'${evaluatorIdentity}'`),
    'Official provenance must compare the evaluator digest with the reviewed identity.',
  );
  assert.match(
    stageMatcher,
    new RegExp(`candidate ->> 'evaluator_digest' is distinct from\\s*'${evaluatorIdentity}'`),
    'Official stage admission must compare the evaluator digest with the reviewed identity.',
  );
  assert.match(
    catalogValidator,
    new RegExp(`task_set\\.metadata ->> 'evaluator_identity_sha256' =\\s*'${evaluatorIdentity}'`),
    'The frozen task-set record must retain the reviewed evaluator identity.',
  );
  assert.match(
    initializedExpression,
    new RegExp(`evaluator_identity_sha256 =\\s*'${evaluatorIdentity}'`),
    'Production readiness must compare stored metadata with the reviewed evaluator identity.',
  );
  assert.match(
    readiness,
    /'evaluator_identity_sha256', evaluator_identity_sha256/,
    'Production readiness must attest the stored evaluator identity.',
  );
}

function checkReviewedTaskSetIdentity(schema: string): void {
  const taskSetIdentity = 'sha256:b3a11e8801310b6c07318ba0a39a9d31ca9f41e88e53295876a940873e333b82';
  const officialValidator =
    schema.match(
      /create function aiq_private\.dto_run_provenance_is_valid[\s\S]*?\n\$_\$;/i,
    )?.[0] ?? '';
  const stageMatcher =
    schema.match(
      /create function aiq_private\.run_provenance_v2_matches_stage[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  const catalogValidator =
    schema.match(
      /create function aiq_private\.frozen_catalog_identity_is_valid[\s\S]*?\n\$_\$;/i,
    )?.[0] ?? '';
  const readiness =
    schema.match(/create function public\.aiq_production_reference_status[\s\S]*?\n\$\$;/i)?.[0] ??
    '';
  const initializedExpression =
    readiness.match(/'initialized',[\s\S]*?'model_config_count'/)?.[0] ?? '';

  assert.match(
    officialValidator,
    new RegExp(`candidate ->> 'task_set_digest' <>\\s*'${taskSetIdentity}'`),
    'Official provenance must compare the task-set digest with the native identity.',
  );
  assert.match(
    stageMatcher,
    new RegExp(`candidate ->> 'task_set_digest' is distinct from\\s*'${taskSetIdentity}'`),
    'Official stage admission must compare the task-set digest with the native identity.',
  );
  assert.match(
    catalogValidator,
    new RegExp(
      `jcs_sha256\\([\\s\\S]{0,260}jsonb_agg\\([\\s\\S]{0,260}fixture_commitment[\\s\\S]{0,260}collate "C"[\\s\\S]{0,500}= '${taskSetIdentity}'`,
    ),
    'The frozen catalog must derive and compare the sorted task-definition identities.',
  );
  assert.match(
    readiness,
    /case when count\(\*\) = 72 and count\(task\.fixture_commitment\) = 72[\s\S]{0,320}jcs_sha256\([\s\S]{0,320}jsonb_agg\([\s\S]{0,240}order by \('sha256:' \|\| task\.fixture_commitment\) collate "C"/,
    'Production readiness must derive the native identity from all 72 stored task commitments.',
  );
  assert.match(
    initializedExpression,
    new RegExp(`task_set_identity_sha256 =\\s*'${taskSetIdentity}'`),
    'Production readiness must compare the derived task-set identity.',
  );
  assert.match(
    readiness,
    /'task_set_identity_sha256', task_set_identity_sha256/,
    'Production readiness must attest the derived task-set identity.',
  );
}

export function checkDatabaseTaskCommitmentFixture(value: unknown): void {
  const taskSetIdentity = 'sha256:b3a11e8801310b6c07318ba0a39a9d31ca9f41e88e53295876a940873e333b82';
  const reviewedCommitmentsIdentity =
    'sha256:94d41753482dbb45cc67cf2563fa369f125eb0d8dd19fa186f279c1b0f741211';
  const fixture = jsonObject(value);
  assert.deepEqual(Object.keys(fixture).toSorted(), [
    'schema_version',
    'task_set_id',
    'task_set_identity_sha256',
    'task_set_version',
    'tasks',
  ]);
  assert.equal(fixture.schema_version, 'aiq.production-task-commitments.v1');
  assert.equal(fixture.task_set_id, 'aiq-core');
  assert.equal(fixture.task_set_version, '1.0.6');
  assert.equal(fixture.task_set_identity_sha256, taskSetIdentity);
  const tasks = unknownArray(fixture.tasks);
  assert.equal(tasks.length, 72);
  const taskIds = new Set<string>();
  const definitionIdentities = tasks.map((taskValue, index) => {
    const task = jsonObject(taskValue);
    assert.deepEqual(Object.keys(task).toSorted(), [
      'fixture_bundle_sha256',
      'task_definition_sha256',
      'task_id',
    ]);
    assert.match(String(task.task_id), /^[a-z][a-z0-9-]{1,63}$/);
    assert.match(String(task.task_definition_sha256), /^sha256:[0-9a-f]{64}$/);
    assert.match(String(task.fixture_bundle_sha256), /^sha256:[0-9a-f]{64}$/);
    assert.ok(!taskIds.has(String(task.task_id)), `duplicate task_id at index ${String(index)}`);
    taskIds.add(String(task.task_id));
    return String(task.task_definition_sha256);
  });
  assert.equal(new Set(definitionIdentities).size, 72);
  const derivedIdentity = `sha256:${createHash('sha256')
    .update(canonicalJson(definitionIdentities.toSorted()))
    .digest('hex')}`;
  assert.equal(derivedIdentity, taskSetIdentity);
  const derivedCommitmentsIdentity = `sha256:${createHash('sha256')
    .update(canonicalJson(fixture))
    .digest('hex')}`;
  assert.equal(derivedCommitmentsIdentity, reviewedCommitmentsIdentity);
}

export function checkDatabaseInitializerSource(initializer: string): void {
  const evaluatorIdentity =
    'sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c';
  assert.match(
    initializer,
    new RegExp(`const EVALUATOR_IDENTITY =\\s*'${evaluatorIdentity}'`),
    'The initializer must declare the reviewed evaluator identity.',
  );
  const runtimeValidator =
    initializer.match(/function validateRuntimeProvenance[\s\S]*?\nfunction validateNodes/)?.[0] ??
    '';
  const taskSetValidator =
    initializer.match(
      /function validateReviewedTaskCommitments[\s\S]*?\nfunction validateRuntimeProvenance/,
    )?.[0] ?? '';
  const referenceRowBuilder =
    initializer.match(/function referenceRows[\s\S]*?\nfunction insertSql/)?.[0] ?? '';
  const initializationSql =
    initializer.match(/function insertSql[\s\S]*?\nfunction schemaTransactionBody/)?.[0] ?? '';
  const preparation =
    initializer.match(
      /export function prepareInitialization[\s\S]*?\nasync function runPsql/,
    )?.[0] ?? '';
  const readinessParser =
    initializer.match(
      /function readinessPassed[\s\S]*?\nexport async function initializeDatabase/,
    )?.[0] ?? '';
  assert.match(
    initializer,
    /const TASK_SET_IDENTITY =\s*'sha256:b3a11e8801310b6c07318ba0a39a9d31ca9f41e88e53295876a940873e333b82'/,
    'The initializer must declare the native task-set identity.',
  );
  assert.match(
    initializer,
    /const REVIEWED_TASK_COMMITMENTS_IDENTITY =\s*'sha256:94d41753482dbb45cc67cf2563fa369f125eb0d8dd19fa186f279c1b0f741211'/,
    'The initializer must declare the reviewed task commitment manifest identity.',
  );
  assert.match(
    taskSetValidator,
    /documentDigest\(manifest\) !== REVIEWED_TASK_COMMITMENTS_IDENTITY/,
    'The initializer must compare the complete reviewed task commitment manifest.',
  );
  assert.match(
    taskSetValidator,
    /binding\.task_definition_sha256 !== reviewed\.task_definition_sha256/,
    'Every task definition must match the reviewed commitment.',
  );
  assert.match(
    taskSetValidator,
    /binding\.fixture_bundle_sha256 !== reviewed\.fixture_bundle_sha256/,
    'Every fixture bundle must match the reviewed commitment.',
  );
  assert.match(
    taskSetValidator,
    /documentDigest\(taskDefinitionIdentities\.toSorted\(\)\)/,
    'The initializer must use the Rust sorted-address canonical task-set hash algorithm.',
  );
  assert.match(
    taskSetValidator,
    /derivedIdentity !== TASK_SET_IDENTITY/,
    'The initializer must compare the derived task-set identity with the native value.',
  );
  assert.match(
    runtimeValidator,
    /evaluatorDigest !== EVALUATOR_IDENTITY/,
    'The initializer must compare runtime evaluator provenance with the reviewed identity.',
  );
  assert.match(
    runtimeValidator,
    /binding\.evaluator_executable_sha256 !== EVALUATOR_IDENTITY/,
    'Every task binding must compare its evaluator executable with the reviewed identity.',
  );
  assert.match(
    runtimeValidator,
    /return evaluatorDigest;/,
    'The initializer must return the validated evaluator identity.',
  );
  assert.match(
    referenceRowBuilder,
    /evaluator_identity_sha256: reference\.evaluatorIdentitySha256/,
    'The initializer must persist the validated evaluator identity in task-set metadata.',
  );
  assert.match(
    preparation,
    /task_set_identity_sha256: reference\.taskSetIdentitySha256[\s\S]{0,160}evaluator_identity_sha256:/,
    'The initialization receipt must attest the validated task-set identity.',
  );
  assert.match(
    preparation,
    /evaluator_identity_sha256: reference\.evaluatorIdentitySha256[\s\S]{0,160}task_count: 72/,
    'The initialization receipt must attest the validated evaluator identity.',
  );
  assert.match(
    preparation,
    /select 1 from storage\.buckets[\s\S]{0,160}id in \('aiq-submission-packages', 'aiq-runner-artifacts'\)[\s\S]{0,160}name in \('aiq-submission-packages', 'aiq-runner-artifacts'\)/,
    'The greenfield preflight must reject either existing AIQ Storage bucket identity.',
  );
  assert.match(
    initializationSql,
    /from storage\.buckets[\s\S]{0,160}id in \('aiq-submission-packages', 'aiq-runner-artifacts'\)[\s\S]{0,80}public is false/,
    'Initialization readiness must require both private AIQ Storage buckets.',
  );
  assert.match(
    readinessParser,
    /value\.task_set_identity_sha256 === expected\.task_set_identity_sha256/,
    'The initializer must compare readiness output with the receipt task-set identity.',
  );
  assert.match(
    readinessParser,
    /value\.task_set_identity_valid === true/,
    'The initializer must require the readiness task-set validity result.',
  );
  assert.match(
    readinessParser,
    /value\.evaluator_identity_sha256 === expected\.evaluator_identity_sha256/,
    'The initializer must compare readiness output with the receipt evaluator identity.',
  );
  assert.match(
    readinessParser,
    /value\.evaluator_identity_valid === true/,
    'The initializer must require the readiness evaluator validity result.',
  );
}

export function checkDatabaseSchemaSources(schema: string, syntheticDemo: string): void {
  assert.match(schema, /^begin;\n/);
  assert.match(schema, /\ncommit;\s*$/);
  assert.doesNotMatch(schema, /^\s*drop\s/im, 'The fresh schema must not drop database objects.');
  assert.doesNotMatch(
    schema,
    /^insert\s+into\s+aiq_private\./im,
    'The schema must not contain AIQ demo data.',
  );
  assert.equal(
    (schema.match(/^insert\s+into\s+/gim) ?? []).length,
    1,
    'The schema must contain only the private Storage bucket initialization insert.',
  );
  assert.match(
    schema,
    /insert into storage\.buckets \(id, name, public\)\s+values\s+\('aiq-submission-packages', 'aiq-submission-packages', false\),\s+\('aiq-runner-artifacts', 'aiq-runner-artifacts', false\);/i,
    'Fresh initialization must create both AIQ Storage buckets as private.',
  );
  assert.match(
    schema,
    /supplied_object_type = 'submission_package'[\s\S]{0,120}supplied_bucket = 'aiq-submission-packages'[\s\S]{0,160}supplied_object_type = 'runner_artifact'[\s\S]{0,120}supplied_bucket = 'aiq-runner-artifacts'/i,
    'The Storage registry must accept only the two object-type-specific AIQ buckets.',
  );
  assert.match(
    schema,
    /object\.object_type = 'submission_package'[\s\S]{0,120}object\.bucket_name = 'aiq-submission-packages'[\s\S]{0,160}object\.object_type = 'runner_artifact'[\s\S]{0,120}object\.bucket_name = 'aiq-runner-artifacts'[\s\S]{0,180}object\.retention_class <> 'preserve'/i,
    'Lifecycle deletion claims must remain inside the two canonical AIQ buckets.',
  );
  const storageInitialization =
    schema.match(/insert into storage\.buckets[\s\S]*?;(?=\s*create role aiq_verifier)/i)?.[0] ??
    '';
  assert.doesNotMatch(
    storageInitialization,
    /on conflict/i,
    'The greenfield Storage initialization must not reuse or update existing buckets.',
  );
  assert.equal(
    (schema.match(/^create role aiq_(?:verifier|publisher)$/gm) ?? []).length,
    hardenedGatewayRoleCount,
    'Fresh initialization must create both AIQ roles directly.',
  );
  assert.doesNotMatch(
    schema,
    /if not exists\s*\(\s*select 1\s+from pg_roles\s+where rolname = 'aiq_(?:verifier|publisher)'/i,
    'Fresh initialization must not preserve pre-existing AIQ roles.',
  );
  for (const roleName of ['aiq_verifier', 'aiq_publisher']) {
    assert.match(
      schema,
      new RegExp(
        `create role ${roleName}[\\s\\S]{0,100}nocreatedb nocreaterole noreplication nobypassrls nologin noinherit`,
        'i',
      ),
      `${roleName} must be a hardened no-login gateway role.`,
    );
  }
  assert.match(
    schema,
    /create function aiq_private\.enqueue_submission_core\(envelope jsonb, request_context jsonb\)/,
  );
  assert.doesNotMatch(
    schema,
    /create function public\.aiq_enqueue_submission\(envelope jsonb, request_context jsonb\)/,
    'The public submission API must expose only its current object-bound signature.',
  );
  assert.equal(
    (schema.match(/^create table aiq_private\./gim) ?? []).length,
    privateTableCount,
    'The private table inventory must contain only the core and evidence tables.',
  );
  assert.equal(
    (schema.match(/enable row level security/gi) ?? []).length,
    privateTableCount,
    'Each private table must enable row-level security.',
  );
  assert.equal(
    (schema.match(/force row level security/gi) ?? []).length,
    privateTableCount,
    'Each private table must force row-level security.',
  );
  assert.equal(
    (schema.match(/^create view public\./gim) ?? []).length,
    publicViewCount,
    'Only the inventoried read views can be public.',
  );
  assert.equal(
    (schema.match(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/gi) ?? []).length,
    publicViewCount,
    'Each public view must use invoker security.',
  );
  assert.equal(publicViews.length, publicViewCount, 'The checker public-view inventory is stale.');
  for (const tableName of evidencePrivateTables) {
    assert.match(
      schema,
      new RegExp(`^create table aiq_private\\.${tableName}\\s*\\(`, 'im'),
      `The private evidence inventory must create ${tableName}.`,
    );
    assert.match(
      schema,
      new RegExp(`^alter table aiq_private\\.${tableName} enable row level security;$`, 'im'),
      `${tableName} must enable row-level security.`,
    );
    assert.match(
      schema,
      new RegExp(`^alter table aiq_private\\.${tableName} force row level security;$`, 'im'),
      `${tableName} must force row-level security.`,
    );
  }
  for (const viewName of publicViews) {
    assert.match(
      schema,
      new RegExp(
        `^create view public\\.${viewName} with \\(\\s*security_invoker\\s*=\\s*true\\s*\\)`,
        'im',
      ),
      `${viewName} must be an invoker-security view.`,
    );
  }
  const browserReadSurfaceRevocation = [
    ...schema.matchAll(/revoke all on table\s+([\s\S]*?)\s+from public, anon, authenticated;/gi),
  ]
    .map((match) => match[1])
    .join('\n');
  assert.ok(
    browserReadSurfaceRevocation,
    'The public read surface must remove provider default grants before granting SELECT.',
  );
  for (const viewName of corePublicViews) {
    assert.match(
      browserReadSurfaceRevocation,
      new RegExp(`public\\.${viewName}(?:,|\\s|$)`),
      `The public read surface must revoke provider defaults from ${viewName}.`,
    );
  }
  const evidenceReadSurfaceRevocation = schema.match(
    /revoke all on table\s+(public\.public_calibration_runs[\s\S]*?)\s+from public,\s*anon,\s*authenticated;/i,
  )?.[1];
  assert.ok(
    evidenceReadSurfaceRevocation,
    'The evidence read surface must remove provider default grants before granting SELECT.',
  );
  for (const viewName of evidencePublicViews) {
    assert.match(
      evidenceReadSurfaceRevocation,
      new RegExp(`public\\.${viewName}(?:,|$)`),
      `The evidence read surface must revoke provider defaults from ${viewName}.`,
    );
    assert.match(
      schema,
      new RegExp(`grant select on table public\\.${viewName} to anon, authenticated;`, 'i'),
      `The evidence read surface must grant ${viewName} to browser roles.`,
    );
  }
  assert.match(schema, /'synthetic_complete'/);
  assert.match(schema, /score ->> 'tier' = 'synthetic_complete' and not is_synthetic/);
  assert.match(schema, /score ->> 'tier' = 'official' and is_synthetic/);
  assert.match(schema, /batch\.synthetic[\s\S]{0,120}return false;/);
  assert.match(
    syntheticDemo,
    /["']synthetic_complete["']/,
    'The synthetic scoring policy must retain the synthetic_complete status definition.',
  );
  assert.doesNotMatch(schema, /create table public\.aiq_/);
  const databaseSources = `${schema}\n${syntheticDemo}`;
  for (const contractName of [
    'result-package',
    'verifier-attestation',
    'normalized-batch',
    'package-binding',
  ]) {
    const versions = [
      ...databaseSources.matchAll(new RegExp(`aiq\\.${contractName}\\.v([0-9]+)`, 'g')),
    ].map((match) => match[1]);
    assert.ok(versions.length > 0, `The canonical database sources omit aiq.${contractName}.v3.`);
    assert.deepEqual(
      new Set(versions),
      new Set(['3']),
      `The canonical database sources must use only aiq.${contractName}.v3.`,
    );
  }
  assert.doesNotMatch(databaseSources, /(?:stage_verifier_result|verify_and_publish)_v[0-9]+/);
  assert.doesNotMatch(databaseSources, /provenance_storage_adapter/);
  assert.match(schema, /create function aiq_private\.stage_verifier_result_core\(/);
  assert.match(schema, /create function aiq_private\.verify_and_publish_core\(/);
  assert.match(
    schema,
    /aiq_result_packages_schema_version_check check \(\(schema_version = 'aiq\.result-package\.v3'::text\)\)/,
  );
  assert.match(
    schema,
    /aiq_result_packages_provenance_check check \(\(provenance = '\{"schema_version": "aiq\.package-binding\.v3"\}'::jsonb\)\)/,
  );
  assert.match(
    schema,
    /revoke all on schema aiq_private[\s\S]{0,160}from public, anon, authenticated, service_role, aiq_verifier, aiq_publisher/,
  );
  assert.match(
    schema,
    /revoke create on schema public[\s\S]{0,160}from public, anon, authenticated, service_role, aiq_verifier, aiq_publisher/,
  );
  checkSecurityDefinerSearchPaths(schema);
  checkWorkspaceIntegrityFailureClassification(schema);
  checkActivePublicReadVersionFilters(schema);
  checkCurrentReleaseAndPricing(schema, syntheticDemo);
  checkReviewedTaskSetIdentity(schema);
  checkReviewedEvaluatorIdentity(schema);

  for (const requiredName of [
    'aiq_enqueue_submission',
    'aiq_record_artifact_ingress',
    'aiq_claim_submission',
    'aiq_renew_submission_claim',
    'aiq_ack_submission_claim',
    'aiq_resolve_claim_artifact',
    'aiq_stage_verifier_result',
    'aiq_record_verifier_attestation',
    'aiq_record_verification_rejection',
    'aiq_verify_and_publish',
    'aiq_register_storage_object',
    'aiq_claim_storage_deletions',
    'aiq_ack_storage_deletion',
    'aiq_retry_storage_deletion',
    'aiq_set_storage_legal_hold',
    'aiq_record_storage_inventory_epoch',
    'aiq_production_reference_status',
    'aiq_describe_web_rpc_contract',
    'aiq_gateway_role_probe',
    'aiq_stage_calibration_verification',
    'aiq_record_calibration_attestation',
    'aiq_publish_calibration_evidence',
    'public_trend_points',
  ]) {
    assert.match(schema, new RegExp(`function public\\.${requiredName}\\(`));
  }

  for (const [functionName, roleName] of [
    ['aiq_stage_calibration_verification', 'aiq_verifier'],
    ['aiq_record_calibration_attestation', 'aiq_verifier'],
    ['aiq_publish_calibration_evidence', 'aiq_publisher'],
  ] as const) {
    assert.match(
      schema,
      new RegExp(
        `grant execute on function public\\.${functionName}\\([^;]{1,100}\\)\\s+to ${roleName};`,
        'i',
      ),
      `${functionName} must be executable only through ${roleName}.`,
    );
  }

  const publicTrendPoints =
    schema.match(/create function public\.public_trend_points[\s\S]*?\n\$\$;/i)?.[0] ?? '';
  assert.match(
    publicTrendPoints,
    /range_ended_at := latest_recorded_at \+ interval '1 millisecond';/,
    'The public trend range must remain half-open at JavaScript millisecond precision.',
  );

  for (const tableName of evidencePrivateTables) {
    assert.match(
      schema,
      new RegExp(
        `create trigger ${tableName}_append_only before update or delete on aiq_private\\.${tableName}`,
        'i',
      ),
      `${tableName} must reject evidence mutation.`,
    );
  }
  for (const tableName of [
    'calibration_runs',
    'calibration_task_results',
    'calibration_model_scores',
    'calibration_publications',
    'efficiency_pricing_methods',
    'efficiency_official_models',
  ]) {
    assert.match(
      schema,
      new RegExp(`create policy ${tableName}_public_read on aiq_private\\.${tableName}`, 'i'),
      `${tableName} must expose only its bounded published-evidence rows.`,
    );
  }

  for (const pricingContract of [
    "candidate->>'method'='standard_api_equivalent_text_token_estimate'",
    "candidate->>'version'='aiq.standard-api-equivalent-usd.v1'",
    "candidate->>'as_of'='2026-08-02'",
    "candidate->>'source'='https://developers.openai.com/api/docs/pricing'",
    "candidate->>'currency'='USD'",
    "candidate->>'processing_tier'='standard'",
    "candidate->'hosted_tool_fees_included'='false'::jsonb",
    "'(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again'",
    "'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing'",
  ]) {
    assert.ok(
      schema.includes(pricingContract),
      `The pricing inventory must retain ${pricingContract}.`,
    );
  }
  assert.match(
    schema,
    /candidate->'rates'=jsonb_build_array\([\s\S]{0,700}'gpt-5\.6-sol'[\s\S]{0,300}'gpt-5\.6-terra'[\s\S]{0,300}'gpt-5\.6-luna'/,
    'The pricing inventory must retain the ordered Sol, Terra, and Luna rates.',
  );
  assert.match(
    schema,
    /reference_type in \('calibration_run','official_publication'\)/,
    'Storage references must admit only the bounded publication evidence classes.',
  );
  assert.match(
    schema,
    /evidence_role in \('submitted_package','verified_artifact'\)/,
    'Publication retention must bind the submitted package and verified artifacts.',
  );
  assert.match(
    schema,
    /create function aiq_private\.reconcile_publication_storage_evidence\(\s*supplied_publication_class text,target_publication_id text,\s*target_package_sha256 text,target_inbox_id uuid\s*\)/i,
    'Official and calibration publication paths must share one storage-evidence reconciler.',
  );
  assert.match(
    schema,
    /create function aiq_private\.aiq_claim_storage_deletions_reference_core[\s\S]{0,1800}'aiq\.storage\.inventory-deletion-gate'[\s\S]{0,900}interval '24 hours'/,
    'Storage deletion claims require the serialized 24-hour clean-inventory gate.',
  );
  assert.match(
    schema,
    /create function aiq_private\.storage_registry_inventory_digest\(\) returns text[\s\S]{0,180}aiq_private\.jcs_sha256\(coalesce\([\s\S]{0,260}jsonb_agg\(jsonb_build_object\(\s*'bucket',object\.bucket_name,\s*'key',object\.object_path,\s*'content_sha256',object\.content_sha256,\s*'bytes',object\.byte_size\s*\)[\s\S]{0,180}order by object\.bucket_name collate "C",object\.object_path collate "C"[\s\S]{0,160}'\[\]'::jsonb[\s\S]{0,160}where object\.lifecycle_state<>'deleted'/i,
    'The registry inventory digest must use the bounded JCS object inventory in bytewise order.',
  );
  const inventoryEpoch = schema.match(
    /create function public\.aiq_record_storage_inventory_epoch\(\s*supplied_inventory_object_count bigint,supplied_inventory_digest text\s*\)[\s\S]*?\n\$\$;/i,
  )?.[0];
  assert.ok(
    inventoryEpoch,
    'The Storage inventory RPC must retain its count-and-digest signature.',
  );
  assert.match(
    inventoryEpoch,
    /supplied_inventory_object_count not between 0 and 9007199254740991[\s\S]{0,160}supplied_inventory_digest~'\^sha256:\[0-9a-f\]\{64\}\$'/i,
    'The Storage inventory RPC must validate its bounded count and sha256 digest.',
  );
  assert.match(
    inventoryEpoch,
    /supplied_inventory_object_count<>\([\s\S]{0,180}where object\.lifecycle_state<>'deleted'[\s\S]{0,120}supplied_inventory_digest is distinct from\s*aiq_private\.storage_registry_inventory_digest\(\)/i,
    'A successful inventory epoch must match the exact live registry count and digest.',
  );
  assert.match(
    inventoryEpoch,
    /inventory_object_count,inventory_digest,[\s\S]{0,500}supplied_inventory_object_count,supplied_inventory_digest,1,database_now/i,
    'A successful inventory epoch must persist both supplied inventory identity fields.',
  );
  assert.match(
    schema,
    /revoke all on function public\.aiq_record_storage_inventory_epoch\(supplied_inventory_object_count bigint, supplied_inventory_digest text\) from PUBLIC;/i,
    'The Storage inventory RPC must revoke the provider default execute grant.',
  );
  assert.match(
    schema,
    /grant all on function public\.aiq_record_storage_inventory_epoch\(supplied_inventory_object_count bigint, supplied_inventory_digest text\) to service_role;/i,
    'Only service_role can record a completed Storage inventory epoch.',
  );

  assert.match(
    schema,
    /task_hash text generated always as \('sha256:'::text \|\| fixture_commitment\) stored/,
    'Catalog task hashes must be generated from the committed fixture digest.',
  );
  assert.match(
    schema,
    /constraint aiq_task_catalog_exact_commitment_key unique \(\s*task_set_id, task_set_version, task_id, task_version, task_hash\s*\)/i,
    'The catalog must expose one exact five-field task commitment key.',
  );
  assert.match(
    schema,
    /foreign key \(task_set_id,task_set_version,task_id,task_version,task_hash\)\s*references aiq_private\.aiq_task_catalog\(\s*task_set_id,task_set_version,task_id,task_version,task_hash\s*\)/i,
    'Calibration results must reference one exact committed catalog task.',
  );
  const calibrationPackageValidator =
    schema.match(
      /create function aiq_private\.calibration_package_v3_is_valid[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  assert.match(
    calibrationPackageValidator,
    /result ->> 'task_hash' = 'sha256:' \|\| catalog\.fixture_commitment/,
    'Calibration package validation must bind each source task hash to the catalog commitment.',
  );
  const calibrationStage =
    schema.match(
      /create function public\.aiq_stage_calibration_verification[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
  assert.match(calibrationStage, /aiq_private\.task_catalog_is_exact\(/);
  assert.match(calibrationStage, /selected_hashes/);
  assert.match(
    calibrationStage,
    /source->>'task_hash'='sha256:'\|\|catalog\.fixture_commitment/,
    'Calibration staging must reject a source result with a noncatalog task hash.',
  );

  assert.match(schema, /outcome aiq_private\.result_outcome not null/);
  assert.match(
    schema,
    /constraint calibration_task_results_outcome_score check \([\s\S]{0,1800}\(outcome='correct' and task_score is not null and task_score=1\)[\s\S]{0,300}\(outcome='partial' and task_score is not null and task_score>0 and task_score<1\)[\s\S]{0,400}\(outcome='incorrect' and task_score is not null and task_score=0\)[\s\S]{0,300}'timeout','budget_exhausted','tool_failure','policy_failure','wrong_artifact'[\s\S]{0,180}task_score is null\)[\s\S]{0,160}outcome in \('invalid','missing','not_applicable'\) and task_score is null/i,
    'Calibration outcomes must retain their exact score bindings.',
  );
  const failureBinding =
    schema.match(
      /constraint calibration_task_results_failure_binding check \([\s\S]*?\n\s*\)\n\s*,constraint calibration_task_results_efficiency_nonnegative/i,
    )?.[0] ?? '';
  for (const contract of [
    /outcome in \('correct','partial','incorrect','missing'\) and failure_code is null/,
    /outcome='timeout'[\s\S]{0,100}failure_code='timeout'/,
    /outcome='budget_exhausted'[\s\S]{0,120}failure_code='budget_exceeded'/,
    /outcome='tool_failure'[\s\S]{0,140}'unsupported_model','non_zero_exit'/,
    /outcome='policy_failure'[\s\S]{0,120}failure_code='output_truncated'/,
    /outcome='wrong_artifact'[\s\S]{0,120}failure_code='missing_response'/,
    /outcome='invalid'[\s\S]{0,260}'evaluator_failure','workspace_unavailable','workspace_integrity','missing_evaluator','spawn',[\s\S]{0,160}'authentication','subscription_limit','capability_validation_failed'/,
    /outcome='not_applicable'[\s\S]{0,140}failure_code='capability_unavailable'/,
  ]) {
    assert.match(
      failureBinding,
      contract,
      'Calibration outcomes must retain exact failure-code bindings.',
    );
  }

  const publicCalibrationResults =
    schema.match(
      /create view public\.public_calibration_results with \(security_invoker\s*=\s*true\) as[\s\S]*?\nfrom aiq_private\.calibration_task_results result[\s\S]*?;/i,
    )?.[0] ?? '';
  assert.match(publicCalibrationResults, /result\.outcome::text as outcome/);
  assert.match(
    publicCalibrationResults,
    /when result\.outcome in \('correct','partial','incorrect'\) then 'completed'[\s\S]{0,240}when result\.outcome in \([\s\S]{0,180}'wrong_artifact'[\s\S]{0,80}then 'runtime_issue'/,
    'The public calibration result must separate semantic outcomes from execution status.',
  );
  assert.match(publicCalibrationResults, /end as execution_status/);
  assert.doesNotMatch(
    publicCalibrationResults,
    /end as status|then 'passed'|then 'failed'/,
    'Public calibration results must not collapse semantic outcomes into pass/fail status.',
  );
  assert.match(publicCalibrationResults, /result\.failure_code as explanation_code/);
  assert.match(publicCalibrationResults, /end as explanation_summary/);
  assert.doesNotMatch(
    publicCalibrationResults,
    /result\.(?:task_hash|failure_detail)/,
    'The public calibration view must not expose committed hashes or raw failure detail.',
  );
  const calibrationResultGrant =
    schema.match(
      /grant select\(result_id,run_id,task_id,task_version,[\s\S]*?\)\s*on aiq_private\.calibration_task_results to anon, authenticated;/i,
    )?.[0] ?? '';
  assert.match(calibrationResultGrant, /failure_code/);
  assert.doesNotMatch(
    calibrationResultGrant,
    /task_hash|failure_detail/,
    'Browser roles must receive only bounded calibration-result columns.',
  );
  assert.match(
    schema,
    /grant select\(run_id,official_eligible,ranking_eligible,published_at\)\s+on aiq_private\.calibration_publications to anon, authenticated;/i,
    'Browser roles must receive only the bounded calibration publication columns.',
  );
  assert.match(
    schema,
    /private_table_count=40 and forced_rls_table_count=40\s+and public_view_count=12 and security_invoker_view_count=12\s+and canonical_public_view_count=12\s+and hardened_gateway_role_count=2/,
    'Production readiness must bind the complete schema, RLS, view, and gateway-role inventory.',
  );
  const readinessViewFacts =
    schema.match(/view_facts as \([\s\S]*?\n  \),\n  role_facts as \(/i)?.[0] ?? '';
  assert.match(
    readinessViewFacts,
    /where namespace\.nspname='public' and relation\.relkind='v'\s+and relation\.relname in \([\s\S]*?'public_model_efficiency'[\s\S]*?\)/,
    'Production readiness must count only the canonical AIQ public views.',
  );

  for (const indexName of [
    'aiq_runs_public_trend_series_idx',
    'aiq_runs_public_trend_extent_idx',
    'aiq_submission_claimable_idx',
    'aiq_storage_objects_claim_idx',
    'aiq_matrix_batches_task_set_fk_idx',
    'aiq_distributed_aggregation_receipt_fk_idx',
    'aiq_task_catalog_public_rls_idx',
    'calibration_runs_package_idx',
    'calibration_runs_pricing_idx',
    'aiq_publication_storage_evidence_object_idx',
    'aiq_publication_storage_evidence_official_fk_idx',
    'aiq_publication_storage_evidence_calibration_fk_idx',
    'efficiency_official_models_pricing_idx',
    'aiq_task_results_pricing_idx',
    'calibration_runs_register_cursor_idx',
    'calibration_task_results_model_detail_idx',
    'calibration_runs_task_set_idx',
    'calibration_task_results_catalog_idx',
    'calibration_publications_published_idx',
  ]) {
    assert.match(schema, new RegExp(`create (?:unique )?index ${indexName}`));
  }
  for (const [indexContract, message] of [
    [
      /create index aiq_publication_storage_evidence_object_idx\s+on aiq_private\.aiq_publication_storage_evidence\(object_id,content_sha256\);/i,
      'Publication storage evidence must retain its object lookup index.',
    ],
    [
      /create index aiq_publication_storage_evidence_official_fk_idx\s+on aiq_private\.aiq_publication_storage_evidence\(official_batch_id,package_sha256\)\s+where official_batch_id is not null;/i,
      'Official publication evidence must retain its bounded partial foreign-key index.',
    ],
    [
      /create index aiq_publication_storage_evidence_calibration_fk_idx\s+on aiq_private\.aiq_publication_storage_evidence\(calibration_run_id,package_sha256\)\s+where calibration_run_id is not null;/i,
      'Calibration publication evidence must retain its bounded partial foreign-key index.',
    ],
    [
      /create index aiq_task_results_pricing_idx\s+on aiq_private\.aiq_task_results\(pricing_digest\)\s+where pricing_digest is not null;/i,
      'Official result pricing lookup must remain a bounded partial index.',
    ],
    [
      /create index calibration_runs_register_cursor_idx\s+on aiq_private\.calibration_runs\(started_at desc,run_id\);/i,
      'Calibration registration must retain its deterministic cursor index.',
    ],
    [
      /create index calibration_task_results_model_detail_idx\s+on aiq_private\.calibration_task_results\(\s*run_id,model_family,reasoning_effort,result_id\s*\);/i,
      'Calibration detail lookup must retain its model-result index.',
    ],
    [
      /create index calibration_runs_task_set_idx\s+on aiq_private\.calibration_runs\(task_set_id,task_set_version\);/i,
      'Calibration runs must retain their task-set lookup index.',
    ],
    [
      /create index calibration_task_results_catalog_idx\s+on aiq_private\.calibration_task_results\(\s*task_set_id,task_set_version,task_id,task_version,task_hash\s*\);/i,
      'Calibration results must retain their exact catalog lookup index.',
    ],
    [
      /create index calibration_publications_published_idx on aiq_private\.calibration_publications\(published_at,run_id\);/i,
      'Calibration publications must retain their publish cursor index.',
    ],
  ] as const) {
    assert.match(schema, indexContract, message);
  }

  assert.match(
    schema,
    /claim_expires_at = database_now \+ make_interval\(secs => requested_lease_seconds\)/,
    'Submission claims must calculate leases from the wall clock.',
  );
  assert.match(
    schema,
    /deletion_lease_expires_at =\s*database_now \+ make_interval\(secs => requested_lease_seconds\)/,
    'Storage deletion claims must calculate leases from the wall clock.',
  );
  assert.doesNotMatch(schema, /claim_expires_at\s*(?:=|<=)\s*now\(\)/);
  assert.doesNotMatch(schema, /deletion_lease_expires_at\s*(?:=|<=)\s*now\(\)/);

  assert.match(
    syntheticDemo,
    /^-- Deterministic local demonstration data\. Every published observation is\n-- explicitly synthetic\./,
  );
  assert.match(syntheticDemo, /\nbegin;\n/);
  assert.match(syntheticDemo, /\ncommit;\s*$/);
  assert.match(syntheticDemo, /insert into aiq_private\.aiq_model_configs/);
  assert.match(syntheticDemo, /insert into aiq_private\.aiq_task_catalog/);
  assert.match(syntheticDemo, /insert into aiq_private\.aiq_package_runs/);
  assert.match(syntheticDemo, /'schema_version', 'aiq\.result-package\.v3'/);
  assert.doesNotMatch(syntheticDemo, /'unverified',\s*'queued'/);
  assert.match(syntheticDemo, /'unverified',\s*'processed'/);
  assert.doesNotMatch(syntheticDemo, /storage\.buckets|create\s+(?:storage\s+)?bucket/i);
  assert.doesNotMatch(`${schema}\n${syntheticDemo}`, /cron\.schedule|pg_cron/i);
}

export async function checkDatabaseSchema(
  repositoryRoot = resolve(import.meta.dirname, '..'),
): Promise<void> {
  const [schema, syntheticDemo, initializer, taskCommitments] = await Promise.all([
    readFile(join(repositoryRoot, 'databases/schema.sql'), 'utf8'),
    readFile(join(repositoryRoot, 'databases/synthetic-demo.sql'), 'utf8'),
    readFile(join(repositoryRoot, 'databases/init.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'databases/aiq-core-1.0.6-task-commitments.json'), 'utf8').then(
      (bytes) => JSON.parse(bytes) as unknown,
    ),
  ]);
  checkDatabaseSchemaSources(schema, syntheticDemo);
  checkDatabaseInitializerSource(initializer);
  checkDatabaseTaskCommitmentFixture(taskCommitments);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await checkDatabaseSchema();
  console.log('Database schema check passed.');
}
