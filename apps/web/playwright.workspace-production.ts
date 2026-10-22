import { defineConfig } from '@playwright/test';
import { resolveProductionOrigin } from './playwright-production-origin.ts';

export default defineConfig({
  testDir: './browser-tests-workspace-production',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  outputDir: '/tmp/aiq-workspace-production-results',
  use: {
    baseURL: resolveProductionOrigin(process.env.AIQ_PRODUCTION_ORIGIN),
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    navigationTimeout: 60_000,
    browserName: 'chromium',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
});
