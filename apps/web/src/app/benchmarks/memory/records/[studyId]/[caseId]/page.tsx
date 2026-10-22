import { Suspense } from 'react';
import { BoardDetailNavigation } from '../../../../../../components/board-detail-navigation.tsx';
import { notFound } from 'next/navigation';
import { EvidenceLinks } from '../../../../../../components/study-evidence.tsx';
import { findStudy, listStudies } from '../../../../../../studies/repository.ts';
import { createPageMetadata } from '../../../../../site-metadata.ts';
import { ReferenceNavigation } from '../../../../../../components/reference-layout.tsx';
import { alphabetical } from '../../../../../../display-order.ts';
import { ReferenceDisclosure } from '../../../../../../components/reference-disclosure.tsx';
import { SectionLink } from '../../../../../../components/section-link.tsx';
import { TableColumnHeading } from '../../../../../../components/table-column-heading.tsx';
import { studyDisplayName } from '../../../../../../studies/presentation.ts';

type Params = Promise<{ studyId: string; caseId: string }>;
export function generateStaticParams() {
  return listStudies().flatMap((study) =>
    study.cases.map((item) => ({ studyId: study.id, caseId: item.id })),
  );
}

export async function generateMetadata({ params }: { params: Params }) {
  const { studyId: id, caseId } = await params;
  const study = findStudy(id);
  const item = study?.cases.find((candidate) => candidate.id === caseId);
  if (!study || !item) notFound();
  return createPageMetadata({
    title: `${item.id} · ${study.title}`,
    path: `/benchmarks/memory/records/${id}/${caseId}`,
    description: item.explanation,
  });
}

