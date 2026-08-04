import { formatHumanDuration, formatTaskDuration } from '../data/format-duration.ts';
import type { PublicModelEfficiency, TokenCategoryCoverage } from '../data/types.ts';

function formatCoverage(coverage: TokenCategoryCoverage, resultCount: number): string {
  return coverage.count === null || coverage.percent === null
    ? 'unavailable'
    : `${coverage.count}/${resultCount} (${coverage.percent.toFixed(1)}%)`;
}

export function OfficialEfficiencyTable({ rows }: { rows: readonly PublicModelEfficiency[] }) {
  if (rows.length === 0) return <p className="empty-note">Official efficiency is unavailable.</p>;
  const batches = new Map<string, number>();
  for (const row of rows) batches.set(row.matrixBatchId, row.matrixBatchElapsedMs);
  return (
    <div role="region" aria-label="Official model efficiency">
      <div className="formula-note">
        <strong>Signed matrix batch wall-clock</strong>
        {[...batches].map(([batchId, elapsedMs]) => (
          <p key={batchId} title={batchId}>
            {formatHumanDuration(elapsedMs)} · {batchId.slice(0, 18)}… · count once across all 17
            configurations in this matrix batch.
          </p>
        ))}
        <p>TTFT and TPS are unavailable and are not inferred.</p>
        <p>
          Dollar values are estimates from provider-reported tokens and the published Standard API
          pricing binding shown below. They are not billed Codex or ChatGPT subscription cost.
        </p>
      </div>
      <div className="table-scroll" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Run / configuration</th>
              <th>Summed cell adapter elapsed</th>
              <th>Estimated Standard API-equivalent cost</th>
              <th>Provider token totals and coverage</th>
              <th>Trust metadata</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.runId}-${row.modelFamily}-${row.reasoningEffort}`}
                data-run-id={row.runId}
                data-matrix-batch-id={row.matrixBatchId}
                data-duration-evidence-level={row.durationEvidenceLevel ?? 'unavailable'}
                data-token-usage-evidence-level={row.tokenUsageEvidenceLevel ?? 'unavailable'}
                data-cost-estimator-status={row.costEstimatorStatus}
                data-cost-evidence-level={row.costEvidenceLevel ?? 'unavailable'}
                data-attempted-result-count={row.attemptedResultCount}
                data-invoked-result-count={row.invokedResultCount}
                data-elapsed-observed-result-count={row.adapterElapsedObservedResultCount}
                data-token-observed-result-count={row.tokenObservedResultCount}
                data-priced-result-count={row.pricedResultCount}
              >
                <th scope="row" title={row.runId}>
                  {row.modelFamily} · {row.reasoningEffort}
                  <small>{row.runId.slice(0, 18)}…</small>
                </th>
                <td>
                  {row.summedCellAdapterElapsedMs === null
                    ? 'Unavailable'
                    : `${formatHumanDuration(row.summedCellAdapterElapsedMs)} summed`}
                  <small>
                    {row.observedMedianWallMs === null
                      ? 'median unavailable'
                      : `${formatTaskDuration(row.observedMedianWallMs)} median`}{' '}
                    ·{' '}
                    {row.observedP95WallMs === null
                      ? 'p95 unavailable'
                      : `${formatTaskDuration(row.observedP95WallMs)} p95`}{' '}
                    · {row.adapterElapsedObservedResultCount}/{row.resultCount} retained ·{' '}
                    {row.durationEvidenceLevel?.replaceAll('_', '-') ?? 'evidence unavailable'}
                  </small>
                  <small>
                    Retained cell durations can overlap at concurrency {row.executionConcurrency};
                    this sum is not the signed matrix batch wall-clock shown above.
                  </small>
                </td>
                <td>
                  {row.standardApiEquivalentUsdNanos === null
                    ? 'Unavailable'
                    : `$${(row.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`}
                  <small>
                    {row.pricedResultCount}/{row.resultCount} priced ·{' '}
                    {row.costEstimatorStatus.replaceAll('_', ' ')}
                  </small>
                </td>
                <td>
                  input {row.inputTokens?.toLocaleString() ?? 'unavailable'} (
                  {formatCoverage(row.tokenCoverage.input, row.resultCount)}) · cached input{' '}
                  {row.cachedInputTokens?.toLocaleString() ?? 'unavailable'} (
                  {formatCoverage(row.tokenCoverage.cachedInput, row.resultCount)}) · cache-write
                  input {row.cacheWriteInputTokens?.toLocaleString() ?? 'unavailable'} (
                  {formatCoverage(row.tokenCoverage.cacheWriteInput, row.resultCount)}) · output{' '}
                  {row.outputTokens?.toLocaleString() ?? 'unavailable'} (
                  {formatCoverage(row.tokenCoverage.output, row.resultCount)})
                  <small>
                    reasoning {row.reasoningOutputTokens?.toLocaleString() ?? 'unavailable'} (
                    {formatCoverage(row.tokenCoverage.reasoning, row.resultCount)}) · total{' '}
                    {row.totalTokens?.toLocaleString() ?? 'unavailable'} (
                    {formatCoverage(row.tokenCoverage.total, row.resultCount)}). Reasoning is a
                    subset of output and is not charged twice.
                  </small>
                </td>
                <td>
                  {row.resultCount} results · {row.attemptedResultCount} attempted ·{' '}
                  {row.invokedResultCount} adapter-invoked · concurrency {row.executionConcurrency}
                  <small>
                    Pricing: {row.pricingVersion ?? 'unavailable'} ·{' '}
                    {row.pricingAsOf ?? 'date unavailable'} ·{' '}
                    {row.pricingSource ? (
                      <a href={row.pricingSource}>source</a>
                    ) : (
                      'source unavailable'
                    )}
                  </small>
                  <details>
                    <summary>Formula, rates, and limitations</summary>
                    <p>{row.costFormula ?? 'Formula unavailable.'}</p>
                    <ul>
                      {row.pricingRates.map((rate) => (
                        <li key={rate.model}>
                          {rate.model}: input {rate.input_usd_nanos_per_token}, cached input{' '}
                          {rate.cached_input_usd_nanos_per_token}, cache-write input{' '}
                          {rate.cache_write_input_usd_nanos_per_token}, output{' '}
                          {rate.output_usd_nanos_per_token} USD nanos/token
                        </li>
                      ))}
                      {row.costEstimatorLimitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
