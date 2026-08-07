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
      benchmarkVersion: 'aiq-core@1.0.6',
      scoringVersion: '1.0.6',
      matrixBatchId: `run_${'b'.repeat(64)}`,
      runnerCommit: 'b76148cd419ab4ebb491cdb9f6a00555059eab67',
      corpusReleaseId: 'corpus_test-generated-aiq-core-1.0.6',
      corpusCommitment: 'sha256:f196b67599a7305473dba1054d8511c9bf60011c67fb2f58bb0f8706d04db612',
      catalogDigest: 'sha256:7548f78c0b4bae156e3c8ab257688dffd176b26234d0f7a52cb06a568f8c4ad1',
      taskSetDigest: 'sha256:b3a11e8801310b6c07318ba0a39a9d31ca9f41e88e53295876a940873e333b82',
      promptSetDigest: `sha256:${'2'.repeat(64)}`,
      estimatedCostResultCount: 1_208,
      unavailableContextBandResultCount: 10,
      unavailableMissingUsageResultCount: 6,
      pricedCostSubtotalUsdNanos: '12770603200',
    },
  },
  webServer: productionContractServers,
  use: {
    ...livePublishedConfig.use,
    serviceWorkers: 'block',
  },
});
