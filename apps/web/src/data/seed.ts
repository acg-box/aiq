import type {
  BenchmarkRun,
  Methodology,
  ModelFamily,
  RadarNode,
  ReasoningTier,
  ScoredLeaderboardEntry,
  TaskResult,
  TrendPoint,
} from './types.ts';
import { AIQ_CORE_BENCHMARK_VERSION, AIQ_CORE_SCORING_VERSION } from '../aiq-core-contract.ts';

export const benchmarkDomainConfig = [
  { domain: 'coding', taskCount: 8 },
  { domain: 'debugging', taskCount: 8 },
  { domain: 'repository_understanding', taskCount: 7 },
  { domain: 'data_processing', taskCount: 8 },
  { domain: 'retrieval_verification', taskCount: 7 },
  { domain: 'documentation_communication', taskCount: 7 },
  { domain: 'planning_execution', taskCount: 7 },
  { domain: 'tool_use', taskCount: 7 },
  { domain: 'instruction_following', taskCount: 6 },
  { domain: 'reliability_recovery', taskCount: 7 },
] as const;

const modelConfig: ReadonlyArray<{
  family: ModelFamily;
  modelName: string;
  tiers: readonly ReasoningTier[];
  base: number;
}> = [
  {
    family: 'Sol',
    modelName: 'gpt-5.6-sol',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    base: 66.1,
  },
  {
    family: 'Terra',
    modelName: 'gpt-5.6-terra',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    base: 63.2,
  },
  {
    family: 'Luna',
    modelName: 'gpt-5.6-luna',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max'],
    base: 61.4,
  },
];

function wilsonInterval(successes: number, sampleSize: number): readonly [number, number] {
  if (sampleSize === 0) return [0, 1];
  const z = 1.959963984540054;
  const proportion = successes / sampleSize;
  const denominator = 1 + (z * z) / sampleSize;
  const center = proportion + (z * z) / (2 * sampleSize);
  const margin =
    z *
    Math.sqrt(
      (proportion * (1 - proportion)) / sampleSize + (z * z) / (4 * sampleSize * sampleSize),
    );
  return [(center - margin) / denominator, (center + margin) / denominator];
}

function syntheticStrictPasses(qualityScore: number, runtimeIssues: number): number {
  return benchmarkDomainConfig.reduce(
    (total, domain, domainIndex) =>
      total +
      Math.min(
        Math.floor((qualityScore / 100) * domain.taskCount),
        domain.taskCount - (domainIndex < runtimeIssues ? 1 : 0),
      ),
    0,
  );
}

const seedLeaderboardBase = modelConfig
  .flatMap((model, familyIndex) =>
    model.tiers.map((reasoningTier, tierIndex) => {
      const score = Number((model.base + tierIndex * 3.45 - familyIndex * 0.06).toFixed(1));
      const runtimeIssues = 0;
      const strictPassSuccesses = syntheticStrictPasses(score, runtimeIssues);
      const strictPassRate = strictPassSuccesses / 72;
      const [strictPassLow, strictPassHigh] = wilsonInterval(strictPassSuccesses, 72);
      return {
        id: `${model.family.toLowerCase()}-${reasoningTier}`,
        modelFamily: model.family,
        modelName: model.modelName,
        reasoningTier,
        score,
        theta: null,
        standardError: null,
        thetaCiLow: null,
        thetaCiHigh: null,
        scoreCiLow: null,
        scoreCiHigh: null,
        information: null,
        qualityScore: score,
        strictPassRate,
        strictPassLow,
        strictPassHigh,
        strictPassSampleSize: 72,
        strictPassSuccesses,
        reliabilityStatus: 'not_estimated' as const,
        calibrationStatus: 'not_applicable' as const,
        sensitivityLow: Number((score - 2.1 - familyIndex * 0.1).toFixed(1)),
        sensitivityHigh: Number((score + 2.1 + familyIndex * 0.1).toFixed(1)),
        sampleSize: 72,
        coveragePercent: 100,
        runtimeIssues,
        missing: 0,
        scoringVersion: AIQ_CORE_SCORING_VERSION,
        scoreStatus: 'synthetic_complete' as const,
        synthetic: true as const,
      };
    }),
  )
  .toSorted((left, right) => right.qualityScore - left.qualityScore);

