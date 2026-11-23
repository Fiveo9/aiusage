/**
 * Parse a timestamp value into epoch milliseconds.
 *
 * Handles:
 * - numbers: treated as seconds when below 1e12 (multiplied to ms), else ms
 * - numeric strings: same second/ms heuristic as numbers
 * - date strings: parsed via `Date`
 *
 * Falls back to `fallback` when the value cannot be interpreted.
 */
export function parseTimestamp(value: unknown, fallback: number, numericUnit: 'auto' | 'ms' = 'auto'): number {
  const fromNumber = (number: number) => {
    const milliseconds = numericUnit === 'auto' && number < 1e12 ? number * 1000 : number
    return Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : fallback
  }
  if (typeof value === 'number' && Number.isFinite(value)) return fromNumber(value)
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return fromNumber(asNumber)
    const parsed = new Date(value).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}
