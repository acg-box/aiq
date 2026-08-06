import { createServer } from 'node:http';

import { REQUIRED_RPC_CONTRACT } from '../src/server/readiness.ts';

const port = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Supply one valid mock Supabase port.');
}
const emptyCalibrationEvidence = process.env.AIQ_MOCK_EMPTY_CALIBRATION_EVIDENCE === '1';

/** @type {ReadonlyArray<readonly [string, number]>} */
const domainCounts = [
  ['coding', 8],
  ['debugging', 8],
  ['repository_understanding', 7],
  ['data_processing', 8],
  ['retrieval_verification', 7],
  ['documentation_communication', 7],
  ['planning_execution', 7],
  ['tool_use', 7],
  ['instruction_following', 6],
  ['reliability_recovery', 7],
];

const matrix = [
  {
    family: 'Sol',
    model: 'gpt-5.6-sol',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    family: 'Terra',
    model: 'gpt-5.6-terra',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    family: 'Luna',
    model: 'gpt-5.6-luna',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
].flatMap(({ family, model, tiers }) =>
  tiers.map((tier) => ({
    id: `${family.toLowerCase()}-${tier}`,
    model_family: family,
    model_name: model,
    reasoning_tier: tier,
  })),
);

/**
 * Exact public aggregates from the hash-verified production public backup RSC payload.
 * These fields were already public and contain no private task material.
 *
 * @type {Readonly<Record<string, {runId: string; score: number; sensitivityLow: number; sensitivityHigh: number}>>}
 */
const verifiedPublishedAggregates = {
  'sol-low': {
    runId: 'run_441adf403347a1f32c3176e2ca837341e236a8db5ef5ee3059cdc7baa3cac1d7',
    score: 41.959,
    sensitivityLow: 31.377,
    sensitivityHigh: 52.066,
  },
  'sol-medium': {
    runId: 'run_fa605028cfc2d6c94d2ee0769a75d0f5c7bfddfc3b32b0106f525cc328e68930',
    score: 42.801,
    sensitivityLow: 32.474,
    sensitivityHigh: 52.45,
  },
  'sol-high': {
    runId: 'run_37c17d1683b14473966cfc9c4ac8fb97ea16b7f9a0bf2948bd8b234220f6240f',
    score: 42.26,
    sensitivityLow: 32.472,
    sensitivityHigh: 51.524,
  },
  'sol-xhigh': {
    runId: 'run_17b245b7a4b7c46348864a100e70cb0ce47d8f961e4d762ef4b4610e620bee5c',
    score: 42.865,
    sensitivityLow: 31.708,
    sensitivityHigh: 53.996,
  },
  'sol-max': {
    runId: 'run_87c706c0bdc9e7cdfd52eebc9f55661d3cb6c2f2606721dd68fd869df8723093',
    score: 42.397,
    sensitivityLow: 31.196,
    sensitivityHigh: 53.282,
  },
  'sol-ultra': {
    runId: 'run_f43f06eefb714c86d413a802587ba303b16e9a0ddc3de9f4cc01b8ff9e8d3f14',
    score: 40.803,
    sensitivityLow: 28.825,
    sensitivityHigh: 52.294,
  },
  'terra-low': {
    runId: 'run_a8358a9ea1ee1fb19edc9b2c0a3f8909764503d5f1d2c4f2a7161debaac610c4',
    score: 37.299,
    sensitivityLow: 27.509,
    sensitivityHigh: 47.286,
  },
  'terra-medium': {
    runId: 'run_130c49d83c7816a4939cf9851d936e8fa578d2b1d3dcedff5a6c9bbbfae53684',
    score: 40.571,
    sensitivityLow: 29.572,
    sensitivityHigh: 51.103,
  },
  'terra-high': {
    runId: 'run_0f873d71f76b85a0670444fec79be29fb0102e7435b1c1bcb3f0b2d8f50387b4',
    score: 39.117,
    sensitivityLow: 29.328,
    sensitivityHigh: 48.561,
  },
  'terra-xhigh': {
    runId: 'run_834fdafb3146ead1d05f146388e68b99a0f2569a19d92bd2fb9f3de25f93fcc7',
    score: 39.67,
    sensitivityLow: 29.983,
    sensitivityHigh: 48.929,
  },
  'terra-max': {
    runId: 'run_b7415ac6300414b294a668149710c4fecb7a7bec368d25361e4fcc961db7cac4',
    score: 42.432,
    sensitivityLow: 32,
    sensitivityHigh: 52.211,
  },
  'terra-ultra': {
    runId: 'run_db0ba87f356c60ee87a93df4cf730c44b3d511ca65c3310d00acb193686fa685',
    score: 42.347,
    sensitivityLow: 32.279,
    sensitivityHigh: 51.96,
  },
  'luna-low': {
    runId: 'run_ff1d6d7ac0b68f652e28a4437baa9417fbab23789dc60c2b0bb6c6fee4eac71c',
    score: 37.314,
    sensitivityLow: 26.628,
    sensitivityHigh: 47.616,
  },
  'luna-medium': {
    runId: 'run_f4bfbadc40f66cfd7bdd279a9ac025c4fdf6951e61e2f58ccb90b0988090a363',
    score: 39.083,
    sensitivityLow: 29.548,
    sensitivityHigh: 48.834,
  },
  'luna-high': {
    runId: 'run_34f3e4bdea2d80922c016d17f0fb8005ae4a4bfbd7724c0e841384466666dc82',
    score: 41.879,
    sensitivityLow: 31.824,
    sensitivityHigh: 51.618,
  },
  'luna-xhigh': {
    runId: 'run_5b896428917c276cc7aec28f91f48a3572b2b62e1266a89fd568cf8ac3983c8b',
    score: 38.781,
    sensitivityLow: 29.728,
    sensitivityHigh: 48.172,
  },
  'luna-max': {
    runId: 'run_03c1830225ab52b741137eb34847d4432b08f3f57c7e562df4288999f1b48f0d',
    score: 41.39,
    sensitivityLow: 31.042,
    sensitivityHigh: 51.324,
  },
};

/**
 * Anonymous result distributions extracted from the verified production result package.
 *
 * Domains use `domainCounts` order. Each tuple is
 * `[correct count, partial score multiset, incorrect count, timeout count, budget count]`.
 * It contains no task identifiers, prompts, responses, artifacts, or credentials.
 *
 * @type {Readonly<Record<string, ReadonlyArray<readonly [number, readonly number[], number, number, number]>>>}
 */
const officialDomainEvidence = {
  'sol-low': [
    [6, [], 2, 0, 0],
    [6, [], 2, 0, 0],
    [2, [], 5, 0, 0],
    [2, [0.6125, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.425, 0.7], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.6875, 0.8], 4, 0, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.5375, 0.625, 0.7875, 0.8875, 0.8875], 2, 0, 0],
  ],
  'sol-medium': [
    [7, [], 1, 0, 0],
    [6, [], 2, 0, 0],
    [2, [], 5, 0, 0],
    [2, [0.5, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.425, 0.525], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.55, 0.8], 4, 0, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.5375, 0.7875, 0.8, 0.8375, 0.8875], 2, 0, 0],
  ],
  'sol-high': [
    [6, [], 2, 0, 0],
    [5, [0.875], 2, 0, 0],
    [2, [], 5, 0, 0],
    [1, [0.5, 0.75, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.425, 0.525], 5, 0, 0],
    [0, [], 7, 0, 0],
    [2, [0.55, 0.8], 3, 0, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.3625, 0.7875, 0.8, 0.8375, 0.8875], 2, 0, 0],
  ],
  'sol-xhigh': [
    [7, [], 1, 0, 0],
    [6, [], 2, 0, 0],
    [3, [], 4, 0, 0],
    [2, [0.5, 0.6625, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.525, 0.6125], 5, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.55, 0.8], 5, 0, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.5375, 0.7875, 0.8, 0.8375, 0.8875], 2, 0, 0],
  ],
  'sol-max': [
    [6, [], 2, 0, 0],
    [6, [], 2, 0, 0],
    [3, [], 4, 0, 0],
    [2, [0.4875, 0.5, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.425, 0.525], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.4375, 0.8], 3, 1, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.5375, 0.7875, 0.8, 0.8375, 0.8875], 2, 0, 0],
  ],
  'sol-ultra': [
    [6, [], 1, 1, 0],
    [5, [], 2, 1, 0],
    [3, [], 4, 0, 0],
    [1, [0.5, 0.6625, 0.75, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.425, 0.525], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.4375, 0.8], 4, 0, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.5375, 0.625, 0.7875, 0.8375, 0.8875], 2, 0, 0],
  ],
  'terra-low': [
    [7, [], 1, 0, 0],
    [5, [], 3, 0, 0],
    [0, [], 7, 0, 0],
    [3, [0.5, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.525, 0.6125], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.75, 0.8], 4, 0, 0],
    [2, [0.6625], 3, 0, 0],
    [0, [0.3625, 0.625, 0.7875, 0.8375, 0.8875], 2, 0, 0],
  ],
  'terra-medium': [
    [7, [], 1, 0, 0],
    [6, [], 2, 0, 0],
    [1, [], 6, 0, 0],
    [2, [0.5, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.525, 0.6125], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.75, 0.8], 4, 0, 0],
    [3, [], 3, 0, 0],
    [0, [0.3625, 0.7875, 0.8, 0.8375, 0.8875], 2, 0, 0],
  ],
  'terra-high': [
    [7, [], 1, 0, 0],
    [6, [], 2, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.5, 0.6625, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.6125, 0.7], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.6875, 0.8], 4, 0, 0],
    [2, [0.6625, 0.8], 2, 0, 0],
    [0, [0.1625, 0.625, 0.7875, 0.8375, 0.8875], 2, 0, 0],
  ],
  'terra-xhigh': [
    [8, [], 0, 0, 0],
    [6, [], 2, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.5, 0.75, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.525, 0.6125], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.6375, 0.8], 4, 0, 0],
    [3, [], 3, 0, 0],
    [0, [0.3625, 0.625, 0.7875, 0.8375, 0.8875], 2, 0, 0],
  ],
  'terra-max': [
    [7, [], 1, 0, 0],
    [6, [], 2, 0, 0],
    [2, [], 5, 0, 0],
    [1, [0.5, 0.6625, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.525, 0.6125], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.75, 0.8], 4, 0, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.3625, 0.625, 0.7875, 0.8375, 0.8875], 2, 0, 0],
  ],
  'terra-ultra': [
    [8, [], 0, 0, 0],
    [5, [0.875], 2, 0, 0],
    [1, [], 6, 0, 0],
    [1, [0.5, 0.6625, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.525, 0.6125], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.75, 0.8], 4, 0, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.3625, 0.7875, 0.8, 0.8375, 0.8875], 2, 0, 0],
  ],
  'luna-low': [
    [7, [], 1, 0, 0],
    [4, [], 4, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.5, 0.6875, 0.825, 0.825, 0.8625, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.425], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.375, 0.8], 4, 0, 0],
    [3, [0.6625], 2, 0, 0],
    [0, [0.3375, 0.7875, 0.8, 0.8875, 0.8875], 2, 0, 0],
  ],
  'luna-medium': [
    [7, [], 1, 0, 0],
    [5, [], 3, 0, 0],
    [0, [], 7, 0, 0],
    [3, [0.6125, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.6125, 0.7], 5, 0, 0],
    [0, [], 7, 0, 0],
    [2, [0.575, 0.8], 3, 0, 0],
    [2, [0.6625], 3, 0, 0],
    [0, [0.5375, 0.6875, 0.7875, 0.8, 0.8375], 2, 0, 0],
  ],
  'luna-high': [
    [8, [], 0, 0, 0],
    [4, [0.875], 3, 0, 0],
    [1, [], 6, 0, 0],
    [2, [0.5, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.6125, 0.7], 5, 0, 0],
    [0, [], 7, 0, 0],
    [2, [0.575, 0.8], 3, 0, 0],
    [3, [], 3, 0, 0],
    [0, [0.3375, 0.7875, 0.8, 0.8875, 0.8875], 2, 0, 0],
  ],
  'luna-xhigh': [
    [7, [], 1, 0, 0],
    [5, [], 3, 0, 0],
    [1, [], 6, 0, 0],
    [3, [0.5, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.525, 0.6125], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.4375, 0.8], 4, 0, 0],
    [2, [0.6625], 3, 0, 0],
    [0, [0.5375, 0.7875, 0.8, 0.8375, 0.8875], 2, 0, 0],
  ],
  'luna-max': [
    [8, [], 0, 0, 0],
    [4, [], 3, 1, 0],
    [2, [], 5, 0, 0],
    [2, [0.5, 0.825, 0.825, 0.825, 0.925], 1, 0, 0],
    [0, [], 7, 0, 0],
    [0, [0.525, 0.6125], 5, 0, 0],
    [0, [], 7, 0, 0],
    [1, [0.375, 0.8], 2, 1, 1],
    [3, [0.6625], 2, 0, 0],
    [0, [0.5375, 0.625, 0.7875, 0.8875, 0.8875], 2, 0, 0],
  ],
};

