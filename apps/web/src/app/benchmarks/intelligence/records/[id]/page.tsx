import { BoardDetailNavigation } from '../../../../../components/board-detail-navigation.tsx';
import { TableColumnHeading } from '../../../../../components/table-column-heading.tsx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReferenceDisclosure } from '../../../../../components/reference-disclosure.tsx';
import { alphabetical } from '../../../../../display-order.ts';

import { DataNote } from '../../../../../components/data-note.tsx';
import { OfficialEfficiencyTable } from '../../../../../components/official-efficiency-table.tsx';
import {
  ExpandableTableRow,
  TableRowFacts,
} from '../../../../../components/expandable-table-row.tsx';
import { ReadStateNote } from '../../../../../components/read-state-note.tsx';
import { RunScientificSummaryPanel } from '../../../../../components/run-scientific-summary.tsx';
import {
  resolveExactEfficiencyRows,
  resolveExactScientificEvidence,
} from '../../../../../components/scientific-evidence-resolution.ts';
import { buildRunScientificSummary } from '../../../../../components/scientific-score-context.ts';
import {
  classifyRunCompleteness,
  summarizeRun,
  summarizeRunDomains,
} from '../../../../../data/format.ts';
import { readPublicData, readPublicValue } from '../../../../../data/read-state.ts';
import { createAiqRepository } from '../../../../../data/repository.ts';
import { createPageMetadata } from '../../../../site-metadata.ts';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return createPageMetadata({
    title: 'Run detail',
    path: `/benchmarks/intelligence/records/${encodeURIComponent(id)}`,
    description:
      'Inspect the outcomes, coverage, and provenance for one public AIQ configuration run.',
  });
}
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
      <section className="research-shell research-inner reference-run-detail">
        <BoardDetailNavigation board="intelligence" />
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
  const observedTasks = run.tasks.filter(
    (task) => task.executionStatus === 'completed' || task.executionStatus === 'runtime_issue',
  );
  const observedDomains = new Map<string, number>();
  for (const task of observedTasks) {
    observedDomains.set(task.domain, (observedDomains.get(task.domain) ?? 0) + 1);
  }
  const resultSummary = {
    resultCount: run.tasks.length,
    observedCount: observedTasks.length,
    coveragePercent:
      run.tasks.length === 0 ? null : (observedTasks.length / run.tasks.length) * 100,
    coveredDomainCount: [...observedDomains.values()].filter((count) => count > 0).length,
    provisionalDomainCount: [...observedDomains.values()].filter((count) => count >= 4).length,
    correctCount: summary.correct,
    partialCount: summary.partial,
    incorrectCount: summary.incorrect,
    runtimeIssueCount: summary.runtimeIssues,
    invalidCount: summary.invalid,
    missingCount: summary.missing,
    notApplicableCount: summary.notApplicable,
    completedCount: run.tasks.filter((task) => task.executionStatus === 'completed').length,
  };
  const scientificEvidence = resolveExactScientificEvidence({
    candidate: {
      runId: run.id,
      entryId: run.entryId,
      scoringVersion: run.scoringVersion,
      synthetic: run.synthetic,
    },
    runs: [run],
    entries: leaderboard,
    efficiencyRows: efficiencyResult.data,
  });
  const exactEfficiencyRows = resolveExactEfficiencyRows({
    runs: [run],
    entries: leaderboard,
    efficiencyRows: efficiencyResult.data,
  });
  return (
    <section className="research-shell research-inner reference-run-detail">
      <BoardDetailNavigation board="intelligence" />
      <div className="run-heading">
        <div>
          <span className="eyebrow">Configuration run</span>
          <h1>
            {entry?.modelFamily ?? run.entryId} · {entry?.reasoningTier ?? 'unknown'}
          </h1>
          <p>
            {entry?.modelName} · started {new Date(run.startedAt).toLocaleString()}
          </p>
          <small>{run.synthetic ? 'Synthetic seed evidence' : 'Published evidence'}</small>
        </div>
      </div>
      <RunScientificSummaryPanel
        summary={buildRunScientificSummary({
          run,
          resultSummary,
          leaderboardEntry:
            scientificEvidence.state === 'exact' ? scientificEvidence.evidence.score : undefined,
          efficiency:
            scientificEvidence.state === 'exact'
              ? scientificEvidence.evidence.efficiency
              : undefined,
        })}
      />
      <details className="evidence-notes run-evidence-notes">
        <summary>
          <strong>Run evidence</strong>
          <span>Outcomes, identity, completeness, and provenance</span>
        </summary>
        <div className="evidence-note-body">
          <div className="run-stats">
            <div>
              <span>Correct</span>
              <strong>{summary.correct}</strong>
            </div>
            <div>
              <span>Partial</span>
              <strong>{summary.partial}</strong>
            </div>
            <div>
              <span>Incorrect</span>
              <strong>{summary.incorrect}</strong>
            </div>
            <div>
              <span>Runtime issue</span>
              <strong>{summary.runtimeIssues}</strong>
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
          <DataNote provenance={run.synthetic ? 'synthetic' : 'published'} />
          <dl className="run-evidence-facts">
            <div>
              <dt>Run ID</dt>
              <dd>
                <code>{run.id}</code>
              </dd>
            </div>
            <div>
              <dt>Completeness</dt>
              <dd>{completeness.label}</dd>
            </div>
            <div>
              <dt>Valid results</dt>
              <dd>
                {completeness.notApplicable ? 'Not applicable' : `${completeness.validResults}/72`}
              </dd>
            </div>
            <div>
              <dt>Scoring version</dt>
              <dd>{run.scoringVersion}</dd>
            </div>
          </dl>
          <p className="fine-print">
            This is one configuration run. One complete Official batch contains 17 runs and 1,224
            task attempts. Missing and invalid results block Official publication; a provisional
            estimate remains conditional.
          </p>
        </div>
      </details>
      <section className="run-section" aria-labelledby="run-efficiency-heading">
        <div className="section-heading compact">
          <div>
            <span className="eyebrow">Efficiency</span>
            <h2 id="run-efficiency-heading">Time, token coverage, and cost</h2>
          </div>
          <details className="research-disclosure">
            <summary>Timing scope</summary>
            <p>
              Codex adapter elapsed is runner-observed. Summed cell durations can overlap, while the
              signed matrix batch wall-clock is counted once. Neither value is isolated model
              latency.
            </p>
          </details>
        </div>
        <ReadStateNote result={efficiencyResult} subject="Official run efficiency" />
        {efficiencyResult.state === 'published' ? (
          <OfficialEfficiencyTable rows={exactEfficiencyRows} />
        ) : null}
      </section>
      <section className="run-section">
        <div className="section-heading compact">
          <div>
            <span className="eyebrow">Domain profile</span>
            <h2>Score and coverage by domain</h2>
          </div>
          <p>
            Scores use completed outcomes and runtime issues. Coverage keeps missing and invalid
            work in the denominator.
          </p>
        </div>
        <div
          className="table-scroll domain-summary"
          role="region"
          aria-label="Run domain summary"
          tabIndex={0}
        >
          <table className="run-domain-table compact-table measurement-table">
            <thead>
              <tr>
                <th scope="col">
                  <TableColumnHeading label="Domain" />
                </th>
                <th scope="col">
                  <TableColumnHeading label="Score" unit="observed %" />
                </th>
                <th scope="col">
                  <TableColumnHeading label="Coverage" unit="tasks / all" />
                </th>
                <th scope="col" className="compact-secondary">
                  <TableColumnHeading label="Completed" unit="tasks" />
                </th>
                <th scope="col" className="compact-secondary">
                  <TableColumnHeading label="Runtime issues" unit="tasks" />
                </th>
                <th scope="col" className="compact-secondary">
                  <TableColumnHeading label="Missing" unit="tasks" />
                </th>
                <th scope="col" className="compact-secondary">
                  <TableColumnHeading label="Invalid" unit="tasks" />
                </th>
                <th scope="col" className="compact-secondary">
                  <TableColumnHeading label="Not applicable" unit="tasks" />
                </th>
                <th scope="col" className="row-expand-cell">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {alphabetical(domains, (domain) => domain.domain.replaceAll('_', ' ')).map(
                (domain) => (
                  <ExpandableTableRow
                    key={domain.domain}
                    label={domain.domain.replaceAll('_', ' ')}
                    visibleColumns={3}
                    details={
                      <TableRowFacts
                        items={[
                          { label: 'Completed', unit: 'tasks', value: domain.completed },
                          { label: 'Runtime issues', unit: 'tasks', value: domain.runtimeIssues },
                          { label: 'Missing', unit: 'tasks', value: domain.missing },
                          { label: 'Invalid', unit: 'tasks', value: domain.invalid },
                          { label: 'Not applicable', unit: 'tasks', value: domain.notApplicable },
                        ]}
                      />
                    }
                  >
                    <th scope="row">{domain.domain.replaceAll('_', ' ')}</th>
                    <td data-label="Score">
                      {domain.score === null ? 'No score' : `${domain.score.toFixed(1)}%`}
                    </td>
                    <td data-label="Coverage">
                      {domain.coveragePercent.toFixed(1)}% (
                      {domain.completed + domain.runtimeIssues}/{domain.total})
                    </td>
                    <td className="compact-secondary" data-label="Completed">
                      {domain.completed}
                    </td>
                    <td className="compact-secondary" data-label="Runtime issue">
                      {domain.runtimeIssues}
                    </td>
                    <td className="compact-secondary" data-label="Missing">
                      {domain.missing}
                    </td>
                    <td className="compact-secondary" data-label="Invalid">
                      {domain.invalid}
                    </td>
                    <td className="compact-secondary" data-label="N/A">
                      {domain.notApplicable}
                    </td>
                  </ExpandableTableRow>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>
      <ReferenceDisclosure
        id="run-task-outcomes"
        title="Task outcomes"
        description={`${run.tasks.length} task records · individual results, explanations, and usage`}
      >
        <div className="task-list">
          {run.tasks.map((task) => (
            <article
              key={task.id}
              data-token-evidence-level={task.tokenUsageEvidenceLevel ?? 'unavailable'}
              data-cost-estimator-status={task.costEstimatorStatus}
              data-cost-evidence-level={task.costEvidenceLevel ?? 'unavailable'}
              data-standard-api-equivalent-usd-nanos={
                task.standardApiEquivalentUsdNanos ?? 'unavailable'
              }
            >
              <header>
                <span className={`result result-${task.executionStatus}`}>
                  {task.outcome.replaceAll('_', ' ')} · {task.executionStatus.replace('_', ' ')}
                </span>
                <strong>
                  {task.score === null ? 'No score' : `${(task.score * 100).toFixed(0)}%`}
                </strong>
              </header>
              <span className="eyebrow">{task.domain}</span>
              <h3>{task.task}</h3>
              <details className="research-disclosure task-evidence-details">
                <summary>Explanation and usage</summary>
                {task.explanation ? (
                  <div className="result-explanation">
                    {task.explanation.code ? (
                      <code>{task.explanation.code}</code>
                    ) : task.executionStatus === 'runtime_issue' ? (
                      <strong>Runtime issue</strong>
                    ) : (
                      <strong>Published outcome</strong>
                    )}
                    <p>{task.explanation.summary}</p>
                    <small>
                      {task.explanation.retryable === null
                        ? task.executionStatus === 'runtime_issue'
                          ? 'The execution did not complete normally.'
                          : 'Retryability is not published.'
                        : `Retryable: ${task.explanation.retryable ? 'yes' : 'no'}`}
                    </small>
                  </div>
                ) : task.executionStatus !== 'completed' ? (
                  <div className="result-explanation">
                    <code>EXPLANATION_NOT_PUBLISHED</code>
                    <p>No public explanation was supplied for this outcome.</p>
                    <small>Retryability is not published.</small>
                  </div>
                ) : null}
                <footer>
                  <span>
                    Auxiliary usage: {task.agentSteps.toLocaleString()} agent steps ·{' '}
                    {task.toolCallCount.toLocaleString()} tool calls
                    {task.tools.length > 0
                      ? ` (${task.tools
                          .map(
                            (tool) =>
                              `${tool} ${task.toolCallsByType[tool]?.toLocaleString() ?? '0'}`,
                          )
                          .join(', ')})`
                      : ''}
                  </span>
                  <span>
                    Codex adapter elapsed:{' '}
                    {task.latencyMs === null
                      ? 'unavailable'
                      : `${task.latencyMs.toLocaleString()} ms · ${task.latencyEvidenceLevel?.replaceAll('_', '-')}`}
                  </span>
                  <span>
                    Tokens: input {task.inputTokens?.toLocaleString() ?? 'unavailable'} · cached
                    input {task.cachedInputTokens?.toLocaleString() ?? 'unavailable'} · cache-write
                    input {task.cacheWriteInputTokens?.toLocaleString() ?? 'unavailable'} · output{' '}
                    {task.outputTokens?.toLocaleString() ?? 'unavailable'} · reasoning{' '}
                    {task.reasoningOutputTokens?.toLocaleString() ?? 'unavailable'} · total{' '}
                    {task.totalTokens?.toLocaleString() ?? 'unavailable'}
                  </span>
                  <span>
                    Estimated Standard API-equivalent cost:{' '}
                    {task.standardApiEquivalentUsdNanos === null
                      ? task.costEstimatorStatus.replaceAll('_', ' ')
                      : `$${(task.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(6)}`}{' '}
                    · token evidence{' '}
                    {task.tokenUsageEvidenceLevel?.replaceAll('_', '-') ?? 'unavailable'} · cost
                    evidence {task.costEvidenceLevel?.replaceAll('_', '-') ?? 'unavailable'}
                  </span>
                </footer>
              </details>
            </article>
          ))}
        </div>
      </ReferenceDisclosure>
      <ReferenceDisclosure
        id="run-provenance"
        title="Run provenance"
        description="Versions, content digests, runner identity, and publication scope"
      >
        <div className="provenance-panel">
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
        </div>
      </ReferenceDisclosure>
    </section>
  );
}
