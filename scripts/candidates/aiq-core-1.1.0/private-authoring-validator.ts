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

interface SourceCounterexampleChildResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
}

export interface PrivateAuthoringResponseSources {
  readonly prompt: readonly string[];
  readonly workspace_allowlist: readonly string[];
  readonly progress_binding: readonly string[];
  readonly evaluator_imports: readonly string[];
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

function exactStringArray(observedValue: unknown, expectedValue: unknown, label: string): void {
  const observed = stringArray(observedValue, `${label} observed locations`);
  const expected = stringArray(expectedValue, `${label} expected locations`);
  if (
    observed.length === 0 ||
    expected.length === 0 ||
    new Set(observed).size !== observed.length ||
    new Set(expected).size !== expected.length ||
    observed.some(
      (location) =>
        location.length === 0 ||
        location.startsWith('/') ||
        location.split('/').some((component) => component === '.' || component === '..'),
    ) ||
    expected.some(
      (location) =>
        location.length === 0 ||
        location.startsWith('/') ||
        location.split('/').some((component) => component === '.' || component === '..'),
    ) ||
    observed.length !== expected.length ||
    observed.some((location, index) => location !== expected[index])
  ) {
    throw new TypeError(`${label} response locations do not match task-owned source.`);
  }
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
  taskOwnedLocationsValue: unknown,
  label: string,
): void {
  const responseContract = jsonObject(responseContractValue, `${label} response contract`);
  assertSchemaOwnedResponseFieldTypes(responseContract, label);
  exactStringArray(responseContract.locations, taskOwnedLocationsValue, label);
}

export function assertPrivateAuthoringResponseContract(
  responseContractValue: unknown,
  sources: unknown,
  label: string,
): void {
  const responseContract = jsonObject(responseContractValue, `${label} response contract`);
  const sourceRecord = jsonObject(sources, `${label} private authoring sources`);
  const expectedOwners = ['evaluator_imports', 'progress_binding', 'prompt', 'workspace_allowlist'];
  if (JSON.stringify(Object.keys(sourceRecord).toSorted()) !== JSON.stringify(expectedOwners)) {
    throw new TypeError(`${label} private authoring source owners are incomplete.`);
  }
  assertSchemaOwnedResponseFieldTypes(responseContract, label);
  for (const [owner, locations] of Object.entries(sourceRecord)) {
    exactStringArray(responseContract.locations, locations, `${label} ${owner}`);
  }
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
