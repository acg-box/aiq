import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  inspectArtifactIngressConfiguration,
  inspectProductionConfiguration,
  inspectSubmissionConfiguration,
  inspectVerificationConfiguration,
  inspectVerifierClaimConfiguration,
} from './production-configuration.ts';

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

  void it('guards every privileged route with its exact inspector before client construction', async () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    const routes = new Map([
      ['apps/web/src/app/api/submissions/route.ts', 'inspectSubmissionConfiguration(process.env)'],
      [
        'apps/web/src/app/api/artifacts/route.ts',
        'inspectArtifactIngressConfiguration(process.env)',
      ],
      [
        'apps/web/src/app/api/observations/speed/route.ts',
        'inspectArtifactIngressConfiguration(process.env)',
      ],
      [
        'apps/web/src/app/api/artifacts/resolve/route.ts',
        'inspectVerifierClaimConfiguration(process.env)',
      ],
      ['apps/web/src/app/api/claims/route.ts', 'inspectVerifierClaimConfiguration(process.env)'],
      [
        'apps/web/src/app/api/verifications/route.ts',
        'inspectVerificationConfiguration(process.env)',
      ],
    ]);
    const routeSources = await Promise.all(
      [...routes].map(async ([route, inspector]) => ({
        inspector,
        route,
        source: await readFile(resolve(repositoryRoot, route), 'utf8'),
      })),
    );
    for (const { inspector, route, source } of routeSources) {
      const guard = source.indexOf(inspector);
      const client = source.indexOf('createClient(');
      assert.ok(guard >= 0, `${route} must use its route-scoped inspector`);
      assert.ok(client > guard, `${route} must validate before constructing a client`);
    }
  });

  void it('keeps the long verification route server-only and within the Hobby duration limit', async () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    const [source, claimsSource, artifactResolveSource, handlerSource] = await Promise.all([
      readFile(resolve(repositoryRoot, 'apps/web/src/app/api/verifications/route.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'apps/web/src/app/api/claims/route.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'apps/web/src/app/api/artifacts/resolve/route.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'apps/web/src/server/verification-handler.ts'), 'utf8'),
    ]);

    assert.match(source, /import 'server-only';/);
    assert.match(source, /export const maxDuration = 300;/);
    assert.match(source, /verificationRpcRoleClientOptions/);
    assert.doesNotMatch(claimsSource, /verificationRpcRoleClientOptions/);
    assert.doesNotMatch(artifactResolveSource, /verificationRpcRoleClientOptions/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_(?:AIQ|SUPABASE)_(?:VERIFIER|PUBLISHER|SECRET|JWT)/);
    assert.match(
      handlerSource,
      /global: \{ fetch: createVerificationSupabaseFetch\(parentSignal\) \}/,
    );
  });
});
