'use client';

import { useEffect, useState } from 'react';

export function ScoreRing({
  score,
  label,
  unit = 'AIQ index',
}: {
  score: number;
  label: string;
  unit?: string;
}) {
  const [displayScore, setDisplayScore] = useState(score);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplayScore(score);
      return undefined;
    }
    const startedAt = performance.now();
    let frame = 0;
    const update = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 480);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayScore(score * eased);
      if (progress < 1) frame = requestAnimationFrame(update);
    };
    setDisplayScore(0);
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [score]);

  return (
    <div
      className="score-ring"
      style={{
        background: `radial-gradient(circle, var(--panel) 56%, transparent 57%), conic-gradient(var(--data-cyan) 0 ${displayScore * 3.6}deg, #292e2a ${displayScore * 3.6}deg 360deg)`,
      }}
      aria-label={`${label}: ${score.toFixed(1)} ${unit}`}
    >
      <span>{displayScore.toFixed(1)}</span>
      <small>{unit}</small>
    </div>
  );
}
