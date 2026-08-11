/* oxlint-disable typescript/no-unsafe-type-assertion -- Configuration assertions are adjacent to every cast. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_SCHEMA = 'aiq.continuous-observation-config.v1';
const STATUS_SCHEMA = 'aiq.continuous-observation-status.v1';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}(?![\s\S])/;
const SLOT_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:03|15)-00Z(?![\s\S])/;
const REQUIRED_SECRETS = [
  'AIQ_RUNNER_SIGNING_KEY',
  'AIQ_RUNNER_SUBMISSION_TOKEN',
  'AIQ_VERIFIER_INGRESS_TOKEN',
  'AIQ_VERIFIER_SIGNING_KEY',
] as const;

export interface ContinuousObservationConfiguration {
  schema_version: typeof CONFIG_SCHEMA;
  release_root: string;
  source_root: string;
  observer_runner: string;
  state_root: string;
  codex_auth_source: string;
  endpoint: string;
  official_jobs: number;
  verifier_replay_jobs: number;
  speed_jobs: number;
  speed_trials: number;
  production_reference_sha256: string;
  build_receipt_sha256: string;
}

interface ScheduleDocument {
  schema_version: 'aiq.schedule.v1';
  timezone: 'UTC';
  day_local_time: '15:00';
  night_local_time: '03:00';
}

export interface ScheduledSlot {
  id: string;
  slotDate: string;
  occurrence: 'day' | 'night';
  observedAt: string;
  timestampMs: number;
}

interface ReleasePaths {
  runner: string;
  verifier: string;
  codex: string;
  core: string;
  tasks: string;
  workspaces: string;
  evaluator: string;
  runtime: string;
  toolchain: string;
  commitment: string;
  sealReceipt: string;
  calibrationAdmission: string;
  capabilities: string;
  schedule: string;
  environmentGenerator: string;
  productionReference: string;
  buildReceipt: string;
}

interface SlotPaths {
  root: string;
  log: string;
  status: string;
  speed: {
    root: string;
    home: string;
    artifacts: string;
    workspace: string;
    checkpoints: string;
    batch: string;
    receipt: string;
  };
  official: {
    root: string;
    home: string;
    artifacts: string;
    execution: string;
    state: string;
    records: string;
    verification: string;
    admission: string;
    preflight: string;
    checkpoint: string;
    run: string;
    score: string;
    package: string;
    submissionReceipt: string;
    environment: string;
    verifierRecords: string;
  };
}

interface CommandStep {
  name: string;
  executable: string;
  args: readonly string[];
  output?: string;
  capture?: 'submission' | 'verifier';
}

interface OfficialRunPublicationSummary {
  total_results: number;
  non_semantic_results: number;
  failure_kinds: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCommandReceipt(stdout: string, stepName: string): Record<string, unknown> {
  assert.ok(stdout.trim(), `${stepName} did not produce a receipt`);
  const record: unknown = JSON.parse(stdout);
  assert.ok(isRecord(record), `${stepName} receipt is invalid`);
  return record;
}

export function verifierRetryPolicyArguments(): readonly string[] {
  return ['--max-retries', '10', '--backoff-ms', '1000'];
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  assert.ok(typeof value === 'string', `${label} must be a string`);
  assert.ok(isAbsolute(value), `${label} must be absolute`);
  assert.equal(resolve(value), value, `${label} must be canonical`);
  return value;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  assert.ok(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum,
    `${label} must be between 1 and ${maximum}`,
  );
  return value;
}

export function readContinuousObservationConfiguration(
  path: string,
): ContinuousObservationConfiguration {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(isRecord(value), 'continuous observation configuration must be an object');
  assert.deepEqual(Object.keys(value).toSorted(), [
    'build_receipt_sha256',
    'codex_auth_source',
    'endpoint',
    'observer_runner',
    'official_jobs',
    'production_reference_sha256',
    'release_root',
    'schema_version',
    'source_root',
    'speed_jobs',
    'speed_trials',
    'state_root',
    'verifier_replay_jobs',
  ]);
  assert.equal(value.schema_version, CONFIG_SCHEMA);
  const endpoint = new URL(String(value.endpoint));
  assert.equal(endpoint.protocol, 'https:', 'continuous observation endpoint must use HTTPS');
  assert.ok(
    !endpoint.username &&
      !endpoint.password &&
      endpoint.pathname === '/' &&
      !endpoint.search &&
      !endpoint.hash,
    'continuous observation endpoint must be an HTTPS origin',
  );
  assert.match(String(value.production_reference_sha256), DIGEST_PATTERN);
  assert.match(String(value.build_receipt_sha256), DIGEST_PATTERN);

  return {
    schema_version: CONFIG_SCHEMA,
    release_root: canonicalAbsolutePath(value.release_root, 'release_root'),
    source_root: canonicalAbsolutePath(value.source_root, 'source_root'),
    observer_runner: canonicalAbsolutePath(value.observer_runner, 'observer_runner'),
    state_root: canonicalAbsolutePath(value.state_root, 'state_root'),
    codex_auth_source: canonicalAbsolutePath(value.codex_auth_source, 'codex_auth_source'),
    endpoint: endpoint.origin,
    official_jobs: boundedInteger(value.official_jobs, 'official_jobs', 32),
    verifier_replay_jobs: boundedInteger(value.verifier_replay_jobs, 'verifier_replay_jobs', 32),
    speed_jobs: boundedInteger(value.speed_jobs, 'speed_jobs', 17),
    speed_trials: boundedInteger(value.speed_trials, 'speed_trials', 10),
    production_reference_sha256: String(value.production_reference_sha256),
    build_receipt_sha256: String(value.build_receipt_sha256),
  };
}

function readSchedule(path: string): ScheduleDocument {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(isRecord(value), 'schedule must be an object');
  assert.deepEqual(Object.keys(value).toSorted(), [
    'day_local_time',
    'night_local_time',
    'schema_version',
    'timezone',
  ]);
  assert.equal(value.schema_version, 'aiq.schedule.v1');
  assert.equal(value.timezone, 'UTC');
  assert.equal(value.day_local_time, '15:00');
  assert.equal(value.night_local_time, '03:00');
  return value as unknown as ScheduleDocument;
}

function slotAt(date: Date, hour: 3 | 15): ScheduledSlot {
  const timestampMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour);
  const instant = new Date(timestampMs);
  const slotDate = instant.toISOString().slice(0, 10);
  const occurrence = hour === 3 ? 'night' : 'day';
  return {
    id: `${slotDate}T${String(hour).padStart(2, '0')}-00Z`,
    slotDate,
    occurrence,
    observedAt: `unix-ms:${timestampMs}`,
    timestampMs,
  };
}

export function surroundingScheduledSlots(now: Date): {
  latest: ScheduledSlot;
  next: ScheduledSlot;
} {
  assert.ok(Number.isFinite(now.getTime()), 'current time is invalid');
  const todayNight = slotAt(now, 3);
  const todayDay = slotAt(now, 15);
  if (now.getTime() < todayNight.timestampMs) {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return { latest: slotAt(yesterday, 15), next: todayNight };
  }
  if (now.getTime() < todayDay.timestampMs) return { latest: todayNight, next: todayDay };
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return { latest: todayDay, next: slotAt(tomorrow, 3) };
}

function releasePaths(configuration: ContinuousObservationConfiguration): ReleasePaths {
  const root = configuration.release_root;
  const core = join(root, 'core-a');
  return {
    runner: join(root, 'bin', 'aiq-runner'),
    verifier: join(root, 'bin', 'aiq-verifier'),
    codex: join(root, 'codex-runtime', 'codex'),
    core,
    tasks: join(core, 'tasks'),
    workspaces: join(core, 'baselines'),
    evaluator: join(core, 'evaluator'),
    runtime: join(core, 'toolchain', 'node'),
    toolchain: join(core, 'toolchain'),
    commitment: join(core, 'commitment.json'),
    sealReceipt: join(core, 'receipt.json'),
    calibrationAdmission: join(root, 'calibration-policy-v2', 'admission-v3.json'),
    capabilities: join(root, 'official-r1', 'inputs', 'capabilities.json'),
    schedule: join(root, 'official-r1', 'inputs', 'schedule.json'),
    environmentGenerator: join(root, 'official-r1', 'records', 'generate-verifier-environment.mjs'),
    productionReference: join(root, 'records', 'production-reference.json'),
    buildReceipt: join(root, 'records', 'final-build-receipt.v2.json'),
  };
}

function slotPaths(stateRoot: string, slot: ScheduledSlot): SlotPaths {
  assert.match(slot.id, SLOT_PATTERN);
  const root = join(stateRoot, 'slots', slot.id);
  const speed = join(root, 'speed');
  const official = join(root, 'official');
  const state = join(official, 'state');
  const records = join(official, 'records');
  const verification = join(official, 'verification');
  return {
    root,
    log: join(root, 'operator.log'),
    status: join(root, 'status.json'),
    speed: {
      root: speed,
      home: join(speed, 'codex-home'),
      artifacts: join(speed, 'artifacts'),
      workspace: join(speed, 'workspace'),
      checkpoints: join(speed, 'checkpoints'),
      batch: join(speed, 'batch.json'),
      receipt: join(speed, 'submission.json'),
    },
    official: {
      root: official,
      home: join(official, 'codex-home'),
      artifacts: join(official, 'artifacts'),
      execution: join(official, 'execution'),
      state,
      records,
      verification,
      admission: join(records, 'permission-admission.json'),
      preflight: join(state, 'preflight.json'),
      checkpoint: join(state, 'checkpoint.json'),
      run: join(state, 'run.json'),
      score: join(state, 'score.json'),
      package: join(state, 'package.json'),
      submissionReceipt: join(state, 'submission.json'),
      environment: join(records, 'verifier-environment.json'),
      verifierRecords: join(verification, 'records.jsonl'),
    },
  };
}

function ensureInput(path: string, label: string): void {
  const metadata = statSync(path, { throwIfNoEntry: false });
  assert.ok(metadata?.isFile() || metadata?.isDirectory(), `${label} is missing`);
}

function validateReleaseInputs(
  configuration: ContinuousObservationConfiguration,
  paths: ReleasePaths,
): void {
  for (const path of [
    paths.runner,
    paths.verifier,
    paths.codex,
    paths.core,
    paths.tasks,
    paths.workspaces,
    paths.evaluator,
    paths.runtime,
    paths.toolchain,
    paths.commitment,
    paths.sealReceipt,
    paths.calibrationAdmission,
    paths.capabilities,
    paths.schedule,
    paths.environmentGenerator,
    paths.productionReference,
    paths.buildReceipt,
  ]) {
    ensureInput(path, 'release input');
  }
  ensureInput(configuration.observer_runner, 'observer_runner');
  ensureInput(configuration.source_root, 'source_root');
  ensureInput(configuration.codex_auth_source, 'codex_auth_source');
  readSchedule(paths.schedule);
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function runUtility(executable: string, args: readonly string[]): void {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${executable} failed: ${(result.stderr || result.stdout).trim().slice(0, 512)}`,
    );
  }
}

function prepareCodexHome(home: string, authSource: string): void {
  privateDirectory(home);
  const target = join(home, 'auth.json');
  if (existsSync(target)) return;
  copyFileSync(authSource, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
  if (process.platform === 'darwin') runUtility('/usr/bin/chflags', ['uchg', target]);
}

function cleanupCodexHome(home: string): void {
  const auth = join(home, 'auth.json');
  if (existsSync(auth) && process.platform === 'darwin') {
    runUtility('/usr/bin/chflags', ['nouchg', auth]);
  }
  rmSync(home, { recursive: true, force: true });
}

function appendLog(path: string, event: string, detail: string): void {
  const safe = detail.replaceAll(/[\r\n]+/g, ' ').slice(0, 1000);
  writeFileSync(path, `${new Date().toISOString()} ${event} ${safe}\n`, {
    flag: 'a',
    mode: 0o600,
  });
}

function writeStatus(path: string, slot: ScheduledSlot, phase: string, detail: string): void {
  const document = {
    schema_version: STATUS_SCHEMA,
    slot_id: slot.id,
    observed_at: slot.observedAt,
    phase,
    detail,
    updated_at: new Date().toISOString(),
  };
  const temporary = `${path}.new`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function retainedStatusPhase(path: string): string | null {
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(isRecord(value), 'continuous observation status must be an object');
  return typeof value.phase === 'string' ? value.phase : null;
}

export function summarizeOfficialRunPublication(path: string): OfficialRunPublicationSummary {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(isRecord(value) && Array.isArray(value.results), 'Official run results are invalid');
  assert.ok(value.results.length > 0, 'Official run results are empty');

  const failureKinds: Record<string, number> = {};
  let nonSemanticResults = 0;
  for (const result of value.results) {
    assert.ok(isRecord(result), 'Official run result is invalid');
    const semantic =
      result.status === 'completed' &&
      typeof result.task_score === 'number' &&
      Number.isFinite(result.task_score) &&
      result.task_score >= 0 &&
      result.task_score <= 1;
    if (semantic) continue;

    nonSemanticResults += 1;
    const kind =
      isRecord(result.failure) && typeof result.failure.kind === 'string'
        ? result.failure.kind
        : typeof result.status === 'string'
          ? result.status
          : 'unknown';
    failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
  }

  return {
    total_results: value.results.length,
    non_semantic_results: nonSemanticResults,
    failure_kinds: failureKinds,
  };
}

function unpublishedOfficialDetail(summary: OfficialRunPublicationSummary): string {
  const failures = Object.entries(summary.failure_kinds)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ');
  return `speed published; Official preserved but not published: ${summary.non_semantic_results}/${summary.total_results} non-semantic result(s)${failures ? ` (${failures})` : ''}; no model rerun`;
}

function commandFailure(step: CommandStep, stderr: string, status: number | null): Error {
  const detail = stderr
    .trim()
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 1000);
  return new Error(`${step.name} failed with status ${String(status)}: ${detail}`);
}

function runCommand(step: CommandStep, logPath: string): string {
  appendLog(logPath, 'step_started', step.name);
  const logDescriptor = openSync(logPath, 'a', 0o600);
  try {
    const capture = step.capture !== undefined;
    const result = spawnSync(step.executable, step.args, {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', capture ? 'pipe' : logDescriptor, capture ? 'pipe' : logDescriptor],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw commandFailure(step, capture ? result.stderr : '', result.status);
    }
    appendLog(logPath, 'step_completed', step.name);
    return capture ? result.stdout.trim() : '';
  } finally {
    closeSync(logDescriptor);
  }
}

function runCreateOnceStep(step: CommandStep, paths: SlotPaths, slot: ScheduledSlot): void {
  if (step.output && existsSync(step.output)) return;
  writeStatus(paths.status, slot, step.name, 'running');
  const stdout = runCommand(step, paths.log);
  if (!step.capture || !step.output) return;
  const record = parseCommandReceipt(stdout, step.name);
  if (step.capture === 'submission') {
    const kind = isRecord(record.package) ? record.package.kind : record.kind;
    assert.ok(kind === 'accepted' || kind === 'duplicate', `${step.name} was not accepted`);
  } else {
    assert.equal(record.disposition, 'verified', `${step.name} did not publish verified evidence`);
  }
  writeFileSync(step.output, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
}

function speedSteps(
  configuration: ContinuousObservationConfiguration,
  release: ReleasePaths,
  paths: SlotPaths,
  slot: ScheduledSlot,
): readonly CommandStep[] {
  return [
    {
      name: 'speed_observe',
      executable: configuration.observer_runner,
      output: paths.speed.batch,
      args: [
        'observe-speed',
        '--corpus-commitment',
        release.commitment,
        '--evaluator-runtime',
        release.runtime,
        '--codex-toolchain-root',
        release.toolchain,
        '--codex-binary',
        release.codex,
        '--codex-home',
        paths.speed.home,
        '--artifact-root',
        paths.speed.artifacts,
        '--workspace-root',
        paths.speed.workspace,
        '--checkpoint-root',
        paths.speed.checkpoints,
        '--observed-at',
        slot.observedAt,
        '--trials',
        String(configuration.speed_trials),
        '--jobs',
        String(configuration.speed_jobs),
        '--output',
        paths.speed.batch,
      ],
    },
    {
      name: 'speed_submit',
      executable: configuration.observer_runner,
      output: paths.speed.receipt,
      capture: 'submission',
      args: [
        'submit-speed',
        '--observation',
        paths.speed.batch,
        '--endpoint',
        configuration.endpoint,
      ],
    },
  ];
}

function officialSteps(
  configuration: ContinuousObservationConfiguration,
  release: ReleasePaths,
  paths: SlotPaths,
  slot: ScheduledSlot,
): readonly CommandStep[] {
  const commonPlan = [
    '--hidden-tasks',
    release.tasks,
    '--corpus-commitment',
    release.commitment,
    '--source-root',
    configuration.source_root,
    '--capabilities',
    release.capabilities,
    '--workspace-root',
    release.workspaces,
    '--execution-root',
    paths.official.execution,
    '--evaluator-root',
    release.evaluator,
    '--evaluator-runtime',
    release.runtime,
    '--codex-toolchain-root',
    release.toolchain,
    '--schedule',
    release.schedule,
    '--slot-date',
    slot.slotDate,
    '--occurrence',
    slot.occurrence,
    '--observed-at',
    slot.observedAt,
    '--codex-binary',
    release.codex,
    '--codex-home',
    paths.official.home,
    '--artifact-root',
    paths.official.artifacts,
    '--preflight-cache',
    paths.official.preflight,
    '--checkpoint',
    paths.official.checkpoint,
    '--jobs',
    String(configuration.official_jobs),
  ];
  return [
    {
      name: 'official_admit',
      executable: release.runner,
      output: paths.official.admission,
      args: [
        'admit-permissions',
        ...commonPlan,
        '--calibration-admission',
        release.calibrationAdmission,
        '--planned-output',
        paths.official.run,
        '--planned-score-output',
        paths.official.score,
        '--planned-package-output',
        paths.official.package,
        '--output',
        paths.official.admission,
      ],
    },
    {
      name: 'official_preflight',
      executable: release.runner,
      output: paths.official.preflight,
      args: [
        'preflight',
        '--capabilities',
        release.capabilities,
        '--corpus-commitment',
        release.commitment,
        '--evaluator-runtime',
        release.runtime,
        '--codex-toolchain-root',
        release.toolchain,
        '--codex-binary',
        release.codex,
        '--codex-home',
        paths.official.home,
        '--artifact-root',
        paths.official.artifacts,
        '--expires-in-seconds',
        '86400',
        '--output',
        paths.official.preflight,
        '--official-admission',
        paths.official.admission,
      ],
    },
    {
      name: 'official_run',
      executable: release.runner,
      output: paths.official.run,
      args: [
        'run',
        ...commonPlan,
        '--official-admission',
        paths.official.admission,
        '--run-class',
        'official',
        '--output',
        paths.official.run,
      ],
    },
    {
      name: 'official_score',
      executable: release.runner,
      output: paths.official.score,
      args: [
        'score',
        '--hidden-tasks',
        release.tasks,
        '--results',
        paths.official.run,
        '--official-admission',
        paths.official.admission,
        '--output',
        paths.official.score,
      ],
    },
    {
      name: 'official_package',
      executable: release.runner,
      output: paths.official.package,
      args: [
        'package',
        '--run',
        paths.official.run,
        '--artifact-root',
        paths.official.artifacts,
        '--execution-concurrency',
        String(configuration.official_jobs),
        '--official-admission',
        paths.official.admission,
        '--output',
        paths.official.package,
      ],
    },
    {
      name: 'official_submit',
      executable: release.runner,
      output: paths.official.submissionReceipt,
      capture: 'submission',
      args: [
        'submit',
        '--package',
        paths.official.package,
        '--artifact-root',
        paths.official.artifacts,
        '--endpoint',
        configuration.endpoint,
        '--artifact-upload-concurrency',
        '8',
      ],
    },
    {
      name: 'official_environment',
      executable: process.execPath,
      output: paths.official.environment,
      args: [
        release.environmentGenerator,
        paths.official.package,
        release.commitment,
        release.sealReceipt,
        release.buildReceipt,
        release.productionReference,
        paths.official.environment,
      ],
    },
    {
      name: 'official_verify_publish',
      executable: release.verifier,
      output: paths.official.verifierRecords,
      capture: 'verifier',
      args: [
        '--endpoint',
        configuration.endpoint,
        '--tasks',
        release.tasks,
        '--environment',
        paths.official.environment,
        '--evaluator-root',
        release.evaluator,
        '--corpus-commitment',
        release.commitment,
        '--codex-toolchain-root',
        release.toolchain,
        '--evaluator-runtime',
        release.runtime,
        '--calibration-admission',
        release.calibrationAdmission,
        '--source-root',
        configuration.source_root,
        '--runner-binary',
        release.runner,
        '--codex-binary',
        release.codex,
        '--production-reference',
        release.productionReference,
        '--expected-production-reference-sha256',
        configuration.production_reference_sha256,
        '--build-receipt',
        release.buildReceipt,
        '--expected-build-receipt-sha256',
        configuration.build_receipt_sha256,
        '--replay-root',
        join(paths.official.verification, 'replay'),
        '--replay-jobs',
        String(configuration.verifier_replay_jobs),
        '--max-claims',
        '1',
        '--max-idle-polls',
        '1',
        ...verifierRetryPolicyArguments(),
      ],
    },
  ];
}

function requireSecrets(environment: Readonly<Record<string, string | undefined>>): void {
  const missing = REQUIRED_SECRETS.filter((name) => !environment[name]?.trim());
  assert.deepEqual(missing, [], `missing exact runtime secrets: ${missing.join(', ')}`);
}

function acquireLock(stateRoot: string): () => void {
  privateDirectory(stateRoot);
  const path = join(stateRoot, 'active.lock');
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    const owner = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (Number.isSafeInteger(owner) && owner > 0) {
      let running = true;
      try {
        process.kill(owner, 0);
      } catch {
        running = false;
      }
      if (running) {
        throw new Error(`continuous observation is already running as process ${owner}`, {
          cause: error,
        });
      }
    }
    unlinkSync(path);
    writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  }
  return () => rmSync(path, { force: true });
}

function prepareSlotDirectories(paths: SlotPaths): void {
  for (const path of [
    paths.root,
    paths.speed.root,
    paths.speed.artifacts,
    paths.speed.workspace,
    paths.speed.checkpoints,
    paths.official.root,
    paths.official.artifacts,
    paths.official.execution,
    paths.official.state,
    paths.official.records,
    paths.official.verification,
    join(paths.official.verification, 'replay'),
  ]) {
    privateDirectory(path);
  }
}

function cleanupCompletedSlot(paths: SlotPaths): void {
  cleanupCodexHome(paths.speed.home);
  cleanupCodexHome(paths.official.home);
  for (const path of [
    paths.speed.workspace,
    paths.speed.artifacts,
    paths.speed.checkpoints,
    paths.official.execution,
    paths.official.artifacts,
    join(paths.official.verification, 'replay'),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
}

function cleanupCompletedSpeed(paths: SlotPaths): void {
  cleanupCodexHome(paths.speed.home);
  for (const path of [paths.speed.workspace, paths.speed.artifacts, paths.speed.checkpoints]) {
    rmSync(path, { recursive: true, force: true });
  }
}

export function scheduleStatus(
  configuration: ContinuousObservationConfiguration,
  now = new Date(),
): Record<string, unknown> {
  const release = releasePaths(configuration);
  readSchedule(release.schedule);
  const { latest, next } = surroundingScheduledSlots(now);
  const paths = slotPaths(configuration.state_root, latest);
  const retained = existsSync(paths.status)
    ? (JSON.parse(readFileSync(paths.status, 'utf8')) as unknown)
    : null;
  return {
    schema_version: STATUS_SCHEMA,
    checked_at: now.toISOString(),
    latest_slot: latest,
    latest_slot_state: retained,
    next_slot: next,
  };
}

export function runDueContinuousObservation(
  configuration: ContinuousObservationConfiguration,
  now = new Date(),
): void {
  requireSecrets(process.env);
  const release = releasePaths(configuration);
  validateReleaseInputs(configuration, release);
  const slot = surroundingScheduledSlots(now).latest;
  const paths = slotPaths(configuration.state_root, slot);
  const releaseLock = acquireLock(configuration.state_root);
  try {
    prepareSlotDirectories(paths);
    if (retainedStatusPhase(paths.status) === 'complete_with_unpublished_official') {
      cleanupCodexHome(paths.speed.home);
      cleanupCodexHome(paths.official.home);
      return;
    }
    if (existsSync(paths.official.verifierRecords) && existsSync(paths.speed.receipt)) {
      cleanupCompletedSlot(paths);
      writeStatus(paths.status, slot, 'complete', 'already complete');
      return;
    }
    prepareCodexHome(paths.speed.home, configuration.codex_auth_source);
    try {
      for (const step of speedSteps(configuration, release, paths, slot)) {
        runCreateOnceStep(step, paths, slot);
      }
    } finally {
      cleanupCodexHome(paths.speed.home);
    }
    cleanupCompletedSpeed(paths);
    prepareCodexHome(paths.official.home, configuration.codex_auth_source);
    try {
      for (const step of officialSteps(configuration, release, paths, slot)) {
        runCreateOnceStep(step, paths, slot);
        if (step.name !== 'official_run') continue;

        const summary = summarizeOfficialRunPublication(paths.official.run);
        if (summary.non_semantic_results === 0) continue;

        writeStatus(
          paths.status,
          slot,
          'complete_with_unpublished_official',
          unpublishedOfficialDetail(summary),
        );
        return;
      }
    } finally {
      cleanupCodexHome(paths.official.home);
    }
    writeStatus(paths.status, slot, 'complete', 'speed and Official evidence published');
    cleanupCompletedSlot(paths);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    privateDirectory(paths.root);
    appendLog(paths.log, 'slot_failed', detail);
    writeStatus(paths.status, slot, 'retryable_failure', detail.slice(0, 1000));
    throw error;
  } finally {
    releaseLock();
  }
}

function main(): void {
  const [command, configurationPath] = process.argv.slice(2);
  assert.ok(command === 'status' || command === 'run-due', 'usage: status|run-due <config.json>');
  assert.ok(configurationPath, 'configuration path is required');
  const configuration = readContinuousObservationConfiguration(configurationPath);
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(scheduleStatus(configuration), null, 2)}\n`);
    return;
  }
  runDueContinuousObservation(configuration);
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) main();
