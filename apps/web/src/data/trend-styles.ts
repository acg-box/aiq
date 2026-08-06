export interface TrendSeriesStyle {
  color: string;
  dashArray?: string;
  pattern: 'solid' | 'dashed' | 'dotted';
}

export const TREND_SERIES_STYLES: readonly TrendSeriesStyle[] = [
  { color: 'var(--series-1)', pattern: 'solid' },
  { color: 'var(--series-2)', pattern: 'solid' },
  { color: 'var(--series-3)', pattern: 'solid' },
  { color: 'var(--series-4)', pattern: 'solid' },
  { color: 'var(--series-5)', pattern: 'solid' },
  { color: 'var(--series-6)', pattern: 'solid' },
  { color: 'var(--series-1)', dashArray: '4 2', pattern: 'dashed' },
  { color: 'var(--series-2)', dashArray: '4 2', pattern: 'dashed' },
  { color: 'var(--series-3)', dashArray: '4 2', pattern: 'dashed' },
  { color: 'var(--series-4)', dashArray: '4 2', pattern: 'dashed' },
  { color: 'var(--series-5)', dashArray: '4 2', pattern: 'dashed' },
  { color: 'var(--series-6)', dashArray: '4 2', pattern: 'dashed' },
  { color: 'var(--series-1)', dashArray: '1 2', pattern: 'dotted' },
  { color: 'var(--series-2)', dashArray: '1 2', pattern: 'dotted' },
  { color: 'var(--series-3)', dashArray: '1 2', pattern: 'dotted' },
  { color: 'var(--series-4)', dashArray: '1 2', pattern: 'dotted' },
  { color: 'var(--series-5)', dashArray: '1 2', pattern: 'dotted' },
];
