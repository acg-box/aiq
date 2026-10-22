'use client';

import Link from 'next/link';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { useWorkspaceQuery } from '../components/workspace-query.ts';
import type { HarnessTask } from './harness-plan.ts';
import { HarnessTaskEvidence } from './harness-task-evidence.tsx';

type Choice = { id: string; name: string };

function DifficultyMarks({ level }: { level: number }) {
  return (
    <span className="task-difficulty-marks" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <i key={index} data-filled={index <= level || undefined} />
      ))}
    </span>
  );
}

export function HarnessTaskMatrix({
  families,
  levels,
  tasks,
}: {
  families: Choice[];
  levels: Choice[];
  tasks: HarnessTask[];
}) {
  const { params, href } = useWorkspaceQuery();
  const family = families.find((item) => item.id === params.get('workload'))?.id ?? 'all';
  const selected = tasks.filter((task) => family === 'all' || task.workload_id === family);
  return (
    <section className="harness-task-matrix" aria-label="Harness task matrix">
      <div className="comparison-heading">
        <div>
          <h2>Task matrix</h2>
          <p>
            {selected.length} task specifications · 3 acceptance gates each · no measured attempts.
          </p>
        </div>
        <Link href={href({ view: 'method' })}>
          Full task catalogue <ArrowRightIcon size={14} aria-hidden="true" />
        </Link>
      </div>
      <div className="task-matrix-grid">
        {families
          .filter((item) => family === 'all' || item.id === family)
          .map((item) => {
            const familyTasks = selected.filter((task) => task.workload_id === item.id);
            return (
              <div className="task-matrix-family" key={item.id} data-family={item.id}>
                <div className="task-matrix-family-name">
                  <h3>{item.name}</h3>
                  <span>{familyTasks.length} specifications</span>
                </div>
                <ul aria-label={`${item.name} task specifications`}>
                  {familyTasks.map((task) => {
                    const level = levels.findIndex((choice) => choice.id === task.difficulty);
                    return (
                      <li key={task.id}>
                        <HarnessTaskEvidence
                          task={task}
                          familyName={item.name}
                          levelName={levels[level]?.name}
                          evidenceHref={`${href({ view: 'data' })}#harness-artifacts`}
                          triggerClassName="task-matrix-trigger"
                          triggerContent={
                            <>
                              <span className="task-matrix-stack">{task.stack}</span>
                              <span className="task-matrix-name">{task.name}</span>
                              <span
                                className="task-matrix-level"
                                aria-label={`${levels[level]?.name} difficulty, estimated`}
                              >
                                <DifficultyMarks level={level} />
                                <span>{levels[level]?.name}</span>
                                <ArrowRightIcon size={15} aria-hidden="true" />
                              </span>
                            </>
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
      </div>
      <div className="task-matrix-legend">
        <span>Estimated difficulty</span>
        {levels.map((level, index) => (
          <span key={level.id}>
            <DifficultyMarks level={index} />
            {level.name} ({selected.filter((task) => task.difficulty === level.id).length})
          </span>
        ))}
        <span>Open a task for its deliverables and acceptance gates.</span>
      </div>
    </section>
  );
}
