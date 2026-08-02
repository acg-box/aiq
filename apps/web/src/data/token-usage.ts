export function uncachedInputTokens(
  input: number | null,
  cachedInput: number | null,
  cacheWriteInput: number | null,
): number | null {
  if (input === null || cachedInput === null || cacheWriteInput === null) return null;
  const uncached = input - cachedInput - cacheWriteInput;
  return uncached >= 0 ? uncached : null;
}
