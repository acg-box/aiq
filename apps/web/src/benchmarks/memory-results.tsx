'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ReferenceHeader } from '../components/reference-layout.tsx';
import { alphabetical } from '../display-order.ts';
import { StudyResultsTable, type StudySources } from '../components/study-results-table.tsx';
import { StudyComparisonCharts } from '../components/study-comparison-charts.tsx';
import { ComparisonFilters } from '../components/comparison-filters.tsx';
import { SectionLink } from '../components/section-link.tsx';
import { TableNotes } from '../components/table-notes.tsx';
import { useWorkspaceQuery } from '../components/workspace-query.ts';
import { studyDate } from '../studies/format.ts';
import { comparisonFinding, studyDisplayName } from '../studies/presentation.ts';
import type { ComparisonGroup, Study } from '../studies/types.ts';

type ComparisonStudy = Pick<Study, 'id' | 'title' | 'groups' | 'subjects'>;

const workloadLabels: Record<string, string> = {
  native: 'Native retrieval + shared reader',
  nightly: 'RAGFlow nightly version check',
  reader: 'Fixed-context reader replay',
  writer: 'Extraction prompt replay',
};

const overviewLabels: Record<string, string> = {
  native: 'Systems · native retrieval',
  nightly: 'Systems · nightly version check',
  reader: 'Readers · fixed-context replay',
  writer: 'Writers · extraction replay',
};

function measuredRange(group: ComparisonGroup, key: string, format: (value: number) => string) {
  const values = group.results.flatMap((result) =>
    typeof result.values[key] === 'number' ? [result.values[key]] : [],
  );
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? format(low) : `${format(low)}–${format(high)}`;
}

