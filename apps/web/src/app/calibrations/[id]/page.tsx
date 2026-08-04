import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CalibrationEfficiency } from '../../../components/calibration-efficiency.tsx';
import { ReadStateNote } from '../../../components/read-state-note.tsx';
import { formatTaskDuration } from '../../../data/format-duration.ts';
import { readPublicData } from '../../../data/read-state.ts';
import {
  CALIBRATION_MODEL_CONFIGURATIONS,
  calibrationConfigurationKey,
  createAiqRepository,
  parseCalibrationConfiguration,
} from '../../../data/repository.ts';
import { uncachedInputTokens } from '../../../data/token-usage.ts';
import { createPageMetadata } from '../../site-metadata.ts';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return createPageMetadata({
    title: 'Calibration detail',
    path: `/calibrations/${encodeURIComponent(id)}`,
    description: 'Inspect replay-verified evidence for one public, non-Official AIQ calibration.',
  });
}
export const dynamic = 'force-dynamic';

type CalibrationDetailSearchParams = { configuration?: string | string[] };

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

  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Calibration detail</span>
        <h1>Calibration evidence</h1>
        <p>
          This bounded public view omits packages, signatures, private artifacts, raw responses,
          envelopes, and private failure details. It publishes fixed safe explanations and
          verifier-recomputed numeric usage and cost evidence without retained provider-event
          contents.
        </p>
      </div>
      <ReadStateNote result={result} subject="Selected configuration" />
      {run ? (
        <>
          <dl className="calibration-facts">
            <div>
              <dt>Run</dt>
              <dd>{run.id}</dd>
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
              <dt>Published</dt>
              <dd>
                <time dateTime={run.publishedAt}>{new Date(run.publishedAt).toLocaleString()}</time>
              </dd>
            </div>
          </dl>
          <form className="calibration-filter" action={`/calibrations/${id}`} method="get">
            <label htmlFor="configuration">Model and reasoning configuration</label>
            <select id="configuration" name="configuration" defaultValue={selectedKey}>
              {supportedConfigurations.map((configuration) => {
                const key = calibrationConfigurationKey(configuration);
                return (
                  <option key={key} value={key}>
                    {configuration.modelFamily} · {configuration.reasoningEffort}
                  </option>
                );
              })}
            </select>
            <button type="submit">Show {run.selectedTaskCount}-task subset</button>
          </form>
          <p className="calibration-slice-count" role="status">
            Showing {run.results.length.toLocaleString()} of {run.resultCount.toLocaleString()}{' '}
            result cells for {selection.modelFamily} · {selection.reasoningEffort}.
          </p>
          <div className="table-scroll" role="region" aria-label="Calibration results" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Domain</th>
                  <th>Outcome / execution</th>
                  <th>Public explanation</th>
                  <th>Task score</th>
                  <th>Observed adapter elapsed</th>
                  <th>Provider tokens</th>
                  <th>Estimated token cost</th>
                </tr>
              </thead>
              <tbody>
                {run.results.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.taskId}
                      <small>v{item.taskVersion}</small>
                    </td>
                    <td>{item.domain}</td>
                    <td>
                      {item.outcome.replaceAll('_', ' ')}
                      <small>Execution: {item.executionStatus.replaceAll('_', ' ')}</small>
                    </td>
                    <td>
                      {item.explanationSummary ?? 'No failure explanation'}
                      {item.explanationCode ? <small>Code: {item.explanationCode}</small> : null}
                    </td>
                    <td>{item.taskScore === null ? 'Unavailable' : item.taskScore.toFixed(3)}</td>
                    <td>
                      {item.latencyMs === null ? 'Unavailable' : formatTaskDuration(item.latencyMs)}
                      <small>
                        {item.latencyEvidenceLevel?.replaceAll('_', ' ') ?? 'not observed'}
                      </small>
                    </td>
                    <td>
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
                    <td>
                      {item.standardApiEquivalentUsdNanos === null
                        ? 'Unavailable'
                        : `$${(item.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(6)}`}
                      <small>{item.costEstimatorStatus.replaceAll('_', ' ')}</small>
                      {item.costEstimatorLimitations.length > 0 ? (
                        <small>{item.costEstimatorLimitations.join(' ')}</small>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ReadStateNote result={scores} subject="Full run score matrix" />
          {scores.state === 'unavailable' ? null : <CalibrationEfficiency scores={scores.data} />}
        </>
      ) : null}
    </section>
  );
}
