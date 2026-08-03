import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256,
  AIQ_CORE_V1_TASK_METADATA_IDENTITY_SHA256,
  COMMAND_EXECUTION_DISCLOSURE,
  DOMAINS,
  FIXED_MODEL_MATRIX_IDENTITIES,
  MODEL_EXECUTION_ID_MAPPING,
  RELEASE_GATE_POLICY,
  RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT,
  PREDECESSOR_CATALOG,
  assertCatalogInvariants,
  buildCatalog,
  catalogReleaseIdentityDigest,
  evaluateReleaseGate as evaluateReleaseGateWithAuthority,
  releaseEvidenceSourceDigest,
  releaseEvidenceModelMatrixDigest,
  releaseModelIdMappingDigest,
  resolveExecutionModelId,
  releaseCellEvidenceBindingDigest,
  releaseAuthoritySigningBytes,
  releaseAdmissionSigningBytes,
  releaseAdmissionDigest,
  promotionReceiptSigningBytes,
  releaseAuthorityDigest,
  releaseEvidenceDigest,
  releaseGateResultDigest,
  releaseGateTrustPolicyDigest,
  taskMetadataIdentityDigest,
  verifyPromotionReceipt,
  type Catalog,
  type CatalogTask,
  type ReleaseGateEvidence,
  type ReleaseGateRawCell,
  type ReleaseGateAuthority,
  type ReleaseGateAdmission,
  type ReleaseGateTrustPolicy,
  type ReleaseGateTrustRoot,
  type PromotionReceipt,
  type ModelMatrixConfiguration,
  type ComponentEvidence,
} from './generate-benchmark-catalog.ts';
import {
  assembleReleaseEvidence,
  issuePromotionReceipt,
  runCandidateReleaseCli,
} from './candidate-release.ts';

type JsonSchema = Record<string, unknown>;

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new RangeError(message);
  return value;
}

