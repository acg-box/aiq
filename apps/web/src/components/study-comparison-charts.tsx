import { alphabetical } from '../display-order.ts';
import { formatMetric } from '../studies/format.ts';
import type { ComparisonGroup, Subject } from '../studies/types.ts';
import { ComparisonBars, comparisonMaximum } from './comparison-bars.tsx';
import { SectionLink } from './section-link.tsx';

export function StudyComparisonCharts({
  group,
  subjects,
}: {
  group: ComparisonGroup;
  subjects: Subject[];
}) {
  const hasQuality = group.metrics.some((metric) => metric.key === 'bound');
  const plots = ['bound', 'time', 'cost'].flatMap((key) => {
    const metric = group.metrics.find((candidate) => candidate.key === key);
    if (!metric) return [];
    const rows = alphabetical(
      group.results.map((result) => {
        const run = group.runs.find((candidate) => candidate.id === result.runId);
        const subject = subjects.find((candidate) => candidate.id === run?.subjectId);
        const recorded = result.values[key];
        const value =
          typeof recorded === 'number'
            ? recorded
            : recorded && typeof recorded === 'object' && recorded.total > 0
              ? recorded.pass / recorded.total
              : null;
        return {
          id: result.runId,
          label: subject?.label ?? result.runId,
          value,
          display: formatMetric(recorded, { ...metric, precision: key === 'cost' ? 6 : 2 }),
          configuration: subject?.configuration.effort ?? '',
        };
      }),
      (row) => row.label,
    );
    if (rows.every((row) => row.value === null)) return [];
    const maximum = key === 'bound' ? 1 : comparisonMaximum(rows.map((row) => row.value));
    return [{ key, rows, maximum }];
  });
  const missing = ['time', 'cost'].filter((key) => !plots.some((plot) => plot.key === key));
  return (
    <section className="comparison-dashboard" aria-label="Study performance charts">
      <div className="comparison-heading">
        <div>
          <h2 className="sr-only">
            {hasQuality ? 'Answer quality, time and cost' : 'Writer time and cost'}
          </h2>
          <p>
            {hasQuality
              ? 'Compare complete, source-bound answers first, then the resources used.'
              : 'Resource use for the same inputs. Semantic writer quality was not measured.'}
          </p>
        </div>
        <SectionLink targetId="memory-rankings">Results &amp; evidence ↓</SectionLink>
      </div>
      <div className="comparison-plots" data-plots={plots.length}>
        {plots.map((plot) => (
          <ComparisonBars
            key={plot.key}
            layout="columns"
            title={
              plot.key === 'bound'
                ? 'Complete + bound'
                : plot.key === 'time'
                  ? 'Mean time'
                  : 'Settled cost'
            }
            description={
              plot.key === 'bound'
                ? 'Answers · higher is better'
                : plot.key === 'time'
                  ? 'Seconds / input · lower is better'
                  : 'USD / test · lower is better'
            }
            rows={plot.rows}
            maximum={plot.maximum}
            maximumLabel={
              plot.key === 'bound'
                ? '100%'
                : plot.key === 'cost'
                  ? `$${Number(plot.maximum.toPrecision(2))}`
                  : `${Number(plot.maximum.toPrecision(2))} s`
            }
          />
        ))}
      </div>
      {missing.length > 0 ? (
        <p className="research-caption comparison-limits">
          {missing
            .map((key) => {
              const label = key === 'time' ? 'Time' : 'Cost';
              const reason = group.metrics.find((metric) => metric.key === key)?.unavailableReason;
              return reason ? `${label}: ${reason.toLowerCase()}.` : `${label} not recorded.`;
            })
            .join(' ')}
        </p>
      ) : null}
    </section>
  );
}
