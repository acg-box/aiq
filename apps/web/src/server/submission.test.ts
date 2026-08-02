import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests intentionally mutate parsed adversarial JSON values. */

import {
  createEnqueueRpcArguments,
  mapEnqueueResult,
  MAX_JSON_DEPTH,
  MAX_MODELS,
  MAX_RAW_SUBMISSION_BYTES,
  MAX_RESULTS,
  MAX_SIGNED_PACKAGE_BYTES,
  RESULT_PACKAGE_SCHEMA,
  RUN_PAYLOAD_TYPE,
  canonicalJson,
  sha256Hex,
  validateSubmission,
  type SubmissionReceipt,
  type SubmissionObjectIdentity,
  type ValidatedSubmission,
} from './submission-contract.ts';
import { handleSubmission, hasValidBearerToken } from './submission-handler.ts';

const token = 'runner-submission-token';
const acceptedInboxId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const duplicateInboxId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const conflictInboxId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const modelMatrix = [
  ['sol', 'low'],
  ['sol', 'medium'],
  ['sol', 'high'],
  ['sol', 'xhigh'],
  ['sol', 'max'],
  ['sol', 'ultra'],
  ['terra', 'low'],
  ['terra', 'medium'],
  ['terra', 'high'],
  ['terra', 'xhigh'],
  ['terra', 'max'],
  ['terra', 'ultra'],
  ['luna', 'low'],
  ['luna', 'medium'],
  ['luna', 'high'],
  ['luna', 'xhigh'],
  ['luna', 'max'],
] as const;
const signingPair = generateKeyPairSync('ed25519');
const publicDer = signingPair.publicKey.export({ format: 'der', type: 'spki' });
const publicKey = publicDer.subarray(publicDer.length - 32).toString('hex');
const runnerNodeId = `node_${sha256Hex(Buffer.from(publicKey, 'hex'))}`;
const scheduleSlot = {
  local_date: '2026-07-27',
  occurrence: 'day',
  local_time: '12:00',
  timezone: 'UTC',
};
const models = modelMatrix.map(([family, reasoning_effort]) => ({ family, reasoning_effort }));
const taskHashes = Array.from({ length: 72 }, (_, index) => `sha256:${sha256Hex(`task-${index}`)}`);
const taskSetHash = `sha256:${sha256Hex(canonicalJson(taskHashes.toSorted()))}`;
const fixtureRunId = `run_${sha256Hex(
  canonicalJson({
    schema_version: 'aiq.run-identity.v1',
    slot: scheduleSlot,
    task_set_hash: taskSetHash,
    models: [...models],
    scoring_version: '1.0.0',
  }),
)}`;

function syntheticResults(): Record<string, unknown>[] {
  return Array.from({ length: 72 }, (_, taskIndex) =>
    models.map((model) => {
      const result: Record<string, unknown> = {
        schema_version: 'aiq.result.v2',
        result_id: '',
        run_id: fixtureRunId,
        task_id: `task-${taskIndex}`,
        task_version: '1',
        task_hash: taskHashes[taskIndex],
        model,
        status: 'failed',
        evaluation: 'not_evaluated',
        task_score: null,
        response: null,
        response_sha256: null,
        evaluator_result_sha256: null,
        evaluator_stdout_sha256: null,
        artifacts: [],
        failure: {
          kind: 'workspace_unavailable',
          message: 'synthetic workspace unavailable',
          exit_code: null,
          retryable: false,
        },
        latency: { wall_ms: 0 },
        tool_usage: { steps: 0, total_calls: 0, by_tool: {} },
        workspace_manifest: null,
        provenance: {
          node_id: runnerNodeId,
          runner_version: '0.1.0',
          codex_version: 'synthetic',
          observed_at: 'synthetic',
          synthetic: true,
          local_trust: 'untrusted',
        },
      };
      result.result_id = `result_${sha256Hex(canonicalJson(result))}`;
      return result;
    }),
  ).flat();
}

function artifact(kind: string, seed: string, bytes = 1): Record<string, unknown> {
  const hash = sha256Hex(seed);
  return {
    kind,
    content_hash: `sha256:${hash}`,
    uri: `aiq-artifact://sha256/${hash}/${kind}`,
    bytes,
  };
}

function capabilityValidation(): Record<string, unknown> {
  const codexVersion = 'codex-1';
  const entries = models.map((model, index) => {
    const preview = `probe-${index}`;
    const resultDigest = `sha256:${sha256Hex(preview)}`;
    const probe: Record<string, unknown> = {
      status: 'available',
      codex_version: codexVersion,
      observed_at: `unix-ms:${index + 1}`,
      result_digest: resultDigest,
      result_preview: preview,
      artifacts: [],
      evidence_digest: '',
      failure: null,
    };
    probe.evidence_digest = `sha256:${sha256Hex(
      canonicalJson([
        model,
        probe.codex_version,
        probe.observed_at,
        probe.status,
        probe.result_digest,
        probe.result_preview,
        probe.artifacts,
        probe.failure,
      ]),
    )}`;
    return {
      model,
      status: 'available',
      reason: 'available',
      probe,
    };
  });
  return {
    schema_version: 'aiq.capability-validation.v2',
    node_id: runnerNodeId,
    manifest_issues: [],
    cli_probe: {
      status: 'available',
      version: codexVersion,
      failure: null,
    },
    authentication_probe: {
      status: 'available',
      mode: 'chatgpt_subscription',
      failure: null,
    },
    models: entries,
  };
}

function productionProvenance(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema_version: 'aiq.run-provenance.v2',
    run_class: 'official',
    corpus_release_id: 'corpus_2026.07.25',
    corpus_commitment_sha256: digest('1'),
    catalog_digest: 'sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3',
    task_set_digest: digest('3'),
    evaluator_digest: digest('4'),
    runtime_digest: digest('5'),
    preflight_digest: digest('6'),
    harness_digest: digest('7'),
    prompt_digest: digest('8'),
    tool_policy_digest: digest('9'),
    network_policy_digest: digest('a'),
    environment_digest: digest('b'),
    source_manifest_digest: digest('c'),
    runner_executable_digest: digest('d'),
    codex_executable_digest: digest('e'),
    permission_evidence_digest: digest('f'),
    ...overrides,
  };
}

