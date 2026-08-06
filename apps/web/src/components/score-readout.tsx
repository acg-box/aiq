export function ScoreReadout({
  score,
  label,
  unit = 'AIQ index',
}: {
  score: number;
  label: string;
  unit?: string;
}) {
  return (
    <div
      className="score-readout"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score}
      aria-valuetext={`${score.toFixed(1)} ${unit} out of 100`}
    >
      <span>{score.toFixed(1)}</span>
      <small>{unit} · 0–100</small>
    </div>
  );
}
