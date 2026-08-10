import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';

export type ConfigurationPriority = 'ability' | 'time' | 'cost' | 'frontier';

export interface ConfigurationDecisionSummary {
  highestAbility: ExactEfficiencyRow | null;
  shortestTime: ExactEfficiencyRow | null;
  lowestCost: ExactEfficiencyRow | null;
  fullyMeasuredCount: number;
  frontierKeys: ReadonlySet<string>;
}

function durationValue({ row }: ExactEfficiencyRow): number | null {
  return row.summedCellAdapterElapsedMs;
}

function costValue({ row }: ExactEfficiencyRow): number | null {
  return row.costEstimatorStatus === 'estimated' ? row.standardApiEquivalentUsdNanos : null;
}

function compareNullableAscending(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
}

function stableIdentity(left: ExactEfficiencyRow, right: ExactEfficiencyRow): number {
  return left.entry.id.localeCompare(right.entry.id);
}

export function configurationFrontierKeys(
  rows: readonly ExactEfficiencyRow[],
): ReadonlySet<string> {
  const comparable = rows.filter(
    (candidate) => durationValue(candidate) !== null && costValue(candidate) !== null,
  );
  return new Set(
    comparable.flatMap((point) => {
      const pointDuration = durationValue(point);
      const pointCost = costValue(point);
      if (pointDuration === null || pointCost === null) return [];
      const dominated = comparable.some((candidate) => {
        if (candidate.entry.id === point.entry.id) return false;
        const candidateDuration = durationValue(candidate);
        const candidateCost = costValue(candidate);
        if (candidateDuration === null || candidateCost === null) return false;
        return (
          candidate.entry.score >= point.entry.score &&
          candidateDuration <= pointDuration &&
          candidateCost <= pointCost &&
          (candidate.entry.score > point.entry.score ||
            candidateDuration < pointDuration ||
            candidateCost < pointCost)
        );
      });
      return dominated ? [] : [point.entry.id];
    }),
  );
}

export function summarizeConfigurationDecisions(
  rows: readonly ExactEfficiencyRow[],
): ConfigurationDecisionSummary {
  const byAbility = rows.toSorted(
    (left, right) => right.entry.score - left.entry.score || stableIdentity(left, right),
  );
  const byTime = rows.toSorted(
    (left, right) =>
      compareNullableAscending(durationValue(left), durationValue(right)) ||
      right.entry.score - left.entry.score ||
      stableIdentity(left, right),
  );
  const byCost = rows.toSorted(
    (left, right) =>
      compareNullableAscending(costValue(left), costValue(right)) ||
      right.entry.score - left.entry.score ||
      stableIdentity(left, right),
  );
  const frontierKeys = configurationFrontierKeys(rows);
  return {
    highestAbility: byAbility[0] ?? null,
    shortestTime: byTime.find((candidate) => durationValue(candidate) !== null) ?? null,
    lowestCost: byCost.find((candidate) => costValue(candidate) !== null) ?? null,
    fullyMeasuredCount: rows.filter(
      (candidate) => durationValue(candidate) !== null && costValue(candidate) !== null,
    ).length,
    frontierKeys,
  };
}

export function orderConfigurationDecisions(
  rows: readonly ExactEfficiencyRow[],
  priority: ConfigurationPriority,
): readonly ExactEfficiencyRow[] {
  const summary = summarizeConfigurationDecisions(rows);
  const source =
    priority === 'frontier'
      ? rows.filter((candidate) => summary.frontierKeys.has(candidate.entry.id))
      : rows;
  return source.toSorted((left, right) => {
    if (priority === 'time') {
      return (
        compareNullableAscending(durationValue(left), durationValue(right)) ||
        right.entry.score - left.entry.score ||
        stableIdentity(left, right)
      );
    }
    if (priority === 'cost') {
      return (
        compareNullableAscending(costValue(left), costValue(right)) ||
        right.entry.score - left.entry.score ||
        stableIdentity(left, right)
      );
    }
    return (
      right.entry.score - left.entry.score ||
      compareNullableAscending(durationValue(left), durationValue(right)) ||
      compareNullableAscending(costValue(left), costValue(right)) ||
      stableIdentity(left, right)
    );
  });
}
