// context-meter: how full the context window is.
//
//  - A line above the prompt, always: tokens used, window, % and where
//    auto-compaction kicks in, with a small coloured bar.
//  - /context-meter, or the band's [ details ] button, opens a pane with the
//    breakdown by category.
//
// The numbers come from $.session.usage({ breakdown: 'summary' }), the same
// breakdown /context shows, estimated locally: no API calls, no cost. They are
// refreshed when the session starts, after every turn and after a compaction.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextSnapshot } from '../types'
import { barSegments, formatTokens, glyph, isNearLimit, orderRows, percentOf, share, toSnapshot } from './meter'

const PANE = 'context-meter'
const TITLE = 'Context window'
const snapshot = atom({ plugin: 'context-meter', key: 'snapshot' } as const, null as ContextSnapshot | null)

// Reads the breakdown and stores it; every drawing that reads it redraws.
// A failure leaves the last snapshot in place rather than blanking the meter.
async function refresh($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  const breakdown = usage?.context.breakdown
  if (breakdown) await update($, snapshot, () => toSnapshot(breakdown))
}

// The headline: "95k / 1M · 10% · compacts at 987k".
function headline(s: ContextSnapshot): string {
  const compacts = s.compactAt ? ` · compacts at ${formatTokens(s.compactAt)}` : ''
  return `${formatTokens(s.total)} / ${formatTokens(s.max)} · ${percentOf(s.total, s.max)}%${compacts}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'context-meter',
      description: 'Show the context window broken down by category in a pane',
    })
    await refresh($)
    return started
  })

  on('command.run', { command: 'context-meter' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Context breakdown opened.' }
  })

  // Main conversation only: a subagent's turn doesn't change this window.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await refresh($)
    return result
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  }).catch(($, e, next) => next(e))

  // The line above the prompt. Other mods draw bands too (client-guard), so
  // this one stacks on top of whatever is beneath it instead of replacing it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const s = await read($, snapshot)
    if (e.props.hasSurvey || !s) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(10, Math.min(24, e.props.bodyColumns - 52))
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={isNearLimit(s) ? 'warning' : 'subtle'}>{`context ${headline(s)}  `}</Text>
          {barSegments(orderRows(s.rows), width).map(seg => (
            <Text color={seg.row.color} dimColor={seg.row.kind === 'free'}>
              {glyph(seg.row.kind).repeat(seg.cells)}
            </Text>
          ))}
          <Text> </Text>
          <Button key="details" label="details" onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
        </Box>
        {below}
      </Box>
    )
  })

  // The pane: the bar full width, then one row per category.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    if (!s) return <Text dimColor>No reading yet: it appears after the first answer.</Text>

    const width = Math.max(10, Math.min(60, e.props.bodyColumns))
    const rows = orderRows(s.rows).filter(r => r.tokens > 0)
    const nameWidth = Math.max(...rows.map(r => r.name.length), 8)

    return (
      <Box flexDirection="column">
        <Text bold color={isNearLimit(s) ? 'warning' : undefined}>{headline(s)}</Text>
        <Box>
          {barSegments(orderRows(s.rows), width).map(seg => (
            <Text color={seg.row.color} dimColor={seg.row.kind === 'free'}>
              {glyph(seg.row.kind).repeat(seg.cells)}
            </Text>
          ))}
        </Box>
        {rows.map(row => (
          <Box>
            <Text color={row.color}>{`${glyph(row.kind)} `}</Text>
            <Text dimColor={row.kind === 'deferred'}>{row.name.padEnd(nameWidth + 2)}</Text>
            <Text dimColor>
              {`${formatTokens(row.tokens).padStart(7)}  ${row.kind === 'deferred' ? '     —' : `${share(row.tokens, s.max).padStart(5)}%`}`}
            </Text>
          </Box>
        ))}
        {rows.some(r => r.kind === 'deferred') && (
          <Text dimColor>— deferred: tool schemas loaded on demand, not in the window</Text>
        )}
        <Text dimColor>{`${s.model} · estimate, updated after each answer`}</Text>
      </Box>
    )
  })
}
