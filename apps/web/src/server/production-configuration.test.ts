import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';

import {
  inspectArtifactIngressConfiguration,
  inspectProductionConfiguration,
  inspectSubmissionConfiguration,
  inspectVerificationConfiguration,
  inspectVerifierClaimConfiguration,
} from './production-configuration.ts';

// Next resolves this marker to its empty module in the server runtime.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === 'server-only' ? 'next/dist/compiled/server-only/empty.js' : specifier,
      context,
    );
  },
});

const privateJwk = JSON.stringify({
  ...generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
    format: 'jwk',
  }),
  alg: 'ES256',
  kid: 'production-configuration-test-key',
});

const common = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://example.supabase.co',
} as const;
const secretKey = 'sb_secret_service_example';
const runnerToken = 'runner-secret-value';
const verifierToken = 'verifier-secret-value';
const apiKey = 'sb_publishable_gateway_example';
const publisherNodeId = `node_${'a'.repeat(64)}`;

const validEnvironment = {
  ...common,
  NEXT_PUBLIC_SUPABASE_URL: common.SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
  SUPABASE_SECRET_KEY: secretKey,
  AIQ_RUNNER_SUBMISSION_TOKEN: runnerToken,
  AIQ_SUBMISSION_PACKAGE_BUCKET: 'aiq-submission-packages',
  AIQ_RUNNER_ARTIFACT_BUCKET: 'aiq-runner-artifacts',
  AIQ_VERIFIER_INGRESS_TOKEN: verifierToken,
  AIQ_SUPABASE_PUBLISHABLE_KEY: apiKey,
  AIQ_SUPABASE_JWT_PRIVATE_JWK: privateJwk,
  AIQ_PUBLISHER_NODE_ID: publisherNodeId,
} as const;