export const seedLeaderboard: readonly ScoredLeaderboardEntry[] = seedLeaderboardBase.map(
  (entry, index): ScoredLeaderboardEntry =>
    Object.assign({}, entry, {
      runId: `run-2026-07-${String(22 - (index % 17)).padStart(2, '0')}-${entry.id}`,
    }),
);

const trendEntryIds = ['sol-ultra', 'sol-high', 'terra-ultra', 'terra-high', 'luna-max'];
const monthOffsets = [0, 1, 3, 7, 14, 31, 62, 92, 123, 184, 245, 306, 367];

export const seedTrendPoints: readonly TrendPoint[] = trendEntryIds.flatMap(
  (entryId, entryIndex) => {
    const entry = seedLeaderboard.find((candidate) => candidate.id === entryId);
    if (!entry) {
      return [];
    }
    return monthOffsets.map((daysAgo, pointIndex) => {
      const recordedAt = new Date(Date.UTC(2026, 6, 24 - daysAgo, 12));
      const drift = (pointIndex - 6) * 0.21 + Math.sin(pointIndex + entryIndex) * 0.65;
      return {
        entryId,
        runId: null,
        scoringVersion: AIQ_CORE_SCORING_VERSION,
        recordedAt: recordedAt.toISOString(),
        bucketStartedAt: recordedAt.toISOString(),
        bucketEndedAt: new Date(recordedAt.getTime() + 1).toISOString(),
        score: Number((entry.qualityScore + drift).toFixed(1)),
        theta: null,
        standardError: null,
        thetaCiLow: null,
        thetaCiHigh: null,
        scoreCiLow: null,
        scoreCiHigh: null,
        information: null,
        qualityScore: Number((entry.qualityScore + drift).toFixed(1)),
        strictPassRate: entry.strictPassRate,
        strictPassLow: entry.strictPassLow,
        strictPassHigh: entry.strictPassHigh,
        strictPassSampleSize: entry.strictPassSampleSize,
        strictPassSuccesses: entry.strictPassSuccesses,
        reliabilityStatus: 'not_estimated',
        calibrationStatus: 'not_applicable',
        sensitivityLow: Number((entry.sensitivityLow + drift).toFixed(1)),
        sensitivityHigh: Number((entry.sensitivityHigh + drift).toFixed(1)),
        sampleSize: 72,
        representedRunCount: 1,
        resolutionSeconds: 0,
        synthetic: true,
      };
    });
  },
);

const toolSets = [
  ['shell', 'test runner'],
  ['repository search'],
  ['browser'],
  ['structured data tool'],
  ['retrieval tool'],
] as const;
const failureCodes = ['AGENT_TIMEOUT', 'MODEL_TIMEOUT', 'TOOL_TIMEOUT'] as const;
const syntheticUnavailableEfficiency = {
  agentSteps: 0,
  toolCallCount: 0,
  toolCallsByType: {},
  latencyMs: null,
  latencyEvidenceLevel: null,
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  totalTokens: null,
  tokenUsageSourceLevel: null,
  tokenUsageEvidenceLevel: null,
  standardApiEquivalentUsdNanos: null,
  costEstimatorStatus: 'unavailable_missing_usage',
  costEvidenceLevel: null,
} as const;

