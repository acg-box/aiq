import type { PublicCalibrationScore } from '../data/types.ts';
import { formatHumanDuration, formatTaskDuration } from '../data/format-duration.ts';

type Metric = 'cost' | 'time';

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

function isPareto(
  point: PublicCalibrationScore,
  points: readonly PublicCalibrationScore[],
  metric: Metric,
): boolean {
  const pointX = valueFor(point, metric);
  const pointAiq = point.aiq;
  if (pointAiq === null || pointX === null) return false;
  return !points.some((candidate) => {
    const candidateX = valueFor(candidate, metric);
    return (
      candidate.runId === point.runId &&
      (metric === 'time' ||
        (candidate.pricingVersion === point.pricingVersion &&
          candidate.pricingAsOf === point.pricingAsOf &&
          candidate.pricingSource === point.pricingSource &&
          candidate.pricingCurrency === point.pricingCurrency &&
          candidate.pricingProcessingTier === point.pricingProcessingTier)) &&
      candidate.aiq !== null &&
      candidateX !== null &&
      candidateX <= pointX &&
      candidate.aiq >= pointAiq &&
      (candidateX < pointX || candidate.aiq > pointAiq)
    );
  });
}

function Scatter({
  scores,
  metric,
}: {
  scores: readonly PublicCalibrationScore[];
  metric: Metric;
}) {
  const points = scores.filter((score) => score.aiq !== null && valueFor(score, metric) !== null);
  const label =
    metric === 'cost'
      ? 'estimated Standard API equivalent token cost (USD)'
      : 'observed Codex adapter elapsed time (median)';
  if (points.length < 2)
    return (
      <p className="empty-note">
        At least two comparable model configurations with AIQ and {label} are required for this
        plot.
      </p>
    );
  const xs = points.map((point) => valueFor(point, metric) ?? 0);
  const ys = points.flatMap((point) => [
    point.aiq ?? 0,
    point.taskResamplingSensitivityLower ?? point.aiq ?? 0,
    point.taskResamplingSensitivityUpper ?? point.aiq ?? 0,
  ]);
  const xMax = Math.max(...xs, 1);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys, yMin + 1);
  return (
    <figure className="calibration-plot">
      <svg
        viewBox="0 0 640 300"
        role="img"
        aria-label={`AIQ versus ${label} scatter plot. Pareto-efficient points have rings.`}
      >
        <line x1="54" y1="20" x2="54" y2="252" />
        <line x1="54" y1="252" x2="620" y2="252" />
        {points.map((point) => {
          const xValue = valueFor(point, metric) ?? 0;
          const x = 54 + (xValue / xMax) * 550;
          const y = 238 - (((point.aiq ?? 0) - yMin) / (yMax - yMin)) * 204;
          const lowerY =
            238 -
            (((point.taskResamplingSensitivityLower ?? point.aiq ?? 0) - yMin) / (yMax - yMin)) *
              204;
          const upperY =
            238 -
            (((point.taskResamplingSensitivityUpper ?? point.aiq ?? 0) - yMin) / (yMax - yMin)) *
              204;
          const pareto = isPareto(point, points, metric);
          return (
            <g key={`${point.runId}-${point.modelFamily}-${point.reasoningEffort}`}>
              {point.taskResamplingSensitivityLower !== null &&
              point.taskResamplingSensitivityUpper !== null ? (
                <line className="sensitivity-bar" x1={x} x2={x} y1={upperY} y2={lowerY} />
              ) : null}
              <circle
                cx={x}
                cy={y}
                r={pareto ? 8 : 5}
                className={pareto ? 'pareto-point' : 'scatter-point'}
              >
                <title>{`${point.modelFamily} ${point.reasoningEffort}: descriptive AIQ ${point.aiq?.toFixed(2)}${point.taskResamplingSensitivityLower === null || point.taskResamplingSensitivityUpper === null ? '' : `, fixed-fixture task-resampling sensitivity ${point.taskResamplingSensitivityLower.toFixed(2)}–${point.taskResamplingSensitivityUpper.toFixed(2)}`}, ${label} ${xValue.toFixed(metric === 'cost' ? 4 : 0)}`}</title>
              </circle>
            </g>
          );
        })}
        <text x="10" y="18">
          AIQ
        </text>
        <text x="340" y="288" textAnchor="middle">
          {label}
        </text>
      </svg>
      <figcaption>
        Higher descriptive AIQ and a smaller horizontal value are preferable. Vertical bars show
        fixed-fixture task-resampling sensitivity, not universal capability confidence. Rings mark a
        descriptive frontier only within the same fixture, scoring version, runtime, concurrency,
        and run; cost also requires the same pricing version. Incomplete usage is excluded. This is
        not a combined ranking or an API-frontier claim.
      </figcaption>
    </figure>
  );
}

export function CalibrationEfficiency({ scores }: { scores: readonly PublicCalibrationScore[] }) {
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
    <section className="calibration-efficiency" aria-labelledby="efficiency-heading">
      <div className="section-heading">
        <span className="eyebrow">Transparent efficiency context</span>
        <h2 id="efficiency-heading">
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
        · <a href="https://developers.openai.com/api/docs/pricing">official source</a>
      </p>
      <div className="plot-grid">
        <Scatter scores={scores} metric="cost" />
        <Scatter scores={scores} metric="time" />
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="Calibration model efficiency"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Model / effort</th>
              <th>AIQ</th>
              <th>Sample / coverage</th>
              <th>Observed Codex adapter elapsed time</th>
              <th>Estimated Standard API equivalent token cost</th>
              <th>Token usage coverage</th>
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
                    : `${formatHumanDuration(score.observedTotalWallMs)} total`}
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="formula-note">
        No score/$ or score/hour aggregate is used. If derived externally: score/$ = descriptive AIQ
        ÷ estimated API-equivalent USD; score/hour = descriptive AIQ ÷ observed hours. The
        denominator and token coverage must accompany the value. Failed attempted tasks remain in
        observed usage totals; missing or non-invoked cells do not. Adapter elapsed time measures
        model and allowed-tool invocation only. It excludes workspace setup, artifact sealing, and
        evaluator replay. Concurrent model order and local contention affect the observed resource
        profile. Missing usage makes cost unavailable and excludes it from the frontier; it is not
        displayed as zero.
      </p>
    </section>
  );
}
