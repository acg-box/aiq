import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, it } from 'node:test';

/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests construct and mutate adversarial JSON records. */

import {
  MAX_VERIFICATION_BYTES,
  MAX_VERIFICATION_ARRAY_ITEMS,
  MAX_VERIFICATION_JSON_DEPTH,
  MAX_VERIFICATION_JSON_NODES,
  MAX_VERIFICATION_OBJECT_PROPERTIES,
  MAX_VERIFICATION_PROPERTY_NAME_LENGTH,
  MAX_VERIFICATION_STRING_LENGTH,
  NORMALIZED_BATCH_SCHEMA,
  isVerificationJsonWithinBounds,
  validateVerification,
  VERIFIER_ATTESTATION_SCHEMA,
  VERIFIER_REJECTION_SCHEMA,
} from './verification-contract.ts';
import {
  handleVerification,
  hasValidVerificationBearerToken,
  MAX_VERIFICATION_AUTHORIZATION_BYTES,
  type VerificationDependencies,
  verificationRpcFailureDiagnostic,
  verificationRoleClientOptions,
} from './verification-handler.ts';
import {
  createSupabaseRoleTokenIssuer,
  SUPABASE_ROLE_TOKEN_TTL_SECONDS,
} from './supabase-role-token.ts';
import { canonicalJson, sha256Hex } from './submission-contract.ts';

const token = 'verifier-ingress-token';
const runId = `run_${'1'.repeat(64)}`;
const packageSha256 = '2'.repeat(64);
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const claim = {
  inbox_id: '223e4567-e89b-42d3-a456-426614174000',
  lease_token: '123e4567-e89b-42d3-a456-426614174000',
  attempt: 1,
} as const;

