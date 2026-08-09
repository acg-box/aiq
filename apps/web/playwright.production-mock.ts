import { defineConfig } from '@playwright/test';

import livePublishedConfig from './playwright.live-published.ts';
import { AIQ_CORE_BENCHMARK_VERSION, AIQ_CORE_SCORING_VERSION } from './src/aiq-core-contract.ts';

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
      benchmarkVersion: AIQ_CORE_BENCHMARK_VERSION,
      scoringVersion: AIQ_CORE_SCORING_VERSION,
      matrixBatchId: `run_${'b'.repeat(64)}`,
      runnerCommit: 'b76148cd419ab4ebb491cdb9f6a00555059eab67',
      corpusReleaseId: 'corpus_test-generated-aiq-core-1.0.7',
      corpusCommitment: 'sha256:f196b67599a7305473dba1054d8511c9bf60011c67fb2f58bb0f8706d04db612',
      catalogDigest: 'sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1',
      taskSetDigest: 'sha256:777dc72d782a274e654bc8fa61479908c244675b148755fb36bb2c28a89acd72',
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
