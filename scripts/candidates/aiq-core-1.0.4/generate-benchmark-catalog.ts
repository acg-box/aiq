import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog as buildPriorCatalog } from '../aiq-core-1.0.3/generate-benchmark-catalog.ts';

// Canonical public-surface generator for AIQ Core 1.0.4. The private prompt,
// fixture, evaluator, and expected-output sources remain outside Git.

const TASK_SET_VERSION = '1.0.4' as const;
const TASK_VERSION = '1.0.4' as const;
const SCORER_VERSION = '1.0.4' as const;
const GENERATOR_PATH = 'scripts/candidates/aiq-core-1.0.4/generate-benchmark-catalog.ts';

export const AIQ_CORE_1_0_4_TASK_METADATA_IDENTITY_SHA256 =
  'sha256:3c8ca814f8210a99dd26202b034c8e74137da57302bdaf25dc556c04efbae6d7';
export const AIQ_CORE_1_0_4_CATALOG_RELEASE_IDENTITY_SHA256 =
  'sha256:8667118ddc9999de7857b255c4e33125c42290195a4ecb2de53de37c84f61b41';

type JsonObject = Record<string, unknown>;
type PriorCatalog = ReturnType<typeof buildPriorCatalog>;
type PriorTask = PriorCatalog['tasks'][number];

interface RevisionSpec {
  readonly kind?: 'contract_repaired';
  readonly objective: string;
  readonly taskSpecificDelta: string;
  readonly summary: string;
  readonly inputKind: string;
  readonly passConditions: readonly [string, string, string, string];
}

export type RevisionKind = 'ceiling_retargeted' | 'contract_repaired' | 'carry_forward';

export interface CatalogTask104 extends Omit<
  PriorTask,
  'task_version' | 'design_revision' | 'input_contract' | 'evaluator' | 'provenance'
> {
  readonly task_version: '1.0.4';
  readonly design_revision: {
    readonly supersedes_task_version: '1.0.3';
    readonly kind: RevisionKind;
    readonly objective: string;
    readonly task_specific_delta: string;
    readonly controlled_corpus_requirements: readonly string[];
  };
  readonly input_contract: Omit<PriorTask['input_contract'], 'kind' | 'content_handle'> & {
    readonly kind: string;
    readonly content_handle: string;
  };
  readonly evaluator: Omit<
    PriorTask['evaluator'],
    'scorer_version' | 'pass_conditions' | 'scoring_contract'
  > & {
    readonly scorer_version: '1.0.4';
    readonly pass_conditions: readonly string[];
    readonly scoring_contract: Omit<PriorTask['evaluator']['scoring_contract'], 'components'> & {
      readonly components: readonly {
        readonly component_id: string;
        readonly weight_basis_points: number;
        readonly criterion: string;
      }[];
    };
  };
  readonly provenance: {
    readonly origin: 'calibration_driven_revision' | 'contract_repair' | 'release_carry_forward';
    readonly owner: 'AIQ benchmark maintainers';
    readonly recorded_date: '2026-08-05';
    readonly predecessor_task_version: '1.0.3';
    readonly source: typeof GENERATOR_PATH;
  };
}

export interface Catalog104 extends Omit<
  PriorCatalog,
  'task_set_version' | 'scoring_version' | 'generated_from' | 'catalog_release_identity' | 'tasks'
> {
  readonly task_set_version: '1.0.4';
  readonly scoring_version: '1.0.4';
  readonly generated_from: typeof GENERATOR_PATH;
  readonly catalog_release_identity: Omit<
    PriorCatalog['catalog_release_identity'],
    'release_identity' | 'scoring_version' | 'task_metadata_identity' | 'digest'
  > & {
    readonly release_identity: 'aiq-core/1.0.4';
    readonly scoring_version: '1.0.4';
    readonly task_metadata_identity: Catalog104['task_metadata_identity'];
    readonly digest: string;
  };
  readonly tasks: readonly CatalogTask104[];
}

