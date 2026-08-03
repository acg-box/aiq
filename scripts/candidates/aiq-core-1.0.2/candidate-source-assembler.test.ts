/* oxlint-disable typescript/no-non-null-assertion, typescript/no-unsafe-type-assertion, typescript/restrict-template-expressions, typescript/no-floating-promises, eslint/no-await-in-loop, oxc/no-map-spread -- The model-free protocol fixture deliberately mutates deeply nested signed JSON and asserts rejected promises. */
import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIXED_MODEL_MATRIX_IDENTITIES,
  MODEL_EXECUTION_ID_MAPPING,
  RELEASE_GATE_POLICY,
  RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT,
  buildCatalog,
  releaseAdmissionDigest,
  releaseAdmissionSigningBytes,
  releaseAuthoritySigningBytes,
  releaseCellEvidenceBindingDigest,
  releaseEvidenceModelMatrixDigest,
  releaseEvidenceSourceDigest,
  releaseGateTrustPolicyDigest,
  releaseModelIdMappingDigest,
  type ReleaseGateAdmission,
  type ReleaseGateAuthority,
  type ReleaseGateRawCell,
  type ReleaseGateTrustPolicy,
} from './generate-benchmark-catalog.ts';
import { matchesSchema } from './candidate-release.ts';
import {
  RELEASE_GATE_EVIDENCE_SCHEMA_JSON,
  SOURCE_OBSERVATIONS_SCHEMA_JSON,
  assembleCandidateSource,
  type CandidateArtifactInput,
  type CandidateFinalSourceAssemblerInput,
  type CandidateSourceAssemblerInput,
} from './candidate-source-assembler.ts';

type JsonObject = Record<string, unknown>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value as object, key))}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function node(key: KeyObject): { node_id: string; public_key: string } {
  const bytes = rawPublicKey(key);
  return {
    node_id: `node_${createHash('sha256').update(bytes).digest('hex')}`,
    public_key: bytes.toString('hex'),
  };
}

function authorizationNode(key: KeyObject): { node_id: string; public_key: string } {
  const bytes = rawPublicKey(key);
  return {
    node_id: `candidate_node_${createHash('sha256').update(bytes).digest('hex')}`,
    public_key: bytes.toString('hex'),
  };
}

function signedHex(value: JsonObject, privateKey: KeyObject): string {
  const { signature: _signature, ...unsigned } = value;
  return sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('hex');
}

function envelope(
  payloadType: string,
  idempotencyKey: string,
  payload: JsonObject,
  privateKey: KeyObject,
  publicKey: KeyObject,
): JsonObject {
  const unsigned: JsonObject = {
    schema_version: 'aiq.candidate-signed-envelope.v1',
    idempotency_key: idempotencyKey,
    payload_type: payloadType,
    content_hash: digest(payload),
    signer: node(publicKey),
    claimed_trust: 'untrusted',
    payload,
  };
  return { ...unsigned, signature: signedHex({ ...unsigned, signature: '' }, privateKey) };
}

const authorityKeys = generateKeyPairSync('ed25519');
const promotionKeys = generateKeyPairSync('ed25519');
const runnerKeys = generateKeyPairSync('ed25519');
const verifierKeys = generateKeyPairSync('ed25519');
const authorizationKeys = generateKeyPairSync('ed25519');

test('embedded fixed-assembler schemas exactly match the public schema files', async () => {
  const [sourceSchema, evidenceSchema] = await Promise.all([
    readFile('benchmarks/schema/release-gate-source-observations.schema.json', 'utf8'),
    readFile('benchmarks/schema/release-gate-evidence.schema.json', 'utf8'),
  ]);
  deepStrictEqual(JSON.parse(SOURCE_OBSERVATIONS_SCHEMA_JSON), JSON.parse(sourceSchema));
  deepStrictEqual(JSON.parse(RELEASE_GATE_EVIDENCE_SCHEMA_JSON), JSON.parse(evidenceSchema));
});

function trustedSigner(
  keyId = 'candidate-authority-test',
  publicKey: KeyObject = authorityKeys.publicKey,
) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return {
    key_id: keyId,
    algorithm: 'ed25519' as const,
    public_key_spki_base64: der.toString('base64'),
    public_key_fingerprint: `sha256:${createHash('sha256').update(der).digest('hex')}`,
  };
}

const trustPolicy: ReleaseGateTrustPolicy = {
  schema_version: 'aiq.release-gate-trust.v1',
  release_identity: 'aiq-core/1.0.2',
  authority_signers: [trustedSigner()],
  promotion_signers: [trustedSigner('candidate-promotion-test', promotionKeys.publicKey)],
};
process.env[RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT] = releaseGateTrustPolicyDigest(trustPolicy);

