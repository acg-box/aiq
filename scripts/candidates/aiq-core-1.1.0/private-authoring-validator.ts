const RESPONSE_FIELD_TYPES = Object.freeze([
  'array',
  'artifact',
  'boolean',
  'module',
  'null',
  'number',
  'object',
  'string',
] as const);

export { RESPONSE_FIELD_TYPES };

type JsonObject = Record<string, unknown>;

export type ResponseMode = 'final_response' | 'workspace';

export interface TaskResponseSourceAuthority {
  readonly response_mode: ResponseMode;
  readonly response_locations: readonly string[];
}

type ProjectionApplicability = 'not_applicable' | 'required';

interface PrivateSourceProjection {
  readonly applicability: ProjectionApplicability;
  readonly locations: readonly string[];
}

export interface PrivateAuthoringResponseValidation {
  readonly response_mode: ResponseMode;
  readonly response_locations: readonly string[];
  readonly response_mode_authority: 'private_task_evaluator_workspace_policy';
  readonly projections: {
    readonly prompt: PrivateSourceProjection;
    readonly workspace_allowlist: PrivateSourceProjection;
    readonly workspace_changes: PrivateSourceProjection;
    readonly progress_files: PrivateSourceProjection;
    readonly evaluator_sources: PrivateSourceProjection;
  };
}

