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
  return (
    <dl className="scientific-run-summary" aria-label="Run scientific summary">
      {fields.map(([key, label]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{summary[key]}</dd>
        </div>
      ))}
    </dl>
  );
}
