export function ScoreRing({
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
      className="score-ring"
      style={{
        background: `radial-gradient(circle, var(--panel) 56%, transparent 57%), conic-gradient(var(--acid) 0 ${score * 3.6}deg, #292e2a ${score * 3.6}deg 360deg)`,
      }}
      aria-label={`${label}: ${score.toFixed(1)} ${unit}`}
    >
      <span>{score.toFixed(1)}</span>
      <small>{unit}</small>
    </div>
  );
}