function officialPackage(): Record<string, unknown> {
  const capability = capabilityValidation();
  const provenance = productionProvenance({
    task_set_digest: taskSetHash,
    preflight_digest: `sha256:${sha256Hex(canonicalJson(capability))}`,
  });
  const runId = `run_${sha256Hex(
    canonicalJson({
      schema_version: 'aiq.run-identity.v3',
      run_class: 'official',
      slot: scheduleSlot,
      task_set_hash: taskSetHash,
      corpus_commitment_sha256: provenance.corpus_commitment_sha256,
      models,
      scoring_version: '1.0.0',
    }),
  )}`;
  const results = Array.from({ length: 72 }, (_, taskIndex) =>
    models.map((model, modelIndex) => {
      const response = 'official result';
      const result: Record<string, unknown> = {
        schema_version: 'aiq.result.v2',
        result_id: '',
        run_id: runId,
        task_id: `task-${taskIndex}`,
        task_version: '1',
        task_hash: taskHashes[taskIndex],
        model,
        status: 'completed',
        evaluation: 'correct',
        task_score: 1,
        response,
        response_sha256: `sha256:${sha256Hex(response)}`,
        evaluator_result_sha256: `sha256:${sha256Hex(`evaluation-${taskIndex}-${modelIndex}`)}`,
        evaluator_stdout_sha256: `sha256:${sha256Hex(
          `evaluator-stdout-${taskIndex}-${modelIndex}`,
        )}`,
        artifacts: [artifact('workspace-snapshot.json', `snapshot-${taskIndex}-${modelIndex}`)],
        failure: null,
        latency: { wall_ms: 1 },
        tool_usage: { steps: 0, total_calls: 0, by_tool: {} },
        workspace_manifest: artifact(
          'workspace-manifest.json',
          `manifest-${taskIndex}-${modelIndex}`,
        ),
        provenance: {
          node_id: runnerNodeId,
          runner_version: '0.1.0',
          codex_version: 'codex-1',
          observed_at: `unix-ms:${taskIndex * models.length + modelIndex + 1}`,
          synthetic: false,
          local_trust: 'untrusted',
        },
      };
      result.result_id = `result_${sha256Hex(canonicalJson(result))}`;
      return result;
    }),
  ).flat();
  return signedPackage({
    synthetic: false,
    provenance,
    payloadOverrides: {
      run_id: runId,
      capability_validation: capability,
      results,
    },
  });
}

function signedPackage(
  options: Readonly<{
    schemaVersion?: string;
    payloadType?: string;
    payloadSchema?: string;
    synthetic?: boolean;
    provenance?: unknown;
    payloadOverrides?: Readonly<Record<string, unknown>>;
  }> = {},
): Record<string, unknown> {
  const synthetic = options.synthetic ?? true;
  const defaultProvenance = productionProvenance();
  const payload: Record<string, unknown> = {
    schema_version: options.payloadSchema ?? RUN_PAYLOAD_TYPE,
    run_id: fixtureRunId,
    schedule_slot: {
      ...scheduleSlot,
    },
    task_set_hash: taskSetHash,
    scoring_version: '1.0.0',
    started_unix_ms: 1,
    finished_unix_ms: 2,
    synthetic,
    capability_validation: null,
    provenance:
      options.provenance === undefined
        ? synthetic
          ? null
          : defaultProvenance
        : options.provenance,
    evaluator_results_artifact: {
      kind: 'evaluator-results.json',
      content_hash: digest('e'),
      uri: `aiq-artifact://sha256/${'e'.repeat(64)}/evaluator-results.json`,
      bytes: 1,
    },
    models: [...models],
    results: syntheticResults(),
    ...options.payloadOverrides,
  };
  const runId = payload.run_id as string;
  const envelope: Record<string, unknown> = {
    schema_version: options.schemaVersion ?? RESULT_PACKAGE_SCHEMA,
    idempotency_key: runId,
    payload_type: options.payloadType ?? RUN_PAYLOAD_TYPE,
    content_hash: `sha256:${sha256Hex(canonicalJson(payload))}`,
    signer: {
      node_id: runnerNodeId,
      public_key: publicKey,
    },
    claimed_trust: 'untrusted',
    payload,
    signature: '',
  };
  const unsigned = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== 'signature'),
  );
  envelope.signature = sign(
    null,
    Buffer.from(canonicalJson(unsigned), 'utf8'),
    signingPair.privateKey,
  ).toString('hex');
  return envelope;
}

const fixture = signedPackage();
const fixtureBytes = Buffer.from(canonicalJson(fixture), 'utf8');

function cloneFixture(): Record<string, unknown> {
  return structuredClone(fixture);
}

function resignPackage(envelope: Record<string, unknown>): Record<string, unknown> {
  const payload = envelope.payload as Record<string, unknown>;
  envelope.content_hash = `sha256:${sha256Hex(canonicalJson(payload))}`;
  const unsigned = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== 'signature'),
  );
  envelope.signature = sign(
    null,
    Buffer.from(canonicalJson(unsigned), 'utf8'),
    signingPair.privateKey,
  ).toString('hex');
  return envelope;
}

function request(
  body: BodyInit = fixtureBytes.toString('utf8'),
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request('http://localhost/api/submissions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': fixtureRunId,
      ...headers,
    },
    body,
  });
}

function requestWithRawHeader(name: string, value: string): Request {
  const base = request();
  return {
    body: base.body,
    headers: {
      get(headerName: string) {
        return headerName.toLowerCase() === name ? value : base.headers.get(headerName);
      },
    },
  } as Request;
}

function dependencies(
  enqueue: (
    submission: ValidatedSubmission,
    receipt: SubmissionReceipt,
  ) => Promise<unknown> = async () => [
    {
      disposition: 'accepted',
      inbox_id: acceptedInboxId,
      object_recorded: true,
    },
  ],
) {
  return {
    configured: true,
    expectedToken: token,
    storePackage: async (
      _rawBytes: Uint8Array,
      receipt: SubmissionReceipt,
    ): Promise<SubmissionObjectIdentity> => ({
      bucket: 'private-packages',
      key: `sha256/${receipt.packageSha256}`,
      contentSha256: receipt.packageSha256,
      bytes: receipt.bodyBytes,
    }),
    registerStoredObject: async () => {},
    enqueue,
  };
}

