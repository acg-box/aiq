import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DataNote } from '../../../components/data-note.tsx';
import { OfficialEfficiencyTable } from '../../../components/official-efficiency-table.tsx';
import { ReadStateNote } from '../../../components/read-state-note.tsx';
import {
  classifyRunCompleteness,
  summarizeRun,
  summarizeRunDomains,
} from '../../../data/format.ts';
import { readPublicData, readPublicValue } from '../../../data/read-state.ts';
import { createAiqRepository } from '../../../data/repository.ts';

export const metadata: Metadata = { title: 'Run detail' };
export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repository = createAiqRepository();
  const [runResult, leaderboardResult] = await Promise.all([
    readPublicValue(
      repository,
      () => repository.getRun(id),
      (value) => (value ? [value.synthetic] : []),
    ),
    readPublicData(
      repository,
      () => repository.listLeaderboard(),
      [],
      (value) => value.length === 0,
      (value) => value.map((entry) => entry.synthetic),
    ),
  ]);
  if (runResult.state === 'unavailable') {
    return (
      <section className="page-shell inner-page">
        <div className="page-intro">
          <span className="eyebrow">Run evidence</span>
          <h1>Run evidence is unavailable.</h1>
          <p>The configured public data source could not be read.</p>
        </div>
        <ReadStateNote result={runResult} />
      </section>
    );
  }
  const run = runResult.data;
  if (!run) {
    notFound();
  }
  const leaderboard = leaderboardResult.data;
  const entry = leaderboard.find((candidate) => candidate.id === run.entryId);
  const summary = summarizeRun(run);
  const domains = summarizeRunDomains(run);
  const completeness = classifyRunCompleteness(run);
  const efficiencyResult = await readPublicData(
    repository,
    () => (run.synthetic ? Promise.resolve([]) : repository.listModelEfficiency([run.id])),
    [],
    (value) => value.length === 0,
    (value) => value.map(() => false),
  );
  return (
    <section className="page-shell inner-page">
      <div className="run-heading">
        <div>
          <Link className="back-link" href="/runs">
            ← Back to run history
          </Link>
          <span className="eyebrow">Run evidence</span>
          <h1>
            {entry?.modelFamily ?? run.entryId} · {entry?.reasoningTier ?? 'unknown'}
          </h1>
          <p>
            {entry?.modelName} · started {new Date(run.startedAt).toLocaleString()}
          </p>
          <small>
            AIQ v1 fixed-fixture run ·{' '}
            {run.synthetic ? 'synthetic seed evidence' : 'published evidence'}
          </small>
        </div>
        <code>{run.id}</code>
      </div>
      <DataNote provenance={run.synthetic ? 'synthetic' : 'published'} />
      <p className="fine-print">
        Completeness: <strong>{completeness.label}</strong> ·{' '}
        {completeness.notApplicable
          ? 'The configuration was observed as unsupported before task execution.'
          : `${completeness.validResults}/72 valid results. Missing and invalid results block Official; any Provisional estimate is conditional and includes fixed-fixture completion bounds.`}
      </p>
      <div className="run-stats">
        <div>
          <span>Passed</span>
          <strong>{summary.passed}</strong>
        </div>
        <div>
          <span>Failed</span>
          <strong>{summary.failed}</strong>
        </div>
        <div>
          <span>Invalid</span>
          <strong>{summary.invalid}</strong>
        </div>
        <div>
          <span>Missing</span>
          <strong>{summary.missing}</strong>
        </div>
        <div>
          <span>N/A</span>
          <strong>{summary.notApplicable}</strong>
        </div>
        <div>
          <span>Median Codex adapter elapsed</span>
          <strong>
            {summary.medianLatencyMs === null
              ? '—'
              : `${(summary.medianLatencyMs / 1000).toFixed(1)} s`}
          </strong>
        </div>
      </div>
      <section className="run-section" aria-labelledby="run-efficiency-heading">
        <div className="section-heading compact">
          <div>
            <span className="eyebrow">Retained efficiency evidence</span>
            <h2 id="run-efficiency-heading">Official time, token coverage, and cost</h2>
          </div>
          <p>
            Codex adapter elapsed is runner-observed. Summed cell durations can overlap, while the
            signed matrix batch wall-clock is counted once. Neither value is isolated model latency.
          </p>
        </div>
        <ReadStateNote result={efficiencyResult} subject="Official run efficiency" />
        {efficiencyResult.state === 'published' ? (
          <OfficialEfficiencyTable rows={efficiencyResult.data} />
        ) : null}
      </section>
      <section className="run-section">
        <div className="section-heading compact">
          <div>
            <span className="eyebrow">Domain profile</span>
            <h2>Score and coverage by domain</h2>
          </div>
          <p>
            Scores use observed succeeded and failed attempts. Coverage keeps missing and invalid
            work in the denominator.
          </p>
        </div>
        <div
          className="table-scroll domain-summary"
          role="region"
          aria-label="Run domain summary"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">Observed score</th>
                <th scope="col">Coverage</th>
                <th scope="col">Succeeded</th>
                <th scope="col">Failed</th>
                <th scope="col">Missing</th>
                <th scope="col">Invalid</th>
                <th scope="col">N/A</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((domain) => (
                <tr key={domain.domain}>
                  <th scope="row">{domain.domain.replaceAll('_', ' ')}</th>
                  <td>{domain.score === null ? 'No score' : `${domain.score.toFixed(1)}%`}</td>
                  <td>
                    {domain.coveragePercent.toFixed(1)}% ({domain.succeeded + domain.failed}/
                    {domain.total})
                  </td>
                  <td>{domain.succeeded}</td>
                  <td>{domain.failed}</td>
                  <td>{domain.missing}</td>
                  <td>{domain.invalid}</td>
                  <td>{domain.notApplicable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="run-section">
        <div className="section-heading compact">
          <div>
            <span className="eyebrow">Task results</span>
            <h2>Outcome by domain</h2>
          </div>
          <p>Failure and missing states include machine-readable codes and human explanations.</p>
        </div>
        <div className="task-list">
          {run.tasks.map((task) => (
            <article key={task.id}>
              <header>
                <span className={`result result-${task.status}`}>
                  {task.status.replace('_', ' ')}
                </span>
                <strong>
                  {task.score === null ? 'No score' : `${(task.score * 100).toFixed(0)}%`}
                </strong>
              </header>
              <span className="eyebrow">{task.domain}</span>
              <h3>{task.task}</h3>
              {task.explanation ? (
                <div className="result-explanation">
                  <code>{task.explanation.code}</code>
                  <p>{task.explanation.summary}</p>
                  <small>Retryable: {task.explanation.retryable ? 'yes' : 'no'}</small>
                </div>
              ) : task.status !== 'passed' ? (
                <div className="result-explanation">
                  <code>EXPLANATION_NOT_PUBLISHED</code>
                  <p>No public explanation was supplied for this outcome.</p>
                  <small>Retryability is not published.</small>
                </div>
              ) : null}
              <footer>
                <span>Tools: {task.tools.length > 0 ? task.tools.join(', ') : 'none'}</span>
                <span>
                  Codex adapter elapsed:{' '}
                  {task.latencyMs === null
                    ? 'unavailable'
                    : `${task.latencyMs.toLocaleString()} ms · ${task.latencyEvidenceLevel?.replaceAll('_', '-')}`}
                </span>
                <span>
                  Tokens: input {task.inputTokens?.toLocaleString() ?? 'unavailable'} · cached input{' '}
                  {task.cachedInputTokens?.toLocaleString() ?? 'unavailable'} · cache-write input{' '}
                  {task.cacheWriteInputTokens?.toLocaleString() ?? 'unavailable'} · output{' '}
                  {task.outputTokens?.toLocaleString() ?? 'unavailable'} · reasoning{' '}
                  {task.reasoningOutputTokens?.toLocaleString() ?? 'unavailable'} · total{' '}
                  {task.totalTokens?.toLocaleString() ?? 'unavailable'}
                </span>
                <span>
                  API-equivalent cost:{' '}
                  {task.standardApiEquivalentUsdNanos === null
                    ? task.costEstimatorStatus.replaceAll('_', ' ')
                    : `$${(task.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(6)}`}{' '}
                  · token evidence{' '}
                  {task.tokenUsageEvidenceLevel?.replaceAll('_', '-') ?? 'unavailable'} · cost
                  evidence {task.costEvidenceLevel?.replaceAll('_', '-') ?? 'unavailable'}
                </span>
              </footer>
            </article>
          ))}
        </div>
      </section>
      <section className="provenance-panel" aria-labelledby="run-provenance-heading">
        <h2 id="run-provenance-heading">Run provenance</h2>
        <div>
          <span>Benchmark</span>
          <code>{run.benchmarkVersion}</code>
        </div>
        <div>
          <span>Scoring</span>
          <code>{run.scoringVersion}</code>
        </div>
        <div>
          <span>Prompt set</span>
          <code>{run.promptSetDigest}</code>
        </div>
        <div>
          <span>Runner commit</span>
          <code>{run.runnerCommit}</code>
        </div>
        <div>
          <span>Region</span>
          <code>{run.region}</code>
        </div>
        {[
          ['Corpus release', run.corpusReleaseId],
          ['Corpus commitment', run.corpusCommitmentSha256],
          ['Catalog digest', run.catalogDigest],
          ['Task-set digest', run.taskSetDigest],
          ['Preflight digest', run.preflightDigest],
          ['Runtime digest', run.runtimeDigest],
          ['Run class', run.runClass],
          ['Permission evidence', run.permissionEvidenceDigest],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <code>{value ?? 'Not published'}</code>
          </div>
        ))}
      </section>
    </section>
  );
}
