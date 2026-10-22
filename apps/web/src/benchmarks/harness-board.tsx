import { BenchmarkHeading } from '../components/benchmark-heading.tsx';
import { BoardTabs } from '../components/board-tabs.tsx';
import { ExpandableTableRow, TableRowFacts } from '../components/expandable-table-row.tsx';
import { TableColumnHeading } from '../components/table-column-heading.tsx';
import { harnessEvidenceFiles, harnessPlan, harnessProtocolHref } from './harness-plan.ts';
import { HarnessResults } from './harness-results.tsx';
import { HarnessTasks } from './harness-tasks.tsx';
import { HarnessTaskMatrix } from './harness-task-matrix.tsx';
import {
  HarnessEvidenceFilesLink,
  HarnessEvidenceRequirements,
  HarnessTaskCatalogueLink,
} from './harness-task-evidence.tsx';
import { alphabetical } from '../display-order.ts';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowUpRight';
import {
  ReferenceHeader,
  ReferenceNavigation,
  ReferenceSection,
  SourceDownload,
} from '../components/reference-layout.tsx';

function HarnessMethod() {
  return (
    <div className="reference-page">
      <ReferenceHeader
        title={`Study protocol · draft ${harnessPlan.protocol_version}`}
        description={
          <>
            {harnessPlan.task_set.planned_tasks} task specifications ·{' '}
            {harnessPlan.task_set.difficulty_levels
              .map((level) => `${level.name} ${level.planned_tasks}`)
              .join(' · ')}{' '}
            (estimated). No trials have been run.
          </>
        }
      />
      <ReferenceNavigation
        sections={[
          ['harness-tasks', 'Tasks'],
          ['harness-cohort', 'Cohort'],
          ['harness-controls', 'Controls'],
          ['harness-budget', 'Budget'],
          ['harness-measures', 'Measures'],
          ['harness-analysis', 'Analysis'],
          ['harness-evidence', 'Evidence'],
        ]}
      />
      <ReferenceSection id="harness-tasks" title="Task specifications" wide>
        <HarnessTasks
          tasks={harnessPlan.tasks}
          families={harnessPlan.workloads.map(({ id, name }) => ({ id, name }))}
          levels={harnessPlan.task_set.difficulty_levels.map(({ id, name }) => ({ id, name }))}
          stacks={harnessPlan.task_set.strata.map(({ name }) => name)}
        />
        <details className="harness-design-contract">
          <summary>Task design and grading</summary>
          <dl className="harness-definitions">
            {harnessPlan.task_set.difficulty_levels.map((level) => (
              <div key={level.id}>
                <dt>
                  {level.name} · {level.planned_tasks} tasks
                </dt>
                <dd>{level.definition}</dd>
              </div>
            ))}
            {[
              ['Acceptance', harnessPlan.task_set.grading_contract],
              ['Difficulty', harnessPlan.task_set.difficulty_policy],
              ['Package contract', harnessPlan.task_set.fixture_contract],
            ].map(([name, rule]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{rule}</dd>
              </div>
            ))}
          </dl>
        </details>
      </ReferenceSection>
      <ReferenceSection id="harness-cohort" title="Same-model cohort">
        <dl className="harness-definitions">
          <div>
            <dt>Model and route</dt>
            <dd>
              {harnessPlan.cohort.model} · {harnessPlan.cohort.reasoning_effort} ·{' '}
              {harnessPlan.cohort.provider} · Responses / HTTP + SSE · Standard
            </dd>
          </div>
          <div>
            <dt>Planned coverage</dt>
            <dd>
              {harnessPlan.task_set.planned_tasks} task specifications ·{' '}
              {harnessPlan.task_set.planned_workspaces} planned workspaces ·{' '}
              {harnessPlan.task_set.repetitions_per_task} repeats ·{' '}
              {harnessPlan.task_set.planned_scored_attempts} planned attempts. Task specifications
              are authored; workspace packages and graders are not built or evaluated.
            </dd>
          </div>
          <div>
            <dt>Shared attempt ceilings</dt>
            <dd>
              {harnessPlan.limits.wall_seconds_per_attempt / 60} minutes · USD{' '}
              {harnessPlan.limits.reference_usd_per_attempt} reference inference cost ·{' '}
              {harnessPlan.limits.max_request_input_tokens.toLocaleString('en-US')} input and{' '}
              {harnessPlan.limits.max_request_output_tokens.toLocaleString('en-US')} output tokens /
              request. Compression and retries consume the same budget.
            </dd>
          </div>
        </dl>
        <p className="research-caption">{harnessPlan.cohort.snapshot_policy}</p>
        <p className="research-caption">{harnessPlan.cohort.profile_scope}</p>
        <div className="research-two-columns research-section">
          {harnessPlan.comparisons.map((comparison) => (
            <section key={comparison.id}>
              <h4>{comparison.name}</h4>
              <p>{comparison.question}</p>
              <p className="research-caption">
                {comparison.description} {comparison.interpretation}
              </p>
            </section>
          ))}
        </div>
        <h4>Task families in scope</h4>
        <div
          className="research-table-scroll"
          role="region"
          tabIndex={0}
          aria-label="Planned task families"
        >
          <table className="research-table harness-method-table compact-table harness-family-table">
            <thead>
              <tr>
                <th scope="col">
                  <TableColumnHeading label="Task family" />
                </th>
                <th scope="col">
                  <TableColumnHeading label="Tasks" unit="planned" />
                </th>
                <th scope="col" className="compact-secondary">
                  <TableColumnHeading label="Acceptance" unit="required evidence" />
                </th>
                <th scope="col" className="row-expand-cell">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {harnessPlan.workloads.map((item) => (
                <ExpandableTableRow
                  key={item.id}
                  label={item.name}
                  visibleColumns={2}
                  details={
                    <TableRowFacts
                      items={[
                        {
                          label: 'Acceptance',
                          unit: 'required evidence',
                          value: item.acceptance,
                          wide: true,
                        },
                      ]}
                    />
                  }
                >
                  <th scope="row">{item.name}</th>
                  <td className="research-number">{item.planned_tasks}</td>
                  <td className="compact-secondary">{item.acceptance}</td>
                </ExpandableTableRow>
              ))}
            </tbody>
          </table>
        </div>
        <h4>Task selection</h4>
        <dl className="harness-definitions">
          {[
            ['Cohort structure', harnessPlan.task_set.selection],
            ['Exclusions', harnessPlan.task_set.exclusions],
            ['Independent validation', harnessPlan.task_set.validation],
            ['Source requirements', harnessPlan.task_set.inclusion],
          ].map(([name, rule]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{rule}</dd>
            </div>
          ))}
        </dl>
      </ReferenceSection>
      <ReferenceSection id="harness-controls" title="Qualification and controls">
        <h4>Same-model qualification · not run</h4>
        <dl className="harness-definitions">
          {harnessPlan.harnesses.map((harness) => (
            <div key={harness.id}>
              <dt>{harness.name}</dt>
              <dd>{harness.study_control}</dd>
            </div>
          ))}
        </dl>
        <p className="research-caption">{harnessPlan.qualification.admission}</p>
        <dl className="harness-definitions">
          {harnessPlan.qualification.checks.map((check) => (
            <div key={check.name}>
              <dt>{check.name}</dt>
              <dd>{check.requirement}</dd>
            </div>
          ))}
        </dl>
        <h4>Shared baseline</h4>
        <dl className="harness-definitions">
          {harnessPlan.baseline.map((item) => (
            <div key={item.name}>
              <dt>{item.name}</dt>
              <dd>{item.rule}</dd>
            </div>
          ))}
        </dl>
      </ReferenceSection>
      <ReferenceSection id="harness-budget" title="Proposed budget">
        <h4>Budget proposal · no spending authority</h4>
        <p className="research-caption">
          USD {harnessPlan.budget.api_ceiling} inference + USD {harnessPlan.budget.compute_ceiling}{' '}
          compute = USD {harnessPlan.budget.total_cash_ceiling_before_tax} maximum cash before tax.{' '}
          {harnessPlan.budget.reviewer_hours_ceiling} reviewer hours are a separate labor cap.
        </p>
        <div
          className="research-table-scroll"
          role="region"
          tabIndex={0}
          aria-label="Proposed budget"
        >
          <table className="research-table harness-method-table compact-table harness-budget-table">
            <thead>
              <tr>
                <th scope="col">
                  <TableColumnHeading label="Allocation" />
                </th>
                <th scope="col" className="compact-secondary">
                  <TableColumnHeading label="Workload" unit="planned" />
                </th>
                <th scope="col" className="harness-budget-ceiling">
                  <TableColumnHeading label="Ceiling" unit="USD proposed" />
                </th>
                <th scope="col" className="row-expand-cell">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {harnessPlan.budget.phases.map((phase) => (
                <ExpandableTableRow
                  key={phase.name}
                  label={phase.name}
                  visibleColumns={2}
                  details={
                    <TableRowFacts
                      items={[
                        {
                          label: 'Workload',
                          unit: 'planned',
                          value: `${phase.units} ${phase.unit}`,
                        },
                        { label: 'Unit cap', unit: 'USD proposed', value: phase.usd_per_unit },
                      ]}
                    />
                  }
                >
                  <th scope="row">{phase.name}</th>
                  <td className="compact-secondary">
                    {phase.units} {phase.unit}
                  </td>
                  <td className="research-number harness-budget-ceiling">{phase.ceiling_usd}</td>
                </ExpandableTableRow>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="harness-definitions">
          {[
            ['Budget admission', harnessPlan.limits.admission_policy],
            ['Reference cost', harnessPlan.limits.reference_cost_policy],
            ['Scope and labor', harnessPlan.budget.exclusions],
            ['Stop rules', harnessPlan.budget.stop_policy],
            ['Worker time bound', harnessPlan.budget.time_bound],
          ].map(([name, rule]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{rule}</dd>
            </div>
          ))}
        </dl>
      </ReferenceSection>
      <ReferenceSection id="harness-measures" title="Measures and denominators">
        <dl className="harness-definitions">
          {harnessPlan.metrics.map((item) => (
            <div key={item.name}>
              <dt>
                {item.name}
                <span>{item.unit}</span>
              </dt>
              <dd>{item.definition}</dd>
            </div>
          ))}
        </dl>
      </ReferenceSection>
      <ReferenceSection id="harness-analysis" title="Repeats and uncertainty">
        <h4>Repeats, failures, and uncertainty</h4>
        <ul className="research-prose-list">
          {Object.values(harnessPlan.analysis)
            .filter((item): item is string => typeof item === 'string')
            .map((item) => (
              <li key={item}>{item}</li>
            ))}
        </ul>
      </ReferenceSection>
      <ReferenceSection id="harness-evidence" title="Documentation and evidence">
        <details className="research-disclosure">
          <summary>Documentation review and evidence contract</summary>
          <HarnessDocumentation />
        </details>
      </ReferenceSection>
    </div>
  );
}

function HarnessDocumentation() {
  return (
    <>
      <h4>Documentation review</h4>
      <p className="research-caption">
        Protocol reviewed on {harnessPlan.reviewed_at}. Configuration documentation and task-design
        research inform the draft; they do not verify a working pairing or task difficulty.
      </p>
      <section aria-label="Harness documentation review">
        <dl className="harness-definitions">
          {harnessPlan.harnesses.map((harness) => (
            <div key={harness.id}>
              <dt>
                {harness.name}
                <a href={harness.documentation}>Official configuration docs ↗</a>
              </dt>
              <dd>
                <p>{harness.observation}</p>
                <p>{harness.study_control}</p>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="research-section">
        <h4>Required experiment evidence</h4>
        <p className="research-caption">
          No experiment originals exist for this draft. Future records must retain the following
          evidence.
        </p>
        <dl className="harness-definitions">
          {harnessPlan.evidence.map((item) => (
            <div key={item.name}>
              <dt>{item.name}</dt>
              <dd>{item.contents}</dd>
            </div>
          ))}
        </dl>
        <HarnessEvidenceFilesLink />
      </section>
      <h4>Decisions still open</h4>
      <ul className="research-prose-list">
        {harnessPlan.unresolved.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

function HarnessSourceList({
  items,
  className = '',
}: {
  items: { name: string; url: string }[];
  className?: string;
}) {
  return (
    <ul className={`reference-sources ${className}`}>
      {items.map((source) => (
        <li key={source.url}>
          <a href={source.url}>
            <span>
              {source.name}
              <small>{new URL(source.url).hostname}</small>
            </span>
            <ArrowUpRightIcon size={15} aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function HarnessData() {
  const sources = harnessPlan.harnesses.map((harness) => ({
    name: `${harness.name} configuration docs`,
    url: harness.documentation,
  }));
  const references = alphabetical(harnessPlan.references, (source) => source.name);
  return (
    <div className="reference-page">
      <ReferenceHeader
        title="Study files"
        description="Task definitions are available. Trial data has not been collected."
      />
      <SourceDownload
        href={harnessProtocolHref}
        label="Download draft protocol · JSON"
        detail={`${harnessPlan.tasks.length} tasks · ${harnessPlan.tasks.reduce((count, task) => count + task.acceptance.length, 0)} acceptance gates`}
        actionLabel="JSON ↓"
      >
        Task set and protocol
      </SourceDownload>
      <div className="harness-data-actions">
        <HarnessTaskCatalogueLink />
        <p>Read prompts, deliverables, and acceptance criteria.</p>
      </div>
      <HarnessEvidenceRequirements count={harnessEvidenceFiles.length}>
        <ReferenceSection id="harness-artifacts" title="Required evidence files">
          <p className="research-caption">
            No attempt artifacts have been collected. Each future trial must retain these files.
          </p>
          <div
            className="research-table-scroll"
            role="region"
            tabIndex={0}
            aria-label="Planned evidence artifacts"
          >
            <table className="research-table harness-method-table compact-table harness-artifact-table">
              <thead>
                <tr>
                  <th scope="col">
                    <TableColumnHeading label="File purpose" unit="required file" />
                  </th>
                  <th scope="col" className="compact-secondary">
                    <TableColumnHeading label="Contents" unit="required evidence" />
                  </th>
                  <th scope="col" className="row-expand-cell">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {harnessEvidenceFiles.map((artifact) => (
                  <ExpandableTableRow
                    key={artifact.path}
                    label={artifact.path}
                    visibleColumns={1}
                    details={
                      <TableRowFacts
                        items={[
                          {
                            label: 'Contents',
                            unit: 'required evidence',
                            value: artifact.purpose,
                            wide: true,
                          },
                        ]}
                      />
                    }
                  >
                    <th scope="row">
                      {artifact.name}
                      <code className="harness-artifact-path">{artifact.path}</code>
                    </th>
                    <td className="compact-secondary">{artifact.purpose}</td>
                  </ExpandableTableRow>
                ))}
              </tbody>
            </table>
          </div>
          <details className="research-disclosure">
            <summary>Evidence preservation and publication</summary>
            <p>{harnessPlan.evidence_policy}</p>
          </details>
        </ReferenceSection>
      </HarnessEvidenceRequirements>
      <ReferenceSection
        id="harness-sources"
        title="Configuration documentation"
        label="Protocol sources"
      >
        <HarnessSourceList items={sources} className="harness-primary-sources" />
        <details className="research-disclosure harness-supporting-sources">
          <summary>Research and model references · {references.length}</summary>
          <HarnessSourceList items={references} />
        </details>
      </ReferenceSection>
    </div>
  );
}

export function HarnessBoardContent() {
  const controls = {
    proposedModel: harnessPlan.cohort.model,
    plannedTasks: harnessPlan.task_set.planned_tasks,
    harnesses: harnessPlan.harnesses.map(({ id, name, documentation }) => ({
      id,
      name,
      documentation,
    })),
    comparisons: harnessPlan.comparisons.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    workloads: harnessPlan.workloads.map(({ id, name }) => ({ id, name })),
  };
  return (
    <>
      <BenchmarkHeading
        title="Harness Rank"
        description="Task outcomes across model–harness combinations."
        facts={[
          `${harnessPlan.harnesses.length} harnesses in scope`,
          `${harnessPlan.task_set.planned_tasks} task specifications`,
          'No measurements',
          `Draft ${harnessPlan.protocol_version}`,
        ]}
      />
      <BoardTabs
        tabs={[
          {
            id: 'leaderboard',
            label: 'Leaderboard',
            content: (
              <HarnessResults {...controls}>
                <HarnessTaskMatrix
                  families={controls.workloads}
                  levels={harnessPlan.task_set.difficulty_levels.map(({ id, name }) => ({
                    id,
                    name,
                  }))}
                  tasks={harnessPlan.tasks}
                />
              </HarnessResults>
            ),
          },
          { id: 'records', label: 'Records', content: <HarnessResults {...controls} records /> },
          { id: 'method', label: 'Method', content: <HarnessMethod /> },
          { id: 'data', label: 'Data', content: <HarnessData /> },
        ]}
      />
    </>
  );
}