function admission(): ReleaseGateAdmission {
  const catalog = buildCatalog();
  const configurations = FIXED_MODEL_MATRIX_IDENTITIES.map((identity, index) => ({
    ...identity,
    execution_model_id: MODEL_EXECUTION_ID_MAPPING[index]!.execution_model_id,
  }));
  const unsigned: ReleaseGateAdmission = {
    schema_version: 'aiq.release-gate-admission.v1',
    signature_domain: 'aiq.release-gate-admission.v1',
    signature_encoding: 'aiq.sorted-key-json.v1',
    release_identity: 'aiq-core/1.0.2',
    catalog_release_identity_digest: catalog.catalog_release_identity.digest,
    task_metadata_identity_digest: catalog.task_metadata_identity.digest,
    corpus_commitment_digest: digest('corpus-manifest'),
    plan_id: 'candidate-release-plan-test',
    execution_plan_digest: digest('execution-plan'),
    model_id_mapping_digest: releaseModelIdMappingDigest(),
    issued_at: '2026-08-01T00:00:00.000Z',
    collection_not_before: '2026-08-02T00:00:00.000Z',
    collection_not_after: '2026-08-03T00:00:00.000Z',
    repeat_schedule: ['repeat-1', 'repeat-2', 'repeat-3'].map((repeatId, index) => ({
      repeat_id: repeatId,
      scheduled_at: `2026-08-02T0${index + 1}:00:00.000Z`,
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
      raw_cell_count: 3672,
      contrast_pair_count: 153,
      contrast_observation_count: 306,
    },
    infrastructure_retry_policy: {
      max_attempts: 3,
      backoff_seconds: [0, 30, 90],
      retryable_classifications: ['pre_model_admission'],
      model_or_evaluator_failures_retryable: false,
    },
    model_matrix: {
      configurations,
      digest: releaseEvidenceModelMatrixDigest(configurations),
    },
    contrast_bindings: RELEASE_GATE_POLICY.predeclared_contrasts.map(
      ({ contrast_id: contrastId }, index) => ({
        contrast_id: contrastId,
        reference_variant_digest: digest(`reference-${index}`),
        challenge_variant_digest: digest(`challenge-${index}`),
      }),
    ),
    signer: { key_id: trustedSigner().key_id, algorithm: 'ed25519' },
    signature: '',
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      releaseAdmissionSigningBytes(unsigned),
      authorityKeys.privateKey,
    ).toString('base64'),
  };
}

interface Fixture {
  readonly input: CandidateFinalSourceAssemblerInput;
  readonly expectedSourceDigest: string;
}

function fixture(
  firstCoreStatus: 'completed' | 'failed' | 'unsupported' = 'completed',
  invalidFirstAttempt = false,
  invalidVerifierDisposition = false,
  privateAttemptField = false,
): Fixture {
  const signedAdmission = admission();
  const models = signedAdmission.model_matrix.configurations.map((configuration) => ({
    canonical_model_id: configuration.model_id,
    execution_model_id: configuration.execution_model_id,
    model_name: `gpt-5.6-${configuration.family}`,
    reasoning_effort: configuration.reasoning_effort,
  }));
  const catalog = buildCatalog();
  const runtime = {
    runner_executable_sha256: digest('runner-executable'),
    verifier_executable_sha256: digest('verifier-executable'),
    evaluator_runtime_sha256: digest('evaluator-runtime'),
    core_harness_sha256: digest('core-harness'),
    core_tool_policy_sha256: digest('core-tool-policy'),
    core_network_policy_sha256: digest('core-network-policy'),
    contrast_harness_sha256: digest('contrast-harness'),
    contrast_tool_policy_sha256: digest('contrast-tool-policy'),
    contrast_network_policy_sha256: digest('contrast-network-policy'),
  };
  const units: JsonObject[] = [];
  for (const [repeatIndex, repeat] of signedAdmission.repeat_schedule.entries()) {
    units.push({
      unit_id: `repeat-0${repeatIndex + 1}-core`,
      repeat_id: repeat.repeat_id,
      slot_id: repeat.scheduled_at,
      kind: 'core',
      contrast_id: null,
      contrast_arm: null,
      variant_sha256: null,
      ordered_task_ids: signedAdmission.observation_universe.task_ids,
      models,
      corpus_commitment_path: '/controlled/core.json',
      corpus_commitment_sha256: digest('core'),
    });
    for (const armBinding of repeat.contrast_arm_order) {
      const [contrastId, arm] = armBinding.split(':') as [string, 'reference' | 'challenge'];
      const binding = signedAdmission.contrast_bindings.find(
        ({ contrast_id: candidate }) => candidate === contrastId,
      )!;
      const contrastIndex = signedAdmission.contrast_bindings.indexOf(binding);
      units.push({
        unit_id: `repeat-0${repeatIndex + 1}-contrast-0${contrastIndex + 1}-${arm}`,
        repeat_id: repeat.repeat_id,
        slot_id: repeat.scheduled_at,
        kind: 'contrast',
        contrast_id: contrastId,
        contrast_arm: arm,
        variant_sha256:
          arm === 'reference' ? binding.reference_variant_digest : binding.challenge_variant_digest,
        ordered_task_ids: [`private-${contrastId}-${arm}`],
        models,
        corpus_commitment_path: '/controlled/contrast.json',
        corpus_commitment_sha256: digest('contrast'),
      });
    }
  }
  const plan: JsonObject = {
    schema_version: 'aiq.candidate-execution-plan.v1',
    release_identity: 'aiq-core/1.0.2',
    execution_plan_digest: signedAdmission.execution_plan_digest,
    signed_admission_path: '/controlled/admission.json',
    signed_admission_sha256: releaseAdmissionDigest(signedAdmission),
    corpus_manifest_path: '/controlled/corpus.json',
    corpus_manifest_sha256: signedAdmission.corpus_commitment_digest,
    core_corpus_commitment_path: '/controlled/core.json',
    core_corpus_commitment_sha256: digest('core'),
    contrast_corpus_commitment_path: '/controlled/contrast.json',
    contrast_corpus_commitment_sha256: digest('contrast'),
    authorization_path: '/controlled/authorization.json',
    runtime,
    controlled_inputs: {
      runner_signer_node_id: node(runnerKeys.publicKey).node_id,
      verifier_signer_node_id: node(verifierKeys.publicKey).node_id,
    },
    contrast_task_bindings: signedAdmission.contrast_bindings.map(
      ({ contrast_id: contrastId }) => ({
        contrast_id: contrastId,
        reference_task_id: `private-${contrastId}-reference`,
        challenge_task_id: `private-${contrastId}-challenge`,
      }),
    ),
    execution_units: units,
  };
  const authSigner = authorizationNode(authorizationKeys.publicKey);
  const authorizationUnsigned: JsonObject = {
    schema_version: 'aiq.candidate-execution-authorization.v1',
    signature_domain: 'aiq.candidate-execution-authorization.v1',
    signature_encoding: 'aiq.sorted-key-json.v1',
    purpose: 'authorize_private_candidate_execution',
    release_identity: 'aiq-core/1.0.2',
    execution_plan_digest: signedAdmission.execution_plan_digest,
    signed_admission_sha256: releaseAdmissionDigest(signedAdmission),
    private_plan_sha256: digest(plan),
    plan,
    signer: { ...authSigner, algorithm: 'ed25519' },
  };
  const authorization: JsonObject = {
    ...authorizationUnsigned,
    signature: signedHex({ ...authorizationUnsigned, signature: '' }, authorizationKeys.privateKey),
  };
  const artifacts: CandidateArtifactInput[] = [];
  const rawByKey = new Map<
    string,
    Omit<ReleaseGateRawCell, 'universe_slot' | 'cell_evidence_binding_digest'>
  >();
  const contrastByKey = new Map<
    string,
    { score: number; result: string; package: string; verifier: string }
  >();

  for (const unit of units) {
    const binding = {
      release_identity: 'aiq-core/1.0.2',
      execution_plan_digest: authorization.execution_plan_digest,
      private_plan_sha256: authorization.private_plan_sha256,
      signed_admission_sha256: authorization.signed_admission_sha256,
      repeat_id: unit.repeat_id,
      unit_id: unit.unit_id,
      slot_id: unit.slot_id,
      kind: unit.kind,
      contrast_id: unit.contrast_id,
      contrast_arm: unit.contrast_arm,
      variant_sha256: unit.variant_sha256,
      corpus_commitment_sha256: unit.corpus_commitment_sha256,
    };
    const taskIds = unit.ordered_task_ids as string[];
    const runResults: JsonObject[] = [];
    for (const model of models) {
      for (const taskId of taskIds) {
        const score =
          unit.kind === 'contrast' ? (unit.contrast_arm === 'reference' ? 0.6 : 0.5) : 0.5;
        const status =
          unit.kind === 'core' && runResults.length === 0 ? firstCoreStatus : 'completed';
        const result: JsonObject = {
          schema_version: 'aiq.result.v3',
          result_id: '',
          run_id: `run-${unit.unit_id}`,
          task_id: taskId,
          task_version: '1.0.2',
          model: {
            family: model.model_name.slice('gpt-5.6-'.length),
            reasoning_effort: model.reasoning_effort,
          },
          status,
          task_score: status === 'completed' ? score : null,
          evaluator_result_sha256:
            status === 'completed'
              ? digest(`persisted-${unit.unit_id}-${runResults.length}`)
              : null,
          response: 'private-output-never-projected',
          failure: status === 'failed' ? { kind: 'timeout' } : null,
        };
        const resultHash = digest(result);
        result.result_id = `result_${resultHash.slice(7)}`;
        runResults.push(result);
      }
    }
    const runPayload = {
      schema_version: 'aiq.candidate-unit-run.v1',
      unit: binding,
      run: {
        schema_version: 'aiq.calibration-run.v3',
        official_eligible: false,
        classification: 'local_calibration_non_official',
        scoring_version: '1.0.0',
        task_set_hash: digest(taskIds),
        capability_validation: { models: [] },
        provenance: {
          schema_version: 'aiq.run-provenance.v2',
          run_class: 'calibration',
          corpus_commitment_sha256: unit.corpus_commitment_sha256,
          catalog_digest:
            unit.kind === 'core'
              ? 'sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937'
              : 'sha256:fa0fbbd01a00874791b592a2661b91a44189ea53e691af1616c76d271b6c7a66',
          task_set_digest: digest(taskIds),
          preflight_digest: digest({ models: [] }),
          runner_executable_digest: runtime.runner_executable_sha256,
          runtime_digest: digest('runtime-composite'),
          harness_digest:
            unit.kind === 'core' ? runtime.core_harness_sha256 : runtime.contrast_harness_sha256,
          tool_policy_digest:
            unit.kind === 'core'
              ? runtime.core_tool_policy_sha256
              : runtime.contrast_tool_policy_sha256,
          network_policy_digest:
            unit.kind === 'core'
              ? runtime.core_network_policy_sha256
              : runtime.contrast_network_policy_sha256,
        },
        task_ids: taskIds,
        models: models.map(({ model_name: modelName, reasoning_effort: reasoningEffort }) => ({
          family: modelName.slice('gpt-5.6-'.length),
          reasoning_effort: reasoningEffort,
        })),
        results: runResults,
      },
    };
    const unitRun = envelope(
      'aiq.candidate-unit-run.v1',
      `${unit.unit_id}.unit-run`,
      runPayload,
      runnerKeys.privateKey,
      runnerKeys.publicKey,
    );
    const resultCells: JsonObject[] = [];
    const evaluatorCells: JsonObject[] = [];
    const verifierCells: JsonObject[] = [];
    const attemptCells: JsonObject[] = [];
    for (const [index, result] of runResults.entries()) {
      const modelIndex = Math.floor(index / taskIds.length);
      const model = models[modelIndex]!;
      const cell = {
        repeat_id: unit.repeat_id,
        unit_id: unit.unit_id,
        result_index: index,
        task_id: result.task_id,
        task_version: '1.0.2',
        model_id: model.canonical_model_id,
        execution_model_id: model.execution_model_id,
      };
      const resultHash = digest({ ...result, result_id: '' });
      const resultEnvelope = envelope(
        'aiq.candidate-cell-result.v1',
        `${unit.unit_id}.cell-result.${index}`,
        {
          schema_version: 'aiq.candidate-cell-result.v1',
          unit: binding,
          cell,
          unit_run_envelope_sha256: digest(unitRun),
          result_sha256: resultHash,
          result_id: result.result_id,
        },
        runnerKeys.privateKey,
        runnerKeys.publicKey,
      );
      const completed = result.status === 'completed';
      const evaluator = completed
        ? {
            schema_version: 'aiq.candidate-evaluator-result.v1',
            task_id: result.task_id,
            task_version: '1.0.2',
            scorer_version: '1.0.2',
            components: [
              ['component_01', 3000],
              ['component_02', 2500],
              ['component_03', 2500],
              ['component_04', 2000],
            ].map(([componentId, weight]) => ({
              component_id: componentId,
              weight_basis_points: weight,
              assertions: Array.from({ length: 10 }, (_, assertionIndex) => ({
                assertion_id: `private_criterion_${componentId}_${String(
                  assertionIndex + 1,
                ).padStart(3, '0')}`,
                passed: assertionIndex < (result.task_score as number) * 10,
                evidence_sha256: digest(`${result.task_id}-${componentId}-${assertionIndex}`),
              })),
            })),
            score_numerator: result.task_score === 0.6 ? 3 : 1,
            score_denominator: result.task_score === 0.6 ? 5 : 2,
            score_decimal_6: String(
              result.task_score === 0.6
                ? '0.600000'
                : result.task_score === 0.5
                  ? '0.500000'
                  : result.task_score,
            ),
          }
        : null;
      const evaluatorEnvelope = envelope(
        'aiq.candidate-cell-evaluator.v1',
        `${unit.unit_id}.cell-evaluator.${index}`,
        {
          schema_version: 'aiq.candidate-cell-evaluator.v1',
          unit: binding,
          cell,
          result_package_sha256: digest(resultEnvelope),
          persisted_evaluator_sha256: result.evaluator_result_sha256,
          evaluator,
        },
        runnerKeys.privateKey,
        runnerKeys.publicKey,
      );
      const verifierEnvelope = envelope(
        'aiq.candidate-cell-verification.v1',
        `${unit.unit_id}.cell-verifier.${index}`,
        {
          schema_version: 'aiq.candidate-cell-verification.v1',
          unit: binding,
          cell,
          result_package_sha256: digest(resultEnvelope),
          evaluator_package_sha256: digest(evaluatorEnvelope),
          replayed_evaluator_sha256: completed ? digest(evaluator) : null,
          verified: completed,
          disposition:
            invalidVerifierDisposition && unit.kind === 'core' && index === 0
              ? 'ambiguous_replay'
              : completed
                ? 'candidate_evaluator_replayed'
                : 'candidate_result_noncompleted_not_verified',
        },
        verifierKeys.privateKey,
        verifierKeys.publicKey,
      );
      const attempt = {
        attempt_number: invalidFirstAttempt && unit.kind === 'core' && index === 0 ? 2 : 1,
        scheduled_delay_seconds: 0,
        scheduled_for: unit.slot_id,
        started_at: new Date(Date.parse(unit.slot_id as string) + 5_000).toISOString(),
        model_started: result.status !== 'unsupported',
        disposition:
          result.status === 'failed'
            ? 'model_failure'
            : result.status === 'unsupported'
              ? 'unsupported'
              : 'completed',
        infrastructure_classification: null,
        result_digest: completed ? resultHash : null,
        result_package_digest: completed ? digest(resultEnvelope) : null,
        verifier_attestation_digest: completed ? digest(verifierEnvelope) : null,
        ...(privateAttemptField && unit.kind === 'core' && index === 0
          ? { private_response: 'must-never-be-public' }
          : {}),
      };
      const attemptEnvelope = envelope(
        'aiq.candidate-cell-attempt-log.v1',
        `${unit.unit_id}.cell-attempt.${index}`,
        {
          schema_version: 'aiq.candidate-cell-attempt-log.v1',
          unit: binding,
          cell,
          result_package_sha256: digest(resultEnvelope),
          evaluator_package_sha256: digest(evaluatorEnvelope),
          verifier_attestation_sha256: digest(verifierEnvelope),
          attempts: [attempt],
        },
        runnerKeys.privateKey,
        runnerKeys.publicKey,
      );
      resultCells.push(resultEnvelope);
      evaluatorCells.push(evaluatorEnvelope);
      verifierCells.push(verifierEnvelope);
      attemptCells.push(attemptEnvelope);
      if (unit.kind === 'core') {
        const publicStatus =
          result.status === 'failed'
            ? 'model_failure'
            : result.status === 'unsupported'
              ? 'unsupported'
              : 'completed';
        rawByKey.set(`${unit.repeat_id}\0${result.task_id}\0${model.canonical_model_id}`, {
          repeat_id: unit.repeat_id as string,
          task_id: result.task_id as string,
          domain: catalog.tasks.find(({ task_id: candidate }) => candidate === result.task_id)!
            .domain,
          model_id: model.canonical_model_id,
          status: publicStatus,
          reported_score: completed ? (result.task_score as number) : null,
          components:
            evaluator?.components.map((component) => ({
              component_id: component.component_id as 'component_01',
              weight_basis_points: component.weight_basis_points as 3000,
              passed_assertions: component.assertions.filter(({ passed }) => passed).length,
              total_assertions: component.assertions.length,
              assertions: component.assertions.map((assertion, assertionIndex) => ({
                assertion_id: `assertion_${String(assertionIndex + 1).padStart(3, '0')}`,
                passed: assertion.passed,
                evidence_digest: assertion.evidence_sha256,
              })),
            })) ?? null,
          evaluator_digest: completed ? digest(evaluator) : null,
          result_digest: completed ? resultHash : null,
          result_package_digest: completed ? digest(resultEnvelope) : null,
          verification_digest: completed ? digest(verifierEnvelope) : null,
          verification_status: completed ? 'verified' : 'failed',
          attempts: [attempt] as ReleaseGateRawCell['attempts'],
        });
      } else {
        contrastByKey.set(
          `${unit.contrast_id}\0${unit.repeat_id}\0${model.canonical_model_id}\0${unit.contrast_arm}`,
          {
            score: result.task_score as number,
            result: resultHash,
            package: digest(resultEnvelope),
            verifier: digest(verifierEnvelope),
          },
        );
      }
    }
    const resultBundle = {
      schema_version: 'aiq.candidate-result-package-bundle.v1',
      unit: binding,
      unit_run: unitRun,
      cells: resultCells,
    };
    const evaluatorBundle = {
      schema_version: 'aiq.candidate-evaluator-result-bundle.v1',
      unit: binding,
      result_bundle_sha256: digest(resultBundle),
      cells: evaluatorCells,
    };
    const verifierBundle = {
      schema_version: 'aiq.candidate-verifier-replay-bundle.v1',
      unit: binding,
      result_bundle_sha256: digest(resultBundle),
      evaluator_bundle_sha256: digest(evaluatorBundle),
      cells: verifierCells,
    };
    const attemptBundle = {
      schema_version: 'aiq.candidate-attempt-log.v1',
      unit: binding,
      result_bundle_sha256: digest(resultBundle),
      evaluator_bundle_sha256: digest(evaluatorBundle),
      verifier_bundle_sha256: digest(verifierBundle),
      cells: attemptCells,
    };
    for (const [artifact_class, artifact] of [
      ['result_package_bundle', resultBundle],
      ['evaluator_result_bundle', evaluatorBundle],
      ['verifier_replay_bundle', verifierBundle],
      ['attempt_log_bundle', attemptBundle],
    ] as const)
      artifacts.push({ unit_id: unit.unit_id as string, artifact_class, artifact });
  }
  const rawCells = signedAdmission.repeat_schedule
    .flatMap(({ repeat_id: repeatId }) =>
      signedAdmission.observation_universe.task_ids.flatMap((taskId) =>
        signedAdmission.observation_universe.model_ids.map((modelId) =>
          rawByKey.get(`${repeatId}\0${taskId}\0${modelId}`)!,
        ),
      ),
    )
    .map((cell, index) => {
      const unsigned = { universe_slot: index + 1, ...cell };
      return {
        ...unsigned,
        cell_evidence_binding_digest:
          cell.status === 'completed' ? releaseCellEvidenceBindingDigest(unsigned) : null,
      };
    });
  const pairedContrasts = signedAdmission.contrast_bindings.map((binding) => ({
    ...binding,
    pairs: signedAdmission.repeat_schedule.flatMap(({ repeat_id: repeatId }) =>
      signedAdmission.observation_universe.model_ids.map((modelId) => {
        const reference = contrastByKey.get(
          `${binding.contrast_id}\0${repeatId}\0${modelId}\0reference`,
        )!;
        const challenge = contrastByKey.get(
          `${binding.contrast_id}\0${repeatId}\0${modelId}\0challenge`,
        )!;
        return {
          repeat_id: repeatId,
          model_id: modelId,
          reference_score: reference.score,
          challenge_score: challenge.score,
          reference_result_digest: reference.result,
          reference_result_package_digest: reference.package,
          reference_verifier_attestation_digest: reference.verifier,
          challenge_result_digest: challenge.result,
          challenge_result_package_digest: challenge.package,
          challenge_verifier_attestation_digest: challenge.verifier,
        };
      }),
    ),
  }));
  const sourceDigest = releaseEvidenceSourceDigest(rawCells, pairedContrasts);
  const authorityUnsigned: ReleaseGateAuthority = {
    schema_version: 'aiq.release-gate-authority.v1',
    signature_domain: 'aiq.release-gate-authority.v1',
    signature_encoding: 'aiq.sorted-key-json.v1',
    release_identity: 'aiq-core/1.0.2',
    catalog_release_identity_digest: signedAdmission.catalog_release_identity_digest,
    task_metadata_identity_digest: signedAdmission.task_metadata_identity_digest,
    admission_digest: releaseAdmissionDigest(signedAdmission),
    execution_plan_digest: signedAdmission.execution_plan_digest,
    model_id_mapping_digest: signedAdmission.model_id_mapping_digest,
    admission: signedAdmission,
    source_observations_digest: sourceDigest,
    signer: { key_id: trustedSigner().key_id, algorithm: 'ed25519' },
    signature: '',
  };
  const authority = {
    ...authorityUnsigned,
    signature: sign(
      null,
      releaseAuthoritySigningBytes(authorityUnsigned),
      authorityKeys.privateKey,
    ).toString('base64'),
  };
  const expectations = {
    authorization_path: plan.authorization_path,
    authorization_sha256: digest(authorization),
    authorization_signer_node_id: authSigner.node_id,
    authorization_signer_public_key: authSigner.public_key,
    signed_admission_path: plan.signed_admission_path,
    signed_admission_sha256: authority.admission_digest,
    signed_admission_key_id: authority.admission.signer.key_id,
    execution_plan_sha256: authority.execution_plan_digest,
    corpus_manifest_path: plan.corpus_manifest_path,
    corpus_manifest_sha256: plan.corpus_manifest_sha256,
    core_corpus_commitment_path: plan.core_corpus_commitment_path,
    core_corpus_commitment_sha256: plan.core_corpus_commitment_sha256,
    contrast_corpus_commitment_path: plan.contrast_corpus_commitment_path,
    contrast_corpus_commitment_sha256: plan.contrast_corpus_commitment_sha256,
    observed_at: '2026-08-02T04:00:00.000Z',
  };
  return {
    input: {
      operation: 'finalize',
      admission: signedAdmission,
      authority,
      runtime_pinned_trust_policy: trustPolicy,
      expectations,
      authorization,
      artifacts,
      collected_at: '2026-08-02T04:00:00.000Z',
    },
    expectedSourceDigest: sourceDigest,
  };
}

const sourceFixture = fixture();

test('matches the Rust candidate authorization identity derived from secret byte 9', () => {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, 9),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  deepStrictEqual(authorizationNode(createPublicKey(privateKey)), {
    node_id: 'candidate_node_dbc298251c51321b7266e78d1c151c2b62aff8cb95b293096d3463018544face',
    public_key: 'fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618',
  });
});

