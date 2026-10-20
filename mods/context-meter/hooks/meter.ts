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

// As /context writes them: one decimal, dropped when it's zero.
// 950 -> "950", 4_200 -> "4.2k", 614_800 -> "614.8k", 95_000 -> "95k", 1_000_000 -> "1M".
export function formatTokens(n: number): string {
  const short = (value: number, unit: string) => `${Math.round(value * 10) / 10}${unit}`
  if (n >= 1_000_000) return short(n / 1_000_000, 'M')
  if (n >= 1_000) return short(n / 1_000, 'k')
  return String(Math.round(n))
}

// A category's share of the window with one decimal, as /context shows it:
// 55.9, 1.6, 0.3.
export function share(tokens: number, max: number): string {
  if (max <= 0) return '0.0'
  return ((tokens / max) * 100).toFixed(1)
}

// /context's order: content biggest first, then the compaction buffer, the
// free space, and last the deferred tool schemas (not in the window).
export function orderRows(rows: ContextRow[]): ContextRow[] {
  const rank = { used: 0, buffer: 1, free: 2, deferred: 3 } as const
  return [...rows].sort((a, b) => rank[a.kind] - rank[b.kind] || b.tokens - a.tokens)
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

// A button another mod offers to sit after `details` (skill-map's book). It
// comes from that mod's state, so its shape is checked before anything is
// drawn: a malformed value draws nothing rather than breaking the band.
// Keep in sync with skill-map's copy (mods/skill-map/types/index.d.ts):
// neither mod depends on the other, so each writes the shape down itself.
export type HostedButton = {
  label: string
  command: string
  args: string
}

export function asHostedButton(value: unknown): HostedButton | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const fields = ['label', 'command', 'args'] as const
  const record = value as Record<string, unknown>
  return fields.every(f => typeof record[f] === 'string') ? (record as HostedButton) : undefined
}