interface SourceCounterexampleChildResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a string array.`);
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new TypeError(`${label} item ${String(index)} must be a string.`);
    }
    return item;
  });
}

function unknownArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function responseLocations(
  value: unknown,
  mode: ResponseMode,
  label: string,
  allowEmpty = false,
): readonly string[] {
  const locations = stringArray(value, label);
  if (
    (!allowEmpty && locations.length === 0) ||
    new Set(locations).size !== locations.length ||
    locations.some(
      (location) =>
        location.length === 0 ||
        location.startsWith('/') ||
        location.split('/').some((component) => component === '.' || component === '..'),
    ) ||
    (mode === 'final_response' && (locations.length !== 1 || locations[0] !== 'final_response')) ||
    (mode === 'workspace' && locations.includes('final_response'))
  ) {
    throw new TypeError(`${label} response locations are invalid for ${mode}.`);
  }
  return locations;
}

function exactStringArray(
  observed: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    observed.length !== expected.length ||
    observed.some((location, index) => location !== expected[index])
  ) {
    throw new TypeError(`${label} response locations do not match task-owned source.`);
  }
}

function responseMode(value: unknown, label: string): ResponseMode {
  if (value !== 'final_response' && value !== 'workspace') {
    throw new TypeError(`${label} response mode is invalid.`);
  }
  return value;
}

export function parseTaskResponseSourceAuthority(
  value: unknown,
  label: string,
): TaskResponseSourceAuthority {
  const authority = jsonObject(value, `${label} task response-source authority`);
  const mode = responseMode(authority.response_mode, label);
  return {
    response_mode: mode,
    response_locations: responseLocations(
      authority.response_locations,
      mode,
      `${label} task-owned response locations`,
    ),
  };
}

export function assertSchemaOwnedResponseFieldTypes(
  responseContractValue: unknown,
  label: string,
): void {
  const responseContract = jsonObject(responseContractValue, `${label} response contract`);
  const fieldTypes = jsonObject(responseContract.field_types, `${label} response field types`);
  const allowed = new Set<string>(RESPONSE_FIELD_TYPES);
  if (Object.keys(fieldTypes).length === 0) {
    throw new TypeError(`${label} response field types must not be empty.`);
  }
  for (const [field, type] of Object.entries(fieldTypes)) {
    if (typeof type !== 'string' || !allowed.has(type)) {
      throw new TypeError(`${label} response field ${field} type must use the schema-owned enum.`);
    }
  }
}

export function assertGeneratedResponseContract(
  responseContractValue: unknown,
  taskOwnedAuthorityValue: unknown,
  label: string,
): void {
  const responseContract = jsonObject(responseContractValue, `${label} response contract`);
  const authority = parseTaskResponseSourceAuthority(taskOwnedAuthorityValue, label);
  assertSchemaOwnedResponseFieldTypes(responseContract, label);
  const contractMode = responseMode(responseContract.transport, `${label} response contract`);
  if (contractMode !== authority.response_mode) {
    throw new TypeError(`${label} response mode does not match task-owned source.`);
  }
  const contractLocations = responseLocations(
    responseContract.locations,
    contractMode,
    `${label} response contract locations`,
  );
  exactStringArray(contractLocations, authority.response_locations, label);
}

function privateTaskText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      throw new TypeError(`${label} must contain UTF-8 task bytes.`);
    }
  }
  throw new TypeError(`${label} must be a UTF-8 string or byte array.`);
}

function privateTask(value: unknown, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(privateTaskText(value, label)) as unknown;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('UTF-8')) throw error;
    throw new TypeError(`${label} must contain one JSON task object.`, { cause: error });
  }
  return jsonObject(parsed, label);
}

function evaluatorSourceText(value: unknown, key: string | undefined, output: string[]): void {
  if (typeof value === 'string') {
    if (
      key !== undefined &&
      ['import', 'imports', 'source', 'source_ref', 'source_refs'].includes(key)
    ) {
      output.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) evaluatorSourceText(child, key, output);
    return;
  }
  if (isJsonObject(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      evaluatorSourceText(child, childKey, output);
    }
  }
}

function requiredProjection(
  source: string | readonly string[],
  locations: readonly string[],
  label: string,
): PrivateSourceProjection {
  const observed = locations.filter((location) =>
    typeof source === 'string' ? source.includes(location) : source.includes(location),
  );
  exactStringArray(observed, locations, label);
  return { applicability: 'required', locations: observed };
}

function notApplicableProjection(): PrivateSourceProjection {
  return { applicability: 'not_applicable', locations: [] };
}

export function derivePrivateTaskResponseAuthority(
  privateTaskBytes: unknown,
  label: string,
): PrivateAuthoringResponseValidation {
  const task = privateTask(privateTaskBytes, `${label} private task bytes`);
  if (typeof task.prompt !== 'string' || task.prompt.trim().length === 0) {
    throw new TypeError(`${label} private task prompt is invalid.`);
  }
  const evaluator = jsonObject(task.evaluator, `${label} private task evaluator`);
  const external = jsonObject(evaluator.external, `${label} private task external evaluator`);
  const configuration = jsonObject(
    external.configuration,
    `${label} private task evaluator configuration`,
  );
  const checks = unknownArray(configuration.checks, `${label} private task evaluator checks`).map(
    (check, index) => jsonObject(check, `${label} private task evaluator check ${String(index)}`),
  );
  if (checks.length === 0) throw new TypeError(`${label} private task evaluator has no checks.`);

  const workspaceChecks = checks.filter((check) => check.type === 'workspace_policy');
  if (workspaceChecks.length > 1) {
    throw new TypeError(`${label} private task has multiple workspace authorities.`);
  }
  const sourceValues: string[] = [];
  evaluatorSourceText(checks, undefined, sourceValues);
  const source = sourceValues.join('\n');

  if (workspaceChecks.length === 0) {
    const authority = {
      response_mode: 'final_response',
      response_locations: ['final_response'],
    } as const;
    return {
      ...authority,
      response_mode_authority: 'private_task_evaluator_workspace_policy',
      projections: {
        prompt: notApplicableProjection(),
        workspace_allowlist: notApplicableProjection(),
        workspace_changes: notApplicableProjection(),
        progress_files: notApplicableProjection(),
        evaluator_sources: requiredProjection(
          source,
          authority.response_locations,
          `${label} evaluator sources`,
        ),
      },
    };
  }

  const workspace = workspaceChecks[0];
  if (workspace === undefined) throw new TypeError(`${label} workspace authority is missing.`);
  const expectedFiles = jsonObject(
    workspace.expected_file_sha256,
    `${label} workspace expected-file authority`,
  );
  const locations = responseLocations(
    Object.keys(expectedFiles).toSorted(),
    'workspace',
    `${label} workspace change locations`,
  );
  const allowlistedFiles = responseLocations(
    workspace.allowlisted_files,
    'workspace',
    `${label} workspace allowlist`,
    true,
  );
  const progressFiles = responseLocations(
    workspace.progress_files ?? [],
    'workspace',
    `${label} progress files`,
    true,
  );

  return {
    response_mode: 'workspace',
    response_locations: locations,
    response_mode_authority: 'private_task_evaluator_workspace_policy',
    projections: {
      prompt: requiredProjection(task.prompt, locations, `${label} prompt references`),
      workspace_allowlist: requiredProjection(
        allowlistedFiles,
        locations,
        `${label} workspace allowlist`,
      ),
      workspace_changes: { applicability: 'required', locations },
      progress_files:
        progressFiles.length === 0
          ? notApplicableProjection()
          : requiredProjection(progressFiles, locations, `${label} progress files`),
      evaluator_sources: requiredProjection(source, locations, `${label} evaluator sources`),
    },
  };
}

export function assertPrivateAuthoringResponseContract(
  responseContractValue: unknown,
  privateTaskBytes: unknown,
  label: string,
): PrivateAuthoringResponseValidation {
  const authority = derivePrivateTaskResponseAuthority(privateTaskBytes, label);
  assertGeneratedResponseContract(responseContractValue, authority, label);
  return authority;
}

const SOURCE_COUNTEREXAMPLE_EVIDENCE_BYTES = 2_048;

function boundedEvidence(value: string | Buffer | null | undefined): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '', 'utf8');
  const bounded = bytes.subarray(0, SOURCE_COUNTEREXAMPLE_EVIDENCE_BYTES).toString('utf8');
  return bytes.length > SOURCE_COUNTEREXAMPLE_EVIDENCE_BYTES ? `${bounded}\n[truncated]` : bounded;
}

export function sourceCounterexampleChildDiagnostic(
  label: string,
  child: SourceCounterexampleChildResult,
): string {
  return JSON.stringify({
    label,
    child_status: child.status,
    signal: child.signal,
    error: child.error === undefined ? null : String(child.error),
    stdout: boundedEvidence(child.stdout),
    stderr: boundedEvidence(child.stderr),
  });
}

export function assertSourceCounterexampleRejected(
  label: string,
  child: SourceCounterexampleChildResult,
  expectedEvidence: string,
): string {
  if (expectedEvidence.trim().length === 0) {
    throw new TypeError('Expected source-counterexample evidence must not be empty.');
  }
  const diagnostic = sourceCounterexampleChildDiagnostic(label, child);
  const evidence = `${boundedEvidence(child.stdout)}\n${boundedEvidence(child.stderr)}`;
  if (
    child.error !== undefined ||
    child.signal !== null ||
    child.status !== 1 ||
    !evidence.includes(expectedEvidence)
  ) {
    throw new Error(`Source counterexample did not fail through its validator: ${diagnostic}`);
  }
  return diagnostic;
}