function isJsonObject(value: unknown): value is JsonSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(source: string): JsonSchema {
  const value: unknown = JSON.parse(source);
  if (!isJsonObject(value)) {
    throw new TypeError('Expected a JSON object.');
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Expected a canonical JSON value.');
}

function mutateBase64PadBits(value: string): string {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (value.length < 4 || !value.endsWith('==')) throw new Error('Expected padded base64.');
  const index = table.indexOf(value.at(-3) ?? '');
  if (index < 0 || (index & 0x0f) !== 0) throw new Error('Expected canonical pad bits.');
  return `${value.slice(0, -3)}${table[index | 1]}==`;
}

function catalogJson(catalog: Catalog): JsonSchema {
  return parseJsonObject(JSON.stringify(catalog));
}

function objectProperty(record: JsonSchema, field: string): JsonSchema {
  const value = record[field];
  if (!isJsonObject(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
  return value;
}

function arrayProperty(record: JsonSchema, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array.`);
  }
  return value;
}

function replaceFirstAllowedTools(catalog: Catalog, allowedTools: readonly string[]): Catalog {
  const [firstTask, ...remainingTasks] = catalog.tasks;
  if (firstTask === undefined) {
    throw new RangeError('Catalog must contain a task.');
  }
  return {
    ...catalog,
    tasks: [{ ...firstTask, allowed_tools: allowedTools }, ...remainingTasks],
  };
}

function replaceFirstTask(catalog: Catalog, task: CatalogTask): Catalog {
  const [, ...remainingTasks] = catalog.tasks;

  return { ...catalog, tasks: [task, ...remainingTasks] };
}

interface ScoreProfile {
  readonly mean: number;
  readonly model_step?: number;
  readonly repeat_step?: number;
}

const AUTHORITY_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHuaWhdSXEidbUqHPsGvweUUpoNyzilI368yi4XOXXBs
-----END PRIVATE KEY-----`;
const PROMOTION_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIM8O2C9rfJNTeo94tfhwzrNJKjxqrKqX6zEuf5DJQAHt
-----END PRIVATE KEY-----`;

const TRUST_POLICY: ReleaseGateTrustPolicy = {
  schema_version: 'aiq.release-gate-trust.v1',
  release_identity: 'aiq-core/1.0.2',
  authority_signers: [
    {
      key_id: 'release-authority-test-2026',
      algorithm: 'ed25519',
      public_key_fingerprint:
        'sha256:09a7c70f88e50bec0a7d589fab3ec3091ee333bbcc7de08b943037da23ad1de3',
      public_key_spki_base64: 'MCowBQYDK2VwAyEAHa0lq47JGowNz4pD6WqN/VjyhAuA2RjR25GdSxxFLEQ=',
    },
  ],
  promotion_signers: [
    {
      key_id: 'release-promotion-test-2026',
      algorithm: 'ed25519',
      public_key_fingerprint:
        'sha256:f08ddc05f416207d45e9277c340b0b0c5be4656ba9bc50eef9118e5ef9ed8007',
      public_key_spki_base64: 'MCowBQYDK2VwAyEAin+ZDe8Q2y5Lcu+4eecR/l40Xh72ST+hfyjA7NCv0n0=',
    },
  ],
};

const TRUST_ROOT: ReleaseGateTrustRoot = {
  schema_version: 'aiq.release-gate-trust-root.v1',
  release_identity: 'aiq-core/1.0.2',
  trust_policy_digest: releaseGateTrustPolicyDigest(TRUST_POLICY),
};

function testDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function bindCell(cell: ReleaseGateRawCell): ReleaseGateRawCell {
  const { cell_evidence_binding_digest: _bindingDigest, ...unsignedCell } = cell;
  return {
    ...unsignedCell,
    cell_evidence_binding_digest:
      cell.status === 'completed' ? releaseCellEvidenceBindingDigest(unsignedCell) : null,
  };
}

function modelMatrix(): readonly ModelMatrixConfiguration[] {
  return FIXED_MODEL_MATRIX_IDENTITIES.map((identity, index) => ({
    ...identity,
    execution_model_id: requireValue(
      MODEL_EXECUTION_ID_MAPPING[index],
      'Execution-model mapping is required.',
    ).execution_model_id,
  }));
}

const SCORE_COMPONENT_CACHE = new Map<number, readonly number[]>();
const COMPONENT_TEST_WEIGHTS = [3000, 2500, 2500, 2000] as const;
function componentsForScore(requestedScore: number): readonly ComponentEvidence[] {
  const requestedUnits = Math.round(Math.max(0, Math.min(1, requestedScore)) * 200);
  let selected = SCORE_COMPONENT_CACHE.get(requestedUnits);
  if (selected === undefined) {
    let candidate = [0, 0, 0, 0];
    let selectedDistance = Number.POSITIVE_INFINITY;
    for (let first = 0; first <= 10; first += 1) {
      for (let second = 0; second <= 10; second += 1) {
        for (let third = 0; third <= 10; third += 1) {
          for (let fourth = 0; fourth <= 10; fourth += 1) {
            const units = 6 * first + 5 * second + 5 * third + 4 * fourth;
            const distance = Math.abs(units - requestedUnits);
            if (distance < selectedDistance) {
              candidate = [first, second, third, fourth];
              selectedDistance = distance;
            }
          }
        }
      }
    }
    selected = candidate;
    SCORE_COMPONENT_CACHE.set(requestedUnits, selected);
  }
  return (['component_01', 'component_02', 'component_03', 'component_04'] as const).map(
    (componentId, componentIndex) => {
      const assertionCount = 10;
      const passedCount = selected[componentIndex] ?? 0;
      return {
        component_id: componentId,
        weight_basis_points: requireValue(
          COMPONENT_TEST_WEIGHTS[componentIndex],
          'Component weight is required.',
        ),
        passed_assertions: passedCount,
        total_assertions: assertionCount,
        assertions: Array.from({ length: assertionCount }, (_, index) => ({
          assertion_id: `assertion_${String(index + 1).padStart(3, '0')}`,
          passed: index < passedCount,
          evidence_digest: `sha256:${((index % 9) + 1).toString().repeat(64)}`,
        })),
      };
    },
  );
}

function scoreFromComponents(components: readonly ComponentEvidence[]): number {
  const weights = [0.3, 0.25, 0.25, 0.2];
  const score = components.reduce(
    (sum, component, index) =>
      sum +
      (weights[index] ?? 0) *
        (component.assertions.filter(({ passed }) => passed).length / component.assertions.length),
    0,
  );
  return Math.round((score + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function buildReleaseEvidence(
  profiles: ReadonlyMap<string, ScoreProfile> = new Map(),
  repeatIds: readonly string[] = ['repeat-1', 'repeat-2', 'repeat-3'],
): ReleaseGateEvidence {
  const catalog = buildCatalog();
  const configurations = modelMatrix();
  const modelIds = configurations.map(({ model_id: modelId }) => modelId);
  const rawCells = repeatIds.flatMap((repeatId, repeatIndex) =>
    catalog.tasks.flatMap(({ task_id: taskId, domain }, taskIndex) => {
      const profile = profiles.get(taskId) ?? { mean: 0.5 };
      const modelStep = profile.model_step ?? 0.006;
      const repeatStep = profile.repeat_step ?? 0.005;
      return modelIds.map((modelId, modelIndex) => {
        const components = componentsForScore(
          profile.mean + (modelIndex - 8) * modelStep + (repeatIndex - 1) * repeatStep,
        );
        const unsignedCell = {
          universe_slot:
            repeatIndex * catalog.tasks.length * modelIds.length +
            taskIndex * modelIds.length +
            modelIndex +
            1,
          repeat_id: repeatId,
          task_id: taskId,
          domain,
          model_id: modelId,
          status: 'completed' as const,
          reported_score: scoreFromComponents(components),
          components,
          evaluator_digest: testDigest(`evaluator:${repeatId}:${taskId}:${modelId}`),
          result_digest: testDigest(`result:${repeatId}:${taskId}:${modelId}`),
          result_package_digest: testDigest(`package:${repeatId}:${taskId}:${modelId}`),
          verification_digest: testDigest(`verification:${repeatId}:${taskId}:${modelId}`),
          verification_status: 'verified' as const,
          attempts: [
            {
              attempt_number: 1,
              scheduled_delay_seconds: 0 as const,
              scheduled_for: `2026-08-02T${String(repeatIndex + 1).padStart(2, '0')}:00:00.000Z`,
              started_at: `2026-08-02T${String(repeatIndex + 1).padStart(2, '0')}:00:05.000Z`,
              model_started: true,
              disposition: 'completed' as const,
              infrastructure_classification: null,
              result_digest: testDigest(`result:${repeatId}:${taskId}:${modelId}`),
              result_package_digest: testDigest(`package:${repeatId}:${taskId}:${modelId}`),
              verifier_attestation_digest: testDigest(
                `verification:${repeatId}:${taskId}:${modelId}`,
              ),
            },
          ],
        };
        return {
          ...unsignedCell,
          cell_evidence_binding_digest: releaseCellEvidenceBindingDigest(unsignedCell),
        };
      });
    }),
  );
  const pairs = repeatIds.flatMap((repeatId) =>
    modelIds.map((modelId) => ({
      repeat_id: repeatId,
      model_id: modelId,
      reference_score: 0.43,
      challenge_score: 0.4,
    })),
  );
  const pairedContrasts = RELEASE_GATE_POLICY.predeclared_contrasts.map(
    ({ contrast_id: contrastId }, contrastIndex) => ({
      contrast_id: contrastId,
      reference_variant_digest: `sha256:${(['c', 'e', '1'][contrastIndex] ?? '0').repeat(64)}`,
      challenge_variant_digest: `sha256:${(['d', 'f', '2'][contrastIndex] ?? '0').repeat(64)}`,
      pairs: pairs.map((pair) => ({
        repeat_id: pair.repeat_id,
        model_id: pair.model_id,
        reference_score: pair.reference_score + contrastIndex * 0.05,
        challenge_score: pair.challenge_score + contrastIndex * 0.05,
        reference_result_digest: testDigest(
          `contrast:${contrastIndex}:${pair.repeat_id}:${pair.model_id}:reference:result`,
        ),
        reference_result_package_digest: testDigest(
          `contrast:${contrastIndex}:${pair.repeat_id}:${pair.model_id}:reference:package`,
        ),
        reference_verifier_attestation_digest: testDigest(
          `contrast:${contrastIndex}:${pair.repeat_id}:${pair.model_id}:reference:attestation`,
        ),
        challenge_result_digest: testDigest(
          `contrast:${contrastIndex}:${pair.repeat_id}:${pair.model_id}:challenge:result`,
        ),
        challenge_result_package_digest: testDigest(
          `contrast:${contrastIndex}:${pair.repeat_id}:${pair.model_id}:challenge:package`,
        ),
        challenge_verifier_attestation_digest: testDigest(
          `contrast:${contrastIndex}:${pair.repeat_id}:${pair.model_id}:challenge:attestation`,
        ),
      })),
    }),
  );
  const sourceObservationsDigest = releaseEvidenceSourceDigest(rawCells, pairedContrasts);
  const authority = buildReleaseAuthority(repeatIds, sourceObservationsDigest);
  return {
    schema_version: 'aiq.release-gate-evidence.v1',
    release_identity: 'aiq-core/1.0.2',
    catalog_release_identity_digest: catalog.catalog_release_identity.digest,
    task_metadata_identity_digest: catalog.task_metadata_identity.digest,
    corpus_commitment_digest: `sha256:${'a'.repeat(64)}`,
    model_matrix_digest: releaseEvidenceModelMatrixDigest(configurations),
    source_observations_digest: sourceObservationsDigest,
    authority_digest: releaseAuthorityDigest(authority),
    admission_digest: authority.admission_digest,
    execution_plan_digest: authority.execution_plan_digest,
    model_id_mapping_digest: authority.model_id_mapping_digest,
    collected_at: '2026-08-02T12:00:00.000Z',
    repeat_ids: repeatIds,
    raw_cells: rawCells,
    paired_contrasts: pairedContrasts,
  };
}

function isReleaseGateEvidence(
  value: ReleaseGateEvidence | readonly string[],
): value is ReleaseGateEvidence {
  return !Array.isArray(value);
}

function buildReleaseAuthority(
  source: ReleaseGateEvidence | readonly string[],
  suppliedSourceDigest?: string,
): ReleaseGateAuthority {
  const catalog = buildCatalog();
  const configurations = modelMatrix();
  const evidenceSource = isReleaseGateEvidence(source) ? source : undefined;
  const repeatIds: readonly string[] = isReleaseGateEvidence(source) ? source.repeat_ids : source;
  const unsignedAdmission: ReleaseGateAdmission = {
    schema_version: 'aiq.release-gate-admission.v1',
    signature_domain: 'aiq.release-gate-admission.v1',
    signature_encoding: 'aiq.sorted-key-json.v1',
    release_identity: 'aiq-core/1.0.2',
    catalog_release_identity_digest: catalog.catalog_release_identity.digest,
    task_metadata_identity_digest: catalog.task_metadata_identity.digest,
    corpus_commitment_digest: `sha256:${'a'.repeat(64)}`,
    plan_id: 'aiq-core-1.0.2-release-plan-001',
    execution_plan_digest: testDigest('external-execution-plan'),
    model_id_mapping_digest: releaseModelIdMappingDigest(),
    issued_at: '2026-08-01T00:00:00.000Z',
    collection_not_before: '2026-08-02T00:00:00.000Z',
    collection_not_after: '2026-08-03T00:00:00.000Z',
    repeat_schedule: repeatIds.map((repeatId, index) => ({
      repeat_id: repeatId,
      scheduled_at: `2026-08-02T${String(index + 1).padStart(2, '0')}:00:00.000Z`,
      contrast_arm_order: RELEASE_GATE_POLICY.predeclared_contrasts.flatMap(
        ({ contrast_id: contrastId }) =>
          index % 2 === 0
            ? [`${contrastId}:reference`, `${contrastId}:challenge`]
            : [`${contrastId}:challenge`, `${contrastId}:reference`],
      ),
    })),
    observation_universe: {
      task_ids: catalog.tasks.map(({ task_id: taskId }) => taskId),
      model_ids: configurations.map(({ model_id: modelId }) => modelId),
      raw_cell_count: repeatIds.length * catalog.tasks.length * configurations.length,
      contrast_pair_count:
        repeatIds.length * configurations.length * RELEASE_GATE_POLICY.predeclared_contrasts.length,
      contrast_observation_count:
        repeatIds.length *
        configurations.length *
        RELEASE_GATE_POLICY.predeclared_contrasts.length *
        2,
    },
    infrastructure_retry_policy: {
      max_attempts: 3,
      backoff_seconds: [0, 30, 90],
      retryable_classifications: ['pre_model_admission'],
      model_or_evaluator_failures_retryable: false,
    },
    model_matrix: {
      digest: releaseEvidenceModelMatrixDigest(configurations),
      configurations,
    },
    contrast_bindings: RELEASE_GATE_POLICY.predeclared_contrasts.map(
      ({ contrast_id: contrastId }, contrastIndex) => ({
        contrast_id: contrastId,
        reference_variant_digest: `sha256:${(['c', 'e', '1'][contrastIndex] ?? '0').repeat(64)}`,
        challenge_variant_digest: `sha256:${(['d', 'f', '2'][contrastIndex] ?? '0').repeat(64)}`,
      }),
    ),
    signer: { key_id: 'release-authority-test-2026', algorithm: 'ed25519' },
    signature: '',
  };
  const admission: ReleaseGateAdmission = {
    ...unsignedAdmission,
    signature: sign(
      null,
      releaseAdmissionSigningBytes(unsignedAdmission),
      createPrivateKey(AUTHORITY_PRIVATE_KEY),
    ).toString('base64'),
  };
  const unsigned: ReleaseGateAuthority = {
    schema_version: 'aiq.release-gate-authority.v1',
    signature_domain: 'aiq.release-gate-authority.v1',
    signature_encoding: 'aiq.sorted-key-json.v1',
    release_identity: 'aiq-core/1.0.2',
    catalog_release_identity_digest: catalog.catalog_release_identity.digest,
    task_metadata_identity_digest: catalog.task_metadata_identity.digest,
    admission_digest: releaseAdmissionDigest(admission),
    execution_plan_digest: admission.execution_plan_digest,
    model_id_mapping_digest: admission.model_id_mapping_digest,
    admission,
    source_observations_digest:
      suppliedSourceDigest ?? evidenceSource?.source_observations_digest ?? '',
    signer: { key_id: 'release-authority-test-2026', algorithm: 'ed25519' },
    signature: '',
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      releaseAuthoritySigningBytes(unsigned),
      createPrivateKey(AUTHORITY_PRIVATE_KEY),
    ).toString('base64'),
  };
}

function evaluateReleaseGate(evidence: ReleaseGateEvidence) {
  return evaluateReleaseGateWithAuthority(
    evidence,
    buildReleaseAuthority(evidence),
    TRUST_POLICY,
    TRUST_ROOT,
  );
}

function buildPromotionReceipt(
  evidence: ReleaseGateEvidence,
  authority: ReleaseGateAuthority,
  issuedAt = '2026-08-02T12:00:00.000Z',
): PromotionReceipt {
  const catalog = buildCatalog();
  const result = evaluateReleaseGateWithAuthority(evidence, authority, TRUST_POLICY, TRUST_ROOT);
  const unsigned: PromotionReceipt = {
    schema_version: 'aiq.promotion-receipt.v1',
    signature_domain: 'aiq.promotion-receipt.v1',
    signature_encoding: 'aiq.sorted-key-json.v1',
    release_identity: 'aiq-core/1.0.2',
    candidate_catalog_release_identity_digest: catalog.catalog_release_identity.digest,
    task_metadata_identity_digest: catalog.task_metadata_identity.digest,
    authority_digest: releaseAuthorityDigest(authority),
    evidence_digest: releaseEvidenceDigest(evidence),
    gate_result_digest: releaseGateResultDigest(result),
    promotion_state: 'released',
    issued_at: issuedAt,
    signer: { key_id: 'release-promotion-test-2026', algorithm: 'ed25519' },
    signature: '',
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      promotionReceiptSigningBytes(unsigned),
      createPrivateKey(PROMOTION_PRIVATE_KEY),
    ).toString('base64'),
  };
}

function replaceRawCells(
  evidence: ReleaseGateEvidence,
  rawCells: ReleaseGateEvidence['raw_cells'],
): ReleaseGateEvidence {
  const replaced = {
    ...evidence,
    source_observations_digest: releaseEvidenceSourceDigest(rawCells, evidence.paired_contrasts),
    raw_cells: rawCells,
  };
  return replaced;
}

function replacePairedContrasts(
  evidence: ReleaseGateEvidence,
  pairedContrasts: ReleaseGateEvidence['paired_contrasts'],
): ReleaseGateEvidence {
  const replaced = {
    ...evidence,
    source_observations_digest: releaseEvidenceSourceDigest(evidence.raw_cells, pairedContrasts),
    paired_contrasts: pairedContrasts,
  };
  return replaced;
}

function reauthorizeEvidence(evidence: ReleaseGateEvidence): {
  readonly evidence: ReleaseGateEvidence;
  readonly authority: ReleaseGateAuthority;
} {
  const authority = buildReleaseAuthority(evidence);
  return {
    authority,
    evidence: {
      ...evidence,
      authority_digest: releaseAuthorityDigest(authority),
      admission_digest: authority.admission_digest,
      execution_plan_digest: authority.execution_plan_digest,
      model_id_mapping_digest: authority.model_id_mapping_digest,
    },
  };
}

function evaluateReauthorizedEvidence(evidence: ReleaseGateEvidence) {
  const rebound = reauthorizeEvidence(evidence);
  return evaluateReleaseGateWithAuthority(
    rebound.evidence,
    rebound.authority,
    TRUST_POLICY,
    TRUST_ROOT,
  );
}

function preAssemblyObservations(
  evidence: ReleaseGateEvidence,
): Parameters<typeof assembleReleaseEvidence>[1] {
  const {
    admission_digest: _admissionDigest,
    authority_digest: _authorityDigest,
    execution_plan_digest: _executionPlanDigest,
    model_id_mapping_digest: _modelIdMappingDigest,
    raw_cells: evidenceCells,
    source_observations_digest: _sourceDigest,
    ...observationEnvelope
  } = evidence;
  return {
    ...observationEnvelope,
    raw_cells: evidenceCells.map(
      ({ universe_slot: _universeSlot, cell_evidence_binding_digest: _binding, ...cell }) => cell,
    ),
  };
}

function contrastPairsAtLowerBound(
  pairs: ReleaseGateEvidence['paired_contrasts'][number]['pairs'],
  meanDifferenceAiQ: number,
) {
  const modelIds = [...new Set(pairs.map(({ model_id: modelId }) => modelId))];
  const deviationAiQ = (3 * Math.sqrt(modelIds.length)) / 2.128;
  return pairs.map((pair) => {
    const modelIndex = modelIds.indexOf(pair.model_id);
    const differenceAiQ =
      modelIndex === modelIds.length - 1
        ? meanDifferenceAiQ
        : meanDifferenceAiQ + (modelIndex % 2 === 0 ? deviationAiQ : -deviationAiQ);
    return {
      ...pair,
      reference_score: 0.5,
      challenge_score: 0.5 - differenceAiQ / 100,
    };
  });
}

function resolveReference(root: JsonSchema, reference: string): JsonSchema {
  let value: unknown = root;
  for (const segment of reference.replace(/^#\//, '').split('/')) {
    if (!isJsonObject(value)) {
      throw new TypeError(`Schema reference ${reference} does not resolve to an object.`);
    }
    value = value[segment];
  }
  if (!isJsonObject(value)) {
    throw new TypeError(`Schema reference ${reference} does not resolve to an object.`);
  }
  return value;
}

function matchesSchema(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  if (typeof schema.$ref === 'string') {
    return matchesSchema(value, resolveReference(root, schema.$ref), root);
  }
  if (Array.isArray(schema.oneOf)) {
    return (
      schema.oneOf.filter(
        (candidate) => isJsonObject(candidate) && matchesSchema(value, candidate, root),
      ).length === 1
    );
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every(
      (candidate) => isJsonObject(candidate) && matchesSchema(value, candidate, root),
    )
  ) {
    return false;
  }
  if (isJsonObject(schema.if)) {
    const conditionMatches = matchesSchema(value, schema.if, root);
    if (conditionMatches && isJsonObject(schema.then) && !matchesSchema(value, schema.then, root)) {
      return false;
    }
    if (
      !conditionMatches &&
      isJsonObject(schema.else) &&
      !matchesSchema(value, schema.else, root)
    ) {
      return false;
    }
  }
  if (isJsonObject(schema.not) && matchesSchema(value, schema.not, root)) {
    return false;
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return false;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.some(
      (type) => typeof type === 'string' && matchesSchema(value, { ...schema, type }, root),
    );
  }

  const hasObjectKeywords =
    schema.type === 'object' ||
    isJsonObject(schema.properties) ||
    Array.isArray(schema.required) ||
    schema.additionalProperties !== undefined;
  if (hasObjectKeywords) {
    if (!isJsonObject(value)) {
      return false;
    }
    const object = value;
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    if (
      Array.isArray(schema.required) &&
      schema.required.some((field) => typeof field === 'string' && !(field in object))
    ) {
      return false;
    }
    for (const [field, fieldValue] of Object.entries(object)) {
      const propertySchema = properties[field];
      if (isJsonObject(propertySchema)) {
        if (!matchesSchema(fieldValue, propertySchema, root)) {
          return false;
        }
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        isJsonObject(schema.additionalProperties) &&
        !matchesSchema(fieldValue, schema.additionalProperties, root)
      ) {
        return false;
      }
    }
    return true;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return false;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return false;
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return false;
    }
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      return false;
    }
    const contains = schema.contains;
    if (isJsonObject(contains) && !value.some((item) => matchesSchema(item, contains, root))) {
      return false;
    }
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [index, itemSchema] of prefixItems.slice(0, value.length).entries()) {
      if (!isJsonObject(itemSchema) || !matchesSchema(value[index], itemSchema, root)) {
        return false;
      }
    }
    const items = schema.items;
    if (items === false) {
      return value.length <= prefixItems.length;
    }
    const remainingItems = value.slice(prefixItems.length);
    return (
      items === undefined ||
      (isJsonObject(items) && remainingItems.every((item) => matchesSchema(item, items, root)))
    );
  }

  if (schema.type === 'string') {
    return (
      typeof value === 'string' &&
      (typeof schema.minLength !== 'number' || value.length >= schema.minLength) &&
      (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength) &&
      (typeof schema.pattern !== 'string' || new RegExp(schema.pattern).test(value))
    );
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value)) &&
      (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
      (typeof schema.maximum !== 'number' || value <= schema.maximum)
    );
  }

  if (schema.type === 'boolean') {
    return typeof value === 'boolean';
  }
  if (schema.type === 'null') {
    return value === null;
  }
  return true;
}

await test('the catalog contains the fixed 72-task distribution', () => {
  const catalog = buildCatalog();

  assertCatalogInvariants(catalog);
  strictEqual(catalog.distribution.total, 72);
  strictEqual(catalog.tasks.length, 72);
  strictEqual(
    Object.values(catalog.distribution.domains).reduce((sum, value) => sum + value, 0),
    72,
  );
  deepStrictEqual(catalog.distribution.difficulties, { easy: 12, medium: 48, hard: 12 });
  deepStrictEqual(Object.keys(catalog.distribution.domains), [...DOMAINS]);
  deepStrictEqual(catalog.distribution.domain_difficulty.coding, {
    easy: 1,
    medium: 5,
    hard: 2,
  });
  deepStrictEqual(catalog.distribution.domain_difficulty.instruction_following, {
    easy: 1,
    medium: 4,
    hard: 1,
  });
});

await test('schema matcher enforces union types', () => {
  const schema: JsonSchema = { type: ['number', 'null'] };
  strictEqual(matchesSchema(0.5, schema, schema), true);
  strictEqual(matchesSchema(null, schema, schema), true);
  strictEqual(matchesSchema('0.5', schema, schema), false);
  strictEqual(matchesSchema({ private: true }, schema, schema), false);
});

await test('task metadata and candidate release identities have separate scopes', () => {
  const catalog = buildCatalog();

  strictEqual(catalog.task_metadata_identity.algorithm, 'sha256');
  strictEqual(catalog.task_metadata_identity.canonicalization, 'aiq.sorted-key-json.v1');
  strictEqual(catalog.task_metadata_identity.scope, 'ordered_full_task_metadata');
  strictEqual(catalog.task_metadata_identity.digest, taskMetadataIdentityDigest(catalog.tasks));
  strictEqual(catalog.task_metadata_identity.digest, AIQ_CORE_V1_TASK_METADATA_IDENTITY_SHA256);
  strictEqual(
    catalog.catalog_release_identity.scope,
    'task_metadata_identity_release_policy_and_predecessor',
  );
  strictEqual(catalog.catalog_release_identity.canonicalization, 'aiq.sorted-key-json.v1');
  strictEqual(
    catalog.catalog_release_identity.digest,
    catalogReleaseIdentityDigest(
      catalog.task_metadata_identity.digest,
      catalog.release_gate_policy,
      catalog.predecessor_catalog,
    ),
  );
  strictEqual(catalog.catalog_release_identity.digest, AIQ_CORE_V1_CATALOG_RELEASE_IDENTITY_SHA256);
  strictEqual(
    catalogReleaseIdentityDigest(
      catalog.task_metadata_identity.digest,
      {
        ...catalog.release_gate_policy,
        predeclared_contrasts: catalog.release_gate_policy.predeclared_contrasts.toReversed(),
      },
      catalog.predecessor_catalog,
    ) === catalog.catalog_release_identity.digest,
    false,
  );

  const first = catalog.tasks[0];
  const second = catalog.tasks[1];
  if (first === undefined || second === undefined) {
    throw new RangeError('Catalog must contain at least two tasks.');
  }
  const reordered: Catalog = {
    ...catalog,
    tasks: [second, first, ...catalog.tasks.slice(2)],
  };
  throws(() => assertCatalogInvariants(reordered), /Task metadata identity does not match/);
});

await test('execution model IDs resolve to a base Codex model plus reasoning effort', () => {
  for (const [index, mapping] of MODEL_EXECUTION_ID_MAPPING.entries()) {
    const identity = requireValue(
      FIXED_MODEL_MATRIX_IDENTITIES[index],
      'Mapped model identity is required.',
    );
    const resolved = resolveExecutionModelId(mapping.execution_model_id);
    strictEqual(resolved.base_model, `gpt-5.6-${identity.family}`);
    strictEqual(resolved.reasoning_effort, identity.reasoning_effort);
    strictEqual(resolved.base_model === mapping.execution_model_id, false);
  }
  throws(() => resolveExecutionModelId('gpt-5.6-sol-low-post-selected'), /Unknown/u);
});

await test('the current catalog binds the redesigned task and scorer release 1.0.2', () => {
  const catalog = buildCatalog();

  strictEqual(catalog.task_set_version, '1.0.2');
  for (const task of catalog.tasks) {
    strictEqual(task.task_version, '1.0.2', task.task_id);
    strictEqual(task.evaluator.scorer_version, '1.0.2', task.task_id);
    strictEqual(
      task.input_contract.content_handle,
      `aiq-controlled-task://aiq-core/1.0.2/${task.task_id}`,
      task.task_id,
    );
  }

  const first = catalog.tasks[0];
  if (first === undefined) {
    throw new Error('Catalog must contain a task.');
  }
  throws(
    () => assertCatalogInvariants(replaceFirstTask(catalog, { ...first, task_version: '1.0.0' })),
    /current AIQ Core catalog requires/,
  );
});

