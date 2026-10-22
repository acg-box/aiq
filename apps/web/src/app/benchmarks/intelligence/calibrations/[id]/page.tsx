import { BoardDetailNavigation } from '../../../../../components/board-detail-navigation.tsx';
import { TableColumnHeading } from '../../../../../components/table-column-heading.tsx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { alphabetical } from '../../../../../display-order.ts';

import { CalibrationEfficiency } from '../../../../../components/calibration-efficiency.tsx';
import {
  ExpandableTableRow,
  RowDetailContext,
  TableRowFacts,
} from '../../../../../components/expandable-table-row.tsx';
import { ReadStateNote } from '../../../../../components/read-state-note.tsx';
import { formatTaskDuration } from '../../../../../data/format-duration.ts';
import { readPublicData } from '../../../../../data/read-state.ts';
import {
  CALIBRATION_MODEL_CONFIGURATIONS,
  calibrationConfigurationKey,
  createAiqRepository,
  parseCalibrationConfiguration,
} from '../../../../../data/repository.ts';
import { uncachedInputTokens } from '../../../../../data/token-usage.ts';
import { createPageMetadata } from '../../../../site-metadata.ts';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return createPageMetadata({
    title: 'Calibration detail',
    path: `/benchmarks/intelligence/calibrations/${encodeURIComponent(id)}`,
    description: 'Inspect replay-verified evidence for one public, non-Official AIQ calibration.',
  });
}
export const dynamic = 'force-dynamic';

type CalibrationDetailSearchParams = { configuration?: string | string[]; return?: string };

