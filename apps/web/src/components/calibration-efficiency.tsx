'use client';

import { useState } from 'react';
import { ExpandableTableRow, RowDetailContext, TableRowFacts } from './expandable-table-row.tsx';
import { TableNotes } from './table-notes.tsx';
import { TableColumnHeading } from './table-column-heading.tsx';
import type { EChartsCoreOption } from 'echarts/core';
import { alphabetical } from '../display-order.ts';
import { comparisonColor } from '../data/comparison-palette.ts';

import type { PublicCalibrationScore } from '../data/types.ts';
import { formatHumanDuration, formatTaskDuration } from '../data/format-duration.ts';
import { EChartsChart } from './echarts-chart.tsx';
import { paretoEfficientKeys } from './efficiency-analysis.ts';
import { calibrationMetricValue } from './calibration-metric.ts';
import { formatScientificScoreContextHtml } from './scientific-score-context.ts';

type Metric = 'cost' | 'time';
type CalibrationPoint = Readonly<{ score: PublicCalibrationScore; x: number; y: number }>;
export type CalibrationExecutionContext = Readonly<{
  runtimeIssues: number;
  missing: number;
}>;

function calibrationMetricLabel(metric: Metric): string {
  return metric === 'cost'
    ? 'estimated Standard API-equivalent token cost'
    : 'median observed cell adapter elapsed time';
}

function pointKey(score: PublicCalibrationScore): string {
  return `${score.runId}-${score.modelFamily}-${score.reasoningEffort}`;
}

function comparisonGroup(score: PublicCalibrationScore, metric: Metric): string {
  if (metric === 'time') {
    return `${score.runId}|time|${score.durationEvidenceLevel ?? 'duration-evidence-unavailable'}`;
  }
  return [
    score.runId,
    'cost',
    score.costEvidenceLevel ?? 'cost-evidence-unavailable',
    score.tokenUsageSourceLevel ?? 'token-source-unavailable',
    score.tokenUsageEvidenceLevel ?? 'token-evidence-unavailable',
    score.pricingVersion ?? 'pricing-version-unavailable',
    score.pricingAsOf ?? 'pricing-date-unavailable',
    score.pricingSource ?? 'pricing-source-unavailable',
    score.pricingCurrency,
    score.pricingProcessingTier,
  ].join('|');
}

function readCalibrationDatum(value: unknown): readonly (number | string)[] | null {
  if (typeof value !== 'object' || value === null || !('data' in value)) return null;
  const data = value.data;
  return Array.isArray(data) &&
    data.every((item) => typeof item === 'number' || typeof item === 'string')
    ? data
    : null;
}

function calibrationDatum(
  point: CalibrationPoint,
  executionContext: ReadonlyMap<string, CalibrationExecutionContext>,
): readonly (number | string)[] {
  const execution = executionContext.get(
    `${point.score.modelFamily}:${point.score.reasoningEffort}`,
  );
  return [
    point.x,
    point.y,
    `${point.score.modelFamily} · ${point.score.reasoningEffort}`,
    point.score.sampleSize,
    `${point.score.coveragePercent.toFixed(1)}%`,
    point.score.taskResamplingSensitivityLower ?? point.y,
    point.score.taskResamplingSensitivityUpper ?? point.y,
    point.score.synthetic ? 'synthetic' : 'published',
    point.score.descriptiveStatus,
    point.score.attemptedResultCount,
    point.score.invokedResultCount,
    execution?.runtimeIssues ?? 'Unavailable',
    execution?.missing ?? 'Unavailable',
  ];
}

