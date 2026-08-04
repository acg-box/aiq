export function formatHumanDuration(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

export function formatTaskDuration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${(milliseconds / 1_000).toFixed(1)} s`
    : formatHumanDuration(milliseconds);
}
