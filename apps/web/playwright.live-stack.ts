import { defineConfig } from '@playwright/test';

import { resolvePlaywrightCompanionPort, resolvePlaywrightPort } from './playwright-port.ts';

const applicationPort = resolvePlaywrightPort(4_181, process.env.AIQ_PLAYWRIGHT_PORT);
const proxyPort = resolvePlaywrightCompanionPort(applicationPort);
const postgrestUrl = process.env.AIQ_LIVE_POSTGREST_URL;
const publicKey = 'sb_publishable_local_validation';

if (postgrestUrl === undefined) {
  throw new Error('AIQ_LIVE_POSTGREST_URL is required.');
}

const parsedUrl = new URL(postgrestUrl);
if (
  parsedUrl.origin !== postgrestUrl ||
  parsedUrl.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(parsedUrl.hostname)
) {
  throw new Error('AIQ_LIVE_POSTGREST_URL must be one canonical loopback HTTP origin.');
}

export default defineConfig({
  testDir: './browser-tests-live-empty',
  reporter: 'list',
  outputDir: '/tmp/aiq-playwright-live-stack-results',
  use: {
    baseURL: `http://127.0.0.1:${applicationPort}`,
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
  },
  webServer: [
    {
      command: `node browser-tests-live-stack/supabase-rest-proxy.mjs ${proxyPort} ${postgrestUrl}`,
      reuseExistingServer: false,
      timeout: 30_000,
      url: `http://127.0.0.1:${proxyPort}/health`,
    },
    {
      command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${applicationPort}`,
      env: {
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${proxyPort}`,
        NODE_ENV: 'test',
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `http://127.0.0.1:${applicationPort}`,
    },
  ],
});