function Scatter({
  scores,
  metric,
  scoringVersion,
  executionContext,
}: {
  scores: readonly PublicCalibrationScore[];
  metric: Metric;
  scoringVersion: string | null;
  executionContext: ReadonlyMap<string, CalibrationExecutionContext>;
}) {
  const points = scores.flatMap((score) => {
    const x = calibrationMetricValue(score, metric);
    return score.qualityScore === null || x === null ? [] : [{ score, x, y: score.qualityScore }];
  });
  const label = `${calibrationMetricLabel(metric)} (${metric === 'cost' ? 'USD' : 'seconds'})`;
  if (points.length === 0)
    return (
      <p className="empty-note">
        No model configuration has both a descriptive quality score and {label}. Missing values are
        not plotted as zero.
      </p>
    );
  const groups = new Map<string, number>();
  for (const point of points) {
    const group = comparisonGroup(point.score, metric);
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const frontier = paretoEfficientKeys(
    points.map((point) => ({
      key: pointKey(point.score),
      comparisonGroup: comparisonGroup(point.score, metric),
      x: point.x,
      y: point.y,
    })),
  );
  const frontierPoints = points.filter(
    (point) =>
      frontier.has(pointKey(point.score)) &&
      (groups.get(comparisonGroup(point.score, metric)) ?? 0) > 1,
  );
  const option: EChartsCoreOption = {
    aria: { enabled: true, decal: { show: true } },
    grid: { left: 62, right: 28, top: 28, bottom: 64 },
    legend: {
      top: 0,
      right: 12,
      selectedMode: false,
      data: ['luna', 'sol', 'terra'],
      textStyle: { color: 'var(--muted)' },
    },
    tooltip: {
      trigger: 'item',
      formatter: (value: unknown) => {
        const data = readCalibrationDatum(value);
        if (!data) return 'Calibration efficiency evidence unavailable';
        const x = Number(data[0]);
        const scientificContext = formatScientificScoreContextHtml({
          sampleSize: Number(data[3]),
          coverage: String(data[4]),
          runtime: `issues ${data[11]}`,
          missing: String(data[12]),
          status: String(data[8]).replaceAll('_', ' '),
          scoringVersion: scoringVersion ?? 'unavailable',
          provenance: String(data[7]),
        });
        return `${data[2]}<br/>Descriptive quality ${Number(data[1]).toFixed(2)} · task-mix sensitivity ${Number(data[5]).toFixed(2)}–${Number(data[6]).toFixed(2)}<br/>${label}: ${x.toFixed(metric === 'cost' ? 4 : 2)}${metric === 'time' ? ' s' : ''}<br/>adapter invocation ${data[10]}/${data[9]} attempted<br/>${scientificContext}`;
      },
    },
    xAxis: {
      type: 'value',
      min: 0,
      name: metric === 'cost' ? 'Estimated API cost (USD)' : 'Median adapter time (s)',
      nameLocation: 'middle',
      nameGap: 42,
      axisLabel: { color: 'var(--muted)' },
      nameTextStyle: { color: 'var(--muted)' },
      axisLine: { lineStyle: { color: 'var(--line-bright)' } },
      splitLine: { lineStyle: { color: 'var(--line)' } },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      name: 'Quality score (0–100)',
      nameLocation: 'middle',
      nameGap: 42,
      axisLabel: { color: 'var(--muted)' },
      nameTextStyle: { color: 'var(--muted)' },
      axisLine: { lineStyle: { color: 'var(--line-bright)' } },
      splitLine: { lineStyle: { color: 'var(--line)' } },
    },
    series: [
      {
        type: 'custom',
        name: 'Task-sensitivity interval',
        silent: true,
        z: 4,
        data: points.map((point) => [
          point.x,
          point.score.taskResamplingSensitivityLower ?? point.y,
          point.score.taskResamplingSensitivityUpper ?? point.y,
        ]),
        renderItem: (
          _params: unknown,
          api: {
            value: (dimension: number) => number;
            coord: (value: readonly number[]) => readonly [number, number];
          },
        ) => {
          const x = api.value(0);
          const low = api.coord([x, api.value(1)]);
          const high = api.coord([x, api.value(2)]);
          return {
            type: 'group',
            children: [
              {
                type: 'line',
                shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] },
                style: { stroke: 'var(--interval)', lineWidth: 1.5 },
              },
              {
                type: 'line',
                shape: { x1: low[0] - 4, y1: low[1], x2: low[0] + 4, y2: low[1] },
                style: { stroke: 'var(--interval)', lineWidth: 1.5 },
              },
              {
                type: 'line',
                shape: { x1: high[0] - 4, y1: high[1], x2: high[0] + 4, y2: high[1] },
                style: { stroke: 'var(--interval)', lineWidth: 1.5 },
              },
            ],
          };
        },
      },
      ...(['luna', 'sol', 'terra'] as const).map((family, index) => ({
        type: 'scatter',
        name: family,
        symbol: ['circle', 'diamond', 'triangle'][index],
        symbolSize: 12,
        itemStyle: {
          color: comparisonColor(family),
          borderColor: 'var(--panel)',
          borderWidth: 1.5,
        },
        data: points
          .filter((point) => point.score.modelFamily === family)
          .map((point) => calibrationDatum(point, executionContext)),
      })),
      {
        type: 'scatter',
        name: 'Descriptive Pareto frontier',
        silent: true,
        z: 5,
        symbolSize: 20,
        itemStyle: {
          color: 'transparent',
          borderColor: 'var(--frontier)',
          borderWidth: 3,
        },
        data: frontierPoints.map((point) => calibrationDatum(point, executionContext)),
      },
    ],
  };
  return (
    <figure className="calibration-plot">
      <EChartsChart
        className="calibration-chart"
        option={option}
        label={`Calibration scatter of descriptive quality against ${label} for ${points.length} configurations, with visible task-mix sensitivity intervals; scoring ${scoringVersion ?? 'unavailable'}.`}
      />
      <figcaption>
        Higher quality, lower resource use. Bars: task-mix sensitivity; rings: descriptive frontier.
      </figcaption>
    </figure>
  );
}

