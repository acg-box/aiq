import { defineConfig } from '@playwright/test';

import livePublishedConfig from './playwright.live-published.ts';

export default defineConfig({
  ...livePublishedConfig,
  testDir: './browser-tests-production',
  outputDir: '/tmp/aiq-playwright-production-contract-results',
  workers: 1,
  metadata: { productionEvidenceVariants: true },
  use: {
    ...livePublishedConfig.use,
    serviceWorkers: 'block',
  },
});