export default async function CalibrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<CalibrationDetailSearchParams>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (Array.isArray(query.configuration)) notFound();

  const repository = createAiqRepository();
  const scores = await readPublicData(
    repository,
    () => repository.listCalibrationScores(id),
    [],
    (value) => value.length === 0,
    (value) => value.map((score) => score.synthetic),
  );
  const firstScore = scores.data[0];
  const selection =
    query.configuration === undefined
      ? firstScore && {
          modelFamily: firstScore.modelFamily,
          reasoningEffort: firstScore.reasoningEffort,
        }
      : parseCalibrationConfiguration(query.configuration);
  if (
    !selection ||
    !scores.data.some(
      (score) =>
        score.modelFamily === selection.modelFamily &&
        score.reasoningEffort === selection.reasoningEffort,
    )
  )
    notFound();
  const result = await readPublicData(
    repository,
    () => repository.getCalibrationRun(id, selection),
    null,
    (value) => value === null,
    (value) => (value ? [value.synthetic] : []),
  );
  if (result.state === 'empty') notFound();
  const run = result.data;
  const selectedKey = calibrationConfigurationKey(selection);
  const supportedConfigurations = CALIBRATION_MODEL_CONFIGURATIONS.filter((configuration) =>
    scores.data.some(
      (score) =>
        score.modelFamily === configuration.modelFamily &&
        score.reasoningEffort === configuration.reasoningEffort,
    ),
  );
  const selectedExecutionContext = run
    ? new Map([
        [
          selectedKey,
          {
            runtimeIssues: run.results.filter((item) => item.executionStatus === 'runtime_issue')
              .length,
            missing: run.results.filter((item) => item.executionStatus === 'missing').length,
          },
        ],
      ])
    : new Map();

  return (
    <section className="page-shell inner-page">
      <BoardDetailNavigation
        board="intelligence"
        selected="records"
        fallback="/benchmarks/intelligence/calibrations"
      />
      <div className="page-intro">
        <span className="eyebrow">Diagnostic run</span>
        <h1>Calibration run</h1>
        <p>
          Inspect one replay-verified diagnostic matrix. Private task payloads and raw provider
          events remain sealed; safe explanations, usage, and recomputed cost stay public.
        </p>
      </div>
      <ReadStateNote result={result} subject="Selected configuration" />
      {run ? (
        <>
          <dl className="calibration-facts">
            <div>
              <dt>Run</dt>
              <dd>
                <code>{run.id}</code>
              </dd>
            </div>
            <div>
              <dt>Full selection</dt>
              <dd>
                {run.selectedModelCount} models × {run.selectedTaskCount} tasks ·{' '}
                {run.resultCount.toLocaleString()} retained cells
              </dd>
            </div>
            <div>
              <dt>Current filter</dt>
              <dd>
                {selection.modelFamily} · {selection.reasoningEffort}
              </dd>
            </div>
            <div>
              <dt>Replay</dt>
              <dd>Evaluator replayed</dd>
            </div>
            <div>
              <dt>Scoring</dt>
              <dd>{run.scoringVersion || 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd>
                <time dateTime={run.publishedAt}>{new Date(run.publishedAt).toLocaleString()}</time>
              </dd>
            </div>
          </dl>
          <form
            className="calibration-filter"
            action={`/benchmarks/intelligence/calibrations/${id}`}
            method="get"
          >
            {query.return ? <input type="hidden" name="return" value={query.return} /> : null}
            <label className="calibration-filter-control" htmlFor="configuration">
              <span>Model and reasoning configuration</span>
              <select id="configuration" name="configuration" defaultValue={selectedKey}>
                {alphabetical(
                  supportedConfigurations,
                  (configuration) => configuration.modelFamily,
                ).map((configuration) => {
                  const key = calibrationConfigurationKey(configuration);
                  return (
                    <option key={key} value={key}>
                      {configuration.modelFamily} · {configuration.reasoningEffort}
                    </option>
                  );
                })}
              </select>
            </label>
            <button type="submit" className="ui-action">
              Show {run.selectedTaskCount}-task subset
            </button>
          </form>
          <p
            className="calibration-slice-count"
            role="status"
            aria-label="Calibration result count"
          >
            Showing {run.results.length.toLocaleString()} of {run.resultCount.toLocaleString()}{' '}
            result cells for {selection.modelFamily} · {selection.reasoningEffort}.
          </p>
          <div className="table-scroll" role="region" aria-label="Calibration results" tabIndex={0}>
            <table className="calibration-results-table compact-table measurement-table">
              <thead>
                <tr>
                  <th scope="col">
                    <TableColumnHeading label="Task" unit="version" />
                  </th>
                  <th scope="col" className="compact-secondary">
                    <TableColumnHeading label="Domain" />
                  </th>
                  <th scope="col">
                    <TableColumnHeading label="Outcome" unit="execution" />
                  </th>
                  <th scope="col" className="compact-secondary">
                    <TableColumnHeading label="Explanation" unit="public summary" />
                  </th>
                  <th scope="col">
                    <TableColumnHeading label="Task score" unit="0–1" />
                  </th>
                  <th scope="col" className="compact-secondary">
                    <TableColumnHeading label="Adapter time" unit="per task" />
                  </th>
                  <th scope="col" className="compact-secondary">
                    <TableColumnHeading label="Tokens" unit="provider reported" />
                  </th>
                  <th scope="col" className="compact-secondary">
                    <TableColumnHeading label="API cost" unit="USD estimate" />
                  </th>
                  <th className="row-expand-cell">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {run.results.map((item) => (
                  <ExpandableTableRow
                    key={item.id}
                    label={item.taskId}
                    visibleColumns={3}
                    details={
                      <>
                        <TableRowFacts
                          items={[
                            {
                              label: 'Task score',
                              unit: '0–1',
                              value:
                                item.taskScore === null ? 'Unavailable' : item.taskScore.toFixed(3),
                            },
                            {
                              label: 'Outcome',
                              unit: 'execution',
                              value: `${item.outcome.replaceAll('_', ' ')} · ${item.executionStatus.replaceAll('_', ' ')}`,
                            },
                            {
                              label: 'Adapter time',
                              unit: 'per task',
                              value:
                                item.latencyMs === null
                                  ? 'Unavailable'
                                  : formatTaskDuration(item.latencyMs),
                            },
                            {
                              label: 'API cost',
                              unit: 'USD estimate',
                              value:
                                item.standardApiEquivalentUsdNanos === null
                                  ? 'Unavailable'
                                  : `$${(item.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(6)}`,
                            },
                            {
                              label: 'Tokens',
                              unit: 'provider reported · total',
                              value: item.totalTokens?.toLocaleString() ?? 'Unavailable',
                            },
                            { label: 'Domain', value: item.domain.replaceAll('_', ' ') },
                          ]}
                        />
                        <RowDetailContext>
                          <TableRowFacts
                            layout="rows"
                            items={[
                              {
                                label: 'Task',
                                unit: 'version',
                                value: `${item.taskId} · v${item.taskVersion}`,
                              },
                              {
                                label: 'Explanation',
                                unit: 'public summary',
                                value: (
                                  <>
                                    {item.explanationSummary ?? 'No failure explanation'}
                                    {item.explanationCode ? (
                                      <small>Code: {item.explanationCode}</small>
                                    ) : null}
                                  </>
                                ),
                              },
                              {
                                label: 'Time evidence',
                                value:
                                  item.latencyEvidenceLevel?.replaceAll('_', ' ') ?? 'Not observed',
                              },
                              {
                                label: 'Tokens',
                                unit: 'provider reported',
                                value: (
                                  <dl className="token-breakdown">
                                    {[
                                      [
                                        'Uncached input',
                                        uncachedInputTokens(
                                          item.inputTokens,
                                          item.cachedInputTokens,
                                          item.cacheWriteInputTokens,
                                        ),
                                      ],
                                      ['Cache read', item.cachedInputTokens],
                                      ['Cache write', item.cacheWriteInputTokens],
                                      ['Output', item.outputTokens],
                                      ['Reasoning', item.reasoningOutputTokens],
                                      ['Total', item.totalTokens],
                                    ].map(([label, value]) => (
                                      <div key={String(label)}>
                                        <dt>{label}</dt>
                                        <dd>{value?.toLocaleString() ?? 'Unavailable'}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                ),
                              },
                              {
                                label: 'Cost estimate',
                                unit: 'status / limits',
                                value: (
                                  <>
                                    {item.costEstimatorStatus.replaceAll('_', ' ')}
                                    <small>{item.costEstimatorLimitations.join(' ')}</small>
                                  </>
                                ),
                              },
                            ]}
                          />
                        </RowDetailContext>
                      </>
                    }
                  >
                    <th scope="row">
                      <span className="compact-row-title">{item.taskId}</span>
                      <small>v{item.taskVersion}</small>
                    </th>
                    <td className="compact-secondary">{item.domain}</td>
                    <td>
                      {item.outcome.replaceAll('_', ' ')}
                      <small>Execution: {item.executionStatus.replaceAll('_', ' ')}</small>
                    </td>
                    <td className="compact-secondary">
                      {item.explanationSummary ?? 'No failure explanation'}
                      {item.explanationCode ? <small>Code: {item.explanationCode}</small> : null}
                    </td>
                    <td>{item.taskScore === null ? 'Unavailable' : item.taskScore.toFixed(3)}</td>
                    <td className="compact-secondary">
                      {item.latencyMs === null ? 'Unavailable' : formatTaskDuration(item.latencyMs)}
                      <small>
                        {item.latencyEvidenceLevel?.replaceAll('_', ' ') ?? 'not observed'}
                      </small>
                    </td>
                    <td className="compact-secondary">
                      uncached input{' '}
                      {uncachedInputTokens(
                        item.inputTokens,
                        item.cachedInputTokens,
                        item.cacheWriteInputTokens,
                      )?.toLocaleString() ?? 'unavailable'}{' '}
                      · cache read {item.cachedInputTokens?.toLocaleString() ?? 'unavailable'} ·
                      cache write {item.cacheWriteInputTokens?.toLocaleString() ?? 'unavailable'} ·
                      output {item.outputTokens?.toLocaleString() ?? 'unavailable'}
                      <small>
                        reasoning {item.reasoningOutputTokens?.toLocaleString() ?? 'unavailable'} ·
                        total {item.totalTokens?.toLocaleString() ?? 'unavailable'}
                      </small>
                    </td>
                    <td className="compact-secondary">
                      {item.standardApiEquivalentUsdNanos === null
                        ? 'Unavailable'
                        : `$${(item.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(6)}`}
                      <small>{item.costEstimatorStatus.replaceAll('_', ' ')}</small>
                      {item.costEstimatorLimitations.length > 0 ? (
                        <small>{item.costEstimatorLimitations.join(' ')}</small>
                      ) : null}
                    </td>
                  </ExpandableTableRow>
                ))}
              </tbody>
            </table>
          </div>
          <ReadStateNote result={scores} subject="Full run score matrix" />
          {scores.state === 'unavailable' ? null : (
            <CalibrationEfficiency
              scores={scores.data}
              scoringVersion={run.scoringVersion || null}
              executionContext={selectedExecutionContext}
            />
          )}
        </>
      ) : null}
    </section>
  );
}