function nestedObject(depth: number): Readonly<Record<string, unknown>> {
  let value: Readonly<Record<string, unknown>> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

function firstResult(candidate: Record<string, unknown>): Record<string, unknown> {
  const results = (candidate.payload as Record<string, unknown>).results as Record<
    string,
    unknown
  >[];
  const result = results[0];
  assert.ok(result);
  return result;
}

function rehashResult(result: Record<string, unknown>): void {
  result.result_id = '';
  result.result_id = `result_${sha256Hex(canonicalJson(result))}`;
}

void describe('shared result-package contract', () => {
  void it('accepts a complete signed v3 synthetic RunRecord', () => {
    const validation = validateSubmission(fixture);
    assert.equal(validation.ok, true);
    if (!validation.ok) {
      return;
    }
    assert.equal(validation.submission.schemaVersion, RESULT_PACKAGE_SCHEMA);
    assert.equal(validation.submission.idempotencyKey, fixtureRunId);
  });

  void it('accepts a complete non-synthetic Official 17-by-72 package', () => {
    const official = officialPackage();
    const validation = validateSubmission(official);
    assert.equal(validation.ok, true);
    if (!validation.ok) {
      return;
    }
    assert.equal(validation.submission.envelope.payload.synthetic, false);
    assert.equal(validation.submission.envelope.payload.models.length, 17);
    assert.equal(validation.submission.envelope.payload.results.length, 1_224);
    assert.equal(validation.submission.envelope.payload.provenance?.run_class, 'official');
  });

  void it('rejects one-field mutations of each signed contract layer', () => {
    const mutations: ReadonlyArray<
      readonly [string, (candidate: Record<string, unknown>) => void]
    > = [
      [
        'envelope schema',
        (candidate) => void (candidate.schema_version = 'aiq.result-package.unsupported'),
      ],
      ['payload type', (candidate) => void (candidate.payload_type = 'aiq.run.v2')],
      ['trust claim', (candidate) => void (candidate.claimed_trust = 'official')],
      [
        'signer public key',
        (candidate) =>
          void ((candidate.signer as Record<string, unknown>).public_key = '0'.repeat(64)),
      ],
      [
        'run schema',
        (candidate) =>
          void ((candidate.payload as Record<string, unknown>).schema_version = 'aiq.run.v2'),
      ],
      [
        'finish time',
        (candidate) => void ((candidate.payload as Record<string, unknown>).finished_unix_ms = 0),
      ],
      [
        'model order',
        (candidate) => {
          const payload = candidate.payload as Record<string, unknown>;
          payload.models = (payload.models as unknown[]).toReversed();
        },
      ],
      [
        'result schema',
        (candidate) => void (firstResult(candidate).schema_version = 'aiq.result.v1'),
      ],
      ['result status', (candidate) => void (firstResult(candidate).status = 'unevaluated')],
      ['result score', (candidate) => void (firstResult(candidate).task_score = 0)],
      [
        'result evaluator digest',
        (candidate) => void (firstResult(candidate).evaluator_result_sha256 = null),
      ],
      [
        'result evaluator stdout digest',
        (candidate) => void (firstResult(candidate).evaluator_stdout_sha256 = null),
      ],
      [
        'capability report schema',
        (candidate) =>
          void ((
            (candidate.payload as Record<string, unknown>).capability_validation as Record<
              string,
              unknown
            >
          ).schema_version = 'aiq.capability-validation.v1'),
      ],
    ];

    for (const [label, mutate] of mutations) {
      const candidate = officialPackage();
      mutate(candidate);
      assert.equal(validateSubmission(candidate).ok, false, label);
    }
  });

  void it('enforces capability evidence and attempted and unattempted workspace branches', () => {
    const missingSnapshot = officialPackage();
    firstResult(missingSnapshot).artifacts = [];
    const missingManifest = officialPackage();
    firstResult(missingManifest).workspace_manifest = null;

    for (const candidate of [missingSnapshot, missingManifest]) {
      const result = firstResult(candidate);
      rehashResult(result);
      assert.equal(validateSubmission(resignPackage(candidate)).ok, false);
    }

    const unattempted = officialPackage();
    const result = firstResult(unattempted);
    Object.assign(result, {
      status: 'failed',
      evaluation: 'not_evaluated',
      task_score: null,
      response: null,
      response_sha256: null,
      evaluator_result_sha256: null,
      evaluator_stdout_sha256: null,
      artifacts: [],
      failure: {
        kind: 'workspace_unavailable',
        message: 'workspace unavailable',
        exit_code: null,
        retryable: false,
      },
      workspace_manifest: null,
    });
    rehashResult(result);
    assert.equal(validateSubmission(resignPackage(unattempted)).ok, true);

    const brokenEvidence = officialPackage();
    const capability = (brokenEvidence.payload as Record<string, unknown>)
      .capability_validation as Record<string, unknown>;
    const firstEntry = (capability.models as Record<string, unknown>[])[0];
    assert.ok(firstEntry);
    (firstEntry.probe as Record<string, unknown>).evidence_digest = digest('a');
    assert.equal(validateSubmission(resignPackage(brokenEvidence)).ok, false);
  });

  void it('accepts exact completed, unevaluated, failed, and unsupported status semantics', () => {
    const unevaluated = officialPackage();
    const unevaluatedResult = firstResult(unevaluated);
    Object.assign(unevaluatedResult, {
      status: 'unevaluated',
      evaluation: 'not_evaluated',
      task_score: null,
      evaluator_result_sha256: null,
      evaluator_stdout_sha256: null,
      failure: {
        kind: 'missing_evaluator',
        message: 'missing evaluator',
        exit_code: null,
        retryable: false,
      },
    });
    rehashResult(unevaluatedResult);
    assert.equal(validateSubmission(resignPackage(unevaluated)).ok, true);

    const failed = officialPackage();
    const failedResult = firstResult(failed);
    Object.assign(failedResult, {
      status: 'failed',
      evaluation: 'not_evaluated',
      task_score: 0,
      response: null,
      response_sha256: null,
      evaluator_result_sha256: null,
      evaluator_stdout_sha256: null,
      failure: {
        kind: 'timeout',
        message: 'timed out',
        exit_code: null,
        retryable: true,
      },
    });
    rehashResult(failedResult);
    assert.equal(validateSubmission(resignPackage(failed)).ok, true);

    const subscriptionLimited = officialPackage();
    const subscriptionLimitedResult = firstResult(subscriptionLimited);
    Object.assign(subscriptionLimitedResult, {
      status: 'failed',
      evaluation: 'not_evaluated',
      task_score: null,
      response: null,
      response_sha256: null,
      evaluator_result_sha256: null,
      evaluator_stdout_sha256: null,
      failure: {
        kind: 'subscription_limit',
        message: 'subscription limit reached',
        exit_code: null,
        retryable: true,
      },
    });
    rehashResult(subscriptionLimitedResult);
    assert.equal(validateSubmission(resignPackage(subscriptionLimited)).ok, true);

    const failedWithEvaluatorStdout = structuredClone(failed);
    firstResult(failedWithEvaluatorStdout).evaluator_stdout_sha256 = digest('e');
    rehashResult(firstResult(failedWithEvaluatorStdout));
    assert.equal(validateSubmission(resignPackage(failedWithEvaluatorStdout)).ok, false);

    const unsupported = officialPackage();
    const payload = unsupported.payload as Record<string, unknown>;
    const capability = payload.capability_validation as Record<string, unknown>;
    const entry = (capability.models as Record<string, unknown>[])[0];
    assert.ok(entry);
    entry.status = 'unsupported';
    entry.reason = 'observed unsupported';
    const probe = entry.probe as Record<string, unknown>;
    Object.assign(probe, {
      status: 'observed_unsupported',
      result_digest: null,
      result_preview: null,
      artifacts: [],
      failure: {
        kind: 'unsupported',
        exit_code: null,
        stderr: '',
        message: 'unsupported',
        stdout_truncated: false,
        stderr_truncated: false,
        artifacts: [],
      },
    });
    probe.evidence_digest = `sha256:${sha256Hex(
      canonicalJson([
        entry.model,
        probe.codex_version,
        probe.observed_at,
        probe.status,
        probe.result_digest,
        probe.result_preview,
        probe.artifacts,
        probe.failure,
      ]),
    )}`;
    for (const candidate of payload.results as Record<string, unknown>[]) {
      if (canonicalJson(candidate.model) !== canonicalJson(entry.model)) {
        continue;
      }
      Object.assign(candidate, {
        status: 'unsupported',
        evaluation: 'not_evaluated',
        task_score: null,
        response: null,
        response_sha256: null,
        evaluator_result_sha256: null,
        evaluator_stdout_sha256: null,
        artifacts: [],
        failure: {
          kind: 'capability_unavailable',
          message: 'capability unavailable',
          exit_code: null,
          retryable: false,
        },
        workspace_manifest: null,
      });
      rehashResult(candidate);
    }
    const provenance = payload.provenance as Record<string, unknown>;
    provenance.preflight_digest = `sha256:${sha256Hex(canonicalJson(capability))}`;
    assert.equal(validateSubmission(resignPackage(unsupported)).ok, true);

    const mismatch = structuredClone(unsupported);
    firstResult(mismatch).status = 'failed';
    rehashResult(firstResult(mismatch));
    assert.equal(validateSubmission(resignPackage(mismatch)).ok, false);
  });

  void it('enforces UTF-8 64-byte preview edges', () => {
    for (const [value, accepted] of [
      ['😀'.repeat(16), true],
      ['😀'.repeat(16) + 'a', false],
    ] as const) {
      const candidate = officialPackage();
      const result = firstResult(candidate);
      result.response = value;
      result.response_sha256 = `sha256:${sha256Hex(value)}`;
      rehashResult(result);
      assert.equal(validateSubmission(resignPackage(candidate)).ok, accepted);
    }

    for (const [value, accepted] of [
      ['😀'.repeat(16), true],
      ['😀'.repeat(16) + 'a', false],
    ] as const) {
      const candidate = officialPackage();
      const payload = candidate.payload as Record<string, unknown>;
      const capability = payload.capability_validation as Record<string, unknown>;
      const entry = (capability.models as Record<string, unknown>[])[0];
      assert.ok(entry);
      const probe = entry.probe as Record<string, unknown>;
      probe.result_preview = value;
      probe.result_digest = `sha256:${sha256Hex(value)}`;
      probe.evidence_digest = `sha256:${sha256Hex(
        canonicalJson([
          entry.model,
          probe.codex_version,
          probe.observed_at,
          probe.status,
          probe.result_digest,
          probe.result_preview,
          probe.artifacts,
          probe.failure,
        ]),
      )}`;
      (payload.provenance as Record<string, unknown>).preflight_digest =
        `sha256:${sha256Hex(canonicalJson(capability))}`;
      assert.equal(validateSubmission(resignPackage(candidate)).ok, accepted);
    }
  });

  void it('enforces artifact role, URI, hash, byte, and uniqueness contracts', () => {
    const cases: Record<string, unknown>[] = [];

    const wrongRole = officialPackage();
    firstResult(wrongRole).artifacts = [artifact('workspace-manifest.json', 'wrong-role')];
    cases.push(wrongRole);

    const wrongUri = officialPackage();
    (
      (firstResult(wrongUri).artifacts as Record<string, unknown>[])[0] as Record<string, unknown>
    ).uri = 'aiq-artifact://sha256/invalid/workspace-snapshot.json';
    cases.push(wrongUri);

    const zeroHash = officialPackage();
    const zeroReference = (firstResult(zeroHash).artifacts as Record<string, unknown>[])[0];
    assert.ok(zeroReference);
    zeroReference.content_hash = `sha256:${'0'.repeat(64)}`;
    zeroReference.uri = `aiq-artifact://sha256/${'0'.repeat(64)}/workspace-snapshot.json`;
    cases.push(zeroHash);

    const duplicateKind = officialPackage();
    const duplicateResult = firstResult(duplicateKind);
    duplicateResult.artifacts = [
      ...(duplicateResult.artifacts as Record<string, unknown>[]),
      artifact('workspace-snapshot.json', 'second-snapshot'),
    ];
    cases.push(duplicateKind);

    const ambiguousHash = officialPackage();
    const ambiguousResult = firstResult(ambiguousHash);
    const snapshot = (ambiguousResult.artifacts as Record<string, unknown>[])[0];
    assert.ok(snapshot);
    const stdout = artifact('stdout.jsonl', 'unused', 2);
    stdout.content_hash = snapshot.content_hash;
    stdout.uri = `aiq-artifact://sha256/${(snapshot.content_hash as string).slice(
      'sha256:'.length,
    )}/stdout.jsonl`;
    ambiguousResult.artifacts = [snapshot, stdout];
    cases.push(ambiguousHash);

    const oversizedEvaluator = officialPackage();
    (
      (oversizedEvaluator.payload as Record<string, unknown>).evaluator_results_artifact as Record<
        string,
        unknown
      >
    ).bytes = MAX_SIGNED_PACKAGE_BYTES + 1;
    cases.push(oversizedEvaluator);

    for (const candidate of cases) {
      const result = firstResult(candidate);
      rehashResult(result);
      assert.equal(validateSubmission(resignPackage(candidate)).ok, false);
    }

    const exactEvaluator = officialPackage();
    (
      (exactEvaluator.payload as Record<string, unknown>).evaluator_results_artifact as Record<
        string,
        unknown
      >
    ).bytes = MAX_SIGNED_PACKAGE_BYTES;
    assert.equal(validateSubmission(resignPackage(exactEvaluator)).ok, true);
  });

  void it('rejects schema, field, hash, node, casing, payload, and extra-key drift', () => {
    const cases: Record<string, unknown>[] = [];

    const schema = cloneFixture();
    schema.schema_version = 'aiq.result-package.unsupported';
    cases.push(schema);

    const missing = cloneFixture();
    delete missing.signature;
    cases.push(missing);

    const hash = cloneFixture();
    hash.content_hash = `sha256:${'0'.repeat(64)}`;
    cases.push(hash);

    const node = cloneFixture();
    (node.signer as Record<string, unknown>).node_id = `node_${'0'.repeat(64)}`;
    cases.push(node);

    const casing = cloneFixture();
    casing.signature = (casing.signature as string).toUpperCase();
    cases.push(casing);

    const forgedSignature = cloneFixture();
    forgedSignature.signature = '0'.repeat(128);
    cases.push(forgedSignature);

    const unsignedTrustChange = cloneFixture();
    unsignedTrustChange.claimed_trust = 'trusted';
    cases.push(unsignedTrustChange);

    const payload = cloneFixture();
    (payload.payload as Record<string, unknown>).run_id = `run_${'0'.repeat(64)}`;
    cases.push(payload);

    const extraTop = cloneFixture();
    extraTop.package_sha256 = '0'.repeat(64);
    cases.push(extraTop);

    const extraSigner = cloneFixture();
    (extraSigner.signer as Record<string, unknown>).algorithm = 'ed25519';
    cases.push(extraSigner);

    for (const candidate of cases) {
      assert.equal(validateSubmission(candidate).ok, false);
    }
  });

  void it('rejects unsupported and calibration packages, missing synthetic null, and invalid production provenance', () => {
    const unsupported = signedPackage({
      schemaVersion: 'aiq.result-package.unsupported',
      payloadType: 'aiq.run.unsupported',
      payloadSchema: 'aiq.run.unsupported',
    });
    const calibrationPackage = signedPackage({
      payloadType: 'aiq.calibration-run.v3',
      payloadSchema: 'aiq.calibration-run.v3',
      synthetic: false,
      payloadOverrides: { official_eligible: false },
    });
    const missingSyntheticProvenance = signedPackage({
      payloadOverrides: { provenance: undefined },
    });
    delete (missingSyntheticProvenance.payload as Record<string, unknown>).provenance;
    const zeroDigest = signedPackage({
      synthetic: false,
      provenance: productionProvenance({
        runtime_digest: `sha256:${'0'.repeat(64)}`,
      }),
    });
    const extraField = signedPackage({
      synthetic: false,
      provenance: productionProvenance({ private_path: '/controlled/tasks' }),
    });
    const wrongCatalog = signedPackage({
      synthetic: false,
      provenance: productionProvenance({ catalog_digest: digest('2') }),
    });
    const calibration = signedPackage({
      synthetic: false,
      provenance: productionProvenance({ run_class: 'calibration' }),
    });
    const zeroPermissionEvidence = signedPackage({
      synthetic: false,
      provenance: productionProvenance({
        permission_evidence_digest: `sha256:${'0'.repeat(64)}`,
      }),
    });

    assert.equal(validateSubmission(unsupported).ok, false);
    assert.equal(validateSubmission(calibrationPackage).ok, false);
    assert.equal(validateSubmission(missingSyntheticProvenance).ok, false);
    for (const candidate of [
      zeroDigest,
      extraField,
      wrongCatalog,
      calibration,
      zeroPermissionEvidence,
    ]) {
      const validation = validateSubmission(candidate);
      assert.equal(validation.ok, false);
      if (!validation.ok) {
        assert.equal(validation.code, 'INVALID_PROVENANCE');
      }
    }
  });

  void it('rejects line terminators after canonical envelope and provenance fields', () => {
    const suffixes = ['\n', '\r\n', '\u2028', '\u2029'];
    for (const suffix of suffixes) {
      const envelope = cloneFixture();
      envelope.idempotency_key = `${fixtureRunId}${suffix}`;
      assert.equal(validateSubmission(envelope).ok, false);

      const production = signedPackage({
        synthetic: false,
        provenance: productionProvenance({
          corpus_release_id: `corpus_2026${suffix}`,
        }),
      });
      assert.equal(validateSubmission(production).ok, false);
    }
  });

  void it('enforces result, model, depth, and aggregate array bounds', () => {
    const results = cloneFixture();
    (results.payload as Record<string, unknown>).results = Array.from(
      { length: MAX_RESULTS + 1 },
      () => null,
    );
    const modelDrift = cloneFixture();
    (modelDrift.payload as Record<string, unknown>).models = Array.from(
      { length: MAX_MODELS + 1 },
      () => null,
    );
    const depth = cloneFixture();
    (depth.payload as Record<string, unknown>).nested = nestedObject(MAX_JSON_DEPTH);
    const genericArray = cloneFixture();
    (genericArray.payload as Record<string, unknown>).extra = Array.from(
      { length: MAX_RESULTS + 1 },
      () => null,
    );

    assert.equal(validateSubmission(results).ok, false);
    assert.equal(validateSubmission(modelDrift).ok, false);
    assert.equal(validateSubmission(depth).ok, false);
    assert.equal(validateSubmission(genericArray).ok, false);
  });

  void it('requires exact evaluator-results artifact and per-result digest bindings', () => {
    const valid = cloneFixture();
    const results = (valid.payload as Record<string, unknown>).results as Record<string, unknown>[];
    const completedResult = results[0] as Record<string, unknown>;
    completedResult.status = 'completed';
    completedResult.evaluation = 'correct';
    completedResult.task_score = 1;
    completedResult.response = 'ok';
    completedResult.response_sha256 = `sha256:${sha256Hex('ok')}`;
    completedResult.evaluator_result_sha256 = digest('d');
    completedResult.failure = null;
    completedResult.result_id = '';
    completedResult.result_id = `result_${sha256Hex(canonicalJson(completedResult))}`;
    resignPackage(valid);
    assert.equal(validateSubmission(valid).ok, true);

    const missingArtifact = cloneFixture();
    (missingArtifact.payload as Record<string, unknown>).evaluator_results_artifact = null;
    const wrongArtifactUri = cloneFixture();
    (
      (wrongArtifactUri.payload as Record<string, unknown>).evaluator_results_artifact as Record<
        string,
        unknown
      >
    ).uri = `aiq-artifact://sha256/${'f'.repeat(64)}/evaluator-results.json`;
    const missingDigest = structuredClone(valid);
    const missingDigestResult = (
      (missingDigest.payload as Record<string, unknown>).results as Record<string, unknown>[]
    )[0];
    assert.ok(missingDigestResult);
    missingDigestResult.evaluator_result_sha256 = null;

    for (const candidate of [missingArtifact, wrongArtifactUri, missingDigest]) {
      assert.equal(validateSubmission(resignPackage(candidate)).ok, false);
    }
  });

  void it('rejects nested DTO extra fields, scalar overflows, and semantic drift', () => {
    const cases = Array.from({ length: 7 }, () => cloneFixture());

    (firstResult(cases[0] as Record<string, unknown>).latency as Record<string, unknown>).cpu_ms =
      1;
    (firstResult(cases[1] as Record<string, unknown>).failure as Record<string, unknown>).message =
      'x'.repeat(129);
    (
      firstResult(cases[2] as Record<string, unknown>).tool_usage as Record<string, unknown>
    ).total_calls = 1;
    (
      firstResult(cases[3] as Record<string, unknown>).provenance as Record<string, unknown>
    ).private_path = '/tmp/private';
    (firstResult(cases[4] as Record<string, unknown>).model as Record<string, unknown>).family =
      'unknown';
    const invalidDate = cases[5];
    assert.ok(invalidDate);
    (
      (invalidDate.payload as Record<string, unknown>).schedule_slot as Record<string, unknown>
    ).local_date = '2026-02-30';
    firstResult(cases[6] as Record<string, unknown>).result_id = `result_${'a'.repeat(64)}`;

    for (const candidate of cases) {
      assert.equal(validateSubmission(resignPackage(candidate)).ok, false);
    }
  });

  void it('rejects values outside the JCS number and Unicode domain', () => {
    const unsafeInteger = cloneFixture();
    (unsafeInteger.payload as Record<string, unknown>).started_unix_ms =
      Number.MAX_SAFE_INTEGER + 1;
    const malformedUnicode = cloneFixture();
    (malformedUnicode.payload as Record<string, unknown>).message = '\uD800';

    assert.equal(validateSubmission(unsafeInteger).ok, false);
    assert.equal(validateSubmission(malformedUnicode).ok, false);
  });

  void it('keeps the JSON Schema constants consistent with the implementation and fixture', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../../../benchmarks/schema/result-package-v3.schema.json', import.meta.url),
        'utf8',
      ),
    ) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      ['x-aiq-wire']: Record<string, string>;
      ['x-aiq-limits']: Record<string, number>;
    };
    assert.equal(schema.properties.schema_version?.const, RESULT_PACKAGE_SCHEMA);
    assert.equal(schema.properties.payload_type?.const, RUN_PAYLOAD_TYPE);
    assert.deepEqual(schema.required.toSorted(), Object.keys(fixture).toSorted());
    assert.equal(schema['x-aiq-limits'].request_body_bytes, MAX_RAW_SUBMISSION_BYTES);
    assert.equal(MAX_SIGNED_PACKAGE_BYTES, 3_948_544);
    assert.match(schema['x-aiq-wire'].request_body_limit ?? '', /pre-parse hard ceiling/);
    assert.match(
      schema['x-aiq-wire'].signed_package_limit ?? '',
      /exactly equal the RFC 8785 canonical UTF-8 encoding/,
    );
    assert.equal(schema['x-aiq-limits'].maximum_depth, MAX_JSON_DEPTH);
    assert.equal(validateSubmission(fixture).ok, true);
  });

  void it('creates queue arguments from the server-computed receipt', () => {
    const validation = validateSubmission(fixture);
    assert.equal(validation.ok, true);
    if (!validation.ok) {
      return;
    }
    const receipt = {
      receivedAt: '2026-07-24T16:01:00.000Z',
      packageSha256: sha256Hex(fixtureBytes),
      bodyBytes: fixtureBytes.byteLength,
    };
    assert.deepEqual(
      createEnqueueRpcArguments(validation.submission, receipt, {
        bucket: 'private-packages',
        key: `sha256/${receipt.packageSha256}`,
        contentSha256: receipt.packageSha256,
        bytes: receipt.bodyBytes,
      }),
      {
        envelope: fixture,
        request_context: {
          source: 'aiq-wiki-web',
          received_at: receipt.receivedAt,
          idempotency_key: fixtureRunId,
          package_sha256: receipt.packageSha256,
          body_bytes: receipt.bodyBytes,
        },
        object_identity: {
          bucket: 'private-packages',
          key: `sha256/${receipt.packageSha256}`,
          content_sha256: receipt.packageSha256,
          bytes: receipt.bodyBytes,
        },
      },
    );
    assert.equal(
      mapEnqueueResult([
        {
          disposition: 'duplicate',
          inbox_id: duplicateInboxId,
          object_recorded: true,
        },
      ]).status,
      'duplicate',
    );
    assert.equal(
      mapEnqueueResult([
        {
          disposition: 'conflict',
          inbox_id: conflictInboxId,
          object_recorded: false,
        },
      ]).objectRecorded,
      false,
    );
    assert.equal(
      mapEnqueueResult({
        disposition: 'conflict',
        inbox_id: conflictInboxId,
        object_recorded: true,
      }).status,
      'invalid-upstream-response',
    );
  });
});

