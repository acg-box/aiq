import { defineConfig } from '@playwright/test';

import { resolvePlaywrightPort } from './playwright-port.ts';

const port = resolvePlaywrightPort(4_173, process.env.AIQ_PLAYWRIGHT_PORT);
const reuseExistingServer = process.env.AIQ_PLAYWRIGHT_REUSE_EXISTING_SERVER === '1';

export default defineConfig({
  testDir: './browser-tests',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: 'list',
  outputDir: '/tmp/aiq-playwright-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1_440, height: 900 },
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'desktop-firefox',
      use: {
        browserName: 'firefox',
        viewport: { width: 1_366, height: 768 },
      },
    },
    {
      name: 'tablet-webkit',
      use: {
        browserName: 'webkit',
        viewport: { width: 1_024, height: 768 },
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`,
    env: {
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
      NEXT_PUBLIC_SUPABASE_URL: '',
      NODE_ENV: 'test',
    },
    reuseExistingServer,
    timeout: 120_000,
    url: `http://127.0.0.1:${port}`,
  },
});
