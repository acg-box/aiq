import type { PublicDataConfiguration } from './public-configuration.ts';

export type ReasoningTier = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ModelFamily = 'Sol' | 'Terra' | 'Luna';
export type RunStatus = 'passed' | 'failed' | 'invalid' | 'missing' | 'not_applicable';
export type CalibrationModelFamily = 'sol' | 'terra' | 'luna';
export const CALIBRATION_OUTCOMES = [
  'correct',
  'partial',
  'incorrect',
  'timeout',
  'budget_exhausted',
  'tool_failure',
  'policy_failure',
  'wrong_artifact',
  'invalid',
  'missing',
  'not_applicable',
] as const;
export type CalibrationOutcome = (typeof CALIBRATION_OUTCOMES)[number];
export type LeaderboardStatus =
  | 'official'
  | 'synthetic_complete'
  | 'not_applicable'
  | 'missing'
  | 'unpublished';
export type TrustLevel =
  | 'unverified'
  | 'signed_community'
  | 'trusted_verified'
  | 'independently_reproduced';
export type RegistryStatus = 'pending' | 'active' | 'degraded' | 'offline' | 'revoked';
export type SignatureStatus = 'unverified' | 'verified' | 'rejected';
export type CapabilityRecordStatus = 'declared' | 'validated' | 'rejected' | 'expired';
export type ObservationState = 'ready' | 'busy' | 'draining' | 'degraded' | 'offline';
export type ObservationRecordStatus = 'observed' | 'accepted' | 'rejected' | 'stale';
export type TrendRange = 'day' | 'week' | 'month' | 'all';

export interface LeaderboardEntry {
  id: string;
  modelFamily: ModelFamily;
  modelName: string;
  reasoningTier: ReasoningTier;
  score: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  sampleSize: number | null;
  coveragePercent: number | null;
  failures: number | null;
  missing: number | null;
  scoringVersion: string | null;
  scoreStatus: LeaderboardStatus;
  runId: string | null;
  synthetic: boolean | null;
}

type ScoredLeaderboardValues = LeaderboardEntry & {
  score: number;
  ciLow: number;
  ciHigh: number;
  sampleSize: number;
  coveragePercent: number;
  failures: number;
  missing: number;
  scoringVersion: string;
  runId: string;
};

export type ScoredLeaderboardEntry = ScoredLeaderboardValues &
  (
    | { scoreStatus: 'official'; synthetic: false }
    | { scoreStatus: 'synthetic_complete'; synthetic: true }
  );

export function isScoredLeaderboardEntry(entry: LeaderboardEntry): entry is ScoredLeaderboardEntry {
  return (
    (entry.scoreStatus === 'official' || entry.scoreStatus === 'synthetic_complete') &&
    entry.score !== null &&
    entry.ciLow !== null &&
    entry.ciHigh !== null &&
    entry.sampleSize !== null &&
    entry.coveragePercent !== null &&
    entry.failures !== null &&
    entry.missing !== null &&
    entry.scoringVersion !== null &&
    entry.runId !== null &&
    ((entry.scoreStatus === 'official' && entry.synthetic === false) ||
      (entry.scoreStatus === 'synthetic_complete' && entry.synthetic === true))
  );
}

export interface TrendPoint {
  entryId: string;
  runId: string | null;
  recordedAt: string;
  bucketStartedAt: string;
  bucketEndedAt: string;
  score: number;
  ciLow: number;
  ciHigh: number;
  sampleSize: number;
  representedRunCount: number;
  resolutionSeconds: number;
  synthetic: boolean;
}

export interface TaskResult {
  id: string;
  task: string;
  domain: string;
  status: RunStatus;
  score: number | null;
  explanation: {
    code: string;
    summary: string;
    retryable: boolean;
  } | null;
  tools: string[];
  latencyMs: number | null;
}

export interface BenchmarkRun {
  id: string;
  entryId: string;
  startedAt: string;
  completedAt: string;
  benchmarkVersion: string;
  scoringVersion: string;
  promptSetDigest: string;
  runnerCommit: string;
  region: string;
  synthetic: boolean;
  corpusReleaseId: string | null;
  corpusCommitmentSha256: string | null;
  catalogDigest: string | null;
  taskSetDigest: string | null;
  preflightDigest: string | null;
  runtimeDigest: string | null;
  runClass: string | null;
  permissionEvidenceDigest: string | null;
  tasks: TaskResult[];
}

