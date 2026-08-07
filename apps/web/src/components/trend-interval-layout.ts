export type TrendChartMode = 'line' | 'bar';

export const TREND_BAR_MAX_WIDTH = 14;

export interface TrendIntervalPoint {
  readonly entryId: string;
  readonly recordedAt: string;
  readonly intervalLow: number;
  readonly intervalHigh: number;
}

export interface TrendBarLayoutItem {
  readonly offsetCenter: number;
}

export interface TrendIntervalLineShape {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export function trendIntervalData(
  points: readonly TrendIntervalPoint[],
  entryId: string,
): ReadonlyArray<readonly [number, number, number]> {
  return points
    .filter((point) => point.entryId === entryId)
    .map(
      (point) =>
        [new Date(point.recordedAt).getTime(), point.intervalLow, point.intervalHigh] as const,
    );
}

export function trendIntervalXOffset(
  mode: TrendChartMode,
  seriesIndex: number,
  barLayout: readonly TrendBarLayoutItem[] | null | undefined,
): number | null {
  if (mode === 'line') return 0;
  const offset = barLayout?.[seriesIndex]?.offsetCenter;
  return typeof offset === 'number' && Number.isFinite(offset) ? offset : null;
}

export function trendIntervalLineShapes(
  low: readonly [number, number],
  high: readonly [number, number],
  xOffset: number,
  capHalfWidth = 2.5,
): readonly TrendIntervalLineShape[] {
  const x = low[0] + xOffset;
  return [
    { x1: x, y1: low[1], x2: x, y2: high[1] },
    { x1: x - capHalfWidth, y1: low[1], x2: x + capHalfWidth, y2: low[1] },
    { x1: x - capHalfWidth, y1: high[1], x2: x + capHalfWidth, y2: high[1] },
  ];
}
