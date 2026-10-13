// evidence-meter: one line under every answer saying what Claude actually
// checked during that turn.
//
// tool.call records each tool the main conversation ran and whether it
// failed; turn.start clears the list; turn.complete turns the list into one
// line. A turn.complete hook that returns a different `text` has it shown
// beneath the answer, and the transcript itself is never rewritten.

import type { Register } from 'claude-code'

import { classify, summarize } from './evidence'
import type { Call } from './evidence'

// The current turn's calls. A module variable is enough: it lives for one
// turn, and a reload mid-turn only means that turn's line undercounts.
let calls: Call[] = []

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    calls = []
    return next(e)
  })

  // Observe only: the call runs exactly as it would without this mod.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // A subagent's own tool calls are its business; its spawn counts once.
    if (e.agentId !== undefined) return result
    const failed = result.deny !== undefined || result.isError === true
    calls.push({ ...classify(e.tool, e as unknown as Record<string, unknown>), failed })
    return result
  }).catch(($, e, next) => next(e)) // a bug here must never block a tool

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Only the main conversation's finished answers get a line: not a
    // subagent's run, an interrupted turn, a refusal or an API error.
    if (e.agentId !== undefined || e.reason !== 'answer') return result
    return { ...result, text: summarize(calls, e.answer) }
  })
}