export interface PublicCalibrationResult {
  id: string;
  runId: string;
  taskId: string;
  taskVersion: string;
  domain: string;
  modelFamily: CalibrationModelFamily;
  reasoningEffort: ReasoningTier;
  outcome: CalibrationOutcome;
  status: RunStatus;
  failureCode: string | null;
  explanationCode: string | null;
  explanationSummary: string | null;
  taskScore: number | null;
  latencyMs: number | null;
  latencyEvidenceLevel: 'runner_observed' | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  tokenUsageSourceLevel: 'provider_reported' | null;
  tokenUsageEvidenceLevel: 'verifier_recomputed' | null;
  standardApiEquivalentUsdNanos: number | null;
  costEstimatorStatus: 'estimated' | 'unavailable_missing_usage' | 'unavailable_invalid_usage';
  costEvidenceLevel: 'verifier_recomputed' | null;
  costEstimatorLimitations: readonly string[];
  costMethod: string | null;
  costVersion: string | null;
  costAsOf: string | null;
  costSource: string | null;
  pricingCurrency: 'USD';
  pricingProcessingTier: 'standard';
}

export interface PublicCalibrationRun {
  id: string;
  classification: 'local_calibration_non_official';
  scoringVersion: string;
  selectedTaskCount: number;
  selectedModelCount: number;
  resultCount: number;
  startedAt: string;
  completedAt: string;
  verifiedAt: string;
  publishedAt: string;
  replayStatus: 'evaluator_replayed';
  official: false;
  rankingEligible: false;
  pricingCurrency: 'USD';
  pricingProcessingTier: 'standard';
  synthetic: boolean;
  selectedConfiguration: CalibrationModelSelection;
  results: readonly PublicCalibrationResult[];
}

export interface PublicCalibrationScore {
  runId: string;
  modelFamily: CalibrationModelFamily;
  reasoningEffort: ReasoningTier;
  descriptiveStatus:
    | 'complete_fixture'
    | 'conditional_observed'
    | 'coverage_only'
    | 'not_applicable';
  aiq: number | null;
  taskResamplingSensitivityLower: number | null;
  taskResamplingSensitivityUpper: number | null;
  taskResamplingSensitivityMethod: string | null;
  resultCount: number;
  sampleSize: number;
  coveragePercent: number;
  observedTotalWallMs: number | null;
  observedMedianWallMs: number | null;
  observedP95WallMs: number | null;
  observedTimeSampleCount: number;
  observedTimeCoveragePercent: number;
  durationEvidenceLevel: 'runner_observed' | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  tokenUsageSampleCount: number;
  tokenUsageSourceLevel: 'provider_reported' | null;
  tokenUsageEvidenceLevel: 'verifier_recomputed' | null;
  standardApiEquivalentUsdNanos: number | null;
  estimatedCostSampleCount: number;
  costEstimatorStatus: 'estimated' | 'unavailable_missing_usage' | 'unavailable_invalid_usage';
  costEvidenceLevel: 'verifier_recomputed' | null;
  costEstimatorLimitations: readonly string[];
  tokenUsageCoveragePercent: number | null;
  pricingSource: string | null;
  pricingAsOf: string | null;
  pricingVersion: string | null;
  pricingCurrency: 'USD';
  pricingProcessingTier: 'standard';
  attemptedResultCount: number;
  invokedResultCount: number;
  adapterElapsedObservedResultCount: number;
  tokenObservedResultCount: number;
  pricedResultCount: number;
  synthetic: boolean;
}

export interface PublicModelEfficiency {
  runId: string;
  modelFamily: CalibrationModelFamily;
  reasoningEffort: ReasoningTier;
  observedTotalWallMs: number | null;
  observedMedianWallMs: number | null;
  observedP95WallMs: number | null;
  observedTimeSampleCount: number;
  observedTimeCoveragePercent: number;
  durationEvidenceLevel: 'runner_observed' | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  tokenUsageSampleCount: number;
  tokenUsageSourceLevel: 'provider_reported' | null;
  standardApiEquivalentUsdNanos: number | null;
  costEstimatorStatus: 'estimated' | 'unavailable_missing_usage' | 'unavailable_invalid_usage';
  tokenUsageCoveragePercent: number;
  tokenUsageEvidenceLevel: 'verifier_recomputed' | null;
  costEvidenceLevel: 'verifier_recomputed' | null;
  costMethod: string | null;
  pricingSource: string | null;
  pricingAsOf: string | null;
  pricingVersion: string | null;
  pricingCurrency: 'USD' | null;
  pricingProcessingTier: 'standard' | null;
}

