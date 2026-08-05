import { defineConfig } from '@playwright/test';

import { resolveProductionExpectedIdentity } from './playwright-production-identity.ts';
import { resolveProductionOrigin } from './playwright-production-origin.ts';

const productionOrigin = resolveProductionOrigin(process.env.AIQ_PRODUCTION_ORIGIN);
const productionExpectedIdentity = resolveProductionExpectedIdentity(process.env);

export default defineConfig({
  testDir: './browser-tests-production',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  metadata: { productionExpectedIdentity },
  outputDir: '/tmp/aiq-playwright-production-results',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: productionOrigin,
    browserName: 'chromium',
    navigationTimeout: 60_000,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    viewport: { width: 1_440, height: 900 },
  },
});