function buildSyntheticCompleteTasks(
  entry: ScoredLeaderboardEntry,
  entryIndex: number,
): readonly TaskResult[] {
  let globalIndex = 0;
  return benchmarkDomainConfig.flatMap((domain, domainIndex) => {
    const domainHasFailure = domainIndex < entry.runtimeIssues;
    const domainTarget = (entry.qualityScore / 100) * domain.taskCount;
    const strictPassTarget = Math.min(
      Math.floor(domainTarget),
      domain.taskCount - (domainHasFailure ? 1 : 0),
    );
    const partialTaskCount = domain.taskCount - (domainHasFailure ? 1 : 0) - strictPassTarget;
    const partialScore =
      partialTaskCount === 0
        ? 0
        : Number(((domainTarget - strictPassTarget) / partialTaskCount).toFixed(4));
    let nonFailureIndex = 0;
    return Array.from({ length: domain.taskCount }, (_, taskIndex): TaskResult => {
      const currentIndex = globalIndex;
      globalIndex += 1;
      const isFailure =
        domainHasFailure && taskIndex === (entryIndex + domainIndex) % domain.taskCount;
      const failureCode =
        failureCodes[(entryIndex + domainIndex) % failureCodes.length] ?? 'AGENT_TIMEOUT';
      const tools = toolSets[(currentIndex + entryIndex) % toolSets.length] ?? [];
      const isStrictPass = !isFailure && nonFailureIndex < strictPassTarget;
      if (!isFailure) {
        nonFailureIndex += 1;
      }
      const score = isFailure ? null : isStrictPass ? 1 : Number(partialScore.toFixed(4));
      return {
        id: `aiq-2-${domain.domain}-${String(taskIndex + 1).padStart(2, '0')}-${entry.id}`,
        task: `${domain.domain.replaceAll('_', ' ')} fixture ${taskIndex + 1}`,
        domain: domain.domain,
        outcome: isFailure
          ? 'timeout'
          : score === 1
            ? 'correct'
            : (score ?? 0) > 0
              ? 'partial'
              : 'incorrect',
        executionStatus: isFailure ? 'runtime_issue' : 'completed',
        score,
        explanation: isFailure
          ? {
              code: failureCode,
              summary: `${failureCode.replaceAll('_', ' ').toLowerCase()} ended the task attempt. AIQ excludes runtime failures from semantic scores.`,
              retryable: false,
            }
          : null,
        tools: [...tools],
        ...syntheticUnavailableEfficiency,
      };
    });
  });
}

function buildCoverageOnlyTasks(): readonly TaskResult[] {
  let globalIndex = 0;
  return benchmarkDomainConfig.flatMap((domain) =>
    Array.from({ length: domain.taskCount }, (_, taskIndex): TaskResult => {
      const currentIndex = globalIndex;
      globalIndex += 1;
      const isMissing = currentIndex % 5 === 2;
      const isFailed = currentIndex === 9 || currentIndex === 44;
      const tools = toolSets[currentIndex % toolSets.length] ?? [];
      return {
        id: `aiq-v1-${domain.domain}-${String(taskIndex + 1).padStart(2, '0')}-coverage-only`,
        task: `${domain.domain.replaceAll('_', ' ')} fixture ${taskIndex + 1}`,
        domain: domain.domain,
        outcome: isMissing ? 'missing' : isFailed ? 'timeout' : 'partial',
        executionStatus: isMissing ? 'missing' : isFailed ? 'runtime_issue' : 'completed',
        score: isMissing || isFailed ? null : 0.72,
        explanation: isMissing
          ? {
              code: 'RESULT_NOT_RECEIVED',
              summary:
                'The result package did not contain this task result. The fixed denominator remains unchanged.',
              retryable: true,
            }
          : isFailed
            ? {
                code: 'TOOL_TIMEOUT',
                summary:
                  'The tool timed out during the task attempt. AIQ excludes runtime failures from semantic scores.',
                retryable: false,
              }
            : null,
        tools: [...tools],
        ...syntheticUnavailableEfficiency,
      };
    }),
  );
}

const syntheticCompleteRuns: readonly BenchmarkRun[] = seedLeaderboard.map((entry, index) => ({
  id: entry.runId ?? `run-missing-${entry.id}`,
  entryId: entry.id,
  startedAt: `2026-07-${String(22 - (index % 17)).padStart(2, '0')}T13:00:00.000Z`,
  completedAt: `2026-07-${String(22 - (index % 17)).padStart(2, '0')}T13:24:42.000Z`,
  benchmarkVersion: AIQ_CORE_BENCHMARK_VERSION,
  scoringVersion: AIQ_CORE_SCORING_VERSION,
  promptSetDigest: 'sha256:8469b5a3f084…c21a',
  runnerCommit: 'a7d91f4',
  region: 'us-east-1',
  synthetic: true,
  corpusReleaseId: null,
  corpusCommitmentSha256: null,
  catalogDigest: null,
  taskSetDigest: null,
  preflightDigest: null,
  runtimeDigest: null,
  runClass: null,
  permissionEvidenceDigest: null,
  tasks: [...buildSyntheticCompleteTasks(entry, index)],
}));

