'use client';

import type { CoreResultDataset } from '../data/core-results.ts';
import { alphabetical } from '../display-order.ts';
import { comparisonColor } from '../data/comparison-palette.ts';
import { SectionLink } from './section-link.tsx';
import { TableNotes } from './table-notes.tsx';
import { useWorkspaceQuery } from './workspace-query.ts';

export const coreEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export function CoreComparisonMatrix({ dataset }: { dataset: CoreResultDataset }) {
  const { params, href } = useWorkspaceQuery();
  const models = alphabetical(
    [...new Set(dataset.rows.map(({ entry }) => entry.modelFamily))],
    (name) => name,
  );
  const minimum = Math.min(...dataset.rows.map(({ entry }) => entry.score));
  const maximum = Math.max(...dataset.rows.map(({ entry }) => entry.score));
  const selectedModel = params.get('model') ?? 'all';
  const selectedEffort = params.get('effort') ?? 'all';
  const filtered = selectedModel !== 'all' || selectedEffort !== 'all';
  return (
    <section className="core-comparison-overview" aria-labelledby="core-matrix-title">
      <div className="overview-heading overview-heading-actions">
        <div>
          <h2 id="core-matrix-title">Model × reasoning effort</h2>
          <p>Recorded ability. Select a value to filter the ranking.</p>
        </div>
        <SectionLink targetId="core-rankings">Ranked configurations ↓</SectionLink>
      </div>
      <table className="core-comparison-matrix">
        <caption className="sr-only">Recorded ability by model and reasoning effort</caption>
        <thead>
          <tr>
            <th scope="col">Effort</th>
            {models.map((model) => (
              <th scope="col" key={model}>
                <i
                  className="data-swatch"
                  style={{ background: comparisonColor(model) }}
                  aria-hidden="true"
                />
                {model}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {coreEfforts.map((effort) => (
            <tr key={effort}>
              <th scope="row">{effort}</th>
              {models.map((model) => {
                const entry = dataset.rows.find(
                  (row) => row.entry.modelFamily === model && row.entry.reasoningTier === effort,
                )?.entry;
                const matches =
                  entry &&
                  filtered &&
                  (selectedModel === 'all' || selectedModel === model) &&
                  (selectedEffort === 'all' || selectedEffort === effort);
                const strength = entry
                  ? 8 +
                    30 * (maximum === minimum ? 0.5 : (entry.score - minimum) / (maximum - minimum))
                  : 0;
                return (
                  <td
                    key={model}
                    data-in-scope={matches || undefined}
                    style={
                      entry
                        ? {
                            backgroundColor: `color-mix(in srgb, var(--plot-magnitude) ${strength}%, var(--paper))`,
                          }
                        : undefined
                    }
                  >
                    {entry ? (
                      <SectionLink
                        href={`${href({ dataset: dataset.id, model, effort })}#core-rankings`}
                        targetId="core-rankings"
                        label={`Compare ${model} ${effort} · ability ${entry.score.toFixed(3)}`}
                        current={selectedModel === model && selectedEffort === effort}
                        preserveVisibleTarget
                      >
                        {entry.score.toFixed(3)}
                      </SectionLink>
                    ) : (
                      <span aria-label={`${model} ${effort}: not measured`}>—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="core-matrix-scale"
        aria-label={`Ability color scale ${minimum.toFixed(3)} to ${maximum.toFixed(3)}`}
      >
        <span>{minimum.toFixed(3)}</span>
        <span aria-hidden="true" />
        <span>{maximum.toFixed(3)}</span>
      </div>
      <TableNotes label="AI Intelligence matrix" hint="Point estimates · — Not measured.">
        <p>
          All {dataset.rows.length} configurations stay visible here. Color compares point
          estimates; overlapping intervals in the ranking do not establish a statistical winner.
        </p>
      </TableNotes>
    </section>
  );
}
