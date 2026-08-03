import { generateKeyPairSync } from 'node:crypto';

import { defineConfig } from '@playwright/test';

import { resolvePlaywrightCompanionPort, resolvePlaywrightPort } from './playwright-port.ts';

const applicationPort = resolvePlaywrightPort(4_179, process.env.AIQ_PLAYWRIGHT_PORT);
const supabasePort = resolvePlaywrightCompanionPort(applicationPort);
const reuseExistingServer = process.env.AIQ_PLAYWRIGHT_REUSE_EXISTING_SERVER === '1';
const privateJwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
  format: 'jwk',
});
const privateJwkJson = JSON.stringify({
  ...privateJwk,
  alg: 'ES256',
  kid: 'live-published-test-key',
});

export default defineConfig({
  testDir: './browser-tests-live-published',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: 'list',
  outputDir: '/tmp/aiq-playwright-live-published-results',
  use: {
    baseURL: `http://127.0.0.1:${applicationPort}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    viewport: { width: 1_440, height: 900 },
  },
  webServer: [
    {
      command: `node browser-tests-live-published/mock-supabase.mjs ${supabasePort}`,
      reuseExistingServer,
      timeout: 30_000,
      url: `http://127.0.0.1:${supabasePort}/health`,
    },
    {
      command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${applicationPort}`,
      env: {
        AIQ_PUBLISHER_NODE_ID: `node_${'f'.repeat(64)}`,
        AIQ_RUNNER_ARTIFACT_BUCKET: 'private-artifacts',
        AIQ_RUNNER_SUBMISSION_TOKEN: 'live-published-runner-fixture',
        AIQ_SUBMISSION_PACKAGE_BUCKET: 'private-packages',
        AIQ_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_live_published_fixture',
        AIQ_SUPABASE_JWT_PRIVATE_JWK: privateJwkJson,
        AIQ_VERIFIER_INGRESS_TOKEN: 'live-published-verifier-fixture',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_live_published_fixture',
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
        NODE_ENV: 'test',
        SUPABASE_SECRET_KEY: 'sb_secret_live_published_service_fixture',
        SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      },
      reuseExistingServer,
      timeout: 120_000,
      url: `http://127.0.0.1:${applicationPort}`,
    },
  ],
});