await test('provisional difficulty labels do not determine execution budgets', () => {
  const tasks = new Map(buildCatalog().tasks.map((task) => [task.task_id, task]));
  strictEqual(tasks.get('coding-01')?.difficulty, 'easy');
  strictEqual(tasks.get('coding-02')?.difficulty, 'medium');
  strictEqual(tasks.get('coding-07')?.difficulty, 'hard');
  deepStrictEqual(tasks.get('coding-01')?.budget, tasks.get('coding-02')?.budget);
  deepStrictEqual(tasks.get('coding-02')?.budget, tasks.get('coding-07')?.budget);
});

await test('the public catalog contains metadata references, not hidden payloads', () => {
  const catalog = buildCatalog();

  for (const task of catalog.tasks) {
    strictEqual(task.visibility, 'hidden');
    strictEqual(task.input_contract.content_handle.startsWith('aiq-controlled-task://'), true);
    strictEqual(task.input_contract.content_handle.includes('supabase'), false);
    strictEqual('prompt' in task, false);
    strictEqual('expected' in task, false);
  }
});

await test('public metadata stays capability-neutral and matches scored behavior', () => {
  const tasks = new Map(buildCatalog().tasks.map((task) => [task.task_id, task]));
  const reliabilityIds = [
    'reliability-recovery-01',
    'reliability-recovery-03',
    'reliability-recovery-04',
    'reliability-recovery-07',
  ];
  for (const taskId of reliabilityIds) {
    const task = tasks.get(taskId);
    const text = `${task?.summary ?? ''} ${task?.evaluator.pass_conditions.join(' ') ?? ''}`;
    strictEqual(
      /\bunsupported\b|request retransmission|no winner|idempotency key is reused/iu.test(text),
      false,
      taskId,
    );
  }
  strictEqual(tasks.get('coding-04')?.input_contract.kind, 'library_function_patch');
  strictEqual(
    tasks
      .get('coding-08')
      ?.evaluator.pass_conditions.includes('Failed effects do not advance the checkpoint.'),
    true,
  );
  strictEqual(
    tasks
      .get('tool-use-05')
      ?.evaluator.pass_conditions.includes('The focused tests reject seeded behavioral mutants.'),
    true,
  );
  strictEqual(
    tasks
      .get('tool-use-06')
      ?.evaluator.pass_conditions.includes('The lineage artifact binds both exact frozen inputs.'),
    true,
  );
});

await test('the catalog does not declare live web search', () => {
  const catalog = buildCatalog();

  for (const task of catalog.tasks) {
    strictEqual(task.allowed_tools.includes('web_search'), false, task.task_id);
  }
});

await test('the versioned tool-use designs declare exact command execution evidence', () => {
  const catalog = buildCatalog();
  const expectedTaskIds = Array.from(
    { length: 7 },
    (_, index) => `tool-use-${String(index + 1).padStart(2, '0')}`,
  );
  const toolUseTasks = catalog.tasks.filter(({ domain }) => domain === 'tool_use');

  strictEqual(catalog.status, 'candidate_requires_controlled_release_gate');
  deepStrictEqual(
    toolUseTasks.map(({ task_id: taskId }) => taskId),
    expectedTaskIds,
  );

  for (const task of catalog.tasks) {
    strictEqual(
      task.leakage_review.status,
      'public_design_versioned_private_content_required',
      task.task_id,
    );
    strictEqual(
      task.leakage_review.review_requirement,
      'private_corpus_tests_and_catalog_binding_required',
      task.task_id,
    );
    strictEqual(task.leakage_review.notes.includes('reviewed on 2026-07-29'), false, task.task_id);
    strictEqual(
      task.leakage_review.notes.includes(
        'must bind this exact catalog entry and pass the deterministic corpus tests before a real run',
      ),
      true,
      task.task_id,
    );

    const disclosureCount = task.evaluator.pass_conditions.filter(
      (condition) => condition === COMMAND_EXECUTION_DISCLOSURE,
    ).length;
    if (task.domain === 'tool_use') {
      deepStrictEqual(
        task.allowed_tools,
        ['filesystem_read', 'filesystem_write', 'command_execution'],
        task.task_id,
      );
      strictEqual(disclosureCount, 1, task.task_id);
      strictEqual(
        task.evaluator.pass_conditions.at(-1),
        COMMAND_EXECUTION_DISCLOSURE,
        task.task_id,
      );
    } else {
      strictEqual(task.allowed_tools.includes('command_execution'), false, task.task_id);
      strictEqual(disclosureCount, 0, task.task_id);
    }
  }
});

await test('every task publishes structured evidence and acceptance commitments', () => {
  const catalog = buildCatalog();
  const expectedClasses = [
    'gold',
    'alternate_correct',
    'partial_low',
    'partial_high',
    'near_miss',
    'paired_contrast',
    'adversarial_format',
    'empty',
    'timeout',
  ];

  for (const task of catalog.tasks) {
    deepStrictEqual(Object.keys(task.evaluator.acceptance_fixture_commitments), expectedClasses);
    strictEqual(task.evaluator.execution_protocol, 'aiq.evaluator-protocol.v1');
    strictEqual(task.evaluator.binding_requirement, 'controlled_hidden_task_required');
    strictEqual(task.provenance.origin, 'calibration_driven_redesign');
    strictEqual(task.provenance.predecessor_task_version, '1.0.1');
    strictEqual(task.leakage_review.status, 'public_design_versioned_private_content_required');
    strictEqual(task.leakage_review.notes.includes(task.task_id), true);
    strictEqual(
      task.leakage_review.notes.includes('pass the deterministic corpus tests before a real run.'),
      true,
    );
    strictEqual(/^[a-z_]+-cluster-[0-9]{2}$/u.test(task.cluster_id), true);
  }
});

await test('all 72 designs declare a material 1.0.2 middle-discrimination revision', () => {
  const catalog = buildCatalog();
  const revisionCounts = new Map<string, number>();
  const taskSpecificDeltas = new Set<string>();

  strictEqual(catalog.distribution.difficulty_role.includes('provisional, non-ordinal'), true);
  deepStrictEqual(catalog.predecessor_catalog, PREDECESSOR_CATALOG);
  for (const task of catalog.tasks) {
    revisionCounts.set(
      task.design_revision.kind,
      (revisionCounts.get(task.design_revision.kind) ?? 0) + 1,
    );
    strictEqual(task.design_revision.supersedes_task_version, '1.0.1', task.task_id);
    strictEqual(task.design_revision.controlled_corpus_requirements.length, 4, task.task_id);
    strictEqual(
      task.design_revision.task_specific_delta.includes(
        requireValue(task.evaluator.pass_conditions[0], 'Task must have a first pass condition.'),
      ),
      true,
    );
    taskSpecificDeltas.add(task.design_revision.task_specific_delta);
    strictEqual(task.summary.includes('deterministic partial credit'), true, task.task_id);
    strictEqual(task.evaluator.scoring_contract.components.length, 4, task.task_id);
    strictEqual(
      task.evaluator.scoring_contract.components.reduce(
        (sum, component) => sum + component.weight_basis_points,
        0,
      ),
      10_000,
      task.task_id,
    );
    strictEqual(task.evaluator.pass_conditions.length >= 4, true, task.task_id);
  }

  deepStrictEqual(Object.fromEntries(revisionCounts), {
    retargeted: 27,
    rebalanced: 25,
    replacement: 20,
  });
  strictEqual(taskSpecificDeltas.size, 72);
});

await test('the preregistered release policy gates identity without claiming evidence', () => {
  const catalog = buildCatalog();
  const passingEvidence = buildReleaseEvidence();

  deepStrictEqual(catalog.release_gate_policy, RELEASE_GATE_POLICY);
  strictEqual(catalog.release_gate_policy.state, 'preregistered_not_evaluated');
  const passingResult = evaluateReleaseGate(passingEvidence);
  strictEqual(passingResult.passed, true);
  deepStrictEqual(passingResult.failures, []);

  for (const invalidEvidence of [
    { ...passingEvidence, catalog_release_identity_digest: `sha256:${'f'.repeat(64)}` },
    { ...passingEvidence, corpus_commitment_digest: 'missing' },
    { ...passingEvidence, model_matrix_digest: `sha256:${'f'.repeat(64)}` },
    { ...passingEvidence, repeat_ids: ['repeat-1', 'repeat-1', 'repeat-3'] },
    { ...passingEvidence, source_observations_digest: `sha256:${'f'.repeat(64)}` },
    { ...passingEvidence, execution_plan_digest: testDigest('wrong-execution-plan') },
    { ...passingEvidence, raw_cells: passingEvidence.raw_cells.slice(1) },
  ] as const) {
    strictEqual(evaluateReleaseGate(invalidEvidence).failures.includes('invalid_evidence'), true);
  }
  const authority = buildReleaseAuthority(passingEvidence);
  const firstAuthorityBinding = requireValue(
    authority.admission.contrast_bindings[0],
    'Authority must contain the first contrast binding.',
  );
  for (const invalidAuthority of [
    { ...authority, catalog_release_identity_digest: `sha256:${'f'.repeat(64)}` },
    { ...authority, execution_plan_digest: testDigest('wrong-execution-plan') },
    {
      ...authority,
      admission: { ...authority.admission, corpus_commitment_digest: `sha256:${'f'.repeat(64)}` },
    },
    {
      ...authority,
      admission: {
        ...authority.admission,
        model_matrix: { ...authority.admission.model_matrix, digest: `sha256:${'f'.repeat(64)}` },
      },
    },
    {
      ...authority,
      admission: {
        ...authority.admission,
        contrast_bindings: authority.admission.contrast_bindings.map((binding, index) =>
          index === 1
            ? {
                contrast_id: binding.contrast_id,
                challenge_variant_digest: binding.challenge_variant_digest,
                reference_variant_digest: firstAuthorityBinding.reference_variant_digest,
              }
            : binding,
        ),
      },
    },
  ] as const) {
    strictEqual(
      evaluateReleaseGateWithAuthority(
        passingEvidence,
        invalidAuthority,
        TRUST_POLICY,
        TRUST_ROOT,
      ).failures.includes('invalid_authority'),
      true,
    );
  }

  const infrastructureCells = passingEvidence.raw_cells.map((cell, index) =>
    index === 0
      ? {
          ...cell,
          status: 'infrastructure_failure' as const,
          reported_score: null,
          components: null,
          verification_status: 'failed' as const,
        }
      : cell,
  );
  strictEqual(
    evaluateReleaseGate(replaceRawCells(passingEvidence, infrastructureCells)).failures.includes(
      'infrastructure_failures',
    ),
    true,
  );
  const evaluatorCells = passingEvidence.raw_cells.map((cell, index) =>
    index === 0
      ? {
          ...cell,
          status: 'evaluator_failure' as const,
          reported_score: null,
          components: null,
          verification_status: 'failed' as const,
        }
      : cell,
  );
  strictEqual(
    evaluateReleaseGate(replaceRawCells(passingEvidence, evaluatorCells)).failures.includes(
      'evaluator_failures',
    ),
    true,
  );

  const insufficientContrasts = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, index) =>
      index === 0
        ? {
            ...contrast,
            pairs: contrast.pairs.map((pair) => ({ ...pair, challenge_score: 0.429 })),
          }
        : contrast,
    ),
  );
  strictEqual(
    evaluateReleaseGate(insufficientContrasts).failures.includes('paired_contrasts'),
    true,
  );
  const reversedContrast = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, index) =>
      index === 0
        ? {
            ...contrast,
            pairs: contrast.pairs.map((pair) => ({
              ...pair,
              reference_score: 0.4,
              challenge_score: 0.43,
            })),
          }
        : contrast,
    ),
  );
  strictEqual(evaluateReleaseGate(reversedContrast).failures.includes('paired_contrasts'), true);
  const uncertainContrast = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, contrastIndex) =>
      contrastIndex === 0
        ? {
            ...contrast,
            pairs: contrast.pairs.map((pair) => ({
              ...pair,
              challenge_score:
                FIXED_MODEL_MATRIX_IDENTITIES.findIndex(
                  ({ model_id: modelId }) => modelId === pair.model_id,
                ) %
                  2 ===
                0
                  ? 0.6
                  : 0.26,
            })),
          }
        : contrast,
    ),
  );
  strictEqual(evaluateReleaseGate(uncertainContrast).failures.includes('paired_contrasts'), true);
  const zeroLowerBound = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, index) =>
      index === 0 ? { ...contrast, pairs: contrastPairsAtLowerBound(contrast.pairs, 3) } : contrast,
    ),
  );
  strictEqual(evaluateReleaseGate(zeroLowerBound).failures.includes('paired_contrasts'), true);
  const positiveLowerBound = replacePairedContrasts(
    passingEvidence,
    passingEvidence.paired_contrasts.map((contrast, index) =>
      index === 0
        ? { ...contrast, pairs: contrastPairsAtLowerBound(contrast.pairs, 3.000_001) }
        : contrast,
    ),
  );
  strictEqual(evaluateReleaseGate(positiveLowerBound).failures.includes('paired_contrasts'), false);
  strictEqual(
    evaluateReleaseGate(
      replacePairedContrasts(passingEvidence, [
        requireValue(passingEvidence.paired_contrasts[0], 'First contrast is required.'),
        requireValue(passingEvidence.paired_contrasts[0], 'First contrast is required.'),
        requireValue(passingEvidence.paired_contrasts[2], 'Third contrast is required.'),
      ]),
    ).failures.includes('paired_contrasts'),
    true,
  );

  const unstableEvidence = buildReleaseEvidence(
    new Map(
      catalog.tasks.map(({ task_id: taskId }) => [
        taskId,
        { mean: 0.5, model_step: 0.006, repeat_step: 0.056 },
      ]),
    ),
  );
  const unstableResult = evaluateReleaseGate(unstableEvidence);
  strictEqual(unstableResult.failures.includes('stability_aggregate_sd'), true);
  strictEqual(unstableResult.failures.includes('stability_cell_range'), true);

  const exactSdEvidence = buildReleaseEvidence(
    new Map(
      catalog.tasks.map(({ task_id: taskId }) => [
        taskId,
        { mean: 0.5, model_step: 0.02, repeat_step: 0.02 },
      ]),
    ),
  );
  strictEqual(
    evaluateReleaseGate(exactSdEvidence).failures.includes('stability_aggregate_sd'),
    false,
  );
  const exactRangeEvidence = buildReleaseEvidence(
    new Map(
      catalog.tasks.map(({ task_id: taskId }) => [
        taskId,
        { mean: 0.5, model_step: 0.04, repeat_step: 0.05 },
      ]),
    ),
  );
  strictEqual(
    evaluateReleaseGate(exactRangeEvidence).failures.includes('stability_cell_range'),
    false,
  );

  const antiReliableCells = passingEvidence.raw_cells.map((cell) =>
    cell.repeat_id === 'repeat-2' && cell.reported_score !== null
      ? (() => {
          const components = componentsForScore(1 - cell.reported_score);
          return { ...cell, components, reported_score: scoreFromComponents(components) };
        })()
      : cell,
  );
  strictEqual(
    evaluateReleaseGate(replaceRawCells(passingEvidence, antiReliableCells)).failures.includes(
      'stability_icc',
    ),
    true,
  );

  const iccBoundaryProfiles = new Map(
    catalog.tasks.map(({ task_id: taskId }) => [
      taskId,
      { mean: 0.5, model_step: 0.005, repeat_step: 0.01 },
    ]),
  );
  strictEqual(
    evaluateReleaseGate(buildReleaseEvidence(iccBoundaryProfiles)).failures.includes(
      'stability_icc',
    ),
    false,
  );
  const belowIccProfiles = new Map(
    [...iccBoundaryProfiles].map(([taskId, profile]) => [
      taskId,
      { ...profile, repeat_step: 0.015 },
    ]),
  );
  strictEqual(
    evaluateReleaseGate(buildReleaseEvidence(belowIccProfiles)).failures.includes('stability_icc'),
    true,
  );

  const twoRepeatEvidence = buildReleaseEvidence(new Map(), ['repeat-1', 'repeat-2']);
  strictEqual(evaluateReleaseGate(twoRepeatEvidence).failures.includes('stability_repeats'), true);

  const invalidScoreCells = passingEvidence.raw_cells.map((cell, index) =>
    index === 0 ? { ...cell, reported_score: -0.1 } : cell,
  );
  strictEqual(
    evaluateReleaseGate({
      ...passingEvidence,
      source_observations_digest: releaseEvidenceSourceDigest(
        invalidScoreCells,
        passingEvidence.paired_contrasts,
      ),
      raw_cells: invalidScoreCells,
    }).failures.includes('invalid_evidence'),
    true,
  );
});