test('rejects empty or role-duplicated runtime-pinned trust policies', async () => {
  const policies: ReleaseGateTrustPolicy[] = [
    { ...trustPolicy, authority_signers: [] },
    { ...trustPolicy, promotion_signers: [] },
    { ...trustPolicy, promotion_signers: [trustPolicy.authority_signers[0]!] },
  ];
  for (const policy of policies) {
    process.env[RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT] = releaseGateTrustPolicyDigest(policy);
    await rejects(
      assembleCandidateSource({ ...sourceFixture.input, runtime_pinned_trust_policy: policy }),
      /authority|policy/i,
    );
  }
  process.env[RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT] = releaseGateTrustPolicyDigest(trustPolicy);
});

test('assembles exactly 3,978 deterministic observations in release order', async () => {
  const first = await assembleCandidateSource(sourceFixture.input);
  const second = await assembleCandidateSource(sourceFixture.input);
  const sourceSchema = JSON.parse(
    await readFile('benchmarks/schema/release-gate-source-observations.schema.json', 'utf8'),
  ) as JsonObject;
  strictEqual(JSON.stringify(sourceSchema).includes('universe_slot'), false);
  strictEqual(JSON.stringify(sourceSchema).includes('cell_evidence_binding_digest'), false);
  strictEqual(
    matchesSchema(first.source_observations as unknown as JsonObject, sourceSchema, sourceSchema),
    true,
  );
  strictEqual(
    JSON.stringify(first.source_observations).includes('private-output-never-projected'),
    false,
  );
  strictEqual(
    JSON.stringify(first.release_gate_evidence).includes('private-output-never-projected'),
    false,
  );
  for (const output of [first.source_observations, first.release_gate_evidence]) {
    const serialized = JSON.stringify(output);
    strictEqual(serialized.includes('private_criterion_'), false);
    strictEqual(serialized.includes('private_criterion_component_01_001'), false);
  }
  for (const field of ['components', 'attempts'] as const) {
    const changed = clone(first.source_observations) as unknown as JsonObject;
    const cells = changed.raw_cells as JsonObject[];
    const cell = cells[0]!;
    const entries = cell[field] as JsonObject[];
    entries[0]!.private_response = 'must-not-validate';
    strictEqual(matchesSchema(changed, sourceSchema, sourceSchema), false);
  }
  strictEqual(first.release_gate_evidence.raw_cells.length, 3672);
  strictEqual(
    first.release_gate_evidence.paired_contrasts.flatMap(({ pairs }) => pairs).length,
    153,
  );
  strictEqual(
    first.release_gate_evidence.source_observations_digest,
    sourceFixture.expectedSourceDigest,
  );
  deepStrictEqual(first, second);
  strictEqual(first.release_gate_evidence.raw_cells[0]!.universe_slot, 1);
  strictEqual(first.release_gate_evidence.raw_cells.at(-1)!.universe_slot, 3672);
  const firstCell = first.release_gate_evidence.raw_cells[0]!;
  const secondCell = first.release_gate_evidence.raw_cells[1]!;
  for (const component of firstCell.components ?? []) {
    deepStrictEqual(
      component.assertions.map(({ assertion_id: assertionId }) => assertionId),
      Array.from(
        { length: component.assertions.length },
        (_, index) => `assertion_${String(index + 1).padStart(3, '0')}`,
      ),
    );
  }
  strictEqual(firstCell.evaluator_digest, secondCell.evaluator_digest);
  strictEqual(firstCell.result_package_digest === secondCell.result_package_digest, false);
  strictEqual(firstCell.verification_digest === secondCell.verification_digest, false);
  strictEqual(
    firstCell.cell_evidence_binding_digest === secondCell.cell_evidence_binding_digest,
    false,
  );
});