void describe('route-scoped production configuration', () => {
  void it('accepts only the exact submission ingress variables', () => {
    const configuration = inspectSubmissionConfiguration({
      ...common,
      SUPABASE_SECRET_KEY: secretKey,
      AIQ_RUNNER_SUBMISSION_TOKEN: runnerToken,
      AIQ_SUBMISSION_PACKAGE_BUCKET: 'aiq-submission-packages',
    });
    assert.deepEqual(configuration.values, {
      serviceUrl: common.SUPABASE_URL,
      secretKey,
      runnerToken,
      packageBucket: 'aiq-submission-packages',
    });
  });

  void it('accepts only the exact artifact ingress variables', () => {
    const configuration = inspectArtifactIngressConfiguration({
      ...common,
      SUPABASE_SECRET_KEY: secretKey,
      AIQ_RUNNER_SUBMISSION_TOKEN: runnerToken,
      AIQ_RUNNER_ARTIFACT_BUCKET: 'aiq-runner-artifacts',
    });
    assert.deepEqual(configuration.values, {
      serviceUrl: common.SUPABASE_URL,
      secretKey,
      runnerToken,
      artifactBucket: 'aiq-runner-artifacts',
    });
  });

  void it('accepts verifier claim variables without ingress buckets or publisher identity', () => {
    const configuration = inspectVerifierClaimConfiguration({
      ...common,
      SUPABASE_SECRET_KEY: secretKey,
      AIQ_VERIFIER_INGRESS_TOKEN: verifierToken,
      AIQ_SUPABASE_PUBLISHABLE_KEY: apiKey,
      AIQ_SUPABASE_JWT_PRIVATE_JWK: privateJwk,
    });
    assert.deepEqual(configuration.values, {
      serviceUrl: common.SUPABASE_URL,
      secretKey,
      verifierToken,
      publishableKey: apiKey,
      privateJwk,
    });
  });

  void it('accepts verification variables without service credentials or ingress buckets', () => {
    const configuration = inspectVerificationConfiguration({
      ...common,
      AIQ_VERIFIER_INGRESS_TOKEN: verifierToken,
      AIQ_SUPABASE_PUBLISHABLE_KEY: apiKey,
      AIQ_SUPABASE_JWT_PRIVATE_JWK: privateJwk,
      AIQ_PUBLISHER_NODE_ID: publisherNodeId,
    });
    assert.deepEqual(configuration.values, {
      serviceUrl: common.SUPABASE_URL,
      verifierToken,
      publishableKey: apiKey,
      privateJwk,
      publisherNodeId,
    });
  });

  void it('keeps readiness on the complete production contract', () => {
    assert.ok(inspectProductionConfiguration(validEnvironment).values);
    const incomplete = { ...validEnvironment, AIQ_RUNNER_ARTIFACT_BUCKET: undefined };
    assert.equal(inspectProductionConfiguration(incomplete).values, undefined);
  });

  void it('rejects well-formed but non-canonical Storage bucket names', () => {
    const packageInspection = inspectSubmissionConfiguration({
      ...common,
      SUPABASE_SECRET_KEY: secretKey,
      AIQ_RUNNER_SUBMISSION_TOKEN: runnerToken,
      AIQ_SUBMISSION_PACKAGE_BUCKET: 'unrelated-private-bucket',
    });
    assert.equal(packageInspection.values, undefined);
    assert.deepEqual(packageInspection.issues, [
      'AIQ_SUBMISSION_PACKAGE_BUCKET must be aiq-submission-packages',
    ]);

    const artifactInspection = inspectProductionConfiguration({
      ...validEnvironment,
      AIQ_RUNNER_ARTIFACT_BUCKET: 'unrelated-private-bucket',
    });
    assert.equal(artifactInspection.values, undefined);
    assert.ok(
      artifactInspection.issues.includes('AIQ_RUNNER_ARTIFACT_BUCKET must be aiq-runner-artifacts'),
    );
  });

  void it('fails each route scope closed when one of its required variables is invalid', () => {
    assert.equal(
      inspectSubmissionConfiguration({
        ...common,
        SUPABASE_SECRET_KEY: secretKey,
        AIQ_RUNNER_SUBMISSION_TOKEN: 'runner token',
        AIQ_SUBMISSION_PACKAGE_BUCKET: 'aiq-submission-packages',
      }).values,
      undefined,
    );
    assert.equal(
      inspectArtifactIngressConfiguration({
        ...common,
        SUPABASE_SECRET_KEY: secretKey,
        AIQ_RUNNER_SUBMISSION_TOKEN: runnerToken,
      }).values,
      undefined,
    );
    assert.equal(
      inspectVerifierClaimConfiguration({
        ...common,
        SUPABASE_SECRET_KEY: secretKey,
        AIQ_VERIFIER_INGRESS_TOKEN: verifierToken,
        AIQ_SUPABASE_PUBLISHABLE_KEY: apiKey,
        AIQ_SUPABASE_JWT_PRIVATE_JWK: '{}',
      }).values,
      undefined,
    );
    assert.equal(
      inspectVerificationConfiguration({
        ...common,
        AIQ_VERIFIER_INGRESS_TOKEN: verifierToken,
        AIQ_SUPABASE_PUBLISHABLE_KEY: apiKey,
        AIQ_SUPABASE_JWT_PRIVATE_JWK: privateJwk,
        AIQ_PUBLISHER_NODE_ID: 'node_invalid',
      }).values,
      undefined,
    );
  });

  void it('allows loopback HTTP only in development or test', () => {
    for (const NODE_ENV of ['development', 'test']) {
      assert.ok(
        inspectSubmissionConfiguration({
          NODE_ENV,
          SUPABASE_URL: 'http://127.0.0.1:54321',
          SUPABASE_SECRET_KEY: secretKey,
          AIQ_RUNNER_SUBMISSION_TOKEN: runnerToken,
          AIQ_SUBMISSION_PACKAGE_BUCKET: 'aiq-submission-packages',
        }).values,
      );
    }
    assert.equal(
      inspectSubmissionConfiguration({
        NODE_ENV: 'production',
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SECRET_KEY: secretKey,
        AIQ_RUNNER_SUBMISSION_TOKEN: runnerToken,
        AIQ_SUBMISSION_PACKAGE_BUCKET: 'aiq-submission-packages',
      }).values,
      undefined,
    );
  });
});