const REVISION_SPECS: Readonly<Record<string, RevisionSpec>> = {
  'coding-01': {
    objective:
      'Retarget the configuration patch around coupled validation, compatibility, and error-attribution obligations that require more than a local field addition.',
    taskSpecificDelta:
      'Require the new field to interact with an existing configuration rule, preserve a documented compatibility path, and attribute invalid input to the correct source. The controlled corpus must score validation, compatibility, preservation, and evidence independently without publishing private values or checks.',
    summary:
      'Add a typed configuration field whose validation interacts with an existing setting while preserving documented compatibility and source-specific errors.',
    inputKind: 'coupled_configuration_repository_patch',
    passConditions: [
      'The coupled configuration behavior is correct.',
      'Invalid combinations are rejected with the correct source attribution.',
      'The documented compatibility path and unrelated behavior are preserved.',
      'Independent evidence distinguishes a complete change from a plausible local-only patch.',
    ],
  },
  'coding-03': {
    objective:
      'Retarget retry implementation around interacting scheduling, cancellation, and attempt-lifecycle obligations rather than nominal backoff vectors alone.',
    taskSpecificDelta:
      'Couple capped scheduling with injected timing state, cancellation at more than one lifecycle boundary, and preservation of the terminal error contract. The controlled evaluator must distinguish nominal delays from a correct state transition implementation and retain deterministic execution.',
    summary:
      'Complete a bounded retry utility whose scheduling, cancellation, and attempt lifecycle remain correct under deterministic concurrent timing.',
    inputKind: 'concurrent_retry_repository_patch',
    passConditions: [
      'Capped scheduling and injected timing behavior are correct.',
      'Cancellation prevents work at each declared lifecycle boundary.',
      'Terminal success and error behavior preserve the public contract.',
      'Deterministic concurrency evidence separates nominal vectors from correct state transitions.',
    ],
  },
  'coding-05': {
    objective:
      'Retarget record deduplication around the coupled effects of normalization, winner selection, stable ordering, and invalid-record policy.',
    taskSpecificDelta:
      'Require one implementation to reconcile normalization collisions, deterministic winner selection, first-key output order, and invalid records under input permutations. The controlled corpus must include independently scored properties that reject solutions which satisfy only the golden example.',
    summary:
      'Deduplicate records while jointly preserving normalization policy, deterministic winners, stable output order, and declared invalid-record handling.',
    inputKind: 'normalization_reconciliation_patch',
    passConditions: [
      'Normalization and collision handling follow the declared policy.',
      'Winner selection is deterministic under equivalent input permutations.',
      'Stable output order and invalid-record behavior are preserved.',
      'Property evidence distinguishes the general rule from a golden-example implementation.',
    ],
  },
  'coding-07': {
    objective:
      'Retarget incremental parsing around coupled chunk state, byte limits, Unicode boundaries, and recoverable versus terminal parser states.',
    taskSpecificDelta:
      'Require consistent events across chunk partitions while enforcing limits before unbounded buffering, preserving incomplete state, and classifying malformed input deterministically. The evaluator must score state continuity, resource bounds, error typing, and regression preservation separately.',
    summary:
      'Implement an incremental framed-event parser with bounded buffering, Unicode-safe chunk state, and explicit recoverable and terminal errors.',
    inputKind: 'stateful_stream_parser_patch',
    passConditions: [
      'Equivalent chunk partitions produce equivalent events and retained state.',
      'Byte limits are enforced before unbounded buffering.',
      'Recoverable and terminal malformed-input states have stable typed errors.',
      'Boundary and preservation evidence distinguish a stateful parser from whole-buffer parsing.',
    ],
  },
  'debugging-01': {
    objective:
      'Retarget the boundary defect around multiple representations and adjacent valid behavior so a single-example patch cannot satisfy the task.',
    taskSpecificDelta:
      'Expose the same root-cause boundary through more than one representation and require preservation on both sides of the defect. The controlled evaluator must reject constant-specific or fixture-specific repairs while keeping the fault surface bounded and deterministic.',
    summary:
      'Find and repair one boundary defect that appears through multiple representations while preserving adjacent valid and empty behavior.',
    inputKind: 'multi_representation_boundary_repository',
    passConditions: [
      'The root-cause boundary behavior is correct across declared representations.',
      'Adjacent valid, invalid, and empty cases retain their specified behavior.',
      'The repair remains limited to the evidenced fault surface.',
      'Regression evidence rejects constant-specific and fixture-specific patches.',
    ],
  },
  'debugging-02': {
    objective:
      'Retarget configuration precedence around absent, empty, malformed, and valid states across layered sources with exact error attribution.',
    taskSpecificDelta:
      'Require a complete precedence state machine across layered sources instead of a single empty-value branch. The controlled evaluator must distinguish selection, strict parsing, bounds enforcement, fallback behavior, and source-labelled errors without exposing the private matrix.',
    summary:
      'Repair layered configuration precedence across absent, empty, malformed, and valid values while preserving strict parsing and source attribution.',
    inputKind: 'layered_configuration_repository',
    passConditions: [
      'All declared source states follow the precedence policy.',
      'Selected values use strict parsing and bounds enforcement.',
      'Fallback behavior and source-labelled errors are correct.',
      'Matrix evidence distinguishes a complete state machine from a single-branch fix.',
    ],
  },
  'debugging-03': {
    objective:
      'Retarget the cache race around out-of-order completion, version invalidation, and independent-key progress without global serialization.',
    taskSpecificDelta:
      'Exercise stale refresh completion before and after invalidation, including multiple keys and version changes, while requiring cache-hit behavior and key-local concurrency. The controlled evaluator must reject both stale publication and correctness obtained through global serialization.',
    summary:
      'Repair a versioned cache race under out-of-order refresh and invalidation while preserving cache hits and independent-key concurrency.',
    inputKind: 'versioned_concurrent_service_repository',
    passConditions: [
      'Out-of-order refresh completion cannot publish stale state.',
      'Invalidation and version changes preserve the committed source value.',
      'Cache hits and independent keys remain concurrent and correct.',
      'Deterministic race evidence rejects stale publication and global serialization.',
    ],
  },
  'debugging-04': {
    objective:
      'Retarget text truncation around the distinct byte, scalar, grapheme, and display-budget boundaries that a code-point-only fix cannot satisfy.',
    taskSpecificDelta:
      'Require valid output across combining and joined sequences while respecting a declared display-unit budget and preserving simple text behavior. The controlled evaluator must separate encoding validity, segmentation, budget enforcement, and regression preservation.',
    summary:
      'Repair text truncation so it preserves valid grapheme sequences and respects a display-unit budget without changing simple-text behavior.',
    inputKind: 'unicode_display_boundary_repository',
    passConditions: [
      'Output preserves valid declared grapheme sequences.',
      'The display-unit budget is never exceeded.',
      'Simple text, zero-budget, and invalid-budget behavior are preserved.',
      'Unicode evidence distinguishes grapheme-safe behavior from byte- or scalar-only truncation.',
    ],
  },
  'debugging-05': {
    objective:
      'Retarget replay recovery around multiple durable crash windows, concurrent delivery, and retryability rather than one duplicate-suppression path.',
    taskSpecificDelta:
      'Exercise ordering around effect, durable processing state, and acknowledgement across restart and concurrent delivery. The controlled evaluator must distinguish durable idempotency from process-local suppression and preserve retry after transient failures at each declared boundary.',
    summary:
      'Repair duplicate side effects across durable crash windows and concurrent replay while preserving acknowledgement order and transient retryability.',
    inputKind: 'durable_replay_worker_repository',
    passConditions: [
      'Each declared crash window preserves at-most-once committed effects.',
      'Durable processing state and acknowledgement occur in the required order.',
      'Concurrent delivery and transient failures remain independently retryable.',
      'Replay evidence distinguishes durable idempotency from process-local suppression.',
    ],
  },
  'data-processing-02': {
    kind: 'contract_repaired',
    objective:
      'Retarget the keyed-join transform so its reconciliation and duplicate policy are explicit, independently measurable, and achievable without weakening many-to-many safety.',
    taskSpecificDelta:
      'Define one unambiguous output contract for matched rows, unmatched keys, and duplicate-key diagnostics, with bounded input cases that exercise each rule independently. The controlled evaluator must award useful partial credit for correct reconciliation while retaining a hard guard against accidental many-to-many expansion.',
    summary:
      'Join two keyed datasets under an explicit cardinality policy, producing deterministic matched rows, unmatched-key reconciliation, and duplicate diagnostics.',
    inputKind: 'bounded_keyed_reconciliation_transform',
    passConditions: [
      'Matched rows follow the declared key and ordering contract.',
      'Unmatched keys are reconciled in the required deterministic form.',
      'Duplicate diagnostics prevent accidental many-to-many expansion.',
      'Independent evidence awards partial credit for correct transformation and reconciliation components.',
    ],
  },
};