/**
 * @param {{id: string}} entry
 * @param {number} index
 */
function officialRunId(entry, index) {
  const published = verifiedPublishedAggregates[entry.id];
  if (!published) throw new Error(`Missing published run identity for matrix entry ${index}.`);
  return published.runId;
}

const canonicalPublicExecutionFailures = {
  timeout: {
    code: 'timeout',
    summary: 'The task exceeded its time limit.',
    retryable: true,
  },
  budgetExceeded: {
    code: 'budget_exceeded',
    summary: 'The task exceeded a resource budget.',
    retryable: false,
  },
};

const provenanceHash = `sha256:${'1'.repeat(64)}`;
const currentRunStartedAt = '2026-08-03T12:00:00.000Z';
const currentRunCompletedAt = '2026-08-03T13:37:24.411Z';

/**
 * Expand one anonymous per-domain distribution into public result rows.
 *
 * @param {{id: string}} entry
 */
function officialResultsForEntry(entry) {
  const distributions = officialDomainEvidence[entry.id];
  if (!distributions || distributions.length !== domainCounts.length) {
    throw new Error(`Missing complete Official domain evidence for ${entry.id}.`);
  }

  return domainCounts.flatMap(([domain, expectedTaskCount], domainIndex) => {
    const distribution = distributions[domainIndex];
    if (!distribution) throw new Error(`Missing Official ${domain} evidence for ${entry.id}.`);
    const [correctCount, partialScores, incorrectCount, timeoutCount, budgetCount] = distribution;
    if (
      ![correctCount, incorrectCount, timeoutCount, budgetCount].every(Number.isSafeInteger) ||
      partialScores.some((score) => !Number.isFinite(score) || score <= 0 || score >= 1) ||
      correctCount + partialScores.length + incorrectCount + timeoutCount + budgetCount !==
        expectedTaskCount
    ) {
      throw new Error(`Invalid Official ${domain} evidence for ${entry.id}.`);
    }

    const results = [
      ...Array.from({ length: correctCount }, () => ({
        outcome: 'correct',
        execution_status: 'completed',
        score: 1,
        explanation_code: null,
        explanation_summary: null,
        retryable: null,
      })),
      ...partialScores.map((score) => ({
        outcome: 'partial',
        execution_status: 'completed',
        score,
        explanation_code: null,
        explanation_summary: null,
        retryable: null,
      })),
      ...Array.from({ length: incorrectCount }, () => ({
        outcome: 'incorrect',
        execution_status: 'completed',
        score: 0,
        explanation_code: null,
        explanation_summary: 'The evaluator rejected the response.',
        retryable: null,
      })),
      ...Array.from({ length: timeoutCount }, () => ({
        outcome: 'timeout',
        execution_status: 'runtime_issue',
        score: 0,
        explanation_code: canonicalPublicExecutionFailures.timeout.code,
        explanation_summary: canonicalPublicExecutionFailures.timeout.summary,
        retryable: canonicalPublicExecutionFailures.timeout.retryable,
      })),
      ...Array.from({ length: budgetCount }, () => ({
        outcome: 'budget_exhausted',
        execution_status: 'runtime_issue',
        score: 0,
        explanation_code: canonicalPublicExecutionFailures.budgetExceeded.code,
        explanation_summary: canonicalPublicExecutionFailures.budgetExceeded.summary,
        retryable: canonicalPublicExecutionFailures.budgetExceeded.retryable,
      })),
    ];

    return results.map((result, taskIndex) =>
      Object.assign(result, {
        id: `00000000-0000-4000-8000-${String(domainIndex * 10 + taskIndex + 1).padStart(12, '0')}`,
        task_id: `${domain.replaceAll('_', '-')}-${String(taskIndex + 1).padStart(2, '0')}`,
        task: `${domain.replaceAll('_', ' ')} anonymous result ${taskIndex + 1}`,
        domain,
      }),
    );
  });
}

