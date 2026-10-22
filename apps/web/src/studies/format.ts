import type { ComparisonGroup, MetricValue } from './types.ts';

export function formatMetric(
  value: MetricValue | undefined,
  metric: ComparisonGroup['metrics'][number],
): string {
  if (value === null || value === undefined) return metric.unavailableReason ?? 'Not measured';
  if (typeof value === 'object') return `${value.pass}/${value.total}`;
  if (typeof value === 'string') return value;
  if (metric.unit === 'usd') return `$${value.toFixed(metric.precision ?? 9)}`;
  if (metric.unit === 'seconds') return `${value.toFixed(metric.precision ?? 3)} s`;
  return new Intl.NumberFormat('en-US').format(value);
}

export function studyDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
