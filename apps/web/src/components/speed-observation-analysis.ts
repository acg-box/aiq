import type { PublicSpeedObservation } from '../data/types.ts';

export interface PairedSpeedupRow {
  readonly entryId: string;
  readonly normal: PublicSpeedObservation;
  readonly fast: PublicSpeedObservation;
  readonly speedup: number;
}

export function pairedSpeedupRows(
  rows: readonly PublicSpeedObservation[],
): readonly PairedSpeedupRow[] {
  const byIdentity = new Map(rows.map((row) => [`${row.entryId}:${row.mode}`, row]));
  return [...new Set(rows.map((row) => row.entryId))].flatMap((entryId) => {
    const normal = byIdentity.get(`${entryId}:normal`);
    const fast = byIdentity.get(`${entryId}:fast`);
    if (
      !normal ||
      !fast ||
      normal.medianElapsedMs === null ||
      fast.medianElapsedMs === null ||
      fast.medianElapsedMs <= 0
    ) {
      return [];
    }
    return [{ entryId, normal, fast, speedup: normal.medianElapsedMs / fast.medianElapsedMs }];
  });
}