export const seedRuns: readonly BenchmarkRun[] = [
  ...syntheticCompleteRuns,
  {
    id: 'run-2026-07-05-coverage-only-sol-ultra',
    entryId: 'sol-ultra',
    startedAt: '2026-07-05T13:00:00.000Z',
    completedAt: '2026-07-05T13:29:10.000Z',
    benchmarkVersion: AIQ_CORE_BENCHMARK_VERSION,
    scoringVersion: AIQ_CORE_SCORING_VERSION,
    promptSetDigest: 'sha256:8469b5a3f084…c21a',
    runnerCommit: 'a7d91f4',
    region: 'us-east-1',
    synthetic: true,
    corpusReleaseId: null,
    corpusCommitmentSha256: null,
    catalogDigest: null,
    taskSetDigest: null,
    preflightDigest: null,
    runtimeDigest: null,
    runClass: null,
    permissionEvidenceDigest: null,
    tasks: [...buildCoverageOnlyTasks()],
  },
];

export const seedMethodology: Methodology = {
  benchmarkVersion: AIQ_CORE_BENCHMARK_VERSION,
  scoringVersion: AIQ_CORE_SCORING_VERSION,
  publishedAt: '2026-07-22T16:00:00.000Z',
  domainWeights: benchmarkDomainConfig.map((domain) => ({
    domain: domain.domain,
    weight: 0.1,
    taskCount: domain.taskCount,
  })),
  principles: [
    'Estimate a one-dimensional latent ability on the committed AIQ Core fixed-fixture set. Do not claim general intelligence or a population IQ norm.',
    'For non-synthetic Official evidence, jointly estimate model locations and one Rasch task difficulty per task from the complete 17-configuration matrix with weak priors on a centered item scale. The published theta interval is conditional on that released item bank.',
    'Publish 100 × logistic(theta) as the calibrated average-task ability score. Keep the raw equal-domain fixed-fixture mean as a separate quality diagnostic.',
    'Strict pass rate is strict successes divided by every attributable task with a semantic task score. Partial scores are non-passes in the denominator; missing, infrastructure-invalid, and unscored tasks are excluded. Wilson bounds use the same denominator.',
    'Keep hidden fixture payloads behind the commitment boundary. Publish versions, counts, outcomes, and provenance.',
    'Do not fabricate or substitute work when a required capability is unavailable.',
  ],
  missingPolicy:
    'Missing and invalid results block Official and remain in completion accounting. A complete synthetic fixture is descriptive, never Official, and not ranked. A Provisional point estimate averages valid observed tasks within each domain; fixed-fixture completion bounds retain every planned task and assign unobserved tasks zero or one. Provisional requires at least 60 results and at least 4 in every domain, and is not ranked.',
  failurePolicy:
    'Only completed semantic correct, partial, and incorrect outcomes contribute a task score. Runtime failures have no semantic score and remain visible as runtime issues. Invalid infrastructure attempts are audited and rerun. A whole configuration can be N/A only when preflight proves it unavailable.',
  sensitivityPolicy:
    'The canonical fixed-fixture sensitivity interval draws committed clusters with replacement inside each domain, includes all task scores in each drawn cluster, and recomputes the raw equal-domain diagnostic. It expands each raw 95-percentile deviation from the observed fixture score by the versioned 1.3 correction and clamps the endpoints to 0 through 100. It is not a universal confidence interval for model capability. Latent standard error is conditional on the frozen calibration bank.',
  synthetic: true,
};

