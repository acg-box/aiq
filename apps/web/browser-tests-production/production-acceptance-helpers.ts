export type AggregateCostShape = 'exact' | 'range' | 'unavailable';

const decimalUsdPattern = '\\$(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?';
const exactCostPattern = new RegExp(`^${decimalUsdPattern}(?:\\s|$)`);
const rangeCostPattern = new RegExp(`^${decimalUsdPattern}–${decimalUsdPattern}(?:\\s|$)`);

export function classifyAggregateCostText(text: string): AggregateCostShape {
  const value = text.trim();
  if (/^Unavailable(?:\s|$)/.test(value)) {
    if (/\$\d/.test(value)) throw new Error(`Invalid aggregate cost evidence: ${value}`);
    return 'unavailable';
  }
  if (rangeCostPattern.test(value)) return 'range';
  if (exactCostPattern.test(value)) return 'exact';
  throw new Error(`Invalid aggregate cost evidence: ${value || '<empty>'}`);
}

export function partitionProductionHistory(
  expectedRunHrefs: ReadonlySet<string>,
  observedRunHrefs: readonly string[],
): {
  currentRunHrefs: string[];
  historicalRunHrefs: string[];
  missingCurrentRunHrefs: string[];
} {
  const observed = new Set(observedRunHrefs);
  return {
    currentRunHrefs: observedRunHrefs.filter((href) => expectedRunHrefs.has(href)),
    historicalRunHrefs: observedRunHrefs.filter((href) => !expectedRunHrefs.has(href)),
    missingCurrentRunHrefs: [...expectedRunHrefs].filter((href) => !observed.has(href)),
  };
}
