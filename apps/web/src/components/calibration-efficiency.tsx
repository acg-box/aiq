'use client';

import type { EChartsCoreOption } from 'echarts/core';

import type { PublicCalibrationScore } from '../data/types.ts';
import { formatHumanDuration, formatTaskDuration } from '../data/format-duration.ts';
import { EChartsChart } from './echarts-chart.tsx';
import { paretoEfficientKeys } from './efficiency-analysis.ts';
import { formatScientificScoreContextHtml } from './scientific-score-context.ts';

type Metric = 'cost' | 'time';
type CalibrationPoint = Readonly<{ score: PublicCalibrationScore; x: number; y: number }>;

function valueFor(score: PublicCalibrationScore, metric: Metric): number | null {
  if (metric === 'cost') {
    return score.costEstimatorStatus === 'estimated' && score.tokenUsageCoveragePercent === 100
      ? score.standardApiEquivalentUsdNanos === null
        ? null
        : score.standardApiEquivalentUsdNanos / 1_000_000_000
      : null;
  }
  return score.observedTimeCoveragePercent === 100 ? score.observedMedianWallMs : null;
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

function calibrationFamilyColor(family: PublicCalibrationScore['modelFamily']): string {
  if (family === 'sol') return 'var(--data-lime)';
  if (family === 'terra') return 'var(--data-cyan)';
  return 'var(--data-violet)';
}

function readCalibrationDatum(value: unknown): readonly (number | string)[] | null {
  if (typeof value !== 'object' || value === null || !('data' in value)) return null;
  const data = value.data;
  return Array.isArray(data) &&
    data.every((item) => typeof item === 'number' || typeof item === 'string')
    ? data
    : null;
}

function calibrationDatum(point: CalibrationPoint): readonly (number | string)[] {
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
  ];
}

function Scatter({
  scores,
  metric,
  scoringVersion,
}: {
  scores: readonly PublicCalibrationScore[];
  metric: Metric;
  scoringVersion: string | null;
}) {
  const points = scores.flatMap((score) => {
    const x = valueFor(score, metric);
    return score.aiq === null || x === null ? [] : [{ score, x, y: score.aiq }];
  });
  const label =
    metric === 'cost'
      ? 'estimated Standard API equivalent token cost (USD)'
      : 'observed Codex adapter elapsed time (median)';
  if (points.length === 0)
    return (
      <p className="empty-note">
        No model configuration has both descriptive AIQ and {label}. Missing values are not plotted
        as zero.
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
      data: ['sol', 'terra', 'luna'],
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
          runtime: `adapter invoked ${data[10]}/${data[9]} attempted`,
          missing: 'unavailable in aggregate',
          status: String(data[8]).replaceAll('_', ' '),
          scoringVersion: scoringVersion ?? 'unavailable',
          provenance: String(data[7]),
        });
        return `${data[2]}<br/>Descriptive AIQ ${Number(data[1]).toFixed(2)} · interval ${Number(data[5]).toFixed(2)}–${Number(data[6]).toFixed(2)}<br/>${label}: ${x.toFixed(metric === 'cost' ? 4 : 0)}<br/>${scientificContext}`;
      },
    },
    xAxis: {
      type: 'value',
      min: 0,
      name: label,
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
      name: 'AIQ index (0–100)',
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
      ...(['sol', 'terra', 'luna'] as const).map((family, index) => ({
        type: 'scatter',
        name: family,
        symbol: ['circle', 'diamond', 'triangle'][index],
        symbolSize: 12,
        itemStyle: {
          color: calibrationFamilyColor(family),
          borderColor: 'var(--panel)',
          borderWidth: 1.5,
        },
        data: points.filter((point) => point.score.modelFamily === family).map(calibrationDatum),
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
        data: frontierPoints.map(calibrationDatum),
      },
    ],
  };
  return (
    <figure className="calibration-plot">
      <EChartsChart
        className="calibration-chart"
        option={option}
        label={`Calibration scatter of descriptive AIQ against ${label} for ${points.length} configurations, with visible fixed-fixture task-sensitivity intervals; scoring ${scoringVersion ?? 'unavailable'}.`}
      />
      <figcaption>
        Higher descriptive AIQ and a smaller horizontal value are preferable. Vertical bars show
        fixed-fixture task-resampling sensitivity intervals. They are not universal model-capability
        intervals. Rings mark a descriptive frontier only inside one calibration run, which fixes
        the fixture, scoring, runtime, and concurrency. Cost also requires identical pricing and
        evidence bindings. Incomplete usage is excluded. This is not a combined ranking or an
        API-frontier claim.
      </figcaption>
    </figure>
  );
}