test('fixed assembler validates the public projection from an isolated runtime directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aiq-fixed-candidate-assembler-'));
  try {
    for (const name of [
      'candidate-source-assembler.ts',
      'candidate-release.ts',
      'generate-benchmark-catalog.ts',
    ]) {
      await copyFile(new URL(name, import.meta.url), join(directory, name));
    }
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', join(directory, 'candidate-source-assembler.ts')],
      {
        cwd: directory,
        env: {
          [RELEASE_TRUST_POLICY_DIGEST_ENVIRONMENT]: releaseGateTrustPolicyDigest(trustPolicy),
        },
        input: `${canonicalJson(sourceFixture.input)}\n`,
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
      },
    );
    strictEqual(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as JsonObject;
    strictEqual(
      (output.source_observations as JsonObject).schema_version,
      'aiq.release-gate-source-observations.v1',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('derive_source rejects a signed private attempt field without public output', async () => {
  const signedPrivateAttempt = fixture('completed', false, false, true).input;
  const input: CandidateSourceAssemblerInput = {
    ...signedPrivateAttempt,
    operation: 'derive_source',
    authority: null,
    runtime_pinned_trust_policy: null,
  };
  await rejects(
    assembleCandidateSource(input),
    /attempt history entry contains unsupported fields/i,
  );

  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./candidate-source-assembler.ts', import.meta.url))],
    {
      input: `${canonicalJson(input)}\n`,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  strictEqual(result.status, 1);
  strictEqual(result.stdout, '');
  strictEqual(result.stderr, 'Candidate source assembly failed.\n');

  const validDerivation: CandidateSourceAssemblerInput = {
    ...sourceFixture.input,
    operation: 'derive_source',
    authority: null,
    runtime_pinned_trust_policy: null,
    collected_at: 'not-a-canonical-timestamp',
  };
  await rejects(assembleCandidateSource(validDerivation), /do not match their public schema/i);
});

test('rejects missing, duplicate, extra, and misordered artifacts', async () => {
  const variants = [
    sourceFixture.input.artifacts.slice(1),
    [...sourceFixture.input.artifacts, sourceFixture.input.artifacts[0]!],
    [sourceFixture.input.artifacts[0]!, ...sourceFixture.input.artifacts],
    [
      sourceFixture.input.artifacts[1]!,
      sourceFixture.input.artifacts[0]!,
      ...sourceFixture.input.artifacts.slice(2),
    ],
  ];
  for (const artifacts of variants)
    await rejects(assembleCandidateSource({ ...sourceFixture.input, artifacts }));
});

test('rejects swapped unit, model, task, repeat, and invalid signatures or digests', async () => {
  const mutations: CandidateSourceAssemblerInput[] = [];
  for (const field of ['unit_id', 'repeat_id'] as const) {
    const changed = clone(sourceFixture.input);
    (changed.artifacts[0]!.artifact.unit as JsonObject)[field] = 'swapped';
    mutations.push(changed);
  }
  const changedTask = clone(sourceFixture.input);
  const taskPayload = (
    ((changedTask.artifacts[0]!.artifact.unit_run as JsonObject).payload as JsonObject)
      .run as JsonObject
  ).results as JsonObject[];
  taskPayload[0]!.task_id = 'swapped-task';
  mutations.push(changedTask);
  const changedModel = clone(sourceFixture.input);
  const modelPayload = (
    ((changedModel.artifacts[0]!.artifact.unit_run as JsonObject).payload as JsonObject)
      .run as JsonObject
  ).results as JsonObject[];
  (modelPayload[0]!.model as JsonObject).reasoning_effort = 'ultra';
  mutations.push(changedModel);
  const badSignature = clone(sourceFixture.input);
  ((badSignature.artifacts[0]!.artifact.unit_run as JsonObject).signature as string) = '00'.repeat(
    64,
  );
  mutations.push(badSignature);
  const badDigest = clone(sourceFixture.input);
  (badDigest.artifacts[1]!.artifact.result_bundle_sha256 as string) = digest('wrong');
  mutations.push(badDigest);
  for (const input of mutations) await rejects(assembleCandidateSource(input));
});

test('rejects invalid attempt lifecycle and maps signed failed or unsupported results', async () => {
  await rejects(assembleCandidateSource(fixture('completed', true).input), /attempt lifecycle/i);
  await rejects(
    assembleCandidateSource(fixture('completed', false, true).input),
    /verification disposition/i,
  );

  const failed = await assembleCandidateSource(fixture('failed').input);
  strictEqual(failed.release_gate_evidence.raw_cells[0]!.status, 'model_failure');
  strictEqual(failed.release_gate_evidence.raw_cells[0]!.verification_status, 'failed');
  const unsupported = await assembleCandidateSource(fixture('unsupported').input);
  strictEqual(unsupported.release_gate_evidence.raw_cells[0]!.status, 'unsupported');
  strictEqual(unsupported.release_gate_evidence.raw_cells[0]!.reported_score, null);
});

test('preserves contrast direction and rejects an arm swap', async () => {
  const assembled = await assembleCandidateSource(sourceFixture.input);
  const pair = assembled.release_gate_evidence.paired_contrasts[0]!.pairs[0]!;
  strictEqual(pair.reference_score, 0.6);
  strictEqual(pair.challenge_score, 0.5);
  const swapped = clone(sourceFixture.input);
  const contrastIndex = swapped.artifacts.findIndex(({ unit_id: unitId }) =>
    unitId.includes('reference'),
  );
  (swapped.artifacts[contrastIndex]!.artifact.unit as JsonObject).contrast_arm = 'challenge';
  await rejects(assembleCandidateSource(swapped));
});
