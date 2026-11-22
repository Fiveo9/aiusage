# Design

## Aesthetic Direction

Minimalist Engineering (Linear / Vercel / Raycast inspired): crisp neutral surfaces, hairline 1px borders, high-density tabular typography, and a single restrained emerald accent. Designed for engineers reviewing token usage, cost attribution, and session telemetry in both bright daytime lighting and dark developer setups.

## Theme

- **Light (default):** Clean crisp white surfaces (`--surface`) over subtle cool-neutral canvas (`--bg`), maximizing contrast for dense numerical tables and charts.
- **Dark:** Deep obsidian neutral surfaces (`--bg` / `--surface`) with translucent hairline borders (`oklch(1 0 0 / 0.08)`). Controlled via `data-theme="dark"` on `<html>` with system-preference support and zero-flash pre-hydration script in `src/app.html`.

## Color (OKLCH Palette)

All tokens live in `packages/web/src/lib/styles/tokens.css`.

- **Accent:** `oklch(0.54 0.145 162)` (light) / `oklch(0.73 0.15 162)` (dark) — restrained emerald-teal used exclusively for active states, primary actions, cost highlights, and focus rings.
- **Neutrals (Light):** `--bg: oklch(0.985 0.002 250)`, `--surface: oklch(1 0 0)`, `--raised: oklch(0.968 0.003 250)`, `--hover: oklch(0.95 0.004 250)`, `--border-subtle: oklch(0.918 0.004 250)`, `--border-medium: oklch(0.845 0.006 250)`, `--text: oklch(0.165 0.01 250)`, `--text-secondary: oklch(0.42 0.01 250)`, `--text-muted: oklch(0.56 0.008 250)`.
- **Neutrals (Dark):** `--bg: oklch(0.132 0.004 255)`, `--surface: oklch(0.162 0.005 255)`, `--raised: oklch(0.195 0.006 255)`, `--hover: oklch(0.228 0.007 255)`, `--border-subtle: oklch(1 0 0 / 0.08)`, `--border-medium: oklch(1 0 0 / 0.15)`, `--text: oklch(0.955 0.004 255)`.
- **Semantic:** `--green`, `--blue`, `--purple`, `--rose`, `--amber` (and `-dim` 10–15% tint variants).
- **Chart Series:** `--chart-input`, `--chart-output`, `--chart-cache-read`, `--chart-cache-write`, `--chart-thinking`, `--chart-total`.

## Typography

- **UI Font:** `Inter` (`--font-sans`), with system/CJK fallbacks (`PingFang SC`, `Microsoft YaHei`, `system-ui`).
- **Mono / Numeric Font:** `JetBrains Mono` (`--mono`, `--font-mono`, `--font-numeric`), applied with `font-variant-numeric: tabular-nums` on all counters, tables, timestamps, and chart axes.
- **Base Size:** `html { font-size: 100%; }` (`1rem = 16px`).
- **Scale:** `--text-2xs: 0.6875rem`, `--text-xs: 0.75rem`, `--text-sm: 0.8125rem`, `--text-base: 0.875rem`, `--text-lg: 1rem`, `--text-title: 1.375rem` (page `<h1>` with `-0.025em` tracking and `650` weight).

## Layout & Elevation

- **Sidebar:** `220px` fixed (`--sidebar-width`), collapsible to `58px` (`--sidebar-collapsed`), separated by a `1px` `--border-subtle` right border. Includes brand header, `⌘K` / `Ctrl+K` Command Palette trigger, grouped navigation, and a compact single-row icon footer.
- **Content Area:** `padding: 1.75rem clamp(1rem, 3vw, 2.5rem) 2.5rem`, `max-width: 1520px`.
- **Cards:** Flat `--surface` with `1px solid var(--border-subtle)`, `10px` radius (`--radius-md`), subtle `--shadow-sm`, no hover lift or glow shadows.
- **Tables:** Full-bleed crisp horizontal row dividers (`0.6875rem 0.875rem` padding), `11px` uppercase muted headers, hover-only row highlight.
- **Popovers & Modals:** `--surface-elevated` with `1px solid var(--border-medium)` and `--shadow-md` / `--shadow-lg`.

## Controls & Visualization

- **Shared Primitives (`src/lib/styles/primitives.css`):** `.kpi-grid` / `.kpi-card`, `.segmented` / `.segmented-btn`, `.eng-btn`, `.skeleton` shimmer, `.is-stale` stale-while-revalidate dimming.
- **Custom Controls (`src/lib/components/`):** `DropdownSelect` popover menus (replacing native `<select>` in filters), unified `DateRangeSelector` with floating custom date popover, `CommandPalette` (`⌘K` / `Ctrl+K`), and `lucide-svelte` linear icons throughout.
- **SVG Charts (`src/lib/components/charts/`):** Responsive `SvgTokenChart` (stacked breakdown with interactive series toggling, total mode with daily average reference line, smart X-axis label thinning) and `SvgCostChart` (daily spend bars, daily average line, hover crosshair, boundary-aware tooltips).

## Motion & Accessibility

- **Transitions:** Fast `120ms–200ms` `cubic-bezier(0.16, 1, 0.3, 1)` opacity/color/width transitions.
- **Focus:** `2px solid var(--accent)` with `2px` offset on `:focus-visible`.
- **Reduced Motion:** `@media (prefers-reduced-motion: reduce)` collapses all animation and transition durations.