await test('signed authority binds source evidence and rejects caller-selected trust', () => {
  const evidence = buildReleaseEvidence();
  const authority = buildReleaseAuthority(evidence);
  strictEqual(
    evaluateReleaseGateWithAuthority(evidence, authority, TRUST_POLICY, TRUST_ROOT).passed,
    true,
  );

  const untrustedPolicy: ReleaseGateTrustPolicy = {
    ...TRUST_POLICY,
    authority_signers: [],
  };
  strictEqual(
    evaluateReleaseGateWithAuthority(
      evidence,
      authority,
      untrustedPolicy,
      TRUST_ROOT,
    ).failures.includes('invalid_authority'),
    true,
  );
  strictEqual(
    evaluateReleaseGateWithAuthority(
      evidence,
      authority,
      { ...TRUST_POLICY, promotion_signers: TRUST_POLICY.authority_signers },
      TRUST_ROOT,
    ).failures.includes('invalid_authority'),
    true,
  );
  const authorityPublicKey = requireValue(
    TRUST_POLICY.authority_signers[0],
    'Authority signer is required.',
  ).public_key_spki_base64;
  const sameKeyPolicy: ReleaseGateTrustPolicy = {
    ...TRUST_POLICY,
    promotion_signers: [
      {
        key_id: 'different-id-same-key',
        algorithm: 'ed25519',
        public_key_spki_base64: authorityPublicKey,
        public_key_fingerprint:
          'sha256:09a7c70f88e50bec0a7d589fab3ec3091ee333bbcc7de08b943037da23ad1de3',
      },
    ],
  };
  strictEqual(
    evaluateReleaseGateWithAuthority(evidence, authority, sameKeyPolicy, {
      ...TRUST_ROOT,
      trust_policy_digest: releaseGateTrustPolicyDigest(sameKeyPolicy),
    }).failures.includes('invalid_authority'),
    true,
  );
  strictEqual(
    evaluateReleaseGateWithAuthority(evidence, authority, TRUST_POLICY, {
      ...TRUST_ROOT,
      trust_policy_digest: testDigest('caller-selected-trust-policy'),
    }).failures.includes('invalid_authority'),
    true,
  );

  const selfSelected = {
    ...authority,
    signer: { key_id: 'caller-selected-key', algorithm: 'ed25519' as const },
    signature: '',
  };
  const selfSigned: ReleaseGateAuthority = {
    ...selfSelected,
    signature: sign(
      null,
      releaseAuthoritySigningBytes(selfSelected),
      createPrivateKey(AUTHORITY_PRIVATE_KEY),
    ).toString('base64'),
  };
  strictEqual(
    evaluateReleaseGateWithAuthority(
      evidence,
      selfSigned,
      TRUST_POLICY,
      TRUST_ROOT,
    ).failures.includes('invalid_authority'),
    true,
  );

  const firstCell = requireValue(evidence.raw_cells[0], 'Evidence requires one cell.');
  const firstComponent = requireValue(firstCell.components?.[0], 'Cell requires one component.');
  const changedComponents = [
    {
      ...firstComponent,
      assertions: firstComponent.assertions.map((assertion, index) =>
        index === 0 ? Object.assign({}, assertion, { passed: !assertion.passed }) : assertion,
      ),
    },
    ...(firstCell.components?.slice(1) ?? []),
  ];
  const changedCells = evidence.raw_cells.map((cell, index) =>
    index === 0
      ? {
          ...cell,
          components: changedComponents,
          reported_score: scoreFromComponents(changedComponents),
        }
      : cell,
  );
  const changedEvidence = replaceRawCells(evidence, changedCells);
  strictEqual(
    evaluateReleaseGateWithAuthority(
      changedEvidence,
      authority,
      TRUST_POLICY,
      TRUST_ROOT,
    ).failures.includes('invalid_evidence'),
    true,
  );

  const changedConfigurations: readonly ModelMatrixConfiguration[] =
    authority.admission.model_matrix.configurations.map((configuration, index) =>
      index === 0
        ? { ...configuration, reasoning_effort: 'medium' }
        : index === 1
          ? { ...configuration, reasoning_effort: 'low' }
          : configuration,
    );
  const changedMatrixEvidence = {
    ...evidence,
    model_matrix_digest: releaseEvidenceModelMatrixDigest(changedConfigurations),
  };
  const changedMatrixUnsigned: ReleaseGateAuthority = {
    ...authority,
    admission: {
      ...authority.admission,
      model_matrix: {
        configurations: changedConfigurations,
        digest: releaseEvidenceModelMatrixDigest(changedConfigurations),
      },
    },
    signature: '',
  };
  const changedMatrixAuthority: ReleaseGateAuthority = {
    ...changedMatrixUnsigned,
    signature: sign(
      null,
      releaseAuthoritySigningBytes(changedMatrixUnsigned),
      createPrivateKey(AUTHORITY_PRIVATE_KEY),
    ).toString('base64'),
  };
  strictEqual(
    evaluateReleaseGateWithAuthority(
      changedMatrixEvidence,
      changedMatrixAuthority,
      TRUST_POLICY,
      TRUST_ROOT,
    ).failures.includes('invalid_evidence'),
    true,
  );
});

await test('raw component evidence is recomputed and verifier-bound', () => {
  const evidence = buildReleaseEvidence();
  const firstCell = requireValue(evidence.raw_cells[0], 'Evidence requires one cell.');
  const firstComponent = requireValue(firstCell.components?.[0], 'Cell requires one component.');
  const falseStringCell = structuredClone(firstCell);
  const falseStringAssertion = requireValue(
    falseStringCell.components?.[0]?.assertions[0],
    'Cell requires one assertion.',
  );
  Reflect.set(falseStringAssertion, 'passed', 'false');
  const invalidCells = [
    evidence.raw_cells.map((cell, index) =>
      index === 0 ? { ...cell, reported_score: (cell.reported_score ?? 0) + 0.01 } : cell,
    ),
    evidence.raw_cells.map((cell, index) =>
      index === 0 ? { ...cell, verification_digest: null } : cell,
    ),
    evidence.raw_cells.map((cell, index) =>
      index === 0 ? { ...cell, cell_evidence_binding_digest: testDigest('wrong-binding') } : cell,
    ),
    evidence.raw_cells.map((cell, index) =>
      index === 0
        ? {
            ...cell,
            components: [
              { ...firstComponent, assertions: firstComponent.assertions.slice(0, 2) },
              ...(cell.components?.slice(1) ?? []),
            ],
          }
        : cell,
    ),
    evidence.raw_cells.map((cell, index) =>
      index === 0
        ? {
            ...cell,
            components: [
              {
                ...firstComponent,
                assertions: firstComponent.assertions.map((assertion, assertionIndex) =>
                  assertionIndex === 1
                    ? Object.assign({}, assertion, {
                        assertion_id: firstComponent.assertions[0]?.assertion_id ?? 'missing',
                      })
                    : assertion,
                ),
              },
              ...(cell.components?.slice(1) ?? []),
            ],
          }
        : cell,
    ),
    evidence.raw_cells.map((cell, index) =>
      index === 0
        ? {
            ...cell,
            components: [
              {
                ...firstComponent,
                assertions: firstComponent.assertions.map((assertion, assertionIndex) =>
                  assertionIndex === 1
                    ? Object.assign({}, assertion, { assertion_id: 'assertion_064' })
                    : assertion,
                ),
              },
              ...(cell.components?.slice(1) ?? []),
            ],
          }
        : cell,
    ),
    evidence.raw_cells.map((cell, index) => (index === 0 ? bindCell(falseStringCell) : cell)),
  ];
  for (const cells of invalidCells) {
    strictEqual(
      evaluateReleaseGate(replaceRawCells(evidence, cells)).failures.includes('invalid_evidence'),
      true,
    );
  }
  const secondCell = requireValue(evidence.raw_cells[1], 'Evidence requires a second cell.');
  const repeatedEvaluatorCells = evidence.raw_cells.map((cell, index) =>
    index === 0 ? bindCell({ ...cell, evaluator_digest: secondCell.evaluator_digest }) : cell,
  );
  const repeatedEvaluatorResult = evaluateReauthorizedEvidence(
    replaceRawCells(evidence, repeatedEvaluatorCells),
  );
  strictEqual(
    repeatedEvaluatorResult.failures.includes('invalid_evidence'),
    false,
    `byte-identical evaluator content may repeat across distinct cell-bound observations: ${repeatedEvaluatorResult.failures.join(',')}`,
  );

  for (const [cellField, attemptField] of [
    ['result_digest', 'result_digest'],
    ['result_package_digest', 'result_package_digest'],
    ['verification_digest', 'verifier_attestation_digest'],
  ] as const) {
    const duplicatedCells = evidence.raw_cells.map((cell, index) => {
      if (index !== 0) return cell;
      const duplicatedCell = structuredClone(cell);
      Reflect.set(duplicatedCell, cellField, secondCell[cellField]);
      if (attemptField !== undefined) {
        Reflect.set(
          requireValue(duplicatedCell.attempts.at(-1), 'Terminal attempt is required.'),
          attemptField,
          secondCell[cellField],
        );
      }
      return bindCell(duplicatedCell);
    });
    strictEqual(
      evaluateReauthorizedEvidence(replaceRawCells(evidence, duplicatedCells)).failures.includes(
        'invalid_evidence',
      ),
      true,
      `${cellField} must be unique for every completed cell`,
    );
  }
  const reusedBindingCells = evidence.raw_cells.map((cell, index) =>
    index === 0
      ? { ...cell, cell_evidence_binding_digest: secondCell.cell_evidence_binding_digest }
      : cell,
  );
  strictEqual(
    evaluateReauthorizedEvidence(replaceRawCells(evidence, reusedBindingCells)).failures.includes(
      'invalid_evidence',
    ),
    true,
    'cell evidence binding identities must be unique for every completed cell',
  );

  const firstContrast = requireValue(evidence.paired_contrasts[0], 'Contrast is required.');
  const firstPair = requireValue(firstContrast.pairs[0], 'Contrast pair is required.');
  const crossUniverseReuse = replacePairedContrasts(evidence, [
    {
      ...firstContrast,
      pairs: [
        {
          ...firstPair,
          reference_result_package_digest: requireValue(
            firstCell.result_package_digest ?? undefined,
            'Completed package digest is required.',
          ),
        },
        ...firstContrast.pairs.slice(1),
      ],
    },
    ...evidence.paired_contrasts.slice(1),
  ]);
  strictEqual(
    evaluateReauthorizedEvidence(crossUniverseReuse).failures.includes('invalid_evidence'),
    true,
  );
});

await test('admission rejects post-selection, reordered universes, cross-cell provenance, and selected retries', () => {
  const source = buildReleaseEvidence();
  const first = requireValue(source.raw_cells[0], 'First cell is required.');
  const second = requireValue(source.raw_cells[1], 'Second cell is required.');
  const otherRepeat = requireValue(source.raw_cells[72 * 17], 'Other repeat cell is required.');
  const mutations: ReleaseGateEvidence[] = [];

  mutations.push({ ...source, repeat_ids: [...source.repeat_ids, 'post-selected-repeat'] });
  mutations.push(replaceRawCells(source, [second, first, ...source.raw_cells.slice(2)]));
  mutations.push(
    replaceRawCells(
      source,
      source.raw_cells.map((cell, index) =>
        index === 0 ? bindCell({ ...cell, repeat_id: otherRepeat.repeat_id }) : cell,
      ),
    ),
  );
  mutations.push(
    replaceRawCells(
      source,
      source.raw_cells.map((cell, index) =>
        index === 0 ? bindCell({ ...cell, model_id: second.model_id }) : cell,
      ),
    ),
  );
  mutations.push(
    replaceRawCells(
      source,
      source.raw_cells.map((cell, index) =>
        index === 0 ? bindCell({ ...cell, model_id: 'gpt-5.6-sol-low' }) : cell,
      ),
    ),
  );
  mutations.push(
    replaceRawCells(
      source,
      source.raw_cells.map((cell, index) =>
        index === 0
          ? bindCell({
              ...cell,
              result_package_digest: testDigest('wrong-package'),
            })
          : cell,
      ),
    ),
  );
  mutations.push(
    replaceRawCells(
      source,
      source.raw_cells.map((cell, index) =>
        index === 0
          ? bindCell({
              ...cell,
              verification_digest: testDigest('wrong-attestation'),
              attempts: cell.attempts.map((attempt) => ({
                ...attempt,
                verifier_attestation_digest: testDigest('different-attestation'),
              })),
            })
          : cell,
      ),
    ),
  );
  mutations.push(
    replaceRawCells(
      source,
      source.raw_cells.map((cell, index) =>
        index === 0
          ? bindCell({
              ...cell,
              attempts: [
                {
                  ...requireValue(cell.attempts[0], 'Attempt is required.'),
                  disposition: 'infrastructure_retryable',
                  infrastructure_classification: 'pre_model_admission',
                  result_digest: null,
                  result_package_digest: null,
                  verifier_attestation_digest: null,
                },
              ],
            })
          : cell,
      ),
    ),
  );

  for (const [index, mutation] of mutations.entries()) {
    strictEqual(
      evaluateReleaseGate(mutation).failures.includes('invalid_evidence'),
      true,
      `mutation ${index} must be invalid evidence`,
    );
  }

  const contrast = requireValue(source.paired_contrasts[0], 'Contrast is required.');
  const crossRepeatPairs = contrast.pairs.map((pair, index) =>
    index === 0
      ? {
          ...pair,
          repeat_id: requireValue(contrast.pairs[17], 'Other repeat is required.').repeat_id,
        }
      : pair,
  );
  strictEqual(
    evaluateReleaseGate(
      replacePairedContrasts(source, [
        { ...contrast, pairs: crossRepeatPairs },
        ...source.paired_contrasts.slice(1),
      ]),
    ).failures.includes('paired_contrasts'),
    true,
  );
  strictEqual(
    evaluateReleaseGate(
      replacePairedContrasts(source, [
        {
          ...contrast,
          pairs: [
            requireValue(contrast.pairs[1], 'Pair is required.'),
            requireValue(contrast.pairs[0], 'Pair is required.'),
            ...contrast.pairs.slice(2),
          ],
        },
        ...source.paired_contrasts.slice(1),
      ]),
    ).failures.includes('paired_contrasts'),
    true,
  );
});

