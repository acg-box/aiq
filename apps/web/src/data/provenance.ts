export type DataProvenance = 'synthetic' | 'published' | 'mixed' | 'unavailable';

export function classifyDataProvenance(
  values: readonly (boolean | null | undefined)[],
): DataProvenance {
  const available = values.filter((value): value is boolean => typeof value === 'boolean');
  if (available.length === 0) {
    return 'unavailable';
  }
  if (available.every(Boolean)) {
    return 'synthetic';
  }
  if (available.every((value) => !value)) {
    return 'published';
  }
  return 'mixed';
}
