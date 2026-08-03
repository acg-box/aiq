import { defineConfig } from '@playwright/test';

import { resolvePlaywrightCompanionPort, resolvePlaywrightPort } from './playwright-port.ts';

const applicationPort = resolvePlaywrightPort(4_177, process.env.AIQ_PLAYWRIGHT_PORT);
const supabasePort = resolvePlaywrightCompanionPort(applicationPort);
const reuseExistingServer = process.env.AIQ_PLAYWRIGHT_REUSE_EXISTING_SERVER === '1';

export default defineConfig({
  testDir: './browser-tests-live-empty',
  reporter: 'list',
  outputDir: '/tmp/aiq-playwright-live-empty-results',
  use: {
    baseURL: `http://127.0.0.1:${applicationPort}`,
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
  },
  webServer: [
    {
      command: `node browser-tests-live-empty/mock-supabase.mjs ${supabasePort}`,
      reuseExistingServer,
      timeout: 30_000,
      url: `http://127.0.0.1:${supabasePort}/health`,
    },
    {
      command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${applicationPort}`,
      env: {
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_live_empty_fixture',
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
        // The server still uses next build/start. Test mode only authorizes this loopback fixture.
        // The complete public pair selects live data, not seed data.
        NODE_ENV: 'test',
      },
      reuseExistingServer,
      timeout: 120_000,
      url: `http://127.0.0.1:${applicationPort}`,
    },
  ],
});