export function CalibrationEfficiency({
  scores,
  scoringVersion,
}: {
  scores: readonly PublicCalibrationScore[];
  scoringVersion: string | null;
}) {
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
          Observed Codex adapter elapsed time vs estimated Standard API equivalent token cost
        </h2>
      </div>
      <p className="calibration-warning">
        <strong>Evidence levels differ by metric.</strong> The verifier replays score evidence; wall
        Codex adapter elapsed time is runner-observed. Token counters are provider-reported, while
        their aggregation and the cost estimate are verifier-recomputed. Standard API equivalent is
        estimated, not actual subscription billing or necessarily an exact API invoice. Unknown or
        insufficient inputs display as unavailable, never as zero.
      </p>
      <p>
        Pricing binding: {pricingBindings.length === 0 ? 'Unavailable' : pricingBindings.join('; ')}{' '}
        · <a href="https://developers.openai.com/api/docs/pricing">official source</a> · scoring{' '}
        {scoringVersion ?? 'Unavailable'}
      </p>
      <div className="plot-grid">
        <Scatter scores={scores} metric="cost" scoringVersion={scoringVersion} />
        <Scatter scores={scores} metric="time" scoringVersion={scoringVersion} />
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="Calibration model efficiency"
        tabIndex={0}
      >
        <table>
          <caption>
            Descriptive calibration scores, intervals, coverage, efficiency, scoring, and evidence.
          </caption>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Model / effort</th>
              <th scope="col">AIQ</th>
              <th scope="col">Sample / coverage</th>
              <th scope="col">Observed Codex adapter elapsed time</th>
              <th scope="col">Estimated Standard API equivalent token cost</th>
              <th scope="col">Token usage coverage</th>
              <th scope="col">Scoring / evidence</th>
            </tr>
          </thead>
          <tbody>
            {scores.map((score) => (
              <tr key={`${score.runId}-${score.modelFamily}-${score.reasoningEffort}`}>
                <td title={score.runId}>{score.runId.slice(0, 16)}…</td>
                <td>
                  {score.modelFamily} · {score.reasoningEffort}
                  {score.synthetic ? <small>Synthetic seed</small> : null}
                </td>
                <td>
                  {score.aiq === null ? 'Unavailable' : score.aiq.toFixed(2)}
                  {score.taskResamplingSensitivityLower !== null &&
                  score.taskResamplingSensitivityUpper !== null ? (
                    <small>
                      {score.taskResamplingSensitivityLower.toFixed(2)}–
                      {score.taskResamplingSensitivityUpper.toFixed(2)} fixed-fixture sensitivity ·{' '}
                      {score.taskResamplingSensitivityMethod}
                    </small>
                  ) : null}
                </td>
                <td>
                  {score.sampleSize} / {score.coveragePercent.toFixed(1)}%
                  <small>
                    {score.attemptedResultCount} attempted · {score.invokedResultCount}{' '}
                    adapter-invoked · {score.adapterElapsedObservedResultCount} elapsed-observed
                  </small>
                </td>
                <td>
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
                </td>
                <td>
                  {score.standardApiEquivalentUsdNanos === null
                    ? 'Unavailable'
                    : `$${(score.standardApiEquivalentUsdNanos / 1_000_000_000).toFixed(4)}`}
                  <small>{score.costEstimatorStatus.replaceAll('_', ' ')}</small>
                  <small>
                    {score.pricedResultCount} priced / {score.resultCount} selected result cells ·{' '}
                    {score.pricingCurrency} · {score.pricingProcessingTier} processing tier
                  </small>
                  {score.costEstimatorLimitations.length > 0 ? (
                    <small>{score.costEstimatorLimitations.join(' ')}</small>
                  ) : null}
                </td>
                <td>
                  {score.tokenUsageCoveragePercent === null
                    ? 'Unavailable'
                    : `${score.tokenUsageCoveragePercent.toFixed(1)}%`}
                  <small>{score.tokenObservedResultCount} token-observed result cells</small>
                  <small>
                    source {score.tokenUsageSourceLevel?.replaceAll('_', '-') ?? 'unavailable'} ·{' '}
                    aggregation evidence{' '}
                    {score.tokenUsageEvidenceLevel?.replaceAll('_', '-') ?? 'unavailable'}
                  </small>
                </td>
                <td>
                  {scoringVersion ?? 'Scoring unavailable'}
                  <small>{score.descriptiveStatus.replaceAll('_', ' ')}</small>
                  <small>{score.synthetic ? 'Synthetic seed' : 'Published calibration'}</small>
                  <small>Untrusted · not Official · not ranking eligible</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="formula-note">
        No score/$ or score/hour aggregate is used. If derived externally: score/$ = descriptive AIQ
        ÷ estimated API-equivalent USD; score/hour = descriptive AIQ ÷ observed hours. The
        denominator and token coverage must accompany the value. Runtime-issue attempts remain in
        observed usage totals; missing or non-invoked cells do not. Adapter elapsed time measures
        model and allowed-tool invocation only. It excludes workspace setup, artifact sealing, and
        evaluator replay. Concurrent model order and local contention affect the observed resource
        profile. Missing usage makes cost unavailable and excludes it from the frontier; it is not
        displayed as zero.
      </p>
    </section>
  );
}
