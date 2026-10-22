import { comparisonColor } from '../data/comparison-palette.ts';

export function CoreIntervalMark({
  subject,
  value,
  low,
  high,
  minimum,
  maximum,
}: {
  subject: string;
  value: number;
  low: number | null;
  high: number | null;
  minimum: number;
  maximum: number;
}) {
  const x = (point: number) => 3 + ((point - minimum) / (maximum - minimum)) * 194;
  return (
    <svg
      className="core-interval-mark"
      data-subject={subject}
      style={{ color: comparisonColor(subject) }}
      viewBox="0 0 200 16"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-low={low ?? undefined}
      data-high={high ?? undefined}
      data-value={value}
    >
      <path className="core-interval-guide" d="M 3 8 H 197" />
      {low !== null && high !== null ? (
        <path
          className="core-interval-line"
          d={`M ${x(low)} 8 H ${x(high)} M ${x(low)} 5 V 11 M ${x(high)} 5 V 11`}
        />
      ) : null}
      <path className="core-interval-point" d={`M ${x(value)} 8 h 0.01`} />
    </svg>
  );
}
