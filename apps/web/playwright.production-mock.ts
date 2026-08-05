import { defineConfig } from '@playwright/test';

import livePublishedConfig from './playwright.live-published.ts';

const livePublishedServers = Array.isArray(livePublishedConfig.webServer)
  ? livePublishedConfig.webServer
  : livePublishedConfig.webServer
    ? [livePublishedConfig.webServer]
    : [];
const productionContractServers = [...livePublishedServers];
const mockServer = productionContractServers[0];
if (mockServer) {
  productionContractServers[0] = {
    ...mockServer,
    env: {
      ...mockServer.env,
      AIQ_MOCK_EMPTY_CALIBRATION_EVIDENCE: '1',
    },
  };
}

export default defineConfig({
  ...livePublishedConfig,
  testDir: './browser-tests-production',
  outputDir: '/tmp/aiq-playwright-production-contract-results',
  workers: 1,
  metadata: {
    productionEvidenceVariants: true,
    productionExpectedIdentity: {
      benchmarkVersion: 'aiq-core@1.0.2',
      scoringVersion: '1.0.2',
      matrixBatchId: `run_${'b'.repeat(64)}`,
      runnerCommit: '7a0c4d1',
      corpusReleaseId: 'corpus_2026.08.02-aiq-core-1.0.2-controlled.1',
      corpusCommitment: 'sha256:5b8cfddaacefcd58274b880815fd3f955bd319396755d041f2f30d000555624f',
      catalogDigest: 'sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937',
      taskSetDigest: 'sha256:d5463bf713a83d07fdb43c2bf16093779096bcdeb17682ca68952060d71b7e10',
      promptSetDigest: 'sha256:a6aead1a94c0e6dc6e9f80fe2057ab46c60fa9ce287e8db1c6000f8000541105',
      estimatedCostResultCount: 1_208,
      unavailableContextBandResultCount: 10,
      unavailableMissingUsageResultCount: 6,
      pricedCostSubtotalUsdNanos: '12710708200',
    },
  },
  webServer: productionContractServers,
  use: {
    ...livePublishedConfig.use,
    serviceWorkers: 'block',
  },
});