/**
 * AIQ v1: compute each domain's task-score mean, then give all ten domains equal weight.
 *
 * @param {ReadonlyArray<{domain: string; score: number}>} results
 */
function equalDomainAiq(results) {
  if (results.length !== 72) throw new Error('Official AIQ requires exactly 72 result rows.');
  const domainMeans = domainCounts.map(([domain, expectedTaskCount]) => {
    const scores = results
      .filter((result) => result.domain === domain)
      .map((result) => result.score);
    if (
      scores.length !== expectedTaskCount ||
      scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      throw new Error(`Official AIQ requires ${expectedTaskCount} valid ${domain} scores.`);
    }
    return scores.reduce((total, score) => total + score, 0) / scores.length;
  });
  return (100 * domainMeans.reduce((total, score) => total + score, 0)) / domainMeans.length;
}

/** @param {ReadonlyArray<{outcome: string; execution_status: string}>} results */
function summarizeOfficialOutcomes(results) {
  return {
    correct: results.filter((result) => result.outcome === 'correct').length,
    partial: results.filter((result) => result.outcome === 'partial').length,
    evaluatorIncorrect: results.filter((result) => result.outcome === 'incorrect').length,
    timeouts: results.filter((result) => result.outcome === 'timeout').length,
    budgetExceeded: results.filter((result) => result.outcome === 'budget_exhausted').length,
    executionFailures: results.filter((result) => result.execution_status === 'runtime_issue')
      .length,
    completed: results.filter((result) => result.execution_status === 'completed').length,
  };
}

if (
  Object.keys(officialDomainEvidence).length !== matrix.length ||
  Object.keys(verifiedPublishedAggregates).length !== matrix.length ||
  matrix.some(
    (entry) => !officialDomainEvidence[entry.id] || !verifiedPublishedAggregates[entry.id],
  )
) {
  throw new Error('Official evidence must cover the exact 17-entry model matrix.');
}
const verifiedPublishedRuns = Object.values(verifiedPublishedAggregates).map(({ runId }) => runId);
if (
  new Set(verifiedPublishedRuns).size !== matrix.length ||
  verifiedPublishedRuns.some((runId) => !/^run_[0-9a-f]{64}$/.test(runId))
) {
  throw new Error('Verified public run identities must be unique canonical digests.');
}

const currentRunEvidence = matrix.map((entry, entryIndex) => {
  const results = officialResultsForEntry(entry);
  const outcomes = summarizeOfficialOutcomes(results);
  const published = verifiedPublishedAggregates[entry.id];
  if (!published) throw new Error(`Missing published aggregates for ${entry.id}.`);
  const recomputedScore = Number(equalDomainAiq(results).toFixed(3));
  if (
    recomputedScore !== published.score ||
    published.sensitivityLow > recomputedScore ||
    published.sensitivityHigh < recomputedScore
  ) {
    throw new Error(`Published aggregates do not match ${entry.id} task evidence.`);
  }
  return {
    entry,
    entryIndex,
    runId: officialRunId(entry, entryIndex),
    startedAt: currentRunStartedAt,
    completedAt: currentRunCompletedAt,
    outcomes,
    results,
    interval: {
      center: recomputedScore,
      lower: published.sensitivityLow,
      upper: published.sensitivityHigh,
    },
  };
});

