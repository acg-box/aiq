import type { PublicModelEfficiency } from '../data/types.ts';

const JCS_SAFE_INTEGER = 9_007_199_254_740_991n;

export type ConfigurationCostEvidence =
  | {
      kind: 'exact';
      lowerUsdNanos: number;
      upperUsdNanos: number;
      pricedResultCount: number;
      resultCount: number;
    }
  | {
      kind: 'bounded';
      lowerUsdNanos: number;
      upperUsdNanos: number;
      pricedResultCount: number;
      resultCount: number;
    }
  | {
      kind: 'unavailable';
      reason: 'missing_usage' | 'invalid_usage' | 'missing_pricing';
      pricedResultCount: number;
      resultCount: number;
    };

function safeNanos(value: bigint): number | null {
  return value >= 0n && value <= JCS_SAFE_INTEGER ? Number(value) : null;
}

function boundedCost(row: PublicModelEfficiency): readonly [number, number] | null {
  const { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens } = row;
  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null
  ) {
    return null;
  }
  const input = BigInt(inputTokens);
  const cached = BigInt(cachedInputTokens);
  const cacheWrite = BigInt(cacheWriteInputTokens);
  const output = BigInt(outputTokens);
  const uncached = input - cached - cacheWrite;
  if (uncached < 0n) return null;

  const model = `gpt-5.6-${row.modelFamily}`;
  const rate = row.pricingRates.find((candidate) => candidate.model === model);
  if (!rate) return null;
  const standardInput =
    uncached * BigInt(rate.input_usd_nanos_per_token) +
    cached * BigInt(rate.cached_input_usd_nanos_per_token) +
    cacheWrite * BigInt(rate.cache_write_input_usd_nanos_per_token);
  const standardOutput = output * BigInt(rate.output_usd_nanos_per_token);
  const lower = safeNanos(standardInput + standardOutput);
  const upper = safeNanos(standardInput * 2n + (standardOutput * 3n) / 2n);
  return lower === null || upper === null ? null : [lower, upper];
}

export function resolveConfigurationCost(row: PublicModelEfficiency): ConfigurationCostEvidence {
  if (row.costEstimatorStatus === 'estimated' && row.standardApiEquivalentUsdNanos !== null) {
    return {
      kind: 'exact',
      lowerUsdNanos: row.standardApiEquivalentUsdNanos,
      upperUsdNanos: row.standardApiEquivalentUsdNanos,
      pricedResultCount: row.pricedResultCount,
      resultCount: row.resultCount,
    };
  }
  if (row.costEstimatorStatus === 'unavailable_context_band') {
    const range = boundedCost(row);
    if (range) {
      return {
        kind: 'bounded',
        lowerUsdNanos: range[0],
        upperUsdNanos: range[1],
        pricedResultCount: row.pricedResultCount,
        resultCount: row.resultCount,
      };
    }
    return {
      kind: 'unavailable',
      reason: 'missing_pricing',
      pricedResultCount: row.pricedResultCount,
      resultCount: row.resultCount,
    };
  }
  return {
    kind: 'unavailable',
    reason:
      row.costEstimatorStatus === 'unavailable_invalid_usage' ? 'invalid_usage' : 'missing_usage',
    pricedResultCount: row.pricedResultCount,
    resultCount: row.resultCount,
  };
}

export function formatUsdNanos(nanos: number): string {
  const dollars = nanos / 1_000_000_000;
  return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
}

export function formatConfigurationCost(cost: ConfigurationCostEvidence): string {
  if (cost.kind === 'unavailable') return 'Unavailable';
  if (cost.kind === 'exact') return formatUsdNanos(cost.lowerUsdNanos);
  return `${formatUsdNanos(cost.lowerUsdNanos)}–${formatUsdNanos(cost.upperUsdNanos)}`;
}

export function describeConfigurationCost(cost: ConfigurationCostEvidence): string {
  if (cost.kind === 'exact') return `${cost.resultCount}/${cost.resultCount} task costs exact`;
  if (cost.kind === 'bounded') {
    return `${cost.pricedResultCount}/${cost.resultCount} task costs exact · remainder bounded`;
  }
  if (cost.reason === 'invalid_usage') return 'Provider usage could not be validated';
  if (cost.reason === 'missing_pricing') return 'Published rate evidence is incomplete';
  return 'Provider token usage unavailable';
}

export function costUpperBoundNanos(row: PublicModelEfficiency): number | null {
  const cost = resolveConfigurationCost(row);
  return cost.kind === 'unavailable' ? null : cost.upperUsdNanos;
}