export function CalibrationEfficiency({
  scores,
  scoringVersion,
  executionContext = new Map(),
}: {
  scores: readonly PublicCalibrationScore[];
  scoringVersion: string | null;
  executionContext?: ReadonlyMap<string, CalibrationExecutionContext>;
}) {
  const [metric, setMetric] = useState<Metric>('cost');
  const pricingBindings = [
    ...new Set(
      scores.flatMap((score) =>
        score.pricingSource && score.pricingAsOf && score.pricingVersion
          ? [
              `${score.pricingSource} · ${score.pricingAsOf} · ${score.pricingVersion} · ${score.pricingCurrency} · ${score.pricingProcessingTier} processing tier`,
            ]
          : [],
      ),
    ),
  ];
  return (
    <section className="calibration-efficiency" aria-labelledby="calibration-efficiency-heading">
      <div className="section-heading">
        <span className="eyebrow">Transparent efficiency context</span>
        <h2 id="calibration-efficiency-heading">
          Descriptive quality versus {calibrationMetricLabel(metric)}
        </h2>
      </div>
      <div className="chart-controls calibration-metric-control">
        <span id="calibration-metric-label">Horizontal metric</span>
        <div className="chart-switch" role="group" aria-labelledby="calibration-metric-label">
          <button type="button" aria-pressed={metric === 'cost'} onClick={() => setMetric('cost')}>
            Estimated cost
          </button>
          <button type="button" aria-pressed={metric === 'time'} onClick={() => setMetric('time')}>
            Observed time
          </button>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        Showing descriptive quality against {metric === 'cost' ? 'estimated cost' : 'observed time'}
        .
      </p>
      <div className="plot-grid calibration-plot-grid">
        <Scatter
          scores={scores}
          metric={metric}
          scoringVersion={scoringVersion}
          executionContext={executionContext}
        />
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="Calibration model efficiency"
        tabIndex={0}
      >
        <table className="calibration-efficiency-table compact-table measurement-table">
          <caption>
            Descriptive calibration scores, intervals, coverage, efficiency, scoring, and evidence.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="compact-secondary">
                <TableColumnHeading label="Run" unit="identifier" />
              </th>
              <th scope="col">
                <TableColumnHeading label="Model" unit="effort" />
              </th>
              <th scope="col">
                <TableColumnHeading label="Quality" unit="0–100" />
              </th>
              <th scope="col">
                <TableColumnHeading label="Coverage" unit="tasks / %" />
              </th>
              <th scope="col" className="compact-secondary">
                <TableColumnHeading label="Adapter time" unit="cell sum" />
              </th>
              <th scope="col" className="compact-secondary">
                <TableColumnHeading label="API cost" unit="USD estimate" />
              </th>
              <th scope="col" className="compact-secondary">
                <TableColumnHeading label="Token coverage" unit="tasks / %" />
              </th>
              <th scope="col" className="compact-secondary">
                <TableColumnHeading label="Scoring" unit="version / evidence" />
              </th>
              <th scope="col" className="row-expand-cell">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {alphabetical(scores, (score) => score.modelFamily).map((score) => {
              const measurements = [
                { label: 'Run', value: <code>{score.runId}</code> },
                {
                  label: 'Model / effort',
                  value: (
                    <>
                      {score.modelFamily} · {score.reasoningEffort}
                      {score.synthetic ? <small>Synthetic seed</small> : null}
                    </>
                  ),
                },
                {
                  label: 'Quality score',
                  value: (
                    <>
                      {score.qualityScore === null ? 'Unavailable' : score.qualityScore.toFixed(2)}
                      {score.taskResamplingSensitivityLower !== null &&
                      score.taskResamplingSensitivityUpper !== null ? (
                        <small>
                          {score.taskResamplingSensitivityLower.toFixed(2)}–
                          {score.taskResamplingSensitivityUpper.toFixed(2)} fixed-fixture
                          sensitivity · {score.taskResamplingSensitivityMethod}
                        </small>
                      ) : null}
                    </>
                  ),
                },
                {
                  label: 'Sample / coverage',
                  value: (
                    <>
                      {score.sampleSize} / {score.coveragePercent.toFixed(1)}%
                      <small>
                        Adapter invocation: {score.invokedResultCount}/{score.attemptedResultCount}{' '}
                        attempted · elapsed observed {score.adapterElapsedObservedResultCount}
                      </small>
                      <small>
                        Runtime issues:{' '}
                        {executionContext.get(`${score.modelFamily}:${score.reasoningEffort}`)
                          ?.runtimeIssues ?? 'Unavailable'}{' '}
                        · missing{' '}
                        {executionContext.get(`${score.modelFamily}:${score.reasoningEffort}`)
                          ?.missing ?? 'Unavailable'}
                      </small>
                    </>
                  ),
                },
                {
                  label: 'Observed Codex adapter elapsed time',
                  value: (
                    <>
                      {score.observedTotalWallMs === null
                        ? 'Unavailable'
                        : `${formatHumanDuration(score.observedTotalWallMs)} summed cell time`}
                      <small>
                        {score.observedMedianWallMs === null
                          ? 'median unavailable'
                          : `${formatTaskDuration(score.observedMedianWallMs)} median`}{' '}
                        ·{' '}
                        {score.observedP95WallMs === null
                          ? 'p95 unavailable'
                          : `${formatTaskDuration(score.observedP95WallMs)} p95`}{' '}
                        · {score.observedTimeSampleCount} samples ·{' '}
                        {score.observedTimeCoveragePercent.toFixed(1)}% coverage
                        {score.durationEvidenceLevel === null
                          ? ''
                          : ` · ${score.durationEvidenceLevel.replaceAll('_', '-')}`}
                      </small>
                    </>
                  ),
                },
                {
                  label: 'Estimated Standard API equivalent token cost',
                  value: (
                    <>
                      {score.standardApiEquivalentUsdNanos === null
                        ? 'Unavailable'
                        : `$${(score.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`}
                      <small>{score.costEstimatorStatus.replaceAll('_', ' ')}</small>
                      <small>
                        {score.pricedResultCount} priced / {score.resultCount} selected result cells
                        · {score.pricingCurrency} · {score.pricingProcessingTier} processing tier
                      </small>
                      {score.costEstimatorLimitations.length > 0 ? (
                        <small>{score.costEstimatorLimitations.join(' ')}</small>
                      ) : null}
                    </>
                  ),
                },
                {
                  label: 'Token usage coverage',
                  value: (
                    <>
                      {score.tokenUsageCoveragePercent === null
                        ? 'Unavailable'
                        : `${score.tokenObservedResultCount} / ${score.tokenUsageCoveragePercent.toFixed(1)}%`}
                      <small>{score.tokenObservedResultCount} token-observed result cells</small>
                      <small>
                        source {score.tokenUsageSourceLevel?.replaceAll('_', '-') ?? 'unavailable'}{' '}
                        · aggregation evidence{' '}
                        {score.tokenUsageEvidenceLevel?.replaceAll('_', '-') ?? 'unavailable'}
                      </small>
                    </>
                  ),
                },
                {
                  label: 'Scoring / evidence',
                  value: (
                    <>
                      {scoringVersion ?? 'Scoring unavailable'}
                      <small>{score.descriptiveStatus.replaceAll('_', ' ')}</small>
                      <small>{score.synthetic ? 'Synthetic seed' : 'Published calibration'}</small>
                      <small>Untrusted · not Official · not ranking eligible</small>
                    </>
                  ),
                },
              ] as const;
              return (
                <ExpandableTableRow
                  label={`${score.modelFamily} ${score.reasoningEffort}`}
                  visibleColumns={3}
                  details={
                    <>
                      <TableRowFacts
                        items={[
                          {
                            label: 'Quality',
                            unit: '0–100',
                            value: score.qualityScore?.toFixed(2) ?? 'Unavailable',
                          },
                          {
                            label: 'Coverage',
                            unit: 'tasks / %',
                            value: `${score.sampleSize} / ${score.coveragePercent.toFixed(1)}%`,
                          },
                          {
                            label: 'Adapter time',
                            unit: 'cell sum',
                            value:
                              score.observedTotalWallMs === null
                                ? 'Unavailable'
                                : formatHumanDuration(score.observedTotalWallMs),
                          },
                          {
                            label: 'API cost',
                            unit: 'USD estimate',
                            value:
                              score.standardApiEquivalentUsdNanos === null
                                ? 'Unavailable'
                                : `$${(score.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`,
                          },
                          {
                            label: 'Token coverage',
                            unit: 'tasks / %',
                            value:
                              score.tokenUsageCoveragePercent === null
                                ? 'Unavailable'
                                : `${score.tokenObservedResultCount} / ${score.tokenUsageCoveragePercent.toFixed(1)}%`,
                          },
                          {
                            label: 'Sensitivity interval',
                            unit: 'fixed fixture · 0–100',
                            value:
                              score.taskResamplingSensitivityLower !== null &&
                              score.taskResamplingSensitivityUpper !== null
                                ? `${score.taskResamplingSensitivityLower.toFixed(2)}–${score.taskResamplingSensitivityUpper.toFixed(2)}`
                                : 'Unavailable',
                          },
                          {
                            label: 'Median time',
                            unit: 'per task',
                            value:
                              score.observedMedianWallMs === null
                                ? 'Unavailable'
                                : formatTaskDuration(score.observedMedianWallMs),
                          },
                          {
                            label: 'P95 time',
                            unit: 'per task',
                            value:
                              score.observedP95WallMs === null
                                ? 'Unavailable'
                                : formatTaskDuration(score.observedP95WallMs),
                          },
                        ]}
                      />
                      <p className="row-detail-status">
                        Untrusted · not Official · not ranking eligible
                      </p>
                      <RowDetailContext>
                        <TableRowFacts
                          layout="rows"
                          items={[
                            { label: 'Run', unit: 'identifier', value: <code>{score.runId}</code> },
                            {
                              label: 'Model',
                              unit: 'effort',
                              value: `${score.modelFamily} · ${score.reasoningEffort}`,
                            },
                            {
                              label: 'Scoring',
                              unit: 'version',
                              value: scoringVersion ?? 'Unavailable',
                            },
                            {
                              label: 'Evidence',
                              value: score.synthetic ? 'Synthetic seed' : 'Published calibration',
                            },
                            {
                              label: 'Score status',
                              value: score.descriptiveStatus.replaceAll('_', ' '),
                            },
                            {
                              label: 'Sensitivity method',
                              value: score.taskResamplingSensitivityMethod ?? 'Unavailable',
                            },
                            {
                              label: 'Adapter invocation',
                              unit: 'invoked / attempted',
                              value: `${score.invokedResultCount}/${score.attemptedResultCount}`,
                            },
                            {
                              label: 'Runtime issues',
                              unit: 'tasks',
                              value:
                                executionContext.get(
                                  `${score.modelFamily}:${score.reasoningEffort}`,
                                )?.runtimeIssues ?? 'Unavailable',
                            },
                            {
                              label: 'Missing',
                              unit: 'tasks',
                              value:
                                executionContext.get(
                                  `${score.modelFamily}:${score.reasoningEffort}`,
                                )?.missing ?? 'Unavailable',
                            },
                            {
                              label: 'Time coverage',
                              unit: 'samples / %',
                              value: `${score.observedTimeSampleCount} / ${score.observedTimeCoveragePercent.toFixed(1)}%`,
                            },
                            {
                              label: 'Time evidence',
                              value:
                                score.durationEvidenceLevel?.replaceAll('_', ' ') ?? 'Unavailable',
                            },
                            {
                              label: 'Token source',
                              value:
                                score.tokenUsageSourceLevel?.replaceAll('_', ' ') ?? 'Unavailable',
                            },
                            {
                              label: 'Token aggregation',
                              value:
                                score.tokenUsageEvidenceLevel?.replaceAll('_', ' ') ??
                                'Unavailable',
                            },
                            {
                              label: 'Priced tasks',
                              unit: 'priced / selected',
                              value: `${score.pricedResultCount}/${score.resultCount}`,
                            },
                            {
                              label: 'Cost status',
                              value: score.costEstimatorStatus.replaceAll('_', ' '),
                            },
                            {
                              label: 'Pricing tier',
                              value: `${score.pricingCurrency} · ${score.pricingProcessingTier}`,
                            },
                            {
                              label: 'Cost limits',
                              value: score.costEstimatorLimitations.join(' ') || 'None recorded',
                            },
                          ]}
                        />
                      </RowDetailContext>
                    </>
                  }
                  key={`${score.runId}-${score.modelFamily}-${score.reasoningEffort}`}
                >
                  <td className="compact-secondary">{measurements[0].value}</td>
                  <th scope="row">{measurements[1].value}</th>
                  <td className="compact-value">{measurements[2].value}</td>
                  <td className="compact-value">{measurements[3].value}</td>
                  <td className="compact-secondary">{measurements[4].value}</td>
                  <td className="compact-secondary">{measurements[5].value}</td>
                  <td className="compact-secondary">{measurements[6].value}</td>
                  <td className="compact-secondary">{measurements[7].value}</td>
                </ExpandableTableRow>
              );
            })}
          </tbody>
        </table>
      </div>
      <TableNotes label="Calibration efficiency" hint="Descriptive only · estimated API cost.">
        <p>
          Evidence levels differ by metric. The verifier replays score evidence; wall Codex adapter
          elapsed time is runner-observed. Token counters are provider-reported, while their
          aggregation and the cost estimate are verifier-recomputed. Standard API equivalent is
          estimated, not actual subscription billing or necessarily an exact API invoice. Unknown or
          insufficient inputs display as unavailable, never as zero.
        </p>
        <p>
          Pricing binding:{' '}
          {pricingBindings.length === 0 ? 'Unavailable' : pricingBindings.join('; ')} ·{' '}
          <a href="https://developers.openai.com/api/docs/pricing">official source</a> · scoring{' '}
          {scoringVersion ?? 'Unavailable'}
        </p>
        <p>
          Vertical bars show fixed-fixture task-resampling sensitivity intervals. They are not
          calibrated ability intervals. Rings mark a descriptive frontier only inside one
          calibration run, which fixes the fixture, scoring, runtime, and concurrency. Cost also
          requires identical pricing and evidence bindings. Incomplete usage is excluded. This is
          not a combined ranking or an API-frontier claim.
        </p>
        <p>
          No score/$ or score/hour aggregate is used. If derived externally: score/$ = descriptive
          quality ÷ estimated API-equivalent USD; score/hour = descriptive quality ÷ observed hours.
          The denominator and token coverage must accompany the value. Runtime-issue attempts remain
          in observed usage totals; missing or non-invoked cells do not. Adapter elapsed time
          measures model and allowed-tool invocation only. It excludes workspace setup, artifact
          sealing, and evaluator replay. Concurrent model order and local contention affect the
          observed resource profile. Missing usage makes cost unavailable and excludes it from the
          frontier; it is not displayed as zero.
        </p>
      </TableNotes>
    </section>
  );
}