const officialOutcomeTotals = currentRunEvidence.reduce(
  (totals, { outcomes }) => ({
    correct: totals.correct + outcomes.correct,
    partial: totals.partial + outcomes.partial,
    evaluatorIncorrect: totals.evaluatorIncorrect + outcomes.evaluatorIncorrect,
    timeouts: totals.timeouts + outcomes.timeouts,
    budgetExceeded: totals.budgetExceeded + outcomes.budgetExceeded,
    executionFailures: totals.executionFailures + outcomes.executionFailures,
    completed: totals.completed + outcomes.completed,
  }),
  {
    correct: 0,
    partial: 0,
    evaluatorIncorrect: 0,
    timeouts: 0,
    budgetExceeded: 0,
    executionFailures: 0,
    completed: 0,
  },
);
if (
  officialOutcomeTotals.correct !== 329 ||
  officialOutcomeTotals.partial !== 259 ||
  officialOutcomeTotals.evaluatorIncorrect !== 630 ||
  officialOutcomeTotals.timeouts !== 5 ||
  officialOutcomeTotals.budgetExceeded !== 1 ||
  officialOutcomeTotals.executionFailures !== 6 ||
  officialOutcomeTotals.completed !== 1_218 ||
  currentRunEvidence.reduce((total, evidence) => total + evidence.results.length, 0) !== 1_224
) {
  throw new Error('The live-published fixture does not match verified Official outcome totals.');
}

const leaderboard = currentRunEvidence.map(({ entry, runId, outcomes, interval }) => ({
  matrix_id: entry.id,
  run_id: runId,
  score: interval.center,
  sensitivity_low: interval.lower,
  sensitivity_high: interval.upper,
  sample_size: 72,
  coverage_percent: 100,
  runtime_issues: outcomes.executionFailures,
  missing: 0,
  scoring_version: '1.0.2',
  score_status: 'official',
  synthetic: false,
}));

const runEvidence = currentRunEvidence;
const runRows = runEvidence.map(({ entry, runId, startedAt, completedAt, outcomes }) => {
  return {
    id: runId,
    matrix_id: entry.id,
    started_at: startedAt,
    completed_at: completedAt,
    benchmark_version: 'aiq-core@1.0.2',
    scoring_version: '1.0.2',
    prompt_set_digest: 'sha256:a6aead1a94c0e6dc6e9f80fe2057ab46c60fa9ce287e8db1c6000f8000541105',
    runner_commit: '7a0c4d1',
    region: 'us-east-1',
    synthetic: false,
    corpus_release_id: 'corpus_2026.08.02-aiq-core-1.0.2-controlled.1',
    corpus_commitment_sha256:
      'sha256:5b8cfddaacefcd58274b880815fd3f955bd319396755d041f2f30d000555624f',
    catalog_digest: 'sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937',
    task_set_digest: 'sha256:d5463bf713a83d07fdb43c2bf16093779096bcdeb17682ca68952060d71b7e10',
    preflight_digest: `sha256:${'6'.repeat(64)}`,
    runtime_digest: `sha256:${'7'.repeat(64)}`,
    run_class: 'official',
    permission_evidence_digest: `sha256:${'9'.repeat(64)}`,
    result_count: 72,
    correct_count: outcomes.correct,
    partial_count: outcomes.partial,
    incorrect_count: outcomes.evaluatorIncorrect,
    runtime_issue_count: outcomes.executionFailures,
    invalid_count: 0,
    missing_count: 0,
    not_applicable_count: 0,
    completed_count: outcomes.completed,
    observed_count: 72,
    coverage_percent: 100,
    covered_domain_count: 10,
    provisional_domain_count: 10,
  };
});

const calibrationRunId = `run_${'8'.repeat(64)}`;
const subsetCalibrationRunId = `run_${'7'.repeat(64)}`;
const pricingSource = 'https://developers.openai.com/api/docs/pricing';
const pricingDigest = 'sha256:e1a28656f2918a14e86997b06bf9e29ec4db084ff89ee0319aafa0c05cc1f31d';
const pricingLimitation =
  'Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing';
const costFormula =
  '(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again';
const pricingRates = [
  {
    model: 'gpt-5.6-sol',
    input_usd_nanos_per_token: 5000,
    cached_input_usd_nanos_per_token: 500,
    cache_write_input_usd_nanos_per_token: 6250,
    output_usd_nanos_per_token: 30000,
  },
  {
    model: 'gpt-5.6-terra',
    input_usd_nanos_per_token: 2000,
    cached_input_usd_nanos_per_token: 200,
    cache_write_input_usd_nanos_per_token: 2500,
    output_usd_nanos_per_token: 12000,
  },
  {
    model: 'gpt-5.6-luna',
    input_usd_nanos_per_token: 200,
    cached_input_usd_nanos_per_token: 20,
    cache_write_input_usd_nanos_per_token: 250,
    output_usd_nanos_per_token: 1200,
  },
];
const calibrationRun = {
  run_id: calibrationRunId,
  classification: 'local_calibration_non_official',
  scoring_version: '1.0.2',
  selected_task_count: 72,
  selected_model_count: 17,
  result_count: 1_224,
  started_at: '2026-07-30T12:00:00.000Z',
  completed_at: '2026-07-30T14:00:00.000Z',
  verified_at: '2026-07-30T14:05:00.000Z',
  published_at: '2026-07-30T14:10:00.000Z',
  replay_status: 'evaluator_replayed',
  official: false,
  ranking_eligible: false,
  pricing_currency: 'USD',
  pricing_processing_tier: 'standard',
};

const subsetCalibrationRun = {
  ...calibrationRun,
  run_id: subsetCalibrationRunId,
  selected_task_count: 5,
  selected_model_count: 1,
  result_count: 5,
  started_at: '2026-07-31T12:00:00.000Z',
  completed_at: '2026-07-31T12:10:00.000Z',
  verified_at: '2026-07-31T12:15:00.000Z',
  published_at: '2026-07-31T12:20:00.000Z',
};