await test('release evidence requires the exact three-repeat, 3672-cell, and 153-pair universe', async () => {
  const evidenceSchema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-evidence.schema.json', 'utf8'),
  );
  const admissionSchema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-admission.schema.json', 'utf8'),
  );
  for (const repeatIds of [
    ['repeat-1', 'repeat-2'],
    ['repeat-1', 'repeat-2', 'repeat-3', 'repeat-4'],
  ]) {
    const repeated = buildReleaseEvidence(new Map(), repeatIds);
    const authority = buildReleaseAuthority(repeated);
    strictEqual(matchesSchema(repeated, evidenceSchema, evidenceSchema), false);
    strictEqual(matchesSchema(authority.admission, admissionSchema, admissionSchema), false);
    strictEqual(evaluateReauthorizedEvidence(repeated).failures.includes('invalid_evidence'), true);
  }

  const source = buildReleaseEvidence();
  strictEqual(source.raw_cells.length, 72 * 17 * 3);
  strictEqual(
    source.paired_contrasts.reduce((sum, contrast) => sum + contrast.pairs.length, 0),
    3 * 17 * 3,
  );
  strictEqual(2 * 3 * 17 * 3, 306);
  const first = requireValue(source.raw_cells[0], 'First raw cell is required.');
  const second = requireValue(source.raw_cells[1], 'Second raw cell is required.');
  for (const [cells, schemaMatches] of [
    [source.raw_cells.slice(1), false],
    [[...source.raw_cells, first], false],
    [[second, first, ...source.raw_cells.slice(2)], true],
  ] as const) {
    const changed = replaceRawCells(source, cells);
    strictEqual(matchesSchema(changed, evidenceSchema, evidenceSchema), schemaMatches);
    strictEqual(evaluateReauthorizedEvidence(changed).failures.includes('invalid_evidence'), true);
  }

  const firstContrast = requireValue(source.paired_contrasts[0], 'First contrast is required.');
  const firstPair = requireValue(firstContrast.pairs[0], 'First pair is required.');
  const secondPair = requireValue(firstContrast.pairs[1], 'Second pair is required.');
  for (const [pairs, schemaMatches] of [
    [firstContrast.pairs.slice(1), false],
    [[...firstContrast.pairs, firstPair], false],
    [[secondPair, firstPair, ...firstContrast.pairs.slice(2)], true],
  ] as const) {
    const changed = replacePairedContrasts(source, [
      { ...firstContrast, pairs },
      ...source.paired_contrasts.slice(1),
    ]);
    strictEqual(matchesSchema(changed, evidenceSchema, evidenceSchema), schemaMatches);
    strictEqual(evaluateReauthorizedEvidence(changed).failures.includes('paired_contrasts'), true);
  }
});

await test('admission schema closes every fixed model-matrix prefix entry', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-admission.schema.json', 'utf8'),
  );
  const admission = buildReleaseAuthority(buildReleaseEvidence()).admission;
  strictEqual(matchesSchema(admission, schema, schema), true);
  for (const changedEntry of [
    { ...admission.model_matrix.configurations[0], model_id: undefined },
    { ...admission.model_matrix.configurations[0], unexpected: 'private' },
    { ...admission.model_matrix.configurations[0], runtime_digest: `sha256:${'a'.repeat(64)}` },
  ]) {
    const changed: unknown = structuredClone(admission);
    if (!isJsonObject(changed) || !isJsonObject(changed.model_matrix)) {
      throw new Error('Admission matrix fixture is invalid.');
    }
    const matrix = changed.model_matrix;
    const configurations = matrix.configurations;
    if (!Array.isArray(configurations)) throw new Error('Admission configurations are invalid.');
    configurations[0] = changedEntry;
    strictEqual(matchesSchema(changed, schema, schema), false);
  }
});

await test('retry evidence separates logical schedules from ordered unit-attempt start times', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-evidence.schema.json', 'utf8'),
  );
  const source = buildReleaseEvidence();
  const first = requireValue(source.raw_cells[0], 'First raw cell is required.');
  const sameUnitCell = requireValue(source.raw_cells[1], 'Same-unit raw cell is required.');
  const originalAttempt = requireValue(first.attempts[0], 'First attempt is required.');
  const sameUnitAttempt = requireValue(sameUnitCell.attempts[0], 'Same-unit attempt is required.');
  const retryAttempt = {
    ...originalAttempt,
    model_started: false,
    disposition: 'infrastructure_retryable' as const,
    infrastructure_classification: 'pre_model_admission' as const,
    result_digest: null,
    result_package_digest: null,
    verifier_attestation_digest: null,
  };
  const completedAttempt = {
    ...originalAttempt,
    attempt_number: 2,
    scheduled_delay_seconds: 30 as const,
    scheduled_for: '2026-08-02T01:00:30.000Z',
    started_at: '2026-08-02T01:00:45.000Z',
  };
  const retriedCell = bindCell({ ...first, attempts: [retryAttempt, completedAttempt] });
  const validRetriedEvidence = replaceRawCells(source, [retriedCell, ...source.raw_cells.slice(1)]);
  strictEqual(originalAttempt.scheduled_for, '2026-08-02T01:00:00.000Z');
  strictEqual(originalAttempt.started_at, '2026-08-02T01:00:05.000Z');
  strictEqual(sameUnitAttempt.started_at, originalAttempt.started_at);
  strictEqual(matchesSchema(validRetriedEvidence, schema, schema), true);
  strictEqual(
    evaluateReauthorizedEvidence(validRetriedEvidence).failures.includes('invalid_evidence'),
    false,
  );

  const mutateRetriedCell = (field: string, value: unknown, attemptIndex = 0) => {
    const changed = structuredClone(retriedCell);
    Reflect.set(requireValue(changed.attempts[attemptIndex], 'Attempt is required.'), field, value);
    return bindCell(changed);
  };
  const evaluatorRetry = structuredClone(retriedCell);
  Object.assign(requireValue(evaluatorRetry.attempts[0], 'Retry attempt is required.'), {
    disposition: 'evaluator_failure',
    model_started: true,
    infrastructure_classification: null,
  });
  const tooManyAttempts = structuredClone(retriedCell);
  Reflect.set(tooManyAttempts, 'attempts', [
    retryAttempt,
    {
      ...retryAttempt,
      attempt_number: 2,
      scheduled_delay_seconds: 30,
      scheduled_for: '2026-08-02T01:00:30.000Z',
      started_at: '2026-08-02T01:00:45.000Z',
    },
    {
      ...retryAttempt,
      attempt_number: 3,
      scheduled_delay_seconds: 90,
      scheduled_for: '2026-08-02T01:01:30.000Z',
      started_at: '2026-08-02T01:01:45.000Z',
    },
    { ...completedAttempt, attempt_number: 4 },
  ]);
  const delayedActualStart = mutateRetriedCell('started_at', '2026-08-02T01:00:55.000Z', 1);
  const delayedActualEvidence = replaceRawCells(source, [
    delayedActualStart,
    ...source.raw_cells.slice(1),
  ]);
  strictEqual(matchesSchema(delayedActualEvidence, schema, schema), true);
  strictEqual(
    evaluateReauthorizedEvidence(delayedActualEvidence).failures.includes('invalid_evidence'),
    false,
  );
  const invalidRetryCells = [
    [mutateRetriedCell('model_started', true), false],
    [mutateRetriedCell('scheduled_delay_seconds', 90, 1), false],
    [mutateRetriedCell('scheduled_for', '2026-08-02T01:00:45.000Z', 1), true],
    [mutateRetriedCell('started_at', '2026-08-02T01:00:29.999Z', 1), true],
    [mutateRetriedCell('started_at', '2026-08-02T02:00:00.000Z', 1), true],
    [mutateRetriedCell('started_at', '2026-08-02T01:00:50.000Z'), true],
    [mutateRetriedCell('started_at', '2026-08-02T01:00:45Z', 1), true],
    [mutateRetriedCell('attempt_number', 3, 1), false],
    [bindCell(evaluatorRetry), true],
    [bindCell(tooManyAttempts), false],
  ] as const;
  for (const [cell, schemaMatches] of invalidRetryCells) {
    const changed = replaceRawCells(source, [cell, ...source.raw_cells.slice(1)]);
    strictEqual(matchesSchema(changed, schema, schema), schemaMatches);
    strictEqual(evaluateReauthorizedEvidence(changed).failures.includes('invalid_evidence'), true);
  }

  const lastRepeatCellIndex = 2 * 72 * 17;
  const lastRepeatCell = structuredClone(
    requireValue(source.raw_cells[lastRepeatCellIndex], 'Last-repeat cell is required.'),
  );
  Reflect.set(
    requireValue(lastRepeatCell.attempts[0], 'Last-repeat attempt is required.'),
    'started_at',
    '2026-08-03T00:00:00.001Z',
  );
  const afterCollectionCells = source.raw_cells.map((cell, index) =>
    index === lastRepeatCellIndex ? bindCell(lastRepeatCell) : cell,
  );
  const afterCollectionEvidence = replaceRawCells(source, afterCollectionCells);
  strictEqual(matchesSchema(afterCollectionEvidence, schema, schema), true);
  strictEqual(
    evaluateReauthorizedEvidence(afterCollectionEvidence).failures.includes('invalid_evidence'),
    true,
  );

  const terminalCell = bindCell({
    ...first,
    status: 'infrastructure_failure' as const,
    reported_score: null,
    components: null,
    evaluator_digest: null,
    result_digest: null,
    result_package_digest: null,
    verification_digest: null,
    verification_status: 'failed' as const,
    attempts: [
      {
        ...originalAttempt,
        model_started: false,
        disposition: 'infrastructure_terminal' as const,
        infrastructure_classification: 'pre_model_admission' as const,
        result_digest: null,
        result_package_digest: null,
        verifier_attestation_digest: null,
      },
    ],
  });
  const terminalEvidence = replaceRawCells(source, [terminalCell, ...source.raw_cells.slice(1)]);
  strictEqual(matchesSchema(terminalEvidence, schema, schema), true);
  strictEqual(
    evaluateReauthorizedEvidence(terminalEvidence).failures.includes('invalid_evidence'),
    false,
  );
  strictEqual(
    evaluateReauthorizedEvidence(terminalEvidence).failures.includes('incomplete_cells'),
    true,
  );
  const terminalWithProvenance = structuredClone(terminalCell);
  Reflect.set(
    requireValue(terminalWithProvenance.attempts[0], 'Terminal attempt is required.'),
    'result_digest',
    first.result_digest,
  );
  const invalidTerminalEvidence = replaceRawCells(source, [
    bindCell(terminalWithProvenance),
    ...source.raw_cells.slice(1),
  ]);
  strictEqual(matchesSchema(invalidTerminalEvidence, schema, schema), false);
  strictEqual(
    evaluateReauthorizedEvidence(invalidTerminalEvidence).failures.includes('invalid_evidence'),
    true,
  );

  const evaluatorFailureCell = bindCell({
    ...terminalCell,
    status: 'evaluator_failure' as const,
    attempts: [
      {
        ...originalAttempt,
        disposition: 'evaluator_failure' as const,
        model_started: true,
        infrastructure_classification: null,
        result_digest: null,
        result_package_digest: null,
        verifier_attestation_digest: null,
      },
    ],
  });
  const evaluatorFailureEvidence = replaceRawCells(source, [
    evaluatorFailureCell,
    ...source.raw_cells.slice(1),
  ]);
  strictEqual(matchesSchema(evaluatorFailureEvidence, schema, schema), true);
  strictEqual(
    evaluateReauthorizedEvidence(evaluatorFailureEvidence).failures.includes('invalid_evidence'),
    false,
  );
  strictEqual(
    evaluateReauthorizedEvidence(evaluatorFailureEvidence).failures.includes('incomplete_cells'),
    true,
  );
  const evaluatorFailureWithProvenance = structuredClone(evaluatorFailureCell);
  Reflect.set(
    requireValue(evaluatorFailureWithProvenance.attempts[0], 'Evaluator attempt is required.'),
    'verifier_attestation_digest',
    first.verification_digest,
  );
  const invalidEvaluatorEvidence = replaceRawCells(source, [
    bindCell(evaluatorFailureWithProvenance),
    ...source.raw_cells.slice(1),
  ]);
  strictEqual(matchesSchema(invalidEvaluatorEvidence, schema, schema), false);
  strictEqual(
    evaluateReauthorizedEvidence(invalidEvaluatorEvidence).failures.includes('invalid_evidence'),
    true,
  );

  for (const terminalState of [
    { status: 'model_failure', disposition: 'model_failure', modelStarted: true },
    { status: 'unsupported', disposition: 'unsupported', modelStarted: false },
    { status: 'unevaluated', disposition: 'unevaluated', modelStarted: false },
    { status: 'unevaluated', disposition: 'unevaluated', modelStarted: true },
  ] as const) {
    const terminalStateCell = bindCell({
      ...terminalCell,
      status: terminalState.status,
      attempts: [
        {
          ...originalAttempt,
          disposition: terminalState.disposition,
          model_started: terminalState.modelStarted,
          infrastructure_classification: null,
          result_digest: null,
          result_package_digest: null,
          verifier_attestation_digest: null,
        },
      ],
    });
    const terminalStateEvidence = replaceRawCells(source, [
      terminalStateCell,
      ...source.raw_cells.slice(1),
    ]);
    strictEqual(matchesSchema(terminalStateEvidence, schema, schema), true);
    const result = evaluateReauthorizedEvidence(terminalStateEvidence);
    strictEqual(result.failures.includes('invalid_evidence'), false);
    strictEqual(result.failures.includes('incomplete_cells'), true);
    strictEqual(result.passed, false);
  }
});

