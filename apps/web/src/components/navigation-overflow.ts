/** Keep the current item visible and fit alphabetical peers around it. */
export function fitNavigationItems(
  widths: readonly number[],
  currentIndex: number,
  availableWidth: number,
  moreWidth: number,
  gap: number,
  requireMenu: boolean,
): number[] {
  const all = widths.map((_, index) => index);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  if (total + (requireMenu ? moreWidth + gap : 0) <= availableWidth) return all;

  const visible = currentIndex < 0 ? [] : [currentIndex];
  let used = currentIndex < 0 ? moreWidth : (widths[currentIndex] ?? 0) + gap + moreWidth;
  for (const [index, width] of widths.entries()) {
    if (index === currentIndex) continue;
    const next = width + gap;
    if (used + next <= availableWidth) {
      visible.push(index);
      used += next;
    }
  }
  return visible.toSorted((a, b) => a - b);
}
