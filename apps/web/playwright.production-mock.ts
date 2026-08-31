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
      corpusReleaseId: 'corpus_test-generated-aiq-core-1.1.0',
      corpusCommitment: 'sha256:f196b67599a7305473dba1054d8511c9bf60011c67fb2f58bb0f8706d04db612',
      catalogDigest: 'sha256:c00b278d0edbdcd3c45cd0d4f21bd9a1b31a40d97acc47253373cd4228c953fb',
      taskSetDigest: 'sha256:c7481e46c64dbf5ff9f50a85c83608d48390a03cbf9e94a1d89ab36aeb6df89a',
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