export type PublicCalibrationRunSummary = Omit<
  PublicCalibrationRun,
  'results' | 'selectedConfiguration'
>;

export interface CalibrationModelSelection {
  modelFamily: CalibrationModelFamily;
  reasoningEffort: ReasoningTier;
}

export interface CalibrationRunPageRequest {
  direction?: 'older' | 'newer';
  cursor?: string;
}

export interface CalibrationRunPage {
  runs: readonly PublicCalibrationRunSummary[];
  newerCursor: string | null;
  olderCursor: string | null;
}

export interface RunResultSummary {
  resultCount: number;
  observedCount: number;
  coveragePercent: number | null;
  coveredDomainCount: number;
  provisionalDomainCount: number;
  passed: number;
  failed: number;
  invalid: number;
  missing: number;
  notApplicable: number;
}

export type BenchmarkRunSummary = Omit<BenchmarkRun, 'tasks'> & {
  resultSummary: RunResultSummary;
};

export interface RunHistoryCursor {
  startedAt: string;
  id: string;
}

export interface RunHistoryPage {
  runs: readonly BenchmarkRunSummary[];
  newerCursor: string | null;
  olderCursor: string | null;
}

export interface RunHistoryPageRequest {
  direction?: 'older' | 'newer';
  cursor?: string;
}

export interface Methodology {
  benchmarkVersion: string;
  scoringVersion: string;
  publishedAt: string;
  domainWeights: ReadonlyArray<{ domain: string; weight: number; taskCount: number }>;
  principles: readonly string[];
  missingPolicy: string;
  failurePolicy: string;
  confidencePolicy: string;
  synthetic: boolean;
}

export interface RadarNode {
  id: string;
  name: string;
  operator: string;
  publicKeyFingerprint: string;
  registryTrust: TrustLevel;
  registryStatus: RegistryStatus;
  registryLastSeenAt: string | null;
  latestCapability: {
    schemaVersion: string;
    contentHash: string;
    status: CapabilityRecordStatus;
    signatureStatus: SignatureStatus;
    observedAt: string;
  } | null;
  latestObservation: {
    schemaVersion: string;
    state: ObservationState;
    sequence: number;
    contentHash: string;
    recordStatus: ObservationRecordStatus;
    signatureStatus: SignatureStatus;
    observedAt: string;
    provenanceHash: string;
  } | null;
  assignmentCounts: {
    total: number;
    offered: number;
    accepted: number;
    running: number;
    completed: number;
    revoked: number;
    expired: number;
  };
  receiptCounts: {
    total: number;
    received: number;
    accepted: number;
    rejected: number;
  };
  aggregation: {
    receiverVerifiedTrusted: number;
    signedUntrusted: number;
    rejected: number;
    missing: number;
    aggregatedAt: string | null;
  };
  synthetic: boolean;
}

export interface AiqRepository {
  readonly mode: 'synthetic' | 'live';
  readonly configuration: PublicDataConfiguration;
  listLeaderboard(): Promise<readonly LeaderboardEntry[]>;
  listTrendPoints(range?: TrendRange): Promise<readonly TrendPoint[]>;
  listRunPage(request?: RunHistoryPageRequest): Promise<RunHistoryPage>;
  getRun(id: string): Promise<BenchmarkRun | null>;
  listCalibrationRunPage(request?: CalibrationRunPageRequest): Promise<CalibrationRunPage>;
  getCalibrationRun(
    id: string,
    selection: CalibrationModelSelection,
  ): Promise<PublicCalibrationRun | null>;
  listCalibrationScores(runId: string): Promise<readonly PublicCalibrationScore[]>;
  listModelEfficiency(runIds: readonly string[]): Promise<readonly PublicModelEfficiency[]>;
  getMethodology(): Promise<Methodology>;
  listRadarNodes(): Promise<readonly RadarNode[]>;
}
