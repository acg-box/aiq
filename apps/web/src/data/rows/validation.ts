export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function nullableCount(value: unknown): value is number | null {
  return value === null || isCount(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

export function isNullableNonnegativeNumber(value: unknown): value is number | null {
  return value === null || (isFiniteNumber(value) && value >= 0);
}

export function nullableNumberIsAtMost(left: unknown, right: unknown): boolean {
  return (
    left === null ||
    right === null ||
    (isFiniteNumber(left) && isFiniteNumber(right) && left <= right)
  );
}

export function isPricingRate(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    isBoundedIdentifier(value.model) &&
    isCount(value.input_usd_nanos_per_token) &&
    isCount(value.cached_input_usd_nanos_per_token) &&
    isCount(value.cache_write_input_usd_nanos_per_token) &&
    isCount(value.output_usd_nanos_per_token)
  );
}

export const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

export function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function isOptionalTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

export function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isPositiveCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function safeCountSum(values: readonly unknown[]): number | null {
  if (!values.every(isCount)) return null;
  const sum = values.reduce<number>((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

export function groupIsComplete(values: readonly unknown[]): boolean {
  return values.every((value) => value === null) || values.every((value) => value !== null);
}

export function isEnumValue(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}