const routeScopes = [
  {
    name: 'submission',
    load: () => import('../app/api/submissions/route.ts'),
    required: [
      'SUPABASE_SECRET_KEY',
      'AIQ_RUNNER_SUBMISSION_TOKEN',
      'AIQ_SUBMISSION_PACKAGE_BUCKET',
    ],
    token: runnerToken,
  },
  {
    name: 'artifact upload',
    load: () => import('../app/api/artifacts/route.ts'),
    required: ['SUPABASE_SECRET_KEY', 'AIQ_RUNNER_SUBMISSION_TOKEN', 'AIQ_RUNNER_ARTIFACT_BUCKET'],
    token: runnerToken,
  },
  {
    name: 'speed observation',
    load: () => import('../app/api/observations/speed/route.ts'),
    required: ['SUPABASE_SECRET_KEY', 'AIQ_RUNNER_SUBMISSION_TOKEN', 'AIQ_RUNNER_ARTIFACT_BUCKET'],
    token: runnerToken,
  },
  {
    name: 'artifact resolution',
    load: () => import('../app/api/artifacts/resolve/route.ts'),
    required: [
      'SUPABASE_SECRET_KEY',
      'AIQ_VERIFIER_INGRESS_TOKEN',
      'AIQ_SUPABASE_PUBLISHABLE_KEY',
      'AIQ_SUPABASE_JWT_PRIVATE_JWK',
    ],
    token: verifierToken,
  },
  {
    name: 'verifier claim',
    load: () => import('../app/api/claims/route.ts'),
    required: [
      'SUPABASE_SECRET_KEY',
      'AIQ_VERIFIER_INGRESS_TOKEN',
      'AIQ_SUPABASE_PUBLISHABLE_KEY',
      'AIQ_SUPABASE_JWT_PRIVATE_JWK',
    ],
    token: verifierToken,
  },
  {
    name: 'verification',
    load: () => import('../app/api/verifications/route.ts'),
    required: [
      'AIQ_VERIFIER_INGRESS_TOKEN',
      'AIQ_SUPABASE_PUBLISHABLE_KEY',
      'AIQ_SUPABASE_JWT_PRIVATE_JWK',
      'AIQ_PUBLISHER_NODE_ID',
    ],
    token: verifierToken,
  },
] as const;

function invalidRequest(token: string): Request {
  return new Request('https://example.invalid/api', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{',
  });
}

for (const scope of routeScopes) {
  void it(`${scope.name} route accepts its own configuration and rejects requests before upstream access`, async (context) => {
    const originalEnvironment = process.env;
    context.after(() => {
      process.env = originalEnvironment;
    });
    const network = context.mock.method(globalThis, 'fetch', () => {
      throw new Error('Rejected requests must not reach Supabase.');
    });
    process.env = {
      ...common,
      ...Object.fromEntries(scope.required.map((key) => [key, validEnvironment[key]])),
    };
    const route = await scope.load();
    assert.equal((await route.POST(invalidRequest(scope.token))).status, 400);
    assert.equal((await route.POST(invalidRequest('wrong-token'))).status, 401);
    delete process.env[scope.required[0]];
    assert.equal((await route.POST(invalidRequest(scope.token))).status, 503);
    assert.equal(network.mock.callCount(), 0);
  });
}

void it('verification deployment permits its bounded long RPCs', async () => {
  const { maxDuration, runtime } = await import('../app/api/verifications/route.ts');
  assert.equal(maxDuration, 300);
  assert.equal(runtime, 'nodejs');
});
