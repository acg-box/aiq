'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { NavigationLink } from '../components/navigation-link.tsx';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { EvidenceDrawer } from '../components/evidence-drawer.tsx';
import type { HarnessTask } from './harness-plan.ts';
import { useWorkspaceQuery } from '../components/workspace-query.ts';

export function HarnessEvidenceFilesLink() {
  const { href } = useWorkspaceQuery();
  return (
    <NavigationLink href={`${href({ view: 'data' })}#harness-artifacts`}>
      Required evidence files and preservation policy →
    </NavigationLink>
  );
}

export function HarnessTaskCatalogueLink() {
  const { href } = useWorkspaceQuery();
  return (
    <NavigationLink className="ui-action" href={href({ view: 'method' })}>
      Browse tasks →
    </NavigationLink>
  );
}

export function HarnessEvidenceRequirements({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (window.location.hash !== '#harness-artifacts' || !disclosure.current) return;
    disclosure.current.open = true;
    const heading = disclosure.current.querySelector<HTMLElement>('#harness-artifacts-heading');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }, []);
  return (
    <details ref={disclosure} className="harness-evidence-requirements">
      <summary>
        <span>
          Evidence requirements
          <small>{count} file types · for future runs</small>
        </span>
        <CaretDownIcon size={16} aria-hidden="true" />
      </summary>
      {children}
    </details>
  );
}

export function HarnessTaskEvidence({
  task,
  familyName,
  levelName,
  evidenceHref,
  triggerContent,
  triggerClassName,
}: {
  task: HarnessTask;
  familyName: string | undefined;
  levelName: string | undefined;
  evidenceHref: string;
  triggerContent?: ReactNode;
  triggerClassName?: string;
}) {
  return (
    <EvidenceDrawer
      title={task.name}
      label={`Review ${task.name}`}
      contextLabel="Task specification · not run"
      closeLabel="Close task specification"
      triggerContent={triggerContent}
      triggerClassName={triggerClassName}
    >
      <p className="research-caption">
        {familyName} · {task.stack} · {levelName} (estimated)
      </p>
      <p className="task-detail-summary">{task.summary}</p>
      <h3>Acceptance gates · all three must pass</h3>
      <p className="evidence-reading-key">
        No measured result. Open a gate to read its exact criterion.
      </p>
      <ol className="harness-task-gates">
        {task.acceptance.map((gate) => (
          <li key={gate.id}>
            <details className="acceptance-gate">
              <summary>{gate.name}</summary>
              <p>{gate.criterion}</p>
              <code className="task-gate-id">{gate.id}</code>
            </details>
          </li>
        ))}
      </ol>
      <NavigationLink href={evidenceHref}>Required evidence files →</NavigationLink>
      <details className="research-disclosure">
        <summary>Required deliverables</summary>
        <ul className="research-prose-list">
          {task.deliverables.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>
          Success also requires normal completion within the shared time, token, and cost limits.
          Each gate result must retain its ID and assertion evidence in <code>grade.json</code>.
        </p>
      </details>
      <details className="task-full-contract">
        <summary>Full task and output contract</summary>
        <p>{task.prompt}</p>
      </details>
      <details className="research-disclosure">
        <summary>Difficulty rationale and specification</summary>
        <p>{task.difficulty_reason}</p>
        <p>Intended demands: {task.demands.join(' · ')}.</p>
        <p>
          Specification: <code>{task.id}</code> · Workspace: <code>{task.workspace_id}</code>.
          Workspace, reference solution, and grader are not built or validated.
        </p>
      </details>
    </EvidenceDrawer>
  );
}