function MemoryOverview({
  studies,
  selectedStudy,
  selectedTest,
}: {
  studies: ComparisonStudy[];
  selectedStudy: string;
  selectedTest: string;
}) {
  const { href } = useWorkspaceQuery();
  return (
    <section className="memory-overview" aria-labelledby="memory-overview-title">
      <div className="overview-heading overview-heading-actions">
        <div>
          <h2 id="memory-overview-title" tabIndex={-1}>
            All memory comparisons
          </h2>
          <p>
            Complete + bound counts complete answers with source-matched quotes. Each row is a
            separate test.
          </p>
        </div>
        <SectionLink targetId="memory-comparison">Selected comparison ↓</SectionLink>
      </div>
      <table className="memory-overview-table">
        <caption className="sr-only">Memory comparison overview</caption>
        <thead>
          <tr>
            <th scope="col">Comparison</th>
            <th scope="col">Complete + bound</th>
            <th scope="col">Resources</th>
            <th scope="col">Evidence scale</th>
          </tr>
        </thead>
        <tbody>
          {alphabetical(
            studies.flatMap((study) => study.groups.map((group) => ({ study, group }))),
            ({ study, group }) =>
              `${overviewLabels[group.id] ?? group.title} · ${studyDisplayName(study.id, study.title)}`,
          ).map(({ study, group }) => {
            const profiles = alphabetical(
              group.runs.map((run) => ({
                label:
                  study.subjects.find((subject) => subject.id === run.subjectId)?.label ??
                  run.subjectId,
                bound: group.results.find((result) => result.runId === run.id)?.values.bound,
              })),
              (profile) => profile.label,
            );
            const cost = measuredRange(group, 'cost', (value) => `$${value.toFixed(6)}`);
            const time = measuredRange(group, 'time', (value) => value.toFixed(2));
            const timeOmission = group.metrics.find(
              (metric) => metric.key === 'time',
            )?.unavailableReason;
            const samples = [...new Set(group.runs.map((run) => run.sampleSize))].join(' / ');
            const detailHref = `${href({ study: study.id, test: group.id, metric: null, metricOrder: null })}#memory-comparison`;
            const current = study.id === selectedStudy && group.id === selectedTest;
            return (
              <tr key={`${study.id}-${group.id}`} data-selected={current || undefined}>
                <th scope="row">
                  <SectionLink
                    href={detailHref}
                    targetId="memory-comparison"
                    current={current}
                    preserveVisibleTarget
                  >
                    {overviewLabels[group.id] ?? group.title} →{' '}
                    <span>
                      {studyDisplayName(study.id, study.title)}
                      {current ? <small className="overview-current"> Viewing</small> : null}
                    </span>
                  </SectionLink>
                </th>
                <td data-label="Complete + bound">
                  {group.metrics.some((metric) => metric.key === 'bound') ? (
                    <ul className="overview-profile-results">
                      {profiles.map((profile) => (
                        <li key={profile.label}>
                          <span>{profile.label}</span>
                          <strong>
                            {profile.bound && typeof profile.bound === 'object'
                              ? `${profile.bound.pass}/${profile.bound.total}`
                              : 'Not measured'}
                          </strong>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <>
                      <span className="overview-unmeasured">Quality not measured</span>
                      <small>{profiles.map((profile) => profile.label).join(' · ')}</small>
                    </>
                  )}
                </td>
                <td data-label="Resources" className="overview-resources">
                  <span>{cost ?? 'Cost not reported'}</span>
                  <small>
                    {time
                      ? `${time} s / request`
                      : timeOmission
                        ? `Time: ${timeOmission.toLowerCase()}`
                        : 'Time not reported'}
                  </small>
                </td>
                <td data-label="Evidence scale">
                  <span>{samples} inputs / profile</span>
                  <small>
                    {group.runs.length} {group.runs.length === 1 ? 'profile' : 'profiles'} · one
                    pass
                  </small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TableNotes label="Memory overview" hint="Separate tests · no combined ranking.">
        <p>
          Costs are workload totals in USD; resource ranges span profiles within that row. Quote
          binding does not establish semantic entailment.
        </p>
      </TableNotes>
    </section>
  );
}

function SelectedComparison({
  study,
  group,
  sources,
}: {
  study: ComparisonStudy;
  group: ComparisonGroup;
  sources: StudySources;
}) {
  const { href } = useWorkspaceQuery();
  const sampleSizes = [...new Set(group.runs.map((run) => run.sampleSize))].join(' / ');
  const dates = [...new Set(group.runs.map((run) => studyDate(run.date)))].join(' / ');
  return (
    <div className="results-data" aria-live="polite">
      <div className="results-selection-meta">
        <p className="results-dataset">
          {sampleSizes} inputs / profile · {group.runs.length} profiles · {dates}
        </p>
        <Link href={href({ view: 'method' })} scroll={false}>
          Test method
        </Link>
      </div>
      <StudyComparisonCharts group={group} subjects={study.subjects} />
      <div className="comparison-table-heading">
        <h2 id="memory-rankings" tabIndex={-1}>
          Results and evidence
        </h2>
        <p className="results-desktop-help">
          Sort columns. Open Details for the profile and original record.
        </p>
      </div>
      <div className="study-results-workspace">
        <StudyResultsTable
          key={group.id}
          group={group}
          subjects={study.subjects}
          sources={sources}
        />
      </div>
      <TableNotes
        label="Memory comparison"
        hint={
          group.metrics.some((metric) => metric.unavailableReason)
            ? 'One pass · — Withheld from comparison.'
            : 'One pass · — Not measured.'
        }
      >
        <p>
          USD totals are rounded to 6 decimals. The value tooltip and original record retain the
          recorded precision. Sorting is descriptive.
        </p>
        <p>{group.costScope}</p>
        <h3>Recorded finding</h3>
        <p>{comparisonFinding(study.id, group.id)}</p>
        <h3>Protocol and metric definitions</h3>
        <p>{group.description}</p>
        <p>Synthetic inputs · real provider calls · one pass · no repeated-trial interval.</p>
        <p>
          {group.metrics.some((metric) => metric.key === 'bound')
            ? 'Complete + bound: complete answer with every quote matched to its supplied source. Complete: complete answers, before quote binding. Quotes: matched / emitted quotes, with a separate denominator. Source binding alone does not establish semantic entailment.'
            : 'Inputs: paired extraction requests. Time: mean request duration. Cost: settled USD for the selected workload. Output counts and JSON parsing are not quality scores.'}
        </p>
        <Link href={href({ view: 'method' })} scroll={false}>
          Full conditions and limitations
        </Link>
      </TableNotes>
    </div>
  );
}

export function MemoryResults({
  studies,
  sources,
}: {
  studies: ComparisonStudy[];
  sources: StudySources;
}) {
  const { params, update } = useWorkspaceQuery();
  const selected = params.get('study');
  const study = studies.find((candidate) => candidate.id === selected) ?? studies[0];
  if (!study) return null;
  const group =
    study.groups.find((candidate) => candidate.id === params.get('test')) ?? study.groups[0];
  if (!group) return null;
  return (
    <section className="memory-workspace" aria-labelledby="memory-results-heading">
      <h2 className="sr-only" id="memory-results-heading">
        Results
      </h2>
      <MemoryOverview studies={studies} selectedStudy={study.id} selectedTest={group.id} />
      <section className="memory-detail" aria-labelledby="memory-comparison">
        <div className="overview-heading overview-heading-actions">
          <div>
            <h2 id="memory-comparison" tabIndex={-1}>
              {overviewLabels[group.id] ?? group.title}
            </h2>
            <p>
              {studyDisplayName(study.id, study.title)} · {workloadLabels[group.id] ?? group.title}
            </p>
          </div>
          <SectionLink targetId="memory-overview-title">↑ All comparisons</SectionLink>
        </div>
        <ComparisonFilters>
          <div className="results-controls">
            <MemoryStudySelector studies={studies} selected={study.id} />
            <div className="results-test-control">
              <label htmlFor="memory-test">Test</label>
              <select
                id="memory-test"
                value={group.id}
                onChange={(event) =>
                  update({ test: event.target.value, metric: null, metricOrder: null })
                }
              >
                {alphabetical(
                  study.groups,
                  (candidate) => workloadLabels[candidate.id] ?? candidate.title,
                ).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {workloadLabels[candidate.id] ?? candidate.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </ComparisonFilters>
        <SelectedComparison
          key={`${study.id}-${group.id}`}
          study={study}
          group={group}
          sources={sources}
        />
      </section>
    </section>
  );
}

function MemoryStudySelector({
  studies,
  selected,
}: {
  studies: { id: string; title: string }[];
  selected: string;
}) {
  const { update } = useWorkspaceQuery();
  return (
    <div className="results-study-control">
      <label htmlFor="memory-study">Study</label>
      <select
        id="memory-study"
        value={selected}
        onChange={(event) =>
          update({
            study: event.target.value,
            test: null,
            metric: null,
            metricOrder: null,
            caseSearch: null,
            caseKind: null,
          })
        }
      >
        {alphabetical(studies, (study) => studyDisplayName(study.id, study.title)).map((study) => (
          <option key={study.id} value={study.id}>
            {studyDisplayName(study.id, study.title)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function MemoryStudyView({
  studies,
  title,
  description,
}: {
  studies: { id: string; title: string; content: ReactNode }[];
  title: string;
  description: string;
}) {
  const { params } = useWorkspaceQuery();
  const study = studies.find((candidate) => candidate.id === params.get('study')) ?? studies[0];
  if (!study) return null;
  return (
    <>
      <ReferenceHeader title={title} description={description} />
      <div className="memory-view-controls">
        <ComparisonFilters label="Change study" context={studyDisplayName(study.id, study.title)}>
          <div className="results-controls">
            <MemoryStudySelector studies={studies} selected={study.id} />
          </div>
        </ComparisonFilters>
      </div>
      <div key={study.id}>{study.content}</div>
    </>
  );
}

export function MemoryCaseLink({
  studyId,
  caseId,
  children,
}: {
  studyId: string;
  caseId: string;
  children: ReactNode;
}) {
  const { href } = useWorkspaceQuery();
  return (
    <Link
      className="record-open memory-case-link"
      prefetch={false}
      href={`/benchmarks/memory/records/${studyId}/${caseId}?return=${encodeURIComponent(href({ view: 'records' }))}`}
    >
      <span>{children}</span>
      <ArrowRightIcon size={15} aria-hidden="true" />
    </Link>
  );
}
