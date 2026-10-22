import { formatHumanDuration, formatTaskDuration } from '../data/format-duration.ts';
import { ExpandableTableRow, RowDetailContext, TableRowFacts } from './expandable-table-row.tsx';
import { TableNotes } from './table-notes.tsx';
import { TableColumnHeading } from './table-column-heading.tsx';
import { alphabetical } from '../display-order.ts';
import type { TokenCategoryCoverage } from '../data/types.ts';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';

function formatCoverage(coverage: TokenCategoryCoverage, resultCount: number): string {
  return coverage.count === null || coverage.percent === null
    ? 'unavailable'
    : `${coverage.count}/${resultCount} (${coverage.percent.toFixed(1)}%)`;
}

export function OfficialEfficiencyTable({
  rows,
  expectedCount = rows.length,
  unavailableCount = 0,
  rejectedCount = 0,
}: {
  rows: readonly ExactEfficiencyRow[];
  expectedCount?: number;
  unavailableCount?: number;
  rejectedCount?: number;
}) {
  const unavailableNotice =
    unavailableCount > 0 || rejectedCount > 0 ? (
      <p className="empty-note" role="status" aria-label="Unavailable Official efficiency evidence">
        {unavailableCount > 0
          ? `${unavailableCount} of ${expectedCount} expected Official efficiency ${expectedCount === 1 ? 'row is' : 'rows are'} Unavailable. `
          : ''}
        {rejectedCount > 0
          ? `${rejectedCount} returned ${rejectedCount === 1 ? 'row was' : 'rows were'} rejected. `
          : ''}
        Exact run, configuration, scoring-version, and provenance identity are required.
      </p>
    ) : null;
  if (rows.length === 0) {
    return (
      <div>
        <p className="empty-note">Official efficiency is unavailable.</p>
        {unavailableNotice}
      </div>
    );
  }
  const batches = new Map<string, number>();
  for (const { row } of rows) batches.set(row.matrixBatchId, row.matrixBatchElapsedMs);
  return (
    <div role="region" aria-label="Official model efficiency">
      {unavailableNotice}
      <div className="table-scroll" tabIndex={0}>
        <table className="official-efficiency-table compact-table measurement-table">
          <thead>
            <tr>
              <th scope="col">
                <TableColumnHeading label="Model" unit="effort" />
              </th>
              <th scope="col" aria-label="Summed cell adapter elapsed">
                <TableColumnHeading label="Adapter time" unit="cell sum" />
              </th>
              <th scope="col" aria-label="Estimated Standard API-equivalent cost">
                <TableColumnHeading label="API cost" unit="USD estimate" />
              </th>
              <th scope="col" className="compact-secondary">
                <TableColumnHeading label="Provider tokens" unit="totals / coverage" />
              </th>
              <th scope="col" className="compact-secondary">
                <TableColumnHeading label="Trust" unit="source / signer" />
              </th>
              <th className="row-expand-cell">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {alphabetical(rows, ({ entry }) => entry.modelFamily).map(({ entry, row }) => {
              const measurements = [
                {
                  label: 'Summed cell adapter elapsed',
                  value: (
                    <>
                      {' '}
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
                        Retained cell durations can overlap at concurrency{' '}
                        {row.executionConcurrency}; this sum is not the signed matrix batch
                        wall-clock in the notes.
                      </small>{' '}
                    </>
                  ),
                },
                {
                  label: 'Estimated Standard API-equivalent cost',
                  value: (
                    <>
                      {' '}
                      {row.standardApiEquivalentUsdNanos === null
                        ? 'Unavailable'
                        : `$${(row.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`}
                      <small>
                        {row.pricedResultCount}/{row.resultCount} priced ·{' '}
                        {row.costEstimatorStatus.replaceAll('_', ' ')}
                      </small>{' '}
                    </>
                  ),
                },
                {
                  label: 'Provider token totals and coverage',
                  value: (
                    <>
                      {' '}
                      input {row.inputTokens?.toLocaleString() ?? 'unavailable'} (
                      {formatCoverage(row.tokenCoverage.input, row.resultCount)}) · cached input{' '}
                      {row.cachedInputTokens?.toLocaleString() ?? 'unavailable'} (
                      {formatCoverage(row.tokenCoverage.cachedInput, row.resultCount)}) ·
                      cache-write input{' '}
                      {row.cacheWriteInputTokens?.toLocaleString() ?? 'unavailable'} (
                      {formatCoverage(row.tokenCoverage.cacheWriteInput, row.resultCount)}) · output{' '}
                      {row.outputTokens?.toLocaleString() ?? 'unavailable'} (
                      {formatCoverage(row.tokenCoverage.output, row.resultCount)})
                      <small>
                        reasoning {row.reasoningOutputTokens?.toLocaleString() ?? 'unavailable'} (
                        {formatCoverage(row.tokenCoverage.reasoning, row.resultCount)}) · total{' '}
                        {row.totalTokens?.toLocaleString() ?? 'unavailable'} (
                        {formatCoverage(row.tokenCoverage.total, row.resultCount)}). Reasoning is a
                        subset of output and is not charged twice.
                      </small>{' '}
                    </>
                  ),
                },
                {
                  label: 'Trust metadata',
                  value: (
                    <>
                      {' '}
                      {row.resultCount} results · {row.attemptedResultCount} attempted ·{' '}
                      {row.invokedResultCount} adapter-invoked · concurrency{' '}
                      {row.executionConcurrency}
                      <small>
                        Scoring {entry.scoringVersion} ·{' '}
                        {entry.synthetic ? 'synthetic seed' : 'published evidence'}
                      </small>
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
                      </details>{' '}
                    </>
                  ),
                },
              ] as const;
              return (
                <ExpandableTableRow
                  label={`${entry.modelFamily} ${entry.reasoningTier}`}
                  visibleColumns={3}
                  details={
                    <>
                      <TableRowFacts
                        items={[
                          {
                            label: 'Adapter time',
                            unit: 'cell sum',
                            value:
                              row.summedCellAdapterElapsedMs === null
                                ? 'Unavailable'
                                : formatHumanDuration(row.summedCellAdapterElapsedMs),
                          },
                          {
                            label: 'API cost',
                            unit: 'USD estimate',
                            value:
                              row.standardApiEquivalentUsdNanos === null
                                ? 'Unavailable'
                                : `$${(row.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`,
                          },
                          {
                            label: 'Provider tokens',
                            unit: 'total reported',
                            value: row.totalTokens?.toLocaleString() ?? 'Unavailable',
                          },
                          {
                            label: 'Median time',
                            unit: 'per task',
                            value:
                              row.observedMedianWallMs === null
                                ? 'Unavailable'
                                : formatTaskDuration(row.observedMedianWallMs),
                          },
                          {
                            label: 'P95 time',
                            unit: 'per task',
                            value:
                              row.observedP95WallMs === null
                                ? 'Unavailable'
                                : formatTaskDuration(row.observedP95WallMs),
                          },
                          {
                            label: 'Token coverage',
                            unit: 'any usage / cells',
                            value: `${row.tokenObservedResultCount}/${row.resultCount}`,
                          },
                        ]}
                      />
                      <RowDetailContext>
                        <TableRowFacts
                          layout="rows"
                          items={[
                            { label: 'Run ID', value: <code>{row.runId}</code> },
                            { label: 'Scoring', unit: 'version', value: entry.scoringVersion },
                            {
                              label: 'Evidence',
                              value: entry.synthetic ? 'Synthetic seed' : 'Published evidence',
                            },
                            { label: 'Results', unit: 'retained cells', value: row.resultCount },
                            {
                              label: 'Adapter invocation',
                              unit: 'invoked / attempted',
                              value: `${row.invokedResultCount}/${row.attemptedResultCount}`,
                            },
                            {
                              label: 'Concurrency',
                              unit: 'workers',
                              value: row.executionConcurrency,
                            },
                            {
                              label: 'Time coverage',
                              unit: 'observed / cells',
                              value: `${row.adapterElapsedObservedResultCount}/${row.resultCount}`,
                            },
                            {
                              label: 'Time evidence',
                              value:
                                row.durationEvidenceLevel?.replaceAll('_', ' ') ?? 'Unavailable',
                            },
                            {
                              label: 'Token aggregation',
                              value:
                                row.tokenUsageEvidenceLevel?.replaceAll('_', ' ') ?? 'Unavailable',
                            },
                            {
                              label: 'Priced tasks',
                              unit: 'priced / cells',
                              value: `${row.pricedResultCount}/${row.resultCount}`,
                            },
                            {
                              label: 'Cost status',
                              value: row.costEstimatorStatus.replaceAll('_', ' '),
                            },
                            {
                              label: 'Pricing',
                              unit: 'version',
                              value: row.pricingVersion ?? 'Unavailable',
                            },
                            { label: 'Pricing date', value: row.pricingAsOf ?? 'Unavailable' },
                            {
                              label: 'Pricing source',
                              value: row.pricingSource ? (
                                <a href={row.pricingSource}>Source ↗</a>
                              ) : (
                                'Unavailable'
                              ),
                            },
                          ]}
                        />
                        <TableRowFacts
                          items={[
                            {
                              label: 'Input tokens',
                              value: row.inputTokens,
                              coverage: row.tokenCoverage.input,
                            },
                            {
                              label: 'Cache-read tokens',
                              value: row.cachedInputTokens,
                              coverage: row.tokenCoverage.cachedInput,
                            },
                            {
                              label: 'Cache-write tokens',
                              value: row.cacheWriteInputTokens,
                              coverage: row.tokenCoverage.cacheWriteInput,
                            },
                            {
                              label: 'Output tokens',
                              value: row.outputTokens,
                              coverage: row.tokenCoverage.output,
                            },
                            {
                              label: 'Reasoning tokens',
                              value: row.reasoningOutputTokens,
                              coverage: row.tokenCoverage.reasoning,
                            },
                            {
                              label: 'Total tokens',
                              value: row.totalTokens,
                              coverage: row.tokenCoverage.total,
                            },
                          ].map(({ label, value, coverage }) => ({
                            label,
                            unit: `reported · ${formatCoverage(coverage, row.resultCount)}`,
                            value: value?.toLocaleString() ?? 'Unavailable',
                          }))}
                        />
                        <p>
                          Reasoning is part of output; it is not charged twice. Task durations can
                          overlap at concurrency {row.executionConcurrency}; their sum is not the
                          matrix batch wall-clock.
                        </p>
                        <details className="row-detail-context">
                          <summary>Cost formula & limits</summary>
                          <div>
                            <TableRowFacts
                              layout="rows"
                              items={[
                                { label: 'Formula', value: row.costFormula ?? 'Unavailable' },
                                ...row.pricingRates.map((rate) => ({
                                  label: rate.model,
                                  unit: 'USD nanos/token',
                                  value: `Input ${rate.input_usd_nanos_per_token ?? 'Unavailable'} · cache read ${rate.cached_input_usd_nanos_per_token ?? 'Unavailable'} · cache write ${rate.cache_write_input_usd_nanos_per_token ?? 'Unavailable'} · output ${rate.output_usd_nanos_per_token ?? 'Unavailable'}`,
                                })),
                                ...row.costEstimatorLimitations.map((limitation, index) => ({
                                  label: `Limit ${index + 1}`,
                                  value: limitation,
                                })),
                              ]}
                            />
                          </div>
                        </details>
                      </RowDetailContext>
                    </>
                  }
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
                    {entry.modelFamily} · {entry.reasoningTier}
                    <small>{row.runId.slice(0, 18)}…</small>
                  </th>
                  <td className="compact-value">{measurements[0].value}</td>
                  <td className="compact-value">{measurements[1].value}</td>
                  <td className="compact-secondary">{measurements[2].value}</td>
                  <td className="compact-secondary">{measurements[3].value}</td>
                </ExpandableTableRow>
              );
            })}
          </tbody>
        </table>
      </div>
      <TableNotes label="Official efficiency" hint="API cost estimate · not subscription billing.">
        <h3>Signed matrix batch wall-clock</h3>
        {[...batches].map(([batchId, elapsedMs]) => (
          <p key={batchId} title={batchId}>
            {formatHumanDuration(elapsedMs)} · {batchId.slice(0, 18)}… · count once across all 17
            configurations in this matrix batch.
          </p>
        ))}
        <p>TTFT and TPS are unavailable and are not inferred.</p>
        <p>
          Dollar values are estimates from provider-reported tokens and the published Standard API
          pricing binding in each row. They are not billed Codex or ChatGPT subscription cost.
        </p>
      </TableNotes>
    </div>
  );
}
