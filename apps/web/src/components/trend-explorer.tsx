import Link from 'next/link';

import { TREND_SERIES_STYLES } from '../data/trend-styles.ts';
import type { LeaderboardEntry, TrendPoint, TrendRange } from '../data/types.ts';

const ranges: ReadonlyArray<{ value: TrendRange; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: 'All history' },
];

const formatDate = (value: string) => value.slice(0, 10);
const pointProvenance = (point: TrendPoint) => (point.synthetic ? 'Synthetic' : 'Published');

export function scoreAxisTicks(minimum: number, maximum: number, count = 5): readonly number[] {
  if (count < 2 || maximum <= minimum) return [minimum];
  return Array.from(
    { length: count },
    (_, index) => minimum + ((maximum - minimum) * index) / (count - 1),
  );
}

export function dateAxisTicks(minimum: number, maximum: number): readonly number[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [];
  if (minimum === maximum) return [minimum];
  return [minimum, minimum + (maximum - minimum) / 2, maximum];
}

const formatAxisDate = (timestamp: number) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));

function seriesProvenance(points: readonly TrendPoint[]): string {
  if (points.length === 0) {
    return 'No observations in selected range';
  }
  if (points.every((point) => point.synthetic)) {
    return 'synthetic';
  }
  if (points.every((point) => !point.synthetic)) {
    return 'published';
  }
  return 'mixed provenance';
}

