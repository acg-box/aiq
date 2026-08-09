import { defineConfig } from '@playwright/test';

import { resolvePlaywrightPort } from './playwright-port.ts';
import { nextWebServerCommand } from './playwright-web-server.ts';

const port = resolvePlaywrightPort(4_176, process.env.AIQ_PLAYWRIGHT_PORT);
const reuseExistingServer = process.env.AIQ_PLAYWRIGHT_REUSE_EXISTING_SERVER === '1';

export default defineConfig({
  testDir: './browser-tests-missing',
  reporter: 'list',
  outputDir: '/tmp/aiq-playwright-missing-config-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: nextWebServerCommand(port),
    env: {
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
      NEXT_PUBLIC_SUPABASE_URL: '',
    },
    reuseExistingServer,
    timeout: 120_000,
    url: `http://127.0.0.1:${port}`,
  },
});