const calibrationScores = matrix.map((entry, index) => {
  const aiq = Number((82.5 - index * 0.6).toFixed(2));
  const unavailableContextBand = index === 1;
  const inputTokens = unavailableContextBand ? 344_001 : 72_000 + index * 1_000;
  const outputTokens = 36_000 + index * 800;
  return {
    run_id: calibrationRunId,
    model_family: entry.model_family.toLowerCase(),
    reasoning_effort: entry.reasoning_tier,
    descriptive_status: index === 0 ? 'conditional_observed' : 'complete_fixture',
    aiq,
    task_resampling_sensitivity_lower: Number((aiq - 1.5).toFixed(2)),
    task_resampling_sensitivity_upper: Number((aiq + 1.5).toFixed(2)),
    task_resampling_sensitivity_method: 'finite_cluster_calibrated_percentile_sensitivity_v1',
    result_count: 72,
    sample_size: index === 0 ? 71 : 72,
    coverage_percent: index === 0 ? (71 / 72) * 100 : 100,
    observed_total_wall_ms: 720_000 + index * 36_000,
    observed_median_wall_ms: 10_000 + index * 500,
    observed_p95_wall_ms: 12_000 + index * 550,
    observed_time_sample_count: 72,
    observed_time_coverage_percent: 100,
    duration_evidence_level: 'runner_observed',
    input_tokens: inputTokens,
    cached_input_tokens: 12_000,
    cache_write_input_tokens: 2_000,
    output_tokens: outputTokens,
    reasoning_output_tokens: 18_000 + index * 400,
    total_tokens: inputTokens + outputTokens,
    token_usage_sample_count: 72,
    token_usage_source_level: 'provider_reported',
    token_usage_evidence_level: 'verifier_recomputed',
    standard_api_equivalent_usd_nanos: unavailableContextBand
      ? null
      : 48_000_000 + index * 2_000_000,
    estimated_cost_sample_count: unavailableContextBand ? 71 : 72,
    cost_estimator_status: unavailableContextBand ? 'unavailable_context_band' : 'estimated',
    cost_evidence_level: unavailableContextBand ? null : 'verifier_recomputed',
    cost_estimator_limitations: [pricingLimitation],
    token_usage_coverage_percent: 100,
    pricing_source: pricingSource,
    pricing_as_of: '2026-08-02',
    pricing_version: 'aiq.standard-api-equivalent-usd.v1',
    pricing_currency: 'USD',
    pricing_processing_tier: 'standard',
    attempted_result_count: 72,
    invoked_result_count: 72,
    adapter_elapsed_observed_result_count: 72,
    token_observed_result_count: 72,
    priced_result_count: unavailableContextBand ? 71 : 72,
  };
});

const subsetCalibrationScore = {
  ...calibrationScores[7],
  run_id: subsetCalibrationRunId,
  result_count: 5,
  sample_size: 5,
  coverage_percent: 100,
  observed_time_sample_count: 5,
  token_usage_sample_count: 5,
  estimated_cost_sample_count: 5,
  attempted_result_count: 5,
  invoked_result_count: 5,
  adapter_elapsed_observed_result_count: 5,
  token_observed_result_count: 5,
  priced_result_count: 5,
};

const historicalCalibrationScores = [
  subsetCalibrationScore,
  ...calibrationScores,
  { ...calibrationScores[0], run_id: 'run-stale-calibration-history' },
];

const calibrationResults = matrix.flatMap((entry, configurationIndex) =>
  Array.from({ length: 72 }, (_, taskIndex) => {
    const unavailableContextBand = configurationIndex === 0 && taskIndex === 1;
    const inputTokens = unavailableContextBand
      ? 272_001
      : 1_000 + configurationIndex * 10 + taskIndex;
    const outputTokens = 500 + taskIndex;
    const workspaceIntegrity = configurationIndex === 0 && taskIndex === 0;
    return {
      result_id: `result_${String(configurationIndex).padStart(2, '0')}_${String(taskIndex).padStart(2, '0')}`,
      run_id: calibrationRunId,
      task_id: `aiq-v1-calibration-task-${String(taskIndex + 1).padStart(2, '0')}`,
      task_version: '1.0.2',
      domain: domainCounts[taskIndex % domainCounts.length]?.[0] ?? 'coding',
      model_family: entry.model_family.toLowerCase(),
      reasoning_effort: entry.reasoning_tier,
      outcome: workspaceIntegrity ? 'invalid' : 'correct',
      execution_status: workspaceIntegrity ? 'invalid' : 'completed',
      failure_code: workspaceIntegrity ? 'workspace_integrity' : null,
      explanation_code: workspaceIntegrity ? 'workspace_integrity' : null,
      explanation_summary: workspaceIntegrity
        ? 'Benchmark infrastructure invalidated this result; an audited rerun is required.'
        : null,
      task_score: workspaceIntegrity ? null : 1,
      latency_ms: 8_000 + taskIndex * 50,
      latency_evidence_level: 'runner_observed',
      input_tokens: inputTokens,
      cached_input_tokens: 200,
      cache_write_input_tokens: 50,
      output_tokens: outputTokens,
      reasoning_output_tokens: 250,
      total_tokens: inputTokens + outputTokens,
      token_usage_source_level: 'provider_reported',
      token_usage_evidence_level: 'verifier_recomputed',
      standard_api_equivalent_usd_nanos: unavailableContextBand
        ? null
        : 650_000 + taskIndex * 1_000,
      cost_estimator_status: unavailableContextBand ? 'unavailable_context_band' : 'estimated',
      cost_evidence_level: unavailableContextBand ? null : 'verifier_recomputed',
      cost_estimator_limitations: [pricingLimitation],
      cost_method: 'standard_api_equivalent_text_token_estimate',
      cost_version: 'aiq.standard-api-equivalent-usd.v1',
      cost_as_of: '2026-08-02',
      cost_source: pricingSource,
      pricing_currency: 'USD',
      pricing_processing_tier: 'standard',
    };
  }),
);

calibrationResults.push(
  ...calibrationResults
    .filter((result) => result.model_family === 'terra' && result.reasoning_effort === 'medium')
    .slice(0, 5)
    .map((result, index) =>
      Object.assign({}, result, {
        result_id: `subset_result_${String(index).padStart(2, '0')}`,
        run_id: subsetCalibrationRunId,
      }),
    ),
);

