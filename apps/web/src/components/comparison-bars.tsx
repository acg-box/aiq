import type { CSSProperties } from 'react';
import { comparisonColor, configurationStyle } from '../data/comparison-palette.ts';

export type ComparisonBar = {
  id: string;
  label: string;
  value: number | null;
  display: string;
  configuration?: string;
};

/** Small, directly labelled charts. The text is also the non-visual data path. */
export function ComparisonBars({
  title,
  description,
  rows,
  maximum,
  maximumLabel,
  layout = 'bars',
}: {
  title: string;
  description: string;
  rows: ComparisonBar[];
  maximum: number;
  maximumLabel: string;
  layout?: 'bars' | 'columns';
}) {
  return (
    <figure className="comparison-plot" data-layout={layout}>
      <figcaption>
        <h3>{title}</h3>
        <p>{description}</p>
      </figcaption>
      <div className="comparison-scale" aria-hidden="true">
        <span>0</span>
        <span>{maximumLabel}</span>
      </div>
      <ul className="comparison-bars" aria-label={`${title} by profile`}>
        {rows.map((row) => {
          const columnStyle: CSSProperties & {
            '--column-fraction': number;
            '--comparison-color': string;
          } = {
            '--column-fraction': (row.value ?? 0) / maximum,
            '--comparison-color': comparisonColor(row.label),
          };
          return (
            <li
              key={row.id}
              data-profile={row.id}
              data-pattern={configurationStyle(row.configuration ?? '').fill}
              data-value={row.value ?? 'missing'}
              style={columnStyle}
            >
              <div className="comparison-label">
                <span>{row.label}</span>
                <strong>{row.display}</strong>
              </div>
              <div
                className="comparison-track"
                aria-hidden="true"
                data-missing={row.value === null || undefined}
              >
                {row.value !== null ? (
                  <span
                    style={{
                      [layout === 'columns' ? 'height' : 'width']:
                        `${(row.value / maximum) * 100}%`,
                    }}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/** A rounded upper bound keeps non-ratio scales readable without clipping data. */
export function comparisonMaximum(values: (number | null)[]): number {
  const largest = Math.max(0, ...values.map((value) => value ?? 0));
  if (largest === 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(largest));
  return Math.ceil(largest / magnitude) * magnitude;
}