await test('assembler derives slots and bindings and rejects malformed signed-universe observations', async () => {
  const source = buildReleaseEvidence();
  const authority = buildReleaseAuthority(source);
  const observations = preAssemblyObservations(source);
  const assembled = await assembleReleaseEvidence(authority, observations);
  strictEqual(requireValue(assembled.raw_cells[0], 'First cell is required.').universe_slot, 1);
  strictEqual(
    requireValue(assembled.raw_cells[0], 'First cell is required.').cell_evidence_binding_digest,
    requireValue(source.raw_cells[0], 'Source cell is required.').cell_evidence_binding_digest,
  );
  strictEqual(
    requireValue(assembled.raw_cells.at(-1), 'Last cell is required.').universe_slot,
    3672,
  );

  const reorderedObservations = {
    ...observations,
    raw_cells: [
      requireValue(observations.raw_cells[1], 'Second observation cell is required.'),
      requireValue(observations.raw_cells[0], 'First observation cell is required.'),
      ...observations.raw_cells.slice(2),
    ],
  };
  await rejects(() => assembleReleaseEvidence(authority, reorderedObservations), /Raw cells/u);

  const wrongModelObservations = structuredClone(observations);
  Reflect.set(
    requireValue(wrongModelObservations.raw_cells[0], 'First observation is required.'),
    'model_id',
    'gpt-5.6-sol-low',
  );
  await rejects(() => assembleReleaseEvidence(authority, wrongModelObservations), /Raw cells/u);

  const callerBoundObservations = structuredClone(observations);
  const callerBoundCell = requireValue(
    callerBoundObservations.raw_cells[0],
    'First caller-bound observation is required.',
  );
  Reflect.set(
    callerBoundCell,
    'cell_evidence_binding_digest',
    testDigest('caller-selected-binding'),
  );
  await rejects(() => assembleReleaseEvidence(authority, callerBoundObservations), /omit derived/u);

  const malformedCell = structuredClone(requireValue(source.raw_cells[0], 'Cell is required.'));
  const malformedComponent = requireValue(
    malformedCell.components?.[0],
    'First component is required.',
  );
  Reflect.set(malformedComponent, 'passed_assertions', malformedComponent.passed_assertions + 1);
  const malformedEvidence = replaceRawCells(source, [
    bindCell(malformedCell),
    ...source.raw_cells.slice(1),
  ]);
  const malformedAuthority = buildReleaseAuthority(malformedEvidence);
  await rejects(
    () => assembleReleaseEvidence(malformedAuthority, preAssemblyObservations(malformedEvidence)),
    /release-evidence contract/u,
  );

  const shortComponentCell = structuredClone(
    requireValue(source.raw_cells[0], 'Cell is required.'),
  );
  Reflect.set(shortComponentCell, 'components', shortComponentCell.components?.slice(0, 3));
  const shortComponentEvidence = replaceRawCells(source, [
    bindCell(shortComponentCell),
    ...source.raw_cells.slice(1),
  ]);
  await rejects(
    () =>
      assembleReleaseEvidence(
        buildReleaseAuthority(shortComponentEvidence),
        preAssemblyObservations(shortComponentEvidence),
      ),
    /schema/u,
  );

  await Promise.all(
    (
      [
        ['result_digest', 'result'],
        ['result_package_digest', 'result-package'],
        ['verifier_attestation_digest', 'verifier-attestation'],
      ] as const
    ).map(async ([field, label]) => {
      const wrongProvenanceCell = structuredClone(
        requireValue(source.raw_cells[0], 'Cell is required.'),
      );
      Reflect.set(
        requireValue(wrongProvenanceCell.attempts[0], 'Attempt is required.'),
        field,
        testDigest(`different-${label}`),
      );
      const wrongProvenanceEvidence = replaceRawCells(source, [
        bindCell(wrongProvenanceCell),
        ...source.raw_cells.slice(1),
      ]);
      const wrongProvenanceAuthority = buildReleaseAuthority(wrongProvenanceEvidence);
      await rejects(
        () =>
          assembleReleaseEvidence(
            wrongProvenanceAuthority,
            preAssemblyObservations(wrongProvenanceEvidence),
          ),
        /release-evidence contract/u,
      );
    }),
  );

  const firstContrast = requireValue(source.paired_contrasts[0], 'Contrast is required.');
  const reorderedContrasts = replacePairedContrasts(source, [
    {
      ...firstContrast,
      pairs: [
        requireValue(firstContrast.pairs[1], 'Second pair is required.'),
        requireValue(firstContrast.pairs[0], 'First pair is required.'),
        ...firstContrast.pairs.slice(2),
      ],
    },
    ...source.paired_contrasts.slice(1),
  ]);
  await rejects(
    () =>
      assembleReleaseEvidence(
        buildReleaseAuthority(reorderedContrasts),
        preAssemblyObservations(reorderedContrasts),
      ),
    /Contrast observations/u,
  );
});

await test('only a separately trusted signed receipt promotes the immutable candidate', () => {
  const evidence = buildReleaseEvidence();
  const authority = buildReleaseAuthority(evidence);
  const receipt = buildPromotionReceipt(evidence, authority);
  strictEqual(buildCatalog().status, 'candidate_requires_controlled_release_gate');
  strictEqual(verifyPromotionReceipt(receipt, evidence, authority, TRUST_POLICY, TRUST_ROOT), true);
  strictEqual(
    verifyPromotionReceipt(
      { ...receipt, evidence_digest: `sha256:${'f'.repeat(64)}` },
      evidence,
      authority,
      TRUST_POLICY,
      TRUST_ROOT,
    ),
    false,
  );
  strictEqual(
    verifyPromotionReceipt(
      receipt,
      evidence,
      authority,
      { ...TRUST_POLICY, promotion_signers: [] },
      TRUST_ROOT,
    ),
    false,
  );
  strictEqual(
    verifyPromotionReceipt(
      { ...receipt, signature: mutateBase64PadBits(receipt.signature) },
      evidence,
      authority,
      TRUST_POLICY,
      TRUST_ROOT,
    ),
    false,
  );
});

await test('promotion receipt time is causal and remains independent of the collection window', () => {
  const evidence = buildReleaseEvidence();
  const authority = buildReleaseAuthority(evidence);
  const promotionKey = createPrivateKey(PROMOTION_PRIVATE_KEY);

  throws(
    () =>
      issuePromotionReceipt(
        evidence,
        authority,
        TRUST_POLICY,
        TRUST_ROOT,
        'release-promotion-test-2026',
        '2026-08-02T11:59:59.999Z',
        promotionKey,
      ),
    /does not precede evidence collection/u,
  );

  const equal = issuePromotionReceipt(
    evidence,
    authority,
    TRUST_POLICY,
    TRUST_ROOT,
    'release-promotion-test-2026',
    evidence.collected_at,
    promotionKey,
  );
  strictEqual(verifyPromotionReceipt(equal, evidence, authority, TRUST_POLICY, TRUST_ROOT), true);

  const afterCollectionWindow = issuePromotionReceipt(
    evidence,
    authority,
    TRUST_POLICY,
    TRUST_ROOT,
    'release-promotion-test-2026',
    '2026-08-03T00:00:00.001Z',
    promotionKey,
  );
  strictEqual(
    verifyPromotionReceipt(afterCollectionWindow, evidence, authority, TRUST_POLICY, TRUST_ROOT),
    true,
  );

  const independentlySignedBeforeEvidence = buildPromotionReceipt(
    evidence,
    authority,
    '2026-08-02T11:59:59.999Z',
  );
  strictEqual(
    verifyPromotionReceipt(
      independentlySignedBeforeEvidence,
      evidence,
      authority,
      TRUST_POLICY,
      TRUST_ROOT,
    ),
    false,
  );
});

await test('candidate release CLI validates, assembles, signs, evaluates, receipts, and manifests with canonical create-or-verify outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aiq-release-lifecycle-'));
  const evidence = buildReleaseEvidence();
  const authority = buildReleaseAuthority(evidence);
  const paths = Object.fromEntries(
    ['admission', 'authority', 'evidence', 'observations', 'trust-policy'].map((name) => [
      name,
      join(directory, `${name}.json`),
    ]),
  ) as Record<string, string>;
  const requiredPath = (name: string): string =>
    requireValue(paths[name], `${name} path is required.`);
  const {
    admission_digest: _admissionDigest,
    authority_digest: _authorityDigest,
    execution_plan_digest: _executionPlanDigest,
    model_id_mapping_digest: _modelIdMappingDigest,
    raw_cells: evidenceCells,
    source_observations_digest: _sourceDigest,
    ...observationEnvelope
  } = evidence;
  const observations = {
    ...observationEnvelope,
    raw_cells: evidenceCells.map(
      ({ universe_slot: _universeSlot, cell_evidence_binding_digest: _binding, ...cell }) => cell,
    ),
  };
  await Promise.all([
    writeFile(requiredPath('admission'), `${canonicalJson(authority.admission)}\n`, 'utf8'),
    writeFile(requiredPath('authority'), `${canonicalJson(authority)}\n`, 'utf8'),
    writeFile(requiredPath('evidence'), `${canonicalJson(evidence)}\n`, 'utf8'),
    writeFile(requiredPath('observations'), `${canonicalJson(observations)}\n`, 'utf8'),
    writeFile(requiredPath('trust-policy'), `${canonicalJson(TRUST_POLICY)}\n`, 'utf8'),
  ]);
  const contextArgs = [
    '--authority',
    requiredPath('authority'),
    '--evidence',
    requiredPath('evidence'),
    '--trust-policy',
    requiredPath('trust-policy'),
  ];
  const invalidEvidencePath = join(directory, 'invalid-evidence.json');
  const invalidAuthorityPath = join(directory, 'invalid-authority.json');
  const invalidAdmissionPath = join(directory, 'invalid-admission.json');
  const invalidObservationsPath = join(directory, 'invalid-observations.json');
  await Promise.all([
    writeFile(
      invalidEvidencePath,
      `${canonicalJson({ ...evidence, post_selected: true })}\n`,
      'utf8',
    ),
    writeFile(
      invalidAuthorityPath,
      `${canonicalJson({ ...authority, caller_key: true })}\n`,
      'utf8',
    ),
    writeFile(
      invalidAdmissionPath,
      `${canonicalJson({ ...authority.admission, mutable_plan: true })}\n`,
      'utf8',
    ),
    writeFile(
      invalidObservationsPath,
      `${canonicalJson({ ...observations, selected_subset: true })}\n`,
      'utf8',
    ),
  ]);
  const prettyAuthorityPath = join(directory, 'pretty-authority.json');
  const duplicateAuthorityPath = join(directory, 'duplicate-authority.json');
  const canonicalAuthority = canonicalJson(authority);
  await Promise.all([
    writeFile(prettyAuthorityPath, JSON.stringify(authority, null, 2), 'utf8'),
    writeFile(
      duplicateAuthorityPath,
      canonicalAuthority.replace(
        '{"admission":',
        `{"admission":${canonicalJson(authority.admission)},"admission":`,
      ),
      'utf8',
    ),
  ]);
  const assembledPath = join(directory, 'assembled.json');
  delete process.env[RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT];
  await rejects(
    () =>
      runCandidateReleaseCli([
        'assemble',
        '--authority',
        requiredPath('authority'),
        '--observations',
        requiredPath('observations'),
        '--trust-policy',
        requiredPath('trust-policy'),
        '--output',
        assembledPath,
      ]),
    /Missing protected runtime trust anchor/u,
  );
  process.env[RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT] = `sha256:${'A'.repeat(64)}`;
  await rejects(
    () =>
      runCandidateReleaseCli([
        'assemble',
        '--authority',
        requiredPath('authority'),
        '--observations',
        requiredPath('observations'),
        '--trust-policy',
        requiredPath('trust-policy'),
        '--output',
        assembledPath,
      ]),
    /canonical nonzero SHA-256 digest/u,
  );
  process.env[RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT] = TRUST_ROOT.trust_policy_digest;
  await Promise.all(
    [prettyAuthorityPath, duplicateAuthorityPath].map((noncanonicalAuthorityPath) =>
      rejects(
        () =>
          runCandidateReleaseCli([
            'validate',
            '--authority',
            noncanonicalAuthorityPath,
            '--evidence',
            requiredPath('evidence'),
            '--trust-policy',
            requiredPath('trust-policy'),
          ]),
        /canonical JSON bytes/u,
      ),
    ),
  );
  await runCandidateReleaseCli([
    'assemble',
    '--authority',
    requiredPath('authority'),
    '--observations',
    requiredPath('observations'),
    '--trust-policy',
    requiredPath('trust-policy'),
    '--output',
    assembledPath,
  ]);
  await runCandidateReleaseCli(['validate', ...contextArgs]);
  const attackerPolicy: ReleaseGateTrustPolicy = {
    ...TRUST_POLICY,
    authority_signers: TRUST_POLICY.authority_signers.map((signer) => ({
      ...signer,
      key_id: `attacker-${signer.key_id}`,
    })),
    promotion_signers: TRUST_POLICY.promotion_signers.map((signer) => ({
      ...signer,
      key_id: `attacker-${signer.key_id}`,
    })),
  };
  const attackerPolicyPath = join(directory, 'attacker-policy.json');
  const attackerRootPath = join(directory, 'attacker-root.json');
  await Promise.all([
    writeFile(attackerPolicyPath, `${canonicalJson(attackerPolicy)}\n`, 'utf8'),
    writeFile(
      attackerRootPath,
      `${canonicalJson({
        ...TRUST_ROOT,
        trust_policy_digest: releaseGateTrustPolicyDigest(attackerPolicy),
      })}\n`,
      'utf8',
    ),
  ]);
  await rejects(
    () =>
      runCandidateReleaseCli([
        'validate',
        '--authority',
        requiredPath('authority'),
        '--evidence',
        requiredPath('evidence'),
        '--trust-policy',
        attackerPolicyPath,
        '--trust-root',
        attackerRootPath,
      ]),
    /independently pinned runtime anchor/u,
  );
  await rejects(
    () => runCandidateReleaseCli(['validate', ...contextArgs, '--trust-root', attackerRootPath]),
    /--trust-root is not accepted/u,
  );
  await rejects(
    () =>
      runCandidateReleaseCli([
        'validate',
        '--authority',
        requiredPath('authority'),
        '--evidence',
        invalidEvidencePath,
        '--trust-policy',
        requiredPath('trust-policy'),
      ]),
    /schema/u,
  );
  await rejects(
    () =>
      runCandidateReleaseCli([
        'assemble',
        '--authority',
        requiredPath('authority'),
        '--observations',
        invalidObservationsPath,
        '--trust-policy',
        requiredPath('trust-policy'),
        '--output',
        join(directory, 'invalid-assembled.json'),
      ]),
    /closed pre-assembly/u,
  );
  const resultPath = join(directory, 'gate-result.json');
  await runCandidateReleaseCli(['evaluate', ...contextArgs, '--output', resultPath]);
  const initialResultBytes = await readFile(resultPath);
  await runCandidateReleaseCli(['evaluate', ...contextArgs, '--output', resultPath]);
  deepStrictEqual(await readFile(resultPath), initialResultBytes);
  const conflictingResultPath = join(directory, 'conflicting-gate-result.json');
  await writeFile(conflictingResultPath, '{}\n', { encoding: 'utf8', mode: 0o600 });
  await rejects(
    () => runCandidateReleaseCli(['evaluate', ...contextArgs, '--output', conflictingResultPath]),
    /conflicts with the expected canonical bytes/u,
  );

  process.env.AIQ_TEST_AUTHORITY_KEY = AUTHORITY_PRIVATE_KEY;
  process.env.AIQ_TEST_PROMOTION_KEY = PROMOTION_PRIVATE_KEY;
  try {
    await rejects(
      () =>
        runCandidateReleaseCli([
          'sign-admission',
          '--input',
          invalidAdmissionPath,
          '--trust-policy',
          requiredPath('trust-policy'),
          '--key-env',
          'AIQ_TEST_AUTHORITY_KEY',
          '--output',
          join(directory, 'invalid-signed-admission.json'),
        ]),
      /schema/u,
    );
    await rejects(
      () =>
        runCandidateReleaseCli([
          'sign-authority',
          '--input',
          invalidAuthorityPath,
          '--trust-policy',
          requiredPath('trust-policy'),
          '--key-env',
          'AIQ_TEST_AUTHORITY_KEY',
          '--output',
          join(directory, 'invalid-signed-authority.json'),
        ]),
      /schema/u,
    );
    const signedAdmissionPath = join(directory, 'signed-admission.json');
    await runCandidateReleaseCli([
      'sign-admission',
      '--input',
      requiredPath('admission'),
      '--trust-policy',
      requiredPath('trust-policy'),
      '--key-id',
      'release-authority-test-2026',
      '--key-env',
      'AIQ_TEST_AUTHORITY_KEY',
      '--output',
      signedAdmissionPath,
    ]);
    const noncanonicalAdmissionSignaturePath = join(
      directory,
      'noncanonical-admission-signature-authority.json',
    );
    await writeFile(
      noncanonicalAdmissionSignaturePath,
      `${canonicalJson({
        ...authority,
        admission: {
          ...authority.admission,
          signature: mutateBase64PadBits(authority.admission.signature),
        },
      })}\n`,
      'utf8',
    );
    await rejects(
      () =>
        runCandidateReleaseCli([
          'sign-authority',
          '--input',
          noncanonicalAdmissionSignaturePath,
          '--trust-policy',
          requiredPath('trust-policy'),
          '--key-env',
          'AIQ_TEST_AUTHORITY_KEY',
          '--output',
          join(directory, 'noncanonical-admission-signature-output.json'),
        ]),
      /Admission signature is not trusted/u,
    );
    const signedAuthorityPath = join(directory, 'signed-authority.json');
    await runCandidateReleaseCli([
      'sign-authority',
      '--input',
      requiredPath('authority'),
      '--trust-policy',
      requiredPath('trust-policy'),
      '--key-env',
      'AIQ_TEST_AUTHORITY_KEY',
      '--output',
      signedAuthorityPath,
    ]);
    const receiptPath = join(directory, 'receipt.json');
    const preEvidenceReceiptPath = join(directory, 'pre-evidence-receipt.json');
    await rejects(
      () =>
        runCandidateReleaseCli([
          'issue-receipt',
          ...contextArgs,
          '--key-id',
          'release-promotion-test-2026',
          '--key-env',
          'AIQ_TEST_PROMOTION_KEY',
          '--issued-at',
          '2026-08-02T11:59:59.999Z',
          '--output',
          preEvidenceReceiptPath,
        ]),
      /does not precede evidence collection/u,
    );
    await rejects(() => stat(preEvidenceReceiptPath), /ENOENT/u);
    await rejects(
      () =>
        runCandidateReleaseCli([
          'issue-receipt',
          '--authority',
          requiredPath('authority'),
          '--evidence',
          invalidEvidencePath,
          '--trust-policy',
          requiredPath('trust-policy'),
          '--key-id',
          'release-promotion-test-2026',
          '--key-env',
          'AIQ_TEST_PROMOTION_KEY',
          '--issued-at',
          '2026-08-02T12:00:00.000Z',
          '--output',
          join(directory, 'invalid-receipt.json'),
        ]),
      /schema/u,
    );
    await runCandidateReleaseCli([
      'issue-receipt',
      ...contextArgs,
      '--key-id',
      'release-promotion-test-2026',
      '--key-env',
      'AIQ_TEST_PROMOTION_KEY',
      '--issued-at',
      '2026-08-02T12:00:00.000Z',
      '--output',
      receiptPath,
    ]);
    const manifestPath = join(directory, 'manifest.json');
    await runCandidateReleaseCli([
      'release-manifest',
      ...contextArgs,
      '--receipt',
      receiptPath,
      '--output',
      manifestPath,
    ]);
    const invalidReceiptPath = join(directory, 'schema-invalid-receipt.json');
    const receiptJson = parseJsonObject(await readFile(receiptPath, 'utf8'));
    await writeFile(
      invalidReceiptPath,
      `${canonicalJson({ ...receiptJson, caller_selected: true })}\n`,
      'utf8',
    );
    await rejects(
      () =>
        runCandidateReleaseCli([
          'release-manifest',
          ...contextArgs,
          '--receipt',
          invalidReceiptPath,
          '--output',
          join(directory, 'invalid-manifest.json'),
        ]),
      /schema/u,
    );
    await runCandidateReleaseCli([
      'verify-manifest',
      ...contextArgs,
      '--receipt',
      receiptPath,
      '--manifest',
      manifestPath,
    ]);
    strictEqual((await stat(receiptPath)).mode & 0o777, 0o600);
  } finally {
    delete process.env.AIQ_TEST_AUTHORITY_KEY;
    delete process.env.AIQ_TEST_PROMOTION_KEY;
    delete process.env[RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT];
  }
});

