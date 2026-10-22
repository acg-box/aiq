const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Use display names for peer lists; keep scores, dates, and levels in their own order. */
export function alphabetical<T>(items: readonly T[], label: (item: T) => string): T[] {
  return items.toSorted((left, right) => collator.compare(label(left), label(right)));
}
