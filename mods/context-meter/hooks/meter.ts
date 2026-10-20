// Pure logic: turn the engine's context breakdown into a snapshot, and the
// snapshot into numbers and bar segments. No `$` here, so it unit-tests on
// plain values.

import type { SessionContextBreakdown } from 'claude-code'

import type { ContextRow, ContextSnapshot } from '../types'

// Keep only what the band and the pane draw: the breakdown also carries the
// grid, per-tool and per-file lists, which would bloat the session state.
export function toSnapshot(breakdown: SessionContextBreakdown): ContextSnapshot {
  return {
    total: breakdown.totalTokens,
    max: breakdown.rawMaxTokens,
    compactAt: breakdown.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined,
    model: breakdown.model,
    rows: breakdown.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
  }
}

// 950 -> "950", 4_200 -> "4.2k", 95_000 -> "95k", 1_000_000 -> "1M".
export function formatTokens(n: number): string {
  const short = (value: number, unit: string) =>
    `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`
  if (n >= 1_000_000) return short(n / 1_000_000, 'M')
  if (n >= 1_000) return short(n / 1_000, 'k')
  return String(Math.round(n))
}

// Whole percent of the window, never below 1 for a category that has tokens,
// so a small but present category doesn't read as "0%".
export function percentOf(tokens: number, max: number): number {
  if (max <= 0 || tokens <= 0) return 0
  return Math.max(1, Math.round((tokens / max) * 100))
}

// Close to compaction: 80% of the way to the threshold (or the window when
// auto-compaction is off). The band turns to the warning colour then.
export function isNearLimit(snapshot: ContextSnapshot): boolean {
  const limit = snapshot.compactAt ?? snapshot.max
  return limit > 0 && snapshot.total >= limit * 0.8
}

export type Segment = { row: ContextRow; cells: number }

// Splits `width` cells between the rows in the window (deferred ones are not
// in it), in proportion to their tokens. Largest-remainder rounding, so the
// cells always add up to exactly `width`.
export function barSegments(rows: ContextRow[], width: number): Segment[] {
  const inWindow = rows.filter(r => r.kind !== 'deferred' && r.tokens > 0)
  const sum = inWindow.reduce((s, r) => s + r.tokens, 0)
  if (sum === 0 || width <= 0) return []
  const exact = inWindow.map(r => (r.tokens / sum) * width)
  const cells = exact.map(Math.floor)
  let left = width - cells.reduce((s, c) => s + c, 0)
  const byRemainder = exact
    .map((e, i) => ({ i, rest: e - Math.floor(e) }))
    .sort((a, b) => b.rest - a.rest)
  for (const { i } of byRemainder) {
    if (left === 0) break
    cells[i] = (cells[i] ?? 0) + 1
    left--
  }
  return inWindow
    .map((row, i) => ({ row, cells: cells[i] ?? 0 }))
    .filter(s => s.cells > 0)
}

// The character a segment is drawn with: solid for content, shaded for the
// compaction reserve, light for free space.
export function glyph(kind: ContextRow['kind']): string {
  return kind === 'free' ? '░' : kind === 'buffer' ? '▒' : '█'
}