await test('release thresholds accept exact task-count limits and reject one-step violations', () => {
  const catalog = buildCatalog();
  const tasksByDomain = DOMAINS.map((domain) =>
    catalog.tasks.filter((task) => task.domain === domain),
  );
  const floorIds = new Set(
    tasksByDomain
      .slice(0, 7)
      .map((tasks) => requireValue(tasks[0], 'Each domain must have a first task.').task_id),
  );
  const ceilingIds = new Set(
    tasksByDomain
      .slice(3)
      .map((tasks) => requireValue(tasks[1], 'Each domain must have a second task.').task_id),
  );
  const midIds = new Set<string>();
  for (const tasks of tasksByDomain) {
    for (const task of tasks) {
      if (!floorIds.has(task.task_id) && !ceilingIds.has(task.task_id) && midIds.size < 43) {
        midIds.add(task.task_id);
      }
    }
  }
  for (const tasks of tasksByDomain) {
    const required = Math.ceil(tasks.length / 2);
    const present = tasks.filter((task) => midIds.has(task.task_id)).length;
    for (const task of tasks) {
      if (
        tasks.filter((candidate) => midIds.has(candidate.task_id)).length >= required ||
        floorIds.has(task.task_id) ||
        ceilingIds.has(task.task_id)
      ) {
        continue;
      }
      midIds.add(task.task_id);
    }
    strictEqual(tasks.filter((task) => midIds.has(task.task_id)).length >= present, true);
  }
  while (midIds.size > 43) {
    const removable = [...midIds].find((taskId) => {
      const task = requireValue(
        catalog.tasks.find((candidate) => candidate.task_id === taskId),
        'Mid-band task must exist in the catalog.',
      );
      const domainTasks = requireValue(
        tasksByDomain[DOMAINS.indexOf(task.domain)],
        'Task domain must have a task list.',
      );
      return (
        domainTasks.filter((candidate) => midIds.has(candidate.task_id)).length >
        Math.ceil(domainTasks.length / 2)
      );
    });
    if (removable === undefined) break;
    midIds.delete(removable);
  }
  strictEqual(midIds.size, 43);

  const invariantIds = new Set([...midIds].slice(0, 14));
  const profiles = new Map<string, ScoreProfile>();
  for (const task of catalog.tasks) {
    const meanScore = floorIds.has(task.task_id)
      ? 0.1
      : ceilingIds.has(task.task_id)
        ? 0.9
        : midIds.has(task.task_id)
          ? 0.5
          : 0.15;
    profiles.set(task.task_id, {
      mean: meanScore,
      model_step: invariantIds.has(task.task_id) ? 0.0025 : 0.006,
      repeat_step: 0.005,
    });
  }
  const boundaryEvidence = buildReleaseEvidence(profiles);
  const boundaryResult = evaluateReleaseGate(boundaryEvidence);
  strictEqual(boundaryResult.passed, true);
  deepStrictEqual(boundaryResult.failures, []);

  const firstGapId = requireValue(
    catalog.tasks.find(
      (task) =>
        !floorIds.has(task.task_id) && !ceilingIds.has(task.task_id) && !midIds.has(task.task_id),
    ),
    'Boundary fixture requires a gap task.',
  ).task_id;
  const firstNonInvariantMid = requireValue(
    [...midIds].find((taskId) => !invariantIds.has(taskId)),
    'Boundary fixture requires a non-invariant mid-band task.',
  );
  for (const [failure, taskId, profile] of [
    ['floor_tasks', firstGapId, { mean: 0.1 }],
    ['ceiling_tasks', firstGapId, { mean: 0.9 }],
    ['mid_band_tasks', firstNonInvariantMid, { mean: 0.15 }],
    [
      'invariant_tasks',
      firstNonInvariantMid,
      { mean: 0.5, model_step: 0.0025, repeat_step: 0.005 },
    ],
  ] as const) {
    const changedProfiles = new Map(profiles);
    changedProfiles.set(taskId, profile);
    strictEqual(
      evaluateReleaseGate(buildReleaseEvidence(changedProfiles)).failures.includes(failure),
      true,
      failure,
    );
  }
});

await test('release domain-share limits cover 6-, 7-, and 8-task domains', () => {
  const catalog = buildCatalog();
  for (const domain of ['instruction_following', 'repository_understanding', 'coding'] as const) {
    const domainTasks = catalog.tasks.filter((task) => task.domain === domain);
    const maximumExtreme = Math.floor(domainTasks.length * 0.3);
    const minimumMid = Math.ceil(domainTasks.length * 0.5);
    for (const [score, label] of [
      [0.1, 'floor'],
      [0.9, 'ceiling'],
    ] as const) {
      const allowedProfiles = new Map<string, ScoreProfile>();
      for (const task of domainTasks.slice(0, maximumExtreme)) {
        allowedProfiles.set(task.task_id, { mean: score });
      }
      strictEqual(
        evaluateReleaseGate(buildReleaseEvidence(allowedProfiles)).failures.includes(
          `domain_${label}:${domain}`,
        ),
        false,
      );
      allowedProfiles.set(
        requireValue(domainTasks[maximumExtreme], 'Domain must contain the boundary task.').task_id,
        { mean: score },
      );
      strictEqual(
        evaluateReleaseGate(buildReleaseEvidence(allowedProfiles)).failures.includes(
          `domain_${label}:${domain}`,
        ),
        true,
      );
    }
    const exactMid = new Map<string, ScoreProfile>();
    for (const task of domainTasks) exactMid.set(task.task_id, { mean: 0.15 });
    for (const task of domainTasks.slice(0, minimumMid)) {
      exactMid.set(task.task_id, { mean: 0.5 });
    }
    strictEqual(
      evaluateReleaseGate(buildReleaseEvidence(exactMid)).failures.includes(
        `domain_mid_band:${domain}`,
      ),
      false,
    );
    const insufficientMid = new Map<string, ScoreProfile>();
    for (const task of domainTasks) {
      insufficientMid.set(task.task_id, { mean: 0.15 });
    }
    for (const task of domainTasks.slice(0, minimumMid - 1)) {
      insufficientMid.set(task.task_id, { mean: 0.5 });
    }
    strictEqual(
      evaluateReleaseGate(buildReleaseEvidence(insufficientMid)).failures.includes(
        `domain_mid_band:${domain}`,
      ),
      true,
    );
  }
});

await test('semantic dependencies share conservative cross-domain clusters', () => {
  const tasks = new Map(buildCatalog().tasks.map((task) => [task.task_id, task]));

  strictEqual(tasks.get('coding-08')?.cluster_id, tasks.get('reliability-recovery-02')?.cluster_id);
  strictEqual(
    tasks.get('instruction-following-02')?.cluster_id,
    tasks.get('instruction-following-06')?.cluster_id,
  );
  strictEqual(
    tasks.get('instruction-following-02')?.cluster_id,
    tasks.get('tool-use-05')?.cluster_id,
  );
  strictEqual(
    tasks.get('retrieval-verification-01')?.cluster_id,
    tasks.get('retrieval-verification-07')?.cluster_id,
  );
});

await test('catalog invariants reject unknown tools and mixed none', () => {
  const source = buildCatalog();
  const unknown = replaceFirstAllowedTools(source, ['shell']);
  throws(() => assertCatalogInvariants(unknown), /invalid allowed-tools policy/);

  const webSearch = replaceFirstAllowedTools(source, ['web_search']);
  throws(() => assertCatalogInvariants(webSearch), /invalid allowed-tools policy/);

  const mixedNone = replaceFirstAllowedTools(source, ['none', 'filesystem_read']);
  throws(() => assertCatalogInvariants(mixedNone), /invalid allowed-tools policy/);
});

await test('catalog invariants freeze the exact tool-use execution policy and disclosure', () => {
  const source = buildCatalog();
  const replaceToolUse = (taskId: string, update: (task: CatalogTask) => CatalogTask): Catalog => ({
    ...source,
    tasks: source.tasks.map((task) => (task.task_id === taskId ? update(task) : task)),
  });

  for (const allowedTools of [
    ['filesystem_read', 'filesystem_write'],
    ['command_execution', 'filesystem_read', 'filesystem_write'],
    ['filesystem_read', 'filesystem_write', 'command_execution', 'web_search'],
  ] as const) {
    throws(
      () =>
        assertCatalogInvariants(
          replaceToolUse('tool-use-01', (task) => ({ ...task, allowed_tools: allowedTools })),
        ),
      /invalid allowed-tools policy/,
    );
  }

  const missingDisclosure = replaceToolUse('tool-use-01', (task) => ({
    ...task,
    evaluator: {
      ...task.evaluator,
      pass_conditions: task.evaluator.pass_conditions.filter(
        (condition) => condition !== COMMAND_EXECUTION_DISCLOSURE,
      ),
    },
  }));
  throws(
    () => assertCatalogInvariants(missingDisclosure),
    /invalid command-execution evidence disclosure/,
  );
});

await test('generated catalog matches the published catalog schema', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/candidates/aiq-core-1.0.2/catalog.schema.json', 'utf8'),
  );
  const catalog = buildCatalog();
  const taskSchema = resolveReference(schema, '#/$defs/task');
  const publicTaskSchema = parseJsonObject(
    await readFile('benchmarks/candidates/aiq-core-1.0.2/task.schema.json', 'utf8'),
  );
  const exampleNames = (await readdir('benchmarks/examples/tasks')).filter((name) =>
    name.endsWith('.json'),
  );

  strictEqual(matchesSchema(catalog, schema, schema), true);

  for (const task of catalog.tasks) {
    strictEqual(matchesSchema(task, taskSchema, schema), true, `${task.task_id} must match`);
  }
  await Promise.all(
    exampleNames.map(async (name) => {
      const task: unknown = JSON.parse(
        await readFile(join('benchmarks/examples/tasks', name), 'utf8'),
      );
      strictEqual(
        matchesSchema(task, publicTaskSchema, publicTaskSchema),
        true,
        `${name} must match`,
      );
    }),
  );

  strictEqual(catalog.tasks.length + exampleNames.length, 82);
});

await test('catalog schema rejects repeated contrasts, repeated components, and wrong weights', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/candidates/aiq-core-1.0.2/catalog.schema.json', 'utf8'),
  );
  const catalog = buildCatalog();

  const repeatedContrast = catalogJson(catalog);
  const contrastList = arrayProperty(
    objectProperty(repeatedContrast, 'release_gate_policy'),
    'predeclared_contrasts',
  );
  contrastList[1] = structuredClone(contrastList[0]);
  strictEqual(matchesSchema(repeatedContrast, schema, schema), false);

  const repeatedComponent = catalogJson(catalog);
  const firstTask = arrayProperty(repeatedComponent, 'tasks')[0];
  if (!isJsonObject(firstTask)) throw new TypeError('First task must be an object.');
  const components = arrayProperty(
    objectProperty(objectProperty(firstTask, 'evaluator'), 'scoring_contract'),
    'components',
  );
  components[1] = structuredClone(components[0]);
  strictEqual(matchesSchema(repeatedComponent, schema, schema), false);

  const wrongWeight = catalogJson(catalog);
  const weightedTask = arrayProperty(wrongWeight, 'tasks')[0];
  if (!isJsonObject(weightedTask)) throw new TypeError('First task must be an object.');
  const weightedComponents = arrayProperty(
    objectProperty(objectProperty(weightedTask, 'evaluator'), 'scoring_contract'),
    'components',
  );
  const weightedComponent = weightedComponents[0];
  if (!isJsonObject(weightedComponent)) throw new TypeError('Component must be an object.');
  weightedComponent.weight_basis_points = 2999;
  strictEqual(matchesSchema(wrongWeight, schema, schema), false);
});

