import { BenchmarkHeading } from '../components/benchmark-heading.tsx';
import { BoardTabs } from '../components/board-tabs.tsx';
import { StudyEvidence } from '../components/study-evidence.tsx';
import { TableColumnHeading } from '../components/table-column-heading.tsx';
import { alphabetical } from '../display-order.ts';
import { listStudies, studyEvidence } from '../studies/repository.ts';
import type { Study } from '../studies/types.ts';
import type { BenchmarkBoard } from './boards.ts';
import { MemoryResults, MemoryStudyView } from './memory-results.tsx';
import { MemoryRecords } from './memory-records.tsx';
import { ReferenceDisclosure } from '../components/reference-disclosure.tsx';
import { ReferenceViewLinks } from '../components/reference-view-links.tsx';
import { ReferenceNavigation } from '../components/reference-layout.tsx';

function StudyMethod({ study }: { study: Study }) {
  return (
    <div className="reference-page">
      <p className="reference-lead">{study.sample}</p>
      <dl className="reference-reading-list">
        {study.groups.map((group) => (
          <div key={group.id}>
            <dt>{group.title}</dt>
            <dd>{group.description}</dd>
          </div>
        ))}
      </dl>
      <p className="reference-note">
        {study.id === 'native-memory'
          ? 'Answer completeness and exact quote binding are checked separately.'
          : 'Reader completeness and quote binding are separate checks. Writer resource use does not establish a semantic quality ranking.'}
      </p>
      <ReferenceViewLinks
        links={[
          { view: 'data', label: 'Download files' },
          { view: 'records', label: 'Open case records' },
        ]}
      />
      <ReferenceNavigation
        sections={[
          ['memory-conditions', 'Conditions'],
          ['memory-limits', 'Limits'],
          ['memory-versions', 'Versions'],
        ]}
      />
      <ReferenceDisclosure
        id="memory-conditions"
        title="Conditions"
        description="Inputs, shared settings, and execution environment"
      >
        <ul className="research-prose-list">
          {study.conditions.map((condition) => (
            <li key={condition}>{condition}</li>
          ))}
        </ul>
      </ReferenceDisclosure>
      <ReferenceDisclosure
        id="memory-limits"
        title="Limits"
        description="What this study can and cannot support"
      >
        <ul className="research-prose-list">
          {study.limitations.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </ReferenceDisclosure>
      <ReferenceDisclosure
        id="memory-versions"
        title="Compared versions"
        description={`${study.subjects.length} profiles · recorded model, version, and settings`}
      >
        <div
          className="research-table-scroll"
          role="region"
          tabIndex={0}
          aria-label="Compared versions"
        >
          <table className="research-table benchmark-version-table">
            <caption className="sr-only">Exact configurations in the selected study</caption>
            <thead>
              <tr>
                <th scope="col">
                  <TableColumnHeading label="Profile" />
                </th>
                <th scope="col">
                  <TableColumnHeading label="Version" unit="or model" />
                </th>
                <th scope="col">
                  <TableColumnHeading label="Configuration" />
                </th>
              </tr>
            </thead>
            <tbody>
              {alphabetical(study.subjects, (subject) => subject.label).map((subject) => (
                <tr key={subject.id}>
                  <th scope="row">{subject.label}</th>
                  <td data-label="Version / model">
                    <code>
                      {subject.configuration.version ??
                        subject.configuration.model ??
                        'Not recorded'}
                    </code>
                  </td>
                  <td data-label="Configuration">
                    <details className="configuration-details">
                      <summary>Settings</summary>
                      <dl className="evidence-facts">
                        {Object.entries(subject.configuration)
                          .filter(([key]) => key !== 'version' && key !== 'model')
                          .map(([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                      </dl>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ReferenceDisclosure>
    </div>
  );
}

export function MemoryBoardContent({ board }: { board: BenchmarkBoard }) {
  const studies = listStudies().filter((study) => board.studyIds.includes(study.id));
  const files = [
    ...new Map(studies.flatMap(studyEvidence).map((file) => [file.id, file])).values(),
  ];
  const uniqueFiles = new Set(files.map((file) => file.sha256)).size;
  const sourceIds = new Set(
    studies.flatMap((study) =>
      study.groups.flatMap((group) => group.runs.flatMap((run) => run.evidenceIds)),
    ),
  );
  const sources = Object.fromEntries(
    files
      .filter((file) => sourceIds.has(file.id))
      .map((file) => [file.id, { href: file.href, path: file.path }]),
  );
  return (
    <>
      <BenchmarkHeading
        title={board.title}
        description="Memory systems, readers, and writers."
        facts={[
          `${studies.length} studies`,
          `${studies.reduce((sum, study) => sum + study.groups.length, 0)} comparisons`,
          `${uniqueFiles} original files`,
        ]}
      />
      <BoardTabs
        tabs={[
          {
            id: 'leaderboard',
            label: 'Leaderboard',
            content: (
              <MemoryResults
                studies={studies.map(({ id, title, groups, subjects }) => ({
                  id,
                  title,
                  groups,
                  subjects,
                }))}
                sources={sources}
              />
            ),
          },
          {
            id: 'records',
            label: 'Records',
            content: (
              <MemoryStudyView
                title="Case records"
                description="Browse saved questions, compare outputs, and inspect their source evidence."
                studies={studies.map((study) => ({
                  id: study.id,
                  title: study.title,
                  content: (
                    <MemoryRecords
                      studyId={study.id}
                      cases={study.cases.map((item) => ({
                        id: item.id,
                        title: item.title,
                        kind: item.kind,
                        question: item.question,
                        explanation: item.explanation,
                        outputCount: item.observations.length,
                      }))}
                    />
                  ),
                }))}
              />
            ),
          },
          {
            id: 'method',
            label: 'Method',
            content: (
              <MemoryStudyView
                title="Study method"
                description="What each comparison tests, what stays fixed, and how to read its measures."
                studies={studies.map((study) => ({
                  id: study.id,
                  title: study.title,
                  content: <StudyMethod study={study} />,
                }))}
              />
            ),
          },
          {
            id: 'data',
            label: 'Data',
            content: (
              <MemoryStudyView
                title="Study files"
                description="Download reports and measured summaries, or trace a case to its saved outputs."
                studies={studies.map((study) => ({
                  id: study.id,
                  title: study.title,
                  content: <StudyEvidence files={studyEvidence(study)} />,
                }))}
              />
            ),
          },
        ]}
      />
    </>
  );
}
