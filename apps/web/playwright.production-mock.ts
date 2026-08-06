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
      benchmarkVersion: 'aiq-core@1.0.5',
      scoringVersion: '1.0.5',
      matrixBatchId: `run_${'b'.repeat(64)}`,
      runnerCommit: '4566388',
      corpusReleaseId: 'corpus_test-generated-aiq-core-1.0.5',
      corpusCommitment: 'sha256:f196b67599a7305473dba1054d8511c9bf60011c67fb2f58bb0f8706d04db612',
      catalogDigest: 'sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7',
      taskSetDigest: 'sha256:f6fc21fa2deb3788c186437c45f8e1c8d5d1e366d32bc81e3b5f847e9844cf05',
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