await test('release evidence schema accepts raw cells and rejects aggregate or identity shortcuts', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-evidence.schema.json', 'utf8'),
  );
  const evidence = buildReleaseEvidence();
  strictEqual(matchesSchema(evidence, schema, schema), true);
  strictEqual('tasks' in evidence, false);
  strictEqual('stability' in evidence, false);
  strictEqual('infrastructure_failures' in evidence, false);

  for (const invalid of [
    { ...evidence, catalog_release_identity_digest: `sha256:${'f'.repeat(64)}` },
    { ...evidence, repeat_ids: ['repeat-1', 'repeat-1', 'repeat-3'] },
    { ...evidence, raw_cells: evidence.raw_cells.slice(1) },
    {
      ...evidence,
      paired_contrasts: [
        requireValue(evidence.paired_contrasts[0], 'First contrast is required.'),
        requireValue(evidence.paired_contrasts[0], 'First contrast is required.'),
        requireValue(evidence.paired_contrasts[2], 'Third contrast is required.'),
      ],
    },
  ]) {
    strictEqual(matchesSchema(invalid, schema, schema), false);
  }

  const weightedAssertion = structuredClone(evidence);
  const weightedCell = weightedAssertion.raw_cells[0];
  if (!isJsonObject(weightedCell)) throw new TypeError('First raw cell must be an object.');
  const weightedComponent = arrayProperty(weightedCell, 'components')[0];
  if (!isJsonObject(weightedComponent)) throw new TypeError('First component must be an object.');
  const weightedEvidence = arrayProperty(weightedComponent, 'assertions')[0];
  if (!isJsonObject(weightedEvidence)) throw new TypeError('First assertion must be an object.');
  weightedEvidence.weight = 1;
  strictEqual(matchesSchema(weightedAssertion, schema, schema), false);

  for (const invalidAssertionId of ['private_criterion_security_boundary', 'assertion_065']) {
    const invalidAssertion = structuredClone(evidence);
    const invalidCell = invalidAssertion.raw_cells[0];
    if (!isJsonObject(invalidCell)) throw new TypeError('First raw cell must be an object.');
    const invalidComponent = arrayProperty(invalidCell, 'components')[0];
    if (!isJsonObject(invalidComponent)) throw new TypeError('First component must be an object.');
    const assertion = arrayProperty(invalidComponent, 'assertions')[0];
    if (!isJsonObject(assertion)) throw new TypeError('First assertion must be an object.');
    assertion.assertion_id = invalidAssertionId;
    strictEqual(matchesSchema(invalidAssertion, schema, schema), false);
  }

  const tooFewAssertions = structuredClone(evidence);
  const shortCell = tooFewAssertions.raw_cells[0];
  if (!isJsonObject(shortCell)) throw new TypeError('First raw cell must be an object.');
  const shortComponent = arrayProperty(shortCell, 'components')[0];
  if (!isJsonObject(shortComponent)) throw new TypeError('First component must be an object.');
  shortComponent.assertions = arrayProperty(shortComponent, 'assertions').slice(0, 2);
  strictEqual(matchesSchema(tooFewAssertions, schema, schema), false);
});

await test('authority, trust, promotion receipt, and released manifest schemas are canonical closed contracts', async () => {
  const evidence = buildReleaseEvidence();
  const authority = buildReleaseAuthority(evidence);
  const receipt = buildPromotionReceipt(evidence, authority);
  const authoritySchema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-authority.schema.json', 'utf8'),
  );
  const admissionSchema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-admission.schema.json', 'utf8'),
  );
  const authorityProperties = objectProperty(authoritySchema, 'properties');
  const authorityDefinitions = objectProperty(authoritySchema, '$defs');
  const admissionDefinitions = objectProperty(admissionSchema, '$defs');
  const resolvedAuthoritySchema: JsonSchema = {
    ...authoritySchema,
    properties: { ...authorityProperties, admission: admissionSchema },
    $defs: { ...authorityDefinitions, ...admissionDefinitions },
  };
  const trustSchema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-trust-policy.schema.json', 'utf8'),
  );
  const trustRootSchema = parseJsonObject(
    await readFile('benchmarks/schema/release-gate-trust-root.schema.json', 'utf8'),
  );
  const receiptSchema = parseJsonObject(
    await readFile('benchmarks/schema/promotion-receipt.schema.json', 'utf8'),
  );
  const manifestSchema = parseJsonObject(
    await readFile('benchmarks/schema/released-manifest.schema.json', 'utf8'),
  );
  const manifest = {
    schema_version: 'aiq.released-manifest.v1',
    release_identity: 'aiq-core/1.0.2',
    release_status: 'released_by_verified_receipt',
    candidate_catalog_release_identity_digest: buildCatalog().catalog_release_identity.digest,
    task_metadata_identity_digest: buildCatalog().task_metadata_identity.digest,
    receipt_digest: testDigest('promotion-receipt'),
    released_at: '2026-08-02T12:00:00.000Z',
  };
  strictEqual(matchesSchema(authority, resolvedAuthoritySchema, resolvedAuthoritySchema), true);
  strictEqual(matchesSchema(authority.admission, admissionSchema, admissionSchema), true);
  strictEqual(matchesSchema(TRUST_POLICY, trustSchema, trustSchema), true);
  strictEqual(matchesSchema(TRUST_ROOT, trustRootSchema, trustRootSchema), true);
  strictEqual(matchesSchema(receipt, receiptSchema, receiptSchema), true);
  strictEqual(matchesSchema(manifest, manifestSchema, manifestSchema), true);
  await rejects(() => stat('benchmarks/schema/release-receipt.schema.json'), /ENOENT/u);
  await rejects(() => stat('benchmarks/schema/released-version-manifest.schema.json'), /ENOENT/u);
  strictEqual(
    matchesSchema(
      { ...authority, public_key: 'caller-selected' },
      resolvedAuthoritySchema,
      resolvedAuthoritySchema,
    ),
    false,
  );
  strictEqual(
    matchesSchema(
      {
        ...authority.admission,
        model_matrix: {
          ...authority.admission.model_matrix,
          configurations: authority.admission.model_matrix.configurations.map(
            (configuration, index) =>
              index === 0 ? { ...configuration, reasoning_effort: 'medium' } : configuration,
          ),
        },
      },
      admissionSchema,
      admissionSchema,
    ),
    false,
  );
  strictEqual(
    matchesSchema(
      {
        ...authority.admission,
        model_matrix: {
          ...authority.admission.model_matrix,
          configurations: authority.admission.model_matrix.configurations.slice(1),
        },
      },
      admissionSchema,
      admissionSchema,
    ),
    false,
  );
  strictEqual(
    matchesSchema({ ...receipt, promotion_state: 'candidate' }, receiptSchema, receiptSchema),
    false,
  );
  strictEqual(
    matchesSchema(
      { ...receipt, schema_version: 'aiq.release-receipt.v1' },
      receiptSchema,
      receiptSchema,
    ),
    false,
  );
});

await test('task schemas bind command execution to an explicit filesystem scope', async () => {
  const catalogSchema = parseJsonObject(
    await readFile('benchmarks/candidates/aiq-core-1.0.2/catalog.schema.json', 'utf8'),
  );
  const catalogTaskSchema = resolveReference(catalogSchema, '#/$defs/task');
  const catalogTask = buildCatalog().tasks.find(({ domain }) => domain === 'tool_use');
  if (catalogTask === undefined) {
    throw new Error('Catalog must contain a tool-use task.');
  }

  strictEqual(
    matchesSchema(
      { ...catalogTask, allowed_tools: ['command_execution'] },
      catalogTaskSchema,
      catalogSchema,
    ),
    false,
  );
  strictEqual(
    matchesSchema(
      {
        ...catalogTask,
        allowed_tools: ['filesystem_read', 'command_execution'],
      },
      catalogTaskSchema,
      catalogSchema,
    ),
    true,
  );

  const taskSchema = parseJsonObject(
    await readFile('benchmarks/candidates/aiq-core-1.0.2/task.schema.json', 'utf8'),
  );
  const publicTask = parseJsonObject(
    await readFile('benchmarks/examples/tasks/public-example-tool-use.json', 'utf8'),
  );

  strictEqual(
    matchesSchema({ ...publicTask, allowed_tools: ['command_execution'] }, taskSchema, taskSchema),
    false,
  );
  strictEqual(
    matchesSchema(
      {
        ...publicTask,
        allowed_tools: ['filesystem_write', 'command_execution'],
      },
      taskSchema,
      taskSchema,
    ),
    true,
  );
});

await test('catalog machine tokens, versions, fixtures, and acceptance handles are exact', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/candidates/aiq-core-1.0.2/catalog.schema.json', 'utf8'),
  );
  const source = buildCatalog();
  const first = source.tasks[0];
  if (first === undefined) {
    throw new Error('Catalog must contain a task.');
  }

  const invalidTasks: CatalogTask[] = [
    { ...first, task_id: `${first.task_id}\n` },
    { ...first, cluster_id: `${first.cluster_id}\r\n` },
    { ...first, task_version: '01.0.0' },
    { ...first, tags: [`${first.tags[0] ?? 'tag'}\u2028`] },
    {
      ...first,
      input_contract: { ...first.input_contract, kind: `${first.input_contract.kind}\u2029` },
    },
    {
      ...first,
      input_contract: {
        ...first.input_contract,
        fixture_profile: `aiq-fixture://${first.task_id}/v2`,
      },
    },
    {
      ...first,
      input_contract: {
        ...first.input_contract,
        content_handle: `aiq-controlled-task://other/1.0.2/${first.task_id}`,
      },
    },
    {
      ...first,
      evaluator: { ...first.evaluator, kind: `${first.evaluator.kind}\n` },
    },
    {
      ...first,
      evaluator: { ...first.evaluator, scorer_version: '1.0.0-beta' },
    },
    {
      ...first,
      evaluator: {
        ...first.evaluator,
        acceptance_fixture_commitments: {
          ...first.evaluator.acceptance_fixture_commitments,
          gold: {
            ...first.evaluator.acceptance_fixture_commitments.gold,
            handle: `aiq-acceptance://${first.task_id}/v2/golden`,
          },
        },
      },
    },
  ];

  for (const task of invalidTasks) {
    strictEqual(matchesSchema(replaceFirstTask(source, task), schema, schema), false);
  }
});

await test('generated catalog byte-matches the checked-in artifact', async () => {
  const published = await readFile('benchmarks/candidates/aiq-core-1.0.2/catalog.json', 'utf8');
  strictEqual(published, `${JSON.stringify(buildCatalog(), undefined, 2)}\n`);
});

await test('published task schema accepts examples and rejects shared negative fixtures', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/candidates/aiq-core-1.0.2/task.schema.json', 'utf8'),
  );
  strictEqual(schema.$id, 'https://aiq.wiki/schema/task.v2.json');
  strictEqual(
    objectProperty(objectProperty(schema, 'properties'), 'schema_version').const,
    'aiq.task.v2',
  );
  const exampleNames = (await readdir('benchmarks/examples/tasks')).filter((name) =>
    name.endsWith('.json'),
  );
  await Promise.all(
    exampleNames.map(async (name) => {
      const task: unknown = JSON.parse(
        await readFile(join('benchmarks/examples/tasks', name), 'utf8'),
      );
      strictEqual(matchesSchema(task, schema, schema), true, `${name} must match the schema`);
    }),
  );

  const negativeNames = (await readdir('benchmarks/fixtures/tasks')).filter((name) =>
    name.endsWith('.json'),
  );
  await Promise.all(
    negativeNames.map(async (name) => {
      const task: unknown = JSON.parse(
        await readFile(join('benchmarks/fixtures/tasks', name), 'utf8'),
      );
      strictEqual(matchesSchema(task, schema, schema), false, `${name} must fail the schema`);
    }),
  );
});

await test('task schema keeps human text multiline and rejects unsafe machine fields', async () => {
  const schema = parseJsonObject(
    await readFile('benchmarks/candidates/aiq-core-1.0.2/task.schema.json', 'utf8'),
  );
  const task = parseJsonObject(
    await readFile('benchmarks/examples/tasks/public-example-coding.json', 'utf8'),
  );
  strictEqual(task.schema_version, 'aiq.task.v2');
  strictEqual(matchesSchema({ ...task, schema_version: 'aiq.task.v1' }, schema, schema), false);
  const multiline = structuredClone(task);

  multiline.title = 'A multiline\npublic title';
  multiline.prompt = 'Line one.\nLine two.';
  multiline.leakage_notes = ['Reviewed line one.\nReviewed line two.'];

  strictEqual(matchesSchema(multiline, schema, schema), true);

  for (const [field, value] of [
    ['task_id', `${String(task.task_id)}\n`],
    ['task_id', `${String(task.task_id)}\r\n`],
    ['task_id', `${String(task.task_id)}\u2028`],
    ['task_id', `${String(task.task_id)}\u2029`],
    ['task_version', '01.0.0'],
    ['scorer_version', '1.0.0-beta'],
    ['cluster_id', 'coding-cluster-1'],
  ] as const) {
    const changed = structuredClone(task);
    changed[field] = value;
    strictEqual(matchesSchema(changed, schema, schema), false, `${field} must be rejected`);
  }

  for (const reference of [
    'repo://',
    'repo:///absolute',
    'repo://.',
    'repo://./file',
    'repo://dir/.',
    'repo://dir/..',
    'repo://dir//file',
    'repo://dir/',
    'repo://dir\\file',
    `repo://fixture.json\n`,
    `repo://fixture.json\r\n`,
    `repo://fixture.json\u2028`,
    `repo://fixture.json\u2029`,
    'aiq-controlled-fixture://aiq-core/1.0.2/coding-1',
    'aiq-controlled-fixture://other/1.0.2/coding-01',
    'aiq-controlled-acceptance://aiq-core/1.0.1/coding-01',
  ]) {
    const changed = structuredClone(task);
    changed.fixture_refs = [reference];
    strictEqual(matchesSchema(changed, schema, schema), false, `${reference} must be rejected`);
  }

  const invalidTag = structuredClone(task);
  invalidTag.tags = [`${String(arrayProperty(task, 'tags')[0])}\n`];
  strictEqual(matchesSchema(invalidTag, schema, schema), false);

  const invalidKind = structuredClone(task);
  objectProperty(invalidKind, 'evaluator').kind = 'exact_match\n';
  strictEqual(matchesSchema(invalidKind, schema, schema), false);

  const externalSchema = resolveReference(schema, '#/$defs/externalEvaluator');
  const external: JsonSchema = {
    protocol_version: 'aiq.evaluator-input.v2',
    scorer_version: '1.0.0',
    executable_ref: 'bin/evaluator',
    executable_digest: `sha256:${'a'.repeat(64)}`,
    runtime_kind: 'node',
    runtime_executable_digest: `sha256:${'c'.repeat(64)}`,
    configuration_digest: `sha256:${'b'.repeat(64)}`,
    timeout_ms: 1_000,
    max_input_bytes: 1_024,
    max_output_bytes: 1_024,
  };

  strictEqual(matchesSchema(external, externalSchema, schema), true);
  const configuredChecks = Array.from({ length: 16 }, (_, index) => ({
    check_id: `check_${String(index + 1)}`,
    type: 'text',
    weight: 1,
  }));
  strictEqual(
    matchesSchema(
      { ...external, configuration: { checks: configuredChecks } },
      externalSchema,
      schema,
    ),
    true,
  );
  strictEqual(
    matchesSchema(
      {
        ...external,
        configuration: {
          checks: [...configuredChecks, { check_id: 'check_17', type: 'text', weight: 1 }],
        },
      },
      externalSchema,
      schema,
    ),
    false,
  );
  for (const version of ['01.0.0', '1.00.0', '1.0.00', '1.0.0-beta']) {
    const changed = { ...external, scorer_version: version };
    strictEqual(matchesSchema(changed, externalSchema, schema), false);
  }
  for (const field of ['runtime_kind', 'runtime_executable_digest'] as const) {
    const changed = { ...external };
    delete changed[field];
    strictEqual(matchesSchema(changed, externalSchema, schema), false);
  }
  strictEqual(
    matchesSchema({ ...external, runtime_kind: 'python' }, externalSchema, schema),
    false,
  );
  strictEqual(
    matchesSchema(
      { ...external, runtime_executable_digest: `sha256:${'C'.repeat(64)}` },
      externalSchema,
      schema,
    ),
    false,
  );
  strictEqual(
    matchesSchema(
      { ...external, runtime_digest: external.runtime_executable_digest },
      externalSchema,
      schema,
    ),
    false,
  );

  const hiddenTask = structuredClone(task);
  hiddenTask.visibility = 'hidden';
  hiddenTask.catalog_entry_digest = `sha256:${'d'.repeat(64)}`;
  hiddenTask.evaluator = { kind: 'external_command', external };
  strictEqual(matchesSchema(hiddenTask, schema, schema), true);
  delete hiddenTask.catalog_entry_digest;
  strictEqual(matchesSchema(hiddenTask, schema, schema), false);
  hiddenTask.catalog_entry_digest = `sha256:${'D'.repeat(64)}`;
  strictEqual(matchesSchema(hiddenTask, schema, schema), false);
});
