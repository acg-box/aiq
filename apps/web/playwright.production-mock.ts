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
      catalogDigest: 'sha256:6dc43022b04333de889abc08de118d63652aeab6ee2c3b8610905a2faa91e460',
      taskSetDigest: 'sha256:54c7026ac723a2e932b01fe8bf6557c226d1a658c7f87ab9fc4645c88bdd7766',
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