const modelEfficiency = calibrationScores.map((score, index) => {
  const completeTokens = index === 0;
  const partialTokens = index === 2;
  const contextBandTokens = index === 4;
  const tokenCount = completeTokens || contextBandTokens ? 72 : partialTokens ? 36 : 0;
  const tokenCoveragePercent = tokenCount === 0 ? null : (tokenCount / 72) * 100;
  const tokensAvailable = tokenCount > 0;
  const durationAvailable = index !== 3;
  return {
    run_id:
      leaderboard[index]?.run_id ?? officialRunId(matrix[index] ?? { id: String(index) }, index),
    matrix_batch_id: `run_${'b'.repeat(64)}`,
    model_family: score.model_family,
    reasoning_effort: score.reasoning_effort,
    matrix_batch_elapsed_ms: 5_844_411,
    summed_cell_adapter_elapsed_ms: durationAvailable ? score.observed_total_wall_ms : null,
    observed_median_wall_ms: durationAvailable ? score.observed_median_wall_ms : null,
    observed_p95_wall_ms: durationAvailable ? score.observed_p95_wall_ms : null,
    observed_time_sample_count: durationAvailable ? 72 : 0,
    observed_time_coverage_percent: durationAvailable ? 100 : 0,
    duration_evidence_level: durationAvailable ? 'runner_observed' : null,
    input_tokens: tokensAvailable ? 72_000 : null,
    cached_input_tokens: tokensAvailable ? 12_000 : null,
    cache_write_input_tokens: tokensAvailable ? 6_000 : null,
    output_tokens: tokensAvailable ? 36_000 : null,
    reasoning_output_tokens: tokensAvailable ? 12_000 : null,
    total_tokens: null,
    token_usage_sample_count: tokenCount,
    token_usage_coverage_percent: tokenCoveragePercent,
    input_token_coverage_count: tokensAvailable ? tokenCount : null,
    input_token_coverage_percent: tokenCoveragePercent,
    cached_input_token_coverage_count: tokensAvailable ? tokenCount : null,
    cached_input_token_coverage_percent: tokenCoveragePercent,
    cache_write_input_token_coverage_count: tokensAvailable ? tokenCount : null,
    cache_write_input_token_coverage_percent: tokenCoveragePercent,
    output_token_coverage_count: tokensAvailable ? tokenCount : null,
    output_token_coverage_percent: tokenCoveragePercent,
    reasoning_token_coverage_count: tokensAvailable ? tokenCount : null,
    reasoning_token_coverage_percent: tokenCoveragePercent,
    total_token_coverage_count: null,
    total_token_coverage_percent: null,
    token_usage_source_level: tokensAvailable ? 'provider_reported' : null,
    token_usage_evidence_level: tokensAvailable ? 'verifier_recomputed' : null,
    standard_api_equivalent_usd_nanos: completeTokens ? 12_345_600_000 : null,
    cost_estimator_status: completeTokens
      ? 'estimated'
      : contextBandTokens
        ? 'unavailable_context_band'
        : 'unavailable_missing_usage',
    cost_evidence_level: completeTokens ? 'verifier_recomputed' : null,
    cost_method: 'standard_api_equivalent_text_token_estimate',
    pricing_source: score.pricing_source,
    pricing_as_of: score.pricing_as_of,
    pricing_version: score.pricing_version,
    pricing_currency: score.pricing_currency,
    pricing_processing_tier: score.pricing_processing_tier,
    result_count: 72,
    attempted_result_count: 72,
    invoked_result_count: 72,
    adapter_elapsed_observed_result_count: durationAvailable ? 72 : 0,
    token_observed_result_count: tokenCount,
    priced_result_count: completeTokens || contextBandTokens ? 72 : 0,
    execution_concurrency: 17,
    estimated_cost_sample_count: completeTokens || contextBandTokens ? 72 : 0,
    cost_estimator_limitations: score.cost_estimator_limitations,
    pricing_rates: pricingRates,
    cost_formula: costFormula,
  };
});

const publishedModelEfficiency = modelEfficiency;

/** @type {Array<{ run_id: string; [key: string]: unknown }>} */
const runResults = [];
let publishedResultIndex = 0;
for (const evidence of runEvidence) {
  const modelRate = pricingRates.find((rate) => rate.model === evidence.entry.model_name);
  if (!modelRate) throw new Error(`Missing pricing rate for ${evidence.entry.model_name}.`);
  let globalIndex = 0;
  for (const result of evidence.results) {
    globalIndex += 1;
    publishedResultIndex += 1;
    const runtimeIssue = result.execution_status === 'runtime_issue';
    const unavailableContextBand = !runtimeIssue && publishedResultIndex <= 10;
    const estimatedCost = !runtimeIssue && !unavailableContextBand;
    const tokensAvailable = estimatedCost || unavailableContextBand;
    const inputTokens = tokensAvailable
      ? unavailableContextBand
        ? 272_001 + publishedResultIndex
        : 1_000 + publishedResultIndex
      : null;
    const cachedInputTokens = tokensAvailable ? 200 : null;
    const cacheWriteInputTokens = tokensAvailable ? 50 : null;
    const outputTokens = tokensAvailable ? 500 : null;
    const estimatedUsdNanos = estimatedCost
      ? (inputTokens - cachedInputTokens - cacheWriteInputTokens) *
          modelRate.input_usd_nanos_per_token +
        cachedInputTokens * modelRate.cached_input_usd_nanos_per_token +
        cacheWriteInputTokens * modelRate.cache_write_input_usd_nanos_per_token +
        outputTokens * modelRate.output_usd_nanos_per_token
      : null;
    runResults.push({
      run_id: evidence.runId,
      id: result.id,
      task_id: result.task_id,
      task: result.task,
      domain: result.domain,
      outcome: result.outcome,
      execution_status: result.execution_status,
      score: result.score,
      explanation_code: result.explanation_code,
      explanation_summary: result.explanation_summary,
      retryable: result.retryable,
      tools: ['repository_search', 'test_runner'],
      latency_ms: 7_500 + globalIndex * 137,
      latency_evidence_level: 'runner_observed',
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      cache_write_input_tokens: cacheWriteInputTokens,
      output_tokens: outputTokens,
      reasoning_output_tokens: tokensAvailable ? 250 : null,
      total_tokens: null,
      token_usage_source_level: tokensAvailable ? 'provider_reported' : null,
      token_usage_evidence_level: tokensAvailable ? 'verifier_recomputed' : null,
      standard_api_equivalent_usd_nanos: estimatedUsdNanos,
      cost_estimator_status: estimatedCost
        ? 'estimated'
        : unavailableContextBand
          ? 'unavailable_context_band'
          : 'unavailable_missing_usage',
      cost_evidence_level: estimatedCost ? 'verifier_recomputed' : null,
      pricing_digest: pricingDigest,
    });
  }
}

const resultCostCoverage = {
  estimated: runResults.filter((result) => result.cost_estimator_status === 'estimated').length,
  unavailableContextBand: runResults.filter(
    (result) => result.cost_estimator_status === 'unavailable_context_band',
  ).length,
  unavailableMissingUsage: runResults.filter(
    (result) => result.cost_estimator_status === 'unavailable_missing_usage',
  ).length,
};
if (
  resultCostCoverage.estimated !== 1_208 ||
  resultCostCoverage.unavailableContextBand !== 10 ||
  resultCostCoverage.unavailableMissingUsage !== 6
) {
  throw new Error('Official result cost coverage must match the verified production matrix.');
}

