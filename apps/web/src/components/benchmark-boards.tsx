import { NavigationLink } from './navigation-link.tsx';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { comparisonColor } from '../data/comparison-palette.ts';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowRight';
import { benchmarkBoards } from '../benchmarks/boards.ts';
import { readCoreResults } from '../benchmarks/core-data.ts';
import { harnessPlan } from '../benchmarks/harness-plan.ts';
import { rankCoreResults } from '../data/core-results.ts';
import { alphabetical } from '../display-order.ts';
import { listStudies } from '../studies/repository.ts';
import { CoreIntervalMark } from './core-interval-mark.tsx';
import { NavigationPending } from './navigation-pending.tsx';

async function IntelligenceSnapshot() {
  await connection();
  const { datasets } = await readCoreResults();
  const current = datasets[0];
  const measured = datasets.find(
    (dataset) => dataset.state === 'available' && dataset.rows.length > 0,
  );
  if (!measured)
    return (
      <p className="home-result-status">
        {current.state === 'unavailable'
          ? 'Published results unavailable'
          : current.state === 'preview'
            ? 'Preview · no Official measurements'
            : 'No Official results published'}
      </p>
    );
  const preview = rankCoreResults(measured.rows).slice(0, 3);
  const lower = Math.min(...measured.rows.map(({ entry }) => entry.scoreCiLow ?? entry.score));
  const upper = Math.max(...measured.rows.map(({ entry }) => entry.scoreCiHigh ?? entry.score));
  const padding = Math.max((upper - lower) * 0.05, 0.01);
  return (
    <>
      <p className="home-result-status">
        Core {measured.version} · {measured.rows.length}{' '}
        {measured.historical ? 'historical' : 'Official'} configurations
      </p>
      <ul className="home-result-preview" aria-label="Recorded ability preview">
        {preview.map(({ entry }) => (
          <li key={entry.id}>
            <span>
              {entry.modelFamily} · {entry.reasoningTier}
            </span>
            <CoreIntervalMark
              subject={entry.modelFamily}
              value={entry.score}
              low={entry.scoreCiLow}
              high={entry.scoreCiHigh}
              minimum={lower - padding}
              maximum={upper + padding}
            />
            <strong>{entry.score.toFixed(3)}</strong>
            <span className="sr-only">
              {entry.scoreCiLow !== null && entry.scoreCiHigh !== null
                ? `Conditional 95% interval: ${entry.scoreCiLow.toFixed(1)} to ${entry.scoreCiHigh.toFixed(1)}.`
                : 'Interval not reported.'}
            </span>
          </li>
        ))}
      </ul>
      <div className="home-preview-axis" aria-hidden="true">
        <span />
        <span>
          <span>{(lower - padding).toFixed(1)}</span>
          <span>{(upper + padding).toFixed(1)}</span>
        </span>
        <span />
      </div>
      <small>
        Ability score · top point estimates; lines show conditional 95% intervals.
        {measured.historical
          ? current.state === 'unavailable'
            ? ' Current publication unavailable.'
            : ` Current Core ${current.version} has no Official results.`
          : ''}
      </small>
    </>
  );
}

function MemorySnapshot() {
  const studies = listStudies();
  const native = studies.find((study) => study.id === 'native-memory');
  const group = native?.groups.find((item) => item.id === 'native');
  return (
    <>
      <p className="home-result-status">
        {studies.length} studies ·{' '}
        {studies.reduce((count, study) => count + study.groups.length, 0)} comparisons
      </p>
      <ul className="home-result-preview" aria-label="Native memory answer preview">
        {alphabetical(
          group?.runs ?? [],
          (run) =>
            native?.subjects.find((subject) => subject.id === run.subjectId)?.label ??
            run.subjectId,
        ).map((run) => {
          const value = group?.results.find((result) => result.runId === run.id)?.values.bound;
          return (
            <li key={run.id} data-subject={run.subjectId}>
              <span>{native?.subjects.find((subject) => subject.id === run.subjectId)?.label}</span>
              <span className="home-ratio-track" aria-hidden="true">
                {value && typeof value === 'object' && value.total > 0 ? (
                  <span
                    style={{
                      width: `${(value.pass / value.total) * 100}%`,
                      background: comparisonColor(run.subjectId),
                    }}
                  />
                ) : null}
              </span>
              <strong>
                {value && typeof value === 'object'
                  ? `${value.pass}/${value.total}`
                  : 'Not measured'}
              </strong>
            </li>
          );
        })}
      </ul>
      <small>
        Native systems · complete answers with source-matched quotes. Reader and writer tests remain
        separate.
      </small>
    </>
  );
}

