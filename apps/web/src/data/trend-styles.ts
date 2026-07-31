export interface TrendSeriesStyle {
  color: string;
  dashArray?: string;
  pattern: 'solid' | 'dashed' | 'dotted';
}

export const TREND_SERIES_STYLES: readonly TrendSeriesStyle[] = [
  { color: '#d9ff5b', pattern: 'solid' },
  { color: '#ff8b69', pattern: 'solid' },
  { color: '#79a9ff', pattern: 'solid' },
  { color: '#d697ff', pattern: 'solid' },
  { color: '#63e6be', pattern: 'solid' },
  { color: '#ffd166', pattern: 'solid' },
  { color: '#d9ff5b', dashArray: '4 2', pattern: 'dashed' },
  { color: '#ff8b69', dashArray: '4 2', pattern: 'dashed' },
  { color: '#79a9ff', dashArray: '4 2', pattern: 'dashed' },
  { color: '#d697ff', dashArray: '4 2', pattern: 'dashed' },
  { color: '#63e6be', dashArray: '4 2', pattern: 'dashed' },
  { color: '#ffd166', dashArray: '4 2', pattern: 'dashed' },
  { color: '#d9ff5b', dashArray: '1 2', pattern: 'dotted' },
  { color: '#ff8b69', dashArray: '1 2', pattern: 'dotted' },
  { color: '#79a9ff', dashArray: '1 2', pattern: 'dotted' },
  { color: '#d697ff', dashArray: '1 2', pattern: 'dotted' },
  { color: '#63e6be', dashArray: '1 2', pattern: 'dotted' },
];
