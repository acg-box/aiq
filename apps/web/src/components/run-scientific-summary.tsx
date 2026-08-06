import type { RunScientificSummary } from './scientific-score-context.ts';

const fields: ReadonlyArray<[keyof RunScientificSummary, string]> = [
  ['aiq', 'AIQ'],
  ['interval', 'Task-sensitivity interval'],
  ['sampleSize', 'n'],
  ['coverage', 'Coverage'],
  ['runtime', 'Runtime issues'],
  ['missing', 'Missing'],
  ['scoring', 'Scoring'],
  ['provenance', 'Provenance'],
  ['adapterDuration', 'Summed adapter duration'],
  ['batchWallClock', 'Batch wall-clock'],
  ['cost', 'API-equivalent cost'],
  ['metricCoverage', 'Time / cost coverage'],
];

export function RunScientificSummaryPanel({
  summary,
  compact = false,
}: {
  summary: RunScientificSummary;
  compact?: boolean;
}) {
  if (compact) {
    const primaryFields: ReadonlyArray<[keyof RunScientificSummary, string]> = [
      ['aiq', 'AIQ'],
      ['interval', 'Task sensitivity'],
      ['sampleSize', 'n'],
      ['coverage', 'Coverage'],
      ['runtime', 'Runtime issues'],
      ['missing', 'Missing'],
    ];
    const contextFields: ReadonlyArray<[keyof RunScientificSummary, string]> = [
      ['provenance', 'Provenance'],
      ['scoring', 'Scoring'],
      ['adapterDuration', 'Summed adapter duration'],
      ['batchWallClock', 'Batch wall-clock'],
      ['cost', 'API-equivalent cost'],
      ['metricCoverage', 'Time / cost coverage'],
    ];
    return (
      <div className="run-history-summary">
        <dl className="run-history-primary" aria-label="Run score and coverage">
          {primaryFields.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{summary[key]}</dd>
            </div>
          ))}
        </dl>
        <details className="run-history-context">
          <summary>Provenance, time, and cost</summary>
          <dl aria-label="Run provenance, time, and cost">
            {contextFields.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{summary[key]}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    );
  }
  const primaryFields: ReadonlyArray<[keyof RunScientificSummary, string]> = [
    ['aiq', 'AIQ'],
    ['interval', 'Task sensitivity'],
    ['coverage', 'Coverage'],
    ['runtime', 'Runtime issues'],
    ['adapterDuration', 'Adapter time'],
    ['cost', 'API-equivalent cost'],
  ];
  const evidenceFields = fields.filter(
    ([key]) => !primaryFields.some(([primaryKey]) => primaryKey === key),
  );
  return (
    <section className="scientific-run-card" aria-label="Run scientific summary">
      <dl className="scientific-run-summary">
        {primaryFields.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{summary[key]}</dd>
          </div>
        ))}
      </dl>
      <details className="run-scientific-context">
        <summary>Sample, scoring, provenance, and metric coverage</summary>
        <dl>
          {evidenceFields.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{summary[key]}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