export function BenchmarkBoards() {
  return (
    <div
      className="research-table-scroll directory-scroll"
      role="region"
      tabIndex={0}
      aria-label="Benchmark boards"
    >
      <table className="research-table benchmark-directory">
        <caption className="sr-only">Peer benchmark boards and their test coverage</caption>
        <colgroup>
          <col className="home-board-column" />
          <col className="home-results-column" />
          <col className="home-conditions-column" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Board</th>
            <th scope="col">Comparison and recorded results</th>
            <th scope="col">Conditions and evidence</th>
          </tr>
        </thead>
        <tbody>
          {benchmarkBoards.map((board, index) => (
            <tr key={board.id}>
              <th scope="row" aria-label={board.title} data-index={`0${index + 1}`}>
                <NavigationLink href={`/benchmarks/${board.id}`} aria-label={board.title}>
                  {board.title}
                  <ArrowRightIcon size={18} aria-hidden="true" />
                  <NavigationPending />
                </NavigationLink>
              </th>
              <td data-label="Comparison and recorded results">
                <p className="home-comparison-type">{board.summary}</p>
                {board.id === 'intelligence' ? (
                  <Suspense
                    fallback={
                      <div className="home-snapshot-loading" role="status">
                        <p>Reading published results…</p>
                      </div>
                    }
                  >
                    <IntelligenceSnapshot />
                  </Suspense>
                ) : board.id === 'memory' ? (
                  <MemorySnapshot />
                ) : (
                  <>
                    <p className="home-result-status">Design only · no measured attempts</p>
                    <p>
                      {harnessPlan.task_set.planned_tasks} task specifications ·{' '}
                      {harnessPlan.task_set.planned_workspaces} planned workspaces
                    </p>
                    <ul className="home-task-preview" aria-label="Planned task families">
                      {harnessPlan.workloads.map((family) => (
                        <li key={family.id}>
                          <span>{family.name}</span>
                          <span className="home-task-dots" aria-hidden="true">
                            {harnessPlan.tasks
                              .filter((task) => task.workload_id === family.id)
                              .map((task) => (
                                <i key={task.id} />
                              ))}
                          </span>
                          <small>
                            {
                              harnessPlan.tasks.filter((task) => task.workload_id === family.id)
                                .length
                            }{' '}
                            specifications
                          </small>
                        </li>
                      ))}
                    </ul>
                    <NavigationLink href="/benchmarks/harness?view=method">
                      Inspect task specifications →
                    </NavigationLink>
                  </>
                )}
              </td>
              <td data-label="Conditions and evidence">
                <p>{board.comparisonConditions}</p>
                <NavigationLink
                  className="board-open-action"
                  href={`/benchmarks/${board.id}`}
                  aria-label={`Open leaderboard: ${board.title}`}
                >
                  Open leaderboard
                  <ArrowRightIcon size={16} aria-hidden="true" />
                  <NavigationPending />
                </NavigationLink>
                <nav className="home-evidence-links" aria-label={`${board.title} evidence views`}>
                  <NavigationLink href={`/benchmarks/${board.id}?view=data`} aria-label="Data">
                    Data
                    <NavigationPending />
                  </NavigationLink>
                  <NavigationLink href={`/benchmarks/${board.id}?view=method`} aria-label="Method">
                    Method
                    <NavigationPending />
                  </NavigationLink>
                  <NavigationLink
                    href={`/benchmarks/${board.id}?view=records`}
                    aria-label="Records"
                  >
                    Records
                    <NavigationPending />
                  </NavigationLink>
                </nav>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