void describe('submission handler', () => {
  void it('compares bearer tokens and authorizes before reading the body', async () => {
    assert.equal(hasValidBearerToken(`Bearer ${token}`, token), true);
    assert.equal(hasValidBearerToken('Bearer wrong', token), false);
    assert.equal(hasValidBearerToken(null, token), false);
    const unauthorized = await handleSubmission(
      request('{', { authorization: 'Bearer wrong' }),
      dependencies(),
    );
    assert.equal(unauthorized.status, 401);
  });

  void it('returns 503 when server-only configuration is incomplete', async () => {
    const response = await handleSubmission(request(), {
      configured: false,
      expectedToken: '',
      storePackage: async () => {
        throw new Error('must not run');
      },
      registerStoredObject: async () => {
        throw new Error('must not run');
      },
      enqueue: async () => [
        {
          disposition: 'accepted',
          inbox_id: acceptedInboxId,
          object_recorded: true,
        },
      ],
    });
    assert.equal(response.status, 503);
  });

  void it('rejects missing, mismatched, and uppercase idempotency headers', async () => {
    const missing = await handleSubmission(
      request(undefined, { 'idempotency-key': '' }),
      dependencies(),
    );
    const mismatch = await handleSubmission(
      request(undefined, { 'idempotency-key': `run_${'0'.repeat(64)}` }),
      dependencies(),
    );
    const uppercase = await handleSubmission(
      request(undefined, { 'idempotency-key': fixtureRunId.toUpperCase() }),
      dependencies(),
    );
    assert.deepEqual([missing.status, mismatch.status, uppercase.status], [400, 400, 400]);
  });

  void it('rejects line terminators after exact submission header values', async () => {
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each raw header case owns a one-shot request body.
      const idempotency = await handleSubmission(
        requestWithRawHeader('idempotency-key', `${fixtureRunId}${suffix}`),
        dependencies(),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each raw header case owns a one-shot request body.
      const contentLength = await handleSubmission(
        requestWithRawHeader('content-length', `${fixtureBytes.byteLength}${suffix}`),
        dependencies(),
      );
      assert.equal(idempotency.status, 400);
      assert.equal(contentLength.status, 400);
    }
  });

  void it('rejects non-JSON, declared raw oversized, streamed raw oversized, and malformed bodies', async () => {
    const nonJson = await handleSubmission(
      request('{}', { 'content-type': 'text/plain' }),
      dependencies(),
    );
    const declaredOversized = await handleSubmission(
      request('{}', { 'content-length': String(MAX_RAW_SUBMISSION_BYTES + 1) }),
      dependencies(),
    );
    const streamedOversized = await handleSubmission(
      request(`"${'a'.repeat(MAX_RAW_SUBMISSION_BYTES)}"`),
      dependencies(),
    );
    const malformed = await handleSubmission(request('{'), dependencies());
    assert.deepEqual(
      [nonJson.status, declaredOversized.status, streamedOversized.status, malformed.status],
      [400, 413, 413, 400],
    );
  });

  void it('uses Content-Length only for the declared raw hard ceiling', async () => {
    const declaredAboveSigned = await handleSubmission(
      request(undefined, { 'content-length': String(MAX_SIGNED_PACKAGE_BYTES + 1) }),
      dependencies(),
    );
    const declaredAtRaw = await handleSubmission(
      request(undefined, { 'content-length': String(MAX_RAW_SUBMISSION_BYTES) }),
      dependencies(),
    );
    const declaredOverRaw = await handleSubmission(
      request(undefined, { 'content-length': String(MAX_RAW_SUBMISSION_BYTES + 1) }),
      dependencies(),
    );

    assert.equal(declaredAboveSigned.status, 202);
    assert.equal(declaredAtRaw.status, 202);
    assert.equal(declaredOverRaw.status, 413);
    assert.equal(((await declaredOverRaw.json()) as { error: string }).error, 'BODY_TOO_LARGE');
  });

  void it('rejects BOM, whitespace, and key-order alternatives before Storage or enqueue', async () => {
    let storageCalls = 0;
    let enqueueCalls = 0;
    const guardedDependencies = {
      ...dependencies(async () => {
        enqueueCalls += 1;
        throw new Error('must not enqueue noncanonical JSON');
      }),
      storePackage: async () => {
        storageCalls += 1;
        throw new Error('must not store noncanonical JSON');
      },
    };

    for (const body of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixtureBytes]),
      JSON.stringify(fixture, null, 2),
      JSON.stringify(fixture),
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each request owns a one-shot body.
      const response = await handleSubmission(request(body), guardedDependencies);
      assert.equal(response.status, 400);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each response body is consumed once.
      assert.deepEqual(await response.json(), {
        error: 'NON_CANONICAL_JSON',
        message: 'The JSON body must use its exact RFC 8785 canonical encoding.',
      });
    }
    assert.equal(storageCalls, 0);
    assert.equal(enqueueCalls, 0);
  });

  void it('rejects duplicate envelope, signature, signer, and deep keys before storage', async () => {
    const source = fixtureBytes.toString('utf8');
    const duplicates = [
      source.replace(
        '"schema_version":"aiq.result-package.v3"',
        '"schema_version":"aiq.result-package.v3","schema_version":"aiq.result-package.v3"',
      ),
      source.replace(
        /"signature":"([^"]+)"/,
        (_match, signature: string) => `"signature":"${signature}","signature":"${signature}"`,
      ),
      source.replace(
        `"signer":{"node_id":"${runnerNodeId}"`,
        `"signer":{"node_id":"${runnerNodeId}","node_id":"${runnerNodeId}"`,
      ),
      source.replace(
        '"model":{"family":"sol","reasoning_effort":"low"}',
        '"model":{"family":"sol","\\u0066amily":"sol","reasoning_effort":"low"}',
      ),
      source.replace(
        '"latency":{"wall_ms":0}',
        '"latency":{"wall_ms":0,"unknown":{"deep":1,"deep":2}}',
      ),
    ];
    let storageCalls = 0;
    const guardedDependencies = {
      ...dependencies(),
      storePackage: async () => {
        storageCalls += 1;
        throw new Error('must not store duplicate JSON');
      },
    };
    for (const body of duplicates) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each request owns a one-shot body.
      const response = await handleSubmission(request(body), guardedDependencies);
      assert.equal(response.status, 400);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each response body is consumed once.
      assert.deepEqual(await response.json(), {
        error: 'DUPLICATE_JSON_KEY',
        message: 'The JSON body must not contain duplicate object keys.',
      });
    }
    assert.equal(storageCalls, 0);
  });

  void it('enforces streamed raw bytes under, at, and over the hard ceiling', async () => {
    for (const [bytes, expectedError] of [
      [MAX_RAW_SUBMISSION_BYTES - 1, 'SIGNED_PACKAGE_TOO_LARGE'],
      [MAX_RAW_SUBMISSION_BYTES, 'SIGNED_PACKAGE_TOO_LARGE'],
      [MAX_RAW_SUBMISSION_BYTES + 1, 'BODY_TOO_LARGE'],
    ] as const) {
      const body = `"${'a'.repeat(bytes - 2)}"`;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each boundary owns a one-shot stream.
      const response = await handleSubmission(request(body), dependencies());
      assert.equal(response.status, 413);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each response body is consumed once.
      assert.equal(((await response.json()) as { error: string }).error, expectedError);
    }
  });

  void it('enforces canonical signed-package bytes at and over the lower ceiling', async () => {
    const exactBody = `"${'a'.repeat(MAX_SIGNED_PACKAGE_BYTES - 2)}"`;
    const overBody = `"${'a'.repeat(MAX_SIGNED_PACKAGE_BYTES - 1)}"`;
    const exact = await handleSubmission(request(exactBody), dependencies());
    const over = await handleSubmission(request(overBody), dependencies());

    assert.equal(exact.status, 400);
    assert.equal(((await exact.json()) as { error: string }).error, 'INVALID_BODY');
    assert.equal(over.status, 413);
    assert.equal(((await over.json()) as { error: string }).error, 'SIGNED_PACKAGE_TOO_LARGE');
  });

  void it('rejects malformed signed JSON without storing or reflecting input', async () => {
    const marker = 'private-signed-input-marker';
    let storageCalls = 0;
    for (const body of [
      `{"value":01,"secret":"${marker}"}`,
      `{"value":"\\x00","secret":"${marker}"}`,
      `{"value":"\\ud800","secret":"${marker}"}`,
      `{"value":true} trailing-${marker}`,
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each request owns a one-shot body.
      const response = await handleSubmission(request(body), {
        ...dependencies(),
        storePackage: async () => {
          storageCalls += 1;
          throw new Error('must not store malformed JSON');
        },
      });
      assert.equal(response.status, 400);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each response body is consumed once.
      const text = await response.text();
      assert.match(text, /INVALID_JSON/);
      assert.doesNotMatch(text, new RegExp(marker));
    }
    assert.equal(storageCalls, 0);
  });

  void it('passes the raw-body digest and byte count to the queue', async () => {
    let receipt: SubmissionReceipt | undefined;
    const response = await handleSubmission(
      request(),
      dependencies(async (_submission, observedReceipt) => {
        receipt = observedReceipt;
        return [
          {
            disposition: 'accepted',
            inbox_id: acceptedInboxId,
            object_recorded: true,
          },
        ];
      }),
    );
    assert.equal(response.status, 202);
    assert.equal(receipt?.packageSha256, sha256Hex(fixtureBytes));
    assert.equal(receipt?.bodyBytes, fixtureBytes.byteLength);
    assert.match(await response.text(), /queued_unverified/);
  });

  void it('stores and registers exact bytes before enqueue and signals retained objects after enqueue failure', async () => {
    const calls: string[] = [];
    let storedBytes: Uint8Array | undefined;
    const response = await handleSubmission(request(), {
      configured: true,
      expectedToken: token,
      async storePackage(rawBytes, receipt) {
        calls.push('store');
        storedBytes = rawBytes;
        return {
          bucket: 'private-packages',
          key: `sha256/${receipt.packageSha256}`,
          contentSha256: receipt.packageSha256,
          bytes: receipt.bodyBytes,
        };
      },
      async enqueue() {
        calls.push('enqueue');
        throw new Error('database unavailable');
      },
      async registerStoredObject() {
        calls.push('register');
      },
      signalOrphan(_identity, _receipt, reason) {
        calls.push(`signal-orphan:${reason}`);
      },
    });
    assert.equal(response.status, 502);
    assert.deepEqual(calls, [
      'store',
      'register',
      'enqueue',
      'signal-orphan:metadata_enqueue_failed',
    ]);
    assert.deepEqual(Buffer.from(storedBytes ?? []), fixtureBytes);
    assert.match(await response.text(), /SUBMISSION_ENQUEUE_FAILED_OBJECT_RETAINED/);
  });

  void it('fails closed after Storage registration failure without enqueue or secret disclosure', async () => {
    const calls: string[] = [];
    const response = await handleSubmission(request(), {
      ...dependencies(async () => {
        calls.push('enqueue');
      }),
      async storePackage(_rawBytes, receipt) {
        calls.push('store');
        return {
          bucket: 'private-packages',
          key: `sha256/${receipt.packageSha256}`,
          contentSha256: receipt.packageSha256,
          bytes: receipt.bodyBytes,
        };
      },
      async registerStoredObject() {
        calls.push('register');
        throw new Error('service-role-secret database detail');
      },
      signalOrphan(_identity, _receipt, reason) {
        calls.push(`signal-orphan:${reason}`);
      },
    });

    assert.equal(response.status, 502);
    assert.deepEqual(calls, ['store', 'register', 'signal-orphan:storage_registry_failed']);
    const body = await response.text();
    assert.match(body, /SUBMISSION_STORAGE_REGISTRATION_FAILED_OBJECT_RETAINED/);
    assert.doesNotMatch(body, /service-role-secret|database detail/);
  });

  void it('does not enqueue after object upload failure or mismatched stored identity', async () => {
    let enqueueCalls = 0;
    const uploadFailure = await handleSubmission(request(), {
      ...dependencies(),
      storePackage: async () => {
        throw new Error('storage unavailable');
      },
      enqueue: async () => {
        enqueueCalls += 1;
      },
    });
    const identityMismatch = await handleSubmission(request(), {
      ...dependencies(),
      storePackage: async (_rawBytes, receipt) => ({
        bucket: 'private-packages',
        key: `sha256/${receipt.packageSha256}`,
        contentSha256: '0'.repeat(64),
        bytes: receipt.bodyBytes,
      }),
      enqueue: async () => {
        enqueueCalls += 1;
      },
    });
    assert.equal(uploadFailure.status, 502);
    assert.equal(identityMismatch.status, 502);
    assert.equal(enqueueCalls, 0);
  });

  void it('maps duplicate and conflict without claiming verification', async () => {
    const duplicate = await handleSubmission(
      request(),
      dependencies(async () => [
        {
          disposition: 'duplicate',
          inbox_id: duplicateInboxId,
          object_recorded: true,
        },
      ]),
    );
    const conflict = await handleSubmission(
      request(),
      dependencies(async () => [
        {
          disposition: 'conflict',
          inbox_id: conflictInboxId,
          object_recorded: true,
        },
      ]),
    );
    assert.equal(duplicate.status, 208);
    assert.match(await duplicate.text(), /duplicate_unverified/);
    assert.equal(conflict.status, 409);
    assert.match(await conflict.text(), /unverified/);
  });

  void it('signals an over-quota conflict object for reconciliation', async () => {
    let signals = 0;
    const response = await handleSubmission(request(), {
      ...dependencies(async () => [
        {
          disposition: 'conflict',
          inbox_id: conflictInboxId,
          object_recorded: false,
        },
      ]),
      signalOrphan: () => {
        signals += 1;
      },
    });
    assert.equal(response.status, 409);
    assert.equal(signals, 1);
  });

  void it('rejects accepted and duplicate rows that did not record the retained object', async () => {
    for (const disposition of ['accepted', 'duplicate'] as const) {
      let orphanReason = '';
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each disposition owns an independent retained object.
      const response = await handleSubmission(request(), {
        ...dependencies(async () => [
          {
            disposition,
            inbox_id: disposition === 'accepted' ? acceptedInboxId : duplicateInboxId,
            object_recorded: false,
          },
        ]),
        signalOrphan: (_identity, _receipt, reason) => {
          orphanReason = reason;
        },
      });
      assert.equal(response.status, 502);
      assert.notEqual(response.status, disposition === 'accepted' ? 202 : 208);
      assert.equal(orphanReason, 'queue_object_not_recorded');
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each response body is consumed once.
      assert.deepEqual(await response.json(), {
        error: 'SUBMISSION_ENQUEUE_FAILED_OBJECT_RETAINED',
      });
    }
  });

  void it('rejects every malformed PostgREST enqueue result as a sanitized retained-object failure', async () => {
    const validRow = {
      disposition: 'accepted',
      inbox_id: acceptedInboxId,
      object_recorded: true,
    };
    const hostileResults: readonly [string, unknown][] = [
      ['object instead of array', validRow],
      ['zero rows', []],
      ['multiple rows', [validRow, validRow]],
      ['missing disposition', [{ inbox_id: acceptedInboxId, object_recorded: true }]],
      ['missing inbox_id', [{ disposition: 'accepted', object_recorded: true }]],
      ['missing object_recorded', [{ disposition: 'accepted', inbox_id: acceptedInboxId }]],
      ['extra field', [{ ...validRow, secret_detail: 'private-upstream-marker' }]],
      ['invalid disposition', [{ ...validRow, disposition: 'official' }]],
      ['wrong disposition type', [{ ...validRow, disposition: 1 }]],
      ['wrong inbox_id type', [{ ...validRow, inbox_id: 1 }]],
      ['zero inbox UUID', [{ ...validRow, inbox_id: '00000000-0000-0000-0000-000000000000' }]],
      ['uppercase inbox UUID', [{ ...validRow, inbox_id: acceptedInboxId.toUpperCase() }]],
      ['noncanonical inbox UUID', [{ ...validRow, inbox_id: acceptedInboxId.replaceAll('-', '') }]],
      [
        'invalid-version inbox UUID',
        [{ ...validRow, inbox_id: 'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa' }],
      ],
      [
        'invalid-variant inbox UUID',
        [{ ...validRow, inbox_id: 'aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa' }],
      ],
      ['wrong object_recorded type', [{ ...validRow, object_recorded: 'true' }]],
    ];

    for (const [label, upstreamResult] of hostileResults) {
      let orphanReason = '';
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each hostile result owns an independent retained object.
      const response = await handleSubmission(request(), {
        ...dependencies(async () => upstreamResult),
        signalOrphan: (_identity, _receipt, reason) => {
          orphanReason = reason;
        },
      });
      assert.equal(response.status, 502, label);
      assert.notEqual(response.status, 202, label);
      assert.notEqual(response.status, 208, label);
      assert.equal(orphanReason, 'queue_response_invalid', label);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each response body is consumed once.
      const body = await response.text();
      assert.equal(body, '{"error":"SUBMISSION_ENQUEUE_FAILED_OBJECT_RETAINED"}', label);
      assert.doesNotMatch(body, /private-upstream-marker/, label);
    }
  });

  void it('does not disclose RPC errors', async () => {
    const upstreamError = await handleSubmission(
      request(),
      dependencies(async () => {
        throw new Error('private upstream detail');
      }),
    );
    assert.equal(upstreamError.status, 502);
    assert.doesNotMatch(await upstreamError.text(), /private upstream detail/);
  });
});