const scoringVersion = {
  benchmark_version: 'aiq-core@1.0.2',
  scoring_version: '1.0.2',
  published_at: '2026-07-29T16:00:00.000Z',
  principles: [
    'Estimate performance on the committed AIQ v1 fixed-fixture set.',
    'Score every frozen domain with equal weight.',
    'Publish outcome counts and provenance without exposing hidden payloads.',
    'Keep missing or invalid work visible.',
  ],
  missing_policy: 'Missing and invalid results block Official publication.',
  failure_policy: 'A valid failed attempt scores zero and remains visible.',
  sensitivity_policy:
    'The interval is a fixed-fixture task-resampling sensitivity interval, not a universal capability claim.',
  synthetic: false,
};

const taskCoverage = domainCounts.map(([domain, task_count]) => ({
  scoring_version: '1.0.2',
  domain,
  weight: 0.1,
  task_count,
}));

const radar = [
  {
    node_id: `node_${'b'.repeat(64)}`,
    name: 'Published East Runner',
    operator: 'AIQ production fixture operator',
    public_key_fingerprint: provenanceHash,
    registry_trust: 'trusted_verified',
    registry_status: 'active',
    last_seen_at: '2026-07-29T15:58:00.000Z',
    synthetic: false,
    latest_capability_schema_version: 'aiq.distributed-capability.v1',
    latest_capability_hash: `sha256:${'c'.repeat(64)}`,
    latest_capability_status: 'validated',
    latest_capability_signature_status: 'verified',
    latest_capability_observed_at: '2026-07-29T15:55:00.000Z',
    latest_observation_schema_version: 'aiq.distributed-observation.v1',
    latest_observation_state: 'ready',
    latest_observation_sequence: 42,
    latest_observation_hash: `sha256:${'d'.repeat(64)}`,
    latest_observation_status: 'accepted',
    latest_observation_signature_status: 'verified',
    latest_observation_observed_at: '2026-07-29T15:58:00.000Z',
    latest_observation_provenance_hash: `sha256:${'e'.repeat(64)}`,
    assignment_total_count: 12,
    assignment_offered_count: 0,
    assignment_accepted_count: 0,
    assignment_running_count: 0,
    assignment_completed_count: 12,
    assignment_revoked_count: 0,
    assignment_expired_count: 0,
    receipt_total_count: 12,
    receipt_received_count: 0,
    receipt_accepted_count: 12,
    receipt_rejected_count: 0,
    receiver_verified_trusted_count: 12,
    signed_untrusted_count: 0,
    rejected_count: 0,
    missing_count: 0,
    aggregated_at: '2026-07-29T15:59:00.000Z',
  },
];

/**
 * @param {string} recordedAt
 */
function trendBucket(recordedAt) {
  const bucketStartedAt = new Date(recordedAt);
  bucketStartedAt.setUTCMinutes(0, 0, 0);
  return {
    bucketStartedAt: bucketStartedAt.toISOString(),
    bucketEndedAt: new Date(bucketStartedAt.getTime() + 3_600_000).toISOString(),
  };
}

const currentTrends = leaderboard.map((current) => {
  const { bucketStartedAt, bucketEndedAt } = trendBucket(currentRunCompletedAt);
  return {
    matrix_id: current.matrix_id,
    run_id: current.run_id,
    scoring_version: current.scoring_version,
    recorded_at: currentRunCompletedAt,
    bucket_started_at: bucketStartedAt,
    bucket_ended_at: bucketEndedAt,
    score: current.score,
    sensitivity_low: current.sensitivity_low,
    sensitivity_high: current.sensitivity_high,
    sample_size: current.sample_size,
    represented_run_count: 1,
    resolution_seconds: 3_600,
    synthetic: false,
  };
});

const trendDates = [currentRunCompletedAt];
const trends = currentTrends;

if (new Set(trends.map((point) => point.run_id)).size !== trends.length) {
  throw new Error('Every retained trend point must have one independent run identity.');
}
for (const point of trends) {
  const run = runRows.find((candidate) => candidate.id === point.run_id);
  if (
    !run ||
    run.matrix_id !== point.matrix_id ||
    run.synthetic ||
    point.synthetic ||
    Date.parse(run.started_at) > Date.parse(run.completed_at) ||
    Date.parse(run.completed_at) > Date.parse(point.recorded_at)
  ) {
    throw new Error('Retained trend evidence must bind one time-valid non-synthetic run.');
  }
}
for (const current of leaderboard) {
  const retained = trends.filter((point) => point.matrix_id === current.matrix_id);
  retained.sort((left, right) => right.recorded_at.localeCompare(left.recorded_at));
  const latest = retained[0];
  if (
    !latest ||
    latest.run_id !== current.run_id ||
    latest.score !== current.score ||
    latest.sensitivity_low !== current.sensitivity_low ||
    latest.sensitivity_high !== current.sensitivity_high ||
    latest.sample_size !== current.sample_size
  ) {
    throw new Error('The latest retained trend point must equal its current leaderboard row.');
  }
}

for (const evidence of currentRunEvidence) {
  const current = leaderboard.find((row) => row.run_id === evidence.runId);
  if (
    !current ||
    current.score !== Number(equalDomainAiq(evidence.results).toFixed(3)) ||
    current.score !== evidence.interval.center ||
    current.sensitivity_low !== evidence.interval.lower ||
    current.sensitivity_high !== evidence.interval.upper ||
    current.sensitivity_low > current.score ||
    current.sensitivity_high < current.score
  ) {
    throw new Error('Current leaderboard values must derive from their exact task evidence.');
  }
}

const rpcContract = Object.entries(REQUIRED_RPC_CONTRACT).map(([name, contract]) => ({
  name,
  arguments: contract.arguments,
  result: contract.result,
  default_count: contract.defaultCount,
  argument_modes: contract.modes,
  executable_roles: contract.grants,
}));

/**
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} value
 * @param {number} [status]
 */