function productionProvenance(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema_version: 'aiq.run-provenance.v2',
    run_class: 'official',
    corpus_release_id: 'corpus_2026.07.25',
    corpus_commitment_sha256: digest('1'),
    catalog_digest: 'sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3',
    task_set_digest: digest('4'),
    evaluator_digest: digest('3'),
    runtime_digest: digest('7'),
    preflight_digest: digest('6'),
    harness_digest: digest('8'),
    prompt_digest: digest('5'),
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

function signingIdentity() {
  const pair = generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  const publicKey = publicDer.subarray(publicDer.length - 32).toString('hex');
  return {
    privateKey: pair.privateKey,
    node: {
      node_id: `node_${sha256Hex(Buffer.from(publicKey, 'hex'))}`,
      public_key: publicKey,
    },
  };
}

function signedVerification(
  options: Readonly<{
    synthetic?: boolean;
    capabilityValidationDigest?: string | null;
    provenance?: unknown;
    replayStatus?: string;
    roleCollision?: 'runner_verifier';
  }> = {},
) {
  const synthetic = options.synthetic ?? true;
  const capabilityValidationDigest =
    options.capabilityValidationDigest === undefined
      ? synthetic
        ? null
        : digest('6')
      : options.capabilityValidationDigest;
  const runnerIdentity = signingIdentity();
  const verifierIdentity =
    options.roleCollision === 'runner_verifier' ? runnerIdentity : signingIdentity();
  const provenance =
    options.provenance === undefined
      ? synthetic
        ? null
        : productionProvenance()
      : options.provenance;
  const stage: Record<string, unknown> = {
    schema_version: NORMALIZED_BATCH_SCHEMA,
    matrix_batch_id: runId,
    package_sha256: packageSha256,
    content_hash: digest('3'),
    signer: runnerIdentity.node,
    task_set_id: 'aiq-core',
    task_set_version: '1.0.0',
    task_set_hash: digest('4'),
    capability_validation_digest: capabilityValidationDigest,
    provenance,
    run_class: synthetic ? null : 'official',
    benchmark_version: 'aiq-core@1.0.0',
    prompt_set_digest: digest('5'),
    scoring_version: '1.0.0',
    runner_commit: 'a'.repeat(40),
    region: 'test',
    scheduled_unix_ms: 1_753_376_400_000,
    started_unix_ms: 1_753_376_401_000,
    finished_unix_ms: 1_753_376_402_000,
    synthetic,
    runs: Array.from({ length: 17 }, (_, index) => ({ index })),
    normalization_digest: '',
  };
  const unsignedStage = Object.fromEntries(
    Object.entries(stage).filter(([key]) => key !== 'normalization_digest'),
  );
  stage.normalization_digest = `sha256:${sha256Hex(canonicalJson(unsignedStage))}`;

  const attestation: Record<string, unknown> = {
    schema_version: VERIFIER_ATTESTATION_SCHEMA,
    signature_algorithm: 'ed25519',
    signature_version: 'aiq.ed25519-jcs.v1',
    matrix_batch_id: stage.matrix_batch_id,
    package_sha256: stage.package_sha256,
    content_hash: stage.content_hash,
    normalization_digest: stage.normalization_digest,
    task_set_hash: stage.task_set_hash,
    capability_validation_digest: stage.capability_validation_digest,
    provenance: structuredClone(stage.provenance),
    benchmark_version: stage.benchmark_version,
    prompt_set_digest: stage.prompt_set_digest,
    scoring_version: stage.scoring_version,
    verifier: verifierIdentity.node,
    observed_unix_ms: 1_753_376_403_000,
    replay_status:
      options.replayStatus ?? (synthetic ? 'commitments_verified' : 'evaluator_replayed'),
    policy: synthetic ? 'synthetic_test' : 'production',
    synthetic,
    signature: '',
  };
  const unsignedAttestation = Object.fromEntries(
    Object.entries(attestation).filter(([key]) => key !== 'signature'),
  );
  attestation.signature = sign(
    null,
    Buffer.from(canonicalJson(unsignedAttestation), 'utf8'),
    verifierIdentity.privateKey,
  ).toString('hex');
  return { claim, stage, attestation };
}

function verifierRejection(overrides: Readonly<Record<string, unknown>> = {}): {
  claim: typeof claim;
  rejection: Record<string, unknown>;
} {
  return {
    claim,
    rejection: {
      schema_version: VERIFIER_REJECTION_SCHEMA,
      matrix_batch_id: runId,
      package_sha256: packageSha256,
      observed_at: '2026-07-24T17:03:04.123456Z',
      production: false,
      reason_code: 'verification_failed',
      reason_detail: 'The normalized package did not pass controlled verification.',
      synthetic: true,
      verifier_node_id: `node_${'7'.repeat(64)}`,
      ...overrides,
    },
  };
}

function request(
  body: string = JSON.stringify(signedVerification()),
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request('http://localhost/api/verifications', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
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

function nestedJsonArray(depth: number): unknown {
  let value: unknown = true;
  for (let index = 1; index < depth; index += 1) value = [value];
  return value;
}

function dependencies(
  calls: string[] = [],
  overrides: Partial<VerificationDependencies> = {},
): VerificationDependencies {
  return {
    configured: true,
    expectedToken: token,
    async stage(verification) {
      calls.push('aiq_stage_verifier_result');
      return verification.stage.matrix_batch_id;
    },
    async recordAttestation() {
      calls.push('aiq_record_verifier_attestation');
    },
    async publish() {
      calls.push('aiq_verify_and_publish');
    },
    async reject() {
      calls.push('aiq_record_verification_rejection');
    },
    ...overrides,
  };
}

void describe('verifier ingress contract', () => {
  void it('accepts synthetic null and production non-null capability evidence', () => {
    assert.equal(validateVerification(signedVerification()).ok, true);
    assert.equal(validateVerification(signedVerification({ synthetic: false })).ok, true);
  });

  void it('requires evaluator replay for production v3 attestations', () => {
    assert.equal(
      validateVerification(
        signedVerification({ synthetic: false, replayStatus: 'evaluator_replayed' }),
      ).ok,
      true,
    );
    assert.equal(
      validateVerification(signedVerification({ synthetic: false, replayStatus: 'reproduced' })).ok,
      false,
    );
    assert.equal(
      validateVerification(
        signedVerification({ synthetic: false, replayStatus: 'commitments_verified' }),
      ).ok,
      false,
    );
  });

  void it('rejects unsupported verification and normalized-batch schemas', () => {
    const unsupportedStage = signedVerification();
    unsupportedStage.stage.schema_version = 'aiq.normalized-batch.unsupported';
    const unsupportedAttestation = signedVerification();
    unsupportedAttestation.attestation.schema_version = 'aiq.verifier-attestation.unsupported';

    assert.equal(validateVerification(unsupportedStage).ok, false);
    assert.equal(validateVerification(unsupportedAttestation).ok, false);
  });

  void it('accepts exact synthetic and production rejection contracts', () => {
    assert.equal(
      validateVerification(verifierRejection({ reason_detail: '😀'.repeat(1_024) })).ok,
      true,
    );
    assert.equal(
      validateVerification(verifierRejection({ production: true, synthetic: false })).ok,
      true,
    );
    assert.equal(
      validateVerification(verifierRejection({ package_sha256: '0'.repeat(64) })).ok,
      false,
    );
  });

  void it('rejects capability evidence that does not match the stage policy', () => {
    const syntheticWithDigest = validateVerification(
      signedVerification({ capabilityValidationDigest: digest('6') }),
    );
    const productionWithoutDigest = validateVerification(
      signedVerification({ synthetic: false, capabilityValidationDigest: null }),
    );

    assert.equal(syntheticWithDigest.ok, false);
    assert.equal(productionWithoutDigest.ok, false);
    if (!syntheticWithDigest.ok && !productionWithoutDigest.ok) {
      assert.equal(syntheticWithDigest.code, 'INVALID_CAPABILITY_EVIDENCE_POLICY');
      assert.equal(productionWithoutDigest.code, 'INVALID_CAPABILITY_EVIDENCE_POLICY');
    }
  });

  void it('requires exact nonzero provenance and all stage-to-attestation provenance bindings', () => {
    const syntheticWithProvenance = signedVerification({
      provenance: productionProvenance(),
    });
    const productionWithoutProvenance = signedVerification({
      synthetic: false,
      provenance: null,
    });
    const zeroDigest = signedVerification({
      synthetic: false,
      provenance: productionProvenance({
        runtime_digest: `sha256:${'0'.repeat(64)}`,
      }),
    });
    const extraField = signedVerification({
      synthetic: false,
      provenance: productionProvenance({ private_path: '/controlled/tasks' }),
    });
    const wrongCatalog = signedVerification({
      synthetic: false,
      provenance: productionProvenance({ catalog_digest: digest('2') }),
    });
    const calibration = signedVerification({
      synthetic: false,
      provenance: productionProvenance({ run_class: 'calibration' }),
    });
    const missingRunClass = signedVerification({ synthetic: false });
    missingRunClass.stage.run_class = null;
    const stageBinding = signedVerification({
      synthetic: false,
      provenance: productionProvenance({ task_set_digest: digest('f') }),
    });
    const attestationBinding = signedVerification({ synthetic: false });
    (attestationBinding.attestation.provenance as Record<string, unknown>).runtime_digest =
      digest('f');
    const substitutedPermissionEvidence = signedVerification({ synthetic: false });
    (
      substitutedPermissionEvidence.attestation.provenance as Record<string, unknown>
    ).permission_evidence_digest = digest('4');
    const zeroStageDigest = signedVerification();
    zeroStageDigest.stage.content_hash = `sha256:${'0'.repeat(64)}`;
    const zeroPackageDigest = signedVerification();
    zeroPackageDigest.stage.package_sha256 = '0'.repeat(64);
    const zeroPermissionEvidence = signedVerification({
      synthetic: false,
      provenance: productionProvenance({
        permission_evidence_digest: `sha256:${'0'.repeat(64)}`,
      }),
    });

    for (const candidate of [
      syntheticWithProvenance,
      productionWithoutProvenance,
      zeroDigest,
      extraField,
      wrongCatalog,
      calibration,
      missingRunClass,
      stageBinding,
      attestationBinding,
      substitutedPermissionEvidence,
      zeroStageDigest,
      zeroPackageDigest,
      zeroPermissionEvidence,
    ]) {
      assert.equal(validateVerification(candidate).ok, false);
    }
  });

  void it('matches the SQL JSON depth, node, property, array, string, and key bounds', () => {
    assert.equal(
      isVerificationJsonWithinBounds(nestedJsonArray(MAX_VERIFICATION_JSON_DEPTH)),
      true,
    );
    assert.equal(
      isVerificationJsonWithinBounds(nestedJsonArray(MAX_VERIFICATION_JSON_DEPTH + 1)),
      false,
    );

    const properties = Object.fromEntries(
      Array.from({ length: MAX_VERIFICATION_OBJECT_PROPERTIES }, (_, index) => [`p${index}`, null]),
    );
    assert.equal(isVerificationJsonWithinBounds(properties), true);
    assert.equal(isVerificationJsonWithinBounds({ ...properties, overflow: null }), false);
    assert.equal(
      isVerificationJsonWithinBounds(
        Array.from({ length: MAX_VERIFICATION_ARRAY_ITEMS }, () => null),
      ),
      true,
    );
    assert.equal(
      isVerificationJsonWithinBounds(
        Array.from({ length: MAX_VERIFICATION_ARRAY_ITEMS + 1 }, () => null),
      ),
      false,
    );
    assert.equal(isVerificationJsonWithinBounds('a'.repeat(MAX_VERIFICATION_STRING_LENGTH)), true);
    assert.equal(
      isVerificationJsonWithinBounds('a'.repeat(MAX_VERIFICATION_STRING_LENGTH + 1)),
      false,
    );
    assert.equal(
      isVerificationJsonWithinBounds({
        ['a'.repeat(MAX_VERIFICATION_PROPERTY_NAME_LENGTH)]: null,
      }),
      true,
    );
    assert.equal(
      isVerificationJsonWithinBounds({
        ['a'.repeat(MAX_VERIFICATION_PROPERTY_NAME_LENGTH + 1)]: null,
      }),
      false,
    );

    const nodeGroups = Array.from({ length: 256 }, () => [] as null[]);
    let remaining = MAX_VERIFICATION_JSON_NODES - 257;
    for (const group of nodeGroups) {
      const size = Math.min(MAX_VERIFICATION_ARRAY_ITEMS, remaining);
      group.push(...Array.from({ length: size }, () => null));
      remaining -= size;
    }
    const exactNodes = Object.fromEntries(nodeGroups.map((group, index) => [`g${index}`, group]));
    assert.equal(remaining, 0);
    assert.equal(isVerificationJsonWithinBounds(exactNodes), true);
    nodeGroups.at(-1)?.push(null);
    assert.equal(isVerificationJsonWithinBounds(exactNodes), false);
  });

  void it('rejects LF, CRLF, U+2028, and U+2029 after verification boundary fields', () => {
    const suffixes = ['\n', '\r\n', '\u2028', '\u2029'];
    for (const suffix of suffixes) {
      const stage = signedVerification();
      stage.stage.matrix_batch_id = `${runId}${suffix}`;
      assert.equal(validateVerification(stage).ok, false);

      const provenance = signedVerification({
        synthetic: false,
        provenance: productionProvenance({
          corpus_release_id: `corpus_2026${suffix}`,
        }),
      });
      assert.equal(validateVerification(provenance).ok, false);

      assert.equal(
        validateVerification(verifierRejection({ observed_at: `2026-07-24T17:03:04Z${suffix}` }))
          .ok,
        false,
      );
    }
  });

  void it('requires separate API and valid role-token signing credentials', async () => {
    const roleTokenKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateJwk = {
      ...roleTokenKeys.privateKey.export({ format: 'jwk' }),
      alg: 'ES256',
      kid: 'test-supabase-role-key',
    };
    const configuration = {
      url: 'https://example.supabase.co',
      apiKey: 'publishable-api-key',
      jwtPrivateJwk: JSON.stringify(privateJwk),
      ingressToken: token,
      publisherNodeId: `node_${'a'.repeat(64)}`,
    };
    const fixedTime = 1_753_376_400;
    const issueRoleToken = createSupabaseRoleTokenIssuer(
      configuration.jwtPrivateJwk,
      () => fixedTime,
    );
    const verifierOptions = verificationRoleClientOptions(() =>
      issueRoleToken({ role: 'aiq_verifier' }),
    );
    const roleToken = await verifierOptions.accessToken();
    const [encodedHeader, encodedPayload, encodedSignature] = roleToken.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(encodedHeader ?? '', 'base64url').toString('utf8')), {
      alg: 'ES256',
      kid: 'test-supabase-role-key',
      typ: 'JWT',
    });
    assert.deepEqual(JSON.parse(Buffer.from(encodedPayload ?? '', 'base64url').toString('utf8')), {
      role: 'aiq_verifier',
      iat: fixedTime,
      exp: fixedTime + SUPABASE_ROLE_TOKEN_TTL_SECONDS,
    });
    assert.equal(
      verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
        { key: roleTokenKeys.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(encodedSignature ?? '', 'base64url'),
      ),
      true,
    );
    assert.deepEqual(verifierOptions.auth, {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
    const publisherToken = issueRoleToken({
      role: 'aiq_publisher',
      publisherNodeId: configuration.publisherNodeId,
    });
    const publisherPayload = publisherToken.split('.')[1] ?? '';
    assert.deepEqual(JSON.parse(Buffer.from(publisherPayload, 'base64url').toString('utf8')), {
      role: 'aiq_publisher',
      aiq_publisher_node_id: configuration.publisherNodeId,
      iat: fixedTime,
      exp: fixedTime + SUPABASE_ROLE_TOKEN_TTL_SECONDS,
    });
    assert.throws(
      () =>
        issueRoleToken({
          role: 'aiq_publisher',
          publisherNodeId: 'node_invalid',
        }),
      /exact AIQ publisher node ID/,
    );

    const calls: string[] = [];
    const response = await handleVerification(
      request(),
      dependencies(calls, { configured: false }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(calls, []);
  });

  void it('builds bounded RPC diagnostics without parameters or secret fields', () => {
    const upstream = {
      code: `P0001\n${'c'.repeat(100)}`,
      message: `bounded database failure\u0000${'m'.repeat(1_000)}`,
      parameters: 'must-not-appear',
      secret: 'must-not-appear',
    };
    const diagnostic = verificationRpcFailureDiagnostic('aiq_stage_verifier_result', upstream);

    assert.deepEqual(Object.keys(diagnostic).toSorted(), [
      'code',
      'event',
      'function_name',
      'message',
    ]);
    assert.equal(diagnostic.event, 'aiq_verification_rpc_failed');
    assert.equal(diagnostic.function_name, 'aiq_stage_verifier_result');
    assert.ok(diagnostic.code.length <= 64);
    assert.ok(diagnostic.message.length <= 512);
    const serialized = JSON.stringify(diagnostic);
    assert.doesNotMatch(serialized, /must-not-appear/);
    assert.equal(
      Array.from(serialized).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      }),
      false,
    );
  });

  void it('rejects malformed, forged but well-formed, and all-zero signatures', () => {
    const malformed = signedVerification();
    malformed.attestation.signature = 'not-a-signature';
    const forged = signedVerification();
    const signature = forged.attestation.signature as string;
    forged.attestation.signature = `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`;
    const zero = signedVerification();
    zero.attestation.signature = '0'.repeat(128);

    assert.equal(validateVerification(malformed).ok, false);
    assert.equal(validateVerification(forged).ok, false);
    assert.equal(validateVerification(zero).ok, false);
  });

  void it('rejects key/signature and key-derived node_id mismatches', () => {
    const signingKeyMismatch = signedVerification();
    signingKeyMismatch.attestation.verifier = signingIdentity().node;
    const nodeIdMismatch = signedVerification();
    (nodeIdMismatch.attestation.verifier as Record<string, unknown>).public_key =
      signingIdentity().node.public_key;

    assert.equal(validateVerification(signingKeyMismatch).ok, false);
    assert.equal(validateVerification(nodeIdMismatch).ok, false);
  });

  void it('rejects a runner/verifier production identity collision', () => {
    const validation = validateVerification(
      signedVerification({ synthetic: false, roleCollision: 'runner_verifier' }),
    );
    assert.equal(validation.ok, false);
    if (!validation.ok) {
      assert.equal(validation.code, 'INVALID_IDENTITY_SEPARATION');
    }
  });

  void it('rejects an attestation binding mismatch before any RPC', async () => {
    const candidate = signedVerification();
    candidate.attestation.package_sha256 = '9'.repeat(64);
    const calls: string[] = [];
    const response = await handleVerification(
      request(JSON.stringify(candidate)),
      dependencies(calls),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
    assert.match(await response.text(), /ATTESTATION_BINDING_MISMATCH/);
  });

  void it('rejects oversized authorization and body inputs before processing', async () => {
    assert.equal(hasValidVerificationBearerToken(`Bearer ${token}`, token), true);
    assert.equal(
      hasValidVerificationBearerToken(
        `Bearer ${'a'.repeat(MAX_VERIFICATION_AUTHORIZATION_BYTES)}`,
        token,
      ),
      false,
    );
    assert.equal(
      hasValidVerificationBearerToken(
        `Bearer ${'é'.repeat(MAX_VERIFICATION_AUTHORIZATION_BYTES / 2)}`,
        token,
      ),
      false,
    );
    const calls: string[] = [];
    const oversizedAuth = await handleVerification(
      request('{}', {
        authorization: `Bearer ${'a'.repeat(MAX_VERIFICATION_AUTHORIZATION_BYTES)}`,
      }),
      dependencies(calls),
    );
    const declaredOversized = await handleVerification(
      request('{}', { 'content-length': String(MAX_VERIFICATION_BYTES + 1) }),
      dependencies(calls),
    );
    const streamedOversized = await handleVerification(
      request(`"${'a'.repeat(MAX_VERIFICATION_BYTES)}"`),
      dependencies(calls),
    );

    assert.deepEqual(
      [oversizedAuth.status, declaredOversized.status, streamedOversized.status],
      [401, 400, 400],
    );
    assert.deepEqual(calls, []);
  });

  void it('returns deterministic 4xx for each JSON boundary plus one before any RPC', async () => {
    const tooDeep = nestedJsonArray(MAX_VERIFICATION_JSON_DEPTH + 1);
    const tooManyProperties = Object.fromEntries(
      Array.from({ length: MAX_VERIFICATION_OBJECT_PROPERTIES + 1 }, (_, index) => [
        `p${index}`,
        null,
      ]),
    );
    const tooManyArrayItems = Array.from({ length: MAX_VERIFICATION_ARRAY_ITEMS + 1 }, () => null);
    const tooLongString = 'a'.repeat(MAX_VERIFICATION_STRING_LENGTH + 1);
    const tooLongKey = {
      ['a'.repeat(MAX_VERIFICATION_PROPERTY_NAME_LENGTH + 1)]: null,
    };
    const nodeGroups = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `g${index}`,
        Array.from(
          {
            length: index < 81 ? MAX_VERIFICATION_ARRAY_ITEMS : index === 81 ? 600 : 0,
          },
          () => null,
        ),
      ]),
    );
    const calls: string[] = [];
    for (const candidate of [
      tooDeep,
      tooManyProperties,
      tooManyArrayItems,
      tooLongString,
      tooLongKey,
      nodeGroups,
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each case owns a one-shot request stream.
      const response = await handleVerification(
        request(JSON.stringify(candidate)),
        dependencies(calls),
      );
      assert.equal(response.status, 400);
    }
    assert.deepEqual(calls, []);
  });

  void it('rejects line terminators after the verification content-length header', async () => {
    const calls: string[] = [];
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each raw header case owns a one-shot request body.
      const response = await handleVerification(
        requestWithRawHeader('content-length', `1${suffix}`),
        dependencies(calls),
      );
      assert.equal(response.status, 400);
    }
    assert.deepEqual(calls, []);
  });

  void it('invokes the verifier and publisher RPC boundaries in controlled order', async () => {
    const calls: string[] = [];
    const response = await handleVerification(request(), dependencies(calls));

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      'aiq_stage_verifier_result',
      'aiq_record_verifier_attestation',
      'aiq_verify_and_publish',
    ]);
    assert.match(await response.text(), /verified_published/);
  });

  void it('records a valid rejection without staging, attesting, or publishing', async () => {
    const calls: string[] = [];
    const response = await handleVerification(
      request(JSON.stringify(verifierRejection())),
      dependencies(calls),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['aiq_record_verification_rejection']);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, 'rejection_recorded_not_published');
    assert.equal(body.published, false);
    assert.equal(body.matrix_batch_id, runId);
    assert.equal(body.package_sha256, packageSha256);
  });

  void it('rejects malformed rejection shapes before any RPC', async () => {
    const candidates = [
      verifierRejection({ schema_version: 'aiq.verifier-rejection.v1' }),
      verifierRejection({ matrix_batch_id: 'invalid-run' }),
      verifierRejection({ package_sha256: 'ABC' }),
      verifierRejection({ verifier_node_id: 'node_invalid' }),
      verifierRejection({ observed_at: '2026-02-29T17:03:04Z' }),
      verifierRejection({ observed_at: '2026-07-24T13:03:04-04:00' }),
      verifierRejection({ reason_code: 'UPPERCASE' }),
      verifierRejection({ reason_code: 'ab' }),
      verifierRejection({ reason_code: 'a'.repeat(65) }),
      verifierRejection({ reason_detail: '😀'.repeat(1_025) }),
      verifierRejection({ reason_detail: '\uD800' }),
      verifierRejection({ extra: true }),
      { claim, rejection: null },
      { claim, rejection: verifierRejection().rejection, stage: {} },
      { ...verifierRejection(), claim: { ...claim, attempt: 0 } },
      { ...verifierRejection(), claim: { ...claim, lease_token: 'wrong' } },
    ];
    const calls: string[] = [];
    for (const candidate of candidates) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each adversarial request is independent.
      const response = await handleVerification(
        request(JSON.stringify(candidate)),
        dependencies(calls),
      );
      assert.equal(response.status, 400);
    }
    assert.deepEqual(calls, []);
  });

  void it('enforces the rejection production and synthetic binding policy', async () => {
    const calls: string[] = [];
    const invalidBindings = [
      verifierRejection({ production: true, synthetic: true }),
      verifierRejection({ production: false, synthetic: false }),
    ];
    for (const candidate of invalidBindings) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each policy case is independent.
      const response = await handleVerification(
        request(JSON.stringify(candidate)),
        dependencies(calls),
      );
      assert.equal(response.status, 400);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect the current policy response.
      assert.match(await response.text(), /INVALID_VERIFICATION_REJECTION/);
    }
    assert.deepEqual(calls, []);
  });

  void it('hides rejection RPC errors and does not invoke another boundary', async () => {
    const calls: string[] = [];
    const response = await handleVerification(
      request(JSON.stringify(verifierRejection())),
      dependencies(calls, {
        async reject() {
          calls.push('aiq_record_verification_rejection');
          throw new Error('private rejection RPC detail');
        },
      }),
    );

    assert.equal(response.status, 502);
    assert.deepEqual(calls, ['aiq_record_verification_rejection']);
    assert.doesNotMatch(await response.text(), /private rejection RPC detail/);
  });

  void it('stops the RPC sequence and hides upstream errors', async () => {
    const calls: string[] = [];
    const response = await handleVerification(
      request(),
      dependencies(calls, {
        async recordAttestation() {
          calls.push('aiq_record_verifier_attestation');
          throw new Error('private RPC detail');
        },
      }),
    );

    assert.equal(response.status, 502);
    assert.deepEqual(calls, ['aiq_stage_verifier_result', 'aiq_record_verifier_attestation']);
    assert.doesNotMatch(await response.text(), /private RPC detail/);
  });
});