export function TrendExplorer({
  entries,
  points,
  range,
}: {
  entries: readonly LeaderboardEntry[];
  points: readonly TrendPoint[];
  range: TrendRange;
}) {
  const visible = points;
  const entryIds = entries.map((entry) => entry.id);
  const timestamps = visible.map((point) => new Date(point.recordedAt).getTime());
  const minimumTime = Math.min(...timestamps);
  const maximumTime = Math.max(...timestamps);
  const scoreValues = visible.flatMap((point) => [point.ciLow, point.score, point.ciHigh]);
  const observedMinimumScore = scoreValues.length === 0 ? 0 : Math.min(...scoreValues);
  const observedMaximumScore = scoreValues.length === 0 ? 100 : Math.max(...scoreValues);
  const scorePadding = Math.max(2, (observedMaximumScore - observedMinimumScore) * 0.1);
  const minimumScore = Math.max(0, observedMinimumScore - scorePadding);
  const maximumScore = Math.min(100, observedMaximumScore + scorePadding);
  const xForTime = (timestamp: number) =>
    maximumTime === minimumTime
      ? 67
      : 18 + ((timestamp - minimumTime) / (maximumTime - minimumTime)) * 98;
  const yForScore = (score: number) =>
    maximumScore === minimumScore
      ? 48
      : 91 - ((score - minimumScore) / (maximumScore - minimumScore)) * 84;
  const scoreTicks = scoreAxisTicks(minimumScore, maximumScore);
  const timeTicks = dateAxisTicks(minimumTime, maximumTime);

  return (
    <>
      <nav className="range-tabs" aria-label="Trend time range">
        {ranges.map((candidate) => (
          <Link
            key={candidate.value}
            aria-current={range === candidate.value ? 'page' : undefined}
            href={`/trends?range=${candidate.value}`}
          >
            {candidate.label}
          </Link>
        ))}
      </nav>
      <p className="trend-resolution" role="note">
        The server returns at most 20 time buckets per model and reasoning combination. Each plotted
        published value is the latest exact Official run in its bucket, not an average. Synthetic
        fixture points do not claim a matching run detail. The table shows represented-run and task
        sample counts.
      </p>
      <div className="trend-layout">
        <div className="chart-frame">
          {visible.length > 0 ? (
            <svg
              className="trend-chart"
              viewBox="0 0 122 112"
              role="img"
              aria-labelledby="trend-title trend-description"
            >
              <title id="trend-title">AIQ score history</title>
              <desc id="trend-description">
                Lines show available fixed-fixture scores across all {entryIds.length} model and
                reasoning combinations. Color, solid, dashed, and dotted line patterns, and the
                adjacent labels distinguish each series. The legend explicitly marks combinations
                with no observation in this range. A data table follows the chart.
              </desc>
              <g className="chart-axis" aria-hidden="true">
                {scoreTicks.map((score) => {
                  const y = yForScore(score);
                  return (
                    <g key={score}>
                      <line className="grid-line" x1="18" x2="116" y1={y} y2={y} />
                      <text x="15" y={y + 1} textAnchor="end">
                        {score.toFixed(score % 1 === 0 ? 0 : 1)}
                      </text>
                    </g>
                  );
                })}
                {timeTicks.map((timestamp) => {
                  const x = xForTime(timestamp);
                  return (
                    <g key={timestamp}>
                      <line className="axis-tick" x1={x} x2={x} y1="91" y2="94" />
                      <text x={x} y="100" textAnchor="middle">
                        {formatAxisDate(timestamp)}
                      </text>
                    </g>
                  );
                })}
                <text className="axis-label" x="67" y="109" textAnchor="middle">
                  Observation date (UTC)
                </text>
                <text
                  className="axis-label"
                  x="3"
                  y="49"
                  textAnchor="middle"
                  transform="rotate(-90 3 49)"
                >
                  AIQ score
                </text>
              </g>
              {entryIds.map((entryId, index) => {
                const style = TREND_SERIES_STYLES[index];
                const series = visible
                  .filter((point) => point.entryId === entryId)
                  .toSorted(
                    (left, right) =>
                      new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime(),
                  );
                const path = series
                  .map(
                    (point, pointIndex) =>
                      `${pointIndex === 0 ? 'M' : 'L'} ${xForTime(new Date(point.recordedAt).getTime())} ${yForScore(point.score)}`,
                  )
                  .join(' ');
                return (
                  <g key={entryId}>
                    {path.length > 0 ? (
                      <path
                        d={path}
                        style={{ stroke: style?.color, strokeDasharray: style?.dashArray }}
                      />
                    ) : null}
                    {series.map((point) => (
                      <circle
                        key={point.recordedAt}
                        cx={xForTime(new Date(point.recordedAt).getTime())}
                        cy={yForScore(point.score)}
                        r="1.1"
                        style={{ fill: style?.color }}
                      >
                        <title>
                          {point.runId === null
                            ? `${entryId}, ${formatDate(point.recordedAt)}, ${point.score.toFixed(1)}, synthetic fixture point with no matching run detail`
                            : `${entryId}, ${formatDate(point.recordedAt)}, ${point.score.toFixed(1)}, latest of ${point.representedRunCount} run${point.representedRunCount === 1 ? '' : 's'} in this bucket, ${pointProvenance(point)}`}
                        </title>
                      </circle>
                    ))}
                  </g>
                );
              })}
            </svg>
          ) : (
            <p>No observations fall in this range.</p>
          )}
        </div>
        <ul className="chart-legend" aria-label="Trend series">
          {entryIds.map((entryId, index) => {
            const entry = entries.find((candidate) => candidate.id === entryId);
            const style = TREND_SERIES_STYLES[index];
            const series = points.filter((point) => point.entryId === entryId);
            return (
              <li key={entryId}>
                <svg viewBox="0 0 28 8" aria-hidden="true">
                  <line
                    x1="1"
                    x2="27"
                    y1="4"
                    y2="4"
                    style={{ stroke: style?.color, strokeDasharray: style?.dashArray }}
                  />
                </svg>
                <strong>
                  {entry?.modelFamily ?? entryId} · {entry?.reasoningTier}
                </strong>
                <small>
                  {style?.pattern} · {seriesProvenance(series)}
                </small>
              </li>
            );
          })}
        </ul>
      </div>
      <details className="data-disclosure">
        <summary>Read trend values as a table</summary>
        <div className="table-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                <th scope="col">Series</th>
                <th scope="col">Score</th>
                <th scope="col">Task sensitivity</th>
                <th scope="col">Samples</th>
                <th scope="col">Bucket coverage</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {visible
                .toSorted(
                  (left, right) =>
                    new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime(),
                )
                .map((point) => (
                  <tr key={`${point.entryId}-${point.recordedAt}`}>
                    <td>{formatDate(point.recordedAt)}</td>
                    <th scope="row">{point.entryId}</th>
                    <td>{point.score.toFixed(1)}</td>
                    <td>
                      {point.ciLow.toFixed(1)}–{point.ciHigh.toFixed(1)}
                    </td>
                    <td>{point.sampleSize}</td>
                    <td>
                      {point.runId === null ? (
                        <>Synthetic fixture · no run detail</>
                      ) : (
                        <>
                          Latest of {point.representedRunCount} run
                          {point.representedRunCount === 1 ? '' : 's'}
                        </>
                      )}
                    </td>
                    <td>{pointProvenance(point)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
