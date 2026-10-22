'use client';

import { TableColumnHeading } from '../components/table-column-heading.tsx';

import { HarnessTaskEvidence } from './harness-task-evidence.tsx';
import {
  ExpandableTableRow,
  RowDetailContext,
  TableRowFacts,
} from '../components/expandable-table-row.tsx';
import { useWorkspaceQuery } from '../components/workspace-query.ts';
import type { HarnessTask } from './harness-plan.ts';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';

type Choice = { id: string; name: string };

export function HarnessTasks({
  tasks,
  families,
  levels,
  stacks,
}: {
  tasks: HarnessTask[];
  families: Choice[];
  levels: Choice[];
  stacks: string[];
}) {
  const { params, update, href } = useWorkspaceQuery();
  const family = families.find((item) => item.id === params.get('workload'))?.id ?? 'all';
  const difficulty = levels.find((item) => item.id === params.get('difficulty'))?.id ?? 'all';
  const stack = stacks.find((item) => item === params.get('stack')) ?? 'all';
  const query = params.get('q') ?? '';
  const needle = query.trim().toLocaleLowerCase('en-US');
  const filtered = family !== 'all' || difficulty !== 'all' || stack !== 'all' || query !== '';
  const visible = tasks.filter(
    (task) =>
      (family === 'all' || task.workload_id === family) &&
      (difficulty === 'all' || task.difficulty === difficulty) &&
      (stack === 'all' || task.stack === stack) &&
      (!needle || `${task.name} ${task.summary}`.toLocaleLowerCase('en-US').includes(needle)),
  );
  return (
    <section className="harness-task-catalogue" aria-label="Task specifications">
      <div className="results-controls harness-task-controls">
        <div className="task-search-control">
          <label htmlFor="task-search">Search</label>
          <div className="task-search">
            <MagnifyingGlassIcon size={16} aria-hidden="true" />
            <input
              id="task-search"
              aria-label="Search task specifications"
              type="search"
              placeholder="Find a task…"
              value={query}
              onChange={(event) => update({ q: event.target.value || null }, { replace: true })}
            />
          </div>
        </div>
        <div>
          <label htmlFor="task-family">Task family</label>
          <select
            id="task-family"
            value={family}
            onChange={(event) => update({ workload: event.target.value })}
          >
            <option value="all">All families</option>
            {families.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="task-difficulty">Estimated difficulty</label>
          <select
            id="task-difficulty"
            value={difficulty}
            onChange={(event) => update({ difficulty: event.target.value })}
          >
            <option value="all">All levels</option>
            {levels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="task-stack">Stack</label>
          <select
            id="task-stack"
            value={stack}
            onChange={(event) => update({ stack: event.target.value })}
          >
            <option value="all">All stacks</option>
            {stacks.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="task-selection-meta">
        <p className="research-caption" role="status">
          {visible.length} of {tasks.length} specifications · 3 acceptance gates each. Packages
          pending; no runs.
        </p>
        {filtered ? (
          <button
            className="ui-action workspace-reset"
            type="button"
            aria-label="Reset filters for tasks"
            onClick={() => update({ workload: null, difficulty: null, stack: null, q: null })}
          >
            <ArrowCounterClockwiseIcon size={14} aria-hidden="true" /> Reset filters
          </button>
        ) : null}
      </div>
      <div
        className="research-table-scroll"
        role="region"
        tabIndex={0}
        aria-label="Planned task specifications"
      >
        <table className="research-table harness-task-table compact-table">
          <caption className="sr-only">
            Alphabetical task specifications, not measured results
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <TableColumnHeading label="Task" />
              </th>
              <th scope="col" className="harness-task-family compact-secondary">
                <TableColumnHeading label="Task family" unit="stack" />
              </th>
              <th scope="col" className="harness-task-level">
                <TableColumnHeading label="Difficulty" unit="estimated" />
              </th>
              <th scope="col" className="harness-task-details compact-secondary">
                <span>
                  <TableColumnHeading label="Details" unit="specification" />
                </span>
              </th>
              <th scope="col" className="row-expand-cell">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody key={`${family}-${difficulty}-${stack}-${query}`}>
            {visible.map((task) => {
              const familyName = families.find((item) => item.id === task.workload_id)?.name;
              const levelName = levels.find((item) => item.id === task.difficulty)?.name;
              return (
                <ExpandableTableRow
                  key={task.id}
                  label={task.name}
                  visibleColumns={2}
                  details={
                    <>
                      <TableRowFacts
                        items={[
                          { label: 'Task family', value: familyName },
                          { label: 'Stack', value: task.stack },
                          { label: 'Difficulty', unit: 'estimated', value: levelName },
                          {
                            label: 'Acceptance',
                            unit: 'required gates',
                            value: `${task.acceptance.length} defined`,
                          },
                        ]}
                      />
                      <RowDetailContext label="Task & acceptance">
                        <TableRowFacts
                          layout="rows"
                          items={[
                            { label: 'Task', value: task.summary },
                            ...task.acceptance.map((gate) => ({
                              label: gate.name,
                              value: gate.criterion,
                            })),
                          ]}
                        />
                      </RowDetailContext>
                      <HarnessTaskEvidence
                        task={task}
                        familyName={familyName}
                        levelName={levelName}
                        evidenceHref={`${href({ view: 'data' })}#harness-artifacts`}
                      />
                    </>
                  }
                >
                  <th scope="row">
                    {task.name}
                    <span className="harness-task-summary">{task.summary}</span>
                  </th>
                  <td className="harness-task-family compact-secondary">
                    {familyName}
                    <span className="harness-task-summary">{task.stack}</span>
                  </td>
                  <td className="harness-task-level">{levelName}</td>
                  <td className="harness-task-details compact-secondary">
                    <HarnessTaskEvidence
                      task={task}
                      familyName={familyName}
                      levelName={levelName}
                      evidenceHref={`${href({ view: 'data' })}#harness-artifacts`}
                    />
                  </td>
                </ExpandableTableRow>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={4} className="results-empty">
                  No task specifications match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