function json(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {string | null}
 */
function decodeRole(request) {
  const authorization = request.headers.authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const encodedPayload = token.split('.')[1];
  if (!encodedPayload) return null;
  try {
    /** @type {unknown} */
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    if (!('role' in payload)) return null;
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * @template T
 * @param {URL} url
 * @param {readonly T[]} rows
 * @returns {T[]}
 */
function limited(url, rows) {
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  return Number.isSafeInteger(limit) && limit >= 0 ? rows.slice(0, limit) : [...rows];
}

/**
 * @param {string} range
 */
function trendRowsForRange(range) {
  const dateCount = range === 'day' ? 1 : range === 'week' ? 2 : range === 'month' ? 4 : 5;
  const allowedDates = new Set(trendDates.slice(0, dateCount));
  return trends.filter((point) => allowedDates.has(point.recorded_at));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') {
    json(response, { status: 'ok' });
    return;
  }
  if (url.pathname === '/storage/v1/bucket') {
    json(response, [
      { name: 'aiq-submission-packages', public: false },
      { name: 'aiq-runner-artifacts', public: false },
    ]);
    return;
  }
  if (url.pathname === '/rest/v1/rpc/aiq_describe_web_rpc_contract') {
    json(response, rpcContract);
    return;
  }
  if (url.pathname === '/rest/v1/rpc/aiq_gateway_role_probe') {
    json(response, decodeRole(request));
    return;
  }
  if (url.pathname === '/rest/v1/rpc/public_trend_points') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      /** @type {unknown} */
      const payload = JSON.parse(body || '{}');
      const suppliedRange =
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        'supplied_range' in payload
          ? payload.supplied_range
          : undefined;
      const range = typeof suppliedRange === 'string' ? suppliedRange : 'all';
      json(response, trendRowsForRange(range));
    });
    return;
  }
  if (url.pathname === '/rest/v1/public_model_matrix') {
    json(response, limited(url, matrix));
    return;
  }
  if (url.pathname === '/rest/v1/public_leaderboard') {
    json(response, limited(url, leaderboard));
    return;
  }
  if (url.pathname === '/rest/v1/public_runs') {
    const idFilter = url.searchParams.get('id') ?? '';
    const exactId = idFilter.startsWith('eq.') ? idFilter.slice(3) : undefined;
    const selectedIds = new Set(
      idFilter.startsWith('in.(') ? idFilter.slice(4, -1).split(',').filter(Boolean) : [],
    );
    const exactStartedAt = url.searchParams.get('started_at')?.replace(/^eq\./, '');
    const cursorExpression = url.searchParams.get('or') ?? '';
    const olderStartedAt = /started_at\.lt\.([^,)]+)/.exec(cursorExpression)?.[1];
    const newerStartedAt = /started_at\.gt\.([^,)]+)/.exec(cursorExpression)?.[1];
    const boundaryStartedAt = /started_at\.eq\.([^,)]+)/.exec(cursorExpression)?.[1];
    const olderId = /id\.gt\.([^,)]+)/.exec(cursorExpression)?.[1];
    const newerId = /id\.lt\.([^,)]+)/.exec(cursorExpression)?.[1];
    const ordered = [...runRows];
    const ascending = (url.searchParams.get('order') ?? '').includes('started_at.asc');
    ordered.sort(
      (left, right) =>
        (ascending
          ? left.started_at.localeCompare(right.started_at)
          : right.started_at.localeCompare(left.started_at)) ||
        (ascending ? right.id.localeCompare(left.id) : left.id.localeCompare(right.id)),
    );
    const rows =
      selectedIds.size > 0
        ? ordered.filter((run) => selectedIds.has(run.id))
        : exactId
          ? ordered.filter(
              (run) => run.id === exactId && (!exactStartedAt || run.started_at === exactStartedAt),
            )
          : ordered.filter((run) => {
              if (olderStartedAt) {
                return (
                  run.started_at < olderStartedAt ||
                  (run.started_at === boundaryStartedAt && (!olderId || run.id > olderId))
                );
              }
              if (newerStartedAt) {
                return (
                  run.started_at > newerStartedAt ||
                  (run.started_at === boundaryStartedAt && (!newerId || run.id < newerId))
                );
              }
              return true;
            });
    const selectedRows =
      url.searchParams.get('select') === 'id,started_at'
        ? rows.map(({ id, started_at }) => ({ id, started_at }))
        : rows;
    json(response, limited(url, selectedRows));
    return;
  }
  if (url.pathname === '/rest/v1/public_run_results') {
    const runIdFilter = url.searchParams.get('run_id') ?? '';
    const selectedIds = new Set(
      runIdFilter
        .replace(/^in\.\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .filter(Boolean),
    );
    const rows =
      selectedIds.size === 0
        ? runResults
        : runResults.filter((result) => selectedIds.has(result.run_id));
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_scoring_versions') {
    const wantsObject = request.headers.accept?.includes('application/vnd.pgrst.object+json');
    json(response, wantsObject ? scoringVersion : limited(url, [scoringVersion]));
    return;
  }
  if (url.pathname === '/rest/v1/public_task_coverage') {
    json(response, limited(url, taskCoverage));
    return;
  }
  if (url.pathname === '/rest/v1/public_calibration_runs') {
    const exactId = url.searchParams.get('run_id')?.replace(/^eq\./, '');
    const exactStartedAt = url.searchParams.get('started_at')?.replace(/^eq\./, '');
    const rows = (emptyCalibrationEvidence ? [] : [subsetCalibrationRun, calibrationRun]).filter(
      (run) =>
        (!exactId || run.run_id === exactId) &&
        (!exactStartedAt || run.started_at === exactStartedAt),
    );
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_calibration_results') {
    const exactRunId = url.searchParams.get('run_id')?.replace(/^eq\./, '');
    const family = url.searchParams.get('model_family')?.replace(/^eq\./, '');
    const effort = url.searchParams.get('reasoning_effort')?.replace(/^eq\./, '');
    const rows = calibrationResults.filter(
      (result) =>
        (!exactRunId || result.run_id === exactRunId) &&
        (!family || result.model_family === family) &&
        (!effort || result.reasoning_effort === effort),
    );
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_calibration_scores') {
    const exactRunId = url.searchParams.get('run_id')?.replace(/^eq\./, '');
    const rows = exactRunId
      ? historicalCalibrationScores.filter((score) => score.run_id === exactRunId)
      : historicalCalibrationScores;
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_model_efficiency') {
    const runIdFilter = url.searchParams.get('run_id') ?? '';
    const selectedIds = new Set(
      runIdFilter
        .replace(/^in\.\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .filter(Boolean),
    );
    const rows =
      selectedIds.size === 0
        ? publishedModelEfficiency
        : publishedModelEfficiency.filter((entry) => selectedIds.has(entry.run_id));
    json(response, limited(url, rows));
    return;
  }
  if (url.pathname === '/rest/v1/public_distributed_radar') {
    json(response, limited(url, radar));
    return;
  }
  if (url.pathname === '/rest/v1/public_nodes') {
    json(response, []);
    return;
  }
  json(response, { message: 'not found' }, 404);
});

server.listen(port, '127.0.0.1');