export default async function CasePage({ params }: { params: Params }) {
  const { studyId: id, caseId } = await params;
  const study = findStudy(id);
  const item = study?.cases.find((candidate) => candidate.id === caseId);
  if (!study || !item) notFound();
  const observations = alphabetical(item.observations, (observation) => observation.subject);
  return (
    <article className="research-shell research-inner research-case-detail">
      <Suspense>
        <BoardDetailNavigation board="memory" />
      </Suspense>
      <p className="research-meta">
        {studyDisplayName(study.id, study.title)} · {item.kind} · Independent research
      </p>
      <h1>{item.title}</h1>
      <ReferenceNavigation
        sections={[
          ['case-comparison', 'Comparison'],
          ['case-question', 'Input'],
          ...observations.map(
            (observation, observationIndex) =>
              [`case-observation-${observationIndex}`, observation.subject] as const,
          ),
          ['case-protocol', 'Originals'],
        ]}
      />
      <section id="case-comparison" className="case-comparison">
        <h2 id="case-comparison-heading" tabIndex={-1}>
          Result comparison
        </h2>
        <div
          className="research-table-scroll"
          role="region"
          aria-label="Case result comparison"
          tabIndex={0}
        >
          <table className="research-table case-outcome-table">
            <caption className="sr-only">
              Saved outcomes for this case. Rows are separate observations, not an aggregate score.
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <TableColumnHeading label="Profile" />
                </th>
                <th scope="col">
                  <TableColumnHeading label={item.kind === 'reader' ? 'Answer' : 'Output'} />
                </th>
                <th scope="col">
                  <TableColumnHeading
                    label={item.kind === 'reader' ? 'Quotes' : 'Quality'}
                    {...(item.kind === 'reader' ? { unit: 'source match' } : {})}
                    accessibleLabel={
                      item.kind === 'reader' ? 'Literal quote binding' : 'Semantic quality'
                    }
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {observations.map((observation, index) => (
                <tr key={observation.subject}>
                  <th scope="row">
                    <SectionLink
                      targetId={`case-observation-${index}-heading`}
                      href={`#case-observation-${index}`}
                    >
                      {observation.subject}
                    </SectionLink>
                  </th>
                  <td data-label={item.kind === 'reader' ? 'Answer' : 'Output'}>
                    {observation.answer === null
                      ? 'No paired control'
                      : item.kind === 'writer'
                        ? 'Saved'
                        : observation.semanticComplete === null
                          ? 'Not scored'
                          : observation.semanticComplete
                            ? 'Complete'
                            : 'Incomplete'}
                  </td>
                  <td data-label={item.kind === 'reader' ? 'Quote binding' : 'Quality'}>
                    {item.kind === 'writer'
                      ? 'Not scored'
                      : observation.quotesBound === null
                        ? 'Not applicable'
                        : observation.quotesBound
                          ? 'All quotes bound'
                          : 'Failed'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="case-main-finding">{item.explanation}</p>
        {item.kind === 'writer' ? (
          <p className="reference-note">
            Saved outputs and resource use do not establish a semantic quality ranking.
          </p>
        ) : null}
      </section>
      <ReferenceDisclosure
        id="case-question"
        title={item.kind === 'reader' ? 'The question' : 'The extraction input'}
        description={`${item.question.length.toLocaleString('en-US')} characters · complete saved input`}
      >
        <p className="case-input-text">{item.question}</p>
      </ReferenceDisclosure>
      <h2 className="case-observations-heading">Outputs and evidence</h2>
      {observations.map((observation, observationIndex) => (
        <ReferenceDisclosure
          id={`case-observation-${observationIndex}`}
          title={observation.subject}
          description={
            observation.answer === null
              ? 'No paired control · review and source files'
              : item.kind === 'writer'
                ? 'Saved output · quality not scored'
                : `${observation.semanticComplete ? 'Complete answer' : 'Incomplete answer'} · ${observation.quotesBound ? 'quotes bound' : 'quote binding failed'}`
          }
          key={observation.subject}
        >
          <div className="research-case-status">
            <span>
              Semantic completeness:{' '}
              <strong>
                {observation.semanticComplete === null
                  ? 'Not scored'
                  : observation.semanticComplete
                    ? 'Complete'
                    : 'Incomplete'}
              </strong>
            </span>
            <span>
              Literal quote binding:{' '}
              <strong>
                {observation.quotesBound === null
                  ? 'Not applicable'
                  : observation.quotesBound
                    ? 'All quotes bound'
                    : 'Failed'}
              </strong>
            </span>
          </div>
          <h4>Review</h4>
          <p>{observation.review}</p>
          <h4>{observation.answer === null ? 'Control unavailable' : 'Saved output'}</h4>
          {observation.answer === null ? (
            <p>No paired control was run for this input in this campaign.</p>
          ) : (
            <details className="research-disclosure saved-output-disclosure">
              <summary>
                {item.kind === 'writer' ? 'Original JSON' : 'Complete saved output'} ·{' '}
                {observation.answer.length.toLocaleString()} characters
              </summary>
              <pre
                className="research-answer"
                data-format={item.kind === 'writer' ? 'code' : 'text'}
                tabIndex={0}
              >
                {observation.answer}
              </pre>
            </details>
          )}
          {observation.citations.length ? (
            <details className="research-disclosure">
              <summary>Returned citations · {observation.citations.length}</summary>
              {observation.citations.map((citation, index) => (
                <blockquote className="research-citation" key={`${citation.handle}-${index}`}>
                  <code>{citation.handle}</code>
                  <p>{citation.quote}</p>
                </blockquote>
              ))}
            </details>
          ) : null}
          {observation.context.length ? (
            <details className="research-disclosure">
              <summary>
                Exact evidence supplied to the reader · {observation.context.length} entries
              </summary>
              {observation.context.map((entry, index) => (
                <div className="research-context-entry" key={`${entry.handle}-${index}`}>
                  <code>{entry.handle}</code>
                  <p>{entry.text}</p>
                </div>
              ))}
            </details>
          ) : null}
          <details className="research-disclosure">
            <summary>Original files · {observation.evidenceIds.length} source records</summary>
            <EvidenceLinks ids={observation.evidenceIds} />
          </details>
        </ReferenceDisclosure>
      ))}
      <ReferenceDisclosure
        id="case-protocol"
        title="Protocol and expected facts"
        description="Original files, case ID, and interpretation limits"
      >
        <p className="reference-note">
          Case ID: <code>{item.id}</code>
        </p>
        <EvidenceLinks ids={item.evidenceIds} />
        <p className="research-muted">
          A matching quote establishes a literal binding. Semantic support and subject correctness
          require separate review. Historical outputs remain unchanged.
        </p>
      </ReferenceDisclosure>
    </article>
  );
}
