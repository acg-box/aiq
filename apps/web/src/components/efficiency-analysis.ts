export interface EfficiencyCoordinate {
  key: string;
  comparisonGroup: string;
  x: number;
  y: number;
}

/**
 * Return the nondominated points within each explicitly comparable group.
 * A point dominates another when it is no more expensive or slow, no lower
 * scoring, and strictly better on at least one axis.
 */
export function paretoEfficientKeys(points: readonly EfficiencyCoordinate[]): ReadonlySet<string> {
  return new Set(
    points.flatMap((point) => {
      const dominated = points.some(
        (candidate) =>
          candidate.key !== point.key &&
          candidate.comparisonGroup === point.comparisonGroup &&
          candidate.x <= point.x &&
          candidate.y >= point.y &&
          (candidate.x < point.x || candidate.y > point.y),
      );
      return dominated ? [] : [point.key];
    }),
  );
}
