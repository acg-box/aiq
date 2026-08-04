import Link from 'next/link';

import { summarizeRunDomains, summarizeRunOutcomes } from '../data/format.ts';
import type { BenchmarkRun } from '../data/types.ts';

export function RunOutcomeCard({ run }: { run: BenchmarkRun }) {
  const outcomes = summarizeRunOutcomes(run);
  const domains = summarizeRunDomains(run);
  const width = outcomes.total === 0 ? 0 : (outcomes.credited / outcomes.total) * 100;
  const partialWidth = outcomes.total === 0 ? 0 : (outcomes.partial / outcomes.total) * 100;
  const incorrectWidth = outcomes.total === 0 ? 0 : (outcomes.incorrect / outcomes.total) * 100;
  const executionWidth = outcomes.total === 0 ? 0 : (outcomes.runtimeIssues / outcomes.total) * 100;

  return (
    <section className="outcome-card" aria-labelledby="outcome-card-heading">
      <div className="outcome-card-heading">
        <div>
          <span className="eyebrow">What the score contains</span>
          <h2 id="outcome-card-heading">Task outcomes, not model IQ</h2>
        </div>
        <strong className="outcome-rate">
          {outcomes.successRate === null ? '—' : `${outcomes.successRate.toFixed(0)}%`}
          <small>credit among completed outcomes</small>
        </strong>
      </div>
      <p className="outcome-card-copy">
        AIQ is the equal-weight average of ten task domains. The rate above uses completed semantic
        outcomes only; runtime, invalid, missing, and not-applicable cells stay separate. Partial
        credit remains visible below.
      </p>
      <div
        className="outcome-stack"
        role="img"
        aria-label={`Task outcomes: ${outcomes.correct} correct, ${outcomes.partial} partial, ${outcomes.incorrect} incorrect, ${outcomes.runtimeIssues} runtime issues`}
      >
        <span className="outcome-segment correct" style={{ width: `${width - partialWidth}%` }} />
        <span className="outcome-segment partial" style={{ width: `${partialWidth}%` }} />
        <span className="outcome-segment incorrect" style={{ width: `${incorrectWidth}%` }} />
        <span className="outcome-segment execution" style={{ width: `${executionWidth}%` }} />
      </div>
      <dl className="outcome-legend">
        <div>
          <dt>
            <span className="legend-dot correct" />
            Correct
          </dt>
          <dd>{outcomes.correct}</dd>
        </div>
        <div>
          <dt>
            <span className="legend-dot partial" />
            Partial
          </dt>
          <dd>{outcomes.partial}</dd>
        </div>
        <div>
          <dt>
            <span className="legend-dot incorrect" />
            Incorrect
          </dt>
          <dd>{outcomes.incorrect}</dd>
        </div>
        <div>
          <dt>
            <span className="legend-dot execution" />
            Runtime issues
          </dt>
          <dd>{outcomes.runtimeIssues}</dd>
        </div>
      </dl>
      <section className="outcome-domain-disclosure" aria-labelledby="domain-matrix-heading">
        <div className="domain-matrix-heading">
          <span className="eyebrow">Domain matrix</span>
          <h3 id="domain-matrix-heading">Where the leader gains and loses ground</h3>
        </div>
        <div className="domain-score-bars" role="list" aria-label="Domain AIQ index scores">
          {domains.map((domain) => {
            const score = domain.score ?? 0;
            return (
              <div className="domain-score-row" key={domain.domain} role="listitem">
                <div className="domain-score-label">
                  <span>{domain.domain.replaceAll('_', ' ')}</span>
                  <strong>{domain.score === null ? '—' : `${score.toFixed(0)}%`}</strong>
                </div>
                <div className="domain-score-track" aria-hidden="true">
                  <span style={{ width: `${score}%` }} />
                </div>
                <small>
                  {domain.completed + domain.runtimeIssues}/{domain.total} observed ·{' '}
                  {domain.coveragePercent.toFixed(0)}% coverage
                </small>
              </div>
            );
          })}
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
