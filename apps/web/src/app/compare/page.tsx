import type { Metadata } from 'next';
import Link from 'next/link';

import { CompareExplorer } from '../../components/compare-explorer.tsx';
import { ReadStateNote } from '../../components/read-state-note.tsx';
import { formatHumanDuration, formatTaskDuration } from '../../data/format-duration.ts';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
import { uncachedInputTokens } from '../../data/token-usage.ts';

export const metadata: Metadata = { title: 'Compare' };
export const dynamic = 'force-dynamic';

export default async function ComparePage() {
  const repository = createAiqRepository();
  const result = await readPublicData(
    repository,
    () => repository.listLeaderboard(),
    [],
    (value) => value.length === 0,
    (value) => value.map((entry) => entry.synthetic),
  );
  const currentOfficialRunIds = [
    ...new Set(
      result.data.flatMap((entry) =>
        entry.scoreStatus === 'official' && entry.runId ? [entry.runId] : [],
      ),
    ),
  ];
  const efficiency = await readPublicData(
    repository,
    () => repository.listModelEfficiency(currentOfficialRunIds),
    [],
    (value) => value.length === 0,
    (value) => value.map(() => false),
  );
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Comparison studio</span>
        <h1>One model is not one behavior.</h1>
        <p>
          Compare exact model and reasoning-level pairs. Keep sample size, coverage, failure counts,
          scoring version, and task-set sensitivity beside each fixed-fixture point estimate. The
          public comparison is descriptive because aggregate leaderboard rows do not contain the
          paired-task evidence required for a statistically supported difference.
        </p>
      </div>
      <ReadStateNote result={result} />
      {result.state === 'unavailable' ? null : <CompareExplorer entries={result.data} />}
      {efficiency.state === 'published' ? (
        <div
          className="table-scroll"
          role="region"
          aria-label="Official model efficiency"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Model / effort</th>
                <th>Observed Codex adapter elapsed time</th>
                <th>Estimated Standard API equivalent token cost</th>
                <th>Provider token evidence</th>
              </tr>
            </thead>
            <tbody>
              {efficiency.data.map((row) => (
                <tr key={`${row.runId}-${row.modelFamily}-${row.reasoningEffort}`}>
                  <td title={row.runId}>{row.runId.slice(0, 16)}…</td>
                  <td>
                    {row.modelFamily} · {row.reasoningEffort}
                  </td>
                  <td>
                    {row.observedTotalWallMs === null
                      ? 'Unavailable'
                      : `${formatHumanDuration(row.observedTotalWallMs)} total`}
                    <small>
                      {row.observedMedianWallMs === null
                        ? 'median unavailable'
                        : `${formatTaskDuration(row.observedMedianWallMs)} median`}{' '}
                      ·{' '}
                      {row.observedP95WallMs === null
                        ? 'p95 unavailable'
                        : `${formatTaskDuration(row.observedP95WallMs)} p95`}{' '}
                      · {row.observedTimeSampleCount} observed cells ·{' '}
                      {row.observedTimeCoveragePercent.toFixed(1)}% coverage
                      {row.durationEvidenceLevel === null
                        ? ''
                        : ` · ${row.durationEvidenceLevel.replaceAll('_', '-')}`}
                    </small>
                  </td>
                  <td>
                    {row.standardApiEquivalentUsdNanos === null
                      ? 'Unavailable'
                      : `$${(row.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`}
                    <small>
                      {row.costEstimatorStatus.replaceAll('_', ' ')} · {row.tokenUsageSampleCount}{' '}
                      token-observed cells · {row.pricingCurrency ?? 'currency unavailable'} ·{' '}
                      {row.pricingProcessingTier ?? 'processing tier unavailable'} ·{' '}
                      {row.pricingVersion ?? 'pricing unavailable'}
                    </small>
                  </td>
                  <td>
                    uncached input{' '}
                    {uncachedInputTokens(
                      row.inputTokens,
                      row.cachedInputTokens,
                      row.cacheWriteInputTokens,
                    )?.toLocaleString() ?? 'unavailable'}{' '}
                    · cache read {row.cachedInputTokens?.toLocaleString() ?? 'unavailable'} · cache
                    write {row.cacheWriteInputTokens?.toLocaleString() ?? 'unavailable'} · output{' '}
                    {row.outputTokens?.toLocaleString() ?? 'unavailable'}
                    <small>
                      reasoning {row.reasoningOutputTokens?.toLocaleString() ?? 'unavailable'}{' '}
                      (nested within output) · total{' '}
                      {row.totalTokens?.toLocaleString() ?? 'unavailable'} ·{' '}
                      {row.tokenUsageCoveragePercent.toFixed(1)}% coverage · source{' '}
                      {row.tokenUsageSourceLevel?.replaceAll('_', '-') ?? 'unavailable'} ·
                      aggregation evidence{' '}
                      {row.tokenUsageEvidenceLevel?.replaceAll('_', '-') ?? 'unavailable'}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="formula-note">
        AIQ remains the primary score. Observed adapter elapsed time and estimated Standard API
        equivalent token cost are separate, coverage-qualified dimensions with no combined rank or
        API-frontier claim. Missing cost is unavailable and excluded from any frontier.{' '}
        <Link href="/calibrations">Inspect current efficiency evidence</Link>; unavailable Official
        values are not replaced with zero.
      </p>
    </section>
  );
}
