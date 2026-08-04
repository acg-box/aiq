import { defineConfig } from '@playwright/test';

import { resolveProductionOrigin } from './playwright-production-origin.ts';

const productionOrigin = resolveProductionOrigin(process.env.AIQ_PRODUCTION_ORIGIN);

export default defineConfig({
  testDir: './browser-tests-production',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: '/tmp/aiq-playwright-production-results',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: productionOrigin,
    browserName: 'chromium',
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    viewport: { width: 1_440, height: 900 },
  },
});
