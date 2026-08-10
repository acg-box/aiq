import { configurationFrontierKeys } from './configuration-decision.ts';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';

export interface ConfigurationThreePoint {
  id: string;
  label: string;
  family: 'Sol' | 'Terra' | 'Luna';
  score: number;
  durationMs: number;
  costUsd: number;
  frontier: boolean;
}

export interface ConfigurationThreeScale {
  durationMinimumMs: number;
  durationMaximumMs: number;
  costMinimumUsd: number;
  costMaximumUsd: number;
}

export interface ProjectedConfigurationThreePoint extends ConfigurationThreePoint {
  x: number;
  y: number;
  z: number;
}

export function resolveConfigurationThreePoints(
  rows: readonly ExactEfficiencyRow[],
  frontierRows: readonly ExactEfficiencyRow[] = rows,
): readonly ConfigurationThreePoint[] {
  const frontier = configurationFrontierKeys(frontierRows);
  return rows.flatMap(({ entry, row }) => {
    const durationMs = row.summedCellAdapterElapsedMs;
    const costNanos = row.standardApiEquivalentUsdNanos;
    if (durationMs === null || row.costEstimatorStatus !== 'estimated' || costNanos === null) {
      return [];
    }
    return [
      {
        id: entry.id,
        label: `${entry.modelFamily} · ${entry.reasoningTier}`,
        family: entry.modelFamily,
        score: entry.score,
        durationMs,
        costUsd: costNanos / 1_000_000_000,
        frontier: frontier.has(entry.id),
      },
    ];
  });
}

export function createConfigurationThreeScale(
  points: readonly ConfigurationThreePoint[],
): ConfigurationThreeScale | null {
  if (points.length === 0) return null;
  const durations = points.map(({ durationMs }) => durationMs);
  const costs = points.map(({ costUsd }) => costUsd);
  return {
    durationMinimumMs: Math.min(...durations),
    durationMaximumMs: Math.max(...durations),
    costMinimumUsd: Math.min(...costs),
    costMaximumUsd: Math.max(...costs),
  };
}

function normalize(value: number, minimum: number, maximum: number): number {
  return maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 2 - 1;
}

export function projectConfigurationThreePoint(
  point: ConfigurationThreePoint,
  scale: ConfigurationThreeScale,
): ProjectedConfigurationThreePoint {
  return {
    ...point,
    x: normalize(point.durationMs, scale.durationMinimumMs, scale.durationMaximumMs),
    y: (Math.min(100, Math.max(0, point.score)) / 100) * 2 - 1,
    z: normalize(point.costUsd, scale.costMinimumUsd, scale.costMaximumUsd),
  };
}
