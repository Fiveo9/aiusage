/** Compact token counts shared by the dashboard and tray widget.
 * `roundSmall` is for chart tooltips; totals keep their existing precision.
 */
export function formatTokens(value: number, roundSmall = false): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(roundSmall ? Math.round(value) : value)
}