export const seedRadarNodes: readonly RadarNode[] = [
  {
    id: 'node_33518601c2f58e370fd02c26a1a3dc8172285fb40231393d3aa735608d5fe633',
    name: 'Atlas / IAD',
    operator: 'official',
    publicKeyFingerprint: 'sha256:33518601c2f58e370fd02c26a1a3dc8172285fb40231393d3aa735608d5fe633',
    registryTrust: 'unverified',
    registryStatus: 'active',
    registryLastSeenAt: '2026-07-24T14:58:00.000Z',
    latestCapability: {
      schemaVersion: 'aiq.distributed-capability.v1',
      contentHash: `sha256:${'4'.repeat(64)}`,
      status: 'declared',
      signatureStatus: 'unverified',
      observedAt: '2026-07-24T14:01:00.000Z',
    },
    latestObservation: {
      schemaVersion: 'aiq.distributed-observation.v1',
      state: 'ready',
      sequence: 1,
      contentHash: `sha256:${'9'.repeat(64)}`,
      recordStatus: 'observed',
      signatureStatus: 'unverified',
      observedAt: '2026-07-24T14:04:00.000Z',
      provenanceHash: `sha256:${'a'.repeat(64)}`,
    },
    assignmentCounts: {
      total: 3,
      offered: 1,
      accepted: 1,
      running: 1,
      completed: 0,
      revoked: 0,
      expired: 0,
    },
    receiptCounts: { total: 1, received: 1, accepted: 0, rejected: 0 },
    aggregation: {
      receiverVerifiedTrusted: 0,
      signedUntrusted: 1,
      rejected: 0,
      missing: 0,
      aggregatedAt: '2026-07-24T14:30:00.000Z',
    },
    synthetic: true,
  },
  {
    id: 'node_eee08e5881ce3843a8a5002a2391accbf897a06049889cb691730eda20b18cf0',
    name: 'Kepler / FRA',
    operator: 'verifier',
    publicKeyFingerprint: 'sha256:eee08e5881ce3843a8a5002a2391accbf897a06049889cb691730eda20b18cf0',
    registryTrust: 'unverified',
    registryStatus: 'degraded',
    registryLastSeenAt: '2026-07-24T14:46:00.000Z',
    latestCapability: {
      schemaVersion: 'aiq.distributed-capability.v1',
      contentHash: `sha256:${'6'.repeat(64)}`,
      status: 'rejected',
      signatureStatus: 'rejected',
      observedAt: '2026-07-24T14:02:00.000Z',
    },
    latestObservation: {
      schemaVersion: 'aiq.distributed-observation.v1',
      state: 'busy',
      sequence: 1,
      contentHash: `sha256:${'b'.repeat(64)}`,
      recordStatus: 'rejected',
      signatureStatus: 'rejected',
      observedAt: '2026-07-24T14:05:00.000Z',
      provenanceHash: `sha256:${'c'.repeat(64)}`,
    },
    assignmentCounts: {
      total: 2,
      offered: 0,
      accepted: 0,
      running: 0,
      completed: 1,
      revoked: 1,
      expired: 0,
    },
    receiptCounts: { total: 2, received: 0, accepted: 1, rejected: 1 },
    aggregation: {
      receiverVerifiedTrusted: 0,
      signedUntrusted: 1,
      rejected: 1,
      missing: 0,
      aggregatedAt: '2026-07-24T14:32:00.000Z',
    },
    synthetic: true,
  },
  {
    id: 'node_bd09f64ce3b8a251a9e7c1d8587b39fb296edb68981e0bc92a279d0bff85cfdf',
    name: 'Nomad / unknown',
    operator: 'community',
    publicKeyFingerprint: 'sha256:bd09f64ce3b8a251a9e7c1d8587b39fb296edb68981e0bc92a279d0bff85cfdf',
    registryTrust: 'unverified',
    registryStatus: 'offline',
    registryLastSeenAt: '2026-07-23T08:12:00.000Z',
    latestCapability: {
      schemaVersion: 'aiq.distributed-capability.v1',
      contentHash: `sha256:${'8'.repeat(64)}`,
      status: 'declared',
      signatureStatus: 'unverified',
      observedAt: '2026-07-24T14:03:00.000Z',
    },
    latestObservation: {
      schemaVersion: 'aiq.distributed-observation.v1',
      state: 'offline',
      sequence: 1,
      contentHash: `sha256:${'d'.repeat(64)}`,
      recordStatus: 'stale',
      signatureStatus: 'unverified',
      observedAt: '2026-07-24T14:06:00.000Z',
      provenanceHash: `sha256:${'e'.repeat(64)}`,
    },
    assignmentCounts: {
      total: 1,
      offered: 0,
      accepted: 0,
      running: 0,
      completed: 0,
      revoked: 0,
      expired: 1,
    },
    receiptCounts: { total: 0, received: 0, accepted: 0, rejected: 0 },
    aggregation: {
      receiverVerifiedTrusted: 0,
      signedUntrusted: 0,
      rejected: 0,
      missing: 1,
      aggregatedAt: '2026-07-24T14:33:00.000Z',
    },
    synthetic: true,
  },
];
