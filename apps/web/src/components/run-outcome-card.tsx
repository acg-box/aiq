import Link from 'next/link';

import { formatAnyCreditRate, summarizeRunDomains, summarizeRunOutcomes } from '../data/format.ts';
import type { BenchmarkRun } from '../data/types.ts';

export function RunOutcomeCard({ run }: { run: BenchmarkRun }) {
  const outcomes = summarizeRunOutcomes(run);
  const domains = summarizeRunDomains(run);
  const segments = [
    { key: 'correct', label: 'Correct', count: outcomes.correct },
    { key: 'partial', label: 'Partial', count: outcomes.partial },
    { key: 'incorrect', label: 'Incorrect', count: outcomes.incorrect },
    { key: 'runtime', label: 'Runtime issues', count: outcomes.runtimeIssues },
    { key: 'invalid', label: 'Invalid', count: outcomes.invalid },
    { key: 'missing', label: 'Missing', count: outcomes.missing },
    { key: 'not-applicable', label: 'N/A', count: outcomes.notApplicable },
  ] as const;
  return (
    <section className="outcome-card" aria-labelledby="outcome-card-heading">
      <div className="outcome-card-heading">
        <div>
          <span className="eyebrow">What the score contains</span>
          <h2 id="outcome-card-heading">Task outcomes, not model IQ</h2>
        </div>
        <strong className="outcome-rate">
          {formatAnyCreditRate(outcomes.anyCreditRate)}
          <small>completed tasks earning any credit</small>
        </strong>
      </div>
      <p className="outcome-card-copy">
        AIQ is the equal-weight average of ten task domains. The rate above counts completed tasks
        marked correct or partial; it is not a score-weighted percentage or the AIQ index. Runtime,
        invalid, missing, and not-applicable cells remain separate.
      </p>
      <dl
        className="outcome-grid"
        aria-label={`Exact task outcome states; ${outcomes.total} total`}
      >
        {segments.map((segment) => (
          <div key={segment.key}>
            <dt>{segment.label}</dt>
            <dd>{segment.count}</dd>
          </div>
        ))}
      </dl>
      <section className="outcome-domain-disclosure" aria-labelledby="domain-matrix-heading">
        <div className="domain-matrix-heading">
          <span className="eyebrow">Domain matrix</span>
          <h3 id="domain-matrix-heading">Domain profile for this configuration</h3>
        </div>
        <div className="table-scroll outcome-domain-table" tabIndex={0}>
          <table>
            <caption>
              Exact domain scores and execution-state counts for this configuration.
            </caption>
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">AIQ</th>
                <th scope="col">Completed</th>
                <th scope="col">Runtime</th>
                <th scope="col">Invalid / missing / N/A</th>
                <th scope="col">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((domain) => (
                <tr key={domain.domain}>
                  <th scope="row">{domain.domain.replaceAll('_', ' ')}</th>
                  <td>{domain.score === null ? '—' : domain.score.toFixed(1)}</td>
                  <td>{domain.completed}</td>
                  <td>{domain.runtimeIssues}</td>
                  <td>
                    {domain.invalid} / {domain.missing} / {domain.notApplicable}
                  </td>
                  <td>{domain.coveragePercent.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine-print domain-score-note">
          A zero here is a valid scored outcome for this fixed fixture, not missing data. Missing,
          invalid, not-applicable, and runtime-issue cells are reported separately above.
        </p>
      </section>
      <p className="fine-print">
        {outcomes.total} task cells in this configuration ·{' '}
        {run.synthetic ? 'synthetic seed data' : 'published evidence'} ·{' '}
        <Link href={`/runs/${run.id}`}>inspect every task</Link>
      </p>
    </section>
  );
}
