import Link from 'next/link';

import { formatAnyCreditRate, summarizeRunDomains, summarizeRunOutcomes } from '../data/format.ts';
import type { BenchmarkRun } from '../data/types.ts';

function formatDomain(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function RunOutcomeCard({ run }: { run: BenchmarkRun }) {
  const outcomes = summarizeRunOutcomes(run);
  const domains = summarizeRunDomains(run);
  const availableScores = domains.flatMap((domain) =>
    domain.score === null ? [] : [domain.score],
  );
  const strongest = domains
    .filter((domain) => domain.score !== null)
    .toSorted((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];

  return (
    <section className="outcome-card analysis-panel" aria-labelledby="outcome-card-heading">
      <header className="panel-heading domain-profile-heading">
        <div>
          <h2 id="outcome-card-heading">Domain profile</h2>
          <p>
            {run.entryId.replace('-', ' ')} · equal weight across {domains.length} practical-work
            domains
          </p>
        </div>
        <div className="domain-profile-summary">
          <span>Strongest observed domain</span>
          <strong>{strongest ? formatDomain(strongest.domain) : 'Unavailable'}</strong>
        </div>
      </header>

      {availableScores.length === 0 ? (
        <p className="empty-note">No scored domain observations are available for this run.</p>
      ) : (
        <div className="domain-bars" role="img" aria-label="Average task score by benchmark domain">
          {domains.map((domain) => (
            <div className="domain-bar-row" key={domain.domain}>
              <span>{formatDomain(domain.domain)}</span>
              <div className="domain-bar-track" aria-hidden="true">
                <i style={{ width: `${Math.max(0, Math.min(100, domain.score ?? 0))}%` }} />
              </div>
              <strong>{domain.score === null ? '—' : domain.score.toFixed(1)}</strong>
              <small>{domain.coveragePercent.toFixed(0)}% cov.</small>
            </div>
          ))}
        </div>
      )}

      <div className="outcome-summary-row" aria-label={`${outcomes.total} exact task outcomes`}>
        <div>
          <span>Any credit</span>
          <strong>{formatAnyCreditRate(outcomes.anyCreditRate)}</strong>
        </div>
        <div>
          <span>Correct</span>
          <strong>{outcomes.correct}</strong>
        </div>
        <div>
          <span>Partial</span>
          <strong>{outcomes.partial}</strong>
        </div>
        <div>
          <span>Incorrect</span>
          <strong>{outcomes.incorrect}</strong>
        </div>
        <div>
          <span>Runtime / invalid</span>
          <strong>{outcomes.runtimeIssues + outcomes.invalid}</strong>
        </div>
        <div>
          <span>Missing / N/A</span>
          <strong>{outcomes.missing + outcomes.notApplicable}</strong>
        </div>
      </div>

      <p className="panel-footnote">
        Any-credit rate counts correct or partial completed tasks; it is not calibrated ability or
        strict pass. A zero is a scored outcome, not missing data.{' '}
        <Link href={`/runs/${run.id}`}>Inspect every task</Link>
      </p>
    </section>
  );
}