export const REVISED_TASK_IDS = Object.freeze(Object.keys(REVISION_SPECS).toSorted());

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(',')}}`;
  }
  throw new TypeError('Canonical JSON does not support this value.');
}

function digestValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function replaceReleaseStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('1\\.0\\.3', '1\\.0\\.4')
      .replaceAll('aiq-core-1.0.3', 'aiq-core-1.0.4')
      .replaceAll('aiq-core@1.0.3', 'aiq-core@1.0.4')
      .replaceAll('aiq-core/1.0.3', 'aiq-core/1.0.4')
      .replaceAll('1.0.3', '1.0.4');
  }
  if (Array.isArray(value)) return value.map(replaceReleaseStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceReleaseStrings(child)]),
    );
  }
  return value;
}

function carriedForwardDelta(taskId: string): string {
  return `${taskId} carries forward the accepted AIQ Core 1.0.3 public design without a substantive task change. Only the release, task, scorer, controlled-reference, provenance, and commitment bindings advance to 1.0.4; private content must remain byte-equivalent before release rebinding.`;
}

function reviseTask(priorTask: PriorTask): CatalogTask104 {
  const releaseTask = replaceReleaseStrings(priorTask) as unknown as CatalogTask104;
  const spec = REVISION_SPECS[priorTask.task_id];
  const passConditions = spec?.passConditions ?? releaseTask.evaluator.pass_conditions;
  const components = releaseTask.evaluator.scoring_contract.components.map((component, index) => ({
    ...component,
    criterion: passConditions[index] ?? component.criterion,
  }));
  const acceptanceFixtureCommitments = Object.fromEntries(
    Object.entries(releaseTask.evaluator.acceptance_fixture_commitments).map(
      ([fixtureClass, fixture]) => [
        fixtureClass,
        spec === undefined
          ? fixture
          : { ...fixture, handle: fixture.handle.replace('/v2/', '/v3/') },
      ],
    ),
  ) as CatalogTask104['evaluator']['acceptance_fixture_commitments'];

  return {
    ...releaseTask,
    summary: spec?.summary ?? releaseTask.summary,
    design_revision: {
      supersedes_task_version: '1.0.3',
      kind: spec === undefined ? 'carry_forward' : (spec.kind ?? 'ceiling_retargeted'),
      objective:
        spec?.objective ??
        'Carry forward the accepted AIQ Core 1.0.3 task design unchanged while advancing the complete release identity and controlled bindings to AIQ Core 1.0.4.',
      task_specific_delta: spec?.taskSpecificDelta ?? carriedForwardDelta(priorTask.task_id),
      controlled_corpus_requirements: releaseTask.design_revision.controlled_corpus_requirements,
    },
    input_contract: {
      ...releaseTask.input_contract,
      kind: spec?.inputKind ?? releaseTask.input_contract.kind,
    },
    evaluator: {
      ...releaseTask.evaluator,
      scorer_version: SCORER_VERSION,
      pass_conditions: passConditions,
      scoring_contract: {
        ...releaseTask.evaluator.scoring_contract,
        components,
      },
      acceptance_fixture_commitments: acceptanceFixtureCommitments,
    },
    provenance: {
      origin:
        spec === undefined
          ? 'release_carry_forward'
          : spec.kind === 'contract_repaired'
            ? 'contract_repair'
            : 'calibration_driven_revision',
      owner: 'AIQ benchmark maintainers',
      recorded_date: '2026-08-05',
      predecessor_task_version: '1.0.3',
      source: GENERATOR_PATH,
    },
    leakage_review: {
      ...releaseTask.leakage_review,
      notes: `${priorTask.task_id} publishes only its versioned public design and scorer contract. Its private prompt, fixture, expected outputs, executable checks, and leakage evidence must bind this exact AIQ Core 1.0.4 catalog entry outside Git.`,
    },
  };
}

export function taskMetadataIdentityDigest(tasks: readonly CatalogTask104[]): string {
  return digestValue(tasks);
}

export function catalogReleaseIdentityDigest(
  identity: Catalog104['catalog_release_identity'],
): string {
  const {
    algorithm: _algorithm,
    canonicalization: _canonicalization,
    digest: _digest,
    scope: _scope,
    ...input
  } = identity;
  return digestValue(input);
}

export function buildCatalog(): Catalog104 {
  const prior = buildPriorCatalog();
  const tasks = prior.tasks.map(reviseTask);
  const taskMetadataIdentity = {
    ...prior.task_metadata_identity,
    digest: taskMetadataIdentityDigest(tasks),
  };
  const releaseIdentityInput = {
    release_identity: 'aiq-core/1.0.4' as const,
    scoring_version: SCORER_VERSION,
    task_metadata_identity: taskMetadataIdentity,
  };

  return {
    ...prior,
    task_set_version: TASK_SET_VERSION,
    scoring_version: SCORER_VERSION,
    title: 'AIQ Core 1.0.4',
    generated_from: GENERATOR_PATH,
    task_metadata_identity: taskMetadataIdentity,
    catalog_release_identity: {
      ...releaseIdentityInput,
      algorithm: 'sha256',
      canonicalization: 'aiq.sorted-key-json.v1',
      digest: digestValue(releaseIdentityInput),
      scope: 'release_identity_scoring_version_and_ordered_task_metadata_identity',
    },
    tasks,
  };
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function reviseCatalogSchema(priorSchema: unknown): unknown {
  const schema = replaceReleaseStrings(priorSchema);
  const root = jsonObject(schema, 'catalog schema');
  const definitions = jsonObject(root.$defs, 'catalog schema definitions');
  const task = jsonObject(definitions.task, 'catalog task definition');
  const taskProperties = jsonObject(task.properties, 'catalog task properties');
  const designRevision = jsonObject(taskProperties.design_revision, 'design revision');
  const designProperties = jsonObject(designRevision.properties, 'design revision properties');
  designProperties.supersedes_task_version = { const: '1.0.3' };
  designProperties.kind = {
    enum: ['ceiling_retargeted', 'contract_repaired', 'carry_forward'],
  };
  const provenance = jsonObject(taskProperties.provenance, 'provenance');
  const provenanceProperties = jsonObject(provenance.properties, 'provenance properties');
  provenanceProperties.origin = {
    enum: ['calibration_driven_revision', 'contract_repair', 'release_carry_forward'],
  };
  provenanceProperties.recorded_date = { const: '2026-08-05' };
  provenanceProperties.predecessor_task_version = { const: '1.0.3' };
  provenanceProperties.source = { const: GENERATOR_PATH };
  return schema;
}

export function assertCatalogInvariants(catalog: Catalog104): void {
  if (
    catalog.task_set_version !== TASK_SET_VERSION ||
    catalog.scoring_version !== SCORER_VERSION ||
    catalog.generated_from !== GENERATOR_PATH ||
    catalog.tasks.length !== 72
  ) {
    throw new Error('AIQ Core 1.0.4 release identity or cardinality is invalid.');
  }
  const taskIds = new Set(catalog.tasks.map(({ task_id }) => task_id));
  if (taskIds.size !== 72 || REVISED_TASK_IDS.some((taskId) => !taskIds.has(taskId))) {
    throw new Error('AIQ Core 1.0.4 task identity is incomplete.');
  }
  const retargeted = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'ceiling_retargeted',
  );
  const repaired = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'contract_repaired',
  );
  const carriedForward = catalog.tasks.filter(
    ({ design_revision }) => design_revision.kind === 'carry_forward',
  );
  if (
    retargeted.length !== 9 ||
    repaired.length !== 1 ||
    repaired[0]?.task_id !== 'data-processing-02' ||
    carriedForward.length !== 62
  ) {
    throw new Error(
      'AIQ Core 1.0.4 must contain nine ceiling-retargeted, one contract-repaired, and 62 carry-forward tasks.',
    );
  }
  for (const task of catalog.tasks) {
    const isRevised = REVISED_TASK_IDS.includes(task.task_id);
    const expectedKind =
      task.task_id === 'data-processing-02'
        ? 'contract_repaired'
        : isRevised
          ? 'ceiling_retargeted'
          : 'carry_forward';
    const expectedOrigin =
      expectedKind === 'contract_repaired'
        ? 'contract_repair'
        : expectedKind === 'ceiling_retargeted'
          ? 'calibration_driven_revision'
          : 'release_carry_forward';
    if (
      task.task_version !== TASK_VERSION ||
      task.evaluator.scorer_version !== SCORER_VERSION ||
      task.design_revision.supersedes_task_version !== '1.0.3' ||
      task.provenance.predecessor_task_version !== '1.0.3' ||
      task.provenance.source !== GENERATOR_PATH ||
      task.design_revision.kind !== expectedKind ||
      task.provenance.origin !== expectedOrigin
    ) {
      throw new Error(`Task ${task.task_id} has inconsistent revision metadata.`);
    }
    if (
      !task.input_contract.content_handle.includes('/1.0.4/') ||
      task.evaluator.pass_conditions.length < 4 ||
      task.evaluator.scoring_contract.components.length !== 4 ||
      task.evaluator.scoring_contract.components.some(
        (component, index) => component.criterion !== task.evaluator.pass_conditions[index],
      )
    ) {
      throw new Error(`Task ${task.task_id} has inconsistent public scoring metadata.`);
    }
    const acceptanceHandles = Object.values(task.evaluator.acceptance_fixture_commitments).map(
      ({ handle }) => handle,
    );
    if (
      acceptanceHandles.some((handle) =>
        isRevised ? !handle.includes('/v3/') : !handle.includes('/v2/'),
      )
    ) {
      throw new Error(`Task ${task.task_id} has inconsistent acceptance handles.`);
    }
  }

  const observedTaskIdentity = taskMetadataIdentityDigest(catalog.tasks);
  if (catalog.task_metadata_identity.digest !== observedTaskIdentity) {
    throw new Error('AIQ Core 1.0.4 task metadata identity is stale.');
  }
  const observedReleaseIdentity = catalogReleaseIdentityDigest(catalog.catalog_release_identity);
  if (catalog.catalog_release_identity.digest !== observedReleaseIdentity) {
    throw new Error('AIQ Core 1.0.4 release identity is stale.');
  }
  if (observedTaskIdentity !== AIQ_CORE_1_0_4_TASK_METADATA_IDENTITY_SHA256) {
    throw new Error(`AIQ Core 1.0.4 task metadata identity changed: ${observedTaskIdentity}.`);
  }
  if (observedReleaseIdentity !== AIQ_CORE_1_0_4_CATALOG_RELEASE_IDENTITY_SHA256) {
    throw new Error(`AIQ Core 1.0.4 release identity changed: ${observedReleaseIdentity}.`);
  }
}

async function readPriorSchema(name: string): Promise<unknown> {
  const path = fileURLToPath(
    new URL(`../../../benchmarks/candidates/aiq-core-1.0.3/${name}`, import.meta.url),
  );
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function writeCandidate(outputDirectory: string): Promise<void> {
  const catalog = buildCatalog();
  assertCatalogInvariants(catalog);
  const catalogSchema = reviseCatalogSchema(await readPriorSchema('catalog.schema.json'));
  const taskSchema = replaceReleaseStrings(await readPriorSchema('task.schema.json'));
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(`${outputDirectory}/catalog.json`, `${JSON.stringify(catalog, undefined, 2)}\n`),
    writeFile(
      `${outputDirectory}/catalog.schema.json`,
      `${JSON.stringify(catalogSchema, undefined, 2)}\n`,
    ),
    writeFile(
      `${outputDirectory}/task.schema.json`,
      `${JSON.stringify(taskSchema, undefined, 2)}\n`,
    ),
  ]);
}

if (import.meta.main) {
  const outputDirectory = dirname(
    fileURLToPath(
      new URL('../../../benchmarks/candidates/aiq-core-1.0.4/catalog.json', import.meta.url),
    ),
  );
  const catalog = buildCatalog();
  await writeCandidate(outputDirectory);
  process.stdout.write(
    `${JSON.stringify({
      catalog_release_identity_sha256: catalog.catalog_release_identity.digest,
      task_metadata_identity_sha256: catalog.task_metadata_identity.digest,
    })}\n`,
  );
}
