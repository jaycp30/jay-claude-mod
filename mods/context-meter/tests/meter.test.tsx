import type { On, SessionContextBreakdown } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { ContextRow } from '../types'
import { barSegments, formatTokens, isNearLimit, percentOf, toSnapshot } from '../hooks/meter'

// A breakdown shaped like the one in the README screenshot. Only the fields the
// mod reads are filled; the cast keeps the fixture readable.
const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 4_200, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 52_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 38_800, color: 'claude', isDeferred: false, kind: 'used' },
    { name: 'Deferred tools', tokens: 9_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Autocompact buffer', tokens: 13_000, color: 'warning', isDeferred: false, kind: 'buffer' },
    { name: 'Free space', tokens: 892_000, color: 'inactive', isDeferred: false, kind: 'free' },
  ],
  totalTokens: 95_000,
  rawMaxTokens: 1_000_000,
  isAutoCompactEnabled: true,
  autoCompactThreshold: 987_000,
  model: 'claude-opus-5-5',
} as unknown as SessionContextBreakdown

describe('numbers', () => {
  test('formatTokens', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(4_200)).toBe('4.2k')
    expect(formatTokens(95_000)).toBe('95k')
    expect(formatTokens(987_000)).toBe('987k')
    expect(formatTokens(1_000_000)).toBe('1M')
  })
  test('percentOf never shows a present category as 0%', () => {
    expect(percentOf(95_000, 1_000_000)).toBe(10)
    expect(percentOf(3_400, 1_000_000)).toBe(1)
    expect(percentOf(0, 1_000_000)).toBe(0)
  })
  test('near the limit means 80% of the way to compaction', () => {
    const s = toSnapshot(BREAKDOWN)
    expect(isNearLimit(s)).toBe(false)
    expect(isNearLimit({ ...s, total: 800_000 })).toBe(true)
    expect(isNearLimit({ ...s, compactAt: undefined, total: 800_000 })).toBe(true)
  })
})

describe('bar', () => {
  const rows = toSnapshot(BREAKDOWN).rows
  test('cells add up to the width exactly, and deferred rows are left out', () => {
    for (const width of [10, 24, 60]) {
      const segments = barSegments(rows, width)
      expect(segments.reduce((sum, s) => sum + s.cells, 0)).toBe(width)
      expect(segments.some(s => s.row.kind === 'deferred')).toBe(false)
    }
  })
  test('an empty breakdown draws no bar', () => {
    expect(barSegments([] as ContextRow[], 20)).toEqual([])
  })
})

// The engine beneath the plugin: a breakdown to read, and the calls the
// session start makes.
function world(on: On) {
  on('session.usage', () => ({
    value: { context: { tokens: 95_000, window: 1_000_000, percent: 10, breakdown: BREAKDOWN }, rateLimits: [], startedAt: 0 },
  }))
  on('command.register', () => ({ value: { command: 'context-meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const BAND_PROPS = {
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
} as const
const PANE_PROPS = {
  title: 'Context window', isFocused: false, bodyColumns: 60, placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 }, view: {},
} as const

describe('drawing', () => {
  test('the band shows the headline and keeps the band beneath it', async ($, on) => {
    world(on)
    // Another mod's band beneath this one (client-guard's, say).
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>other band</Text>
    })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'context-meter', surface, component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS,
      } as never)
      expect((await ui.find({ type: 'Text', text: /context 95k/ }))?.text)
        .toBe('context 95k / 1M · 10% · compacts at 987k  ')
      expect(await ui.find({ type: 'Text', text: 'other band' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the pane lists each category with its tokens and share', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'context-meter', surface, component: 'Pane', requestId: 'context-meter', props: PANE_PROPS,
      } as never)
      expect(await ui.find({ type: 'Text', text: 'mcp tools' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /52k/ }))?.text).toBe('   52k    5%')
      expect(await ui.find({ type: 'Text', text: /loaded on demand/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
