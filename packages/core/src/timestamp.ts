/**
 * Parse a timestamp value into epoch milliseconds.
 *
 * Handles:
 * - numbers: treated as seconds when below 1e12 (multiplied to ms), else ms
 * - numeric strings: same second/ms heuristic as numbers
 * - date strings: parsed via `Date`
 *
 * Falls back to `fallback` when the value cannot be interpreted. Bare SQL
 * datetime strings are local by default; sources documented as UTC can opt in.
 */
export function parseTimestamp(value: unknown, fallback: number, numericUnit: 'auto' | 'ms' = 'auto', naiveTimezone: 'local' | 'utc' = 'local'): number {
  const fromNumber = (number: number) => {
    const milliseconds = numericUnit === 'auto' && number < 1e12 ? number * 1000 : number
    return Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : fallback
  }
  if (typeof value === 'number' && Number.isFinite(value)) return fromNumber(value)
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return fromNumber(asNumber)
    const dateValue = naiveTimezone === 'utc' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value.trim())
      ? `${value.trim()}Z` : value
    const parsed = new Date(dateValue).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}
