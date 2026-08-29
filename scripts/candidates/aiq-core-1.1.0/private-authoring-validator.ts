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

function evaluatorPathTargets(value: unknown, key: string | undefined, output: string[]): void {
  if (key === 'path') {
    if (typeof value !== 'string') {
      throw new TypeError('Private task evaluator target paths must be strings.');
    }
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) evaluatorPathTargets(child, undefined, output);
    return;
  }
  if (isJsonObject(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      evaluatorPathTargets(child, childKey, output);
    }
  }
}

function evaluatorSourceText(value: unknown, key: string | undefined, output: string[]): void {
  if (typeof value === 'string') {
    if (key === 'source') output.push(value);
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

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function digestMapPaths(value: unknown, label: string): readonly string[] {
  const digests = jsonObject(value, label);
  const paths = responseLocations(Object.keys(digests), 'workspace', `${label} paths`, true);
  for (const [path, digest] of Object.entries(digests)) {
    if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
      throw new TypeError(`${label} digest for ${path} is invalid.`);
    }
  }
  return paths;
}

export function derivePrivateTaskResponseAuthority(
  privateTaskBytes: unknown,
  label: string,
): TaskResponseSourceAuthority {
  const task = privateTask(privateTaskBytes, `${label} private task bytes`);
  if (typeof task.prompt !== 'string' || task.prompt.trim().length === 0) {
    throw new TypeError(`${label} private task prompt is invalid.`);
  }
  const prompt = task.prompt;
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

  const completeWorkspaceChecks = checks.filter(
    (check) => check.check_id === 'complete_workspace_policy',
  );
  if (completeWorkspaceChecks.length !== 1) {
    throw new TypeError(`${label} private task must have exactly one complete workspace policy.`);
  }
  const completeWorkspace = completeWorkspaceChecks[0];
  if (
    completeWorkspace === undefined ||
    completeWorkspace.type !== 'workspace_policy' ||
    completeWorkspace.hard_gate !== true
  ) {
    throw new TypeError(`${label} complete workspace policy must be a hard gate.`);
  }

  const allowlistedFiles = responseLocations(
    completeWorkspace.allowlisted_files,
    'workspace',
    `${label} complete workspace allowlist`,
  );
  const allowlisted = new Set(allowlistedFiles);
  const protectedFiles = digestMapPaths(
    completeWorkspace.expected_file_sha256,
    `${label} complete workspace expected-file authority`,
  );
  if (protectedFiles.some((path) => !allowlisted.has(path))) {
    throw new TypeError(`${label} protected workspace inputs must be allowlisted.`);
  }
  const protectedSet = new Set(protectedFiles);
  const mutableFiles = allowlistedFiles.filter((path) => !protectedSet.has(path));
  const mutable = new Set(mutableFiles);
  const progressFiles: string[] = [];

  const workspaceChecks = checks.filter((check) => check.type === 'workspace_policy');
  for (const [index, check] of workspaceChecks.entries()) {
    const checkLabel = `${label} workspace policy ${String(index)}`;
    if (check.allowlisted_files !== undefined) {
      const corroboratingAllowlist = responseLocations(
        check.allowlisted_files,
        'workspace',
        `${checkLabel} allowlist`,
        true,
      );
      if (corroboratingAllowlist.some((path) => !allowlisted.has(path))) {
        throw new TypeError(`${checkLabel} allowlist exceeds the complete workspace policy.`);
      }
    }
    if (check.expected_file_sha256 !== undefined) {
      const expectedFiles = digestMapPaths(
        check.expected_file_sha256,
        `${checkLabel} expected-file evidence`,
      );
      if (expectedFiles.some((path) => !protectedSet.has(path))) {
        throw new TypeError(`${checkLabel} expected files do not corroborate protected inputs.`);
      }
    }
    for (const field of ['required_changed_from_sha256', 'progress_changed_from_sha256']) {
      if (check[field] === undefined) continue;
      const changedFiles = digestMapPaths(check[field], `${checkLabel} ${field} evidence`);
      if (changedFiles.some((path) => !mutable.has(path))) {
        throw new TypeError(`${checkLabel} ${field} files must be mutable and allowlisted.`);
      }
    }
    if (check.progress_files !== undefined) {
      const progress = responseLocations(
        check.progress_files,
        'workspace',
        `${checkLabel} progress files`,
        true,
      );
      if (progress.some((path) => !mutable.has(path))) {
        throw new TypeError(`${checkLabel} progress files must be mutable and allowlisted.`);
      }
      progressFiles.push(...progress);
    }
  }

  if (
    checks.some((check) => typeof check.type === 'string' && check.type.startsWith('response_'))
  ) {
    return { response_mode: 'final_response', response_locations: ['final_response'] };
  }

  const evaluatorTargets: string[] = [];
  evaluatorPathTargets(checks, undefined, evaluatorTargets);
  for (const [index, target] of evaluatorTargets.entries()) {
    responseLocations([target], 'workspace', `${label} evaluator target path ${String(index)}`);
    if (!mutable.has(target)) {
      throw new TypeError(`${label} evaluator target paths must be mutable and allowlisted.`);
    }
  }

  let locations = [...new Set([...progressFiles, ...evaluatorTargets])];
  if (locations.length === 0) {
    const sourceValues: string[] = [];
    evaluatorSourceText(checks, undefined, sourceValues);
    locations = mutableFiles.filter((path) => sourceValues.some((source) => source.includes(path)));
  }
  const canonicalLocations = responseLocations(
    locations,
    'workspace',
    `${label} derived workspace response locations`,
  );
  if (canonicalLocations.some((location) => !prompt.includes(location))) {
    throw new TypeError(`${label} prompt must cover every workspace response location.`);
  }

  return {
    response_mode: 'workspace',
    response_locations: canonicalLocations,
  };
}

export function assertPrivateAuthoringResponseContract(
  responseContractValue: unknown,
  privateTaskBytes: unknown,
  label: string,
): TaskResponseSourceAuthority {
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
